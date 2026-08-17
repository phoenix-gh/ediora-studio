# Text Video Kinetic Punch V2 Motion System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic, word-timed `kinetic-punch-v2@1` Remotion template with editable rule/AI motion planning, complete scene lifecycles, overlapping transitions, backward-compatible persistence, preview, and MP4 export.

**Architecture:** `scene_plan` remains the editable source of truth and stores optional motion chunks by stable word IDs; the existing projection layer converts those chunks into absolute render-time cues. A shared pure motion-timing layer drives a template-specific Kinetic Punch composition, while the existing durable `text_video_scene_plan` job gains a constrained `motion` mode for AI optimization. V1 templates and projects keep their existing identities and rendering behavior.

**Tech Stack:** FastAPI, Pydantic, SQLAlchemy JSON documents, Next.js 16.2.4, React 19.2.4, TypeScript, Zod, AI SDK 7, Remotion 4.0.500, Vitest, Testing Library, pytest, Remotion CLI.

## Global Constraints

- Register the new template exactly as `templateId=kinetic-punch-v2`, `templateVersion=1`, `compositionId=kinetic-punch-v2`.
- Do not change the rendering behavior of `kinetic-punch-v1@1` or any other V1 template.
- Keep one Remotion project; video projects remain data and never copy a Remotion codebase.
- Persist editable motion boundaries with word IDs in `scene_plan`; store seconds only in the projected `render_input`.
- AI may return only validated structured motion data and may not return CSS, React, Remotion code, arbitrary keyframes, or rewritten scene text.
- Rule-based motion planning must work without AI. When provider-exact cues are unavailable, proportionally map display-text slices onto the existing global aligned word ranges and label them as estimated.
- Motion must be deterministic: no `Math.random()`, wall-clock state, or playback-only state.
- The V2 composition must support 16:9, 9:16, and 1:1 from the same semantic motion plan.
- Use project Dialog components for focused AI instructions; do not add a side drawer or browser-native prompt.
- Preview, frame inspection, and MP4 export must consume the same saved `render_input`.
- Do not add an npm dependency for this work.
- Preserve all pre-existing dirty-worktree edits. If a required file is already dirty, stage only the exact task hunk and never stage unrelated changes.

---

### Task 1: Backend Motion Document and Render Projection

**Files:**
- Modify: `backend/text_video_scene_plan.py`
- Modify: `backend/routers/text_videos.py`
- Modify: `backend/tests/test_text_video_scene_plan.py`
- Modify: `backend/tests/test_text_videos_router.py`

**Interfaces:**
- Produces: optional `scene["motion"]` with `transition`, `intensity`, and word-ID-based `chunks`.
- Produces: `validate_scene_motion(motion, *, scene, words) -> dict | None`.
- Produces: render segments with optional `transition`, `intensity`, and second-based `chunks`.
- Consumes: existing `validate_scene_partition()`, `resolve_scene_seconds()`, and exact-field validation.

- [ ] **Step 1: Write failing backend domain tests**

Add fixtures with three contiguous words and assert the motion document is accepted only
when chunk word ranges completely partition the parent scene:

```python
def test_scene_motion_projects_word_ids_to_render_seconds():
    words = [
        {"id": "w1", "text": "做AI", "start": 0.0, "end": 0.8},
        {"id": "w2", "text": "一个月", "start": 0.8, "end": 1.7},
        {"id": "w3", "text": "没赚到钱", "start": 1.7, "end": 3.0},
    ]
    scenes = [{
        "id": "s1",
        "fromWordId": "w1",
        "throughWordId": "w3",
        "displayText": "做AI，一个月没赚到钱",
        "highlight": ["没赚到钱"],
        "animation": "reveal",
        "motion": {
            "transition": "block-wipe",
            "intensity": 0.8,
            "chunks": [
                {
                    "id": "c1",
                    "fromWordId": "w1",
                    "throughWordId": "w1",
                    "displayText": "做AI，",
                    "highlight": [],
                    "motionPreset": "reveal",
                    "emphasis": "normal",
                },
                {
                    "id": "c2",
                    "fromWordId": "w2",
                    "throughWordId": "w3",
                    "displayText": "一个月没赚到钱",
                    "highlight": ["没赚到钱"],
                    "motionPreset": "impact",
                    "emphasis": "punch",
                },
            ],
        },
    }]
    segments = resolve_scene_seconds(
        proposals=scenes,
        words=words,
        master_duration=3.0,
        manifest=kinetic_v2_manifest(),
    )
    assert segments[0]["chunks"][1]["start"] == 0.8
    assert segments[0]["chunks"][1]["end"] == 3.0
    assert segments[0]["chunks"][1]["words"][-1] == {
        "text": "没赚到钱",
        "start": 1.7,
        "end": 3.0,
        "emphasis": "highlight",
    }
```

Also add parameterized failures for an unknown word ID, a gap between chunks, an
overlap, `intensity=1.1`, a highlight absent from chunk text, rewritten/omitted
`displayText`, an unsupported preset, and an unsupported transition.

- [ ] **Step 2: Run the domain tests and verify RED**

Run:

```bash
cd backend
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  tests/test_text_video_scene_plan.py -q
```

Expected: failures because scene motion is rejected as an extra field and render chunks
are not projected.

- [ ] **Step 3: Implement optional exact motion validation**

Keep the six existing scene fields required and allow only one optional `motion` key.
Use these constants and signature:

```python
BASE_SCENE_FIELDS = {
    "id", "fromWordId", "throughWordId",
    "displayText", "highlight", "animation",
}
MOTION_FIELDS = {"transition", "intensity", "chunks"}
MOTION_CHUNK_FIELDS = {
    "id", "fromWordId", "throughWordId", "displayText",
    "highlight", "motionPreset", "emphasis",
}
EMPHASIS_VALUES = {"normal", "punch"}

def validate_scene_motion(
    motion: Any,
    *,
    scene: dict,
    words: list[dict],
) -> dict | None:
    if motion is None:
        return None
    if not isinstance(motion, dict) or set(motion) != MOTION_FIELDS:
        raise ValueError("动效编排字段无效")
    if motion["transition"] != "block-wipe":
        raise ValueError("动效编排转场无效")
    intensity = motion["intensity"]
    if not _is_finite_number(intensity) or not 0 <= intensity <= 1:
        raise ValueError("动效编排强度必须位于 0 到 1")
    if not isinstance(motion["chunks"], list) or not motion["chunks"]:
        raise ValueError("动效短句不能为空")
    return _validate_motion_chunks(
        motion,
        scene=scene,
        words=words,
    )
```

Implement `_validate_motion_chunks()` with the existing `_word_indexes()`,
`_require_nonblank()`, and `_validate_highlights()` helpers. It must require exact chunk
keys, `impact|reveal|contrast`, `normal|punch`, unique chunk IDs, and a contiguous
word-range partition from the parent scene's first word through its last word. Compare
display-text coverage after removing Unicode whitespace only; do not remove punctuation.
Return a deep-copied canonical document. Only include `"motion"` in the canonical scene
when the input contained non-null motion, so unchanged V1 fixture equality remains stable.

Validate the motion document against these fixed V2 values rather than the currently
selected template manifest. This lets a project retain its V2 motion document while a
V1 template is selected.

- [ ] **Step 4: Project motion to a render-ready segment**

Extend render-segment validation with optional `transition`, `intensity`, and `chunks`.
For each chunk, derive boundaries from its word range and the following chunk:

```python
def resolve_motion_chunks(scene, words, *, scene_start, scene_end):
    indexes = _word_indexes(words)
    motion = scene.get("motion")
    if motion is None:
        return None
    chunks = []
    for index, chunk in enumerate(motion["chunks"]):
        from_index = indexes[chunk["fromWordId"]]
        following = motion["chunks"][index + 1] if index + 1 < len(motion["chunks"]) else None
        end = (
            float(words[indexes[following["fromWordId"]]]["start"])
            if following else scene_end
        )
        cues = cue_words(
            words[from_index:indexes[chunk["throughWordId"]] + 1],
            chunk["highlight"],
        )
        chunks.append({
            "id": chunk["id"],
            "start": scene_start if index == 0 else float(words[from_index]["start"]),
            "end": end,
            "text": chunk["displayText"],
            "motionPreset": chunk["motionPreset"],
            "emphasis": chunk["emphasis"],
            "words": cues,
        })
    return chunks
```

`cue_words()` marks every cue participating in a normalized highlight match as
`highlight`; all other cues are `normal`. If no cue text maps to a visual highlight,
mark the final cue so the emphasis still has a deterministic spoken anchor.

Only append `transition`, `intensity`, and `chunks` to the render segment when the
selected manifest identity is `kinetic-punch-v2@1`. Other templates retain the persisted
motion document in `scene_plan` but receive their original six-field render segments.

- [ ] **Step 5: Accept and persist optional motion through the API**

Add strict Pydantic models and exclude `None` when converting requests:

```python
class SceneMotionChunkEdit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1)
    fromWordId: str = Field(min_length=1)
    throughWordId: str = Field(min_length=1)
    displayText: str = Field(min_length=1)
    highlight: list[str] = Field(default_factory=list)
    motionPreset: Literal["impact", "reveal", "contrast"]
    emphasis: Literal["normal", "punch"]

class SceneMotionEdit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    transition: Literal["block-wipe"]
    intensity: float = Field(ge=0, le=1)
    chunks: list[SceneMotionChunkEdit] = Field(min_length=1)
```

Add `motion: SceneMotionEdit | None = None` to `ScenePlanSceneEdit`. Use
`model_dump(mode="json", exclude_none=True)` in scene-plan edit and worker routes.
Extend `SegmentDocument` with matching render chunk models so API serialization and
frozen render jobs retain the V2 fields.

- [ ] **Step 6: Run backend tests and verify GREEN**

Run:

```bash
cd backend
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  tests/test_text_video_scene_plan.py \
  tests/test_text_videos_router.py -q
```

Expected: all selected tests pass, including an old V1 project with no motion fields.

- [ ] **Step 7: Commit Task 1**

```bash
git add backend/text_video_scene_plan.py backend/routers/text_videos.py \
  backend/tests/test_text_video_scene_plan.py \
  backend/tests/test_text_videos_router.py
git commit -m "feat: project word-timed text video motion"
```

---

### Task 2: Frontend Motion Contract and Deterministic Rule Planner

**Files:**
- Modify: `web/remotion/types.ts`
- Modify: `web/remotion/contract.ts`
- Modify: `web/remotion/contract.test.ts`
- Modify: `web/lib/api/text-videos.ts`
- Create: `web/lib/text-video/motion-plan.ts`
- Create: `web/lib/text-video/motion-plan.test.ts`
- Modify: `web/lib/text-video/scene-plan.ts`
- Modify: `web/lib/text-video/scene-plan.test.ts`

**Interfaces:**
- Produces: `KineticSceneMotionPlan`, `KineticMotionChunkDocument`,
  `KineticRenderChunk`, and `KineticWordCue`.
- Produces: `buildRuleMotionPlan(scene, words) -> KineticSceneMotionPlan`.
- Produces: `applyRuleMotionPlan(project, sceneIds?) -> TextVideoProject`.
- Produces: `editSceneMotion(project, sceneId, motion) -> TextVideoProject`.
- Consumes: backend field names from Task 1 and existing `applyScenePlanToProject()`.

