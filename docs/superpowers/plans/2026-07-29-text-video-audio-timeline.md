# Text Video Production Audio Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the persisted text-video workbench into a production workflow that losslessly segments a script, generates and confirms MiMo speech per segment, builds one canonical master audio track with a word timeline, and directs continuous Remotion scenes from word boundaries.

**Architecture:** Python remains the authority for project state, lossless text slicing, media processing, asset persistence, alignment, and conversion from word ranges to seconds. The existing Node Redis worker owns MiMo and AI calls plus durable step orchestration, while the Next.js editor autosaves only editable fields and merges worker-owned state without overwriting local edits. Speech segments, the master audio timeline, and visual scenes are persisted separately; Remotion consumes only a validated projection of the master audio and scene plan.

**Tech Stack:** FastAPI, Pydantic 2, SQLAlchemy async, SQLite/PostgreSQL migrations, FFmpeg/FFprobe, OpenAI-compatible transcription, Next.js 16.2.4 App Router, React 19.2.4, TypeScript, AI SDK 7, Zod, Remotion 4.0.500, Vitest, Testing Library, Playwright, Redis durable jobs.

## Global Constraints

- A new non-empty script starts as exactly one speech segment.
- The compatibility field remains `paragraphs`, but every entry represents a speech segment and frontend domain code calls them `speechSegments`.
- Every edit, split, merge, AI proposal, migration, and reorder must preserve `speechSegments.map(segment => segment.text).join("") === script`.
- AI split output contains stable candidate-boundary IDs only; it never rewrites script text and never starts TTS automatically.
- Speech segments are TTS, confirmation, failure, and retry units. Video scenes are independent visual units and never have a required one-to-one relationship with speech segments.
- The canonical master audio is the only timing authority for preview and rendering.
- AI scene output uses contiguous global word IDs, never raw seconds. Python resolves word ranges to continuous scenes covering `[0, masterDuration]`.
- Browser PATCH requests may edit narration and visual intent but may not directly claim generated audio, alignment, or worker statuses.
- Worker results must match the current `generation_revision` and `source_hash`; stale results never overwrite current project state.
- Revision-checked user edits increment `project.revision`. Worker-owned progress does not increment that edit revision and is merged by stable IDs.
- TTS model, base URL, API key, and voice are settings. Use `mimo-v2.5-tts` as the initial configured model, not a legacy hard-coded alias.
- Target persisted audio is MP3, 44.1 kHz, 128 kbps, mono. FFmpeg and FFprobe run in the backend image, where they are already installed.
- Video composition is available only when all non-empty speech segments are confirmed and both master audio and its timeline are ready.
- Use shared application Dialog and AlertDialog components. Do not add a side drawer, `window.prompt`, `window.confirm`, or `window.alert`.
- Voice cloning, freeform millisecond editing, multitrack audio, arbitrary keyframes, server-side MP4 rendering, publishing, collaboration, and automatic paid TTS after AI splitting remain out of scope.
- Before changing Next.js code, read `web/node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md` and `web/node_modules/next/dist/docs/01-app/01-getting-started/06-fetching-data.md`.

---

## File and Responsibility Map

### Python authority and media layer

- `backend/text_video_domain.py`: canonical document defaults, lossless invariants, hashes, editable-field merge, invalidation, gates, and worker-result staleness checks.
- `backend/text_video_segmentation.py`: stable boundary candidates and exact Python string slicing.
- `backend/media_command.py`: safe async subprocess wrapper for FFmpeg and FFprobe with media-specific errors.
- `backend/text_video_audio.py`: raw TTS normalization, duration probing, ordered concatenation, and local CreativeAsset persistence.
- `backend/text_video_alignment.py`: provider-timing validation, transcript word requests, deterministic exact-script alignment, and global word IDs.
- `backend/text_video_scene_plan.py`: scene word-partition validation, template capability validation, and deterministic second resolution.
- `backend/text_video_templates.py`: backend mirror of the registered template versions and their server-side validation capabilities.
- `backend/models.py`: persisted `speech_split_mode`, `master_audio`, and `scene_plan`.
- `backend/database.py`: idempotent column migration plus legacy text-video document normalization.
- `backend/routers/text_videos.py`: editable CRUD, production action endpoints, and worker-only context/result endpoints.
- `backend/config.py` and `backend/routers/settings.py`: write-only speech credentials and protected worker runtime settings.
- `backend/content_jobs.py`: text-video cancellation/failure state recovery.

### Node worker and providers

- `web/lib/mimo/speech-client.ts`: provider-neutral speech interface and MiMo `/v1/chat/completions` adapter.
- `web/lib/ai/text-video-split-job.ts`: structured AI boundary selection and validated preview.
- `web/lib/ai/text-video-speech-job.ts`: one billed TTS call for one frozen speech-segment snapshot.
- `web/lib/ai/text-video-master-job.ts`: resumable backend assembly and alignment steps.
- `web/lib/ai/text-video-scene-job.ts`: structured AI word partition, one repair attempt, and authoritative backend persistence.
- `web/scripts/content-worker.ts`: explicit dispatch for all four text-video flows.

### Next.js editor and Remotion

- `web/lib/api/text-videos.ts`: complete project documents and production-action API contracts.
- `web/lib/text-video/speech-segments.ts`: immutable split, merge, reorder, edit, invalidation, and exact reconstruction functions.
- `web/lib/text-video/project-merge.ts`: field-level merge of worker state into locally edited state.
- `web/lib/text-video/scene-plan.ts`: immutable scene split, merge, and word-boundary movement.
- `web/lib/text-video/test-fixtures.ts`: complete typed project/word fixtures shared only by text-video frontend tests.
- `web/app/text-video/useTextVideoAutosave.ts`: flush returns the saved snapshot and exposes dirty-version state.
- `web/app/text-video/useTextVideoProjectActions.ts`: shared flush, launch, poll, and safe-refresh coordinator.
- `web/app/text-video/SpeechSplitPreviewDialog.tsx`: explicit AI split preview and confirmation.
- `web/app/text-video/SceneDirectionDialog.tsx`: selected-scene or full-plan AI direction.
- `web/app/text-video/ScriptStage.tsx`: real master-script and speech-segment editing.
- `web/app/text-video/AudioStage.tsx`: truthful segment/master audio generation, playback, confirmation, and errors.
- `web/app/text-video/VideoStage.tsx` and `SceneTimeline.tsx`: word-boundary scene editing and proportional master timeline.
- `web/remotion/contract.ts`: canonical continuous render-input validation.
- `web/remotion/registry.ts` and template manifests: versioned template schemas and capability allowlists.

---

### Task 1: Persist the Authoritative Text-Video Domain

**Files:**
- Create: `backend/text_video_domain.py`
- Create: `backend/tests/test_text_video_domain.py`
- Create: `backend/tests/text_video_factories.py`
- Modify: `backend/models.py`
- Modify: `backend/database.py`
- Modify: `backend/routers/text_videos.py`
- Modify: `backend/tests/test_database_text_video_migration.py`
- Modify: `backend/tests/test_text_videos_router.py`
- Modify: `web/lib/api/text-videos.ts`
- Modify: `web/lib/api/text-videos.test.ts`
- Create: `web/lib/text-video/test-fixtures.ts`

**Interfaces:**
- Consumes: Existing `TextVideoProject`, revision-checked PATCH semantics, `DEFAULT_RENDER_INPUT`, and current project serialization.
- Produces: `default_speech_segment(text: str, segment_id: str | None = None) -> dict`, `normalize_speech_segments(script: str, paragraphs: list[dict]) -> list[dict]`, `speech_source_hash(text: str, voice_settings: dict, model: str) -> str`, `merge_editable_project(project, update: dict, speech_model: str) -> None`, `video_stage_ready(project) -> bool`, immutable speech-asset metadata, and the Python/TypeScript test factories used by all later tasks.

- [ ] **Step 1: Write failing domain and migration tests**

```python
from tests.text_video_factories import (
    make_master_audio,
    make_scene_plan,
    make_speech_segment,
    make_text_video_project,
)


def test_normalization_keeps_a_new_script_as_one_lossless_segment():
    segments = normalize_speech_segments("第一句。\n第二句。", [])
    assert len(segments) == 1
    assert segments[0]["text"] == "第一句。\n第二句。"
    assert "".join(segment["text"] for segment in segments) == "第一句。\n第二句。"


def test_editing_one_segment_invalidates_only_that_speech_and_all_downstream_timing():
    project = make_text_video_project(
        script="甲。乙。",
        paragraphs=[
            make_speech_segment("a", "甲。", status="confirmed"),
            make_speech_segment("b", "乙。", status="confirmed"),
        ],
        master_audio=make_master_audio(status="ready", timeline_status="ready"),
        scene_plan=make_scene_plan(status="ready"),
    )
    merge_editable_project(
        project,
        {"script": "甲改。乙。", "paragraphs": [{"id": "a", "text": "甲改。"}, {"id": "b", "text": "乙。"}]},
        speech_model="mimo-v2.5-tts",
    )
    assert project.paragraphs[0]["status"] == "draft"
    assert project.paragraphs[1]["status"] == "confirmed"
    assert project.master_audio["status"] == "stale"
    assert project.master_audio["timeline_status"] == "stale"
    assert project.scene_plan["status"] == "stale"
```

Extend the database migration test with a zero/one paragraph row and a multi-paragraph row. Assert that the first migrates to `single`, the second to `manual`, and neither row claims to have ready master audio.

- [ ] **Step 2: Run the focused tests and verify the missing domain fails**

Run:

```bash
cd backend
conda run -n wems pytest \
  tests/test_text_video_domain.py \
  tests/test_database_text_video_migration.py \
  tests/test_text_videos_router.py -q
```

Expected: collection fails because `text_video_domain` and the new model fields do not exist.

- [ ] **Step 3: Add persisted fields and exact document defaults**

Add these model columns:

```python
speech_split_mode: Mapped[str] = mapped_column(
    String(20), nullable=False, default="single"
)
master_audio: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
scene_plan: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
```

Define authoritative defaults in `text_video_domain.py`:

```python
def empty_master_audio() -> dict:
    return {
        "status": "missing",
        "timeline_status": "missing",
        "audio_url": "",
        "duration": 0.0,
        "source_hash": "",
        "word_timings": [],
        "timeline_source": "",
        "error": "",
        "timeline_error": "",
        "job_id": None,
    }


def empty_scene_plan() -> dict:
    return {
        "status": "missing",
        "generation_revision": 0,
        "master_source_hash": "",
        "scenes": [],
        "job_id": None,
        "error": "",
    }
```

Every speech segment returned by `default_speech_segment()` contains the approved fields plus server-owned `job_id`:

```python
{
    "id": stable_id,
    "text": text,
    "status": "draft",
    "audio_url": "",
    "duration": 0.0,
    "word_timings": [],
    "source_hash": "",
    "generation_revision": 0,
    "error": "",
    "job_id": None,
}
```

- [ ] **Step 3a: Add immutable generated-speech metadata**

Add immutable generated-speech metadata so pending generation can reuse an exact prior asset without charging MiMo again:

```python
class TextVideoSpeechAsset(Base):
    __tablename__ = "text_video_speech_assets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    creative_asset_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    source_hash: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    duration: Mapped[float] = mapped_column(Float, nullable=False)
    word_timings: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    provider_request_id: Mapped[str] = mapped_column(String, nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
```

- [ ] **Step 4: Implement normalization, hashing, editable merge, migration, and shared test factories**

Use canonical JSON and SHA-256:

```python
def speech_source_hash(text: str, voice_settings: dict, model: str) -> str:
    payload = json.dumps(
        {"text": text, "voice_settings": voice_settings, "model": model},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()
```

- [ ] **Step 4a: Implement editable-field merge and invalidation**

`merge_editable_project()` accepts only title, status, stage, script, voice settings, `{id,text}` speech slices, visual `scene_plan.scenes`, composition, template selection, template props, cover, and output fields. It ignores browser-supplied audio URLs, durations, worker statuses, errors, timing, source hashes, and job IDs. Preserve worker-owned segment fields only when both the exact text and current generation-settings hash still match; otherwise increment `generation_revision`, reset that segment to draft, and stale master/timeline/scene state.

- [ ] **Step 4b: Normalize legacy database rows**

In `migrate_text_video_project_schema()` add the three columns, read rows with `SELECT id, script, paragraphs`, normalize each document in Python, and write it back with SQLAlchemy bound parameters. If legacy paragraphs cannot be exact contiguous slices of `script`, collapse them to one draft segment containing the exact script. Do not treat fixture audio as a production master.

- [ ] **Step 4c: Add shared backend test factories**

Add `backend/tests/text_video_factories.py` with exact reusable constructors:

```python
def make_speech_segment(
    segment_id: str,
    text: str,
    *,
    status: str = "draft",
    **overrides,
) -> dict:
    return {
        **default_speech_segment(text, segment_id=segment_id),
        "status": status,
        **overrides,
    }


def make_text_video_project(**overrides) -> TextVideoProject:
    values = {
        "title": "测试文字视频",
        "status": "draft",
        "stage": "script",
        "script": "",
        "voice_settings": {"voice_id": "mimo_default", "model": "mimo-v2.5-tts", "speed": 1, "volume": 1, "pitch": 0},
        "paragraphs": [make_speech_segment("segment-1", "")],
        "speech_split_mode": "single",
        "master_audio": make_master_audio(),
        "scene_plan": make_scene_plan(),
        "render_input": deepcopy(DEFAULT_RENDER_INPUT),
        "revision": 1,
    }
    return TextVideoProject(**(values | overrides))
```

