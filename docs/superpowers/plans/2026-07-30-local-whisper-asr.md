# Local Whisper Shared ASR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run `faster-whisper large-v3` on the host RTX 5060 Ti and use it as the shared local transcription provider for text-video word alignment and YouTube caption fallback.

**Architecture:** Add a private GPU-enabled Speaches service to Docker Compose and place a provider-neutral Python adapter in front of its OpenAI-compatible endpoint. Text-video and YouTube reuse that adapter, while a renewable Redis lease serializes local GPU inference across both workflows. The settings API and UI expose local/cloud provider selection and truthful health/test state without exposing an internal URL or requiring a local API key.

**Tech Stack:** Docker Compose, Speaches 0.8.3 CUDA image, faster-whisper `large-v3`, NVIDIA CUDA, FastAPI, httpx, Redis, pytest, Next.js 16, React 19, TypeScript, Vitest.

## Global Constraints

- Run local ASR on the existing NVIDIA GeForce RTX 5060 Ti 16 GB host.
- Use `large-v3`, CUDA, `float16`, VAD, and word timestamps.
- Allow only one active local ASR inference across text-video and YouTube.
- Persist the model cache across container restarts.
- Do not expose the Speaches port on the host or public network.
- Local mode requires no API key and never silently falls back to a paid provider.
- Keep YouTube priority: Chinese platform caption, English platform caption, then local Whisper.
- Keep the existing text-video exact-script alignment and 85% hard coverage gate.
- Retrying text-video alignment must not regenerate confirmed TTS audio.
- Preserve all unrelated dirty-worktree changes; every commit uses explicit paths.

---

## File Structure

### New files

- `backend/transcription_service.py` — canonical request/result types, provider resolution, HTTP request building, response normalization, timeout/error semantics.
- `backend/local_asr_gate.py` — renewable named Redis lease around local GPU inference.
- `backend/tests/test_transcription_service.py` — local/cloud provider and response contract tests.
- `backend/tests/test_local_asr_gate.py` — lease acquisition, renewal, timeout, and release tests.
- `backend/tests/test_local_asr_compose.py` — Compose GPU, network, cache, and runtime environment assertions.

### Modified backend files

- `backend/text_video_transcription.py` — compatibility wrapper over the shared transcription service.
- `backend/youtube_transcript.py` — remove duplicate HTTP implementation and consume canonical segments.
- `backend/job_queue.py` — add safe named-lease primitives using the existing compare-and-delete/refresh scripts.
- `backend/config.py` — local provider defaults for new installations.
- `backend/runtime_config.py` — environment-backed local ASR URL/model/device metadata.
- `backend/routers/settings.py` — validate provider selection and expose local ASR status/test routes.
- `backend/routers/youtube.py` — preserve valid transcript reuse and local-provider failure semantics.
- `backend/requirements.txt` — no new Python ASR package; Speaches remains isolated.
- `backend/tests/test_text_video_transcription.py` — preserve compatibility and error behavior.
- `backend/tests/test_youtube_transcript.py` — caption ordering and local fallback tests.
- `backend/tests/test_youtube_cookie_settings.py` or a new focused settings test block — settings output/update/status coverage.
- `docker-compose.yml` — private GPU Speaches service and API internal environment.

### Modified frontend files

- `web/lib/api/settings.ts` — provider/status types and API calls.
- `web/lib/api/settings-test-fixtures.ts` — local provider fixture defaults.
- `web/app/settings/sections/TranscriptionSection.tsx` — local/cloud selector, conditional fields, status, test action.
- `web/app/settings/sections/TranscriptionSection.test.tsx` — provider switching and local status behavior.

---

### Task 1: Canonical transcription service and local provider

**Files:**
- Create: `backend/transcription_service.py`
- Create: `backend/tests/test_transcription_service.py`
- Modify: `backend/text_video_transcription.py`
- Modify: `backend/tests/test_text_video_transcription.py`
- Modify: `backend/runtime_config.py`

**Interfaces:**
- Consumes: settings keys `transcription_provider`, `transcription_model`, `transcription_base_url`, `transcription_api_key`, `transcription_max_duration_seconds`, and `transcription_max_audio_bytes`.
- Produces:

