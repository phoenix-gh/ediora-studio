# Local Whisper Shared ASR Design

## Goal

Add one GPU-backed local speech-recognition service that supplies durable
transcription to both:

- text-video master-audio alignment; and
- YouTube audio fallback when no usable platform caption exists.

The first release runs on the existing NVIDIA GeForce RTX 5060 Ti 16 GB host.
It uses Speaches as an isolated OpenAI-compatible server backed by
`faster-whisper`, with `large-v3`, CUDA, and `float16` as the production
defaults.

Runtime validation on the target RTX 5060 Ti showed that Speaches 0.8.3 pins
CTranslate2 4.5.0, whose INT8 mixed-precision word-alignment path fails on
Blackwell with `CUBLAS_STATUS_NOT_SUPPORTED`. The production default therefore
uses `float16`; the same 28-second project audio completed word alignment with
the audio asset unchanged.

Local transcription must not require an API key, must not silently fall back to
a paid cloud provider, and must preserve the existing ability to retry only the
failed transcription or alignment step.

## Relationship to existing designs

This specification extends:

- `2026-07-29-text-video-audio-timeline-design.md`;
- `2026-07-26-unified-content-response-video-analysis-design.md`.

The text-video master audio remains the timing authority. The existing
application alignment step remains responsible for matching recognized words
back to exact script slices and enforcing its 85% minimum coverage. Local
Whisper replaces the remote word-transcription dependency; it does not move
timing authority into Remotion.

YouTube extraction keeps its caption-first policy. Local Whisper is only the
fallback after the configured Chinese-first and English-second platform-caption
selection has found no usable caption.

## Product decisions

1. Local Whisper is a shared platform capability, not a text-video-only
   implementation.
2. Speaches runs as a separate GPU-enabled Docker service. The API process never
   loads Whisper model weights.
3. The production model is fixed to `large-v3` in the first release.
4. The production compute type is `float16`, with one active local ASR
   request at a time.
5. The default recognition language is automatic. Callers may provide a
   language hint when the source is already known.
6. Word timestamps and VAD are enabled.
7. Local model data is stored in a persistent Docker volume.
8. The ASR service is reachable only on the Compose network and exposes no host
   port by default.
9. A local failure is visible and retryable. It never triggers an implicit
   cloud request.
10. Existing valid YouTube transcripts are reused and are not retranscribed.

## Why Speaches and faster-whisper

