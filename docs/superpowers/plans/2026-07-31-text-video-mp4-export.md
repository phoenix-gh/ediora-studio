# Text Video MP4 Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export a text-video project as a durable local H.264/AAC MP4, persist progress and failure state, save the result as a creative asset, and expose playback, download, and rerender controls.

**Architecture:** The FastAPI service validates and freezes a canonical Remotion input into a `text_video_render` content job. The existing Redis Node worker renders that snapshot with `@remotion/bundler` and `@remotion/renderer`, then uploads the MP4 through authenticated worker endpoints. The project stores durable render state while `output_asset_url` continues to identify the latest successful video.

**Tech Stack:** FastAPI, SQLAlchemy async, PostgreSQL/SQLite migrations, Redis content jobs, Next.js 16, React 19, Remotion 4.0.500, Vitest, pytest, Playwright, ffprobe.

## Global Constraints

- Output is fixed to H.264 MP4 with AAC audio.
- Render width, height, FPS, template, segments, and template props come from the canonical project `render_input`.
- Rendering runs in the existing content Worker and survives page closure.
- A render job consumes a frozen input snapshot; later edits cannot change an in-flight render.
- At most one queued or running render exists per project.
- A failed or in-flight rerender never removes the previous successful output.
- Every successful rerender creates a new generated `CreativeAsset`; the project points to the latest one.
- Worker endpoints require both `X-Worker-Token` and `X-Content-Job-Id`.
- Do not stage or commit unrelated dirty-worktree changes.

---

### Task 1: Durable Render State and Invalidation

**Files:**
- Modify: `backend/models.py`
- Modify: `backend/database.py`
- Modify: `backend/text_video_domain.py`
- Modify: `backend/routers/text_videos.py`
- Modify: `backend/tests/test_database_text_video_migration.py`
- Modify: `backend/tests/test_text_video_domain.py`
- Modify: `backend/tests/test_text_videos_router.py`

**Interfaces:**
- Produces: `empty_render_state() -> dict`
- Produces: `render_source_hash(render_input: dict) -> str`
- Produces: serialized `render_state` on summary and detail project responses.
- Consumes: existing `output_asset_url` and `output_stale` invalidation rules.

- [ ] **Step 1: Write failing model, migration, and serialization tests**

```python
def test_text_video_migration_adds_render_state():
    columns = inspect_text_video_columns()
    assert "render_state" in columns

def test_project_serializes_default_render_state(env):
    payload = env.serialize_project(env.project())
    assert payload["render_state"] == {
        "status": "missing",
        "generation": 0,
        "source_hash": "",
        "job_id": None,
        "applied_job_id": None,
        "asset_id": None,
        "progress": 0,
        "error": "",
    }

def test_render_affecting_edit_marks_previous_output_stale(env):
    project = env.video_ready_project(output_asset_url="/api/uploads/old.mp4")
    env.merge_editable_project(project, {
        "template": {
            "templateId": "tech-text-v1",
            "templateVersion": 1,
            "templateProps": {"accentColor": "#ffffff"},
        },
    })
    assert project.output_asset_url == "/api/uploads/old.mp4"
    assert project.output_stale is True
    assert project.render_state["status"] == "stale"
```

- [ ] **Step 2: Run the focused backend tests and verify RED**

Run:

```bash
cd backend
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  tests/test_database_text_video_migration.py \
  tests/test_text_video_domain.py \
  tests/test_text_videos_router.py -q
```

Expected: failures because `render_state` and its default do not exist.

- [ ] **Step 3: Add the model column, additive migration, and domain helpers**

```python
def empty_render_state() -> dict:
    return {
        "status": "missing",
        "generation": 0,
        "source_hash": "",
        "job_id": None,
        "applied_job_id": None,
        "asset_id": None,
        "progress": 0,
        "error": "",
    }

def render_source_hash(render_input: dict) -> str:
    canonical = json.dumps(
        render_input,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
```

Add `render_state: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)`
to `TextVideoProject`, add the column to the idempotent schema upgrader, normalize it
through `empty_render_state() | (project.render_state or {})`, and mark it stale whenever
an edit already sets `output_stale=True`.

