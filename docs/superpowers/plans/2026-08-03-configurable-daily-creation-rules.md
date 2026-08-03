# Configurable Daily Creation Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users configure one-time or recurring daily creation rules that select creative assets, let AI judge seven-day semantic duplication through tools, and create X post drafts or append plan items.

**Architecture:** Add durable rule, run, and usage-ledger models behind a service layer shared by FastAPI routes, MCP tools, the scheduler, and the AI SDK worker. Keep the existing account-quota planner intact; rule runs are independent durable jobs surfaced beside today's planner items.

**Tech Stack:** FastAPI, SQLAlchemy async, PostgreSQL/SQLite migrations, FastMCP, APScheduler, Next.js 16, React 19, AI SDK 7, Zod 4, Base UI/shadcn, pytest, Vitest, Testing Library, Playwright.

## Global Constraints

- No code branch may contain `搞钱副业`, target count `10`, or lookback `7` as product constants.
- Rule bounds: target count 1–50 and deduplication lookback 1–90 days.
- Execution modes are exactly `once` and `recurring`; recurring cadence is daily only.
- Delivery modes are exactly `drafts` and `plan_items`; output type initially supports `x_short_post` only.
- Deduplication defaults to global history across all rules, with AI deciding semantic similarity from tool evidence.
- Within-window reuse requires a materially different angle and a persisted explanation.
- Candidate shortage is partial completion; known duplicates must never be used to pad the batch.
- Usage is recorded only in the same transaction that successfully persists its draft or plan item.
- Generated X drafts use `draft_type="x_post"` and are never automatically published.
- Preserve unrelated dirty X, asset, text-video, and backend changes; stage only task-owned hunks and files.

---

### Task 1: Rule, Run, Ledger, and Planner-Origin Persistence

**Files:**
- Modify: `backend/models.py`
- Modify: `backend/database.py`
- Create: `backend/tests/test_daily_creation_rule_schema.py`
- Modify: `backend/tests/test_database_init_sqlite.py`

**Interfaces:**
- Produces: `DailyCreationRule`, `DailyCreationRun`, and `ContentUsageLedger` SQLAlchemy models.
- Produces: `DailyPlanItem.origin` (`planner | creation_rule`) and nullable `DailyPlanItem.creation_run_id`.
- Produces: idempotent schema migration for all supported databases.

- [ ] **Step 1: Write failing model and constraint tests**

Create test fixtures that persist a recurring rule, a queued run, and one ledger row. Assert uniqueness for scheduled `(rule_id, scheduled_for, trigger_kind)`, uniqueness for `(run_id, output_kind, output_id)`, preservation of rule history after deleting the rule through a soft-delete timestamp, and planner defaults `origin="planner"`, `creation_run_id=None`.

- [ ] **Step 2: Run tests and confirm RED**

Run: `/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_daily_creation_rule_schema.py backend/tests/test_database_init_sqlite.py -q`

Expected: FAIL because the models and columns do not exist.

- [ ] **Step 3: Implement the models**

Use explicit string fields and service validation rather than database-specific enum types. Store a rule snapshot and run detail as bounded JSON. Store `draft_id` and `plan_item_id` as nullable IDs in the ledger with a check enforced in service code that exactly one output reference is present.

- [ ] **Step 4: Implement the idempotent migration**

Create missing tables and add planner-origin columns through the existing `init_db` migration style. Add indexes for enabled recurring rules, run status, usage creation time, creative asset ID, and output lookup. Do not rewrite existing planner items.

- [ ] **Step 5: Verify GREEN**

Run the Task 1 pytest command and expect all selected tests to pass.

- [ ] **Step 6: Commit**

```bash
git add -p backend/models.py backend/database.py backend/tests/test_database_init_sqlite.py
git add backend/tests/test_daily_creation_rule_schema.py
git commit -m "feat: persist daily creation rules and usage"
```

### Task 2: Candidate and Usage Services plus MCP Tools

**Files:**
- Create: `backend/daily_creation_service.py`
- Create: `backend/tests/test_daily_creation_service.py`
- Modify: `backend/mcp_server.py`
- Create: `backend/tests/test_mcp_daily_creation_tools.py`

**Interfaces:**
- Produces: `list_creative_asset_candidates(session, *, asset_type, directory, query="", limit=50)`.
- Produces: `get_recent_content_usage(session, *, lookback_days, output_type, rule_id=None, account_id=None, limit=100)`.
- Produces: `persist_x_draft_with_usage(...)` and `persist_plan_item_with_usage(...)` transactional functions.
- Exposes MCP tools named `list_creative_asset_candidates`, `get_recent_content_usage`, and `record_content_usage` backed by the same service.