- [ ] **Step 1: Write failing render-contract and planner tests**

Use a scene with visual punctuation and source word timings, then assert deterministic,
lossless output:

```ts
it('builds the same lossless rule motion plan on every call', () => {
  const scene = {
    id: 's1',
    fromWordId: 'w1',
    throughWordId: 'w5',
    displayText: '做 AI 视频的，一个月没赚到钱',
    highlight: ['没赚到钱'],
    animation: 'reveal',
  }
  const first = buildRuleMotionPlan(scene, WORDS)
  const second = buildRuleMotionPlan(scene, WORDS)

  expect(second).toEqual(first)
  expect(first.chunks.map(chunk => chunk.displayText).join(''))
    .toBe(scene.displayText)
  expect(first.chunks.at(-1)).toMatchObject({
    motionPreset: 'impact',
    emphasis: 'punch',
  })
})
```

Add tests for: text shorter than four characters; a tail shorter than four characters
merging backward; proportional mapping when `timeline_source` is not `provider`;
highlights; display-text edits clearing stale motion; and
`applyScenePlanToProject()` projecting chunks without changing V1 segments.

- [ ] **Step 2: Run focused frontend tests and verify RED**

Run:

```bash
cd web
pnpm test -- remotion/contract.test.ts \
  lib/text-video/motion-plan.test.ts \
  lib/text-video/scene-plan.test.ts
```

Expected: missing module/type failures and contract rejection of motion fields.

- [ ] **Step 3: Add shared TypeScript document and render types**

Define the exact shapes once in `remotion/types.ts` and reuse them from the API module:

```ts
export type KineticWordCue = {
  text: string
  start: number
  end: number
  emphasis: 'normal' | 'highlight'
}

export type KineticRenderChunk = {
  id: string
  start: number
  end: number
  text: string
  motionPreset: 'impact' | 'reveal' | 'contrast'
  emphasis: 'normal' | 'punch'
  words: KineticWordCue[]
}

export type TextVideoSegment = {
  id: string
  start: number
  end: number
  text: string
  highlight: string[]
  animation: string
  transition?: 'block-wipe'
  intensity?: number
  chunks?: KineticRenderChunk[]
}
```

Add `KineticMotionChunkDocument` and `KineticSceneMotionPlan` to
`lib/api/text-videos.ts`, then add optional `motion` to `ScenePlanSceneDocument`.
Extend the strict Zod render schema and validate nested ordering, containment,
supported presets, and finite intensity.

- [ ] **Step 4: Implement the rule planner**

In `motion-plan.ts`, export:

```ts
export function buildRuleMotionPlan(
  scene: ScenePlanSceneDocument,
  words: GlobalWordTiming[],
): KineticSceneMotionPlan

export function applyRuleMotionPlan(
  project: TextVideoProject,
  sceneIds?: readonly string[],
): TextVideoProject

export function editSceneMotion(
  project: TextVideoProject,
  sceneId: string,
  motion: KineticSceneMotionPlan,
): TextVideoProject
```

Split `displayText` first at `。！？；，,.!?;` after at least four visible characters,
otherwise at ten visible characters. Merge a final slice shorter than four characters
into the previous slice. Partition the scene's source words proportionally across those
text slices, preserving a non-empty contiguous word range for every chunk. Use:

```ts
const IMPACT_PATTERN = /\\d|没|不|却|但|其实|结果|关键|必须|只要/u
const preset = highlights.length > 0 || IMPACT_PATTERN.test(text)
  ? 'impact'
  : index > 0 && index % 3 === 2
    ? 'contrast'
    : 'reveal'
```

Set `intensity` to `0.8` when any chunk is `impact`, otherwise `0.65`; always use
`block-wipe`. IDs are stable `${scene.id}-chunk-${index + 1}`. Set the parent scene's
legacy `animation` field to the first chunk's `motionPreset`, so V2 manifest validation
and older render consumers agree.

- [ ] **Step 5: Integrate motion with existing scene edits and projection**

Update `applyScenePlanToProject()` to include projected motion fields. Update
`editSceneVisuals()` so changing `displayText` or `highlight` removes that scene's
motion, while a legacy animation-only change leaves motion untouched. Both functions
must continue advancing `generation_revision` and make old output stale through the
existing autosave path.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run the command from Step 2.

Expected: all selected Vitest files pass with no snapshot updates.

- [ ] **Step 7: Commit Task 2**

```bash
git add web/remotion/types.ts \
  web/remotion/contract.ts \
  web/remotion/contract.test.ts \
  web/lib/api/text-videos.ts \
  web/lib/text-video/motion-plan.ts \
  web/lib/text-video/motion-plan.test.ts \
  web/lib/text-video/scene-plan.ts \
  web/lib/text-video/scene-plan.test.ts
git commit -m "feat: add deterministic text motion plans"
```

---

### Task 3: Shared Frame Lifecycle and Boundary Continuity

**Files:**
- Create: `web/remotion/shared/motion-lifecycle.ts`
- Create: `web/remotion/shared/motion-lifecycle.test.ts`

**Interfaces:**
- Produces: `motionLayersAtFrame(chunks, frame, fps, overlapFrames?)`.
- Produces: `wordEmphasisProgress(cue, frame, fps, durationFrames?)`.
- Produces: frame-derived enter, hold, exit, background-enter, and mount state.
- Consumes: `KineticRenderChunk` from Task 2.

- [ ] **Step 1: Write failing lifecycle tests**

