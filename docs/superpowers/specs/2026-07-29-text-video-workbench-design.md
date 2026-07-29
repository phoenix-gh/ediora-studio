# Text Video Workbench Design

## Goal

Add **文字视频** under the 创作 navigation. A user enters a script, generates and confirms paragraph-level speech, lets AI direct the visual segmentation, previews a reusable Remotion template, and finally renders a synchronized text video.

The first implementation milestone delivers the workbench shell, the canonical render contract, one real Remotion template, and in-browser Remotion Player preview. Live MiMo TTS, voice cloning, durable render jobs, and MP4 output follow in later milestones against the same contracts.

## Product workflow

The project has three explicit stages:

1. **稿件与分镜** — enter a script, split it into speech paragraphs, and let AI propose visual segments.
2. **配音制作** — generate speech per paragraph, listen, regenerate individual paragraphs, and confirm all audio.
3. **视频合成** — choose a Remotion template, let AI modify visual direction, preview one segment or the full video, and render.

Video composition is locked until every speech paragraph is confirmed. Editing narration text after confirmation invalidates the affected audio. Editing display text, highlighting, animation, or scene boundaries does not invalidate audio as long as timing remains within the confirmed audio range.

## Repository placement

Remotion code lives inside the existing Node/React application so the browser preview and final renderer use the same components:

```text
wemedia-studio/
├── app/text-video/                 # Workbench route and client UI
├── lib/text-video/                 # Contracts and workbench domain helpers
└── remotion/
    ├── index.ts                    # Remotion entry point
    ├── Root.tsx                    # Composition registration
    ├── registry.ts                 # Template registry
    ├── contract.ts                 # Shared render contract
    ├── shared/                     # Audio, timed text, transitions
    └── templates/
        └── tech-text-v1/           # First template
```

A later `video-renderer` Docker service uses the same `wemedia-studio` build context with a renderer-specific Dockerfile. It owns Chromium/FFmpeg rendering and does not add those runtime requirements to the Web container.

## Domain boundaries

There is one Remotion codebase with multiple versioned templates. A video project is data, not a copied Remotion project.

Each template owns:

- a Remotion Composition;
- a versioned template identifier;
- a Zod input schema;
- defaults and supported aspect ratios;
- supported animation and transition identifiers;
- display metadata and preview artwork.

Published template versions are immutable in behavior. Breaking visual changes create a new version, such as `tech-text-v2`. Existing video projects retain their template version and render-props snapshot.

## Canonical render contract

All templates consume the same audio and timed-segment base. Template-specific settings are isolated under `templateProps`.

```ts
type TextVideoRenderInput = {
  templateId: string
  templateVersion: number
  composition: {
    width: number
    height: number
    fps: number
  }
  audio: string
  segments: Array<{
    id: string
    start: number
    end: number
    text: string
    highlight: string[]
    animation: string
  }>
  templateProps: Record<string, unknown>
}
```

`start` and `end` are seconds on the confirmed master audio. The template converts seconds to frames using the composition FPS. Segments must be ordered, non-overlapping, and bounded by the audio duration.

The first template accepts these additional properties:

```ts
type TechTextV1Props = {
  theme: 'tech-blue'
  font: 'source-han-sans'
  background: 'dark-grid'
  transition: 'soft-push'
  textDensity: 'compact' | 'standard' | 'spacious'
}
```

## TTS boundary

Provider-specific TTS data is not passed to Remotion. A speech request contains the model, narration text, voice identifier, speed, volume, pitch, subtitle requirements, and audio encoding settings. The TTS adapter produces:

- an audio asset URL;
- duration;
- paragraph status;
- word-level timing where available.

The system then normalizes confirmed speech into `audio + segments` for Remotion. This keeps MiMo replaceable and lets the renderer remain deterministic and network-independent.

## AI director boundary

AI operates on a structured scene plan rather than editing Remotion code. It may:

- merge word timings into readable visual segments;
- split or merge scenes;
- shorten display text while preserving narration meaning;
- choose highlight phrases;
- choose animations supported by the selected template;
- populate template-specific props;
- respond to instructions such as “拆成两个画面” or “强调没赚到钱”.

AI output is validated against the canonical contract and the selected template schema before preview. Unsupported animation names, invalid time ranges, overlaps, or missing text are rejected with an actionable validation message.

## Workbench layout

The route is `/text-video` and appears as **文字视频** under 创作.

The shared workbench frame contains:

- a top bar with project name, save state, three workflow stages, aspect ratio, and selected template;
- a left column using approximately 28% of the content width for paragraph or scene navigation;
- a central workspace for script editing, audio review, or Remotion Player preview depending on stage;
- a right settings column for voice settings or template properties;
- a lightweight bottom scene strip in the video stage.

The interface avoids side drawers. Focused configuration uses project Dialog components.

### 稿件与分镜

- Paste or edit the master script.
- Split into paragraph-level speech units.
- Show estimated duration and generation state per paragraph.
- Ask AI to propose visual segments without changing narration unless explicitly requested.

### 配音制作

- Show paragraph list, current text, audio waveform placeholder/player, and confirmation state.
- Configure a voice from a shared voice library, including cloned voices.
- Regenerate only the current paragraph.
- Enable video composition only when every paragraph is confirmed.

### 视频合成

- Embed `@remotion/player` using the exact registered Composition used by the renderer.
- Clicking a scene previews its frame range; **预览全片** plays the complete composition.
- Allow scene ordering and AI-directed visual changes.
- First release does not provide freeform duration dragging, multi-track editing, or arbitrary keyframe editing.

## First Remotion template

`tech-text-v1` is a technology-news dynamic text template:

- dark navy grid background;
- responsive 9:16, 16:9, and 1:1 layouts;
- large keyword emphasis;
- `fade-up` and `scale` segment animations;
- `soft-push` transitions;
- audio-synchronized text changes;
- safe-area-aware typography.

The template must render from fixture input in Remotion Studio and inside the workbench Player.

## Persistence and later services

Later milestones add database entities for text-video projects, speech paragraphs, visual segments, and render outputs. Audio, subtitles, thumbnails, and MP4 files live in persistent asset storage rather than the Remotion source directory.

Rendering becomes a durable content job with explicit stages: validate input, bundle/select Composition, render, persist output, and publish job progress. Rendering retries do not regenerate confirmed TTS audio.

## First milestone scope

Included:

- 创作 navigation entry and `/text-video` route;
- responsive three-stage workbench shell;
- local fixture project demonstrating all workflow states;
- canonical render contract with validation;
- template registry;
- one working `tech-text-v1` Composition;
- Remotion Player full preview and selected-scene preview;
- unit tests, production build, and rendered browser QA.

Excluded:

- live MiMo API calls;
- actual voice cloning;
- database persistence;
- server-side MP4 rendering;
- production job orchestration;
- multi-track editing.

No UI action may claim that audio or video was generated when the corresponding backend integration is not present. Unavailable actions are visibly disabled and labelled as the next integration stage.

## Verification

- Contract tests accept valid input and reject overlapping, unordered, or out-of-range segments.
- Registry tests resolve `tech-text-v1` and reject unknown template versions.
- Component tests cover stage navigation and the audio-confirmation gate.
- Remotion tests or static render checks verify the Composition accepts fixture props for every supported aspect ratio.
- Next.js tests and production build pass.
- Browser QA verifies `/text-video`, the three-stage layout, Player playback, selected-scene playback, and absence of framework/console errors at desktop and a practical narrow viewport.
