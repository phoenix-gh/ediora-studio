# Remove Legacy Daily Plan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire the legacy daily editorial planner while retaining daily creation rules and their execution history as a focused creation-task product.

**Architecture:** Delete planner models, routes, scheduler, worker flow, and UI rather than leave dormant code. Move creation-rule APIs to `/creation-rules`; migrate historical `plan_items` delivery to `drafts` before dropping legacy tables.

**Tech Stack:** FastAPI, SQLAlchemy async, SQLite/PostgreSQL, Next.js 16, React 19, TypeScript, Vitest, pytest.

## Global Constraints

- Delete legacy `daily_plans` and `daily_plan_items` records.
- Preserve `DailyCreationRule`, `DailyCreationRun`, scheduling, agent jobs, and direct draft delivery.
- Migrate existing rule `delivery_mode = "plan_items"` to `"drafts"` during initialization.
- Accept only `delivery_mode = "drafts"` in new rule input.
- `/daily-plan` and legacy planner API endpoints return 404.
- Remove the 08:00 planner scheduler and `daily_quota`.
- Do not stage unrelated existing worktree changes.

---

### Task 1: Persistence Migration and Rule Contract

**Files:**

- Modify: `backend/models.py`, `backend/database.py`, `backend/schemas.py`
- Modify: `backend/tests/test_database_init_sqlite.py`, `backend/tests/test_daily_creation_rule_schema.py`

**Interfaces:** Retains `DailyCreationRule.delivery_mode = "drafts"`; removes `DailyPlan`, `DailyPlanItem`, and publish-account `daily_quota`.

- [ ] **Step 1: Write failing migration tests**

Seed SQLite with legacy `daily_plans`, `daily_plan_items`, and a `daily_creation_rules` `plan_items` record. After `init_db()`, assert both legacy tables are absent and `SELECT delivery_mode FROM daily_creation_rules WHERE id = 1` returns `drafts`. Add a `CreationRuleIn` test that rejects `plan_items` and accepts `drafts`.

- [ ] **Step 2: Verify RED**

Run `cd backend && python -m pytest tests/test_database_init_sqlite.py tests/test_daily_creation_rule_schema.py -q`. Expected: FAIL because the tables and legacy mode remain.

- [ ] **Step 3: Implement migration**

Drop `daily_plan_items` before `daily_plans` in initialization, update legacy rules to `drafts`, delete planner ORM/schema classes, remove `daily_quota`, and make rule input `Literal['drafts']`.

- [ ] **Step 4: Verify GREEN and commit**

Re-run Step 2. Stage only Task 1 files and commit `refactor: remove daily planner persistence` when Git metadata is writable.

### Task 2: Backend Route and Runtime Removal

**Files:**

- Create: `backend/routers/creation_rules.py`
- Delete: `backend/routers/daily_plan.py`
- Modify: `backend/main.py`, `backend/daily_planner.py`, `backend/daily_creation_service.py`, `backend/scheduler.py`
- Modify: `backend/tests/test_daily_creation_rules_router.py`, `backend/tests/test_daily_creation_scheduler.py`
- Delete: legacy planner router/model/MCP tests

**Interfaces:** Provides `/api/creation-rules`, `/api/creation-rules/runs`, and `/api/creation-rules/{id}/run`; retains `dispatch_due_creation_rules` but no planner scheduler.

- [ ] **Step 1: Write failing endpoint and scheduler tests**

Change retained-rule tests to `/api/creation-rules`, assert `GET /api/daily-plan/today` is 404, `GET /api/creation-rules` is 200, and posting `delivery_mode: 'plan_items'` returns 422. Assert scheduler registration contains `daily_creation_rules` but not `daily_plan`.

- [ ] **Step 2: Verify RED**

Run `cd backend && python -m pytest tests/test_daily_creation_rules_router.py tests/test_daily_creation_scheduler.py -q`. Expected: FAIL on old routing/scheduler registration.

- [ ] **Step 3: Implement route extraction**

