# Hermes-to-AI-SDK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Hermes agent runtime with durable content jobs, a Python collection/content service, and Next.js AI SDK orchestration in a self-hosted single-user build.

**Architecture:** The Python service remains the authority for Postgres-backed content, collection, publishing, and assets. It adds durable job/step/event records and a Redis-backed worker boundary. Next.js becomes the product entry point, owns the Jobs interface and runs bounded Vercel AI SDK creation flows against a narrow Python HTTP tool allowlist. No production path invokes Hermes, a Hermes profile, a Kanban CLI, or a local Codex skill.

**Tech Stack:** FastAPI, SQLAlchemy async, PostgreSQL, Redis, Python worker, Next.js App Router, React 19, TypeScript, Vercel AI SDK, pnpm, Docker Compose.

## Global Constraints

- Preserve collectors, drafts, assets, accounts, publishing adapters, and prompt fragments.
- Do not expose shell execution, arbitrary filesystem access, arbitrary HTTP access, or raw database access as model tools.
- Publishing remains a separate explicit user action and is never an automatic creation-step side effect.
- Persist every job, step, attempt, error, and event in Postgres; Redis is not the source of truth.
- Use idempotency keys for draft and asset writes and allow retrying a failed step without replaying completed steps.
- Keep provider and image credentials server-side and out of version control.
- Do not modify the user-owned `chrome-plug/` working-tree changes.

---

### Task 1: Establish self-hosted runtime and remove Hermes from startup requirements

**Files:**
- Create: `docker-compose.yml`
- Create: `backend/Dockerfile`
- Create: `web/Dockerfile`
- Create: `backend/requirements.txt`
- Modify: `.gitignore`
- Modify: `README.md`
- Test: `backend/tests/test_runtime_config.py`

**Interfaces:**
- Consumes: `DATABASE_URL`, `REDIS_URL`, `API_URL`, and server-only LLM/image provider environment variables.
- Produces: a four-service Compose topology: `web`, `api`, `worker`, `postgres`, plus `redis`; a documented `docker compose up --build` route that does not install Hermes.

- [ ] **Step 1: Write the failing runtime configuration test**

```python
def test_runtime_settings_default_to_self_hosted_services(monkeypatch):
    monkeypatch.delenv("REDIS_URL", raising=False)
    from runtime_config import get_runtime_settings

    settings = get_runtime_settings()

    assert settings.redis_url == "redis://redis:6379/0"
    assert settings.worker_queue == "content-jobs"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `conda run -n wems pytest backend/tests/test_runtime_config.py::test_runtime_settings_default_to_self_hosted_services -q`

Expected: FAIL because `runtime_config` does not exist.

- [ ] **Step 3: Implement the minimal runtime configuration module and container manifests**

Create `backend/runtime_config.py` with an immutable settings dataclass, `get_runtime_settings()`, and environment-only parsing. Add Python requirements used by the existing application and the new Redis queue. Add Dockerfiles that run FastAPI and the worker independently. Add Compose services using Postgres and Redis health checks, then document exact environment variables and startup commands in README. Add generated runtime output directories to `.gitignore`.

- [ ] **Step 4: Run the focused test and manifest checks**

Run: `conda run -n wems pytest backend/tests/test_runtime_config.py -q && docker compose config -q`

Expected: tests pass and Compose validates without mentioning Hermes.

- [ ] **Step 5: Commit**

```bash
git add .gitignore README.md docker-compose.yml backend/Dockerfile backend/requirements.txt backend/runtime_config.py backend/tests/test_runtime_config.py web/Dockerfile
git commit -m "feat(runtime): add self-hosted service topology"
```

### Task 2: Add durable content jobs, steps, events, and state-transition rules

**Files:**
- Modify: `backend/models.py`
- Create: `backend/content_jobs.py`
- Create: `backend/schemas/jobs.py`
- Test: `backend/tests/test_content_jobs.py`

**Interfaces:**
- Consumes: `database.SessionLocal`, `models.ArticleDraft`, and an explicit `ContentJobCreate` request.
- Produces: `ContentJob`, `ContentJobStep`, `ContentJobEvent` ORM models; `create_job`, `start_step`, `succeed_step`, `fail_step`, `cancel_job`, and `retry_step` service functions.

- [ ] **Step 1: Write failing state-machine tests**

```python
async def test_retrying_a_failed_step_preserves_completed_steps(session):
    job = await create_job(session, flow="draft", title="T", input_data={})
    brief = await start_step(session, job.id, "brief")
    await succeed_step(session, brief.id, {"brief": "ok"})
    draft = await start_step(session, job.id, "draft")
    await fail_step(session, draft.id, "provider timeout", retryable=True)

    retry = await retry_step(session, job.id, "draft")

    assert retry.attempt == 2
    assert retry.status == "queued"
    assert brief.status == "succeeded"