- [ ] **Step 4: Rerun focused backend tests and verify GREEN**

Run the command from Step 2.

Expected: all selected tests pass.

- [ ] **Step 5: Commit only Task 1 files**

```bash
git add backend/models.py backend/database.py backend/text_video_domain.py \
  backend/routers/text_videos.py \
  backend/tests/test_database_text_video_migration.py \
  backend/tests/test_text_video_domain.py \
  backend/tests/test_text_videos_router.py
git commit -m "feat: persist text video render state"
```

### Task 2: Render Launch Contract and Concurrency

**Files:**
- Create: `backend/text_video_render.py`
- Modify: `backend/routers/text_videos.py`
- Create: `backend/tests/test_text_video_render.py`
- Modify: `backend/tests/test_text_videos_router.py`

**Interfaces:**
- Produces: `launch_text_video_render(db, project, revision) -> RenderLaunchResult`
- Produces: `POST /api/text-videos/{project_id}/render`
- Consumes: `render_source_hash()`, `validate_render_input_projection()`, `create_or_get_job()`, and `enqueue_job()`.

- [ ] **Step 1: Write failing launch tests**

```python
async def test_launch_freezes_canonical_render_input(env):
    project = await env.video_ready_project()
    result = await env.launch(project.id, revision=project.revision)
    snapshot = result.jobs[0].input_data
    assert snapshot["project_id"] == project.id
    assert snapshot["project_revision"] == project.revision
    assert snapshot["render_input"] == project.render_input
    assert snapshot["source_hash"] == render_source_hash(project.render_input)
    assert result.project.render_state["status"] == "queued"

async def test_launch_reuses_active_render_job(env):
    first = await env.launch_ready_project()
    second = await env.launch(first.project.id, revision=first.project.revision)
    assert second.jobs[0].id == first.jobs[0].id

async def test_launch_rejects_stale_scene_plan(env):
    project = await env.video_ready_project()
    project.scene_plan["master_source_hash"] = "old"
    with pytest.raises(ValueError, match="分镜"):
        await env.launch(project.id, revision=project.revision)
```

- [ ] **Step 2: Run the new tests and verify RED**

```bash
cd backend
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  tests/test_text_video_render.py \
  tests/test_text_videos_router.py -q
```

Expected: import or route failure because launch support is missing.

- [ ] **Step 3: Implement a locked, idempotent launch**

```python
@dataclass(frozen=True)
class RenderLaunchResult:
    jobs: list[ContentJob]
    project: TextVideoProject

async def launch_text_video_render(
    db: AsyncSession,
    project: TextVideoProject,
    *,
    revision: int,
) -> RenderLaunchResult:
    # lock project, validate revision and video_stage_open(project)
    # validate and deepcopy render_input
    # return active job when render_state is queued/rendering
    # increment generation, freeze snapshot, create job, set queued state
```

Use an idempotency key derived from project id, generation, and source hash. Commit the
project state before enqueueing, matching existing text-video job launch ordering.

- [ ] **Step 4: Add and test the user launch route**

```python
@router.post("/{project_id}/render")
async def render_text_video(
    project_id: int,
    body: SpeechActionRequest,
    db: AsyncSession = Depends(get_db),
):
    project = await require_project(db, project_id)
    result = await launch_text_video_render(
        db, project, revision=body.revision
    )
    return {
        "jobs": [{
            "id": job.id,
            "flow": job.flow,
            "target_id": project_id,
        } for job in result.jobs],
        "project": serialize_project(result.project),
    }
```

- [ ] **Step 5: Rerun Task 2 tests and verify GREEN**

Run the command from Step 2.

- [ ] **Step 6: Commit only Task 2 files**

```bash
git add backend/text_video_render.py backend/routers/text_videos.py \
  backend/tests/test_text_video_render.py backend/tests/test_text_videos_router.py
git commit -m "feat: launch durable text video renders"
```

### Task 3: Authenticated Worker Progress, Result, Failure, and Download