- [ ] **Step 1: Write failing candidate and global-history tests**

Seed two article directories, arbitrary rule names, recent global ledger entries, and full asset bodies. Assert exact directory scoping, compact candidate results without full bodies, global history by default, optional rule/account filters, bounded limits, and UTC lookback boundaries.

- [ ] **Step 2: Write failing transactional persistence tests**

Assert draft plus ledger commit together, rollback together on ledger failure, reject assets outside the rule snapshot directory, reject nonexistent outputs, reject duplicate run/output records, and write `ArticleDraft.draft_type == "x_post"`.

- [ ] **Step 3: Run service tests and confirm RED**

Run: `/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_daily_creation_service.py -q`

- [ ] **Step 4: Implement the bounded service operations**

Return candidate records shaped as `{id,title,summary,tags,source_url,created_at,content_length}` and usage records shaped as `{id,asset_id,rule_name,topic,angle,excerpt,reuse_decision,reuse_explanation,created_at}`. Normalize query and directory inputs, validate bounds before querying, and centralize transaction ownership in persistence functions.

- [ ] **Step 5: Write MCP contract tests and wrappers**

Call `.fn` on each FastMCP tool. Assert read tools return the service shape, the record tool rejects a missing output, and no tool description or implementation contains a named directory or fixed target count.

- [ ] **Step 6: Verify service and MCP tests GREEN**

Run both Task 2 pytest files and expect all tests to pass.

- [ ] **Step 7: Commit**

```bash
git add backend/daily_creation_service.py backend/tests/test_daily_creation_service.py backend/mcp_server.py backend/tests/test_mcp_daily_creation_tools.py
git commit -m "feat: expose AI creation selection tools"
```

### Task 3: Rule CRUD, Run-Now, and Run Inspection API

**Files:**
- Modify: `backend/routers/daily_plan.py`
- Create: `backend/tests/test_daily_creation_rules_router.py`

**Interfaces:**
- Produces endpoints:
  - `GET /api/daily-plan/creation-rules`
  - `POST /api/daily-plan/creation-rules`
  - `PATCH /api/daily-plan/creation-rules/{rule_id}`
  - `DELETE /api/daily-plan/creation-rules/{rule_id}`
  - `POST /api/daily-plan/creation-rules/{rule_id}/run`
  - `GET /api/daily-plan/creation-runs?date=YYYY-MM-DD`
  - `GET /api/daily-plan/creation-runs/{run_id}`
  - `GET /api/daily-plan/creation-runs/{run_id}/context`
  - `POST /api/daily-plan/creation-runs/{run_id}/outputs`
  - `POST /api/daily-plan/creation-runs/{run_id}/complete`

- [ ] **Step 1: Write failing CRUD and validation tests**

Use arbitrary directories and accounts. Cover once/recurring conditional fields, count/lookback bounds, exact directory existence, account existence, allowed output/delivery values, pause/resume, soft deletion, and history preservation.

- [ ] **Step 2: Write failing run-now concurrency tests**

Assert the endpoint creates `DailyCreationRun(status="queued")` and one `content_jobs(flow="daily_creation")`, enqueues it after commit, snapshots the rule, rejects a deleted/disabled-invalid rule, and returns the existing active explicit run instead of duplicating it.

- [ ] **Step 3: Write failing worker-contract tests**

Authenticate with the existing content-worker token. Assert context returns the immutable rule snapshot without full asset bodies, outputs atomically persist one draft or plan item with its usage row, duplicate output submissions are idempotent, completion accepts only valid counts/statuses, and a browser session cannot call worker-only mutation endpoints.

- [ ] **Step 4: Run router tests and confirm RED**

Run: `/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_daily_creation_rules_router.py -q`

- [ ] **Step 5: Implement strict Pydantic contracts and endpoints**

Use discriminated validation for `once` versus `recurring`. Serialize run details without full asset bodies or model prompts. Delete sets `deleted_at` and `enabled=False`; it never deletes runs, ledger entries, drafts, or plan items. Keep worker mutations behind the same worker authentication used by existing content-job callbacks and delegate atomic persistence to Task 2 services.

- [ ] **Step 6: Verify GREEN and commit**

Run the Task 3 pytest command, then:

```bash
git add backend/routers/daily_plan.py backend/tests/test_daily_creation_rules_router.py
git commit -m "feat: manage daily creation rules"
```

### Task 4: Generic AI Selection and X Draft Batch Flow

**Files:**
- Modify: `wemedia-studio/lib/ai/content-job.ts`
- Modify: `wemedia-studio/lib/ai/content-job.test.ts`
- Modify: `wemedia-studio/scripts/content-worker.ts`
- Modify: `wemedia-studio/scripts/content-worker.test.ts`
- Modify: `backend/content_jobs.py`
- Modify: `backend/tests/test_content_jobs.py`

