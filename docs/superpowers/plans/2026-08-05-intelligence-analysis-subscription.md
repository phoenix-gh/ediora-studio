# 情报分析订阅开关 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove X 即时响应 and make explicit per-subscription 情报分析 enablement control which new posts enter the intelligence station.

**Architecture:** Replace the old realtime-response opt-in fields with `intelligence_enabled` and `intelligence_enabled_at`. Gate the existing intelligence dispatcher at the collector boundary, persist the X subscription id on unified response items, and expose the new control in the existing X subscription API/UI. Keep unified intelligence records and a compatibility redirect, but remove the old active response service and worker path.

**Tech Stack:** FastAPI, SQLAlchemy async, SQLite/Postgres in-place migrations, Next.js/React, Vitest, pytest.

## Global Constraints

- Existing subscriptions default to disabled for intelligence analysis.
- Only posts collected after `intelligence_enabled_at` may enter analysis.
- Timeline and search subscriptions use the same intelligence gate.
- Existing unified intelligence analysis records remain intact.
- Do not modify unrelated dirty-worktree changes.
- Follow red-green-refactor for each behavior change and run fresh verification before claiming completion.

---

### Task 1: Replace subscription fields and API contract

**Files:**
- Modify: `backend/models.py` (`XSubscription`, `ContentResponseItem`)
- Modify: `backend/routers/x.py` (`SubscriptionOut`, `SubscriptionPatch`, serializer and patch handler)
- Modify: `backend/database.py` (in-place schema migration)
- Test: `backend/tests/test_x_router.py`
- Test: `backend/tests/test_database_init_sqlite.py`

**Interfaces:**
- `XSubscription.intelligence_enabled: bool` defaults to `False`.
- `XSubscription.intelligence_enabled_at: datetime | None` is set on enable and cleared on disable.
- `ContentResponseItem.subscription_id: int | None` stores the X subscription source when available.
- `PATCH /api/x/subscriptions/{id}` accepts `intelligence_enabled` and returns both intelligence fields.

- [ ] **Step 1: Write failing API and migration tests**

  Add tests proving a new subscription returns `intelligence_enabled=false`, enabling it sets a timestamp, disabling it clears the timestamp, and the initialize migration adds the new columns while defaulting existing rows to false.

- [ ] **Step 2: Run the focused tests and verify they fail for the missing contract**

  Run: `WMS_DATABASE_URL=sqlite+aiosqlite:///... /home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_x_router.py -k intelligence -q`

  Expected: failures because the response schema and patch payload still use `notify_new_posts`.

- [ ] **Step 3: Implement the new ORM fields, API fields, and idempotent migration**

  Remove `notify_new_posts` and `notify_enabled_at` from the active ORM/API contract. Add the two intelligence fields. In the initialization migration add the new columns with false/null defaults on both SQLite and Postgres. Do not copy old opt-in values.

- [ ] **Step 4: Run focused tests and confirm green**

  Run the same focused pytest command and the database initialization tests.

- [ ] **Step 5: Commit the isolated task**

  Commit only the files for this task with message: `feat: add subscription intelligence analysis switch`.

### Task 2: Gate new-post dispatch and persist source subscription

**Files:**
- Modify: `backend/content_response_service.py`
- Modify: `backend/routers/x.py` (`_collect_one` dispatch boundary)
- Modify: `backend/routers/responses.py` (source subscription projection if needed)
- Test: `backend/tests/test_x_router.py`
- Test: `backend/tests/test_content_response_service.py`
- Test: `backend/tests/test_responses_router_contract.py`

**Interfaces:**
- `dispatch_intelligence_posts(db, subscription, source_ids, ...)` returns without creating records unless the subscription is enabled, intelligence-enabled, and the post was collected after the enable timestamp.
- `ensure_response_item(..., subscription_id: int | None = None)` writes the source subscription only for newly created X items and preserves existing non-X behavior.

- [ ] **Step 1: Write failing gate and source-attribution tests**

  Add cases for disabled analysis, enabled analysis before the timestamp, enabled analysis after the timestamp, and a successful item carrying `subscription_id`.

- [ ] **Step 2: Run the tests and verify the gate tests fail**

  Run: `/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_content_response_service.py backend/tests/test_x_router.py -k 'intelligence or response_item' -q`

- [ ] **Step 3: Implement the minimal gate and source persistence**

  Apply the gate before querying/creating posts in the intelligence dispatcher. Pass the subscription id into `ensure_response_item` for X posts. Keep the existing idempotency behavior so repeated collections do not duplicate analysis jobs.

- [ ] **Step 4: Run the focused backend tests and confirm green**

  Run the commands from Step 2 without the `-k` filter for the touched test files.