**Files:**
- Modify: `backend/text_video_render.py`
- Modify: `backend/routers/text_videos.py`
- Modify: `backend/tests/test_text_video_render.py`
- Modify: `backend/tests/test_text_videos_router.py`

**Interfaces:**
- Produces: `GET /{project_id}/render/worker-context`
- Produces: `POST /{project_id}/render/worker-progress`
- Produces: `POST /{project_id}/render/worker-result`
- Produces: `POST /{project_id}/render/worker-failure`
- Produces: `GET /{project_id}/output/download`
- Consumes: job header identity, frozen snapshot, `CreativeAsset`, and `UPLOADS_DIR`.

- [ ] **Step 1: Write failing worker-boundary tests**

```python
async def test_progress_is_monotonic_and_does_not_bump_revision(env):
    launched = await env.launch_ready_project()
    before = launched.project.revision
    await env.progress(launched, progress=42)
    await env.progress(launched, progress=20)
    project = await env.get_project(launched.project.id)
    assert project.render_state["progress"] == 42
    assert project.revision == before

async def test_result_replay_returns_same_asset(env, mp4_upload):
    launched = await env.launch_ready_project()
    first = await env.result(launched, mp4_upload)
    second = await env.result(launched, mp4_upload)
    assert second["asset_id"] == first["asset_id"]
    assert await env.count_video_assets() == 1

async def test_late_result_cannot_overwrite_new_generation(env, mp4_upload):
    old = await env.launch_ready_project()
    newer = await env.force_new_generation(old.project.id)
    response = await env.result_response(old, mp4_upload)
    assert response.status_code == 409
    assert (await env.get_project(old.project.id)).render_state["job_id"] \
        == newer.jobs[0].id
```

- [ ] **Step 2: Run focused worker-boundary tests and verify RED**

```bash
cd backend
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  tests/test_text_video_render.py \
  tests/test_text_videos_router.py -q
```

- [ ] **Step 3: Implement context, progress, and failure identity checks**

```python
def assert_current_render_job(project, job):
    snapshot = job.input_data
    state = empty_render_state() | (project.render_state or {})
    if (
        job.flow != "text_video_render"
        or state["job_id"] != job.id
        or state["generation"] != snapshot["render_generation"]
        or state["source_hash"] != snapshot["source_hash"]
    ):
        raise StaleTextVideoRender("渲染任务已过期")
    return snapshot
```

Progress must clamp to `0..100`, use `max(current, incoming)`, update the running
`render_mp4` step output to `{"progress": progress}`, and avoid revision increments.

- [ ] **Step 4: Implement streaming MP4 commit and replay**

Stream multipart bytes into `UPLOADS_DIR/.text-video-render-tmp`, reject empty or
non-`video/mp4` inputs, cap at 500 MiB, then atomically rename to a UUID `.mp4`.
In the same database transaction:

```python
asset = CreativeAsset(
    asset_type="media",
    media_kind="video",
    title=f"{project.title} · 成片",
    url=f"/api/uploads/{filename}",
    media_type="video/mp4",
    filename=filename,
    source="generated",
)
project.output_asset_url = asset.url
project.output_stale = False
project.status = "completed"
project.render_state = {
    **state,
    "status": "ready",
    "applied_job_id": job.id,
    "asset_id": asset.id,
    "progress": 100,
    "error": "",
}
project.revision += 1
```

If `applied_job_id == job.id`, return the existing asset without reading or saving the
second upload.

- [ ] **Step 5: Implement attachment download with path containment**

Resolve `output_asset_url` only beneath `UPLOADS_DIR`, require an existing `.mp4`, and
return:

```python
FileResponse(
    path,
    media_type="video/mp4",
    filename=f"{safe_title}.mp4",
)
```

- [ ] **Step 6: Rerun tests and verify GREEN**

Run the command from Step 2.

- [ ] **Step 7: Commit only Task 3 files**

```bash
git add backend/text_video_render.py backend/routers/text_videos.py \
  backend/tests/test_text_video_render.py backend/tests/test_text_videos_router.py
git commit -m "feat: commit text video render outputs"
```