`make_master_audio(**overrides)` and `make_scene_plan(**overrides)` return the domain defaults merged with overrides. The same test helper module exports `fresh_session_factory(monkeypatch, tmp_path, database_name)` using the repository's module-reset SQLite setup and `run_async(coroutine)` using a fresh event loop, so new backend tests do not require a new pytest async plugin.

- [ ] **Step 5: Tighten API models and TypeScript contracts**

Make PATCH paragraphs editable slices:

```python
class SpeechSegmentEdit(BaseModel):
    id: str = Field(min_length=1)
    text: str = ""


class ProjectUpdate(BaseModel):
    revision: int = Field(ge=1)
    paragraphs: list[SpeechSegmentEdit] | None = None
```

- [ ] **Step 5a: Serialize authoritative state and enforce gates**

Expand the response `SpeechSegmentDocument`, `MasterAudioDocument`, and `ScenePlanDocument` with the exact fields from this task. Serialize `speech_split_mode`, `master_audio`, and `scene_plan`; make `stage="video"` depend on `video_stage_ready(project)`. On create, keep the empty placeholder for an empty script; when the first non-empty script PATCH arrives, normalize it into exactly one segment.

Validate voice settings from the first PATCH:

```python
class VoiceSettingsDocument(BaseModel):
    voice_id: str = ""
    model: str = ""
    speed: float = Field(default=1, ge=0.5, le=2)
    volume: float = Field(default=1, ge=0, le=2)
    pitch: float = Field(default=0, ge=-12, le=12)
```

- [ ] **Step 5b: Add complete frontend document types and fixtures**

Mirror the documents in TypeScript:

```ts
export type SpeechSplitMode = 'single' | 'auto' | 'manual'
export type SpeechStatus = 'draft' | 'generating' | 'ready' | 'confirmed' | 'failed'
export type TextVideoVoiceSettings = {
  voice_id: string
  model: string
  speed: number
  volume: number
  pitch: number
}
export type WordTiming = { id: string; text: string; start: number; end: number }
export type GlobalWordTiming = WordTiming & { speech_segment_id: string }
export type TextVideoParagraph = {
  id: string
  text: string
  status: SpeechStatus
  audio_url: string
  duration: number
  word_timings: WordTiming[]
  source_hash: string
  generation_revision: number
  error: string
  job_id: number | null
}
export type MasterAudioDocument = {
  status: 'missing' | 'building' | 'ready' | 'stale' | 'failed'
  timeline_status: 'missing' | 'aligning' | 'ready' | 'stale' | 'failed'
  audio_url: string
  duration: number
  source_hash: string
  word_timings: GlobalWordTiming[]
  timeline_source: '' | 'provider' | 'forced-alignment'
  error: string
  timeline_error: string
  job_id: number | null
}
export type ScenePlanSceneDocument = {
  id: string
  fromWordId: string
  throughWordId: string
  displayText: string
  highlight: string[]
  animation: string
}
export type ScenePlanDocument = {
  status: 'missing' | 'generating' | 'ready' | 'stale' | 'failed'
  generation_revision: number
  master_source_hash: string
  scenes: ScenePlanSceneDocument[]
  job_id: number | null
  error: string
}
export type TextVideoProjectUpdate = {
  revision: number
  title?: string
  status?: TextVideoProjectStatus
  stage?: TextVideoStage
  script?: string
  voice_settings?: TextVideoVoiceSettings
  paragraphs?: Array<Pick<TextVideoParagraph, 'id' | 'text'>>
  composition?: TextVideoRenderInput['composition']
  template?: {
    templateId: string
    templateVersion: number
    templateProps: Record<string, unknown>
  }
  scene_plan?: { scenes: ScenePlanSceneDocument[] }
  cover_asset_url?: string
  output_asset_url?: string
}
```

Add `web/lib/text-video/test-fixtures.ts`:

```ts
export function makeTextVideoProject(
  overrides: Partial<TextVideoProject> = {},
): TextVideoProject {
  const base: TextVideoProject = {
    id: 1,
    title: '测试文字视频',
    status: 'draft',
    stage: 'script',
    script: '',
    voice_settings: { voice_id: 'mimo_default', model: 'mimo-v2.5-tts', speed: 1, volume: 1, pitch: 0 },
    paragraphs: [makeSpeechSegment('segment-1', '')],
    speech_split_mode: 'single',
    master_audio: makeMasterAudio(),
    scene_plan: makeScenePlan(),
    render_input: makeRenderInput(),
    cover_asset_url: '',
    output_asset_url: '',
    revision: 1,
    duration: 0,
    aspect_ratio: '9:16',
    created_at: '2026-07-29T00:00:00Z',
    updated_at: '2026-07-29T00:00:00Z',
  }
  return { ...base, ...overrides }
}
```

An empty project model means “use the current speech default on first generation.” The launch action then pins the resolved model into `voice_settings.model`; later global settings changes do not silently mutate an existing project's sound. An explicit project-model change is an ordinary voice-settings edit and invalidates every segment.

The same file exports `makeSpeechSegment()`, `makeMasterAudio()`, `makeScenePlan()`, `makeRenderInput()`, and `makeGlobalWords()` with complete typed defaults.

- [ ] **Step 5c: Run the authoritative-domain tests**

Run:

```bash
cd backend
conda run -n wems pytest \
  tests/test_text_video_domain.py \
  tests/test_database_text_video_migration.py \
  tests/test_text_videos_router.py -q
cd ../web
pnpm exec vitest run lib/api/text-videos.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 6: Commit the authoritative domain**

```bash
git add \
  backend/text_video_domain.py \
  backend/tests/test_text_video_domain.py \
  backend/tests/text_video_factories.py \
  backend/models.py \
  backend/database.py \
  backend/routers/text_videos.py \
  backend/tests/test_database_text_video_migration.py \
  backend/tests/test_text_videos_router.py \
  web/lib/api/text-videos.ts \
  web/lib/api/text-videos.test.ts \
  web/lib/text-video/test-fixtures.ts
git commit -m "feat: persist text video speech domain"
```

---

### Task 2: Add Lossless Manual Speech Segmentation

**Files:**
- Create: `web/lib/text-video/speech-segments.ts`
- Create: `web/lib/text-video/speech-segments.test.ts`
- Modify: `web/app/text-video/TextVideoWorkbench.tsx`
- Modify: `web/app/text-video/TextVideoWorkbench.test.tsx`
- Modify: `web/app/text-video/ScriptStage.tsx`
- Create: `web/app/text-video/ScriptStage.test.tsx`

**Interfaces:**
- Consumes: `TextVideoProject`, `TextVideoParagraph`, `SpeechSplitMode`, and server-owned invalidation rules from Task 1.
- Produces: `editSpeechSegment()`, `splitSpeechSegment()`, `mergeSpeechSegment()`, `collapseToSingleSegment()`, `reorderSpeechSegment()`, `applySpeechSplitProposal()`, and stable-ID ScriptStage callbacks used by the editor.

- [ ] **Step 1: Read the repository-local Next.js guides**

Run:

```bash
sed -n '1,240p' web/node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md
sed -n '1,220p' web/node_modules/next/dist/docs/01-app/01-getting-started/06-fetching-data.md
```

Expected: confirm that the editor remains a Client Component and that production action calls stay in client event handlers rather than render.

- [ ] **Step 2: Write failing pure-function tests**

```ts
import { makeSpeechSegment, makeTextVideoProject } from './test-fixtures'


it('splits at the exact JS cursor without losing whitespace', () => {
  const script = '第一句。\n  第二句。'
  const project = makeTextVideoProject({
    script,
    paragraphs: [makeSpeechSegment('segment-1', script)],
  })
  const next = splitSpeechSegment(project, 'segment-1', 5)
  expect(next.paragraphs.map(item => item.text)).toEqual(['第一句。\n', '  第二句。'])
  expect(next.paragraphs.map(item => item.text).join('')).toBe(next.script)
  expect(next.speech_split_mode).toBe('manual')
})

it('merges adjacent segments and invalidates only the merged speech', () => {
  const project = makeTextVideoProject({
    script: '甲。乙。',
    paragraphs: [
      makeSpeechSegment('segment-1', '甲。', { status: 'confirmed' }),
      makeSpeechSegment('segment-2', '乙。', { status: 'confirmed' }),
    ],
  })
  const next = mergeSpeechSegment(project, 'segment-2', 'previous')
  expect(next.paragraphs).toHaveLength(1)
  expect(next.paragraphs[0]).toMatchObject({ text: '甲。乙。', status: 'draft' })
  expect(next.master_audio.status).toBe('stale')
})

it('rejects a whitespace-only side of a split', () => {
  const project = makeTextVideoProject({
    script: '甲。  ',
    paragraphs: [makeSpeechSegment('segment-1', '甲。  ')],
  })
  expect(() => splitSpeechSegment(project, 'segment-1', 2))
    .toThrow('分段后不能只包含空白')
})
```

- [ ] **Step 3: Run tests and verify the helper module is missing**

Run:

```bash
cd web
pnpm exec vitest run lib/text-video/speech-segments.test.ts
```

Expected: FAIL because `speech-segments.ts` does not exist.

- [ ] **Step 4: Implement immutable exact-slice operations**

Export exact signatures:

```ts
export function editSpeechSegment(
  project: TextVideoProject,
  segmentId: string,
  text: string,
): TextVideoProject

export function splitSpeechSegment(
  project: TextVideoProject,
  segmentId: string,
  cursor: number,
): TextVideoProject

export function mergeSpeechSegment(
  project: TextVideoProject,
  segmentId: string,
  direction: 'previous' | 'next',
): TextVideoProject

export function collapseToSingleSegment(project: TextVideoProject): TextVideoProject
```

- [ ] **Step 4a: Implement reorder and validated AI-proposal application**

```ts
export function reorderSpeechSegment(
  project: TextVideoProject,
  segmentId: string,
  targetIndex: number,
): TextVideoProject

export function applySpeechSplitProposal(
  project: TextVideoProject,
  proposal: {
    segments: Array<{ id: string; text: string }>
    speech_split_mode: 'auto'
  },
): TextVideoProject
```

Use `crypto.randomUUID()` only for the newly created right-hand segment. Keep the original ID on the left slice. Rebuild `script` exclusively with `paragraphs.map(({text}) => text).join('')`. Attach boundary whitespace to the preceding non-empty slice, reject whitespace-only slices, set manual operations to `manual`, and never update `render_input.segments` by paragraph index. `applySpeechSplitProposal()` first checks that exact join against the current script, then applies normal source-hash preservation/invalidation. Reorder both the segments and exact master script, but expose it only behind explicit AlertDialog confirmation.

`makeSpeechSegment(id, text, overrides?)` is the typed test helper created in Task 1; production code never imports test fixtures.

- [ ] **Step 5: Replace array-index selection with stable segment IDs**

Change `TextVideoWorkbench` state to:

```ts
const [selectedSpeechSegmentId, setSelectedSpeechSegmentId] = useState(
  projectDocument?.paragraphs[0]?.id ?? '',
)
```

After split, select the returned right-hand ID. After merge, select the surviving ID. Add an effect that falls back to the first existing ID after remote refresh. Pass the real `TextVideoProject` into `ScriptStage`; remove `documentToWorkbench()` from the production path and remove the paragraph-to-scene mutation in `changeParagraphText()`.

- [ ] **Step 5a: Add the manual segmentation controls**

In `ScriptStage`, provide **保持整篇**, **AI 自动分段**, **从此处分段**, **与上一段合并**, **与下一段合并**, **上移**, and **下移** controls. Store the current textarea selection with `selectionStart`; use shared AlertDialog for collapse/reorder operations that invalidate audio and change narration order. Each card shows its truthful speech status plus real duration when generated, otherwise the same display-only `speakable_character_count / 4.2` estimate used by split preview.

- [ ] **Step 5b: Run segmentation and editor tests**

Run:

```bash
cd web
pnpm exec vitest run \
  lib/text-video/speech-segments.test.ts \
  app/text-video/ScriptStage.test.tsx \
  app/text-video/TextVideoWorkbench.test.tsx
```

Expected: all tests pass, including exact whitespace preservation and stable selection after split/merge.

- [ ] **Step 6: Commit manual segmentation**

```bash
git add \
  web/lib/text-video/speech-segments.ts \
  web/lib/text-video/speech-segments.test.ts \
  web/app/text-video/TextVideoWorkbench.tsx \
  web/app/text-video/TextVideoWorkbench.test.tsx \
  web/app/text-video/ScriptStage.tsx \
  web/app/text-video/ScriptStage.test.tsx
git commit -m "feat: add lossless speech segmentation"
```

---

### Task 3: Add Speech Settings and the MiMo Provider Adapter

**Files:**
- Modify: `backend/config.py`
- Modify: `backend/routers/settings.py`
- Create: `backend/tests/test_speech_settings.py`
- Modify: `.env.example`
- Modify: `docker-compose.yml`
- Create: `web/lib/mimo/speech-client.ts`
- Create: `web/lib/mimo/speech-client.test.ts`
- Create: `web/app/settings/sections/SpeechSection.tsx`
- Create: `web/app/settings/sections/SpeechSection.test.tsx`
- Modify: `web/app/settings/SettingsClient.tsx`
- Modify: `web/app/settings/SettingsClient.test.tsx`
- Modify: `web/lib/api/settings.ts`
- Modify: `web/lib/api/settings-test-fixtures.ts`

**Interfaces:**
- Consumes: Existing encrypted/write-only settings behavior, protected worker-runtime endpoints, worker headers, and `fetch`.
- Produces: `SpeechRuntimeConfig`, `SpeechProvider`, `createMiMoSpeechProvider()`, public speech settings fields, `/api/settings/speech-runtime`, and the settings UI used by speech jobs.

- [ ] **Step 1: Write failing settings and MiMo contract tests**

```python
def test_speech_runtime_is_worker_only_and_returns_effective_values(client, worker_headers):
    client.put("/api/settings", json={
        "speech_provider": "mimo",
        "speech_model": "mimo-v2.5-tts",
        "speech_base_url": "https://api.xiaomimimo.com/v1",
        "speech_api_key": "secret-key",
        "speech_default_voice": "mimo_default",
    })
    assert client.get("/api/settings/speech-runtime").status_code == 403
    response = client.get("/api/settings/speech-runtime", headers=worker_headers)
    assert response.json() == {
        "provider": "mimo",
        "model": "mimo-v2.5-tts",
        "base_url": "https://api.xiaomimimo.com/v1",
        "api_key": "secret-key",
        "default_voice": "mimo_default",
    }