```ts
it('keeps the outgoing layer while the next background enters', () => {
  const chunks = [
    makeChunk({ id: 'a', start: 0, end: 3 }),
    makeChunk({ id: 'b', start: 3, end: 6 }),
  ]
  const atBoundary = motionLayersAtFrame(chunks, 90, 30, 6)

  expect(atBoundary.map(layer => layer.chunk.id)).toEqual(['a', 'b'])
  expect(atBoundary[0].exit).toBe(0)
  expect(atBoundary[1].backgroundEnter).toBeGreaterThan(0)
  expect(atBoundary[1].textEnter).toBe(0)
})

it('fires word emphasis once at the spoken cue', () => {
  const cue = { text: '没赚到钱', start: 1.7, end: 2.4, emphasis: 'highlight' as const }
  expect(wordEmphasisProgress(cue, 50, 30, 12)).toBe(0)
  expect(wordEmphasisProgress(cue, 56, 30, 12)).toBeGreaterThan(0)
  expect(wordEmphasisProgress(cue, 70, 30, 12)).toBe(0)
})
```

Also cover frame zero, the last composition frame, a one-frame chunk, 24/30/60 FPS,
missing cues, negative frames, and repeated calls returning equal objects.

- [ ] **Step 2: Run the lifecycle test and verify RED**

```bash
cd web
pnpm test -- remotion/shared/motion-lifecycle.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement pure frame calculations**

Use a local clamp and no React state:

```ts
const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

export function motionLayersAtFrame(
  chunks: readonly KineticRenderChunk[],
  frame: number,
  fps: number,
  overlapFrames = 6,
) {
  return chunks.flatMap((chunk, index) => {
    const startFrame = Math.ceil(chunk.start * fps)
    const endFrame = Math.ceil(chunk.end * fps)
    const mountStart = index === 0 ? 0 : startFrame - overlapFrames
    const mountEnd = index === chunks.length - 1
      ? endFrame
      : endFrame + overlapFrames
    if (frame < mountStart || frame >= mountEnd) return []
    return [{
      chunk,
      index,
      backgroundEnter: clamp01((frame - mountStart + 1) / overlapFrames),
      textEnter: clamp01(
        (frame - startFrame + (index === 0 ? 1 : 0)) / 8,
      ),
      hold: clamp01((frame - startFrame - 8) / Math.max(1, endFrame - startFrame - 14)),
      exit: clamp01((frame - endFrame) / overlapFrames),
    }]
  })
}
```

Implement `wordEmphasisProgress()` as a deterministic `0 → 1 → 0` envelope starting
at `Math.round(cue.start * fps)`, then shape it with a fixed ease-out curve. Return zero
for non-highlight cues.

- [ ] **Step 4: Run the lifecycle test and verify GREEN**

Run the command from Step 2.

Expected: all lifecycle edge cases pass.

- [ ] **Step 5: Commit Task 3**

```bash
git add web/remotion/shared/motion-lifecycle.ts \
  web/remotion/shared/motion-lifecycle.test.ts
git commit -m "feat: add deterministic remotion scene lifecycles"
```

---

### Task 4: Kinetic Punch V2 Composition and Template Registration

**Files:**
- Create: `web/remotion/templates/kinetic-punch-v2/config.ts`
- Create: `web/remotion/templates/kinetic-punch-v2/layout.ts`
- Create: `web/remotion/templates/kinetic-punch-v2/Composition.tsx`
- Create: `web/remotion/templates/kinetic-punch-v2/Composition.test.tsx`
- Create: `web/remotion/templates/kinetic-punch-v2/manifest.ts`
- Modify: `web/remotion/registry.ts`
- Modify: `web/remotion/registry.test.ts`
- Modify: `web/remotion/Root.test.ts`
- Modify: `backend/text_video_templates.py`
- Modify: `backend/tests/test_text_video_templates.py`

**Interfaces:**
- Produces: `kineticPunchV2Manifest`.
- Produces: `KineticPunchV2Composition(props: TextVideoRenderInput<KineticPunchV2Props>)`.
- Produces: `kineticLayout(width, height, visibleCharacters)`.
- Consumes: Task 2 render chunks and Task 3 lifecycle functions.

- [ ] **Step 1: Write failing registry, layout, and composition tests**

Lock the exact identity and catalog parity:

```ts
expect(resolveTextVideoTemplate('kinetic-punch-v2', 1)).toMatchObject({
  id: 'kinetic-punch-v2',
  version: 1,
  compositionId: 'kinetic-punch-v2',
  name: '动感大字 V2',
  animations: ['impact', 'reveal', 'contrast'],
  transitions: ['block-wipe'],
})
```

Render frames immediately before, at, and after a chunk boundary by mocking
`useCurrentFrame()`. Assert both layers exist at the boundary, the outgoing text remains
visible, the incoming text is not visible before its word time, and highlighted text has
a larger transform during its cue. Test layout output for 1080×1920, 1920×1080, and
1080×1080, including a three-line cap.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
cd web
pnpm test -- remotion/registry.test.ts remotion/Root.test.ts \
  remotion/templates/kinetic-punch-v2/Composition.test.tsx

cd ../backend
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  tests/test_text_video_templates.py -q
```

Expected: missing V2 manifest/composition and catalog mismatch.

- [ ] **Step 3: Define V2 settings and responsive layout**

Use a strict Zod config with existing brand controls:

```ts
export const kineticPunchV2PropsSchema = z.object({
  brandTitle: z.string().max(40),
  showBrand: z.boolean(),
  accentColor: z.string().regex(/^#[0-9A-F]{6}$/iu),
  showProgress: z.boolean(),
  palette: z.enum(['night', 'light']),
}).strict()

export const KINETIC_PUNCH_V2_DEFAULTS = {
  brandTitle: 'EDIORA',
  showBrand: true,
  accentColor: '#D8FF3E',
  showProgress: true,
  palette: 'night',
} as const

export const KINETIC_PUNCH_V2_SETTINGS = [{
  id: 'brand',
  label: '品牌与画面',
  fields: [
    { key: 'brandTitle', kind: 'text', label: '左上角品牌', maxLength: 40 },
    { key: 'showBrand', kind: 'boolean', label: '显示品牌' },
    { key: 'accentColor', kind: 'color', label: '强调色' },
    { key: 'showProgress', kind: 'boolean', label: '显示进度' },
    {
      key: 'palette',
      kind: 'select',
      label: '底色',
      options: [
        { value: 'night', label: '深色' },
        { value: 'light', label: '浅色' },
      ],
    },
  ],
}] as const
```