### Task 4: Remotion Worker Runner and Production Browser

**Files:**
- Modify: `web/package.json`
- Modify: `web/pnpm-lock.yaml`
- Modify: `web/Dockerfile`
- Modify: `docker-compose.yml`
- Create: `web/lib/ai/text-video-render-job.ts`
- Create: `web/lib/ai/text-video-render-job.test.ts`
- Modify: `web/scripts/content-worker.ts`
- Modify: `web/scripts/content-worker.test.ts`

**Interfaces:**
- Produces: `runTextVideoRenderJob(jobId: number, deps?: RenderDependencies)`
- Produces: `resolveTextVideoAssetUrl(url: string, apiBase: string) -> string`
- Consumes: the Task 3 Worker APIs and `remotion/index.ts`.

- [ ] **Step 1: Read the good-test rules before editing tests**

Read:

```bash
cat /home/violet/.codex/plugins/cache/openai-curated-remote/superpowers/6.2.0/skills/test-driven-development/writing-good-tests.md
```

- [ ] **Step 2: Write failing runner and flow-routing tests**

```typescript
it('renders the frozen composition as h264 with aac audio', async () => {
  await runTextVideoRenderJob(301, deps)
  expect(deps.selectComposition).toHaveBeenCalledWith(expect.objectContaining({
    id: 'tech-text-v1',
  }))
  expect(deps.renderMedia).toHaveBeenCalledWith(expect.objectContaining({
    codec: 'h264',
    audioCodec: 'aac',
    inputProps: expect.objectContaining({
      audio: 'http://api:8000/api/uploads/master.mp3',
    }),
  }))
  expect(deps.uploadResult).toHaveBeenCalledWith(
    301,
    expect.stringMatching(/\.mp4$/),
    expect.any(Object),
  )
})

it('routes text_video_render to the Remotion runner', () => {
  expect(resolveContentJobRunner('text_video_render'))
    .toBe(runTextVideoRenderJob)
})
```

- [ ] **Step 3: Run worker tests and verify RED**

```bash
cd web
npm test -- \
  lib/ai/text-video-render-job.test.ts \
  scripts/content-worker.test.ts --reporter=dot
```

Expected: module and flow routing are missing.

- [ ] **Step 4: Add direct Remotion runtime dependencies**

Add exact version `4.0.500` for `@remotion/bundler` and `@remotion/renderer`, then run:

```bash
cd web
pnpm install --config.minimumReleaseAge=0
```

- [ ] **Step 5: Implement the injected, testable renderer**

```typescript
export async function runTextVideoRenderJob(
  jobId: number,
  dependencies: Partial<RenderDependencies> = {},
) {
  const deps = { ...defaultDependencies, ...dependencies }
  const job = await deps.getJob(jobId)
  const context = await deps.getContext(projectId, jobId)
  const inputProps = {
    ...context.render_input,
    audio: resolveTextVideoAssetUrl(
      context.render_input.audio,
      apiBase(),
    ),
  }
  // start bundle step, memoized bundle()
  // selectComposition()
  // renderMedia({codec: "h264", audioCodec: "aac", ...})
  // throttle onProgress and await pending progress writes
  // multipart upload result
  // complete step and job
  // report domain failure and clean temporary directory in finally
}
```

Use `mkdtemp(join(tmpdir(), "wms-text-video-render-"))`; never write render outputs
inside the repository.

- [ ] **Step 6: Make the Worker image Remotion-compatible**

Change both Docker stages to `node:22-bookworm-slim`. Install Remotion's required
Chromium libraries and run the supported browser ensure command during the dependency
stage:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
RUN ./node_modules/.bin/remotion browser ensure
```

The ensure command stores the browser beneath `node_modules/.remotion`, which is copied
from the dependency stage into the runtime image.

- [ ] **Step 7: Rerun worker tests and verify GREEN**

Run the command from Step 3.

- [ ] **Step 8: Build the Worker image**

```bash
docker compose build worker
```

Expected: image build succeeds and `remotion browser ensure` completes.

- [ ] **Step 9: Commit only Task 4 files**

```bash
git add web/package.json web/pnpm-lock.yaml \
  web/Dockerfile docker-compose.yml \
  web/lib/ai/text-video-render-job.ts \
  web/lib/ai/text-video-render-job.test.ts \
  web/scripts/content-worker.ts \
  web/scripts/content-worker.test.ts