Move retained creation-rule/run endpoints into `creation_rules.py` with `APIRouter(prefix='/creation-rules')`, register it, delete `create_today_plan` and `scheduled_daily_plan`, and remove plan-item persistence so creation runs always save drafts.

- [ ] **Step 4: Verify GREEN and commit**

Re-run Step 2. Commit scoped files as `refactor: isolate creation rule APIs` when possible.

### Task 3: Planner Integrations and Account Settings

**Files:**

- Modify: `backend/content_jobs.py`, `backend/mcp_server.py`, `backend/routers/dashboard.py`, `backend/routers/publish_accounts.py`
- Modify: `web/lib/ai/content-job.ts`, `web/lib/api/publish-accounts.ts`, `web/app/settings/sections/PublishAccountsSection.tsx`
- Modify: relevant dashboard/content-job/account tests

**Interfaces:** No `daily_plan` content flow/MCP tools/dashboard alert and no `daily_quota` wire value or setting.

- [ ] **Step 1: Write failing boundary tests**

Assert planner-ready fixtures produce no dashboard alert, publish-account JSON omits `daily_quota`, and the settings form contains no label matching `每日配额`.

- [ ] **Step 2: Verify RED**

Run focused backend dashboard/content-job tests and `cd web && pnpm test app/settings/sections/PublishAccountsSection.test.tsx`. Expected: FAIL because integrations remain.

- [ ] **Step 3: Remove integrations**

Delete planner job branches/parsers/MCP tools, planner dashboard queries/alerts, and quota serialization/settings. Preserve creation-agent job behavior.

- [ ] **Step 4: Verify GREEN and commit**

Re-run Step 2 and commit scoped files as `refactor: remove planner integrations` when possible.

### Task 4: Dedicated Creation-Task Frontend

**Files:**

- Create: `web/app/creation-rules/page.tsx`, `web/app/creation-rules/CreationRulesClient.tsx`, `web/app/creation-rules/CreationRulesClient.test.tsx`, `web/lib/api/creation-rules.ts`
- Delete: `web/app/daily-plan/`, `web/components/features/dashboard/TodayPlan.tsx`
- Modify: `web/app/page.tsx`, `web/components/features/Sidebar.tsx`, dashboard tests

**Interfaces:** The `/creation-rules` page loads only rules/runs and has no planning controls. Sidebar links there; dashboard does not fetch/render a plan.

- [ ] **Step 1: Write failing UI tests**

Render `CreationRulesClient`; assert headings `今日创作任务` and `创作规则`, plus no text matching `今日计划|重新生成|入队所选`. Assert sidebar has `/creation-rules` but no `/daily-plan`, and dashboard has no plan card.

- [ ] **Step 2: Verify RED**

Run `cd web && pnpm test app/creation-rules/CreationRulesClient.test.tsx components/features/dashboard/dashboard-components.test.tsx`. Expected: FAIL because the new page/client does not exist.

- [ ] **Step 3: Implement product migration**

Move retained run/rule loading, polling, dialog, and panels into `CreationRulesClient`; point its API client at `/creation-rules`. Delete plan UI/files; remove `plan_items` from `CreationRuleDialog`; change sidebar link and dashboard data/rendering.

- [ ] **Step 4: Verify GREEN and commit**

Re-run Step 2 and commit scoped files as `refactor: replace daily plan with creation tasks` when possible.

### Task 5: Regression and Scope Review

- [ ] **Step 1: Run backend tests**

Run `cd backend && python -m pytest -q`. Record exact unrelated failures separately if any occur.

- [ ] **Step 2: Run frontend tests and build**

Run `cd web && pnpm test && pnpm lint && pnpm build`.

- [ ] **Step 3: Verify route outcomes**

With services running, assert `/api/daily-plan/today` and `/daily-plan` are 404 while `/api/creation-rules` and `/creation-rules` are 200.

- [ ] **Step 4: Diff hygiene**

Run `git diff --check`, `git status --short`, and `git diff --name-only`; stage only files in this plan. If `.git` remains read-only, leave changes unstaged and report that restriction.