`kineticLayout()` returns safe-area insets, font size, line height, maximum text width,
and block angle. Base font size on the smaller video dimension and reduce it in bounded
steps for 9–18 and 19+ visible characters; never return more than three lines.

- [ ] **Step 4: Implement the three V2 motion presets**

Render every mounted layer returned by `motionLayersAtFrame()`. Use:

```tsx
const blockTransform = preset === 'contrast'
  ? `translateX(${(1 - backgroundEnter) * 100}%)`
  : `translateX(${(1 - backgroundEnter) * -18}%) rotate(-5deg)`

const textTransform = preset === 'impact'
  ? `translateY(${(1 - textEnter) * 42}px) scale(${0.94 + textEnter * 0.06 + emphasis * 0.12})`
  : `translateY(${(1 - textEnter) * 30}px) scale(${1 + hold * 0.018})`

const clipPath = `inset(0 ${(1 - textEnter) * 100}% 0 0)`
```

For `reveal`, stagger line masks by two frames. For `impact`, apply the emphasis envelope
only to the highlighted phrase. For `contrast`, invert foreground and block colors after
the emphasized cue starts. During exit, move the outgoing text and block on separate
axes. Keep the outgoing text above the incoming background until incoming text reveal is
non-zero.

Always render `Html5Audio` from `props.audio`, the configured brand, and deterministic
progress. Do not import or reuse `TimedText`.

- [ ] **Step 5: Register frontend and backend catalogs**

Append `kineticPunchV2Manifest` to the frontend registry without replacing V1. Add the
matching backend manifest with:

```python
{
    "id": "kinetic-punch-v2",
    "version": 1,
    "composition_id": "kinetic-punch-v2",
    "default_composition": {"width": 1080, "height": 1920, "fps": 30},
    "aspect_ratios": ["9:16", "16:9", "1:1"],
    "animations": ["impact", "reveal", "contrast"],
    "transitions": ["block-wipe"],
    "template_props": {
        "brandTitle": {"type": "string", "maxLength": 40},
        "showBrand": {"type": "boolean"},
        "accentColor": {"type": "color"},
        "showProgress": {"type": "boolean"},
        "palette": {"type": "enum", "values": ["night", "light"]},
    },
    "defaults": {
        "brandTitle": "EDIORA",
        "showBrand": True,
        "accentColor": "#D8FF3E",
        "showProgress": True,
        "palette": "night",
    },
}
```

Update exact registry order/length assertions to include V2 as the sixth template.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run both commands from Step 2.

Expected: frontend and backend catalogs agree and every V2 composition assertion passes.

- [ ] **Step 7: Commit Task 4**

```bash
git add web/remotion/templates/kinetic-punch-v2 \
  web/remotion/registry.ts \
  web/remotion/registry.test.ts \
  web/remotion/Root.test.ts \
  backend/text_video_templates.py backend/tests/test_text_video_templates.py
git commit -m "feat: add kinetic punch v2 remotion template"
```

---

### Task 5: Constrained AI Motion Optimization

**Files:**
- Modify: `backend/routers/text_videos.py`
- Modify: `backend/text_video_scene_plan.py`
- Modify: `backend/job_reconciliation.py`
- Modify: `backend/tests/test_text_videos_router.py`
- Modify: `backend/tests/test_job_reconciliation.py`
- Modify: `web/lib/ai/text-video-scene-job.ts`
- Modify: `web/lib/ai/text-video-scene-job.test.ts`
- Modify: `web/lib/api/text-videos.ts`

**Interfaces:**
- Extends: `POST /api/text-videos/{id}/scene-plan/generate` with `mode: 'scene' | 'motion'`.
- Produces: AI motion proposals using the same durable `text_video_scene_plan` flow.
- Consumes: Task 1 motion validation and Task 4 V2 manifest capabilities.

- [ ] **Step 1: Write failing API, worker, and recovery tests**

Add tests proving:

```python
async def test_motion_mode_freezes_current_scene_text_and_ranges(env):
    response = await env.generate_scene_plan(mode="motion", scope="all")
    snapshot = response.job.input_data
    assert snapshot["generation_mode"] == "motion"
    assert snapshot["existing_scenes"] == env.project.scene_plan["scenes"]

async def test_motion_failure_restores_last_ready_plan(env):
    before = deepcopy(env.project.scene_plan["scenes"])
    await env.fail_motion_job("provider unavailable")
    assert env.project.scene_plan["status"] == "ready"
    assert env.project.scene_plan["scenes"] == before
    assert env.project.scene_plan["error"] == "provider unavailable"
```

In Vitest, assert the motion prompt excludes timestamps, freezes scene text/ranges,
accepts valid word-ID chunks, repairs one invalid result, and refuses a proposal that
changes `displayText`.

- [ ] **Step 2: Run focused AI tests and verify RED**

```bash
cd backend
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  tests/test_text_videos_router.py \
  tests/test_job_reconciliation.py -q

cd ../web
pnpm test -- lib/ai/text-video-scene-job.test.ts
```

Expected: request schema rejects `mode`, worker has no motion schema, and failure changes
the last valid plan to failed.

- [ ] **Step 3: Freeze and validate a motion-mode job**