git commit -m "feat: render text videos with remotion worker"
```

### Task 5: Render Controls, Progress, Playback, and Download

**Files:**
- Modify: `web/lib/api/text-videos.ts`
- Modify: `web/lib/api/text-videos.test.ts`
- Modify: `web/app/text-video/useTextVideoProjectActions.ts`
- Modify: `web/app/text-video/useTextVideoProjectActions.test.tsx`
- Modify: `web/app/text-video/VideoStage.tsx`
- Modify: `web/app/text-video/VideoStage.test.tsx`
- Modify: `web/app/text-video/TextVideoWorkbench.tsx`
- Modify: `web/app/text-video/TextVideoWorkbench.test.tsx`
- Modify: `web/app/text-video/TextVideoEditorClient.tsx`
- Modify: `web/app/text-video/TextVideoEditorClient.test.tsx`

**Interfaces:**
- Produces: `renderTextVideo(projectId, revision) -> TextVideoRenderResponse`
- Produces: `textVideoOutputDownloadUrl(projectId) -> string`
- Produces: `onRenderVideo?: () => void` on Workbench and VideoStage.
- Consumes: durable `project.render_state` and `TextVideoActionState`.

- [ ] **Step 1: Write failing API and UI tests**

```typescript
it('launches an MP4 render after flushing current edits', async () => {
  await user.click(screen.getByRole('button', { name: '渲染 MP4' }))
  expect(mocks.autosave.flush).toHaveBeenCalledOnce()
  expect(mocks.renderTextVideo).toHaveBeenCalledWith(project.id, project.revision)
})

it('shows durable render progress', () => {
  renderVideoStage(makeVideoReadyProject({
    render_state: {
      ...emptyRenderState,
      status: 'rendering',
      progress: 37,
    },
  }))
  expect(screen.getByRole('button', { name: '正在渲染 37%' }))
    .toBeDisabled()
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '37')
})

it('offers playback, attachment download, and rerender after success', () => {
  renderVideoStage(renderedProject)
  expect(screen.getByRole('video')).toHaveAttribute(
    'src',
    'http://localhost:8000/api/uploads/output.mp4',
  )
  expect(screen.getByRole('link', { name: '下载 MP4' })).toHaveAttribute(
    'href',
    'http://localhost:8000/api/text-videos/2/output/download',
  )
  expect(screen.getByRole('button', { name: '重新渲染' })).toBeEnabled()
})
```

- [ ] **Step 2: Run focused frontend tests and verify RED**

```bash
cd web
npm test -- \
  lib/api/text-videos.test.ts \
  app/text-video/useTextVideoProjectActions.test.tsx \
  app/text-video/VideoStage.test.tsx \
  app/text-video/TextVideoWorkbench.test.tsx \
  app/text-video/TextVideoEditorClient.test.tsx --reporter=dot
```

- [ ] **Step 3: Add API types and calls**

```typescript
export type TextVideoRenderState = {
  status: 'missing' | 'queued' | 'rendering' | 'ready' | 'stale' | 'failed'
  generation: number
  source_hash: string
  job_id: number | null
  applied_job_id: number | null
  asset_id: number | null
  progress: number
  error: string
}

