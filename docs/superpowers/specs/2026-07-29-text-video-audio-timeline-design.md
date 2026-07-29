# Text Video Speech Segmentation and Timeline Design

## Goal

Extend the persisted text-video editor with a production speech workflow that:

- treats the full script as one speech segment by default;
- optionally lets AI propose speech segments before generation;
- supports manual split and merge operations;
- generates and confirms speech per segment;
- assembles one canonical master audio track;
- derives a word-aligned global timeline from that final audio;
- lets AI direct Remotion scenes without inventing timestamps.

The master audio is the single timing authority for preview and rendering. Speech segments are generation and retry units; video scenes are visual units. They are related through word timing, but they are never required to map one-to-one.

## Relationship to the existing text-video design

This specification extends:

- `2026-07-29-text-video-workbench-design.md`;
- `2026-07-29-text-video-project-management-design.md`.

Where the original workbench design assumes fixed paragraph-level speech generation, this specification supersedes that behavior with configurable speech segmentation and a canonical master-audio pipeline. It preserves the existing project-management routes, autosave model, Remotion template registry, and `audio + segments` render contract.

## Product decisions

1. A new non-empty script starts as exactly one speech segment.
2. The user may keep one segment, preview an AI split, or split and merge manually.
3. AI splitting never rewrites the script and never starts paid TTS generation automatically.
4. Every generated speech segment can be played, regenerated, and confirmed independently.
5. Video composition is available only after all speech segments are confirmed and the master timeline is ready.
6. Remotion receives one master audio asset plus continuous visual scenes on the master timeline.
7. AI chooses word boundaries and supported visual intent. Application code resolves those boundaries into seconds.
8. Editing narration invalidates affected speech. Editing display text, highlights, animation, or template styling does not invalidate speech.

## Domain terminology

### Master script

The exact narration text entered by the user. It is the content authority for speech generation.

### Speech segment

A contiguous, ordered, lossless slice of the master script. It is the unit used for TTS generation, playback, confirmation, failure, and retry.

### Master audio

The final ordered audio asset assembled from all confirmed speech segments. With one speech segment, the confirmed segment audio may be reused as the master asset without an unnecessary second encode.

### Word timeline

The ordered word or token timing data measured against the master audio.

### Video scene

A visual interval generated from one or more contiguous timed words. A scene owns display text, highlights, animation, and template-supported settings, but it does not own narration audio.

## Script and segmentation invariants

The persisted `script` remains the master text. For compatibility, the existing project JSON field `paragraphs` remains the API and database field in this milestone, but each entry represents a speech segment. Frontend domain code may name the collection `speechSegments`.

The core lossless invariant is:

```text
speechSegments.map(segment => segment.text).join("") === script
```

All whitespace and punctuation belong to an exact segment slice. Automatic splitting selects boundaries in the original string and then slices it; it must not ask AI to return rewritten segment text. Manual splitting divides one exact string at the selected cursor boundary. Merging concatenates the two exact strings.

Whitespace at a boundary is attached to the preceding non-empty segment. The system does not create whitespace-only speech segments. An empty project may retain one draft placeholder segment, but generation remains unavailable until it contains speakable text.

## Segmentation modes

The project stores:

```ts
type SpeechSplitMode = 'single' | 'auto' | 'manual'
```

### Single

- Default mode.
- The complete script is one speech segment.
- Generating all pending speech is equivalent to generating the full script once.
- This produces the most consistent delivery and is recommended for normal scripts.

### AI auto split

- The user opens an application Dialog and requests a split preview.
- The server derives stable candidate-boundary IDs from newlines, sentence punctuation, clause punctuation, and safe whitespace in unusually long sentences.
- AI receives the script plus those candidate IDs and returns only ordered boundary IDs with short reasons.
- The server validates the IDs and slices the original script itself. Numeric character offsets never cross the Python/TypeScript boundary, avoiding Unicode-index ambiguity.
- The Dialog shows each proposed speech segment and its estimated duration.
- No project data changes and no TTS request starts until the user confirms.
- Applying the proposal sets the mode to `auto`.

The first release asks AI to prefer semantic sentence groups of practical TTS length. It does not expose a target-duration control; the user can refine the result manually.

### Manual