```python
@dataclass(frozen=True)
class TranscriptionRequest:
    audio_path: Path
    duration: float
    require_word_timestamps: bool = True
    language_hint: str | None = None

@dataclass(frozen=True)
class TranscriptSegment:
    text: str
    start: float
    end: float

@dataclass(frozen=True)
class TranscriptionResult:
    words: tuple[dict[str, object], ...]
    segments: tuple[TranscriptSegment, ...]
    text: str
    language: str
    request_id: str

async def transcribe_audio(
    request: TranscriptionRequest,
    config: Mapping[str, str],
    *,
    client: httpx.AsyncClient | None = None,
) -> TranscriptionResult
```

- Preserves `text_video_transcription.TranscriptionError`,
  `text_video_transcription.TranscriptionResult`, and
  `transcribe_audio_words(...)` for existing callers.

- [ ] **Step 1: Write failing local-provider request tests**

Add tests that send a fake MP3 through `httpx.MockTransport` and assert:

```python
result = await transcribe_audio(
    TranscriptionRequest(audio_path=audio, duration=0.6),
    {
        "transcription_provider": "local-whisper",
        "transcription_max_duration_seconds": "7200",
        "transcription_max_audio_bytes": "26214400",
    },
    client=client,
)

assert request.url == "http://local-asr:8000/v1/audio/transcriptions"
assert "Authorization" not in request.headers
assert b"Systran/faster-whisper-large-v3" in body
assert b'timestamp_granularities[]' in body
assert b"word" in body
assert result.words[0]["text"] == "甲"
```

Also cover a Speaches-compatible response whose words are nested under
`segments[].words`, ensuring it normalizes to the same canonical word list.

- [ ] **Step 2: Run the new tests and verify RED**

Run:

```bash
cd backend
pytest -q tests/test_transcription_service.py
```

Expected: collection fails because `transcription_service` and its types do not
exist.

- [ ] **Step 3: Implement provider resolution and canonical parsing**

Create `backend/transcription_service.py` with:

```python
LOCAL_PROVIDER = "local-whisper"
LOCAL_MODEL = "Systran/faster-whisper-large-v3"

def _provider_config(config: Mapping[str, str]) -> ProviderConfig:
    provider = str(config.get("transcription_provider") or LOCAL_PROVIDER).strip()
    if provider == LOCAL_PROVIDER:
        runtime = get_runtime_settings()
        return ProviderConfig(
            provider=provider,
            base_url=runtime.local_asr_url.rstrip("/"),
            model=runtime.local_asr_model,
            api_key="",
            local=True,
        )
    if provider == "openai-compatible":
        base_url = _validate_base_url(
            str(config.get("transcription_base_url") or ""),
        ).rstrip("/")
        model = str(config.get("transcription_model") or "").strip()
        api_key = str(config.get("transcription_api_key") or "").strip()
        if not model or not api_key:
            raise TranscriptionError(
                "语音转写服务尚未完整配置",
                retryable=False,
            )
        return ProviderConfig(
            provider=provider,
            base_url=base_url,
            model=model,
            api_key=api_key,
            local=False,
        )
    raise TranscriptionError(
        f"不支持的语音转写供应商：{provider}",
        retryable=False,
    )
```

Build multipart fields with `response_format=verbose_json`. Add
`timestamp_granularities[]=word` when `require_word_timestamps` is true, add the
language hint only when present, and omit `Authorization` for local mode.
Normalize top-level or nested words through the existing
`validate_word_timings` function. Normalize segments independently and reject
non-finite, reversed, or out-of-duration ranges.

Extend `RuntimeSettings` with:

```python
local_asr_url: str
local_asr_model: str
local_asr_device: str
local_asr_compute_type: str
```

using defaults:

```text
http://local-asr:8000/v1
Systran/faster-whisper-large-v3
cuda
float16
```

- [ ] **Step 4: Convert the text-video module into a compatibility wrapper**

Keep the current public function signature:

```python
async def transcribe_audio_words(
    audio_path: Path,
    config: Mapping[str, str],
    *,
    duration: float,
    client: httpx.AsyncClient | None = None,
) -> TranscriptionResult:
    return await transcribe_audio(
        TranscriptionRequest(
            audio_path=audio_path,
            duration=duration,
            require_word_timestamps=True,
        ),
        config,
        client=client,
    )
```