export function renderTextVideo(projectId: number, revision: number) {
  return textVideoRequest<TextVideoRenderResponse>(
    `/text-videos/${projectId}/render`,
    { method: 'POST', body: JSON.stringify({ revision }) },
  )
}
```

- [ ] **Step 4: Include render jobs in project recovery**

Add `project.render_state.job_id` to `activeProjectJobIds()` when status is queued or
rendering. While polling a render job, derive progress from the running step output and
refresh the canonical project so a reload and a live page agree.

- [ ] **Step 5: Replace the disabled export control**

Render the button, progress bar, error alert, previous-output notice, `<video controls>`,
download link, and rerender action from `project.render_state`, `output_asset_url`,
`output_stale`, and `actionStates["render:mp4"]`.

- [ ] **Step 6: Wire autosave-before-render**

```typescript
function renderVideo() {
  run(actions.runProjectAction(
    'render:mp4',
    async saved => renderTextVideo(saved.id, saved.revision),
  ))
}
```

Pass this through `TextVideoWorkbench` into `VideoStage`.

- [ ] **Step 7: Rerun focused tests and verify GREEN**

Run the command from Step 2.

- [ ] **Step 8: Commit only Task 5 files**

```bash
git add web/lib/api/text-videos.ts \
  web/lib/api/text-videos.test.ts \
  web/app/text-video/useTextVideoProjectActions.ts \
  web/app/text-video/useTextVideoProjectActions.test.tsx \
  web/app/text-video/VideoStage.tsx \
  web/app/text-video/VideoStage.test.tsx \
  web/app/text-video/TextVideoWorkbench.tsx \
  web/app/text-video/TextVideoWorkbench.test.tsx \
  web/app/text-video/TextVideoEditorClient.tsx \
  web/app/text-video/TextVideoEditorClient.test.tsx
git commit -m "feat: export and download text video mp4"
```

### Task 6: Full Verification and Real MP4 Acceptance

**Files:**
- Modify only if a verification failure exposes a scoped defect.
- Do not commit screenshots, temporary renders, Playwright scripts, or ffprobe logs.

**Interfaces:**
- Verifies the complete design rather than introducing a new interface.

- [ ] **Step 1: Run the complete backend suite**

```bash
cd backend
/home/violet/miniconda3/envs/wems/bin/python -m pytest -q
```

- [ ] **Step 2: Run the complete frontend/worker suite**

```bash
cd web
npm test -- --reporter=dot
```

- [ ] **Step 3: Run scoped lint and production build**

```bash
cd web
npm exec eslint -- \
  lib/ai/text-video-render-job.ts \
  lib/ai/text-video-render-job.test.ts \
  lib/api/text-videos.ts \
  app/text-video/useTextVideoProjectActions.ts \
  app/text-video/VideoStage.tsx \
  app/text-video/TextVideoWorkbench.tsx \
  app/text-video/TextVideoEditorClient.tsx \
  scripts/content-worker.ts
npm run build
```

- [ ] **Step 4: Rebuild and start runtime services**

```bash
docker compose up -d --build api worker
docker compose ps
curl --fail http://localhost:8000/health
curl --fail http://localhost:3000/text-video/2
```

- [ ] **Step 5: Render a real ready project through the UI**

Use Playwright outside the repository:

1. Open `/text-video/{ready_project_id}`.
2. Enter “视频合成”.
3. Click “渲染 MP4”.
4. Assert progress is non-decreasing.
5. Close and reopen the page while running; assert state remains queued/rendering.
6. Wait for “下载 MP4”.
7. Capture screenshots before render, during progress, and after completion.
8. Assert no framework overlay, console errors, or page errors.

- [ ] **Step 6: Download and inspect the actual output**

```bash
curl --fail --location \
  http://localhost:8000/api/text-videos/2/output/download \
  --output /tmp/wms-text-video-output.mp4
ffprobe -v error \
  -show_entries stream=codec_name,codec_type,width,height,r_frame_rate \
  -show_entries format=duration,size \
  -of json /tmp/wms-text-video-output.mp4
```

Expected:

- one `h264` video stream;
- one `aac` audio stream;
- dimensions and FPS match the project;
- nonzero file size;
- duration differs from the project master duration by no more than one frame.

- [ ] **Step 7: Verify rerender invalidation**

Change one template visual property, wait for autosave, assert the previous player remains
with a stale notice, rerender, and assert `output_asset_url` changes while the previous
CreativeAsset still exists.

- [ ] **Step 8: Review final diff and commits**

```bash
git diff --check
git status --short
git log --oneline -8
```

Confirm all unrelated pre-existing dirty changes remain untouched and unstaged by this
feature's commits.