Add `mode: Literal["scene", "motion"] = "scene"` to `ScenePlanGenerateRequest` and
`generation_mode` to the frozen snapshot and request hash. Motion mode requires:

- current ready scene plan matching the master source hash;
- template `kinetic-punch-v2@1`;
- all existing scene ranges and visual fields frozen;
- scope `all` or one exact selected scene.

Add `canonicalize_motion_generation_proposal()` that accepts only motion changes and
returns the full validated scene list. Non-selected scenes must remain byte-for-byte
equal in selected mode.

- [ ] **Step 4: Add the strict worker schema and prompt**

In `text-video-scene-job.ts`, define:

```ts
const motionChunkSchema = z.object({
  id: z.string().min(1),
  fromWordId: z.string().min(1),
  throughWordId: z.string().min(1),
  displayText: z.string().min(1),
  highlight: z.array(z.string()),
  motionPreset: z.enum(['impact', 'reveal', 'contrast']),
  emphasis: z.enum(['normal', 'punch']),
}).strict()

const motionSchema = z.object({
  transition: z.literal('block-wipe'),
  intensity: z.number().min(0).max(1),
  chunks: z.array(motionChunkSchema).min(1),
}).strict()

const motionSceneSchema = z.object({
  id: z.string().min(1),
  fromWordId: z.string().min(1),
  throughWordId: z.string().min(1),
  displayText: z.string().min(1),
  highlight: z.array(z.string()),
  animation: z.enum(['impact', 'reveal', 'contrast']),
  motion: motionSchema,
}).strict()

export const motionProposalSchema = z.object({
  scenes: z.array(motionSceneSchema).min(1),
}).strict()
```

The motion prompt supplies ordered word IDs without seconds, current scene text, current
highlights, allowed presets, and the user direction. It explicitly requires exact scene
text coverage and unchanged top-level scene fields. Keep the existing one-repair path,
but choose the schema and repair text from `context.generation_mode`.

- [ ] **Step 5: Preserve the last valid plan on all motion failures**

In the worker-failure route, restore `status="ready"`, clear `job_id`, retain frozen
scenes, and save the redacted error when `generation_mode=="motion"`. In
`job_reconciliation.py`, make `_fail_scene_domain()` perform the same branch for an
interrupted motion-mode job. The file is already dirty: stage only this branch with an
interactive hunk or an exact temporary index patch; do not stage its unrelated diff.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run both commands from Step 2.

Expected: all selected tests pass; a failed motion job leaves the previous plan usable.

- [ ] **Step 7: Commit Task 5 with scoped staging**

```bash
git add backend/routers/text_videos.py backend/text_video_scene_plan.py \
  backend/tests/test_text_videos_router.py \
  backend/tests/test_job_reconciliation.py \
  web/lib/ai/text-video-scene-job.ts \
  web/lib/ai/text-video-scene-job.test.ts \
  web/lib/api/text-videos.ts
git add -p backend/job_reconciliation.py
git commit -m "feat: let ai optimize text video motion"
```

Before committing, inspect `git diff --cached -- backend/job_reconciliation.py` and
confirm it contains only the `generation_mode=="motion"` recovery branch.

---

### Task 6: Motion Planning Editor and Template Upgrade Flow

**Files:**
- Create: `web/app/text-video/MotionPlanEditor.tsx`
- Create: `web/app/text-video/MotionPlanEditor.test.tsx`
- Modify: `web/app/text-video/VideoStage.tsx`
- Modify: `web/app/text-video/VideoStage.test.tsx`
- Modify: `web/app/text-video/TextVideoEditorClient.tsx`
- Modify: `web/app/text-video/TextVideoEditorClient.test.tsx`
- Modify: `web/app/text-video/useTextVideoProjectActions.ts`
- Modify: `web/app/text-video/useTextVideoProjectActions.test.tsx`

**Interfaces:**
- Produces: inline `MotionPlanEditor` for V2 scenes.
- Consumes: `applyRuleMotionPlan()`, `editSceneMotion()`, autosave, and
  `generateTextVideoScenePlan(..., { mode: 'motion' })`.

- [ ] **Step 1: Write failing editor and template-switch tests**

Test the user-visible flow:

```tsx
it('shows motion controls only for kinetic punch v2', async () => {
  render(<MotionPlanEditor project={V2_PROJECT} scene={V2_SCENE} {...handlers} />)
  expect(screen.getByRole('button', { name: 'AI 优化全片' })).toBeEnabled()
  expect(screen.getByRole('button', { name: '自动拆句' })).toBeEnabled()
  expect(screen.getAllByLabelText('短句动作')).toHaveLength(2)
})

it('switching from v1 to v2 creates and persists a rule plan', async () => {
  await user.click(screen.getByRole('option', { name: /动感大字 V2/ }))
  expect(save).toHaveBeenCalledWith(expect.objectContaining({
    template: expect.objectContaining({ templateId: 'kinetic-punch-v2' }),
    scene_plan: expect.objectContaining({
      scenes: expect.arrayContaining([
        expect.objectContaining({ motion: expect.any(Object) }),
      ]),
    }),
  }))
})
```

Also test selected-scene rule regeneration, preset/intensity edits, failed AI retaining
cards, save-state copy, stale-output indication, the “使用估算时间” label when exact
provider cues are unavailable, and no browser `prompt()` call.

- [ ] **Step 2: Run focused UI tests and verify RED**

```bash
cd web
pnpm test -- app/text-video/MotionPlanEditor.test.tsx \
  app/text-video/VideoStage.test.tsx \
  app/text-video/TextVideoEditorClient.test.tsx \
  app/text-video/useTextVideoProjectActions.test.tsx
```

Expected: missing component and no V2 upgrade behavior.

- [ ] **Step 3: Build the inline motion editor**

