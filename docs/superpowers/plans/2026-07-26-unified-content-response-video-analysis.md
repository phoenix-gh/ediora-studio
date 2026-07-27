# Unified Content Response and YouTube Analysis Implementation Plan

> **Required subskill:** Use `superpowers:executing-plans` to implement this plan task by task. Use `superpowers:test-driven-development` for every behavior change and `superpowers:verification-before-completion` before claiming completion.

**Goal:** Deliver a unified `/responses` workbench where every subscribed YouTube video can be manually or automatically transcribed, evaluated, matched against all active publishing accounts, and turned into editable article/commentary/X-share outputs while preserving existing X response and Telegram behavior.

**Architecture:** Keep source records in `x_posts` and `youtube_videos`, and add a source-neutral response domain made of response items, versioned analyses, per-account scores, outputs, notifications, and audit events. The Python API owns durable persistence and media extraction (`yt-dlp`, `ffmpeg`, Whisper-compatible transcription); the Node content worker owns AI SDK orchestration and structured generation. Jobs remain Redis-backed `ContentJob` flows and all worker-only APIs use `WMS_WORKER_TOKEN`.

**Tech stack:** FastAPI, async SQLAlchemy, PostgreSQL/SQLite test database, Redis jobs, Next.js 16, React 19, TypeScript, AI SDK 7, Zod 4, Vitest, pytest, `yt-dlp`, `ffmpeg`.

**Global constraints:**

- Existing YouTube channels migrate with auto-analysis off; newly added channels default it on.
- Enabling auto-analysis never backfills existing videos. Only videos inserted after `analysis_enabled_at` are automatically queued.
- Every completed analysis, including low-value content, enters the unified inbox.
- Original-language transcript is persisted. Chinese analysis is automatic; full Chinese transcript translation remains on demand and is not part of this release.
- Caption priority is manual/native, then automatic captions, then audio-only Whisper fallback.
- Score intrinsic content value separately from fit against every active publishing account.
- No frame extraction, OCR, visual understanding, batch backfill, model self-training, or automatic publishing.
- Preserve existing X immediate/digest Telegram semantics through the unified models.
- Do not modify or stage `.superpowers/brainstorm/`.

---

### Task 1: Add the unified persistence model and idempotent schema migration

**Files:**

- Modify: `backend/models.py`
- Modify: `backend/database.py`
- Create: `backend/tests/test_content_response_models.py`
- Create: `backend/tests/test_database_content_response_migration.py`
- Modify: `backend/tests/test_models_schema.py`

**Step 1: Write failing model tests**

Cover:

- `YoutubeChannel.auto_analyze_new_videos` defaults to false at database-model level and has nullable `analysis_enabled_at`.
- `YoutubeVideo` stores transcript status/source/language/text/segments/hash/timestamps/errors.
- A `(source_type, source_id)` pair has one `ContentResponseItem`.
- One response item supports multiple `ContentAnalysisRun` versions, multiple `ContentAccountScore` rows, multiple `ContentResponseOutput` rows, notifications, and events.
- JSON columns default to independent empty collections.

Run:

```bash
cd backend && pytest -q tests/test_content_response_models.py tests/test_models_schema.py
```

Expected: FAIL because the new classes and fields do not exist.

**Step 2: Implement SQLAlchemy models**

Add:

- `ContentResponseItem`
- `ContentAnalysisRun`
- `ContentAccountScore`
- `ContentResponseOutput`
- `ContentResponseNotification`
- `ContentResponseEvent`

Use explicit indexed foreign keys, unique constraints for source identity and analysis-version/account identity, UTC timestamps, and existing JSON helpers. Add the YouTube channel/video fields from the design spec.

**Step 3: Write failing migration tests**

Create a legacy SQLite schema containing YouTube and X response tables, run the migration twice, and assert:

- all columns/tables/indexes exist;
- legacy channels remain disabled;
- existing X decisions migrate exactly once;
- X analysis fields, drafts, Telegram state, and current-analysis links are preserved;
- rollback leaves legacy rows intact if copy validation fails.

Run:

```bash
cd backend && pytest -q tests/test_database_content_response_migration.py
```