```

```ts
const config: MiMoSpeechConfig = {
  apiKey: 'test-key',
  baseUrl: 'https://api.xiaomimimo.com/v1',
  model: 'mimo-v2.5-tts',
  defaultVoice: 'mimo_default',
}
const speechRequest: SpeechRequest = {
  text: '测试配音',
  voiceId: 'mimo_default',
  speed: 1,
  volume: 1,
  pitch: 0,
  audio: {
    sampleRate: 44100,
    bitrate: 128000,
    format: 'mp3',
    channels: 1,
  },
}
const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
  id: 'request-1',
  choices: [{
    message: {
      audio: { data: btoa('RIFF-test-audio') },
    },
  }],
}), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
}))


it('sends narration as the assistant message and decodes returned audio', async () => {
  const provider = createMiMoSpeechProvider(config, fetchMock)
  const result = await provider.generate(speechRequest)
  expect(fetchMock).toHaveBeenCalledWith(
    'https://api.xiaomimimo.com/v1/chat/completions',
    expect.objectContaining({ method: 'POST' }),
  )
  const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string)
  expect(body).toMatchObject({
    model: 'mimo-v2.5-tts',
    messages: [{ role: 'assistant', content: speechRequest.text }],
    audio: { voice: 'mimo_default', format: 'wav' },
  })
  expect(result.mediaType).toBe('audio/wav')
})
```

- [ ] **Step 2: Run focused tests and verify the settings/client are absent**

Run:

```bash
cd backend
conda run -n wems pytest tests/test_speech_settings.py -q
cd ../web
pnpm exec vitest run \
  lib/mimo/speech-client.test.ts \
  app/settings/sections/SpeechSection.test.tsx
```

Expected: FAIL because the runtime route, adapter, and settings section do not exist.

- [ ] **Step 3: Add dedicated write-only speech configuration**

Add defaults and environment fallback:

```python
"speech_provider": os.getenv("WMS_SPEECH_PROVIDER", "mimo"),
"speech_model": os.getenv("WMS_SPEECH_MODEL", "mimo-v2.5-tts"),
"speech_base_url": os.getenv("WMS_SPEECH_BASE_URL", "https://api.xiaomimimo.com/v1"),
"speech_api_key": os.getenv("WMS_SPEECH_API_KEY", os.getenv("MIMO_API_KEY", "")),
"speech_default_voice": os.getenv("WMS_SPEECH_DEFAULT_VOICE", "mimo_default"),
```

Public `SettingsOut` exposes provider/model/base URL/default voice and only `speech_api_key_set` plus the last-four preview. `SettingsUpdate.speech_api_key=""` leaves the current key unchanged; `speech_clear_api_key=true` clears it. Protect `/settings/speech-runtime` with `require_worker_token`.

- [ ] **Step 3a: Wire environment and Compose defaults**

Add the five `WMS_SPEECH_*` variables to `.env.example` and pass them to the API service in `docker-compose.yml`; the Node worker reads the effective values only through the protected runtime route.

- [ ] **Step 4: Implement the provider-neutral MiMo client**

Use these exact public types:

```ts
export type MiMoSpeechConfig = {
  apiKey: string
  baseUrl: string
  model: string
  defaultVoice: string
  styleInstruction?: string
}

export type SpeechRequest = {
  text: string
  voiceId: string
  speed: number
  volume: number
  pitch: number
  audio: {
    sampleRate: 44100
    bitrate: 128000
    format: 'mp3'
    channels: 1
  }
}

export type SpeechProviderResult = {
  bytes: Uint8Array
  mediaType: 'audio/wav' | 'audio/mpeg'
  wordTimings?: WordTiming[]
  providerRequestId?: string
}

export interface SpeechProvider {
  generate(request: SpeechRequest): Promise<SpeechProviderResult>
}

export function createMiMoSpeechProvider(
  config: MiMoSpeechConfig,
  fetcher: typeof fetch = fetch,
): SpeechProvider
```

POST to `${baseUrl}/chat/completions` with Bearer auth. Put optional style instruction in a `user` message followed by the target narration in an `assistant` message. Request WAV from MiMo so Python can apply deterministic speed, volume, pitch, sample-rate, bitrate, and channel normalization. Decode `choices[0].message.audio.data`; reject missing/invalid Base64, empty audio, non-2xx status, and responses larger than 100 MB. Mark 408, 409, 425, 429, and 5xx errors retryable.

- [ ] **Step 5: Add the Speech settings panel**

Add a **语音合成** navigation item next to transcription. The section uses shared `Field`, `Input`, `Select`, `Button`, and password-key controls. It edits provider, model, base URL, default voice, and key, and displays:

```text
当前首个适配器使用 MiMo V2.5 TTS。音色克隆不在本阶段范围内。
```

Do not expose the stored secret and do not invoke paid TTS while saving or rendering the settings page. Extend `makeSettings()` in `settings-test-fixtures.ts` with complete speech defaults so every existing Settings test remains type-complete.

- [ ] **Step 5a: Run settings and provider tests**

Run:

```bash
cd backend
conda run -n wems pytest tests/test_speech_settings.py -q
cd ../web
pnpm exec vitest run \
  lib/mimo/speech-client.test.ts \
  app/settings/sections/SpeechSection.test.tsx \
  app/settings/SettingsClient.test.tsx
```

Expected: all focused tests pass and the public settings response never contains the API key.

- [ ] **Step 6: Commit speech settings and provider**

```bash
git add \
  backend/config.py \
  backend/routers/settings.py \
  backend/tests/test_speech_settings.py \
  .env.example \
  docker-compose.yml \
  web/lib/mimo/speech-client.ts \
  web/lib/mimo/speech-client.test.ts \
  web/app/settings/sections/SpeechSection.tsx \
  web/app/settings/sections/SpeechSection.test.tsx \
  web/app/settings/SettingsClient.tsx \
  web/app/settings/SettingsClient.test.tsx \
  web/lib/api/settings.ts \
  web/lib/api/settings-test-fixtures.ts
git commit -m "feat: configure MiMo speech synthesis"
```

---

### Task 4: Build AI Speech-Split Preview as a Durable Job

**Files:**
- Create: `backend/text_video_segmentation.py`
- Create: `backend/tests/test_text_video_segmentation.py`
- Modify: `backend/routers/text_videos.py`
- Modify: `backend/tests/test_text_videos_router.py`
- Create: `web/lib/ai/text-video-split-job.ts`
- Create: `web/lib/ai/text-video-split-job.test.ts`
- Modify: `web/scripts/content-worker.ts`
- Modify: `web/lib/api/text-videos.ts`
- Create: `web/app/text-video/SpeechSplitPreviewDialog.tsx`
- Create: `web/app/text-video/SpeechSplitPreviewDialog.test.tsx`
- Modify: `web/app/text-video/ScriptStage.tsx`

**Interfaces:**
- Consumes: Task 1 documents, Task 2 exact segment operations, existing `ContentJob`, `enqueue_job()`, AI runtime, `generateObject`, and public `getJob()`.
- Produces: `build_boundary_candidates()`, `slice_at_boundary_ids()`, `POST /speech-split-preview`, worker-only validation, `runTextVideoSplitJob()`, and an explicit-confirmation preview dialog.

- [ ] **Step 1: Write failing Python boundary tests**

```python
def test_candidates_are_stable_and_slicing_preserves_the_exact_script():
    script = "第一句。\n第二句，后半句。"
    first = build_boundary_candidates(script)
    second = build_boundary_candidates(script)
    assert [item.id for item in first] == [item.id for item in second]
    chosen = [item.id for item in first if item.kind in {"sentence", "newline"}]
    slices = slice_at_boundary_ids(script, first, chosen)
    assert "".join(slices) == script
    assert all(segment.strip() for segment in slices)


def test_unknown_or_unordered_boundary_ids_are_rejected():
    with pytest.raises(SegmentationError, match="无效的分段边界"):
        slice_at_boundary_ids("甲。乙。", build_boundary_candidates("甲。乙。"), ["missing"])
```

- [ ] **Step 2: Run focused tests and verify the module/route fail**

Run:

```bash
cd backend
conda run -n wems pytest \
  tests/test_text_video_segmentation.py \
  tests/test_text_videos_router.py -q
```

Expected: FAIL because boundary generation and the preview endpoint are missing.

- [ ] **Step 3: Implement stable candidates and production endpoints**

Define:

```python
@dataclass(frozen=True)
class BoundaryCandidate:
    id: str
    position: int
    kind: Literal["newline", "sentence", "clause", "whitespace"]
    context: str
```

Generate IDs as `boundary-{sha256(script_utf8).hexdigest()[:12]}-{ordinal}`; never expose `position` to Node. Prefer newlines, `。！？!?`, clause punctuation, and safe whitespace inside strings longer than 120 speakable characters. `slice_at_boundary_ids()` resolves IDs on the server, sorts by candidate order, attaches boundary whitespace to the preceding slice, and fails if any output is whitespace-only.

- [ ] **Step 3a: Add split-preview public and protected routes**

Add:

```text
POST /api/text-videos/{id}/speech-split-preview
POST /api/text-videos/{id}/speech-split-preview/worker-validate
```

The public request is `{revision, direction}` and returns `{jobs:[{id,flow,target_id}], project}`. It snapshots `script_hash` and candidate IDs in one `text_video_split_preview` job. Its key is `text-video-split:{project_id}:{request_hash}`, where `request_hash` is SHA-256 over canonical `{revision,script_hash,direction}` and keeps the complete key below 128 characters. The worker-only endpoint accepts `{boundary_ids, script_hash}` and returns `{segments:[{id,text,estimated_duration,reason}], speech_split_mode:"auto"}` without mutating the project. Estimate each preview as `round(max(0.5, speakable_character_count / 4.2), 1)` seconds; this value is display-only and never becomes production timing.

Expose this frontend type:

```ts
export type SpeechSplitProposal = {
  segments: Array<{
    id: string
    text: string
    estimated_duration: number
    reason: string
  }>
  speech_split_mode: 'auto'
}
```

- [ ] **Step 4: Implement the structured AI split worker**

Use a Zod result containing only IDs and reasons:

```ts
const splitSchema = z.object({
  boundaries: z.array(z.object({
    id: z.string().min(1),
    reason: z.string().max(120),
  })),
})
```

The prompt includes the exact script, ordered `{id, kind, context}` candidates, the user's direction, and the requirements “do not rewrite text,” “return IDs only,” and “prefer semantic sentence groups of practical TTS length.” Do not expose a target-duration control. Run one durable step named `propose_boundaries`, call the protected validation endpoint, then complete the step with the validated proposal and complete the job. Explicitly dispatch `text_video_split_preview` in `content-worker.ts`; do not let it fall through to `runContentJob()`.

- [ ] **Step 5: Add the preview Dialog and confirmation flow**

`SpeechSplitPreviewDialog` launches the job, polls `getJob(jobId)` every 1.5 seconds, reads the succeeded `propose_boundaries` output, and renders exact segment text, reason, and estimated seconds. Its footer has **取消** and **应用分段**. Only **应用分段** calls `applySpeechSplitProposal(project, proposal)` and autosaves the new `{id,text}` slices with `speech_split_mode='auto'`; closing the Dialog changes nothing and starts no TTS.

- [ ] **Step 5a: Add explicit-confirmation component tests**

Add tests that assert:

```ts
const project = makeTextVideoProject({
  script: '甲。乙。',
  paragraphs: [makeSpeechSegment('segment-1', '甲。乙。')],
})
const proposal = {
  segments: [
    { id: 'segment-1', text: '甲。', estimated_duration: 0.5, reason: '完整句' },
    { id: 'segment-2', text: '乙。', estimated_duration: 0.5, reason: '完整句' },
  ],
  speech_split_mode: 'auto' as const,
}

expect(onApply).not.toHaveBeenCalled()
await user.click(screen.getByRole('button', { name: '应用分段' }))
expect(proposal.segments.map(item => item.text).join('')).toBe(project.script)
expect(onApply).toHaveBeenCalledTimes(1)
```

- [ ] **Step 5b: Run split-preview tests**

Run:

```bash
cd backend
conda run -n wems pytest \
  tests/test_text_video_segmentation.py \
  tests/test_text_videos_router.py -q
cd ../web
pnpm exec vitest run \
  lib/ai/text-video-split-job.test.ts \
  app/text-video/SpeechSplitPreviewDialog.test.tsx \
  app/text-video/ScriptStage.test.tsx