```

- [ ] **Step 2: Run the state-machine test to verify it fails**

Run: `conda run -n wems pytest backend/tests/test_content_jobs.py::test_retrying_a_failed_step_preserves_completed_steps -q`

Expected: FAIL because job persistence and service functions do not exist.

- [ ] **Step 3: Implement the minimal job domain model**

Add indexed job/step/event tables with UTC timestamps, JSON input/output summaries, retry metadata, an idempotency key, and a unique `(job_id, step_key, attempt)` constraint. Implement the allowed transition table in `content_jobs.py`; reject invalid transitions with a domain exception. Insert an append-only event for each transition. Keep provider payloads out of the event body except for safe summaries.

- [ ] **Step 4: Add cancellation and invalid-transition tests, then run them**

```python
async def test_cancelling_queued_job_marks_unstarted_steps_cancelled(session):
    job = await create_job(session, flow="draft", title="T", input_data={})
    await cancel_job(session, job.id)
    assert job.status == "cancelled"

async def test_completed_step_cannot_be_started_again(session):
    ...
    with pytest.raises(InvalidJobTransition):
        await start_step(session, step.id, "brief")
```

Run: `conda run -n wems pytest backend/tests/test_content_jobs.py -q`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/models.py backend/content_jobs.py backend/schemas/jobs.py backend/tests/test_content_jobs.py
git commit -m "feat(jobs): add durable content job state"
```

### Task 3: Expose a typed Python job API and narrow content tool allowlist

**Files:**
- Create: `backend/routers/jobs.py`
- Create: `backend/content_tools.py`
- Modify: `backend/main.py`
- Test: `backend/tests/test_jobs_router.py`
- Test: `backend/tests/test_content_tools.py`

**Interfaces:**
- Consumes: `POST /api/jobs` with `{flow, title, input, idempotency_key}` and `GET /api/jobs/{id}`.
- Produces: create/get/list/cancel/retry routes; `ContentToolSet.for_step(step_key)` returning only typed tool functions for that step.

- [ ] **Step 1: Write failing API and allowlist tests**

```python
def test_create_job_returns_queued_job(client):
    response = client.post("/api/jobs", json={
        "flow": "draft", "title": "Test", "input": {}, "idempotency_key": "one",
    })
    assert response.status_code == 201
    assert response.json()["status"] == "queued"

def test_cover_step_does_not_receive_publish_tool():
    from content_tools import tools_for_step
    assert "publish_draft" not in tools_for_step("cover")
```

- [ ] **Step 2: Run focused tests to verify they fail**

Run: `conda run -n wems pytest backend/tests/test_jobs_router.py backend/tests/test_content_tools.py -q`

Expected: FAIL because the router and tool registry do not exist.

- [ ] **Step 3: Implement routes and tool registry**

Use Pydantic request/response models. Enforce title/input limits, idempotency key uniqueness, and a maximum page size. Return job state, steps, and event summaries only. Extract reusable business operations needed by creation from MCP code into `content_tools.py`: read selected source/material, load account and writing-plan context, create/update a draft, and attach an uploaded asset. Each tool validates its payload and writes with `(job_id, step_id)` idempotency.

- [ ] **Step 4: Add permission-boundary tests and run the suite**

```python
def test_retry_unknown_step_returns_404(client):
    response = client.post("/api/jobs/999/retry", json={"step_key": "draft"})
    assert response.status_code == 404

def test_draft_tools_do_not_include_shell_or_arbitrary_http():
    assert set(tools_for_step("draft")).isdisjoint({"shell", "fetch_url", "sql"})
```