Re-export the shared error/result types so `routers/text_videos.py` and current
tests do not need a simultaneous import migration.

- [ ] **Step 5: Run focused backend tests and verify GREEN**

Run:

```bash
cd backend
pytest -q tests/test_transcription_service.py tests/test_text_video_transcription.py
```

Expected: all tests pass and existing cloud request assertions remain unchanged.

- [ ] **Step 6: Commit only Task 1 files**

```bash
git add backend/transcription_service.py backend/text_video_transcription.py \
  backend/runtime_config.py backend/tests/test_transcription_service.py \
  backend/tests/test_text_video_transcription.py
git commit --only -m "feat: add shared local transcription provider" -- \
  backend/transcription_service.py backend/text_video_transcription.py \
  backend/runtime_config.py backend/tests/test_transcription_service.py \
  backend/tests/test_text_video_transcription.py
```

---

### Task 2: Renewable Redis gate for one GPU inference

**Files:**
- Create: `backend/local_asr_gate.py`
- Create: `backend/tests/test_local_asr_gate.py`
- Modify: `backend/job_queue.py`
- Modify: `backend/transcription_service.py`

**Interfaces:**
- Consumes: existing `RedisJobQueue` client and runtime Redis URL.
- Produces:

```python
async def try_acquire_named_lease(
    self, key: str, owner: str, *, ttl_ms: int
) -> bool

async def refresh_named_lease(
    self, key: str, owner: str, *, ttl_ms: int
) -> bool

async def release_named_lease(self, key: str, owner: str) -> bool

@asynccontextmanager
async def local_asr_gate(
    *,
    owner: str,
    queue: RedisJobQueue | None = None,
    wait_seconds: float = 300,
    ttl_ms: int = 120_000,
) -> AsyncIterator[None]
```

- [ ] **Step 1: Write failing lease lifecycle tests**

Use a small fake queue and deterministic polling interval to verify:

```python
async with local_asr_gate(owner="job-7", queue=queue, wait_seconds=1):
    assert queue.acquired == [("wms:local-asr:gpu", "job-7")]
    await asyncio.sleep(0)

assert queue.released == [("wms:local-asr:gpu", "job-7")]
assert queue.refresh_count >= 1
```

Add separate tests for acquisition timeout and lost renewal. Timeout must raise
`LocalAsrBusyError(retryable=True)`; a lost renewal must cancel inference and
raise `LocalAsrLeaseLostError(retryable=True)`.

- [ ] **Step 2: Run the lease tests and verify RED**

Run:

```bash
cd backend
pytest -q tests/test_local_asr_gate.py
```

Expected: import fails because `local_asr_gate` does not exist.

- [ ] **Step 3: Add generic named-lease primitives**

Reuse `COMPARE_DELETE_SCRIPT` and `COMPARE_PEXPIRE_SCRIPT` in `job_queue.py`.
Validate non-empty key/owner and positive TTL:

```python
async def try_acquire_named_lease(self, key, owner, *, ttl_ms):
    if not key or not owner or ttl_ms <= 0:
        raise ValueError("named lease requires key, owner, and positive ttl")
    acquired = await self._client.set(key, owner, px=ttl_ms, nx=True)
    return acquired == "OK" or acquired is True
```

Implement matching refresh and release methods with owner comparison.

- [ ] **Step 4: Implement the renewable gate and wrap local HTTP inference**

The gate polls with bounded backoff, starts a renewal task at `ttl_ms / 3`,
cancels and awaits that task on exit, and always owner-checks release.
`transcribe_audio` enters the gate only for `local-whisper`; cloud providers do
not acquire it.

Generate the default owner from a UUID when the caller does not supply a durable
job identity:

```python
owner = f"asr-{uuid.uuid4().hex}"
async with local_asr_gate(owner=owner):
    response = await active_client.post(
        request_url,
        headers=request_headers,
        data=request_fields,
        files=request_files,
    )
```

- [ ] **Step 5: Run gate and provider tests and verify GREEN**

Run:

```bash
cd backend
pytest -q tests/test_local_asr_gate.py tests/test_transcription_service.py \
  tests/test_text_video_transcription.py
```

Expected: all tests pass, including proof that two concurrent local calls enter
the mocked HTTP transport one at a time.