Expected: FAIL because the migration does not exist.

**Step 4: Implement migration**

Add one idempotent `migrate_content_response_schema()` called by `init_db()` after `Base.metadata.create_all()`. It must:

- add YouTube fields without changing existing rows to auto-enabled;
- copy `x_response_decisions` into unified tables inside one transaction;
- use deterministic source/output/notification identities so reruns do not duplicate;
- validate unique tweet count, draft count, and notification count before completing;
- retain the legacy table during this task as a rollback source, but make the unified tables authoritative in later tasks.

**Step 5: Verify and commit**

```bash
cd backend && pytest -q tests/test_content_response_models.py tests/test_database_content_response_migration.py tests/test_models_schema.py tests/test_database_x_response_migration.py
git add backend/models.py backend/database.py backend/tests/test_content_response_models.py backend/tests/test_database_content_response_migration.py backend/tests/test_models_schema.py
git commit -m "feat: add unified content response schema"
```

---

### Task 2: Build the unified response domain service and API

**Files:**

- Create: `backend/content_response_service.py`
- Create: `backend/routers/responses.py`
- Modify: `backend/main.py`
- Modify: `backend/worker_auth.py`
- Create: `backend/tests/test_content_response_service.py`
- Create: `backend/tests/test_responses_router.py`

**Step 1: Write failing service tests**

Cover:

- `ensure_response_item()` is idempotent per source;
- `create_analysis_run()` creates one active run/job for repeated clicks;
- explicit reanalysis creates a new version on the same item;
- low-score analyses still set the item to `ready`;
- all active accounts are included and taboo-conflicted accounts cannot be recommended;
- decisions `adopt`, `later`, and `not_valuable` persist optional reason and an audit event;
- selecting an earlier analysis updates `current_analysis_run_id` and logs an event.

Run:

```bash
cd backend && pytest -q tests/test_content_response_service.py
```

Expected: FAIL because the service does not exist.

**Step 2: Implement the domain service**

Keep state transitions and validation in `content_response_service.py`, not in routers. Reuse `create_job(commit=False)` so item, analysis run, job, and initial event commit atomically before queue dispatch.

**Step 3: Write failing API tests**

Test:

- `GET /api/responses` pagination, source/status/min-score/account/search/sort filters;
- list payload excludes full transcript;
- detail, events, analyses, and account scores;
- decision save and undo;
- analyze/retry idempotency;
- worker context/persist endpoints reject missing or bad worker token;
- worker persistence schema rejects incomplete value dimensions and account scores.

Run:

```bash
cd backend && pytest -q tests/test_responses_router.py
```

Expected: FAIL because the router is not mounted.

**Step 4: Implement and mount the API**

Implement the routes in design section 9.1 and worker-only routes in 9.3. Return stable DTOs with `source` metadata resolved from `XPost` or `YoutubeVideo`, current analysis summary, status, account recommendation, output counts, and active job.

**Step 5: Verify and commit**

```bash
cd backend && pytest -q tests/test_content_response_service.py tests/test_responses_router.py tests/test_jobs_router.py
git add backend/content_response_service.py backend/routers/responses.py backend/main.py backend/worker_auth.py backend/tests/test_content_response_service.py backend/tests/test_responses_router.py
git commit -m "feat: add unified response service and api"
```

---

### Task 3: Add secure YouTube transcript extraction and Whisper runtime

**Files:**

- Create: `backend/youtube_transcript.py`
- Modify: `backend/config.py`
- Modify: `backend/routers/settings.py`
- Modify: `backend/requirements.txt`
- Modify: `backend/Dockerfile`
- Create: `backend/tests/test_youtube_transcript.py`
- Create: `backend/tests/test_transcription_settings.py`

**Step 1: Write failing parser and extraction-policy tests**

Fixtures cover manual and automatic VTT metadata, rolling YouTube captions, tags/entities, repeated cue text, language preservation, and no-caption metadata.

Assert:

- manual captions beat auto captions;
- auto captions beat Whisper;
- usable captions never invoke audio download;
- fallback invokes audio-only download and the configured transcription client;
- output is normalized to `{start, end, text}`;
- rolling duplicates collapse without losing new words;
- a stable content hash is produced.

