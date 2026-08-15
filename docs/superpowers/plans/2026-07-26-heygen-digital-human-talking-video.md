# HeyGen Digital Human Talking Video Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a complete “数字人口播” workflow that creates reusable single-photo HeyGen avatars with cloned voices, edits AI-assisted scripts, renders versioned talking videos with environment images, and persists completed MP4 files in Ediora creative assets.

**Architecture:** Python/FastAPI owns the digital-human, talking-project, render-version, settings, and creative-asset domain records in Postgres. The existing Redis-backed Node worker executes two new durable flows against a focused HeyGen V3 TypeScript client, while a dedicated Next.js AI route returns editable script candidates. The existing Next.js UI adds a role library and three-column talking-video editor.

**Tech Stack:** Python 3.11, FastAPI, SQLAlchemy async, PostgreSQL/SQLite tests, Redis, Next.js 16 App Router, React 19, TypeScript, Vercel AI SDK 7, Zod 4, Vitest, Testing Library, HeyGen V3 REST API.

## Global Constraints

- Work from `main` at or after design commit `67ce67a`.
- The creation menu label is exactly `数字人口播`.
- The two internal tabs are exactly `口播作品` and `数字人角色`.
- First release uses only HeyGen V3; do not add other avatar providers or local models.
- A role owns one portrait asset, one cloned voice, and one default environment asset; it never owns a script.
- A script belongs to one talking-video project and remains editable before render.
- Environment images support upload, creative-asset selection, and the existing `standalone_image` job.
- Render output is MP4, 16:9, with no burned captions, background music, transitions, B-roll, or timeline.
- Every render creates a new immutable version and never overwrites an earlier version.
- A render succeeds only after the HeyGen result has been downloaded into a local creative video asset.
- HeyGen API keys stay server-side, are redacted in public settings responses, and never appear in logs or job events.
- Direct HeyGen uploads are limited to 32 MB; portraits/environments accept JPEG or PNG, and voice samples accept MP3 or WAV.
- Use HeyGen `Idempotency-Key` for asset, avatar, and video mutations; retries reuse already persisted external IDs.
- Publishing, realtime avatars, Digital Twin video training, subtitles, and an independent script library are out of scope.

---

### Task 1: Persist digital-human roles, talking projects, and render versions

**Files:**
- Modify: `backend/models.py`
- Create: `backend/digital_human_service.py`
- Create: `backend/tests/test_digital_human_service.py`

**Interfaces:**
- Consumes: `models.CreativeAsset`, `content_jobs.create_job(session, flow, title, input_data, idempotency_key)`.
- Produces:
  - `DigitalHuman`, `TalkingVideoProject`, `TalkingVideoRender` ORM models.
  - `create_digital_human(session, *, name, portrait_asset_id, voice_sample_asset_id, default_environment_asset_id) -> tuple[DigitalHuman, ContentJob]`.
  - `create_talking_project(session, *, title, digital_human_id, environment_asset_id=None) -> TalkingVideoProject`.
  - `create_render(session, *, project_id) -> tuple[TalkingVideoRender, ContentJob]`.
  - `archive_digital_human(session, role_id) -> DigitalHuman`.
  - `delete_digital_human(session, role_id) -> None`.
  - `select_render(session, project_id, render_id) -> TalkingVideoProject`.

- [ ] **Step 1: Write failing service tests**

```python
async def test_create_role_and_setup_job_are_committed_together(session, media_assets):
    from digital_human_service import create_digital_human
    role, job = await create_digital_human(
        session,
        name="林晓",
        portrait_asset_id=media_assets.portrait.id,
        voice_sample_asset_id=media_assets.voice.id,
        default_environment_asset_id=media_assets.environment.id,
    )
    assert role.status == "processing"
    assert role.setup_job_id == job.id
    assert job.flow == "digital_human_setup"
    assert job.input_data == {"digital_human_id": role.id}


async def test_render_freezes_inputs_and_increments_version(session, ready_role, project):
    from digital_human_service import create_render
    project.script = "第一版脚本"
    first, _ = await create_render(session, project_id=project.id)
    project.script = "第二版脚本"
    second, _ = await create_render(session, project_id=project.id)
    assert (first.version, first.script_snapshot) == (1, "第一版脚本")
    assert (second.version, second.script_snapshot) == (2, "第二版脚本")
    assert first.digital_human_snapshot["heygen_avatar_id"] == ready_role.heygen_avatar_id


async def test_role_with_projects_is_archived_instead_of_deleted(session, ready_role, project):
    from digital_human_service import DigitalHumanInUse, delete_digital_human
    with pytest.raises(DigitalHumanInUse):
        await delete_digital_human(session, ready_role.id)
```

- [ ] **Step 2: Run the focused tests and confirm model/service failures**

Run: `conda run -n wems pytest backend/tests/test_digital_human_service.py -q`

Expected: FAIL because the models and service module do not exist.

- [ ] **Step 3: Add the three focused ORM models**

Add:

```python
class DigitalHuman(Base):
    __tablename__ = "digital_humans"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="processing", index=True)
    portrait_asset_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    voice_sample_asset_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    default_environment_asset_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    heygen_avatar_group_id: Mapped[str] = mapped_column(String, default="")
    heygen_avatar_id: Mapped[str] = mapped_column(String, default="")
    heygen_voice_id: Mapped[str] = mapped_column(String, default="")
    provider_state: Mapped[dict] = mapped_column(JSON, default=dict)
    setup_job_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    error: Mapped[str] = mapped_column(Text, default="")
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)


class TalkingVideoProject(Base):
    __tablename__ = "talking_video_projects"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(300), default="")
    digital_human_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    script: Mapped[str] = mapped_column(Text, default="")
    script_source: Mapped[str] = mapped_column(String(20), default="manual")
    source_draft_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    environment_asset_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    current_render_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)


class TalkingVideoRender(Base):
    __tablename__ = "talking_video_renders"
    __table_args__ = (UniqueConstraint("project_id", "version", name="uq_talking_video_render_version"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="queued", index=True)
    job_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    script_snapshot: Mapped[str] = mapped_column(Text, nullable=False)
    digital_human_snapshot: Mapped[dict] = mapped_column(JSON, default=dict)
    environment_asset_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    provider_state: Mapped[dict] = mapped_column(JSON, default=dict)
    heygen_environment_asset_id: Mapped[str] = mapped_column(String, default="")
    heygen_video_id: Mapped[str] = mapped_column(String, default="")
    video_asset_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    error: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
```