- [ ] **Step 6: Commit only Task 2 files**

```bash
git add backend/job_queue.py backend/local_asr_gate.py \
  backend/transcription_service.py backend/tests/test_local_asr_gate.py \
  backend/tests/test_transcription_service.py
git commit --only -m "feat: serialize local gpu transcription" -- \
  backend/job_queue.py backend/local_asr_gate.py \
  backend/transcription_service.py backend/tests/test_local_asr_gate.py \
  backend/tests/test_transcription_service.py
```

---

### Task 3: Reuse the shared provider for YouTube fallback

**Files:**
- Modify: `backend/youtube_transcript.py`
- Modify: `backend/routers/youtube.py`
- Modify: `backend/tests/test_youtube_transcript.py`
- Modify: `backend/tests/test_content_response_models.py`

**Interfaces:**
- Consumes: `transcription_service.transcribe_audio` and
  `TranscriptionRequest(require_word_timestamps=False)`.
- Produces: the existing YouTube transcript dictionary with `source`,
  `language`, `text`, `segments`, and `content_hash`.

- [ ] **Step 1: Write failing YouTube local-fallback tests**

Add a test that supplies metadata with no captions, creates the fake downloaded
audio, and intercepts the shared adapter:

```python
async def transcribe(request, config):
    assert request.require_word_timestamps is False
    assert request.duration == 7
    return TranscriptionResult(
        words=(),
        segments=(
            TranscriptSegment(text="本地字幕", start=0.2, end=1.4),
        ),
        text="本地字幕",
        language="zh",
        request_id="local-1",
    )
```

Assert that Chinese caption and English caption tests never call this adapter.
Add a router-level test proving a `ready` video with non-empty transcript text
returns immediately without invoking extraction.

- [ ] **Step 2: Run YouTube tests and verify RED**

Run:

```bash
cd backend
pytest -q tests/test_youtube_transcript.py tests/test_content_response_models.py
```

Expected: the fallback test fails because `_transcribe_audio` still performs its
own httpx request and does not accept the canonical result.

- [ ] **Step 3: Replace duplicate HTTP code with the shared adapter**

Change the fallback helper to:

```python
async def _transcribe_audio(
    audio_path: Path,
    config: dict[str, str],
    *,
    duration: float,
) -> dict[str, Any]:
    try:
        result = await transcribe_audio(
            TranscriptionRequest(
                audio_path=audio_path,
                duration=duration,
                require_word_timestamps=False,
            ),
            config,
        )
    except TranscriptionError as exc:
        raise TranscriptError(
            "transcription_failed",
            str(exc),
            retryable=exc.retryable,
        ) from exc
    segments = [
        {"start": item.start, "end": item.end, "text": item.text}
        for item in result.segments
    ]
    return build_transcript("whisper", result.language, segments)
```

Pass the validated video duration into this helper. Preserve current duration,
compressed-size, cookie, and yt-dlp safety checks.

- [ ] **Step 4: Keep persisted transcript reuse fail-closed**

In `routers/youtube.py`, retain the existing early return only when:

```python
video.transcript_status == "ready" and video.transcript_text.strip()
```

Map local errors into the existing safe 500-character error fields without
clearing a previously valid transcript unless a new extraction succeeds.

- [ ] **Step 5: Run YouTube and text-video regression tests**

Run:

```bash
cd backend
pytest -q tests/test_youtube_transcript.py tests/test_content_response_models.py \
  tests/test_text_video_transcription.py tests/test_text_video_master_routes.py
```

Expected: all tests pass; caption selection remains Chinese, then English, then
local transcription.

- [ ] **Step 6: Commit only Task 3 files**

```bash
git add backend/youtube_transcript.py backend/routers/youtube.py \
  backend/tests/test_youtube_transcript.py \
  backend/tests/test_content_response_models.py
git commit --only -m "feat: use local asr for youtube fallback" -- \
  backend/youtube_transcript.py backend/routers/youtube.py \
  backend/tests/test_youtube_transcript.py \
  backend/tests/test_content_response_models.py
```

---

### Task 4: Backend settings, health, and real connection test

**Files:**
- Modify: `backend/config.py`
- Modify: `backend/routers/settings.py`
- Modify: `backend/tests/test_youtube_cookie_settings.py`
- Modify: `backend/tests/test_runtime_config.py`