Also test rejection of non-HTTP URLs, non-YouTube hosts, loopback/private resolved addresses, redirects to private networks, excessive duration/audio size, command timeout, and cleanup on success/failure.

Run:

```bash
cd backend && pytest -q tests/test_youtube_transcript.py
```

Expected: FAIL because the extractor does not exist.

**Step 2: Implement the transcript domain service**

Use `asyncio.create_subprocess_exec` with argv arrays and a per-job temporary directory. First query metadata/captions; download only the selected VTT. If absent, download mono compressed audio with duration/byte limits, then call an OpenAI-compatible `/audio/transcriptions` endpoint with `httpx`. Never accept a request-supplied path or URL; the service receives a persisted `YoutubeVideo`.

**Step 3: Write failing settings tests**

Add independent keys:

- `transcription_provider`
- `transcription_model`
- `transcription_base_url`
- `transcription_api_key`
- `transcription_max_duration_seconds`
- `transcription_max_audio_bytes`

Test masked read, preserve-on-blank update, explicit clear, worker-only runtime response, and connection test without exposing secrets.

Run:

```bash
cd backend && pytest -q tests/test_transcription_settings.py
```

Expected: FAIL before settings implementation.

**Step 4: Implement settings and container dependencies**

Expose public masked settings plus worker-token-protected `/api/settings/transcription-runtime`. Install `yt-dlp` through Python requirements and `ffmpeg` through apt in `backend/Dockerfile`; keep the Node image unchanged.

**Step 5: Verify and commit**

```bash
cd backend && pytest -q tests/test_youtube_transcript.py tests/test_transcription_settings.py tests/test_runtime_config.py
git add backend/youtube_transcript.py backend/config.py backend/routers/settings.py backend/requirements.txt backend/Dockerfile backend/tests/test_youtube_transcript.py backend/tests/test_transcription_settings.py
git commit -m "feat: add secure youtube transcript extraction"
```

---

### Task 4: Wire YouTube channel policy and video analysis triggers

**Files:**

- Modify: `backend/routers/youtube.py`
- Modify: `backend/youtube_collector.py`
- Modify: `backend/content_response_service.py`
- Create: `backend/tests/test_youtube_analysis_triggers.py`
- Create: `backend/tests/test_youtube_collector.py`

**Step 1: Write failing trigger tests**

Cover:

- existing channels stay off after migration;
- newly subscribed channels default on and get `analysis_enabled_at`;
- enabling a channel does not enqueue existing videos;
- only newly inserted videos at/after the enable timestamp enqueue;
- metadata/view-count updates do not enqueue;
- manual analysis works for historical videos;
- repeated manual clicks reuse the active job;
- reanalysis creates a new analysis version;
- transcript retry reuses successful transcript and only retries failed extraction.

Run:

```bash
cd backend && pytest -q tests/test_youtube_analysis_triggers.py
```

Expected: FAIL because trigger policy and endpoints are absent.

**Step 2: Implement collector and API wiring**

Extend channel PATCH; add:

- `POST /api/youtube/videos/{id}/analyze`
- `GET /api/youtube/videos/{id}/transcript`
- `POST /api/youtube/videos/{id}/transcript/retry`

Return item/job identifiers and compact transcript/analysis status in video list DTOs. Queue only after the database transaction succeeds and record dispatch audit events.

**Step 3: Verify and commit**

```bash
cd backend && pytest -q tests/test_youtube_analysis_triggers.py tests/test_content_response_service.py
git add backend/routers/youtube.py backend/youtube_collector.py backend/content_response_service.py backend/tests/test_youtube_analysis_triggers.py backend/tests/test_youtube_collector.py
git commit -m "feat: trigger youtube response analysis"
```

---

### Task 5: Implement AI analysis and output-generation worker flows

**Files:**

- Create: `wemedia-studio/lib/ai/content-response-schema.ts`
- Create: `wemedia-studio/lib/ai/content-response-job.ts`
- Create: `wemedia-studio/lib/ai/content-response-output-job.ts`
- Modify: `wemedia-studio/scripts/content-worker.ts`
- Modify: `wemedia-studio/lib/ai/job-client.ts`
- Create: `wemedia-studio/lib/ai/content-response-job.test.ts`
- Create: `wemedia-studio/lib/ai/content-response-output-job.test.ts`

