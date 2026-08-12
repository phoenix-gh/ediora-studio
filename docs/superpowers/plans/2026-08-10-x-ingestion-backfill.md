# X Ingestion Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow an X subscription to send locally stored, recently published, not-yet-decided posts through the existing topic-source Agent ingestion flow without duplicate processing.

**Architecture:** Add a backend service function that selects a subscription's posts inside a validated day window and excludes `AssetIngestionDecision` rows, then dispatches the remaining tweet IDs in 50-item `topic_source` jobs. Expose that operation through an X router endpoint and a small API client method, and add a button/input to the existing subscription edit dialog.

**Tech Stack:** FastAPI, SQLAlchemy async, PostgreSQL/SQLite-compatible SQLAlchemy expressions, React, TypeScript, Vitest, pytest.

## Global Constraints

- Use the existing `topic_source` job flow and `dispatch_topic_source_posts`; do not create a second Agent workflow.
- Treat any `AssetIngestionDecision` row, including `directory_id = null`, as processed.
- Use `published_at` for the day window and UTC timestamps.
- Use 50 tweet IDs per dispatch batch.
- Run only focused backend and frontend tests related to this feature.
- Preserve all unrelated dirty worktree changes.

---

### Task 1: Add the service-level pending-post backfill contract

**Files:**
- Modify: `backend/topic_source_service.py`
- Test: `backend/tests/test_topic_source_service.py`

**Interfaces:**
- Produces `dispatch_topic_source_backfill(db, subscription_id, days, enqueue=...) -> dict`.
- The result contains `candidate_count`, `skipped_count`, `created`, `enqueued`, and `errors`.

- [x] **Step 1: Write the failing service tests**

Add tests that create one subscription, one enabled article ingestion directory, four posts with mixed publication times, and two decisions (one accepted and one with `directory_id=None`). Assert that a 7-day call dispatches only the two undecided in-window IDs, reports two skipped posts, and a second call creates no new jobs after decisions are inserted. Add a separate test that a 1-day call excludes an older undecided post. Use a fake `enqueue` callback and inspect persisted `ContentJob.input_data`.

- [x] **Step 2: Run the service tests and verify the expected failure**

Run:

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_topic_source_service.py -k backfill -q
```

Expected: collection succeeds and the new tests fail because `dispatch_topic_source_backfill` does not exist.

- [x] **Step 3: Write the minimal implementation**

In `backend/topic_source_service.py`:

1. Import `timedelta`, `desc`, `exists`, `XPost`, and `AssetIngestionDecision`.
2. Query the subscription's selected article/prompt directories and raise a clear 422-compatible error when no enabled directory with a non-empty AI rule exists.
3. Query the subscription's total in-window post count and the in-window decided count.
4. Query undecided `XPost.tweet_id` values ordered by `published_at DESC, tweet_id DESC`.
5. Return zero counts without dispatching if no undecided IDs exist.
6. Split IDs into slices of 50 and call `dispatch_topic_source_posts` for each slice, merging `created`, `enqueued`, and `errors`.
7. Return `candidate_count` as undecided IDs and `skipped_count` as total minus candidate count.

Use an injected `enqueue` callback for deterministic tests. Validate `days` in the router layer; the service should assume a positive integer.

- [x] **Step 4: Run the service tests and verify they pass**

Run:

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_topic_source_service.py -k backfill -q
```

Expected: all backfill service tests pass.

### Task 2: Expose the backfill HTTP endpoint

**Files:**
- Modify: `backend/routers/x.py`
- Test: `backend/tests/test_x_router.py`

**Interfaces:**
- Adds `POST /api/x/subscriptions/{sub_id}/ingestion-backfill` with `{ "days": 7 }`.
- Returns `{ ok, days, candidate_count, skipped_count, created, enqueued, errors }`.

- [x] **Step 1: Write failing route tests**

Add tests for:

1. An existing subscription with a configured ingestion directory calls the service and returns its counters plus `ok: true` and the requested `days`.
2. A missing subscription returns 404.
3. `days=0` and `days=91` return 422 before dispatch.