**Interfaces:**
- Produces:

```python
class TranscriptionStatusOut(BaseModel):
    provider: Literal["local-whisper", "openai-compatible"]
    status: Literal["unavailable", "preparing", "ready", "busy", "error"]
    model: str
    device: str
    compute_type: str
    error: str

GET /api/settings/transcription/status
POST /api/settings/transcription/test -> {"ok": bool, "error": str}
```

- [ ] **Step 1: Write failing settings tests**

Cover:

```python
response = client.put("/api/settings", json={
    "transcription_provider": "local-whisper",
})
assert response.status_code == 200
assert response.json()["transcription_provider"] == "local-whisper"
assert response.json()["transcription_model"] == (
    "Systran/faster-whisper-large-v3"
)
```

Assert invalid providers return 422. Mock `/models` or `/health` for status and
mock `transcribe_audio` for the test action. Local test must not require an API
key; cloud test must retain its key/base URL requirement.

- [ ] **Step 2: Run settings tests and verify RED**

Run:

```bash
cd backend
pytest -q tests/test_youtube_cookie_settings.py tests/test_runtime_config.py
```

Expected: local status route is 404 and local test still reports that API Key is
required.

- [ ] **Step 3: Implement settings validation and safe status output**

Set fresh-install defaults:

```python
"transcription_provider": "local-whisper",
"transcription_model": "Systran/faster-whisper-large-v3",
```

Validate `transcription_provider` against exactly:

```python
{"local-whisper", "openai-compatible"}
```

When local is selected, ignore model/base/key values for effective runtime but
preserve stored cloud credentials so switching back does not destroy them.

The status route calls the private ASR service with a short timeout and maps
connection failure to `unavailable`, active lease to `busy`, an available model
to `ready`, and a healthy server without the cached model to `preparing`.
Responses contain no internal URL or host path.

- [ ] **Step 4: Route both provider tests through production behavior**

For local mode, create a temporary short PCM WAV fixture in memory, call
`transcribe_audio` with `require_word_timestamps=False`, and treat a valid
provider response as success even if the non-speech fixture returns empty text.
For cloud mode, retain the current credential and `/models` validation.

- [ ] **Step 5: Run focused settings tests and verify GREEN**

Run:

```bash
cd backend
pytest -q tests/test_youtube_cookie_settings.py tests/test_runtime_config.py \
  tests/test_transcription_service.py
```

Expected: all tests pass and errors are redacted.

- [ ] **Step 6: Commit only Task 4 files**

```bash
git add backend/config.py backend/routers/settings.py \
  backend/tests/test_youtube_cookie_settings.py \
  backend/tests/test_runtime_config.py
git commit --only -m "feat: configure local whisper runtime" -- \
  backend/config.py backend/routers/settings.py \
  backend/tests/test_youtube_cookie_settings.py \
  backend/tests/test_runtime_config.py
```

---

### Task 5: Settings UI for local and cloud transcription

**Files:**
- Modify: `web/lib/api/settings.ts`
- Modify: `web/lib/api/settings-test-fixtures.ts`
- Modify: `web/app/settings/sections/TranscriptionSection.tsx`
- Modify: `web/app/settings/sections/TranscriptionSection.test.tsx`

**Interfaces:**
- Consumes: `GET /api/settings/transcription/status`,
  `POST /api/settings/transcription/test`, and the settings fields from Task 4.
- Produces:

```ts
export type TranscriptionProvider = 'local-whisper' | 'openai-compatible'

export interface TranscriptionStatus {
  provider: TranscriptionProvider
  status: 'unavailable' | 'preparing' | 'ready' | 'busy' | 'error'
  model: string
  device: string
  compute_type: string
  error: string
}
```

- [ ] **Step 1: Write failing component tests**

Add tests that render local mode and assert:

```ts
expect(screen.getByRole('radio', { name: '本地 Whisper' })).toBeChecked()
expect(screen.queryByLabelText('Base URL')).not.toBeInTheDocument()
expect(screen.queryByLabelText('API Key')).not.toBeInTheDocument()
expect(screen.getByText('large-v3')).toBeInTheDocument()
expect(screen.getByText(/RTX 5060 Ti|CUDA/)).toBeInTheDocument()
```