- [ ] **Step 4: Implement asset validation and transactional creation**

`create_digital_human()` must:

```python
portrait = await require_media_asset(session, portrait_asset_id, {"image/png", "image/jpeg"}, 32 * 1024 * 1024)
voice = await require_media_asset(session, voice_sample_asset_id, {"audio/mpeg", "audio/wav", "audio/x-wav"}, 32 * 1024 * 1024)
environment = await require_media_asset(session, default_environment_asset_id, {"image/png", "image/jpeg"}, 32 * 1024 * 1024)
role = DigitalHuman(...)
session.add(role)
await session.flush()
job = await create_job(
    session,
    flow="digital_human_setup",
    title=f"初始化数字人 · {role.name}",
    input_data={"digital_human_id": role.id},
    idempotency_key=f"digital-human-setup:{role.id}:1",
)
role.setup_job_id = job.id
await session.commit()
```

`create_render()` must lock or query the latest version, require a ready role, non-empty script, and an effective environment. Its snapshot contains role ID/name and current HeyGen avatar/voice IDs. It creates `digital_human_render` with `input_data={"render_id": render.id}`.

- [ ] **Step 5: Add selection, archive, and deletion protection**

Implement:

```python
class DigitalHumanInUse(ValueError): ...
class InvalidTalkingVideo(ValueError): ...

async def archive_digital_human(session, role_id):
    role.status = "archived"
    role.archived_at = now_utc()

async def select_render(session, project_id, render_id):
    if render.project_id != project_id or render.status != "succeeded":
        raise InvalidTalkingVideo("只能选择已成功的本项目成片")
    project.current_render_id = render.id
```

- [ ] **Step 6: Run service tests**

Run: `conda run -n wems pytest backend/tests/test_digital_human_service.py -q`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/models.py backend/digital_human_service.py backend/tests/test_digital_human_service.py
git commit -m "feat(digital-human): persist roles projects and renders"
```

---

### Task 2: Add HeyGen settings, secret redaction, and connection testing

**Files:**
- Modify: `backend/config.py`
- Modify: `backend/routers/settings.py`
- Modify: `backend/tests/test_blog_publish.py`
- Create: `backend/tests/test_heygen_settings.py`

**Interfaces:**
- Consumes: existing `get_config()`, `set_config()`, `redact_secret_text()`.
- Produces:
  - Public settings fields `heygen_api_key_set`, `heygen_api_key_preview`.
  - Update field `heygen_api_key`.
  - Hidden `GET /api/settings/heygen-runtime -> {"api_key": string, "base_url": "https://api.heygen.com"}`.
  - `POST /api/settings/heygen/test -> {"ok": bool, "error": str}`.

- [ ] **Step 1: Write failing settings tests**

```python
def test_heygen_key_roundtrip_is_redacted(client):
    saved = client.put("/api/settings", json={"heygen_api_key": "hg_secret_1234"}).json()
    assert saved["heygen_api_key_set"] is True
    assert saved["heygen_api_key_preview"] == "…1234"
    assert "hg_secret_1234" not in str(saved)


def test_heygen_runtime_uses_environment_fallback(client, monkeypatch):
    monkeypatch.setenv("HEYGEN_API_KEY", "env-key")
    response = client.get("/api/settings/heygen-runtime")
    assert response.json() == {"api_key": "env-key", "base_url": "https://api.heygen.com"}


def test_heygen_connection_classifies_plan_and_auth_errors(client, httpx_mock):
    httpx_mock.add_response(status_code=401, json={"error": {"code": "authentication_failed", "message": "bad"}})
    response = client.post("/api/settings/heygen/test")
    assert response.status_code == 200
    assert response.json() == {"ok": False, "error": "HeyGen API Key 无效"}
```

- [ ] **Step 2: Run the new settings tests and verify failure**

Run: `conda run -n wems pytest backend/tests/test_heygen_settings.py -q`

Expected: FAIL because the settings fields and endpoints do not exist.

- [ ] **Step 3: Add stored/default settings and public schemas**

Add `heygen_api_key: ""` to `DEFAULTS`; extend `SettingsOut`, `SettingsUpdate`, `_build_out()`, and the settings update handler. Never place the clear key in `SettingsOut`.

- [ ] **Step 4: Implement internal runtime and connection test**

Use:

```python
def effective_heygen_api_key(cfg: dict) -> str:
    return cfg.get("heygen_api_key", "").strip() or os.getenv("HEYGEN_API_KEY", "").strip()

@router.get("/heygen-runtime", include_in_schema=False)
async def heygen_runtime():
    return {"api_key": effective_heygen_api_key(await get_config()), "base_url": "https://api.heygen.com"}
```

The test endpoint calls `GET https://api.heygen.com/v3/avatars?ownership=private&limit=1` with `x-api-key`. Map 401 to invalid key, 403 to unavailable plan, 429 to rate-limited, and other failures through `redact_secret_text()`.

- [ ] **Step 5: Run settings regression tests**