Patch `topic_source_service.dispatch_topic_source_backfill` in the route test to avoid queue side effects and assert it receives the subscription ID and requested day count.

- [x] **Step 2: Run route tests and verify the expected failure**

Run:

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_x_router.py -k ingestion_backfill -q
```

Expected: the route tests fail with 404 because the endpoint is not defined.

- [x] **Step 3: Implement the endpoint**

Add a `TimelineIngestionBackfillRequest` model with `days: int = Field(default=7, ge=1, le=90)`. In the endpoint, load the subscription and return 404 when absent. Call the service function, translate its result into the documented response, and return `ok: true` and `days`. Translate the service's missing-directory validation into a clear 422.

- [x] **Step 4: Run route tests and verify they pass**

Run:

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_x_router.py -k ingestion_backfill -q
```

Expected: all route tests pass.

### Task 3: Add the API client and dialog operation

**Files:**
- Modify: `wemedia-studio/lib/api/x.ts`
- Modify: `wemedia-studio/app/x/XClient.tsx`
- Modify: `wemedia-studio/app/x/XSubscriptionDialog.tsx`
- Test: `wemedia-studio/app/x/XSubscriptionDialog.test.tsx`

**Interfaces:**
- Adds `backfillXSubscriptionIngestion(id, days) -> XIngestionBackfillResult`.
- Adds `onIngestExisting(subscription, days) -> Promise<void>` to `XSubscriptionDialogProps`.

- [x] **Step 1: Write the failing dialog test**

Extend the shared callback fixture with `onIngestExisting`. Render edit mode, assert the day input is `7`, change it to `3`, click “补处理已有帖子”, and assert the callback receives the subscription and `3`. Add an invalid-days assertion that displays an alert and does not call the callback.

- [x] **Step 2: Run the dialog test and verify the expected failure**

Run:

```bash
pnpm exec vitest run app/x/XSubscriptionDialog.test.tsx -t “补处理”
```

Expected: the test fails because the new callback and controls do not exist.

- [x] **Step 3: Implement the API and UI**

In `lib/api/x.ts`, add the result type and POST function. In `XClient.tsx`, import the function and add a handler that calls it, shows a concise success toast with counts, reloads subscriptions/posts, and rethrows errors for the dialog to render.

In `XSubscriptionDialog.tsx`, add `onIngestExisting`, `ingestionBackfillDays` defaulting to `7`, `ingestionBackfilling`, and `ingestionBackfillError` state. Under “采集操作”, render a number input (1–90) and a button with a loader while running. Validate the integer before calling the callback. Explain that only local posts in the selected window are processed and prior decisions are skipped. Keep this separate from the normal collection/backfill controls.

- [x] **Step 4: Run the focused dialog tests**

Run:

```bash
pnpm exec vitest run app/x/XSubscriptionDialog.test.tsx
```

Expected: all dialog tests pass.

### Task 4: Run focused regression verification

**Files:**
- No new production files.

- [x] **Step 1: Run the relevant backend tests**

Run:

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_topic_source_service.py backend/tests/test_x_router.py -q
```

Expected: both relevant backend modules pass; report any pre-existing failures separately from this feature.

- [x] **Step 2: Run the relevant frontend tests**

Run:

```bash
pnpm exec vitest run app/x/XSubscriptionDialog.test.tsx
```

Expected: all dialog tests pass.

- [x] **Step 3: Run static checks for touched frontend files**

Run:

```bash
pnpm exec tsc --noEmit 2>&1 | tee /tmp/wms-x-ingestion-backfill-tsc.log
```

Confirm that any remaining errors are the previously known unrelated errors and that no new error references the touched files.

- [x] **Step 4: Review the diff and whitespace**

Run:

```bash
git diff --check
git diff -- backend/topic_source_service.py backend/routers/x.py wemedia-studio/lib/api/x.ts wemedia-studio/app/x/XClient.tsx wemedia-studio/app/x/XSubscriptionDialog.tsx
```

Confirm that the diff contains only the requested backfill behavior and focused tests.