**Interfaces:**
- Adds content-job flow `daily_creation` with steps `loadCandidates`, `loadUsage`, `select`, `generate`, `validate`, and `persist`.
- Defines strict Zod schemas `dailyCreationSelectionSchema`, `xPostBatchSchema`, and `dailyCreationValidationSchema`.
- Consumes the run snapshot, bounded MCP read tools, and worker-authenticated persistence endpoints; produces accepted outputs plus compact selection/exclusion evidence.

- [ ] **Step 1: Write failing flow registration tests**

Assert Python and TypeScript accept `daily_creation`, create the exact step sequence, resume idempotently from completed steps, and reject jobs without a positive `run_id`.

- [ ] **Step 2: Write failing AI selection tests**

Mock arbitrary candidate and usage tool results. Cover fresh selection, semantic duplicate rejection, justified `reuse_allowed`, invented asset/history IDs, insufficient candidates, and absence of fixed directory/count/lookback values in production source.

- [ ] **Step 3: Write failing generation and validation tests**

Assert standalone X posts rather than threads, no invented personal experience, within-batch comparison, recent-history comparison, one revision maximum, omission after second failure, and accepted results containing asset, topic, angle, reuse decision, explanation, and text.

- [ ] **Step 4: Run focused tests and confirm RED**

Run:

```bash
pnpm exec vitest run lib/ai/content-job.test.ts scripts/content-worker.test.ts
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_content_jobs.py -q
```

- [ ] **Step 5: Implement the bounded AI flow**

Open the configured MCP client and expose only `list_creative_asset_candidates`, `get_creative_asset`, and `get_recent_content_usage` to this flow; always close the client. Use AI SDK tools rather than embedding candidate bodies. Require the model to read the full body only for selected assets. Validate every selected ID against observed tool evidence. Generate a JSON batch, validate it, revise rejected items once, and persist accepted outputs one at a time through the worker-authenticated backend endpoints from Task 3.

- [ ] **Step 6: Mark the durable run outcome**

Update requested/created counts, compact exclusions, and status: zero persisted outputs is `failed`, fewer than requested is `partial`, exact requested count is `succeeded`. Ensure worker failure also marks the linked run failed.

- [ ] **Step 7: Verify GREEN and commit**

Run the Task 4 commands, then stage only the flow-owned hunks and commit:

```bash
git add -p wemedia-studio/lib/ai/content-job.ts wemedia-studio/lib/ai/content-job.test.ts wemedia-studio/scripts/content-worker.ts wemedia-studio/scripts/content-worker.test.ts backend/content_jobs.py backend/tests/test_content_jobs.py
git commit -m "feat: execute AI deduplicated creation batches"
```

### Task 5: Scheduled and One-Time Rule Dispatch

**Files:**
- Modify: `backend/daily_planner.py`
- Modify: `backend/scheduler.py`
- Create: `backend/tests/test_daily_creation_scheduler.py`

**Interfaces:**
- Produces `dispatch_due_creation_rules(*, now=None)`.
- Uses the same run/job creation service as Run Now with `trigger_kind="scheduled"`.

- [ ] **Step 1: Write failing due-rule tests**

Cover enabled recurring rules at and after their configured local time, paused/deleted rules, future one-time dates, due one-time dates, already-dispatched dates, timezone-local date boundaries, and independent operation when the account-quota planner has no active accounts.

- [ ] **Step 2: Run and confirm RED**

Run: `/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_daily_creation_scheduler.py -q`

- [ ] **Step 3: Implement idempotent dispatch**

Call the dispatcher from the existing scheduler at a one-minute interval. Use the database uniqueness constraint as the final concurrency guard. A conflict means another scheduler instance already dispatched the run and is not an error.

- [ ] **Step 4: Verify GREEN and commit**

```bash
git add backend/daily_planner.py backend/scheduler.py backend/tests/test_daily_creation_scheduler.py
git commit -m "feat: schedule daily creation rules"
```

### Task 6: Daily Plan Rule Management and Run UI

**Files:**
- Modify: `wemedia-studio/lib/api/daily-plan.ts`
- Create: `wemedia-studio/app/daily-plan/CreationRuleDialog.tsx`
- Create: `wemedia-studio/app/daily-plan/CreationRuleDialog.test.tsx`
- Create: `wemedia-studio/app/daily-plan/CreationRulesPanel.tsx`
- Create: `wemedia-studio/app/daily-plan/CreationRulesPanel.test.tsx`
- Create: `wemedia-studio/app/daily-plan/CreationRunsPanel.tsx`
- Create: `wemedia-studio/app/daily-plan/CreationRunsPanel.test.tsx`
- Modify: `wemedia-studio/app/daily-plan/DailyPlanClient.tsx`
- Create: `wemedia-studio/app/daily-plan/DailyPlanClient.test.tsx`