Speaches provides an OpenAI-compatible HTTP boundary, GPU and Docker support,
dynamic model loading, and a `faster-whisper` speech-to-text implementation.
Keeping that boundary outside the application makes the model independently
restartable and prevents inference from blocking or inflating the Python API
process: [Speaches](https://github.com/speaches-ai/speaches).

`faster-whisper` exposes word-level timestamps, VAD, CUDA execution, and reduced
memory modes. Its published implementation and examples support the required
`word_timestamps=True` behavior and CUDA 12/cuDNN 9 runtime:
[faster-whisper](https://github.com/SYSTRAN/faster-whisper).

WhisperX is not part of the first release. It remains an optional later
forced-alignment stage if measured word-boundary accuracy on clean MiMo TTS
audio is insufficient. It must not be introduced without an actual benchmark
showing a need.

## Runtime architecture

```text
text-video alignment job ─┐
                          ├─> shared transcription adapter
YouTube audio fallback ───┘              │
                                         │ OpenAI-compatible HTTP
                                         v
                              local-asr Speaches service
                                         │
                                         v
                           faster-whisper large-v3 on CUDA
                                         │
                                         v
                        canonical transcript + segments + words
```

The application uploads audio bytes over the internal Compose network. The ASR
service does not mount the application's uploads volume and cannot mutate media
assets.

The Compose service includes:

- NVIDIA GPU device access;
- a persistent model-cache volume;
- an internal health check;
- a pinned Speaches image version;
- no public `ports` mapping; and
- restart behavior consistent with the existing API and worker services.

The application API does not hard-depend on ASR health during startup. Other
features remain available when local ASR is down. Transcription requests fail
with an explicit retryable service error.

## Shared provider boundary

The two current HTTP implementations in `text_video_transcription.py` and
`youtube_transcript.py` are consolidated behind one provider-neutral
transcription service. Callers retain their domain-specific orchestration but
do not build provider requests themselves.

The shared request is conceptually:

```python
class TranscriptionRequest:
    audio_path: Path
    duration: float
    require_word_timestamps: bool
    language_hint: str | None
```

The canonical result is:

```python
class TranscriptWord:
    text: str
    start: float
    end: float

class TranscriptSegment:
    text: str
    start: float
    end: float

class TranscriptionResult:
    language: str
    text: str
    segments: tuple[TranscriptSegment, ...]
    words: tuple[TranscriptWord, ...]
```

Provider response parsing normalizes `word` or `text` source fields into the
canonical `text` field. Every timestamp must be finite, non-negative, ordered,
and bounded by decoded audio duration. Invalid provider data is rejected before
it reaches text-video or YouTube persistence.

The provider implementations are:

- `local-whisper`: known internal service address, no user API key;
- `openai-compatible`: configured base URL, model, and API key.

The internal ASR URL is deployment configuration, not user content stored in
the application database. The settings response never exposes an internal
credential because local ASR has none.

## Local request behavior

Local requests use the OpenAI-compatible audio-transcription endpoint with:

- `response_format=verbose_json`;
- word timestamp granularity;
- model `large-v3`;
- VAD enabled where supported by the server; and
- an optional ISO language hint.

The adapter tolerates compatible response differences only at its boundary. It
accepts words at the documented top level or reconstructs the canonical word
list from timestamped segment words. It never estimates an entire missing word
timeline from character count.

A small number of individually unaligned words may be interpolated later by the
existing exact-script alignment algorithm using neighboring boundaries. A
response with no usable word timings is invalid for text-video alignment.
YouTube may persist timestamped segments without words, because its original
content record does not require per-word animation timing.

The request timeout is derived from audio duration and is longer than the
current fixed cloud timeout, while remaining bounded. A client timeout or
connection failure is retryable. Invalid audio and structurally invalid
responses are not retried blindly.

## GPU concurrency and lifecycle

Only one local transcription may execute at a time across text-video and
YouTube jobs. Serialization is enforced in application infrastructure rather
than assumed from the number of API processes.

Waiting work remains in a truthful queued or waiting-for-ASR state. It must not
occupy the GPU lease while downloading source audio, validating files, or
performing post-transcription script matching.

The GPU lease has:

- a bounded acquisition wait;
- ownership identity tied to the content job step;
- periodic renewal while inference is active; and
- expiry recovery if a worker or API process exits unexpectedly.

The first request may download and load the model. The persisted cache prevents
repeat downloads after container restarts. When supported by the pinned
Speaches version, the model is preloaded or warmed after service health is
established. The UI reports a truthful coarse state such as `preparing model`
instead of fabricating a percentage when the server does not expose download
progress.

After the model is cached, normal transcription must continue without Internet
access. A deliberate model update remains an administrator deployment action,
not an ordinary editor action.

## Text-video flow

The text-video flow becomes:

1. Reuse the confirmed single-segment audio or assemble confirmed segment audio
   into the canonical master.
2. Enqueue or continue only `align_master_timeline`.
3. Acquire the local ASR GPU lease.
4. Transcribe the master with word timestamps.
5. Release the GPU lease.
6. Validate and normalize recognized words.
7. Match those words against the exact project script using the existing
   alignment algorithm.
8. Require at least the existing 85% script coverage and persist the global word
   timeline.
9. Make the validated timeline available to AI scene direction and Remotion.

Retrying alignment never regenerates or re-encodes confirmed TTS audio. A stale
project or generation revision still prevents late transcription results from
overwriting newer project state.

## YouTube flow

YouTube extraction keeps this strict order:

1. usable Chinese platform caption;
2. usable English platform caption;
3. local Whisper audio fallback.

Before audio download or local transcription, the video record is checked for a
successful transcript with a stable content hash. A valid existing transcript
is returned without creating a new ASR task.

The local result is converted into the existing YouTube transcript structure:

- `source=whisper`;
- detected language;
- complete normalized text;
- ordered timestamped segments;
- stable transcript content hash; and
- fetched timestamp and cleared error state.

Failures preserve the existing video record, record an explicit error code and
safe message, and allow the user to retry that video's transcript task. Other
video analysis does not pretend a transcript exists.

## Settings and status UI

The speech-transcription settings section exposes:

- provider: `Local Whisper` or `OpenAI-compatible service`;
- local service status;
- active local model;
- runtime device summary;
- a test-transcription action; and
- collapsed advanced fields for language mode, compute type, and VAD.

When `Local Whisper` is selected:

- Base URL and API Key inputs are hidden;
- model is displayed as the fixed first-release `large-v3`;
- compute type is displayed as `float16`;
- status may be `unavailable`, `preparing`, `ready`, `busy`, or `error`; and
- the test action sends a bundled short, non-sensitive audio fixture through the
  same transcription path used by production.

The settings page does not show a model deletion or redownload button in the
first release. Corrupting or replacing a multi-gigabyte shared model cache is an
administrator operation with deployment impact.

Text-video project jobs expose:

```text
waiting for transcription
→ transcribing
→ matching script
→ timeline ready
```

When applicable, preparation is shown as `preparing local model`. YouTube
transcript tasks use equivalent truthful states without exposing text-video
terminology.

## Error taxonomy

| Condition | Retryable | User-facing behavior |
| --- | --- | --- |
| ASR service unavailable | Yes | Keep the failed step and offer transcript-only retry |
| Model preparing within expected window | Wait | Keep the task waiting; do not report failure |
| Model download or load failure | Yes | Report local model preparation failure |
| GPU out of memory | No automatic retry | Ask the user to free GPU memory, then retry manually |
| GPU lease wait timeout | Yes | Return task to a retryable waiting failure |
| Audio missing or unreadable | No | Preserve project/video data and identify the missing input |
| Audio exceeds configured safety limit | No | State the exact duration or size limit |
| Provider response has invalid timestamps | No | Reject the response; never persist a fabricated timeline |
| Text-video script coverage below 85% | No automatic retry | Preserve recognized words and report audio/script mismatch |
| Stale project revision | No | Discard the stale result without overwriting new state |

Secrets, internal stack traces, absolute host paths, and full upstream response
bodies are never returned to the browser.

## First-release scope

Included:

- GPU-enabled local Speaches service in Compose;
- persistent model cache;
- shared local/cloud transcription adapter;
- local-provider settings and health/test behavior;
- word timestamps for text-video alignment;
- YouTube caption-first local-audio fallback;
- cross-feature local ASR serialization;
- task-specific retries and explicit error states;
- backend, frontend, runtime, and browser verification.

Excluded:

- speaker diarization;
- live or streaming transcription;
- arbitrary model selection;
- automatic cloud fallback;
- WhisperX forced alignment;
- transcript editing UI;
- automatic model deletion or redownload;
- using local Whisper for unrelated media assets before a product workflow
  requires it.

## Verification

### Provider contract

- Unit tests normalize valid Speaches verbose JSON into canonical text,
  segments, and words.
- Tests reject negative, non-finite, reversed, overlapping, and out-of-duration
  timestamps.
- Tests verify that local mode requires no API key and never calls the
  configured cloud URL.
- Tests verify that cloud mode retains its existing URL, key, retry, and
  validation semantics.

### Text video

- A clean Chinese MiMo TTS fixture produces a monotonic word timeline bounded by
  audio duration.
- Exact-script matching retains the existing 85% hard gate and targets at least
  95% coverage on the representative clean TTS fixture set.
- Single-segment projects do not rebuild audio before retrying alignment.
- Concurrent retries share one active inference and stale results cannot
  overwrite a newer project revision.

### YouTube

- Chinese captions remain preferred over English captions.
- English captions remain preferred over local transcription when Chinese is
  absent.
- Local Whisper is invoked only when neither usable caption exists.
- Existing successful transcript records are reused without a second download
  or ASR request.
- Local results persist source, language, text, timestamped segments, content
  hash, and fetched time.

### Runtime

- The ASR service sees the RTX 5060 Ti and successfully runs `large-v3` with
  `float16`.
- Peak ASR model usage fits the 16 GB GPU while the normal desktop workload is
  present.
- Two simultaneous application requests produce only one active GPU inference.
- Restarting the ASR container reuses its model cache.
- After initial model preparation, a representative transcription succeeds
  with external network access disabled.
- An unavailable ASR service does not prevent API, web, worker, PostgreSQL, or
  Redis startup.

### Product QA

- Settings accurately switch between local and OpenAI-compatible providers.
- Local mode hides cloud credentials and reports real service state.
- The test action exercises a real short local transcription.
- A text-video project can generate its timeline and retry only alignment after
  a forced ASR failure.
- A YouTube video without captions can be manually transcribed and then reused
  without duplicate work.
- Browser console and service logs contain no leaked credential or host path.