- The user places the cursor in a speech segment and selects **从此处分段**.
- Adjacent speech segments expose **与上一段合并** and **与下一段合并**.
- Split and merge operations set the mode to `manual`.
- Reordering speech segments is allowed only when it also rewrites the master script to the exact new concatenation and requires explicit confirmation, because it changes narration meaning and master-audio order.

### Preservation during re-segmentation

A speech segment keeps its generated audio only when its exact text and generation settings hash are unchanged. Split, merge, text edit, voice change, model change, speed change, pitch change, or volume change invalidates every affected segment. Unaffected confirmed segments remain reusable.

Invalidating a speech segment sets its status to `draft` and clears its current audio URL, duration, word timings, source hash, and confirmation. Previously stored files become unreferenced assets eligible for later asset cleanup; they are never presented as current speech.

Any segmentation or ordering change marks the master audio, global timeline, and render timing as stale.

## Persisted project state

The existing `paragraphs` documents expand to:

```ts
type SpeechSegmentDocument = {
  id: string
  text: string
  status: 'draft' | 'generating' | 'ready' | 'confirmed' | 'failed'
  audio_url: string
  duration: number
  word_timings: WordTiming[]
  source_hash: string
  generation_revision: number
  error: string
}

type WordTiming = {
  id: string
  text: string
  start: number
  end: number
}
```

`word_timings` on a speech segment are local to that segment audio. Times are seconds, monotonic, non-overlapping, and bounded by the decoded audio duration.

The project adds:

```ts
type MasterAudioDocument = {
  status: 'missing' | 'building' | 'ready' | 'stale' | 'failed'
  timeline_status: 'missing' | 'aligning' | 'ready' | 'stale' | 'failed'
  audio_url: string
  duration: number
  source_hash: string
  word_timings: GlobalWordTiming[]
  timeline_source: 'provider' | 'forced-alignment' | ''
  error: string
  timeline_error: string
}

type GlobalWordTiming = WordTiming & {
  speech_segment_id: string
}
```

The project also persists `speech_split_mode` and `master_audio`. `render_input.audio` mirrors the ready master-audio URL only after timeline validation succeeds. Existing projects with zero or one paragraph migrate to `speech_split_mode='single'`; projects with multiple paragraphs migrate to `speech_split_mode='manual'`. Their current paragraph data remains readable, but incomplete fixture audio is not treated as production-ready master audio.

## TTS provider boundary

The application uses a provider-neutral speech request:

```ts
type SpeechRequest = {
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
```

The adapter returns:

```ts
type SpeechResult = {
  audioAssetUrl: string
  duration: number
  wordTimings?: WordTiming[]
  providerRequestId?: string
}
```

The first adapter targets the configured current MiMo V2.5 TTS model. The model name is configuration, not a Remotion prop and not a hard-coded legacy alias. Xiaomi's platform currently states that the older MiMo V2/TTS names were routed to V2.5 and deprecated, so implementation must use the active V2.5 model exposed to the configured account rather than relying on the old alias: [Xiaomi MiMo API Open Platform](https://platform.xiaomimimo.com/token-plan?planCode=pro%3Ayear).

The design does not assume that MiMo returns word timing. Provider timings are used when present and valid; otherwise the timeline aligner uses the confirmed audio and exact script.

## Speech generation jobs

Speech generation is durable work executed through the existing job infrastructure.

- **生成全部未生成段落** enqueues only draft or failed segments whose source hash has no reusable asset.
- A single-segment action enqueues only that segment.
- Confirmed segments are not regenerated implicitly.
- Each job captures the project ID, speech-segment ID, project revision, generation revision, exact text, and generation-settings hash.
- A completion result is applied only if the current segment still has the same generation revision and source hash.
- A stale result remains an unreferenced job artifact and never overwrites newer project state.
- Duplicate requests with the same source hash are idempotent.

On success, a segment becomes `ready`. The user must listen and explicitly confirm it before master-audio assembly. Regenerating a confirmed segment first returns it to `generating`, then `ready`; it does not silently preserve confirmation.

## Master-audio assembly

Master-audio assembly starts only when every non-empty speech segment is confirmed.