**Interfaces:**
- Produces typed rule/run CRUD API functions matching Task 3.
- Dialog returns a strict create/update payload; panels own presentation, while `DailyPlanClient` owns refresh coordination.

- [ ] **Step 1: Write failing dialog tests**

Cover source type/directory, X short-post output, 1–50 quantity, once date, recurring time, 1–90 lookback, delivery mode, optional account, instructions, conditional fields, and accessible validation errors.

- [ ] **Step 2: Write failing panel tests**

Cover create/edit, pause/resume, run now, active-run disabling, confirmed deletion, historical runs after deletion, partial counts, expansion evidence, exclusions, and draft/plan-item links.

- [ ] **Step 3: Write a failing page-integration test**

Mock the typed API and assert `DailyPlanClient` renders `今日创作任务` above `创作规则`, keeps the existing planner list intact, refreshes rules and runs after mutations, and starts/stops polling when queued or running work appears/disappears.

- [ ] **Step 4: Run UI tests and confirm RED**

Run: `pnpm exec vitest run app/daily-plan/CreationRuleDialog.test.tsx app/daily-plan/CreationRulesPanel.test.tsx app/daily-plan/CreationRunsPanel.test.tsx app/daily-plan/DailyPlanClient.test.tsx`

- [ ] **Step 5: Implement typed API and focused components**

Use existing Dialog, Field, Select, Switch, Button, Badge, and dropdown primitives. Keep the existing planner list unchanged. Add `今日创作任务` above `创作规则`; poll while any run is queued or running. The only primary row action is `立即执行`.

- [ ] **Step 6: Integrate and verify UI GREEN**

Run the Task 6 Vitest command and scoped ESLint for every changed frontend file.

- [ ] **Step 7: Commit**

```bash
git add wemedia-studio/lib/api/daily-plan.ts wemedia-studio/app/daily-plan/CreationRuleDialog.tsx wemedia-studio/app/daily-plan/CreationRuleDialog.test.tsx wemedia-studio/app/daily-plan/CreationRulesPanel.tsx wemedia-studio/app/daily-plan/CreationRulesPanel.test.tsx wemedia-studio/app/daily-plan/CreationRunsPanel.tsx wemedia-studio/app/daily-plan/CreationRunsPanel.test.tsx wemedia-studio/app/daily-plan/DailyPlanClient.test.tsx
git add -p wemedia-studio/app/daily-plan/DailyPlanClient.tsx
git commit -m "feat: configure daily creation rules"
```

### Task 7: Cross-Layer and Live Verification

**Files:**
- No planned file changes; any discovered regression is fixed and recommitted in its owning task before verification continues.

**Interfaces:**
- Produces a verified generic rule flow and no permanent test data.

- [ ] **Step 1: Run backend verification**

Run all new backend tests plus existing daily-plan, MCP daily-plan, content-job, scheduler, draft, and creative-asset tests with the `wems` Python interpreter. Record unrelated fixture or dirty-worktree failures separately.

- [ ] **Step 2: Run frontend verification**

Run all new Vitest files, existing daily-plan/content-worker tests, scoped ESLint, and `pnpm exec tsc --noEmit --pretty false`. Confirm no new error belongs to a task-owned file.

- [ ] **Step 3: Verify migration and API live**

Restart `./dev.sh`, verify `/health`, create a temporary arbitrary article directory and at least four test assets, create a temporary rule requesting two X posts with a one-day lookback, and run it now.

- [ ] **Step 4: Verify AI evidence and second-run history**

Inspect the first run's drafts and ledger. Run the same rule again and verify the AI receives the first run's usage evidence, either selects materially different angles with explanations or returns partial without padding.

- [ ] **Step 5: Verify browser UI**

With Browser plugin if available, otherwise Playwright, verify desktop and narrow `/daily-plan` layouts, create/edit/pause/run/delete interactions, progress polling, partial-state rendering, evidence expansion, draft links, console health, and absence of horizontal overflow. Capture screenshots outside the repository and inspect them with `view_image`.

- [ ] **Step 6: Remove temporary live data**

Delete only the exact temporary rule, directory, assets, drafts, plan items, runs, and ledger records created by Step 3. Report what was removed and whether any generated files remain.

- [ ] **Step 7: Final scope audit**

Run `git diff --check`, scan production files for hard-coded first-rule values, list commits, and verify unrelated dirty files remain unstaged and unchanged by this plan.