Run: `conda run -n wems pytest backend/tests/test_heygen_settings.py backend/tests/test_blog_publish.py backend/tests/test_web_search_settings.py -q`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/config.py backend/routers/settings.py backend/tests/test_heygen_settings.py backend/tests/test_blog_publish.py
git commit -m "feat(settings): configure HeyGen server credentials"
```

---

### Task 3: Expose role, project, render, and worker APIs

**Files:**
- Create: `backend/routers/digital_humans.py`
- Create: `backend/routers/talking_videos.py`
- Modify: `backend/main.py`
- Create: `backend/tests/test_digital_humans_router.py`
- Create: `backend/tests/test_talking_videos_router.py`

**Interfaces:**
- Consumes: Task 1 service functions and models; `job_queue.enqueue_job`.
- Produces the public and worker-only endpoints from the design spec.
- Worker progress bodies:

```python
class RoleWorkerProgress(BaseModel):
    status: Literal["processing", "ready", "failed"]
    heygen_avatar_group_id: str = ""
    heygen_avatar_id: str = ""
    heygen_voice_id: str = ""
    provider_state: dict = Field(default_factory=dict)
    error: str = ""

class RenderWorkerProgress(BaseModel):
    status: Literal["running", "succeeded", "failed", "cancelled"]
    heygen_environment_asset_id: str = ""
    heygen_video_id: str = ""
    video_asset_id: int | None = None
    provider_state: dict = Field(default_factory=dict)
    error: str = ""
```

- [ ] **Step 1: Write failing router tests**

```python
def test_create_role_enqueues_setup_job(client, media_assets, monkeypatch):
    queued = []
    import routers.digital_humans as digital_humans_router
    async def capture_enqueue(job_id: int):
        queued.append(job_id)
    monkeypatch.setattr(digital_humans_router, "enqueue_job", capture_enqueue)
    response = client.post("/api/digital-humans", json={
        "name": "林晓",
        "portrait_asset_id": media_assets["portrait"],
        "voice_sample_asset_id": media_assets["voice"],
        "default_environment_asset_id": media_assets["environment"],
    })
    assert response.status_code == 201
    assert response.json()["status"] == "processing"
    assert queued == [response.json()["setup_job_id"]]


def test_render_endpoint_rejects_non_ready_role(client, project):
    response = client.post(f"/api/talking-videos/{project['id']}/renders")
    assert response.status_code == 409
    assert "尚未就绪" in response.json()["detail"]


def test_worker_context_returns_internal_asset_urls(client, ready_role):
    context = client.get(f"/api/digital-humans/{ready_role['id']}/worker-context").json()
    assert context["portrait"]["url"].startswith("/api/uploads/")
    assert "api_key" not in context
```

- [ ] **Step 2: Run router tests to verify failure**

Run: `conda run -n wems pytest backend/tests/test_digital_humans_router.py backend/tests/test_talking_videos_router.py -q`

Expected: FAIL because the routers do not exist.

- [ ] **Step 3: Implement role endpoints**

Use Pydantic request/response models with exact media IDs. Public list excludes archived roles by default and supports `include_archived=true`. `POST /{id}/retry` creates a new `digital_human_setup` job using the current local assets and enqueues it.

When `PATCH /{id}` changes portrait, voice sample, or default environment, retain the currently active
HeyGen avatar/voice IDs in their public fields, set the role to `processing`, clear the visible error,
and create a new setup job. New provider IDs stay in `provider_state` until both avatar and voice are
ready; the final worker update promotes them together.

- [ ] **Step 4: Implement project and render endpoints**

`PATCH /api/talking-videos/{id}` accepts only `title`, `digital_human_id`, `script`, `script_source`, `source_draft_id`, and `environment_asset_id`. `POST /renders` creates the render/job transaction, commits, and then enqueues. Return nested role, effective environment, renders ordered newest-first, and local video asset URL.

Project deletion removes project/render rows but does not delete `CreativeAsset` records or upload files.
Render deletion is allowed for failed/cancelled rows; a successful current render must first be replaced
or explicitly cleared. Role deletion returns 409 when any project references it and exposes Archive as
the supported action.

- [ ] **Step 5: Implement worker contexts and progress**

Worker context must return only required local asset metadata, role/provider IDs, script snapshot, and target identifiers. Progress endpoints validate referenced local assets and never accept arbitrary model-field updates.

- [ ] **Step 6: Register routers and run tests**

Run:

```bash
conda run -n wems pytest \
  backend/tests/test_digital_humans_router.py \
  backend/tests/test_talking_videos_router.py \
  backend/tests/test_jobs_router.py -q
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/routers/digital_humans.py backend/routers/talking_videos.py backend/main.py backend/tests/test_digital_humans_router.py backend/tests/test_talking_videos_router.py
git commit -m "feat(digital-human): expose role and talking-video APIs"
```

---

### Task 4: Implement a typed HeyGen V3 client with retry classification

**Files:**
- Create: `web/lib/heygen/client.ts`
- Create: `web/lib/heygen/client.test.ts`

**Interfaces:**
- Produces:

```ts
export type HeyGenConfig = { apiKey: string; baseUrl: string }
export type HeyGenAsset = { asset_id: string; url?: string }
export type HeyGenAvatar = { groupId: string; avatarId: string; status: string; error?: string }
export type HeyGenVoice = { voiceId: string; status: string; error?: string }
export type HeyGenVideo = { videoId: string; status: string; videoUrl?: string; thumbnailUrl?: string; error?: string }

export class HeyGenError extends Error {
  retryable: boolean
  code: string
  status: number
}