`MotionPlanEditor` receives:

```ts
type MotionPlanEditorProps = {
  project: TextVideoProject
  scene: ScenePlanSceneDocument
  busy: boolean
  onProjectChange(project: TextVideoProject): void
  onOptimize(scope: 'all' | 'selected', direction: string): void
}
```

Render short-sentence cards inside the existing scene inspector. Each card shows its
text, word-derived time range, a shadcn Select for `impact/reveal/contrast`, emphasis,
highlight chips, and intensity. Boundary controls move one adjacent word at a time and
must disable before producing an empty chunk. Use the existing Field, Button, Select,
Dialog, and toast primitives.

- [ ] **Step 4: Add rule and AI actions**

- “自动拆句” applies `applyRuleMotionPlan(project, [scene.id])` immediately and marks
  the project dirty.
- “AI 优化本场” opens a Dialog for an optional direction, flushes autosave, then calls
  scene generation with `{ mode: 'motion', scope: 'selected' }`.
- “AI 优化全片” uses `{ mode: 'motion', scope: 'all' }`.
- While a job is active, show “正在优化动效…” and disable conflicting scene edits.
- On failure, refresh the returned ready project and show its `scene_plan.error`; do not
  clear the existing cards.

- [ ] **Step 5: Generate a rule plan when the user actively selects V2**

In `TextVideoEditorClient.applyTemplate()`, when changing from another identity to
`kinetic-punch-v2@1`, first update template fields, then call
`applyRuleMotionPlan(nextProject)` before a single autosave flush. Do not auto-upgrade a
project merely because it was opened. Switching away retains the motion document in
`scene_plan` but projects only fields supported by the selected template. For every
template switch, normalize the parent scene `animation` to the target manifest's first
supported animation when the current value is unsupported. Switching to V2 then replaces
that fallback with the first generated chunk preset.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run the command from Step 2.

Expected: all UI interactions pass and only one save occurs during template upgrade.

- [ ] **Step 7: Commit Task 6**

```bash
git add web/app/text-video/MotionPlanEditor.tsx \
  web/app/text-video/MotionPlanEditor.test.tsx \
  web/app/text-video/VideoStage.tsx \
  web/app/text-video/VideoStage.test.tsx \
  web/app/text-video/TextVideoEditorClient.tsx \
  web/app/text-video/TextVideoEditorClient.test.tsx \
  web/app/text-video/useTextVideoProjectActions.ts \
  web/app/text-video/useTextVideoProjectActions.test.tsx
git commit -m "feat: edit and optimize text video motion"
```

---

### Task 7: Render Regression, Frame Audit, and End-to-End Verification

**Files:**
- Create: `web/remotion/fixtures/kinetic-punch-v2-audit.json`
- Modify: `web/lib/ai/text-video-render-job.test.ts`
- Modify: `web/remotion/templates/kinetic-punch-v2/Composition.test.tsx`

**Interfaces:**
- Consumes: final `kinetic-punch-v2@1` composition and canonical render worker.
- Produces: reproducible fixture-based frame and MP4 audit commands.

- [ ] **Step 1: Add a realistic, audio-optional audit fixture**

Create a 16:9, 30 FPS fixture with at least five chunks covering `impact`, `reveal`, and
`contrast`, a scene boundary at exactly 3.0 seconds, and highlighted word cues. Keep
`audio` empty for deterministic still rendering; the real project export below verifies
audio muxing. Use this complete shape, extending the second segment to three chunks:

```json
{
  "templateId": "kinetic-punch-v2",
  "templateVersion": 1,
  "composition": { "width": 1920, "height": 1080, "fps": 30 },
  "audio": "",
  "segments": [
    {
      "id": "scene-1",
      "start": 0,
      "end": 3,
      "text": "做 AI 视频的，一个月没赚到钱",
      "highlight": ["没赚到钱"],
      "animation": "impact",
      "transition": "block-wipe",
      "intensity": 0.8,
      "chunks": [
        {
          "id": "scene-1-chunk-1",
          "start": 0,
          "end": 1.2,
          "text": "做 AI 视频的，",
          "motionPreset": "reveal",
          "emphasis": "normal",
          "words": [
            { "text": "做 AI 视频的", "start": 0, "end": 1.2, "emphasis": "normal" }
          ]
        },
        {
          "id": "scene-1-chunk-2",
          "start": 1.2,
          "end": 3,
          "text": "一个月没赚到钱",
          "motionPreset": "impact",
          "emphasis": "punch",
          "words": [
            { "text": "一个月", "start": 1.2, "end": 1.8, "emphasis": "normal" },
            { "text": "没赚到钱", "start": 1.8, "end": 3, "emphasis": "highlight" }
          ]
        }
      ]
    },
    {
      "id": "scene-2",
      "start": 3,
      "end": 7.2,
      "text": "不是工具不行，而是内容没有价值",
      "highlight": ["内容没有价值"],
      "animation": "contrast",
      "transition": "block-wipe",
      "intensity": 0.8,
      "chunks": [
        {
          "id": "scene-2-chunk-1",
          "start": 3,
          "end": 4.2,
          "text": "不是工具不行，",
          "motionPreset": "contrast",
          "emphasis": "normal",
          "words": [
            { "text": "不是工具不行", "start": 3, "end": 4.2, "emphasis": "normal" }
          ]
        },
        {
          "id": "scene-2-chunk-2",
          "start": 4.2,
          "end": 5.1,
          "text": "而是",
          "motionPreset": "reveal",
          "emphasis": "normal",
          "words": [
            { "text": "而是", "start": 4.2, "end": 5.1, "emphasis": "normal" }
          ]
        },
        {
          "id": "scene-2-chunk-3",
          "start": 5.1,
          "end": 7.2,
          "text": "内容没有价值",
          "motionPreset": "impact",
          "emphasis": "punch",
          "words": [
            { "text": "内容没有价值", "start": 5.1, "end": 7.2, "emphasis": "highlight" }
          ]
        }
      ]
    }
  ],
  "templateProps": {
    "brandTitle": "EDIORA",
    "showBrand": true,
    "accentColor": "#D8FF3E",
    "showProgress": true,
    "palette": "night"
  }
}
```