**Step 1: Read the local Next.js/API guide relevant to worker TypeScript**

Read only the applicable files under `wemedia-studio/node_modules/next/dist/docs/` before editing Next.js code, as required by `wemedia-studio/AGENTS.md`.

**Step 2: Write failing schema and orchestration tests**

The analysis schema requires:

- five named value dimensions and total score;
- Chinese summary, core ideas, evidence-tagged claims, risks, value recommendation;
- recommended formats and value points;
- account score for every active account with fit reasons/taboo conflicts;
- recommended account only when no hard conflict exists.

Test one controlled JSON repair attempt, low-value persistence, no-account completion, partial retry from failed account scoring, sanitized error reporting, and worker-token headers.

Run:

```bash
cd wemedia-studio && pnpm test -- lib/ai/content-response-job.test.ts
```

Expected: FAIL because the worker flow does not exist.

**Step 3: Implement `content_response_analysis`**

Use durable steps:

1. `prepare_source`
2. `extract_content`
3. `analyze_value`
4. `score_accounts`
5. `persist_response`

The extraction step calls the protected Python API, which performs subtitle/audio work and persists the transcript. AI prompts consume the original transcript and return Chinese structured analysis. Persist only schema-validated data.

**Step 4: Write failing output tests**

Test independent jobs for:

- `expanded_article`
- `commentary`
- `x_share`
- migrated X `x_reply`
- migrated X `x_quote`

Article/commentary results must create one idempotent `ArticleDraft`; X results stay editable in `ContentResponseOutput.content`. No flow calls publish endpoints.

**Step 5: Implement `content_response_output` and worker dispatch**

Use steps:

1. `prepare_output_context`
2. `generate_output`
3. `save_output`

Add dispatch branches for both new flows while preserving digital-human and digest branches.

**Step 6: Verify and commit**

```bash
cd wemedia-studio && pnpm test -- lib/ai/content-response-job.test.ts lib/ai/content-response-output-job.test.ts lib/ai/x-response-job.test.ts
git add wemedia-studio/lib/ai/content-response-schema.ts wemedia-studio/lib/ai/content-response-job.ts wemedia-studio/lib/ai/content-response-output-job.ts wemedia-studio/scripts/content-worker.ts wemedia-studio/lib/ai/job-client.ts wemedia-studio/lib/ai/content-response-job.test.ts wemedia-studio/lib/ai/content-response-output-job.test.ts
git commit -m "feat: analyze and expand unified response content"
```

---

### Task 6: Switch X analysis and Telegram compatibility to unified storage

**Files:**

- Modify: `backend/x_response_service.py`
- Modify: `backend/routers/x_responses.py`
- Modify: `wemedia-studio/lib/ai/x-response-job.ts`
- Modify: `backend/tests/test_x_response_service.py`
- Modify: `backend/tests/test_x_responses_router.py`
- Modify: `backend/tests/test_x_response_end_to_end.py`
- Modify: `wemedia-studio/lib/ai/x-response-job.test.ts`

**Step 1: Write failing compatibility tests**

Assert:

- X collection creates a unified item/run/job;
- X worker analysis persists a unified run plus `x_reply`/`x_quote` outputs;
- existing `/api/x/responses` reads unified models in its legacy DTO shape;
- feedback and Telegram claim/send/digest mutate unified item/notification rows only;
- migrated source count, drafts, Telegram message IDs, and workflow status match legacy data;
- no code path inserts or updates `x_response_decisions`.

Run:

```bash
cd backend && pytest -q tests/test_x_response_service.py tests/test_x_responses_router.py tests/test_x_response_end_to_end.py
```

Expected: FAIL until compatibility is switched.

**Step 2: Implement unified X adapter**

Keep X eligibility, link verification, notification thresholds, retryability headers, and digest schedule. Replace the persistence target with the unified response service and notification model. The old table remains read-only only for migration verification.

**Step 3: Update worker calls**