export function createHeyGenClient(config: HeyGenConfig): {
  uploadAsset(bytes: Uint8Array, mediaType: string, filename: string, idempotencyKey: string): Promise<HeyGenAsset>
  createPhotoAvatar(input: { name: string; assetId: string; idempotencyKey: string }): Promise<HeyGenAvatar>
  getAvatar(groupId: string, avatarId: string): Promise<HeyGenAvatar>
  cloneVoice(input: { name: string; assetId: string }): Promise<{ voiceId: string }>
  getVoice(voiceId: string): Promise<HeyGenVoice>
  createVideo(input: { title: string; avatarId: string; voiceId: string; script: string; backgroundAssetId: string; idempotencyKey: string }): Promise<HeyGenVideo>
  getVideo(videoId: string): Promise<HeyGenVideo>
}
```

- [ ] **Step 1: Write failing contract tests**

```ts
it('creates a photo avatar with an uploaded asset', async () => {
  fetchMock.mockResolvedValue(jsonResponse({
    data: { avatar_item: { id: 'look-1', group_id: 'group-1', status: 'processing' } },
  }))
  const result = await client.createPhotoAvatar({ name: '林晓', assetId: 'asset-1', idempotencyKey: 'role:1:avatar' })
  expect(fetchMock).toHaveBeenCalledWith(
    'https://api.heygen.com/v3/avatars',
    expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'x-api-key': 'secret', 'Idempotency-Key': 'role:1:avatar' }),
      body: JSON.stringify({ type: 'photo', name: '林晓', file: { type: 'asset_id', asset_id: 'asset-1' } }),
    }),
  )
  expect(result).toMatchObject({ groupId: 'group-1', avatarId: 'look-1', status: 'processing' })
})


it.each([
  [401, 'authentication_failed', false],
  [403, 'plan_upgrade_required', false],
  [429, 'rate_limit_exceeded', true],
  [500, 'provider_error', true],
])('classifies status %s', async (status, code, retryable) => {
  fetchMock.mockResolvedValue(jsonResponse({ error: { code, message: 'provider detail' } }, status))
  await expect(client.getVideo('video-1')).rejects.toMatchObject({ code, retryable })
})
```

- [ ] **Step 2: Run client tests and verify failure**

Run: `cd web && pnpm test -- lib/heygen/client.test.ts`

Expected: FAIL because the client does not exist.

- [ ] **Step 3: Implement request parsing and error redaction**

`request()` must use `x-api-key`, parse `{data}` / `{error}`, honor `Retry-After`, and expose only the HeyGen machine code plus a short redacted message. Do not include headers or raw bodies in thrown errors.

- [ ] **Step 4: Implement all endpoint methods**

Video creation body:

```ts
{
  type: 'avatar',
  title,
  avatar_id: avatarId,
  script,
  voice_id: voiceId,
  background: { type: 'image', asset_id: backgroundAssetId },
  aspect_ratio: '16:9',
  output_format: 'mp4',
}
```

Use `/v3/assets`, `/v3/avatars`, `/v3/avatars/${groupId}`, `/v3/avatars/looks/${avatarId}`, `/v3/voices/clone`, `/v3/voices/${voiceId}`, `/v3/videos`, and `/v3/videos/${videoId}`.

- [ ] **Step 5: Run HeyGen client tests**

Run: `cd web && pnpm test -- lib/heygen/client.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/lib/heygen/client.ts web/lib/heygen/client.test.ts
git commit -m "feat(heygen): add typed V3 API client"
```

---

### Task 5: Execute role setup and video render as durable worker flows

**Files:**
- Create: `web/lib/ai/digital-human-job.ts`
- Create: `web/lib/ai/digital-human-job.test.ts`
- Modify: `web/scripts/content-worker.ts`
- Modify: `web/lib/ai/job-client.ts`
- Modify: `web/lib/api/jobs.ts`

**Interfaces:**
- Consumes: Task 3 worker APIs and Task 4 HeyGen client.
- Produces:
  - `runDigitalHumanSetupJob(jobId: number): Promise<void>`.
  - `runDigitalHumanRenderJob(jobId: number): Promise<void>`.
  - Worker routing for `digital_human_setup` and `digital_human_render`.

- [ ] **Step 1: Write failing setup-flow tests**

```ts
it('uploads portrait and voice then marks the role ready', async () => {
  api.getRoleContext.mockResolvedValue(roleContext)
  heygen.uploadAsset
    .mockResolvedValueOnce({ asset_id: 'portrait-hg' })
    .mockResolvedValueOnce({ asset_id: 'voice-hg' })
  heygen.createPhotoAvatar.mockResolvedValue({ groupId: 'group-1', avatarId: 'avatar-1', status: 'processing' })
  heygen.getAvatar.mockResolvedValue({ groupId: 'group-1', avatarId: 'avatar-1', status: 'completed' })
  heygen.cloneVoice.mockResolvedValue({ voiceId: 'voice-1' })
  heygen.getVoice.mockResolvedValue({ voiceId: 'voice-1', status: 'complete' })

  await runDigitalHumanSetupJob(41, deps)

  expect(api.updateRole).toHaveBeenLastCalledWith(roleContext.id, expect.objectContaining({
    status: 'ready', heygen_avatar_id: 'avatar-1', heygen_voice_id: 'voice-1',
  }))
  expect(api.completeJob).toHaveBeenCalledWith(41)
})