Click save and assert only the provider and duration are submitted. Add a cloud
mode test proving Base URL, model, key placeholder, clear-key action, and
connection test behavior are preserved.

- [ ] **Step 2: Run the component tests and verify RED**

Run:

```bash
cd web
npm test -- app/settings/sections/TranscriptionSection.test.tsx
```

Expected: local provider controls and status text are absent.

- [ ] **Step 3: Add typed API status support**

Add:

```ts
export async function getTranscriptionStatus(): Promise<TranscriptionStatus> {
  return apiFetch('/settings/transcription/status')
}
```

Update `AppSettings` and fixture defaults to use the provider union while
retaining all current cloud fields.

- [ ] **Step 4: Implement conditional local/cloud settings**

Use existing project `Field`, `Button`, and selection primitives. Do not add a
drawer. Local mode shows a compact status card with model, device, compute type,
and one test button. Cloud mode shows the existing Base URL, model, API Key,
duration, test, and clear-key controls.

Save local mode with:

```ts
await updateSettings({
  transcription_provider: 'local-whisper',
  transcription_max_duration_seconds: Math.max(1, maxMinutes) * 60,
})
```

Map status copy truthfully:

```text
unavailable -> 本地转写服务未启动
preparing   -> 正在准备 large-v3 模型
ready       -> 本地转写服务可用
busy        -> 正在处理另一个转写任务
error       -> 本地转写服务异常
```

- [ ] **Step 5: Run component and API tests and verify GREEN**

Run:

```bash
cd web
npm test -- app/settings/sections/TranscriptionSection.test.tsx \
  lib/api/settings-telegram.test.ts
npx tsc --noEmit
```

Expected: focused tests and type checking pass.

- [ ] **Step 6: Commit only Task 5 files**

```bash
git add web/lib/api/settings.ts \
  web/lib/api/settings-test-fixtures.ts \
  web/app/settings/sections/TranscriptionSection.tsx \
  web/app/settings/sections/TranscriptionSection.test.tsx
git commit --only -m "feat: add local whisper settings ui" -- \
  web/lib/api/settings.ts \
  web/lib/api/settings-test-fixtures.ts \
  web/app/settings/sections/TranscriptionSection.tsx \
  web/app/settings/sections/TranscriptionSection.test.tsx
```

---

### Task 6: Private GPU Speaches service

**Files:**
- Modify: `docker-compose.yml`
- Create: `backend/tests/test_local_asr_compose.py`

**Interfaces:**
- Produces the internal endpoint:

```text
http://local-asr:8000/v1
```

- Uses image:

```text
ghcr.io/speaches-ai/speaches:0.8.3-cuda
```

- [ ] **Step 1: Write failing Compose contract tests**

Parse `docker compose config --format json` in a subprocess and assert:

```python
service = config["services"]["local-asr"]
assert "ports" not in service
assert service["image"] == "ghcr.io/speaches-ai/speaches:0.8.3-cuda"
assert service["deploy"]["resources"]["reservations"]["devices"][0][
    "capabilities"
] == ["gpu"]
assert service["volumes"]
assert config["services"]["api"]["environment"]["WMS_LOCAL_ASR_URL"] == (
    "http://local-asr:8000/v1"
)
```

Also assert API startup does not depend on `local-asr` health.

- [ ] **Step 2: Run the Compose test and verify RED**

Run:

```bash
cd backend
pytest -q tests/test_local_asr_compose.py
```

Expected: failure because `local-asr` is not defined.

- [ ] **Step 3: Add the private CUDA service and cache**

Add:

```yaml
  local-asr:
    image: ghcr.io/speaches-ai/speaches:0.8.3-cuda
    restart: unless-stopped
    volumes:
      - whisper-model-cache:/home/ubuntu/.cache/huggingface/hub
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
    healthcheck:
      test: ["CMD", "curl", "--fail", "http://127.0.0.1:8000/health"]
      interval: 15s
      timeout: 5s
      retries: 20
      start_period: 10s
```

Do not add a `ports` key. Add `whisper-model-cache` under top-level volumes.
Add the internal URL/model/device/compute-type environment variables to the API
service without adding `local-asr` to required startup dependencies.

- [ ] **Step 4: Validate rendered Compose configuration**

Run:

```bash
docker compose config --quiet
cd backend
pytest -q tests/test_local_asr_compose.py
```

Expected: Compose validation and the contract test pass.

- [ ] **Step 5: Commit only Task 6 files**

```bash
git add docker-compose.yml backend/tests/test_local_asr_compose.py
git commit --only -m "feat: add private gpu whisper service" -- \
  docker-compose.yml backend/tests/test_local_asr_compose.py
```

---

### Task 7: Integrated regression and runtime deployment

**Files:**
- Modify only files proven necessary by failures from the commands below.
- Update: `docs/superpowers/plans/2026-07-30-local-whisper-asr.md` checkbox state.

**Interfaces:**
- Consumes all previous task deliverables.
- Produces a healthy local ASR service and active `local-whisper` application
  setting in the current deployment.

- [ ] **Step 1: Run the complete relevant backend suite**

Run:

```bash
cd backend
pytest -q tests/test_transcription_service.py tests/test_local_asr_gate.py \
  tests/test_text_video_transcription.py tests/test_text_video_alignment.py \
  tests/test_text_video_master_routes.py tests/test_youtube_transcript.py \
  tests/test_content_response_models.py tests/test_youtube_cookie_settings.py \
  tests/test_runtime_config.py tests/test_local_asr_compose.py
```

Expected: all selected tests pass with no warnings attributable to this feature.

- [ ] **Step 2: Run frontend regression, types, lint, and build**

Run:

```bash
cd web
npm test -- app/settings/sections/TranscriptionSection.test.tsx \
  app/text-video/AudioStage.test.tsx \
  app/text-video/TextVideoEditorClient.test.tsx \
  lib/api/settings-telegram.test.ts
npx tsc --noEmit
npx eslint app/settings/sections/TranscriptionSection.tsx \
  lib/api/settings.ts lib/api/settings-test-fixtures.ts
npm run build
```

Expected: tests, type checking, focused lint, and production build pass.

- [ ] **Step 3: Start the ASR service and verify GPU access**

Run:

```bash
docker compose pull local-asr
docker compose up -d local-asr
docker compose exec local-asr nvidia-smi
docker compose ps local-asr
```

Expected: the container sees `NVIDIA GeForce RTX 5060 Ti`, becomes healthy, and
has no host port mapping.

- [ ] **Step 4: Build and deploy application services**

Deploy the exact source state:

```bash
docker compose build api web worker
docker compose up -d api web worker
docker compose ps
```

Expected: API, web, worker, PostgreSQL, Redis, and local-asr are healthy/running.

- [ ] **Step 5: Select local provider and perform real ASR verification**

Use the authenticated local settings API or settings UI to save
`transcription_provider=local-whisper`, then:

```bash
curl -fsS http://127.0.0.1:8000/api/settings/transcription/status
curl -fsS -X POST http://127.0.0.1:8000/api/settings/transcription/test
nvidia-smi
```

Expected: status reports `ready` after initial model preparation, the test
returns `{"ok":true,"error":""}`, and GPU memory reflects the loaded model.

- [ ] **Step 6: Verify real text-video and YouTube workflows**

In the browser:

1. Open an existing text-video project with confirmed MiMo audio.
2. Trigger only timeline realignment.
3. Confirm the audio asset ID and URL did not change.
4. Confirm the word timeline becomes ready and scene timing remains bounded.
5. Open a YouTube video with no usable platform caption and manually extract
   its transcript.
6. Confirm the record stores `source=whisper`, language, text, segments, and
   content hash.
7. Trigger extraction again and confirm no second ASR inference occurs.

- [ ] **Step 7: Run final worktree and log checks**

Run:

```bash
git diff --check
git status --short
docker compose logs --since=10m api local-asr worker | \
  rg -i "traceback|api[_ -]?key|authorization|/workspace|out of memory" || true
```

Expected: no whitespace errors, unrelated pre-existing changes remain
untouched, and logs contain no secrets, host paths, unexpected tracebacks, or
GPU OOM errors.

- [ ] **Step 8: Commit any verified integration-only correction**

If Steps 1-7 expose a defect, return to the owning task, add a focused failing
test, implement the smallest correction, rerun that task's verification
commands, and include the correction in that task's explicit-path commit. Do
not create an empty integration commit.
