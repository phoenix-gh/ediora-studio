# Task 8 Implementation Report

## Outcome

Task 8 connects the persisted text-video project to the production audio
workflow. The editor now serializes autosave flushes, launches and recovers
durable jobs, merges worker-owned state without discarding newer local or
cross-action state, and exposes truthful segment and master-audio controls.

AI speech splitting now flushes the editable project before opening a frozen
preview session. Preview polling uses the public jobs API, recursive timeouts,
and exact failed-step messages. Explicit multi-segment `auto` mode is persisted
by the backend; one-segment projects remain normalized to `single`.

The post-implementation review also closed cross-step races: starting a new
speech action now supersedes in-flight downstream master/scene/render actions,
and a delayed downstream response can no longer revive invalidated audio,
timeline, scene, render, or duration state.

## Main implementation

- Added three-way project merging by stable IDs, including monotonic
  worker-state handling for out-of-order action snapshots.
- Added invalidation-aware protection against reviving speech after
  text/voice edit-then-revert operations.
- Replaced best-effort autosave with a shared serialized `flush()` loop that
  saves edits arriving during an in-flight request and rejects failures.
- Added a production action coordinator with:
  - same-key single-flight;
  - per-action merge baselines;
  - one exact idempotent replay only after an unchanged authoritative read;
  - request-specific recovery proof for speech, master, and scene actions;
  - fail-closed unknown outcomes and typed HTTP classification;
  - fail-closed recovery when a fast failure has no durable job/step identity;
  - continued polling of known active batch jobs before reporting an
    unidentifiable sibling failure;
  - dependency-aware supersession from speech to master/scene/render and from
    master/scene to their downstream actions;
  - terminal job error/retryability reporting;
  - StrictMode-safe reload recovery;
  - recursive 1.5-second polling and unmount cancellation.
- Replaced the fixture audio panel with stable-ID production segment cards,
  real audio players, controlled voice settings, and real generation,
  confirmation, master-build, playback, and realignment controls.
- Made speech generation/confirmation and master generation/realignment
  mutually exclusive in both the UI and action coordinator.
- Wired the editor to speech generation, confirmation, master build, and
  `align_master_timeline` retry APIs.
- Added typed public API errors so job polling can distinguish 404, conflict,
  retryable server failures, and no-response transport failures.
- Treats a succeeded split-preview job without a valid
  `propose_boundaries` payload as an immediate visible terminal error instead
  of polling forever.

## TDD evidence

The implementation was driven by focused failing tests for:

- serialized autosave and edits arriving during save;
- text/voice edit-then-revert invalidation;
- split-mode-only edits;
- visual scene edits preserving server job metadata;
- out-of-order cross-key worker snapshots;
- delayed master responses arriving after speech regeneration, including
  downstream scene/render preservation;
- same-revision speech progress from generating to a terminal worker state;
- same-key launch single-flight;
- StrictMode recovery;
- ambiguous launch replay, committed ready/failed proof, 409 refresh, and job
  404 fail-closed behavior;
- fast failures without durable retry metadata and mixed failed/active batch
  recovery;
- real media URLs, truthful audio states, voice controls, confirmation races,
  speakable-only master gating, master retry behavior, and speech/master
  concurrency interlocks;
- frozen split-preview sessions, exact durable-step failures, and malformed
  succeeded-job terminal handling.

## Verification

- Frontend unit/integration suite: `pnpm test` — 91 files, 487 tests passed
  in the final pre-commit rerun.
- Backend focused suite:
  `/home/violet/miniconda3/envs/wems/bin/python -m pytest
  tests/test_text_video_domain.py tests/test_text_videos_router.py -q` —
  52 passed.
- ESLint: `pnpm exec eslint . --quiet` — passed.
- TypeScript: `pnpm exec tsc --noEmit` — passed after correcting one
  test-only self-referential annotation.
- Production build: `pnpm build` — passed on Next.js 16.2.4.
- Patch hygiene: `git diff --check` — passed.

All listed gates were rerun after the final recovery and test-harness fixes.