it('reuses persisted avatar id on a retried voice step', async () => {
  api.getRoleContext.mockResolvedValue({ ...roleContext, provider_state: { avatar_id: 'avatar-1', avatar_group_id: 'group-1' } })
  await runDigitalHumanSetupJob(42, deps)
  expect(heygen.createPhotoAvatar).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Write failing render-flow tests**

```ts
it('downloads HeyGen output and saves a local creative video asset', async () => {
  api.getRenderContext.mockResolvedValue(renderContext)
  heygen.createVideo.mockResolvedValue({ videoId: 'video-1', status: 'waiting' })
  heygen.getVideo.mockResolvedValue({ videoId: 'video-1', status: 'completed', videoUrl: 'https://files.heygen.ai/result.mp4' })
  fetchMock.mockResolvedValueOnce(binaryResponse(mp4Bytes, 'video/mp4'))
  api.saveVideoAsset.mockResolvedValue({ id: 88, url: '/api/uploads/result.mp4' })

  await runDigitalHumanRenderJob(51, deps)

  expect(api.updateRender).toHaveBeenLastCalledWith(renderContext.render.id, expect.objectContaining({
    status: 'succeeded', heygen_video_id: 'video-1', video_asset_id: 88,
  }))
})
```

- [ ] **Step 3: Run job tests to verify failure**

Run: `cd web && pnpm test -- lib/ai/digital-human-job.test.ts`

Expected: FAIL because the orchestration module is missing.

- [ ] **Step 4: Implement polling, cancellation checks, and state checkpoints**

Each external mutation immediately persists returned IDs through the worker progress endpoint. Poll with bounded exponential intervals from 2 seconds to 15 seconds and a 30-minute deadline. Before each poll, call `getJob(jobId)` and stop if `status === "cancelled"`.

On retry, derive the latest attempt for each step from `job.steps`: skip succeeded steps, start the
queued retry attempt, and never call `startStep()` for a previously succeeded step. Reuse IDs from
`provider_state` before invoking a HeyGen mutation.

Start/succeed/fail exact durable steps:

```ts
digital_human_setup: ['heygen_avatar', 'heygen_voice', 'finalize_digital_human']
digital_human_render: ['heygen_render', 'save_talking_video']
```

On `HeyGenError`, pass its `retryable` flag to `failStep()`. On local fetch/upload errors, use retryable `true`.

- [ ] **Step 5: Implement local asset fetch and MP4 save**

Resolve relative local URLs against `apiBase()`. Save videos with multipart:

```ts
const form = new FormData()
form.append('file', new Blob([bytes], { type: 'video/mp4' }), `talking-video-${render.id}-v${render.version}.mp4`)
fetch(`${apiBase()}/assets/upload?media_kind=video&title=${encodeURIComponent(title)}`, {
  method: 'POST',
  headers: { 'X-Content-Job-Id': String(jobId) },
  body: form,
})
```

- [ ] **Step 6: Route worker flows**

In `scripts/content-worker.ts`:

```ts
if (job.flow === 'digital_human_setup') await runDigitalHumanSetupJob(jobId)
else if (job.flow === 'digital_human_render') await runDigitalHumanRenderJob(jobId)
else if (job.flow === 'x_response') ...
```

- [ ] **Step 7: Run worker and existing AI-flow tests**

Run:

```bash
cd web
pnpm test -- lib/ai/digital-human-job.test.ts lib/ai/content-job.test.ts lib/ai/job-client-retryability.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add web/lib/ai/digital-human-job.ts web/lib/ai/digital-human-job.test.ts web/scripts/content-worker.ts web/lib/ai/job-client.ts web/lib/api/jobs.ts
git commit -m "feat(heygen): run durable avatar and render jobs"
```

---

### Task 6: Add AI script generation, draft conversion, and rewriting

**Files:**
- Create: `web/app/api/digital-human/script/route.ts`
- Create: `web/app/api/digital-human/script/route.test.ts`
- Create: `web/lib/ai/talking-script.ts`
- Create: `web/lib/ai/talking-script.test.ts`

**Interfaces:**
- Consumes: hidden `/settings/ai-runtime` and current configured OpenAI-compatible provider.
- Produces:

```ts
export type TalkingScriptRequest =
  | { mode: 'generate'; topic: string; instructions?: string }
  | { mode: 'convert_draft'; draftId: number; instructions?: string }
  | { mode: 'rewrite'; script: string; instructions: string }

export function buildTalkingScriptPrompt(input: TalkingScriptRequest, draft?: { title: string; content: string }): string
export function cleanTalkingScript(text: string): string
```

- [ ] **Step 1: Write failing prompt and route tests**

```ts
it('converts a draft without changing facts or retaining markdown', () => {
  const prompt = buildTalkingScriptPrompt(
    { mode: 'convert_draft', draftId: 7 },
    { title: 'AI 工作流', content: '# 标题\n[链接](https://example.com)\n事实正文' },
  )
  expect(prompt).toContain('保留原文事实')
  expect(prompt).toContain('自然口语')
  expect(prompt).toContain('事实正文')
})


it('strips markdown fences from the model result', () => {
  expect(cleanTalkingScript('```markdown\\n大家好。\\n```')).toBe('大家好。')
})
```

Route tests mock `generateText`, configured model loading, and draft fetch. They assert that no draft update or video job is performed.

- [ ] **Step 2: Run script tests and verify failure**

Run: `cd web && pnpm test -- lib/ai/talking-script.test.ts app/api/digital-human/script/route.test.ts`

Expected: FAIL because the route/helpers do not exist.

- [ ] **Step 3: Implement schemas and prompt builders**

Use Zod discriminated unions. All modes instruct the model to return only final spoken text, preserve verified facts, avoid Markdown headings/links, and never trigger generation or publishing.

- [ ] **Step 4: Implement the server route**

Load the selected draft from `GET /write/drafts/{draftId}` only for `convert_draft`. Reject source content over 60,000 characters and empty outputs. Return `{script: cleanTalkingScript(result.text)}`.

- [ ] **Step 5: Run tests**

Run: `cd web && pnpm test -- lib/ai/talking-script.test.ts app/api/digital-human/script/route.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/app/api/digital-human/script/route.ts web/app/api/digital-human/script/route.test.ts web/lib/ai/talking-script.ts web/lib/ai/talking-script.test.ts
git commit -m "feat(digital-human): add AI talking-script assistance"
```

---

### Task 7: Add frontend API contracts, HeyGen settings UI, and navigation

**Files:**
- Create: `web/lib/api/digital-humans.ts`
- Create: `web/lib/api/digital-humans.test.ts`
- Modify: `web/lib/api/settings.ts`
- Modify: `web/lib/api/settings-test-fixtures.ts`
- Create: `web/app/settings/sections/HeyGenSection.tsx`
- Modify: `web/app/settings/SettingsClient.tsx`
- Modify: `web/components/features/Sidebar.tsx`
- Create: `web/components/features/sidebar-digital-human.test.ts`

**Interfaces:**
- Produces typed API functions for roles/projects/renders plus `generateTalkingScript()`.
- Public settings type includes `heygen_api_key_set` and `heygen_api_key_preview`.

- [ ] **Step 1: Write failing API and navigation tests**

```ts
it('creates a render through the talking-video API', async () => {
  fetchMock.mockResolvedValue(jsonResponse(renderFixture, 201))
  await createTalkingVideoRender(14)
  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining('/talking-videos/14/renders'),
    expect.objectContaining({ method: 'POST' }),
  )
})


it('uses the unambiguous creation menu label', () => {
  const source = readFileSync(new URL('./Sidebar.tsx', import.meta.url), 'utf8')
  expect(source).toContain("label: '数字人口播'")
  expect(source).toContain("href: '/digital-humans'")
})
```

- [ ] **Step 2: Run frontend API tests and verify failure**

Run: `cd web && pnpm test -- lib/api/digital-humans.test.ts components/features/sidebar-digital-human.test.ts`

Expected: FAIL because the API module/menu item are missing.

- [ ] **Step 3: Add complete TypeScript domain types and API calls**

Define `DigitalHuman`, `TalkingVideoProject`, `TalkingVideoRender`, and request types matching Task 3 exactly. Include upload reuse through `uploadCreativeAsset()` and job polling through the existing jobs client.

- [ ] **Step 4: Add HeyGen settings section**

The page stores a newly entered key only, shows `已配置 (…1234)`, and exposes Save/Test actions. Add:

```ts
{ id: 'heygen', label: 'HeyGen', icon: Video, desc: '数字人 · 声音克隆 · 视频生成' }
```

The test button calls `POST /settings/heygen/test` and renders invalid-key, plan, rate-limit, and generic connection messages.

- [ ] **Step 5: Add the sidebar entry**

Place `{ href: '/digital-humans', label: '数字人口播', icon: PersonStanding }` after “创作资产”.

- [ ] **Step 6: Run tests and TypeScript**

Run:

```bash
cd web
pnpm test -- lib/api/digital-humans.test.ts components/features/sidebar-digital-human.test.ts
pnpm exec tsc --noEmit
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web/lib/api/digital-humans.ts web/lib/api/digital-humans.test.ts web/lib/api/settings.ts web/lib/api/settings-test-fixtures.ts web/app/settings/sections/HeyGenSection.tsx web/app/settings/SettingsClient.tsx web/components/features/Sidebar.tsx web/components/features/sidebar-digital-human.test.ts
git commit -m "feat(ui): configure and navigate HeyGen talking videos"
```

---

### Task 8: Build the digital-human role library and creation workflow

**Files:**
- Create: `web/app/digital-humans/page.tsx`
- Create: `web/app/digital-humans/DigitalHumansClient.tsx`
- Create: `web/app/digital-humans/RoleLibrary.tsx`
- Create: `web/app/digital-humans/RoleEditorDialog.tsx`
- Create: `web/app/digital-humans/EnvironmentPickerDialog.tsx`
- Create: `web/app/digital-humans/role-management.test.tsx`

**Interfaces:**
- Consumes: Task 7 API module, creative assets API, and `standalone_image` job.
- Produces the `数字人角色` tab and reusable `EnvironmentPickerDialog`.

- [ ] **Step 1: Write failing role-management component tests**

```tsx
it('creates a role from portrait voice and default environment assets', async () => {
  const user = userEvent.setup()
  render(<RoleEditorDialog open onClose={vi.fn()} onCreated={vi.fn()} />)
  await user.type(screen.getByLabelText('角色名称'), '林晓')
  await user.click(screen.getByRole('button', { name: '选择人物形象' }))
  await user.click(await screen.findByRole('button', { name: portraitAsset.title }))
  await user.click(screen.getByRole('button', { name: '选择声音样本' }))
  await user.click(await screen.findByRole('button', { name: voiceAsset.title }))
  await user.click(screen.getByRole('button', { name: '选择默认环境' }))
  await user.click(await screen.findByRole('button', { name: environmentAsset.title }))
  await user.click(screen.getByRole('button', { name: '保存并开始处理' }))
  expect(createDigitalHuman).toHaveBeenCalledWith({
    name: '林晓',
    portrait_asset_id: portraitAsset.id,
    voice_sample_asset_id: voiceAsset.id,
    default_environment_asset_id: environmentAsset.id,
  })
})


it('offers upload asset and AI generation for environment images', () => {
  render(<EnvironmentPickerDialog open onClose={vi.fn()} onSelect={vi.fn()} />)
  expect(screen.getByRole('tab', { name: '上传图片' })).toBeVisible()
  expect(screen.getByRole('tab', { name: '创作资产' })).toBeVisible()
  expect(screen.getByRole('tab', { name: 'AI 生成' })).toBeVisible()
})
```

- [ ] **Step 2: Run component tests and verify failure**

Run: `cd web && pnpm test -- app/digital-humans/role-management.test.tsx`

Expected: FAIL because the components are missing.

- [ ] **Step 3: Implement role cards and states**

Cards show portrait, name, default environment, project count, and one of:

```text
处理中
可以创作
处理失败
已归档
```

Only failed roles show Retry; only ready roles can start a project. Existing-project roles expose Archive instead of Delete.

- [ ] **Step 4: Implement role creation and asset inputs**

Upload through the existing creative-assets endpoint before role creation. Validate 32 MB and MIME types client-side. The dialog can close after role creation; the library polls roles every 3 seconds while any role is processing.

- [ ] **Step 5: Implement AI environment generation**

Create `standalone_image` with the free-text prompt, poll the job, extract `asset_id`, select the generated creative image, and allow setting it as the default environment.

- [ ] **Step 6: Run role tests and TypeScript**

Run:

```bash
cd web
pnpm test -- app/digital-humans/role-management.test.tsx
pnpm exec tsc --noEmit
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web/app/digital-humans/page.tsx web/app/digital-humans/DigitalHumansClient.tsx web/app/digital-humans/RoleLibrary.tsx web/app/digital-humans/RoleEditorDialog.tsx web/app/digital-humans/EnvironmentPickerDialog.tsx web/app/digital-humans/role-management.test.tsx
git commit -m "feat(ui): create and manage digital-human roles"
```

---

### Task 9: Build the three-column talking-video editor and render versions

**Files:**
- Create: `web/app/digital-humans/TalkingProjectList.tsx`
- Create: `web/app/digital-humans/TalkingVideoEditor.tsx`
- Create: `web/app/digital-humans/ScriptAssistantDialog.tsx`
- Create: `web/app/digital-humans/RenderVersionsPanel.tsx`
- Create: `web/app/digital-humans/talking-video-editor.test.tsx`
- Create: `web/app/digital-humans/talking-video-layout.test.ts`

**Interfaces:**
- Consumes: Tasks 6–8.
- Produces the `口播作品` tab, auto-saving script editor, role/environment selection, and versioned render UI.

- [ ] **Step 1: Write failing editor tests**

```tsx
it('renders the approved three-column workbench', () => {
  render(<TalkingVideoEditor project={projectFixture} roles={[readyRole]} />)
  expect(screen.getByTestId('talking-config-column')).toBeVisible()
  expect(screen.getByTestId('talking-script-column')).toBeVisible()
  expect(screen.getByTestId('talking-render-column')).toBeVisible()
})


it('debounces script saves and never renders before explicit confirmation', async () => {
  vi.useFakeTimers()
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
  render(<TalkingVideoEditor project={projectFixture} roles={[readyRole]} />)
  await user.type(screen.getByLabelText('口播脚本'), '新的内容')
  await vi.advanceTimersByTimeAsync(700)
  expect(updateTalkingVideo).toHaveBeenCalledWith(projectFixture.id, expect.objectContaining({ script: expect.stringContaining('新的内容') }))
  expect(createTalkingVideoRender).not.toHaveBeenCalled()
})


it('keeps earlier successful versions after generating another render', async () => {
  render(<RenderVersionsPanel renders={[renderV2, renderV1]} currentRenderId={renderV2.id} />)
  expect(screen.getByText('版本 2')).toBeVisible()
  expect(screen.getByText('版本 1')).toBeVisible()
})
```

- [ ] **Step 2: Run editor tests and verify failure**

Run: `cd web && pnpm test -- app/digital-humans/talking-video-editor.test.tsx app/digital-humans/talking-video-layout.test.ts`

Expected: FAIL because the editor components are missing.

- [ ] **Step 3: Implement project list and new-project dialog**

List title, role, updated time, current render thumbnail/status. New project requires a ready role and defaults to the role environment. Route selection through `?project=<id>` without a full page reload.

- [ ] **Step 4: Implement the three-column editor**

Use desktop grid `grid-cols-[260px_minmax(420px,1fr)_360px]`; on narrow screens stack in config/script/render order. Keep role/environment selection on the left, a full-height plain-text editor in the center, and render preview/version history on the right.

- [ ] **Step 5: Implement script AI and draft conversion**

`ScriptAssistantDialog` exposes:

```text
根据主题生成
从草稿转换
改写当前脚本
```

The candidate replaces editor text only after the user clicks `使用这个脚本`. Mark `script_source` as `ai` or `draft` and keep `source_draft_id` for conversion.

- [ ] **Step 6: Implement auto-save and render guards**

Debounce project PATCH by 600 ms, flush pending save before render, and disable generation unless:

```ts
role.status === 'ready'
&& project.script.trim().length > 0
&& effectiveEnvironment !== null
&& noRenderIsRunning
```

- [ ] **Step 7: Implement render polling and version actions**

Poll the project every 3 seconds while any render is queued/running. Display local MP4 only from the saved creative asset URL. Allow select-current and deletion according to backend rules.

- [ ] **Step 8: Run editor tests, all frontend tests, and TypeScript**

Run:

```bash
cd web
pnpm test -- app/digital-humans/talking-video-editor.test.tsx app/digital-humans/talking-video-layout.test.ts
pnpm test
pnpm exec tsc --noEmit
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add web/app/digital-humans/TalkingProjectList.tsx web/app/digital-humans/TalkingVideoEditor.tsx web/app/digital-humans/ScriptAssistantDialog.tsx web/app/digital-humans/RenderVersionsPanel.tsx web/app/digital-humans/talking-video-editor.test.tsx web/app/digital-humans/talking-video-layout.test.ts
git commit -m "feat(ui): add HeyGen talking-video workbench"
```

---

### Task 10: Complete runtime configuration, documentation, and end-to-end verification

**Files:**
- Modify: `docker-compose.yml`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `web/README.md`
- Create: `backend/tests/test_digital_human_end_to_end.py`
- Create: `web/lib/ai/digital-human-live-smoke.ts`

**Interfaces:**
- Consumes all prior tasks.
- Produces documented `HEYGEN_API_KEY` fallback, a fake-provider end-to-end test, and an opt-in real HeyGen smoke command.

- [ ] **Step 1: Write a failing fake-provider end-to-end test**

The test must:

```python
def upload_fake_mp4(client, filename: str) -> dict:
    response = client.post(
        "/api/assets/upload?media_kind=video",
        files={"file": (filename, b"fake-mp4-bytes", "video/mp4")},
    )
    assert response.status_code == 201
    return response.json()


def test_role_to_two_versioned_local_videos(client):
    role = create_role_with_assets(client)
    client.post(f"/api/digital-humans/{role['id']}/worker-progress", json={
        "status": "ready",
        "heygen_avatar_group_id": "group-1",
        "heygen_avatar_id": "avatar-1",
        "heygen_voice_id": "voice-1",
        "provider_state": {},
    })
    assert client.get(f"/api/digital-humans/{role['id']}").json()["status"] == "ready"

    project = client.post("/api/talking-videos", json={
        "title": "AI 工作流口播",
        "digital_human_id": role["id"],
        "script": "第一版脚本",
    }).json()
    first = client.post(f"/api/talking-videos/{project['id']}/renders").json()
    first_asset = upload_fake_mp4(client, "version-1.mp4")
    client.post(f"/api/talking-videos/renders/{first['id']}/worker-progress", json={
        "status": "succeeded",
        "heygen_environment_asset_id": "environment-1",
        "heygen_video_id": "video-1",
        "video_asset_id": first_asset["id"],
        "provider_state": {},
    })

    client.patch(f"/api/talking-videos/{project['id']}", json={"script": "第二版脚本"})
    second = client.post(f"/api/talking-videos/{project['id']}/renders").json()
    second_asset = upload_fake_mp4(client, "version-2.mp4")
    client.post(f"/api/talking-videos/renders/{second['id']}/worker-progress", json={
        "status": "succeeded",
        "heygen_environment_asset_id": "environment-1",
        "heygen_video_id": "video-2",
        "video_asset_id": second_asset["id"],
        "provider_state": {},
    })

    detail = client.get(f"/api/talking-videos/{project['id']}").json()
    assert [item["version"] for item in detail["renders"]] == [2, 1]
    assert all(item["video_asset"]["url"].startswith("/api/uploads/") for item in detail["renders"])
```

- [ ] **Step 2: Run the end-to-end test and verify failure**

Run: `conda run -n wems pytest backend/tests/test_digital_human_end_to_end.py -q`

Expected: FAIL until the role/project/render routers, worker progress endpoints, and local video asset persistence are wired together.

- [ ] **Step 3: Add deploy configuration and docs**

Add `HEYGEN_API_KEY: ${HEYGEN_API_KEY:-}` to worker and API environments. Document that UI settings override the environment fallback, voice cloning requires an eligible HeyGen plan, direct uploads are 32 MB maximum, and completed videos are copied to local uploads.

- [ ] **Step 4: Implement an opt-in real smoke script**

`digital-human-live-smoke.ts` requires:

```text
HEYGEN_API_KEY
HEYGEN_SMOKE_PORTRAIT
HEYGEN_SMOKE_VOICE
HEYGEN_SMOKE_ENVIRONMENT
```

It uploads the three files, creates a temporary photo avatar and voice, waits for readiness, renders a short Chinese sentence, downloads the MP4, verifies `video/mp4` and non-zero size, then prints only resource IDs and timings. It never prints the key.

- [ ] **Step 5: Run complete automated verification**

Run:

```bash
conda run -n wems pytest backend/tests/test_digital_human_service.py backend/tests/test_heygen_settings.py backend/tests/test_digital_humans_router.py backend/tests/test_talking_videos_router.py backend/tests/test_digital_human_end_to_end.py -q
cd web
pnpm test
pnpm exec tsc --noEmit
pnpm build
```

Expected: all commands PASS.

- [ ] **Step 6: Run local browser acceptance**

Start API, Redis/worker, and frontend with the host Redis URL:

```bash
cd backend
WMS_REDIS_URL=redis://127.0.0.1:6379/0 conda run -n wems uvicorn main:app --host 0.0.0.0 --port 8000

cd web
WMS_REDIS_URL=redis://127.0.0.1:6379/0 WMS_API_URL=http://127.0.0.1:8000/api pnpm jobs:worker

cd web
pnpm dev
```

Verify at `/digital-humans`:

1. Menu and tabs use the approved names.
2. Role upload and processing states render correctly.
3. Environment upload/asset/AI paths work.
4. AI script generation and draft conversion populate but do not auto-render.
5. The editor is three columns on desktop.
6. A fake-provider render persists a playable local MP4.
7. A second render retains version 1.

- [ ] **Step 7: Run the real HeyGen smoke when credentials are configured**

Run:

```bash
cd web
HEYGEN_API_KEY="$HEYGEN_API_KEY" \
HEYGEN_SMOKE_PORTRAIT="$HEYGEN_SMOKE_PORTRAIT" \
HEYGEN_SMOKE_VOICE="$HEYGEN_SMOKE_VOICE" \
HEYGEN_SMOKE_ENVIRONMENT="$HEYGEN_SMOKE_ENVIRONMENT" \
pnpm exec tsx lib/ai/digital-human-live-smoke.ts
```

Expected: avatar and voice reach ready/complete, video reaches completed, downloaded MP4 is non-empty.

- [ ] **Step 8: Commit**

```bash
git add docker-compose.yml .env.example README.md web/README.md backend/tests/test_digital_human_end_to_end.py web/lib/ai/digital-human-live-smoke.ts
git commit -m "docs(digital-human): verify HeyGen talking-video workflow"
```

---

## Completion Audit

Before claiming completion, collect current evidence for every item:

1. `rg "数字人口播|口播作品|数字人角色" web` proves approved copy is wired.
2. Backend tests prove role/project/render persistence, snapshots, versions, deletion rules, and settings secrecy.
3. HeyGen client tests prove exact V3 paths, bodies, idempotency, and retry classification.
4. Worker tests prove setup and render flows resume from persisted provider state.
5. Script route tests prove generate/convert/rewrite modes do not save or render automatically.
6. Frontend tests and browser evidence prove role creation, environment sources, three-column editor, and version UI.
7. A fake-provider end-to-end run proves the complete local business flow.
8. A real-key smoke run proves actual HeyGen account capability, avatar/voice readiness, video completion, and MP4 download.
9. `pnpm build`, full Vitest, focused Pytest, and TypeScript checks all pass.
10. Only mark the feature complete after item 8 succeeds; absence of a HeyGen key is a live-verification blocker, not proof of completion.
