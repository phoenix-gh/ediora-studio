# YouTube Transcript Variants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collect the video's original-language transcript plus an available Chinese transcript, keep analysis on the original, and let users switch versions in a scrollable viewer.

**Architecture:** Existing transcript columns remain the canonical original version. New nullable JSON/string columns store the optional Chinese version, and the transcript API returns it as a nested object. Extraction selects the original language first and independently downloads Chinese captions; the frontend switches between already-loaded variants without further network calls.

**Tech Stack:** FastAPI, SQLAlchemy async, yt-dlp, pytest, Next.js/React, TypeScript, Vitest, Tailwind CSS.

## Global Constraints

- Existing transcript fields continue to mean the original version.
- Analysis and response handoff continue to consume only `transcript_text`.
- Chinese transcript failure must not fail a successful original transcript.
- Existing records and API responses without Chinese data remain readable.
- Transcript body scrolls independently inside the dialog.

---

### Task 1: Persist and expose optional Chinese transcript

**Files:**
- Modify: `backend/models.py`
- Modify: `backend/database.py`
- Modify: `backend/routers/youtube.py`
- Test: `backend/tests/test_youtube_router.py`

**Interfaces:**
- Produces model fields `transcript_zh_source`, `transcript_zh_language`, `transcript_zh_text`, `transcript_zh_segments`, `transcript_zh_content_hash`.
- Produces API field `chinese: {source, language, text, segments, content_hash} | null`.

- [ ] Write router/database tests proving old rows return `chinese: null` and populated rows return the nested version.
- [ ] Run the focused tests and confirm they fail because the fields are absent.
- [ ] Add SQLAlchemy fields and lightweight database migration columns with safe defaults.
- [ ] Extend the GET endpoint and extraction persistence without changing the original fields.
- [ ] Run focused tests and commit.

### Task 2: Extract original and Chinese caption variants

**Files:**
- Modify: `backend/youtube_transcript.py`
- Test: `backend/tests/test_youtube_transcript.py`

**Interfaces:**
- Produces `extract_youtube_transcript(...): {source, language, text, segments, content_hash, chinese?}`.
- Original selection uses metadata `language` then `original_language`; Chinese selection is independent and optional.

- [ ] Add failing tests for original-language priority over Chinese/English, dual extraction, Chinese-original deduplication, and optional Chinese failure.
- [ ] Run focused tests and confirm expected failures.
- [ ] Split caption selection into original and Chinese selectors while preserving manual-before-auto priority.
- [ ] Download each selected caption independently; keep audio transcription fallback for missing original.
- [ ] Return optional `chinese` without allowing its failure to discard a valid original.
- [ ] Run focused tests and commit.

### Task 3: Add transcript version switching and reliable scrolling

**Files:**
- Modify: `wemedia-studio/lib/api/youtube.ts`
- Modify: `wemedia-studio/lib/api/youtube.test.ts`
- Modify: `wemedia-studio/app/youtube/YoutubeTranscriptDialog.tsx`
- Modify: `wemedia-studio/app/youtube/YoutubeTranscriptDialog.test.tsx`

**Interfaces:**
- Consumes optional `YoutubeTranscript.chinese`.
- Viewer state is `original | chinese`; copy, metadata, segments, and empty state derive from the selected variant.

- [ ] Add failing client/component tests for optional Chinese parsing, default original view, switching, copying selected text, hidden switch without Chinese, and an `overflow-y-auto` bounded body.
- [ ] Run focused Vitest and confirm expected failures.
- [ ] Add the nested TypeScript type and a two-option segmented control shown only when Chinese exists.
- [ ] Replace the unreliable ScrollArea layout with a `min-h-0 flex-1 overflow-y-auto` body while keeping header/footer fixed.
- [ ] Run focused Vitest and ESLint, then commit.

### Task 4: Integrated verification and review

**Files:**
- Verify all files changed in Tasks 1-3.

- [ ] Run focused backend transcript/router tests with `/home/violet/miniconda3/envs/wems/bin/python -m pytest`.
- [ ] Run focused frontend Vitest tests and scoped ESLint.
- [ ] Run `git diff --check` and inspect the complete base-to-head diff.
- [ ] Request independent read-only code review and fix all Critical/Important findings.
- [ ] Re-run verification on the final commit and merge into `main` without disturbing unrelated user changes.