1. Resolve the confirmed audio assets in project order.
2. Decode and normalize them to the target sample rate and channel layout.
3. With one segment, reuse the confirmed audio when it already matches the target encoding.
4. With multiple segments, concatenate decoded audio in order and encode one master asset.
5. Probe the final asset for its actual duration.
6. Build or align the global word timeline against that final asset.
7. Persist the asset, mark `master_audio.status='ready'`, and complete timeline alignment.
8. After alignment succeeds, atomically persist the timeline, mark `timeline_status='ready'`, and copy the asset URL to `render_input.audio`.

The source hash covers the ordered confirmed segment asset identities and relevant audio settings. Repeating the build with the same hash reuses the ready master asset.

The assembler does not crossfade spoken audio. Provider-produced boundary silence remains part of the measured audio and therefore part of the global timeline.

## Timeline alignment

### Native timing path

If every speech result contains valid word timings:

- segment-local timings are offset by the segment's actual position in the decoded master sequence;
- all resulting words receive stable global IDs;
- timings are validated for ordering, non-overlap, and audio bounds;
- the final master duration, including trailing silence, remains authoritative.

### Forced-alignment path

If any segment lacks valid timings, the aligner processes the final master audio together with the exact master script. It returns word-level or token-level boundaries over the complete track. This path also replaces provider timing when timing is unordered, overlapping, negative, or outside decoded audio bounds.

Alignment failure does not delete or invalidate confirmed speech assets. The master audio remains `ready` and playable, while `timeline_status` becomes `failed`; video composition stays locked until alignment succeeds.

## AI scene direction

AI never writes raw scene seconds. It receives:

- the master script;
- ordered global word IDs and text;
- semantic speech-segment boundaries;
- the selected template manifest;
- supported animation and transition identifiers;
- the user's direction.

It returns a structured word partition:

```ts
type AiSceneProposal = {
  id: string
  fromWordId: string
  throughWordId: string
  displayText: string
  highlight: string[]
  animation: string
}
```

The backend requires every timed word to appear exactly once, in order, across contiguous scene proposals. It then resolves scene seconds:

- the first scene starts at `0`;
- an intermediate scene ends where the next scene begins;
- the next scene begins at its first word's start;
- pauses between spoken phrases therefore remain visible in the preceding scene;
- the final scene ends at the probed master-audio duration.

The resulting scenes are continuous, ordered, non-overlapping, and cover the complete audio range. An intentional empty visual interval must be represented as an explicit template-supported blank scene; undefined gaps are invalid.

AI output is validated against both the canonical render contract and the selected template manifest. Unsupported animation names, missing words, duplicated words, invalid highlights, and non-contiguous ranges are rejected. The system may request one structured correction; a second invalid result becomes a visible failure with actionable details.

## Manual scene calibration

The first release does not expose arbitrary millisecond entry or a freeform multitrack editor.

- A scene may be split at a selected word boundary.
- Adjacent scenes may be merged.
- A scene boundary may move one or more words forward or backward.
- Display text, highlights, and supported animation may be edited without changing audio.
- AI may redesign the selected scene or the complete scene plan.

After speech regeneration, the system retains prior visual intent where possible by matching narration text and word ranges, then asks the AI director to recalibrate boundaries against the new timeline. It does not blindly reuse old seconds.

## Workbench behavior

### 稿件与分镜

- New non-empty text appears as one speech segment.
- The toolbar provides **保持整篇**, **AI 自动分段**, and **手动分段** actions.
- AI auto split uses an application Dialog for preview and confirmation.
- Manual split acts at the editor cursor.
- Segment cards support edit, split, merge, status, and estimated duration.
- No side drawer or browser-native prompt is introduced.

### 配音制作

- The left column lists speech segments and their truthful states.
- The central area plays the selected segment and the ready master audio.
- The settings column uses shared voice and speech settings.
- Actions include generate pending, generate selected, regenerate selected, confirm selected, play all, and build/rebuild master audio.
- Video composition remains locked until every segment is confirmed and the master timeline is ready.

### 视频合成

- AI creates scenes from the ready global word timeline.
- The left column lists scenes.
- Remotion Player uses the persisted master audio and validated render input.
- The bottom timeline shows scene intervals and one master-audio lane.
- Word-boundary scene edits immediately update preview data.
- Narration edits return the affected workflow to speech production; visual-only edits do not.

Autosave continues to persist project document edits. Durable job progress is polled or streamed separately and merged only when its generation revision remains current.

## Invalidation rules