```

Expected: all focused tests pass; canceling preview leaves the project and TTS untouched.

- [ ] **Step 6: Commit AI split preview**

```bash
git add \
  backend/text_video_segmentation.py \
  backend/tests/test_text_video_segmentation.py \
  backend/routers/text_videos.py \
  backend/tests/test_text_videos_router.py \
  web/lib/ai/text-video-split-job.ts \
  web/lib/ai/text-video-split-job.test.ts \
  web/scripts/content-worker.ts \
  web/lib/api/text-videos.ts \
  web/app/text-video/SpeechSplitPreviewDialog.tsx \
  web/app/text-video/SpeechSplitPreviewDialog.test.tsx \
  web/app/text-video/ScriptStage.tsx
git commit -m "feat: preview AI speech segmentation"
```

---

### Task 5: Generate One Speech Segment per Durable Job

**Files:**
- Create: `backend/text_video_jobs.py`
- Create: `backend/tests/test_text_video_speech_jobs.py`
- Modify: `backend/models.py`
- Modify: `backend/database.py`
- Modify: `backend/routers/text_videos.py`
- Modify: `backend/tests/test_text_videos_router.py`
- Modify: `backend/content_jobs.py`
- Modify: `backend/tests/test_content_jobs.py`
- Create: `web/lib/ai/text-video-speech-job.ts`
- Create: `web/lib/ai/text-video-speech-job.test.ts`
- Modify: `web/scripts/content-worker.ts`
- Modify: `web/lib/api/text-videos.ts`

**Interfaces:**
- Consumes: `speech_source_hash()`, current segment `generation_revision`, Task 3 `SpeechProvider`, durable job step APIs, Redis queue, and worker authentication.
- Produces: a non-empty idempotency-key uniqueness guarantee, `freeze_speech_job_input()`, `assert_current_speech_job()`, atomic single/pending launch functions, reusable speech-asset lookup, generate/confirm endpoints, worker speech context/result contracts, `runTextVideoSpeechJob()`, and cancellation recovery.

- [ ] **Step 1: Write failing atomic launch and stale-result tests**

```python
from tests.text_video_factories import (
    fresh_session_factory,
    make_speech_segment,
    make_text_video_project,
    run_async,
)


def test_generate_pending_creates_one_job_per_draft_or_failed_segment(
    monkeypatch,
    tmp_path,
):
    session_factory = fresh_session_factory(monkeypatch, tmp_path, "speech-jobs.db")

    async def run():
        async with session_factory() as session:
            project = make_text_video_project(script="甲。乙。丙。丁。")
            project.paragraphs = [
                make_speech_segment("a", "甲。"),
                make_speech_segment("b", "乙。", status="confirmed"),
                make_speech_segment("c", "丙。", status="failed"),
                make_speech_segment("d", "丁。", status="generating"),
            ]
            session.add(project)
            await session.flush()
            result = await launch_pending_speech_jobs(
                session,
                project,
                expected_revision=project.revision,
                speech_model="mimo-v2.5-tts",
            )
            assert [
                (job.flow, job.input_data["segment_id"])
                for job in result.jobs
            ] == [
                ("text_video_speech", "a"),
                ("text_video_speech", "c"),
            ]

    run_async(run())


def test_stale_speech_result_cannot_replace_edited_segment():
    project = make_text_video_project(
        script="原稿。",
        paragraphs=[make_speech_segment("a", "原稿。")],
    )
    snapshot = freeze_speech_job_input(project, "a", model="mimo-v2.5-tts")
    project.paragraphs[0]["text"] = "已修改。"
    project.paragraphs[0]["generation_revision"] += 1
    with pytest.raises(StaleTextVideoJob, match="配音段落已更新"):
        assert_current_speech_job(project, snapshot)
```

Add a concurrent launch test that calls the same single-segment endpoint twice and asserts one active job ID and one billable job.

- [ ] **Step 2: Run the focused backend tests**

Run:

```bash
cd backend
conda run -n wems pytest \
  tests/test_text_video_speech_jobs.py \
  tests/test_text_videos_router.py \
  tests/test_content_jobs.py -q
```

Expected: FAIL because launch, result validation, and text-video cancellation behavior are missing.

- [ ] **Step 3: Enforce durable idempotency and implement atomic per-segment launch**

Add a partial unique index for every non-empty `ContentJob.idempotency_key`. Before creating it in `database.py`, retain the earliest duplicate key and rewrite later historical duplicates as `${key}:legacy:${job_id}`. Then execute the dialect-compatible partial index:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS uq_content_jobs_idempotency_nonempty
ON content_jobs (idempotency_key)
WHERE idempotency_key <> ''
```

- [ ] **Step 3a: Add transactional get-or-create job semantics**

Add `create_or_get_job()` in `content_jobs.py`. It first queries the key, otherwise inserts inside `session.begin_nested()`; on `IntegrityError`, it re-queries the winner without rolling back the caller's outer project transaction.

- [ ] **Step 3b: Define speech-launch results and frozen job input**

Define:

```python
@dataclass(frozen=True)
class SpeechLaunchResult:
    jobs: list[ContentJob]
    reused_segment_ids: list[str]
    project: TextVideoProject


class StaleTextVideoJob(ValueError):
    pass


def freeze_speech_job_input(
    project: TextVideoProject,
    segment_id: str,
    *,
    model: str,
) -> dict

def assert_current_speech_job(
    project: TextVideoProject,
    snapshot: dict,
) -> dict

async def launch_speech_job(
    db: AsyncSession,
    project: TextVideoProject,
    segment_id: str,
    *,
    expected_revision: int,
    speech_model: str,
) -> SpeechLaunchResult

async def launch_pending_speech_jobs(
    db: AsyncSession,
    project: TextVideoProject,
    *,
    expected_revision: int,
    speech_model: str,
) -> SpeechLaunchResult
```

Return a `SpeechLaunchResult` containing `jobs`, `reused_segment_ids`, and the updated project. Lock the project row with `SELECT ... FOR UPDATE`. Resolve `project.voice_settings.model or speech_model`; if the project value is empty, pin the resolved model before hashing. Re-read the segment and compute `source_hash`. For **generate pending**, first look up the newest `TextVideoSpeechAsset` with that exact hash and a still-existing `CreativeAsset` file; attach it as `ready` without a TTS job. Reuse a current queued/running job when its `job_id`, generation revision, and hash match. Otherwise create or reuse one `text_video_speech` job with:

```python
{
    "project_id": project.id,
    "segment_id": segment["id"],
    "project_revision": project.revision,
    "generation_revision": segment["generation_revision"],
    "text": segment["text"],
    "source_hash": source_hash,
    "voice_settings": project.voice_settings,
    "speech_model": resolved_model,
}
```

- [ ] **Step 3c: Add reusable-asset and explicit-regeneration rules**

Use `text-video-speech:{project_id}:{request_hash}`, where `request_hash` is SHA-256 over canonical `{segment_id,generation_revision,source_hash}` and keeps the complete key below 128 characters. An explicit generate action on a `ready` or `confirmed` segment means regenerate: increment its generation revision before creating the new key and do not reuse prior audio. Set only that segment to `generating`, clear its confirmation/error, store `job_id`, commit the job and project atomically, then enqueue after commit. If Redis enqueue fails, leave the durable job queued so existing queue reconciliation can retry it.

Switch the Task 4 split-preview launcher to `create_or_get_job()` in the same change; Tasks 7 and 10 use that helper from their first implementation.

- [ ] **Step 4: Add public and worker-only speech actions**

Add:

```text
POST /api/text-videos/{id}/speech-segments/{segmentId}/generate
POST /api/text-videos/{id}/speech-segments/generate-pending
POST /api/text-videos/{id}/speech-segments/{segmentId}/confirm
GET  /api/text-videos/{id}/speech-segments/{segmentId}/worker-context
POST /api/text-videos/{id}/speech-segments/{segmentId}/worker-result
POST /api/text-videos/{id}/speech-segments/{segmentId}/worker-failure
```

Both generation endpoints validate `{revision}` and return:

```json
{
  "jobs":[{"id":123,"flow":"text_video_speech","target_id":"segment-a"}],
  "project":{"id":7,"revision":4,"paragraphs":[]}
}
```

The shown project is abbreviated only for readability; the real response uses the complete `TextVideoProject` schema. Confirmation requires `{revision,generation_revision,source_hash}` and permits only `ready -> confirmed`. Worker endpoints require `X-WMS-Worker-Token` and `X-Content-Job-Id`; result/failure validates job ownership, segment ID, generation revision, and source hash. Stale responses use HTTP 409 with `X-WMS-Retryable: false`.

- [ ] **Step 4a: Restore segment state when a speech job is canceled**

Extend `cancel_job()` so canceling the current speech job sets only that segment to `failed`, clears its `job_id`, and records `任务已取消`; it must not change unrelated segments.

- [ ] **Step 5: Implement and test the Node speech runner**

`runTextVideoSpeechJob(jobId, deps?)` performs one step named `generate_speech`:

```ts
const job = await deps.api.getJob(jobId)
const projectId = Number(job.input.project_id)
const segmentId = String(job.input.segment_id)
const context = await deps.api.getSpeechContext(projectId, segmentId, jobId)
const result = await deps.speech.generate({
  text: context.text,
  voiceId: context.voice_settings.voice_id || context.runtime.default_voice,
  speed: context.voice_settings.speed,
  volume: context.voice_settings.volume,
  pitch: context.voice_settings.pitch,
  audio: {
    sampleRate: 44100,
    bitrate: 128000,
    format: 'mp3',
    channels: 1,
  },
})
const saved = await deps.api.saveSpeechResult(context, result, jobId)
return {
  asset_id: saved.asset_id,
  audio_url: saved.audio_url,
  duration: saved.duration,
}
```

Send audio as multipart with `generation_revision`, `source_hash`, `provider_request_id`, `media_type`, and optional JSON word timings. Do not call MiMo again when the `generate_speech` step already succeeded after worker restart. On non-stale error, post worker failure before failing the step. Explicitly dispatch `text_video_speech`.

- [ ] **Step 5a: Run speech job and idempotency tests**

Run:

```bash
cd backend
conda run -n wems pytest \
  tests/test_text_video_speech_jobs.py \
  tests/test_text_videos_router.py \
  tests/test_content_jobs.py -q
cd ../web
pnpm exec vitest run \
  lib/mimo/speech-client.test.ts \
  lib/ai/text-video-speech-job.test.ts
```

Expected: tests prove one segment per billed call, only failed/draft segments launch, duplicate launches reuse an active job, and stale results are rejected.

- [ ] **Step 6: Commit durable speech generation**

```bash
git add \
  backend/text_video_jobs.py \
  backend/tests/test_text_video_speech_jobs.py \
  backend/models.py \
  backend/database.py \
  backend/routers/text_videos.py \
  backend/tests/test_text_videos_router.py \
  backend/content_jobs.py \
  backend/tests/test_content_jobs.py \
  web/lib/ai/text-video-speech-job.ts \
  web/lib/ai/text-video-speech-job.test.ts \
  web/scripts/content-worker.ts \
  web/lib/api/text-videos.ts
git commit -m "feat: generate speech by segment"
```

---

### Task 6: Normalize and Persist Generated Audio in Python

**Files:**
- Create: `backend/media_command.py`
- Create: `backend/text_video_audio.py`
- Create: `backend/tests/test_media_command.py`
- Create: `backend/tests/test_text_video_audio.py`
- Modify: `backend/routers/text_videos.py`
- Modify: `backend/tests/test_text_videos_router.py`

**Interfaces:**
- Consumes: Backend FFmpeg/FFprobe binaries, existing uploads directory configuration, `CreativeAsset`, and speech-result multipart data from Task 5.
- Produces: `run_media_command()`, `probe_audio()`, `normalize_speech_audio()`, `concatenate_master_audio()`, `save_text_video_audio_asset()`, and a persisted MP3 `SpeechResult`.

- [ ] **Step 1: Write failing media tests using generated WAV fixtures**

Generate a 440 Hz, one-second fixture inside the test with FFmpeg, then assert:

```python
from tests.text_video_factories import run_async


async def sine_wave(
    path: Path,
    *,
    frequency: int = 440,
    seconds: float = 1.0,
) -> Path:
    await run_media_command([
        "ffmpeg", "-y", "-f", "lavfi",
        "-i", f"sine=frequency={frequency}:duration={seconds}",
        "-ar", "44100", "-ac", "1", str(path),
    ])
    return path


def test_normalize_speech_audio_applies_target_encoding_and_settings(tmp_path):
    async def run():
        source = await sine_wave(tmp_path / "source.wav", seconds=1.0)
        output = tmp_path / "normalized.mp3"
        await normalize_speech_audio(
            source,
            output,
            speed=1.0,
            volume=1.0,
            pitch=0.0,
        )
        probe = await probe_audio(output)
        assert probe.sample_rate == 44100
        assert probe.channels == 1
        assert probe.codec_name == "mp3"
        assert probe.duration == pytest.approx(1.0, abs=0.08)

    run_async(run())


def test_concat_preserves_order_and_real_duration(tmp_path):
    async def run():
        first = await sine_wave(tmp_path / "first.wav", frequency=330, seconds=0.6)
        second = await sine_wave(tmp_path / "second.wav", frequency=660, seconds=0.9)
        output = tmp_path / "master.mp3"
        await concatenate_master_audio([first, second], output)
        assert (await probe_audio(output)).duration == pytest.approx(1.5, abs=0.12)

    run_async(run())
```

- [ ] **Step 2: Run tests and verify media helpers are missing**

Run:

```bash
cd backend
conda run -n wems pytest \
  tests/test_media_command.py \
  tests/test_text_video_audio.py -q
```

Expected: FAIL because the media modules do not exist.

- [ ] **Step 3: Implement a safe subprocess and probe layer**

Use `asyncio.create_subprocess_exec(*args)` with an explicit argument list, captured stdout/stderr, a 120-second timeout, and no shell. Define:

```python
@dataclass(frozen=True)
class AudioProbe:
    duration: float
    sample_rate: int
    channels: int
    codec_name: str
    bit_rate: int


async def run_media_command(args: Sequence[str], *, timeout: float = 120) -> bytes
async def probe_audio(path: Path) -> AudioProbe
```

Raise `MediaCommandError(command, returncode, redacted_stderr)` and never reuse the YouTube-specific `run_command()` error labels.

- [ ] **Step 4: Implement deterministic audio normalization**

Normalize to target MP3 with:

```text
-ar 44100 -ac 1 -codec:a libmp3lame -b:a 128k
```

Clamp validated settings to `speed 0.5..2.0`, `volume 0.0..2.0`, and `pitch -12..12` semitones. Build pitch compensation using `asetrate=44100*2^(pitch/12)` followed by an `atempo` chain that restores duration, combine it with requested speed, and use FFmpeg `volume`. Split any `atempo` factor outside `0.5..2.0` into multiple filters. Unit-test factors `0.25`, `1`, and `4`.

- [ ] **Step 4a: Add compliant-copy and ordered-concatenation paths**

For one already compliant MP3 with speed `1`, volume `1`, and pitch `0`, copy bytes rather than re-encoding. For multiple inputs, decode/normalize each to PCM in a temporary directory, concatenate through an FFmpeg concat list created by Python, and encode the final MP3 once. Do not add `afade`, `acrossfade`, or synthetic silence; provider boundary silence remains measurable content in the master timeline.

- [ ] **Step 5: Persist the worker result atomically**

`save_text_video_audio_asset()` writes the normalized file under the configured uploads root, creates a `CreativeAsset` with `media_type="audio/mpeg"`, creates its immutable `TextVideoSpeechAsset` metadata row from Task 1, and returns:

```python
{
    "asset_id": asset.id,
    "audio_url": f"/api/uploads/{relative_path}",
    "duration": probe.duration,
    "word_timings": validated_provider_timings,
    "provider_request_id": provider_request_id,
}
```

- [ ] **Step 5a: Attach worker results only after a second stale check**

The worker-result route validates staleness before running FFmpeg and again under a project row lock before attaching the asset. On success set the segment to `ready`, store normalized duration/timing/hash, clear error/job ID, and stale master/scene state. If the second check is stale, keep the asset unreferenced and return non-retryable 409. Reject empty files, unsupported MIME, files over 100 MB, negative/overlapping/out-of-duration provider timing, and missing FFmpeg with actionable 422/503 errors.

- [ ] **Step 5b: Add missing-asset recovery and run media tests**

When reusable-asset lookup finds metadata whose `CreativeAsset` row or uploaded file is missing, skip it and let generation proceed; surface a missing currently referenced asset as `配音素材已丢失，请重新生成当前段`, never fixture playback.

Run:

```bash
cd backend
conda run -n wems pytest \
  tests/test_media_command.py \
  tests/test_text_video_audio.py \
  tests/test_text_videos_router.py -q
```

Expected: all focused tests pass using real FFmpeg/FFprobe.

- [ ] **Step 6: Commit backend media processing**

```bash
git add \
  backend/media_command.py \
  backend/text_video_audio.py \
  backend/tests/test_media_command.py \
  backend/tests/test_text_video_audio.py \
  backend/routers/text_videos.py \
  backend/tests/test_text_videos_router.py
git commit -m "feat: normalize text video speech audio"
```

---

### Task 7: Assemble Master Audio and Derive the Global Word Timeline

**Files:**
- Create: `backend/text_video_alignment.py`
- Create: `backend/tests/test_text_video_alignment.py`
- Modify: `backend/text_video_audio.py`
- Modify: `backend/tests/test_text_video_audio.py`
- Modify: `backend/routers/text_videos.py`
- Modify: `backend/tests/test_text_videos_router.py`
- Modify: `backend/content_jobs.py`
- Create: `web/lib/ai/text-video-master-job.ts`
- Create: `web/lib/ai/text-video-master-job.test.ts`
- Modify: `web/scripts/content-worker.ts`
- Modify: `web/lib/api/text-videos.ts`

**Interfaces:**
- Consumes: Confirmed normalized segment assets, validated local timings, existing transcription runtime, durable job steps, and media functions from Task 6.
- Produces: master source hashes, resumable assembly/alignment worker endpoints, exact-script token alignment, stable global word timings, and `runTextVideoMasterJob()`.

- [ ] **Step 1: Write failing alignment and master-state tests**

```python
def test_valid_local_timings_offset_into_one_global_timeline():
    words = build_global_timeline(
        script="甲乙",
        segments=[
            {
                "id": "a",
                "text": "甲",
                "duration": 0.6,
                "word_timings": [{"id": "a-1", "text": "甲", "start": 0.1, "end": 0.4}],
            },
            {
                "id": "b",
                "text": "乙",
                "duration": 0.7,
                "word_timings": [{"id": "b-1", "text": "乙", "start": 0.2, "end": 0.5}],
            },
        ],
        offsets={"a": 0.0, "b": 0.6},
        master_duration=1.3,
    )
    assert [(item["text"], item["start"], item["end"]) for item in words] == [
        ("甲", 0.1, 0.4),
        ("乙", 0.8, 1.1),
    ]


def test_transcript_alignment_keeps_exact_script_slices_and_requires_85_percent_coverage():
    transcript_words = [
        {"word": "做", "start": 0.0, "end": 0.2},
        {"word": "AI", "start": 0.2, "end": 0.7},
        {"word": "视频", "start": 0.7, "end": 1.2},
        {"word": "的", "start": 1.2, "end": 1.4},
        {"word": "一个月", "start": 1.6, "end": 2.2},
        {"word": "没", "start": 2.2, "end": 2.5},
        {"word": "赚到钱", "start": 2.5, "end": 3.4},
    ]
    aligned = align_transcript_words(
        script="做 AI 视频的，一个月没赚到钱。",
        transcript_words=transcript_words,
        master_duration=4.2,
        minimum_coverage=0.85,
    )
    assert "".join(item["text"] for item in aligned) == "做 AI 视频的，一个月没赚到钱。"
    with pytest.raises(AlignmentError, match="逐字对齐置信度不足"):
        align_transcript_words("完全不同的稿件", transcript_words, 4.2, 0.85)
```

Add route tests proving alignment failure leaves `master_audio.status == "ready"`, sets only `timeline_status == "failed"`, keeps confirmed segments, and leaves video stage locked.

- [ ] **Step 2: Run focused tests and verify alignment is absent**

Run:

```bash
cd backend
conda run -n wems pytest \
  tests/test_text_video_alignment.py \
  tests/test_text_video_audio.py \
  tests/test_text_videos_router.py -q
```

Expected: FAIL because global alignment and master worker actions do not exist.

- [ ] **Step 3: Implement exact-script tokenization and alignment**

Define:

```python
@dataclass(frozen=True)
class ScriptToken:
    id: str
    text: str
    normalized: str
    start_char: int
    end_char: int


def tokenize_script(script: str) -> list[ScriptToken]
def validate_word_timings(words: list[dict], duration: float) -> list[dict]
```

- [ ] **Step 3a: Implement deterministic transcript-to-script alignment**

```python
def align_transcript_words(
    script: str,
    transcript_words: list[dict],
    master_duration: float,
    minimum_coverage: float = 0.85,
) -> list[dict]
```

- [ ] **Step 3b: Offset validated local timing into stable global words**

```python
def build_global_timeline(
    script: str,
    segments: list[dict],
    offsets: dict[str, float],
    master_duration: float,
) -> list[dict]
```

Tokenize Chinese/Japanese/Korean characters individually and contiguous Latin/digit words as units. Attach leading punctuation/whitespace to the first speakable token and all following punctuation/whitespace to the preceding token, so concatenating token text exactly reproduces the script. Match normalized transcript tokens with a deterministic longest-common-subsequence alignment, compute matched expected tokens divided by expected speakable tokens, reject coverage below `0.85`, and interpolate only unmatched expected tokens between matched neighbors. Apply the same exact-token alignment to provider words before offsetting local timing, so native timing also reproduces the exact script rather than losing punctuation. Reject a transcription response without a non-empty `words` array.

- [ ] **Step 4: Add master build and forced-alignment backend actions**

Add:

```text
POST /api/text-videos/{id}/master-audio/build
POST /api/text-videos/{id}/master-audio/worker-assemble
POST /api/text-videos/{id}/master-audio/worker-align
POST /api/text-videos/{id}/master-audio/worker-failure
```

The public action locks the project, requires every non-empty segment to be confirmed, hashes ordered `{segment_id,audio_url,source_hash,duration}` plus target encoding, reuses an identical ready master, or creates one `text_video_master_audio` job keyed as `text-video-master:{project_id}:{source_hash}` and marks `status=building`, `timeline_status=missing`. It returns `{jobs:[{id,flow,target_id}], project}`.

- [ ] **Step 4a: Assemble and persist the canonical master asset**

Assembly downloads/opens confirmed assets in project order. Reuse one compliant segment asset; otherwise concatenate and persist one master MP3. Probe actual offsets and duration, persist `status=ready` immediately, and return offsets in the job step output. Before alignment work set `timeline_status=aligning`. Alignment first uses local provider timings only when every segment has valid timings. Otherwise POST the master file to the configured `/audio/transcriptions` endpoint with:

```text
response_format=verbose_json
timestamp_granularities[]=word
```

- [ ] **Step 4b: Persist aligned timing without discarding playable audio**

Persist timeline atomically only if the current master source hash still matches. On success set `timeline_source` to `provider` or `forced-alignment`, set `render_input.audio` to the master URL, and set video gate ready. On failure preserve the playable master and set only timeline failure fields.

- [ ] **Step 5: Implement the resumable master job**

`runTextVideoMasterJob()` uses exactly two durable steps:

```ts
const assembled = await runStep(jobId, 'assemble_master_audio', () =>
  api.postMasterAssemble(projectId, jobId),
)
await runStep(jobId, 'align_master_timeline', () =>
  api.postMasterAlign(projectId, {
    source_hash: assembled.source_hash,
    offsets: assembled.offsets,
  }, jobId),
)
```

If alignment retries after worker restart, read the succeeded assembly output and do not concatenate again. Explicitly dispatch `text_video_master_audio`. Extend cancellation so the current master job becomes failed with an actionable error while confirmed segment assets remain unchanged.

- [ ] **Step 5a: Run master-audio and alignment tests**

Run:

```bash
cd backend
conda run -n wems pytest \
  tests/test_text_video_alignment.py \
  tests/test_text_video_audio.py \
  tests/test_text_videos_router.py \
  tests/test_content_jobs.py -q
cd ../web
pnpm exec vitest run lib/ai/text-video-master-job.test.ts
```

Expected: provider timing and forced alignment paths pass; an alignment-only retry reuses the assembled master.

- [ ] **Step 6: Commit master audio and alignment**

```bash
git add \
  backend/text_video_alignment.py \
  backend/tests/test_text_video_alignment.py \
  backend/text_video_audio.py \
  backend/tests/test_text_video_audio.py \
  backend/routers/text_videos.py \
  backend/tests/test_text_videos_router.py \
  backend/content_jobs.py \
  web/lib/ai/text-video-master-job.ts \
  web/lib/ai/text-video-master-job.test.ts \
  web/scripts/content-worker.ts \
  web/lib/api/text-videos.ts
git commit -m "feat: build text video master timeline"
```

---

### Task 8: Coordinate Autosave, Jobs, and the Real Audio Workbench

**Files:**
- Create: `web/lib/text-video/project-merge.ts`
- Create: `web/lib/text-video/project-merge.test.ts`
- Modify: `web/app/text-video/useTextVideoAutosave.ts`
- Modify: `web/app/text-video/useTextVideoAutosave.test.tsx`
- Create: `web/app/text-video/useTextVideoProjectActions.ts`
- Create: `web/app/text-video/useTextVideoProjectActions.test.tsx`
- Modify: `web/app/text-video/TextVideoEditorClient.tsx`
- Modify: `web/app/text-video/TextVideoWorkbench.tsx`
- Modify: `web/app/text-video/AudioStage.tsx`
- Create: `web/app/text-video/AudioStage.test.tsx`

**Interfaces:**
- Consumes: Production endpoints from Tasks 5 and 7, public `getJob()`, `creativeAssetUrl()`, Task 1 stable document IDs, and existing 800 ms autosave.
- Produces: `flush(): Promise<TextVideoProject>`, `mergeWorkerProject()`, `runProjectAction()`, truthful audio controls, and master-timeline gating.

- [ ] **Step 1: Write failing merge and concurrent-autosave tests**

```ts
it('merges completed speech state without replacing unsaved narration edits', () => {
  const project = makeTextVideoProject({
    script: '甲。乙。',
    paragraphs: [
      makeSpeechSegment('segment-a', '甲。'),
      makeSpeechSegment('segment-b', '乙。'),
    ],
  })
  const local = editSpeechSegment(project, 'segment-b', '本地未保存。')
  const server = {
    ...project,
    paragraphs: project.paragraphs.map(segment => segment.id === 'segment-a'
      ? { ...segment, status: 'ready' as const, audio_url: '/api/uploads/a.mp3' }
      : segment),
  }
  const merged = mergeWorkerProject(local, server, {
    dirtyEditableFields: true,
  })
  expect(merged.paragraphs.find(item => item.id === 'segment-a')?.status).toBe('ready')
  expect(merged.paragraphs.find(item => item.id === 'segment-b')?.text).toBe('本地未保存。')
})

it('flush returns the exact saved project used to launch a job', async () => {
  const project = makeTextVideoProject()
  const save = vi.fn().mockResolvedValue({ ...project, revision: 2 })
  const { result } = renderHook(() => useTextVideoAutosave({
    project,
    save,
    onRevision: vi.fn(),
    debounceMs: 60_000,
  }))
  act(() => result.current.markDirty())
  await expect(result.current.flush()).resolves.toMatchObject({
    project: { revision: 2 },
  })
})
```