Run: `conda run -n wems pytest backend/tests/test_jobs_router.py backend/tests/test_content_tools.py -q`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/main.py backend/content_tools.py backend/routers/jobs.py backend/tests/test_jobs_router.py backend/tests/test_content_tools.py
git commit -m "feat(jobs): expose typed content job API"
```

### Task 4: Implement queued worker execution for deterministic content steps

**Files:**
- Create: `backend/job_queue.py`
- Create: `backend/job_worker.py`
- Create: `backend/content_flows.py`
- Test: `backend/tests/test_job_worker.py`

**Interfaces:**
- Consumes: queued `job_id` values from `content-jobs` Redis queue.
- Produces: `enqueue_job(job_id)`, `run_job(job_id)`, and initial `draft` flow steps `[brief, draft, cover]` with each step run exactly once per attempt.

- [ ] **Step 1: Write failing worker tests**

```python
async def test_worker_executes_steps_in_order(fake_queue, session, monkeypatch):
    job = await create_job(session, flow="draft", title="T", input_data={})
    monkeypatch.setattr(content_flows, "run_brief", fake_brief)
    monkeypatch.setattr(content_flows, "run_draft", fake_draft)

    await run_job(job.id)

    assert await step_statuses(session, job.id) == ["succeeded", "succeeded", "queued"]
```

- [ ] **Step 2: Run the worker test to verify it fails**

Run: `conda run -n wems pytest backend/tests/test_job_worker.py::test_worker_executes_steps_in_order -q`

Expected: FAIL because the queue and worker do not exist.

- [ ] **Step 3: Implement the Redis queue boundary and worker**

Wrap Redis operations behind a small queue interface that has an in-memory fake for tests. The worker claims a job transactionally, runs `brief` then `draft`, records step results, and leaves `cover` queued for the image adapter task. Stop immediately on cancellation or retryable failure. Use only job/step input stored in Postgres; no Hermes task body is read.

- [ ] **Step 4: Add failure, retry, and worker-restart tests**

```python
async def test_worker_marks_only_failed_step_retryable(session, monkeypatch):
    ...
    assert job.status == "failed"
    assert draft.status == "failed"
    assert brief.status == "succeeded"

async def test_worker_resumes_queued_retry_after_restart(session):
    ...
    assert retry.status == "succeeded"
```

Run: `conda run -n wems pytest backend/tests/test_job_worker.py -q`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/job_queue.py backend/job_worker.py backend/content_flows.py backend/tests/test_job_worker.py
git commit -m "feat(jobs): run content flow in durable worker"
```

### Task 5: Add Vercel AI SDK orchestration for bounded draft creation

**Files:**
- Modify: `web/package.json`
- Modify: `web/pnpm-lock.yaml`
- Create: `web/lib/ai/content-job.ts`
- Create: `web/app/api/jobs/[jobId]/run/route.ts`
- Test: `web/lib/ai/content-job.test.ts`

**Interfaces:**
- Consumes: a Python job ID and server-only model provider configuration.
- Produces: a bounded `runContentJob(jobId)` that invokes `generateText`/`streamText` with `stopWhen`, validated tools, and job event persistence through Python APIs.

- [ ] **Step 1: Write the failing orchestration test**

```typescript
it('limits draft orchestration to its declared tools', async () => {
  const toolNames = toolsForContentStep('draft')
  expect(toolNames).toEqual(['getBrief', 'loadWritingContext', 'saveDraft'])
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && pnpm exec vitest run lib/ai/content-job.test.ts`

Expected: FAIL because the module and Vitest setup do not exist.

- [ ] **Step 3: Add dependencies and implement the server-only AI SDK module**

Install `ai`, a selected provider adapter, `zod`, and `vitest`. Create a server-only module that constructs tools solely from the Python allowlist, applies a fixed step limit and abort signal, and persists safe step events. The route accepts only a job ID, never a browser-supplied tool definition or API key. Prefer `generateText` for worker-style execution; stream status/event messages when the browser explicitly attaches to a running step.

- [ ] **Step 4: Add validation and tool-error tests, then run them**

```typescript
it('rejects browser supplied provider keys', async () => {
  const response = await POST(requestWithBody({ apiKey: 'forbidden' }))
  expect(response.status).toBe(400)
})

it('records a tool failure without exposing provider internals', async () => {
  ...
  expect(event.error).toBe('Draft save failed')
})
```