Route X structured analysis through unified worker persistence while preserving X-specific action schema and link-verification policy.

**Step 4: Verify and commit**

```bash
cd backend && pytest -q tests/test_x_response_service.py tests/test_x_responses_router.py tests/test_x_response_end_to_end.py tests/test_x_notify_scout.py tests/test_telegram_notifier.py
cd ../wemedia-studio && pnpm test -- lib/ai/x-response-job.test.ts lib/api/x-responses.test.ts
git add backend/x_response_service.py backend/routers/x_responses.py backend/tests/test_x_response_service.py backend/tests/test_x_responses_router.py backend/tests/test_x_response_end_to_end.py wemedia-studio/lib/ai/x-response-job.ts wemedia-studio/lib/ai/x-response-job.test.ts
git commit -m "refactor: move x responses to unified storage"
```

---

### Task 7: Build the unified `/responses` split-pane workbench

**Files:**

- Create: `wemedia-studio/lib/api/responses.ts`
- Create: `wemedia-studio/lib/api/responses.test.ts`
- Create: `wemedia-studio/app/responses/page.tsx`
- Create: `wemedia-studio/app/responses/ResponsesClient.tsx`
- Create: `wemedia-studio/app/responses/responses-layout.test.tsx`
- Modify: `wemedia-studio/app/x-responses/page.tsx`
- Modify: `wemedia-studio/components/features/Sidebar.tsx`
- Modify: `wemedia-studio/app/globals.css`

**Step 1: Read applicable Next.js 16 guides**

Read the local App Router, server/client component, redirect, and data-fetching guides under `node_modules/next/dist/docs/` before implementation.

**Step 2: Write failing API-client and layout tests**

Test typed query encoding, detail lazy loading, decision/output mutations, `/x-responses` redirect, and sidebar link. Render tests must cover:

- source/status/search filters;
- middle list showing both X and YouTube;
- right detail tabs: overview, transcript, account fit, history;
- transcript fetched only when its tab opens;
- adopt/later/not-valuable actions with optional reason;
- output selector preselecting AI recommendation while allowing account and multi-format changes;
- per-output job status;
- accessible empty/loading/error states and narrow-screen stacking.

Run:

```bash
cd wemedia-studio && pnpm test -- lib/api/responses.test.ts app/responses/responses-layout.test.tsx
```

Expected: FAIL because the route and client do not exist.

**Step 3: Implement the workbench**

Use the approved three-column layout:

- left: source/status/account filters and counts;
- middle: prioritized response cards;
- right: tabbed detail and creation actions.

Keep full transcript out of initial server payload. Mutations update local state or refetch the affected item; they do not publish.

**Step 4: Verify and commit**

```bash
cd wemedia-studio && pnpm test -- lib/api/responses.test.ts app/responses/responses-layout.test.tsx app/x-responses/x-responses-layout.test.tsx
git add wemedia-studio/lib/api/responses.ts wemedia-studio/lib/api/responses.test.ts wemedia-studio/app/responses wemedia-studio/app/x-responses/page.tsx wemedia-studio/components/features/Sidebar.tsx wemedia-studio/app/globals.css
git commit -m "feat: add unified response workbench"
```

---

### Task 8: Add YouTube controls and transcription settings UI

**Files:**

- Modify: `wemedia-studio/lib/api/youtube.ts`
- Modify: `wemedia-studio/lib/api/settings.ts`
- Modify: `wemedia-studio/lib/api/settings-test-fixtures.ts`
- Modify: `wemedia-studio/app/youtube/YoutubeClient.tsx`
- Create: `wemedia-studio/app/youtube/youtube-analysis.test.tsx`
- Create: `wemedia-studio/app/settings/sections/TranscriptionSection.tsx`
- Modify: `wemedia-studio/app/settings/SettingsClient.tsx`
- Create: `wemedia-studio/app/settings/sections/TranscriptionSection.test.tsx`

**Step 1: Write failing UI tests**

Cover:

- channel auto-analysis switch and precise “only future videos” explanatory text;
- existing video card actions for analyze/view/reanalyze/retry;
- compact transcript/analysis/job states;
- no bulk-backfill control;
- settings fields are independent from chat model fields;
- API key masking, blank-preserve, clear, save, and connectivity test.