- [ ] **Step 2: Add final render-worker regression tests**

Assert `selectComposition()` receives `kinetic-punch-v2` and `renderMedia()` receives the
unchanged nested chunks:

```ts
expect(deps.selectComposition).toHaveBeenCalledWith(expect.objectContaining({
  id: 'kinetic-punch-v2',
  inputProps: expect.objectContaining({
    segments: expect.arrayContaining([
      expect.objectContaining({ chunks: expect.any(Array) }),
    ]),
  }),
}))
```

Add a composition assertion at frames 89, 90, 91, 96, and at the highlighted cue frame.
Frame 90 must contain outgoing text and incoming block; the next text may appear only
from its own start frame. Compare a long chunk's transform at frames separated by 30
frames to prove the hold phase continues meaningful visual movement. Assert the
highlight envelope begins within two frames of its word cue.

- [ ] **Step 3: Run complete automated verification**

```bash
cd backend
/home/violet/miniconda3/envs/wems/bin/python -m pytest -q

cd ../web
pnpm test
pnpm lint
pnpm build
```

Expected: all backend and frontend tests pass, ESLint reports no errors, and the Next.js
production build completes.

- [ ] **Step 4: Render boundary stills in all three aspect ratios**

From `web`, create exact ratio variants and render the same boundary:

```bash
jq '.composition = {width: 1920, height: 1080, fps: 30}' \
  remotion/fixtures/kinetic-punch-v2-audit.json \
  > /tmp/kinetic-v2-16x9.json
jq '.composition = {width: 1080, height: 1920, fps: 30}' \
  remotion/fixtures/kinetic-punch-v2-audit.json \
  > /tmp/kinetic-v2-9x16.json
jq '.composition = {width: 1080, height: 1080, fps: 30}' \
  remotion/fixtures/kinetic-punch-v2-audit.json \
  > /tmp/kinetic-v2-1x1.json

npx remotion still remotion/index.ts kinetic-punch-v2 \
  /tmp/kinetic-v2-16x9-frame-90.png \
  --frame=90 \
  --props=/tmp/kinetic-v2-16x9.json

npx remotion still remotion/index.ts kinetic-punch-v2 \
  /tmp/kinetic-v2-16x9-frame-96.png \
  --frame=96 \
  --props=/tmp/kinetic-v2-16x9.json

npx remotion still remotion/index.ts kinetic-punch-v2 \
  /tmp/kinetic-v2-9x16-frame-90.png \
  --frame=90 \
  --props=/tmp/kinetic-v2-9x16.json

npx remotion still remotion/index.ts kinetic-punch-v2 \
  /tmp/kinetic-v2-1x1-frame-90.png \
  --frame=90 \
  --props=/tmp/kinetic-v2-1x1.json
```

Inspect every image for readable three-line-or-less text, safe margins, continuous
foreground coverage, correct contrast, and no early next-sentence text.

- [ ] **Step 5: Export a real audio-backed project**

First reuse project 2's confirmed master audio without modifying that project, render the
V2 fixture through Remotion, and inspect its streams:

```bash
AUDIT_AUDIO_URL="$(
  curl -fsS http://localhost:8000/api/text-videos/2 \
    | jq -r '.master_audio.audio_url'
)"
jq --arg audio "http://localhost:8000${AUDIT_AUDIO_URL}" \
  '.audio = $audio' \
  remotion/fixtures/kinetic-punch-v2-audit.json \
  > /tmp/kinetic-v2-audio.json
npx remotion render remotion/index.ts kinetic-punch-v2 \
  /tmp/kinetic-v2-real-output.mp4 \
  --props=/tmp/kinetic-v2-audio.json \
  --codec=h264 \
  --audio-codec=aac
ffprobe -v error -show_entries stream=codec_name,codec_type \
  -of json /tmp/kinetic-v2-real-output.mp4
```

Expected ffprobe streams: one `h264` video stream and one `aac` audio stream. Then use a
copy or disposable text-video project in the UI, actively select V2, save a rule plan,
and start the normal durable render action. Expected project state:
`render_state.status == "ready"`, persisted
`render_input.templateId == "kinetic-punch-v2"`, and every V2 scene has chunks. Do not
overwrite project 2 or another user project solely for verification.

- [ ] **Step 6: Perform browser QA**

Open the text-video project and verify:

- V1 projects open and preview unchanged.
- Selecting V2 creates rule cards only after the explicit selection.
- Rule regeneration, manual preset changes, AI Dialog, save state, refresh restore,
  selected-scene preview, full preview, export, playback, and download all work.
- No browser console error or failed API request appears.
- Scene/chunk boundaries do not flash blank at normal speed or frame stepping.

- [ ] **Step 7: Commit Task 7**

```bash
git add web/remotion/fixtures/kinetic-punch-v2-audit.json \
  web/lib/ai/text-video-render-job.test.ts \
  web/remotion/templates/kinetic-punch-v2/Composition.test.tsx
git commit -m "test: verify kinetic punch v2 rendering"
```

- [ ] **Step 8: Review commit scope**

```bash
git status --short
git log --oneline --decorate -8
git diff --check HEAD~7 HEAD
```

Expected: the seven feature commits contain only the files listed in their tasks.
Pre-existing unrelated dirty files remain unstaged and unchanged by this plan.