Add a hook test where TTS completes while the user types in another segment. Assert that the completed audio is merged, local text remains, and the next autosave uses the current edit revision.

- [ ] **Step 2: Run the hook tests and verify missing coordinator behavior**

Run:

```bash
cd web
pnpm exec vitest run \
  lib/text-video/project-merge.test.ts \
  app/text-video/useTextVideoAutosave.test.tsx \
  app/text-video/useTextVideoProjectActions.test.tsx
```

Expected: FAIL because `flush`, field-level merge, and the shared project-action hook do not exist.

- [ ] **Step 3: Make autosave flushable and observable**

Replace `saveNow(): Promise<void>` with:

```ts
type FlushResult = {
  project: TextVideoProject
  dirtyVersion: number
}

async function flush(): Promise<FlushResult>
```

When clean, return the current project and saved dirty version without a request. When saving, return the server response, update the revision, and preserve any edits made after the snapshot. Expose `isDirty()` and `dirtyVersion()` refs to the coordinator. Keep the existing conflict Dialog and fail closed on 409.

- [ ] **Step 3a: Implement stable-ID worker-state merging**

```ts
export function mergeWorkerProject(
  local: TextVideoProject,
  server: TextVideoProject,
  options: { dirtyEditableFields: boolean },
): TextVideoProject
```

The function merges segment audio/status/timing/job fields, master audio, and scene job state by stable ID. When `dirtyEditableFields` is true, it preserves local title, stage, script, voice settings, `{id,text}` slices, composition, and visual scene edits made after the job launch snapshot.

- [ ] **Step 4: Implement one shared production-action coordinator**

Export:

```ts
type TextVideoJobLaunch = {
  jobs: Array<{ id: number; flow: string; target_id: string }>
  project: TextVideoProject
}

function useTextVideoProjectActions({
  project,
  autosave,
  setProject,
}: ProjectActionOptions): {
  jobs: Record<string, ContentJob>
  runProjectAction(
    key: string,
    launch: (saved: TextVideoProject) => Promise<TextVideoJobLaunch>,
  ): Promise<void>
  refreshWorkerState(): Promise<void>
}
```

The coordinator immediately merges `launchResult.project` so reusable speech and current action states appear even when `jobs` is empty. It then performs `flush -> launch with saved revision -> poll all returned job IDs every 1.5 seconds -> fetch latest project -> merge worker-owned fields by segment/scene ID`. If local editable fields changed after the launch snapshot, preserve them. Stop polling on unmount and after terminal status. Surface each job's actual error and retryable step instead of converting failure to success.

- [ ] **Step 5: Replace AudioStage fixtures with truthful production controls**

Pass the real `TextVideoProject`, selected segment ID, action states, and callbacks. Render:

- left: stable-ID speech segments with `draft/generating/ready/confirmed/failed`;
- center: exact text, real `<audio src={creativeAssetUrl(segment.audio_url)} controls>`, duration, error, and ready master-audio player;

- [ ] **Step 5a: Add project voice controls and truthful production actions**

- right: pinned speech model, controlled voice ID, speed `0.5..2`, volume `0..2`, pitch `-12..12`, and fixed target format;
- actions: **生成全部未生成段落**, **生成当前段**, **重新生成当前段**, **确认当前段**, **播放全部**, **生成主音频**, and **重新对齐** when timeline alone failed.

Disable each action from real domain state, including all generation actions when every segment is empty or whitespace-only. Never show a fake waveform or fixture playback. The stage gate requires all speech confirmed, `master_audio.status === 'ready'`, `timeline_status === 'ready'`, and non-empty `render_input.audio`.

Use `data-testid="speech-segment-card"` and truthful labels `未生成`, `生成中`, `待确认`, `已确认`, and `生成失败`. Give the master state `data-testid="master-audio-status"` and render `时间轴已就绪` only for `ready/ready`.

- [ ] **Step 5b: Run autosave, coordinator, and AudioStage tests**

Run:

```bash
cd web
pnpm exec vitest run \
  lib/text-video/project-merge.test.ts \
  app/text-video/useTextVideoAutosave.test.tsx \
  app/text-video/useTextVideoProjectActions.test.tsx \
  app/text-video/AudioStage.test.tsx \
  app/text-video/TextVideoWorkbench.test.tsx
```

Expected: all focused tests pass, including relative audio URLs resolving to the API origin and a job completing during an unrelated local edit.

- [ ] **Step 6: Commit autosave coordination and audio UI**

```bash
git add \
  web/lib/text-video/project-merge.ts \
  web/lib/text-video/project-merge.test.ts \
  web/app/text-video/useTextVideoAutosave.ts \
  web/app/text-video/useTextVideoAutosave.test.tsx \
  web/app/text-video/useTextVideoProjectActions.ts \
  web/app/text-video/useTextVideoProjectActions.test.tsx \
  web/app/text-video/TextVideoEditorClient.tsx \
  web/app/text-video/TextVideoWorkbench.tsx \
  web/app/text-video/AudioStage.tsx \
  web/app/text-video/AudioStage.test.tsx
git commit -m "feat: connect text video audio workbench"
```

---

### Task 9: Version the Remotion Template Contract and Enforce Continuous Timing

**Files:**
- Create: `web/remotion/types.ts`
- Modify: `web/remotion/contract.ts`
- Modify: `web/remotion/contract.test.ts`
- Modify: `web/remotion/registry.ts`
- Modify: `web/remotion/registry.test.ts`
- Modify: `web/remotion/Root.tsx`
- Modify: `web/remotion/templates/tech-text-v1/manifest.ts`
- Modify: `web/remotion/templates/tech-text-v1/Composition.tsx`
- Create: `backend/text_video_templates.py`
- Create: `backend/text_video_scene_plan.py`
- Create: `backend/tests/test_text_video_scene_plan.py`
- Modify: `backend/routers/text_videos.py`

**Interfaces:**
- Consumes: Ready master duration and global word timings from Task 7, current `tech-text-v1` template, and existing `audio + segments` render shape.
- Produces: `TextVideoTemplateManifest`, versioned registry lookup, continuous Zod/Pydantic render validation, `validate_scene_partition()`, and `resolve_scene_seconds()`.

- [ ] **Step 1: Write failing contract and scene-resolution tests**

```ts
it.each([
  ['starts after zero', [{ ...validInput.segments[0], start: 0.1 }, validInput.segments[1]]],
  ['contains a gap', [validInput.segments[0], { ...validInput.segments[1], start: 2.5 }]],
  ['ends before audio', [validInput.segments[0], { ...validInput.segments[1], end: 4.1 }]],
])('rejects a timeline that %s', (_name, segments) => {
  expect(() => parseTextVideoRenderInput(
    { ...validInput, segments },
    { masterDuration: 4.2 },
  )).toThrow('segments must continuously cover the master audio')
})
```

```python
def test_scene_word_partition_resolves_to_continuous_master_seconds():
    proposals = [
        {
            "id": "s1",
            "fromWordId": "word-1",
            "throughWordId": "word-2",
            "displayText": "甲乙",
            "highlight": [],
            "animation": "fade-up",
        },
        {
            "id": "s2",
            "fromWordId": "word-3",
            "throughWordId": "word-4",
            "displayText": "丙丁",
            "highlight": [],
            "animation": "scale",
        },
    ]
    words = [
        {"id": "word-1", "text": "甲", "start": 0.2, "end": 0.5},
        {"id": "word-2", "text": "乙", "start": 0.7, "end": 1.0},
        {"id": "word-3", "text": "丙", "start": 2.2, "end": 2.5},
        {"id": "word-4", "text": "丁", "start": 3.2, "end": 3.5},
    ]
    resolved = resolve_scene_seconds(
        proposals=proposals,
        words=words,
        master_duration=4.2,
        manifest=get_text_video_template("tech-text-v1", 1),
    )
    assert resolved[0]["start"] == 0
    assert resolved[0]["end"] == resolved[1]["start"]
    assert resolved[-1]["end"] == 4.2
```

- [ ] **Step 2: Run focused tests and verify gaps/version behavior fail**

Run:

```bash
cd web
pnpm exec vitest run remotion/contract.test.ts remotion/registry.test.ts
cd ../backend
conda run -n wems pytest tests/test_text_video_scene_plan.py -q
```

Expected: tests fail because the current contract permits gaps and the Python scene planner is missing.

- [ ] **Step 3: Define a versioned template manifest**

Create `remotion/types.ts` to avoid a contract/registry/manifest import cycle:

```ts
export type TextVideoSegment = {
  id: string
  start: number
  end: number
  text: string
  highlight: string[]
  animation: string
}

export type TextVideoRenderInput<P = Record<string, unknown>> = {
  templateId: string
  templateVersion: number
  composition: { width: number; height: number; fps: number }
  audio: string
  segments: TextVideoSegment[]
  templateProps: P
}

export type TextVideoTemplateManifest<P> = {
  id: string
  version: number
  compositionId: string
  component: React.ComponentType<TextVideoRenderInput<P>>
  propsSchema: z.ZodType<P>
  aspectRatios: readonly Array<'9:16' | '16:9' | '1:1'>
  animations: readonly string[]
  transitions: readonly string[]
  defaults: P
}
```

Register with key `${id}@${version}` and resolve with `resolveTextVideoTemplate(id, version)`. Move `techTextV1PropsSchema`, component, `compositionId`, animations, transitions, and defaults into the manifest. Generate Remotion `<Composition>` entries from `textVideoTemplates`, so adding a template means adding one template directory and one manifest registration, not duplicating a video project.

- [ ] **Step 3a: Add the backend template-capability mirror**

Create `backend/text_video_templates.py` with the current server-side capability mirror:

```python
TEXT_VIDEO_TEMPLATES = {
    ("tech-text-v1", 1): {
        "aspect_ratios": {"9:16", "16:9", "1:1"},
        "animations": {"fade-up", "scale"},
        "transitions": {"soft-push"},
        "template_props": {
            "theme": {"tech-blue"},
            "font": {"source-han-sans"},
            "background": {"dark-grid"},
            "transition": {"soft-push"},
            "textDensity": {"compact", "standard", "spacious"},
        },
    },
}
```

`get_text_video_template(template_id, version)` fails closed for an unregistered pair. Registry tests in both runtimes assert the same `tech-text-v1@1` capabilities; every future template commit updates both manifests.

`contract.ts` re-exports `TextVideoRenderInput` and `TextVideoSegment` from `types.ts`, so existing application imports remain source-compatible.

- [ ] **Step 4: Enforce one canonical continuous render input**

Keep the approved Remotion props as `audio + segments`; do not add master duration to serialized props. Change `parseTextVideoRenderInput(value, {masterDuration})` to accept authoritative duration out-of-band. With epsilon `0.001`, require:

```ts
Math.abs(segments[0].start) <= epsilon
Math.abs(segments[index].start - segments[index - 1].end) <= epsilon
Math.abs(segments.at(-1)!.end - masterDuration) <= epsilon
```

Resolve the manifest before validating `templateProps`, animation, transition, and aspect ratio. Require each non-empty highlight to occur in its scene text. The backend projection always validates with `master_audio.duration`; Remotion receives the validated props and derives frame duration from the final scene. Remove `?? props.segments.at(-1)!` from `Composition.tsx` and throw an explicit contract error if a scene is unexpectedly missing.

Mirror the same continuity rules in `RenderInputDocument` on the backend and compare the final end with `master_audio.duration` whenever a production project persists a projection.

- [ ] **Step 5: Implement authoritative word-partition validation and seconds**

Use:

```python
def validate_scene_partition(
    proposals: list[dict],
    words: list[dict],
    manifest: dict,
) -> list[dict]

def resolve_scene_seconds(
    proposals: list[dict],
    words: list[dict],
    master_duration: float,
    manifest: dict,
) -> list[dict]
```

Require ordered contiguous ranges, every global word consumed exactly once, valid word IDs, supported animations, supported transition, highlights present in display text, and non-empty display text. Resolve the first start to `0`, every intermediate boundary to the next scene's first-word start, and the final end to master duration. Return both persistent word ranges in `scene_plan.scenes` and projected seconds in `render_input.segments`.

- [ ] **Step 5a: Accept only word-range scene edits from the browser**

Add `ScenePlanEditDocument` to `ProjectUpdate`. Browser scene edits may send only IDs, word ranges, display text, highlights, and animation; the backend ignores browser seconds, revalidates the word partition, and rebuilds `render_input.segments` itself.

- [ ] **Step 5b: Run registry, contract, and scene-domain tests**

Run:

```bash
cd web
pnpm exec vitest run remotion/contract.test.ts remotion/registry.test.ts
pnpm exec remotion compositions remotion/index.ts
cd ../backend
conda run -n wems pytest \
  tests/test_text_video_scene_plan.py \
  tests/test_text_videos_router.py -q
```

Expected: contracts reject gaps/overlaps/wrong versions and Remotion still lists `tech-text-v1` at 30 fps for all supported ratios.

- [ ] **Step 6: Commit template and scene contracts**

```bash
git add \
  web/remotion/types.ts \
  web/remotion/contract.ts \
  web/remotion/contract.test.ts \
  web/remotion/registry.ts \
  web/remotion/registry.test.ts \
  web/remotion/Root.tsx \
  web/remotion/templates/tech-text-v1/manifest.ts \
  web/remotion/templates/tech-text-v1/Composition.tsx \
  backend/text_video_templates.py \
  backend/text_video_scene_plan.py \
  backend/tests/test_text_video_scene_plan.py \
  backend/routers/text_videos.py
git commit -m "feat: enforce text video scene contracts"
```