| Change | Speech segment | Master audio | Word timeline | Video scenes |
|---|---|---|---|---|
| Display text, highlight, animation | unchanged | unchanged | unchanged | update only |
| Template visual property | unchanged | unchanged | unchanged | update only |
| Scene split, merge, boundary move | unchanged | unchanged | unchanged | update only |
| Narration text in one segment | affected segment returns to draft | stale | stale | recalibration required |
| Split or merge speech segments | affected segments return to draft unless exact hash reusable | stale | stale | recalibration required |
| Speech-segment reorder | segment assets reusable | stale | stale | recalibration required |
| Voice, model, speed, pitch, volume | all segments return to draft | stale | stale | recalibration required |
| Regenerate one segment | affected segment ready and unconfirmed | stale | stale | recalibration required |

## Failure and retry behavior

- TTS failure retries only the selected failed segment.
- Master assembly failure preserves every confirmed segment asset.
- Timeline failure preserves playable audio but keeps video composition locked.
- AI scene failure preserves audio and the existing valid scene plan, if any.
- Remotion render failure retries rendering only; it never regenerates speech or scenes.
- Missing referenced assets produce an explicit recovery error rather than fixture playback.
- A project or segment edited while a job runs rejects that stale job result through generation-revision and source-hash checks.

Every unavailable or failed action reports its real state. No control claims that audio, alignment, scenes, or video were produced before the corresponding artifact exists.

## API and job surface

The existing CRUD and autosave API remains authoritative for editable project documents. Production actions use explicit endpoints:

- `POST /api/text-videos/{id}/speech-split-preview`;
- `POST /api/text-videos/{id}/speech-segments/{segmentId}/generate`;
- `POST /api/text-videos/{id}/speech-segments/generate-pending`;
- `POST /api/text-videos/{id}/master-audio/build`;
- `POST /api/text-videos/{id}/scene-plan/generate`.

Each production endpoint validates the current project revision, returns a durable job identifier, and does not report completion synchronously. Read endpoints expose current speech, master-audio, alignment, and scene-plan states through the project document.

Manual split, merge, narration edits, and scene edits remain ordinary revision-checked project updates.

## Scope

Included in the next production milestone:

- persistent segmentation mode and expanded speech-segment state;
- default single-segment behavior;
- lossless AI split preview and manual split/merge;
- current MiMo V2.5 TTS adapter through a provider-neutral interface;
- single and pending speech-generation jobs;
- segment playback, regeneration, and confirmation;
- master-audio assembly and persistent asset storage;
- provider timing validation and forced-alignment fallback;
- AI word-boundary scene generation and recalibration;
- persisted Remotion preview input and workflow gates.

Excluded:

- voice cloning;
- freeform millisecond timeline editing;
- multitrack audio and music mixing;
- arbitrary keyframe editing;
- server-side MP4 rendering and publishing;
- project collaboration and revision history;
- automatic TTS spending immediately after AI split.

## Verification

### Domain and API tests

- A new non-empty script has exactly one speech segment.
- Single, AI, split, and merge flows preserve `join(text) === script`.
- Invalid AI boundaries cannot change the project.
- Existing project documents migrate safely.
- Revision conflicts remain fail-closed.
- Video stage and scene generation require confirmed speech plus a ready timeline.

### Job tests

- Generate-pending skips confirmed, generating, and reusable segments.
- A single-segment retry does not call TTS for any other segment.
- Stale generation results cannot overwrite edited text or settings.
- Master-audio source hashes make rebuilds idempotent.
- Assembly failure preserves confirmed segment assets.

### Timeline tests

- Local timings offset correctly into the master timeline.
- Invalid or absent provider timing selects forced alignment.
- Global words are ordered, non-overlapping, and inside the master duration.
- Scene proposals partition every word once and in order.
- Resolved scenes cover `[0, masterDuration]` continuously with no overlap.
- Regeneration recalibrates word boundaries instead of reusing stale seconds.

### Frontend and rendered tests

- Split preview requires explicit confirmation.
- Cursor split, adjacent merge, status changes, and invalidation are visible and autosaved.
- Generate, retry, confirm, build, and alignment controls show truthful job states.
- Remotion Player receives the same master audio and scene data intended for rendering.
- A refresh restores script, speech segments, confirmations, master audio, word timeline, and video scenes.
- Desktop and compact-width browser QA covers all three stages without side drawers, native prompts, console errors, or hidden primary actions.