Run:

```bash
cd wemedia-studio && pnpm test -- app/youtube/youtube-analysis.test.tsx app/settings/sections/TranscriptionSection.test.tsx
```

Expected: FAIL before UI implementation.

**Step 2: Implement API types and UI**

Update DTOs and mutations. Channel toggle updates only the selected channel. Video action status survives list refresh by using backend state. “查看分析” navigates to `/responses` with the response item selected.

**Step 3: Verify and commit**

```bash
cd wemedia-studio && pnpm test -- app/youtube/youtube-analysis.test.tsx app/settings/sections/TranscriptionSection.test.tsx lib/api/settings-telegram.test.ts
git add wemedia-studio/lib/api/youtube.ts wemedia-studio/lib/api/settings.ts wemedia-studio/lib/api/settings-test-fixtures.ts wemedia-studio/app/youtube/YoutubeClient.tsx wemedia-studio/app/youtube/youtube-analysis.test.tsx wemedia-studio/app/settings/sections/TranscriptionSection.tsx wemedia-studio/app/settings/SettingsClient.tsx wemedia-studio/app/settings/sections/TranscriptionSection.test.tsx
git commit -m "feat: add youtube analysis controls"
```

---

### Task 9: Remove legacy writes, verify migration, and run full acceptance

**Files:**

- Modify: `backend/models.py`
- Modify: `backend/database.py`
- Modify: `backend/tests/test_database_content_response_migration.py`
- Modify: `docs/superpowers/specs/2026-07-26-unified-content-response-video-analysis-design.md` only if implementation evidence requires a factual correction

**Step 1: Prove no legacy writers remain**

```bash
rg -n "XResponseDecision\\(|update\\(XResponseDecision\\)|insert.*x_response_decisions" backend wemedia-studio --glob '!backend/tests/**' --glob '!wemedia-studio/node_modules/**'
```

Expected: no runtime writer matches.

**Step 2: Finalize legacy-table handling**

After the migration parity tests pass, remove the ORM runtime dependency on `XResponseDecision`. Keep only the explicit, idempotent migration reader and a validated backup/drop step appropriate for the startup migration. Never drop before copied row/draft/notification counts match.

**Step 3: Run backend verification**

```bash
cd backend && pytest -q
```

Expected: all backend tests pass.

**Step 4: Run frontend verification**

```bash
cd wemedia-studio && pnpm test
cd wemedia-studio && pnpm lint
cd wemedia-studio && pnpm build
```

Expected: tests, lint, type checking, and production build pass.

**Step 5: Build and inspect runtime containers**

```bash
docker compose build api worker web
docker compose up -d postgres redis api worker web
docker compose exec api yt-dlp --version
docker compose exec api ffmpeg -version
docker compose exec worker sh -lc 'command -v yt-dlp >/dev/null; test $? -ne 0'
curl -fsS http://127.0.0.1:8000/health
curl -fsS http://127.0.0.1:3000/responses
```

Expected: API contains both media tools, worker does not, health succeeds, and the unified page renders.

**Step 6: Run migration and browser acceptance on real local data**

Before mutation, record counts of legacy X decisions, distinct tweets, drafts, and notifications. Start the migrated runtime, then verify equivalent unified counts. In the browser:

- open `/responses` and confirm X rows remain;
- open YouTube, toggle one channel, and confirm no historical jobs appear;
- manually analyze one stored video;
- observe caption-first extraction or configured Whisper fallback;
- confirm transcript persists on the video;
- confirm Chinese value analysis and every active-account score;
- mark later, then adopt and create at least one output;
- confirm no publication occurs;
- check browser console and hydration output.

If no safe stored video or no valid transcription credential is available, run the extractor against mocked external calls and explicitly report the live-smoke limit rather than calling it passed.

**Step 7: Commit final cleanup**

```bash
git add backend/models.py backend/database.py backend/tests/test_database_content_response_migration.py
git commit -m "chore: retire legacy x response storage"
git status --short
```

Expected: only the user-owned `.superpowers/brainstorm/` remains untracked.