---

### Task 10: Generate and Recalibrate Scenes with AI Word Ranges

**Files:**
- Modify: `backend/routers/text_videos.py`
- Modify: `backend/tests/test_text_videos_router.py`
- Modify: `backend/text_video_scene_plan.py`
- Modify: `backend/tests/test_text_video_scene_plan.py`
- Modify: `backend/content_jobs.py`
- Create: `web/lib/ai/text-video-scene-job.ts`
- Create: `web/lib/ai/text-video-scene-job.test.ts`
- Modify: `web/scripts/content-worker.ts`
- Modify: `web/lib/api/text-videos.ts`

**Interfaces:**
- Consumes: Ready master timeline, Task 9 versioned manifest and resolver, AI runtime, durable job runner pattern, and current scene visual intent.
- Produces: `POST /scene-plan/generate`, protected scene context/result/failure routes, one-repair structured AI generation, and `runTextVideoSceneJob()`.

- [ ] **Step 1: Write failing scene job and stale-plan tests**

```ts
const validProposal = {
  scenes: [{
    id: 'scene-1',
    fromWordId: 'word-1',
    throughWordId: 'word-3',
    displayText: '做 AI 视频',
    highlight: ['AI'],
    animation: 'fade-up',
  }],
}
const invalidProposal = {
  scenes: [{ ...validProposal.scenes[0], fromWordId: 'missing-word' }],
}
const stillInvalid = {
  scenes: [{ ...validProposal.scenes[0], animation: 'unsupported-spin' }],
}
const makeQueuedJob = () => ({
  id: 41,
  flow: 'text_video_scene_plan',
  title: '生成文字视频分镜',
  status: 'queued',
  input: { project_id: 1 },
  steps: [],
})
const makeSceneContext = () => ({
  project_id: 1,
  master_source_hash: 'master-hash',
  scene_generation_revision: 1,
  script: '做 AI 视频',
  words: makeGlobalWords(['做', ' AI', ' 视频']),
  speech_segments: [{ id: 'segment-1', fromWordId: 'word-1', throughWordId: 'word-3' }],
  template: {
    id: 'tech-text-v1',
    version: 1,
    animations: ['fade-up', 'scale'],
    transitions: ['soft-push'],
  },
  existing_scenes: [],
  scope: 'all' as const,
  selected_scene_id: '',
  direction: '',
})
function makeSceneJobDeps({ generate }: {
  generate: ReturnType<typeof vi.fn>
}): TextVideoSceneJobDeps {
  return {
    generate,
    api: {
      getJob: vi.fn().mockResolvedValue(makeQueuedJob()),
      startStep: vi.fn().mockResolvedValue({ id: 1 }),
      completeStep: vi.fn(),
      failStep: vi.fn(),
      completeJob: vi.fn(),
      getSceneContext: vi.fn().mockResolvedValue(makeSceneContext()),
      validateScenePlan: vi.fn().mockResolvedValue(validProposal),
      persistScenePlan: vi.fn().mockResolvedValue(makeTextVideoProject()),
      failScenePlan: vi.fn(),
    },
  }
}
const deps = makeSceneJobDeps({
  generate: vi.fn().mockResolvedValue(validProposal),
})


it('asks AI for word IDs and never accepts raw seconds', async () => {
  await runTextVideoSceneJob(41, deps)
  expect(deps.generate).toHaveBeenCalledWith(expect.objectContaining({
    schema: expect.anything(),
    prompt: expect.not.stringContaining('"start":'),
  }))
  expect(deps.api.persistScenePlan).toHaveBeenCalledWith(
    expect.objectContaining({
      proposals: expect.arrayContaining([
        expect.objectContaining({ fromWordId: 'word-1', throughWordId: 'word-3' }),
      ]),
    }),
    41,
  )
})

it('requests exactly one repair and then fails visibly', async () => {
  deps.generate.mockResolvedValueOnce(invalidProposal).mockResolvedValueOnce(stillInvalid)
  await expect(runTextVideoSceneJob(42, deps)).rejects.toThrow('AI 分镜连续两次未通过校验')
  expect(deps.generate).toHaveBeenCalledTimes(2)
})
```

Add a Python route test where master source hash changes while AI runs and assert the old proposals receive non-retryable 409 without replacing the existing valid scene plan.

- [ ] **Step 2: Run focused job and route tests**

Run:

```bash
cd backend
conda run -n wems pytest \
  tests/test_text_video_scene_plan.py \
  tests/test_text_videos_router.py \
  tests/test_content_jobs.py -q
cd ../web
pnpm exec vitest run lib/ai/text-video-scene-job.test.ts
```

Expected: FAIL because scene production endpoints and worker dispatch do not exist.

- [ ] **Step 3: Add public launch and protected persistence**

Add:

```text
POST /api/text-videos/{id}/scene-plan/generate
GET  /api/text-videos/{id}/scene-plan/worker-context
POST /api/text-videos/{id}/scene-plan/worker-validate
POST /api/text-videos/{id}/scene-plan/worker-result
POST /api/text-videos/{id}/scene-plan/worker-failure
```

The public body is:

```json
{
  "revision": 7,
  "scope": "all",
  "selected_scene_id": "",
  "direction": "强化重点，减少每屏文字"
}
```

Return `{jobs:[{id,flow,target_id}], project}`. Require ready master/timeline, snapshot `master_source_hash`, current `scene_plan.generation_revision`, ordered global words, speech boundaries, selected template manifest, supported animations/transitions, and existing scenes. Use `text-video-scene:{project_id}:{request_hash}`, where `request_hash` is SHA-256 over canonical `{master_source_hash,scene_generation_revision,scope,selected_scene_id,direction}` and keeps the complete key below 128 characters. Set status to `generating` without deleting an existing valid render input. Worker persistence revalidates the current master hash and scene generation revision before atomically writing word ranges and projected render seconds.

- [ ] **Step 4: Implement structured generation with one repair**

The AI schema is:

```ts
const sceneProposalSchema = z.object({
  scenes: z.array(z.object({
    id: z.string().min(1),
    fromWordId: z.string().min(1),
    throughWordId: z.string().min(1),
    displayText: z.string().min(1),
    highlight: z.array(z.string()),
    animation: z.string().min(1),
  })).min(1),
})
export type AiSceneProposal = z.infer<typeof sceneProposalSchema>
```

- [ ] **Step 4a: Define the injectable scene-job boundary**

Define the injectable runner boundary used by the tests:

```ts
export type SceneJobContext = {
  project_id: number
  master_source_hash: string
  scene_generation_revision: number
  script: string
  words: GlobalWordTiming[]
  speech_segments: Array<{
    id: string
    fromWordId: string
    throughWordId: string
  }>
  template: {
    id: string
    version: number
    animations: string[]
    transitions: string[]
  }
  existing_scenes: ScenePlanSceneDocument[]
  scope: 'all' | 'selected'
  selected_scene_id: string
  direction: string
}

export type TextVideoSceneJobDeps = {
  generate(input: {
    schema: typeof sceneProposalSchema
    prompt: string
  }): Promise<z.infer<typeof sceneProposalSchema>>
  api: {
    getJob(jobId: number): Promise<DurableJob>
    startStep(jobId: number, key: string): Promise<{ id: number }>
    completeStep(jobId: number, stepId: number, output: Record<string, unknown>): Promise<unknown>
    failStep(jobId: number, stepId: number, error: unknown, retryable?: boolean): Promise<unknown>
    completeJob(jobId: number): Promise<unknown>
    getSceneContext(projectId: number, jobId: number): Promise<SceneJobContext>
    validateScenePlan(projectId: number, proposal: unknown, jobId: number): Promise<AiSceneProposal>
    persistScenePlan(projectId: number, proposal: unknown, jobId: number): Promise<TextVideoProject>
    failScenePlan(projectId: number, error: string, jobId: number): Promise<unknown>
  }
}
```

- [ ] **Step 4b: Add full-plan and selected-scene generation with one repair**

First generate from script, ordered words, semantic segment boundaries, manifest capabilities, scope, direction, and existing visual intent. When a prior plan is stale after speech regeneration, include its display text/highlights/animation plus narration text, but never reuse its old seconds; this is the recalibration path. For `scope="all"`, require a complete word partition. For `scope="selected"`, require exactly one proposal with the selected scene's unchanged `fromWordId` and `throughWordId`, then merge only its display text/highlight/animation into the full plan. Post the result to the protected validate endpoint. If validation returns 422, include its exact validation errors and the invalid JSON in one repair prompt. If the repaired output still fails, post failure and keep the previous valid plan.

Use one durable step `generate_scene_plan`, complete the job only after protected persistence succeeds, and explicitly dispatch `text_video_scene_plan`.

- [ ] **Step 5: Add cancellation and recovery semantics**

Canceling the current scene job clears its job ID and sets the scene-plan status/error to failed, but preserves `scene_plan.scenes` and the last valid `render_input`. A stale result is non-retryable. A provider/network failure may be retried from the failed job step and must not regenerate speech or master audio.

- [ ] **Step 5a: Run scene-job, route, and cancellation tests**

Run:

```bash
cd backend
conda run -n wems pytest \
  tests/test_text_video_scene_plan.py \
  tests/test_text_videos_router.py \
  tests/test_content_jobs.py -q
cd ../web
pnpm exec vitest run lib/ai/text-video-scene-job.test.ts
```

Expected: tests prove word-only AI output, one repair, stale-result rejection, and preservation of the last valid plan on failure.

- [ ] **Step 6: Commit AI scene direction**

```bash
git add \
  backend/routers/text_videos.py \
  backend/tests/test_text_videos_router.py \
  backend/text_video_scene_plan.py \
  backend/tests/test_text_video_scene_plan.py \
  backend/content_jobs.py \
  web/lib/ai/text-video-scene-job.ts \
  web/lib/ai/text-video-scene-job.test.ts \
  web/scripts/content-worker.ts \
  web/lib/api/text-videos.ts
git commit -m "feat: direct text video scenes with AI"
```

---

### Task 11: Add Word-Boundary Scene Editing and the Real Video Timeline

**Files:**
- Create: `web/lib/text-video/scene-plan.ts`
- Create: `web/lib/text-video/scene-plan.test.ts`
- Create: `web/app/text-video/SceneDirectionDialog.tsx`
- Create: `web/app/text-video/SceneDirectionDialog.test.tsx`
- Modify: `web/app/text-video/VideoStage.tsx`
- Create: `web/app/text-video/VideoStage.test.tsx`
- Modify: `web/app/text-video/SceneTimeline.tsx`
- Create: `web/app/text-video/SceneTimeline.test.tsx`
- Modify: `web/app/text-video/RemotionPreview.tsx`
- Modify: `web/app/text-video/TextVideoWorkbench.tsx`

**Interfaces:**
- Consumes: Stable global word IDs, persisted scene word ranges, Task 9 render projection, Task 10 scene generation, and `creativeAssetUrl()`.
- Produces: immutable word-boundary scene edits, selected/full AI direction Dialog, proportional scene/master-audio timeline, and real Remotion preview input.

- [ ] **Step 1: Write failing scene edit tests**

```ts
it('moves a boundary by words and preserves a complete partition', () => {
  const words = makeGlobalWords(['甲', '乙', '丙', '丁', '戊', '己'])
  const plan = makeScenePlan({
    status: 'ready',
    scenes: [
      {
        id: 'scene-1',
        fromWordId: 'word-1',
        throughWordId: 'word-2',
        displayText: '甲乙',
        highlight: [],
        animation: 'fade-up',
      },
      {
        id: 'scene-2',
        fromWordId: 'word-3',
        throughWordId: 'word-6',
        displayText: '丙丁戊己',
        highlight: [],
        animation: 'scale',
      },
    ],
  })
  const next = moveSceneBoundary(plan, words, 'scene-1', 'forward', 1)
  expect(next.scenes).toMatchObject([
    { fromWordId: 'word-1', throughWordId: 'word-3' },
    { fromWordId: 'word-4', throughWordId: 'word-6' },
  ])
  expect(sceneWordIds(next, words)).toEqual(words.map(word => word.id))
})

it('visual edits do not invalidate speech or master audio', () => {
  const project = makeTextVideoProject({
    master_audio: makeMasterAudio({ status: 'ready', timeline_status: 'ready' }),
    scene_plan: makeScenePlan({
      status: 'ready',
      scenes: [{
        id: 'scene-1',
        fromWordId: 'word-1',
        throughWordId: 'word-2',
        displayText: '原屏显',
        highlight: [],
        animation: 'fade-up',
      }],
    }),
  })
  const next = editSceneVisuals(project, 'scene-1', {
    displayText: '新的屏显文字',
    highlight: ['新的'],
    animation: 'scale',
  })
  expect(next.paragraphs).toEqual(project.paragraphs)
  expect(next.master_audio).toEqual(project.master_audio)
})
```

- [ ] **Step 2: Run focused tests and verify scene helpers are absent**

Run:

```bash
cd web
pnpm exec vitest run \
  lib/text-video/scene-plan.test.ts \
  app/text-video/VideoStage.test.tsx \
  app/text-video/SceneTimeline.test.tsx
```

Expected: FAIL because the pure scene operations and production UI behavior do not exist.

- [ ] **Step 3: Implement immutable word-boundary operations**

Export:

```ts
export function splitSceneAtWord(
  plan: ScenePlanDocument,
  words: GlobalWordTiming[],
  sceneId: string,
  firstWordIdOfRightScene: string,
): ScenePlanDocument

export function mergeScene(
  plan: ScenePlanDocument,
  sceneId: string,
  direction: 'previous' | 'next',
): ScenePlanDocument

export function moveSceneBoundary(
  plan: ScenePlanDocument,
  words: GlobalWordTiming[],
  leftSceneId: string,
  direction: 'backward' | 'forward',
  wordCount: number,
): ScenePlanDocument

export function sceneWordIds(
  plan: ScenePlanDocument,
  words: GlobalWordTiming[],
): string[]

export function editSceneVisuals(
  project: TextVideoProject,
  sceneId: string,
  update: Pick<ScenePlanSceneDocument, 'displayText' | 'highlight' | 'animation'>,
): TextVideoProject
```

Keep the left scene ID when splitting and create one UUID for the right scene. Never allow an empty scene or a skipped/duplicated word. Recompute display text from exact word token slices for boundary changes while preserving supported visual intent. Send scene-plan edits through normal revision-checked PATCH; Python reprojects seconds authoritatively.

- [ ] **Step 4: Build the production Scene Direction Dialog**

The Dialog accepts scope `selected` or `all`, an optional selected scene ID, and natural-language direction. `VideoStage` opens it with **AI 生成分镜** when no valid plan exists, **重新校准分镜** when an old plan is stale against a new master timeline, and **让 AI 调整画面** for a current plan. It flushes edits before launch, shows the real job state, preserves the current plan on failure, and closes only after a successful safe merge. Its buttons are **取消** and **让 AI 调整画面**. Do not use a drawer or native prompt.

- [ ] **Step 4a: Test selected-scene scope and cancel behavior**

Add tests that a selected-scene request includes the stable scene ID and that closing the Dialog launches nothing.

- [ ] **Step 5: Replace fixture video UI and timeline**

Pass the real project into `VideoStage`. Select scenes by stable ID and mark each card `data-testid="scene-card"`. Render editable display text, highlight tokens, animation allowlist, split-at-word control, adjacent merge, and word-count boundary movement. Resolve the preview audio with `creativeAssetUrl(project.master_audio.audio_url)`, then pass the same validated `render_input` used by future rendering.

- [ ] **Step 5a: Render proportional scene and master-audio lanes**

Make timeline widths proportional:

```ts
const left = `${(scene.start / masterDuration) * 100}%`
const width = `${((scene.end - scene.start) / masterDuration) * 100}%`
```

Render one master-audio lane with truthful duration and scene intervals. Do not add arbitrary millisecond fields or drag handles. Ensure compact width retains primary actions through horizontal scrolling rather than hiding them.

- [ ] **Step 5b: Run scene editor and Remotion preview tests**

Run:

```bash
cd web
pnpm exec vitest run \
  lib/text-video/scene-plan.test.ts \
  app/text-video/SceneDirectionDialog.test.tsx \
  app/text-video/VideoStage.test.tsx \
  app/text-video/SceneTimeline.test.tsx \
  app/text-video/TextVideoWorkbench.test.tsx \
  remotion/contract.test.ts
```

Expected: all tests pass; narration assets remain unchanged after every visual-only operation.

- [ ] **Step 6: Commit scene calibration and video UI**

```bash
git add \
  web/lib/text-video/scene-plan.ts \
  web/lib/text-video/scene-plan.test.ts \
  web/app/text-video/SceneDirectionDialog.tsx \
  web/app/text-video/SceneDirectionDialog.test.tsx \
  web/app/text-video/VideoStage.tsx \
  web/app/text-video/VideoStage.test.tsx \
  web/app/text-video/SceneTimeline.tsx \
  web/app/text-video/SceneTimeline.test.tsx \
  web/app/text-video/RemotionPreview.tsx \
  web/app/text-video/TextVideoWorkbench.tsx
git commit -m "feat: calibrate text video scenes by word"
```

---

### Task 12: Verify Recovery, Runtime Services, and End-to-End Production Flow

**Files:**
- Create: `web/e2e/text-video-production.spec.ts`
- Create: `web/e2e/text-video-provider-server.ts`
- Modify: `dev.sh`
- Modify: `README.md`
- Modify: `backend/tests/test_content_jobs.py`
- Modify: `backend/tests/test_text_videos_router.py`
- Create: `web/scripts/content-worker.test.ts`

**Interfaces:**
- Consumes: All production APIs, worker flows, editor stages, Redis queue, backend FFmpeg, existing service scripts, and the Browser plugin when connected.
- Produces: reproducible local startup including the worker, browser-level acceptance coverage, and final full-suite evidence.

- [ ] **Step 1: Write end-to-end acceptance coverage**

`text-video-provider-server.ts` starts a local HTTP server on an ephemeral port. Its `/v1/chat/completions` route returns a Base64 one-second WAV fixture for `mimo-v2.5-tts`, a valid boundary-ID object for split prompts, and a valid word-partition object for scene prompts. Its `/v1/audio/transcriptions` route returns deterministic `verbose_json.words`. The test saves that server as the speech, LLM, and transcription base URL through the real settings API. It therefore mocks only paid external provider boundaries while running the real API, Redis worker, FFmpeg, database, Next editor, and Remotion Player. Cover this exact sequence:

- [ ] **Step 1a: Add the happy-path browser scenario**

```ts
test('creates a single-segment project and reaches a timed Remotion preview', async ({ page }) => {
  await createProject(page, '生产文字视频')
  await enterScript(page, '做 AI 视频的，一个月没赚到钱。')
  await expect(segmentCards(page)).toHaveCount(1)
  await previewAndApplyAiSplit(page)
  await generatePendingSpeech(page)
  await confirmEveryReadySegment(page)
  await buildMasterAudio(page)
  await generateScenePlan(page)
  await expect(page.getByRole('tab', { name: '视频合成' })).toBeEnabled()
  await expect(page.getByTestId('scene-timeline')).toContainText('配音音频')
  await page.reload()
  await expect(page.getByTestId('remotion-preview')).toBeVisible()
})
```

- [ ] **Step 1b: Add stable browser helpers and the stale-TTS scenario**

Define the browser helpers in the same spec with stable accessible selectors:

```ts
async function createProject(page: Page, title: string) {
  await page.goto('/text-video')
  await page.getByRole('button', { name: '新建文字视频' }).click()
  await expect(page).toHaveURL(/\/text-video\/\d+$/)
  await page.getByLabel('作品标题').fill(title)
}

async function enterScript(page: Page, script: string) {
  await page.getByLabel('口播内容').fill(script)
  await page.getByText('已保存').waitFor()
}

async function previewAndApplyAiSplit(page: Page) {
  await page.getByRole('button', { name: 'AI 自动分段' }).click()
  await expect(page.getByRole('dialog', { name: 'AI 自动分段预览' })).toBeVisible()
  await page.getByRole('button', { name: '应用分段' }).click()
}
```

Implement the remaining helpers with the exact button labels defined in Tasks 8 and 11, waiting on visible states rather than fixed sleeps:

```ts
const segmentCards = (page: Page) =>
  page.locator('[data-testid="speech-segment-card"]')

async function generatePendingSpeech(page: Page) {
  await page.getByRole('tab', { name: '配音制作' }).click()
  await page.getByRole('button', { name: '生成全部未生成段落' }).click()
  await expect(segmentCards(page).filter({ hasText: '生成中' })).toHaveCount(0)
  await expect(segmentCards(page).filter({ hasText: '待确认' })).not.toHaveCount(0)
}

async function confirmEveryReadySegment(page: Page) {
  const cards = segmentCards(page)
  for (let index = 0; index < await cards.count(); index += 1) {
    await cards.nth(index).click()
    await page.getByRole('button', { name: '确认当前段' }).click()
  }
  await expect(cards.filter({ hasText: '已确认' })).toHaveCount(await cards.count())
}

async function buildMasterAudio(page: Page) {
  await page.getByRole('button', { name: '生成主音频' }).click()
  await expect(page.getByTestId('master-audio-status')).toHaveText('时间轴已就绪')
}

async function generateScenePlan(page: Page) {
  await page.getByRole('tab', { name: '视频合成' }).click()
  await page.getByRole('button', { name: 'AI 生成分镜' }).click()
  await page.getByRole('button', { name: '让 AI 调整画面' }).click()
  await expect(page.getByTestId('scene-card')).not.toHaveCount(0)
}
```

Add a second test that edits one segment while its old TTS job is running, then proves the stale result is rejected, the new text remains, and only that segment is retryable.

- [ ] **Step 2: Add job lifecycle and dispatch regression tests**

Assert every flow is explicitly dispatched:

```ts
expect(resolveContentJobRunner('text_video_split_preview')).toBe(runTextVideoSplitJob)
expect(resolveContentJobRunner('text_video_speech')).toBe(runTextVideoSpeechJob)
expect(resolveContentJobRunner('text_video_master_audio')).toBe(runTextVideoMasterJob)
expect(resolveContentJobRunner('text_video_scene_plan')).toBe(runTextVideoSceneJob)
```

Extract the worker `if/else` chain into `resolveContentJobRunner(flow)` so this can be unit-tested without starting the infinite Redis loop. Backend job tests cover cancellation for speech/master/scenes, failed-step retry, succeeded-step reuse after worker restart, and queued-job reconciliation after an enqueue failure.

- [ ] **Step 3: Make local development start all required services**

Update every existing `start`, `stop`, `status`, and `logs` branch in `dev.sh` to include Redis ownership and the content worker. Validate `WMS_WORKER_TOKEN` length, connect to an already healthy Redis without claiming its PID or start a local `redis-server --port 6379 --save "" --appendonly no` with host URL `redis://127.0.0.1:6379/0`, start FastAPI, start `pnpm jobs:worker` with the same Redis URL/token, and start Next.js. Track only child processes started by the script and terminate all owned children on stop. Keep Docker-only `redis://redis:6379/0` inside Compose.

Document:

```text
./dev.sh
Web: http://localhost:3000
API: http://localhost:8000
Worker: content-jobs queue
Redis: redis://127.0.0.1:6379/0
```

- [ ] **Step 3a: Document runtime configuration and milestone boundaries**

Also document speech settings, the requirement that the configured transcription provider return `verbose_json.words`, the manual confirmation gate, and that MP4 rendering and voice cloning are not part of this milestone.

- [ ] **Step 4: Run backend, frontend, Remotion, and Compose verification**

Run:

```bash
cd backend
conda run -n wems pytest \
  tests/test_database_text_video_migration.py \
  tests/test_text_video_domain.py \
  tests/test_text_video_segmentation.py \
  tests/test_text_video_speech_jobs.py \
  tests/test_media_command.py \
  tests/test_text_video_audio.py \
  tests/test_text_video_alignment.py \
  tests/test_text_video_scene_plan.py \
  tests/test_text_videos_router.py \
  tests/test_content_jobs.py -q
cd ../web
pnpm test
pnpm lint
pnpm build
pnpm exec remotion compositions remotion/index.ts
cd ..
docker compose config -q
docker compose build api worker web
docker compose run --rm api ffmpeg -version
docker compose run --rm api ffprobe -version
```

Expected: every command exits 0; Remotion lists `tech-text-v1`; FFmpeg and FFprobe are present in the API image; no text-video flow reports `Unsupported content flow`.

- [ ] **Step 5: Run browser QA against the actual services**

First check whether the Browser plugin is connected and use it when available. If it is unavailable, record that reason and run:

```bash
WMS_WORKER_TOKEN=ediora-e2e-worker-token-0000000001 ./dev.sh restart
cd web
pnpm exec playwright test e2e/text-video-production.spec.ts
cd ..
./dev.sh stop
```

Manually inspect desktop and compact widths for all three stages. Verify:

- no side drawer or native browser prompt appears;
- the AI split changes nothing before confirmation;
- real segment and master audio URLs play from the API origin;
- failure messages and retry scopes are truthful;
- stage gating follows confirmed speech plus ready timeline;
- refresh restores split mode, speech state, master audio, word timing, scenes, and selected fallbacks;
- there are no browser console errors or failed asset requests;
- no MP4-render action is presented as available.

- [ ] **Step 6: Commit runtime and acceptance coverage**

```bash
git add \
  web/e2e/text-video-production.spec.ts \
  web/e2e/text-video-provider-server.ts \
  dev.sh \
  README.md \
  backend/tests/test_content_jobs.py \
  backend/tests/test_text_videos_router.py \
  web/scripts/content-worker.test.ts
git commit -m "test: verify text video production workflow"
```

---

## Final Acceptance Checklist

- [ ] A fresh non-empty script is one lossless speech segment.
- [ ] AI split preview returns exact slices and requires explicit confirmation.
- [ ] Cursor split, adjacent merge, and confirmed re-use preserve the master script exactly.
- [ ] Each speech segment owns one independent, idempotent, retryable TTS job.
- [ ] MiMo credentials stay server-side and the active model is configurable.
- [ ] Persisted speech audio is real 44.1 kHz, mono, 128 kbps MP3 and plays through the API origin.
- [ ] Confirmed speech produces one canonical master audio asset.
- [ ] Missing or invalid provider timings use forced alignment, and low-confidence alignment fails visibly.
- [ ] AI scenes partition stable global word IDs and Python resolves a gapless full-duration render input.
- [ ] Manual visual changes do not invalidate speech or master audio.
- [ ] Autosave and worker completion do not overwrite each other.
- [ ] Job cancellation, retry, stale completion, queue recovery, refresh, and compact-width UI are verified.
- [ ] Full backend tests, full frontend tests, ESLint, Next production build, Remotion composition listing, Docker builds, and browser acceptance all pass.