Run: `cd web && pnpm exec vitest run lib/ai/content-job.test.ts && pnpm lint`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/package.json web/pnpm-lock.yaml web/lib/ai/content-job.ts web/lib/ai/content-job.test.ts web/app/api/jobs/[jobId]/run/route.ts
git commit -m "feat(ai): orchestrate bounded content jobs"
```

### Task 6: Replace the Hermes Studio board with a persistent Jobs interface

**Files:**
- Create: `web/app/jobs/page.tsx`
- Create: `web/app/jobs/JobsClient.tsx`
- Create: `web/app/jobs/JobDrawer.tsx`
- Create: `web/lib/api/jobs.ts`
- Modify: `web/components/features/Sidebar.tsx`
- Modify: `web/components/features/CreateTaskDialog.tsx`
- Test: `web/app/jobs/JobsClient.test.tsx`

**Interfaces:**
- Consumes: `GET /api/jobs`, `GET /api/jobs/{id}`, cancel/retry endpoints, and job event summaries.
- Produces: job list/detail UI with `queued`, `running`, `succeeded`, `failed`, `cancelled` states, per-step attempts, and retry/cancel controls.

- [ ] **Step 1: Write the failing Jobs UI test**

```tsx
it('shows a retry action only for a failed retryable step', async () => {
  render(<JobsClient initialJobs={[failedDraftJob]} />)
  expect(await screen.findByRole('button', { name: '重试写稿' })).toBeVisible()
  expect(screen.queryByRole('button', { name: '重试简报' })).toBeNull()
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && pnpm exec vitest run app/jobs/JobsClient.test.tsx`

Expected: FAIL because Jobs components and client API do not exist.

- [ ] **Step 3: Implement the Jobs UI**

Create a lightweight paginated list with status filters and a detail drawer. Poll only while a displayed job is queued or running; stop polling when terminal. Render event timestamps, safe error summaries, step outputs, attempts, and draft/asset links. Reuse existing primitives and avoid importing the old Studio Kanban components. Update the sidebar label/link and make manual creation submit a content job instead of an Hermes task.

- [ ] **Step 4: Add terminal-state and cancellation UI tests**

```tsx
it('stops polling a succeeded job', async () => { ... })
it('sends cancellation for a queued job', async () => { ... })
```

Run: `cd web && pnpm exec vitest run app/jobs/JobsClient.test.tsx && pnpm lint`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/app/jobs web/lib/api/jobs.ts web/components/features/Sidebar.tsx web/components/features/CreateTaskDialog.tsx
git commit -m "feat(jobs-ui): replace agent board with job tracking"
```

### Task 7: Migrate all creation entry points from Hermes dispatch to content jobs

**Files:**
- Modify: `backend/routers/studio.py`
- Modify: `backend/routers/writing_plans.py`
- Modify: `backend/routers/github.py`
- Modify: `backend/routers/topic_generator.py`
- Modify: `backend/daily_planner.py`
- Modify: `backend/routers/daily_plan.py`
- Modify: `backend/pipeline_template.py`
- Test: `backend/tests/test_creation_job_dispatch.py`

**Interfaces:**
- Consumes: existing source/manual/GitHub/topic/daily-plan requests.
- Produces: `content_job_id` responses and deterministic flow definitions instead of task IDs, assignees, parent links, or Kanban URLs.

- [ ] **Step 1: Write failing migration tests**

```python
async def test_manual_topic_creates_content_job_not_hermes_task(client, monkeypatch):
    response = await client.post('/api/studio/enqueue-manual', json=manual_payload)
    assert response.status_code == 201
    assert 'content_job_id' in response.json()
    assert not hermes_called(monkeypatch)
```

- [ ] **Step 2: Run the migration test to verify it fails**

Run: `conda run -n wems pytest backend/tests/test_creation_job_dispatch.py -q`

Expected: FAIL because the endpoints still create Hermes Kanban tasks.

- [ ] **Step 3: Replace dispatcher calls flow-by-flow**

Refactor `pipeline_template.py` so each flow yields typed step context/prompt builders rather than Hermes body strings. Route the standard source, manual topic, rewrite, cover, inline illustration, GitHub release/repo introduction, topic, and daily-plan creation requests through `create_job` plus `enqueue_job`. Preserve existing request validation and source/account context. Return only job IDs and job URLs; never a Kanban URL.

- [ ] **Step 4: Add regression tests for every former dispatch path**

```python
@pytest.mark.parametrize('endpoint,payload', [
    ('/api/studio/enqueue', source_payload),
    ('/api/studio/regenerate-cover', cover_payload),
    ('/api/github/releases/1/dispatch', release_payload),
])
async def test_creation_entry_points_return_jobs(client, endpoint, payload):
    response = await client.post(endpoint, json=payload)
    assert response.status_code in {200, 201}
    assert response.json()['content_job_id']
```

Run: `conda run -n wems pytest backend/tests/test_creation_job_dispatch.py backend/tests/test_studio_enqueue_manual.py backend/tests/test_studio_illustrate.py -q`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/routers/studio.py backend/routers/writing_plans.py backend/routers/github.py backend/routers/topic_generator.py backend/daily_planner.py backend/routers/daily_plan.py backend/pipeline_template.py backend/tests/test_creation_job_dispatch.py
git commit -m "refactor(flows): dispatch creation through content jobs"
```

### Task 8: Move image generation behind a cloud-compatible Python adapter

**Files:**
- Create: `backend/image_provider.py`
- Modify: `backend/content_flows.py`
- Modify: `backend/routers/upload.py`
- Test: `backend/tests/test_image_provider.py`

**Interfaces:**
- Consumes: `ImageGenerationRequest(prompt, aspect_ratio, draft_id, idempotency_key)`.
- Produces: `ImageGenerationResult(path_or_bytes, mime_type, provider, safe_summary)` and a linked `DraftImage` record.

- [ ] **Step 1: Write the failing image adapter test**

```python
async def test_cover_step_uses_configured_provider_not_local_skill(monkeypatch):
    request = ImageGenerationRequest(prompt='cover', aspect_ratio='16:9', draft_id=1, idempotency_key='cover-1')
    result = await generate_image(request)
    assert result.provider == 'openai'
    assert 'hermes' not in result.safe_summary.lower()
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `conda run -n wems pytest backend/tests/test_image_provider.py::test_cover_step_uses_configured_provider_not_local_skill -q`

Expected: FAIL because no provider adapter exists.

- [ ] **Step 3: Implement provider interface and cover worker step**

Implement a provider interface with a test fake and an OpenAI-compatible HTTP implementation selected by server-side config. Make the cover step call this interface and the existing upload/domain code to create an idempotent asset link. Remove any flow instruction requiring `baoyu-*`, Codex imagegen, or a local skill path.

- [ ] **Step 4: Add provider failure and duplicate-write tests**

```python
async def test_provider_failure_leaves_cover_step_retryable(session, monkeypatch):
    ...
    assert step.retryable is True

async def test_replaying_same_cover_idempotency_key_returns_one_asset(session):
    ...
    assert count_draft_images(session, draft_id=1) == 1
```

Run: `conda run -n wems pytest backend/tests/test_image_provider.py -q`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/image_provider.py backend/content_flows.py backend/routers/upload.py backend/tests/test_image_provider.py
git commit -m "feat(images): run cover generation without local skills"
```

### Task 9: Remove Hermes code, dependencies, and user interface after replacement coverage

**Files:**
- Delete: `backend/hermes_kanban_client.py`
- Delete: `backend/profile_manager.py`
- Delete: `backend/routers/retro.py`
- Delete: `backend/routers/profiles.py`
- Delete: `backend/routers/skills.py`
- Delete: `web/app/studio/StudioClient.tsx`
- Delete: `web/app/studio/TaskDrawer.tsx`
- Delete: `web/app/studio/page.tsx`
- Delete: `web/components/features/RetroTerminalDialog.tsx`
- Modify: `backend/main.py`
- Modify: `backend/models.py`
- Modify: `README.md`
- Test: `backend/tests/test_no_hermes_runtime.py`

**Interfaces:**
- Consumes: completed Job API, worker, creation dispatch, Jobs UI, and image adapter coverage.
- Produces: an application that has no runtime import, shell invocation, configuration, or documentation requirement for Hermes.

- [ ] **Step 1: Write the failing no-Hermes test**

```python
def test_backend_runtime_has_no_hermes_import_or_subprocess():
    sources = python_sources(Path('backend'))
    assert 'hermes' not in sources.lower()

def test_main_does_not_mount_profile_retro_or_skill_routers():
    source = Path('backend/main.py').read_text()
    assert 'profiles.router' not in source
    assert 'retro.router' not in source
    assert 'skills.router' not in source
```

- [ ] **Step 2: Run it to verify it fails**

Run: `conda run -n wems pytest backend/tests/test_no_hermes_runtime.py -q`

Expected: FAIL because Hermes modules and routes are still present.

- [ ] **Step 3: Delete replacement-covered modules and references**

Remove the Hermes client, profiles, skills manager, retro terminal, Agent profile model and UI, Studio Kanban page, old task timeline UI, and all main/router imports. Delete only tests that assert Hermes-specific behavior; replace their coverage with job tests. Preserve `mcp_server.py` until all reusable business tools have normal service implementations and no consumers require it.

- [ ] **Step 4: Run repository-wide static and targeted regression checks**

Run:

```bash
! rg -n -i 'hermes|kanban_complete|wms_(scout|editor|writer|illustrator)' backend web README.md
conda run -n wems pytest backend/tests -q
cd web && pnpm lint && pnpm build
docker compose config -q
```

Expected: no search matches, Python tests pass, frontend lint/build pass, and Compose validates.

- [ ] **Step 5: Commit**

```bash
git add -A backend web README.md
git commit -m "refactor: remove Hermes agent runtime"
```

### Task 10: Verify clean self-hosted end-to-end operation and update release documentation

**Files:**
- Modify: `README.md`
- Create: `docs/self-hosted.md`
- Create: `scripts/verify-self-hosted.sh`
- Test: `backend/tests/test_self_hosted_contract.py`

**Interfaces:**
- Consumes: Docker Compose startup and a configured model/image provider.
- Produces: reproducible setup, health, create-job, retry, draft, and explicit-publish verification instructions.

- [ ] **Step 1: Write the failing self-hosted contract test**

```python
def test_self_hosted_docs_never_require_hermes():
    docs = Path('README.md').read_text() + Path('docs/self-hosted.md').read_text()
    assert 'hermes' not in docs.lower()
    assert 'docker compose up --build' in docs
```

- [ ] **Step 2: Run it to verify it fails**

Run: `conda run -n wems pytest backend/tests/test_self_hosted_contract.py -q`

Expected: FAIL until migration documentation replaces old requirements.

- [ ] **Step 3: Document and script the supported operator path**

Document `.env.example` values, Compose startup, health checks, job lifecycle, retry/cancel, model/image provider configuration, data persistence locations, backups, and the explicit publish boundary. Add a script that checks Compose health endpoints, creates a sample non-publishing job with a fake provider, waits for terminal state, and verifies a linked draft. It must fail clearly if any service is unavailable.

- [ ] **Step 4: Run the final verification matrix**

Run:

```bash
conda run -n wems pytest backend/tests -q
cd web && pnpm lint && pnpm build
cd .. && docker compose config -q
./scripts/verify-self-hosted.sh
```

Expected: all tests/checks pass; the verification job succeeds without Hermes.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/self-hosted.md scripts/verify-self-hosted.sh backend/tests/test_self_hosted_contract.py
git commit -m "docs: document Hermes-free self-hosting"
```

## Plan self-review

- **Spec coverage:** Tasks 1-4 cover Docker, durable job state, queue, failure/retry, and Python ownership. Task 5 covers bounded AI SDK use. Task 6 covers Jobs UI. Tasks 7-8 cover all creation paths and cloud-compatible images. Task 9 removes Hermes only after replacement coverage. Task 10 verifies clean self-hosting and explicit publish behavior.
- **Placeholder scan:** The plan contains no TBD/TODO/implement-later placeholders. The names, request shapes, and verification commands are declared in the task that introduces them.
- **Type consistency:** `ContentJob`, `ContentJobStep`, and `ContentJobEvent` are introduced before router/worker/UI consumers; `content_job_id` is the replacement response key throughout dispatch tasks; job states are consistent with the design specification.