- [ ] **Step 5: Commit the isolated task**

  Commit with message: `feat: gate intelligence analysis by subscription`.

### Task 3: Replace the subscription UI control

**Files:**
- Modify: `web/lib/api/x.ts`
- Modify: `web/app/x/XSubscriptionRow.tsx`
- Modify: `web/app/x/XSubscriptionRow.test.tsx`
- Modify: `web/app/x/XClient.tsx` if it references the old fields
- Modify: `web/app/x-responses/x-responses-layout.test.tsx` to remove old wording assertions

**Interfaces:**
- The row renders one action labeled `开启情报分析` or `关闭情报分析` based on `intelligence_enabled`.
- The action calls the subscription patch API with `{ intelligence_enabled: boolean }`.
- Search subscriptions no longer hide the action.

- [ ] **Step 1: Write failing component/API contract tests**

  Update fixtures to use `intelligence_enabled`, assert the new action labels, assert search subscriptions can use the same action, and assert no rendered “即时响应” label remains.

- [ ] **Step 2: Run focused Vitest tests and verify the expected failures**

  Run: `pnpm exec vitest run app/x/XSubscriptionRow.test.tsx app/x-responses/x-responses-layout.test.tsx`

- [ ] **Step 3: Implement the new field and control**

  Replace the bell action and old API property with the intelligence-analysis action. Preserve existing row mutation/loading behavior and avoid adding extra requests or effects.

- [ ] **Step 4: Run focused frontend tests and ESLint**

  Run: `pnpm exec vitest run app/x/XSubscriptionRow.test.tsx app/x-responses/x-responses-layout.test.tsx`

  Run: `pnpm exec eslint app/x/XSubscriptionRow.tsx app/x/XSubscriptionRow.test.tsx lib/api/x.ts`

- [ ] **Step 5: Commit the isolated task**

  Commit with message: `feat: expose intelligence analysis subscription control`.

### Task 4: Remove active 即时响应 runtime chain

**Files:**
- Modify: `backend/main.py` to remove active `x_responses` router registration if no compatibility route remains
- Modify/delete: `backend/routers/x_responses.py`, `backend/x_response_service.py`, `backend/x_response_links.py` and their active tests according to imports
- Modify/delete: `web/lib/ai/x-response-job.ts`, `web/lib/api/x-responses.ts`, and old X response tests
- Keep: unified `/api/responses` routes and historical database migration functions needed for existing installations
- Test: `backend/tests/test_x_notify_scout.py`, `backend/tests/test_x_responses_router.py`, `backend/tests/test_x_response_end_to_end.py`, related frontend tests

**Interfaces:**
- Collection no longer imports or calls the old response service.
- `/responses` remains the only active station endpoint.
- Legacy `/x-responses` navigation may redirect to `/responses?source_type=x_post`, but no old response worker jobs are scheduled or accepted.

- [ ] **Step 1: Add a repository-level regression test for removed active coupling**

  Assert the collector source contains no `notify_new_posts` or old response dispatcher call, and that the unified intelligence dispatcher is the only collection-time analysis entry.

- [ ] **Step 2: Run the regression test and verify it fails against the current coupling**

  Run the focused backend/frontend tests and confirm the old symbols are still found.

- [ ] **Step 3: Remove active runtime references and update compatibility behavior**

  Delete only obsolete active routes/workers/services after checking imports. Keep data migration code that upgrades old databases. Update main/router imports and tests so no production path references the retired field or service.

- [ ] **Step 4: Run focused backend and frontend regression tests**

  Run the touched X, response, migration, and job tests; run the focused Vitest suite.

- [ ] **Step 5: Commit the isolated task**

  Commit with message: `refactor: remove realtime response runtime`.

### Task 5: Full verification and handoff

**Files:**
- Modify: only test/documentation files if verification exposes a scoped issue

- [ ] **Step 1: Run backend focused regression suite**

  Run: `/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_x_router.py backend/tests/test_content_response_service.py backend/tests/test_responses_router_contract.py backend/tests/test_database_init_sqlite.py -q`

- [ ] **Step 2: Run frontend focused suite and lint**

  Run the X subscription, responses, and legacy redirect Vitest tests plus ESLint on touched files.

- [ ] **Step 3: Search for retired production references**

  Run: `rg -n "notify_new_posts|notify_enabled_at|即时响应|dispatch_response_posts" backend web --glob '!**/*.test.*' --glob '!**/node_modules/**'`

  Expected: no active production references; historical migration code and explicitly retained compatibility documentation must be reviewed individually.

- [ ] **Step 4: Run `git diff --check` and inspect the final scoped diff**

  Confirm no whitespace errors and no unrelated files were staged or modified by this task.

