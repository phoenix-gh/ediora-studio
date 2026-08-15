# 任务看板与创作 Job 修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or **superpowers:executing-plans** to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 修复每日创作任务最终产出无法落库和 Agent 状态残留的问题，并把 /creation-rules 重构为展示规则、运行统计和 Job 日志的“任务看板”。

**Architecture:** 保留 DailyCreationRule → DailyCreationRun → ContentJob → AgentExecution 数据链路，在 API 层新增一次聚合读取，批量拼装 run、Job steps/events、Agent 工具调用和 daily_creation 调度日志。前端用一个看板请求驱动统计和日志，规则表单继续复用现有组件。

**Tech Stack:** FastAPI、SQLAlchemy async、SQLite/PostgreSQL 兼容迁移、Next.js/React、Tailwind、Vitest、pytest、Playwright。

## Global Constraints

- 不自动重跑 2026-08-05 已失败的 run 24，避免重复模型调用和重复草稿。
- 不恢复 daily_plans、daily_plan_items 或 plan_item_ids 业务模型；旧字段只作为一次性迁移目标。
- 保存服务只把 topic、angle 字符串作为当前 metadata 使用，忽略旧计划字段。
- 看板不新增独立日志服务，复用 CollectLog、ContentJobStep、ContentJobEvent 和 AgentToolCall。
- 自动刷新只刷新看板数据，不重置打开的规则编辑对话框。
- 只修改本任务相关文件，不清理工作区中其他未提交改动。

---

### Task 1: Add failing backend regression tests for the observed save failure

**Files:**
- Modify: backend/tests/test_database_init_sqlite.py
- Modify: backend/tests/test_daily_creation_service.py
- Modify: backend/tests/test_agent_execution_service.py

**Interfaces:**
- Consumes: database migrations, persist_daily_creation_output_batch, and Agent execution service.
- Produces: failing tests defining legacy-column removal, metadata compatibility, and terminal Agent failure behavior.

- [ ] **Step 1: Write the migration regression test**

Create a legacy SQLite daily_creation_output_batches table containing the current columns plus plan_item_ids JSON NOT NULL, initialize the database twice, and assert plan_item_ids is absent after migration.

~~~python
def test_init_db_removes_legacy_daily_creation_plan_item_column(tmp_path, monkeypatch):
    # create the legacy table, run init_db twice, inspect PRAGMA table_info
    assert "plan_item_ids" not in columns("daily_creation_output_batches")
~~~

- [ ] **Step 2: Write the metadata compatibility test**

Extend the daily creation service fixture with a post whose metadata contains {"plan_item_ids": [3], "topic": "..."}. Assert the batch saves, posts_data does not retain plan_item_ids, and the usage ledger contains the string topic. Add an assertion that a non-string angle uses the existing fallback.

~~~python
result = await persist_daily_creation_output_batch(...)
assert result["created_count"] == 1
assert "plan_item_ids" not in batch.posts_data[0]["metadata"]
~~~

- [ ] **Step 3: Write the Agent failure-state test**

Exercise the Agent execution failure transition twice and assert the first call sets status failed, stores a bounded error, and sets completed_at; the second call is idempotent and does not reopen or overwrite a terminal execution.

- [ ] **Step 4: Run only the new tests and verify RED**

Run:

~~~bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  backend/tests/test_database_init_sqlite.py -k legacy_daily_creation_plan \
  backend/tests/test_daily_creation_service.py -k metadata_compatibility \
  backend/tests/test_agent_execution_service.py -k failure_state -q
~~~

Expected: failures because the current migration leaves plan_item_ids, the service rejects the legacy metadata shape, and no idempotent Agent failure API exists.

### Task 2: Fix legacy batch schema and atomic output normalization

**Files:**
- Modify: backend/database.py
- Modify: backend/daily_creation_service.py
- Modify: backend/models.py only if a migration mapping requires it; do not add plan_item_ids back to the model.
- Test: backend/tests/test_database_init_sqlite.py and backend/tests/test_daily_creation_service.py

**Interfaces:**
- Consumes: Task 1 regression tests and the existing database initialization order.
- Produces: an idempotent migration and persist_daily_creation_output_batch behavior compatible with current and legacy Agent payloads.

- [ ] **Step 1: Add the dialect-aware legacy-column migration**

Add a migration called from init_db after the output-batch table exists. PostgreSQL should execute ALTER TABLE daily_creation_output_batches DROP COLUMN IF EXISTS plan_item_ids. SQLite should use the project’s existing dialect-compatible table migration approach. The function must be safe when the table or column is already absent.

- [ ] **Step 2: Normalize only supported metadata**

Change _normalize_agent_post to construct a new metadata dictionary from only string topic and angle values. Ignore plan_item_id, plan_item_ids, and unknown keys. Do not mutate the caller’s post object, and preserve the existing size bound for retained metadata.

~~~python
raw_metadata = post.get("metadata")
metadata = raw_metadata if isinstance(raw_metadata, dict) else {}
normalized_metadata = {
    key: value.strip()
    for key in ("topic", "angle")
    if isinstance(value := metadata.get(key), str) and value.strip()
}
~~~

- [ ] **Step 3: Preserve atomicity**

Keep the current transaction rollback behavior. Ensure no draft or usage is committed when a later post fails. Do not write legacy plan IDs.

- [ ] **Step 4: Run focused backend tests and verify GREEN**

~~~bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  backend/tests/test_database_init_sqlite.py -k 'legacy_daily_creation_plan or init_db_twice' \
  backend/tests/test_daily_creation_service.py -k 'metadata_compatibility or agent_batch_persistence' -q
~~~

Expected: all selected tests pass, including existing atomic/idempotency tests.

### Task 3: Make Agent execution failure terminal and observable

**Files:**
- Modify: backend/agent_execution_service.py
- Modify: backend/routers/agent_executions.py
- Modify: web/lib/ai/agent-execution-client.ts
- Modify: web/lib/ai/daily-creation-agent-job.ts
- Test: backend/tests/test_agent_execution_service.py
- Test: backend/tests/test_agent_executions_router.py
- Test: web/lib/ai/daily-creation-agent-job.test.ts

**Interfaces:**
- Consumes: existing worker-only Agent execution routes and runDailyCreationAgentJob dependency injection.
- Produces: failAgentExecution(jobId, executionId, error) and POST /api/agent-executions/{execution_id}/fail.

- [ ] **Step 1: Add the failing route/service test**

Create a running execution, call the failure operation twice, and assert status failed, phase failed, a bounded error, completed_at, and idempotence.

- [ ] **Step 2: Implement the service transition**

Add fail_agent_execution(session, execution_id, error). Load the execution, return it unchanged if already terminal; otherwise set status failed, phase failed, save the existing redacted error form truncated to the API limit, set completed_at, and commit.

- [ ] **Step 3: Expose the worker-only endpoint and client**

Add ExecutionFailureRequest and the route in backend/routers/agent_executions.py. Add failAgentExecution to the TypeScript client using workerHeaders(jobId).

- [ ] **Step 4: Call failure transition from the daily Agent job**

Add failExecution to DailyCreationAgentJobDependencies and default dependencies. In the catch block call it before failStep; if failure reporting itself fails, preserve the original task error and let existing worker logging/requeue behavior run.

- [ ] **Step 5: Run Agent tests**

~~~bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  backend/tests/test_agent_execution_service.py \
  backend/tests/test_agent_executions_router.py -q
pnpm exec vitest run lib/ai/daily-creation-agent-job.test.ts
~~~

Expected: all selected tests pass and the daily Agent test verifies failExecution on error.

### Task 4: Add the task-board aggregation API

**Files:**
- Modify: backend/routers/creation_rules.py
- Modify: web/lib/api/creation-rules.ts
- Test: backend/tests/test_daily_creation_rules_router.py

**Interfaces:**
- Consumes: DailyCreationRule, DailyCreationRun, ContentJob, ContentJobStep, ContentJobEvent, AgentExecution, AgentToolCall, and CollectLog.
- Produces: GET /api/creation-rules/dashboard?date=YYYY-MM-DD&limit=50 returning CreationDashboard.

- [ ] **Step 1: Write the dashboard endpoint test**

Seed one enabled rule, one queued run, one succeeded run with output count, and one failed run with a Job step error and Agent tool-call error. Call the dashboard endpoint and assert summary counts, created_count, next_run_at, rule data, run Job data, and daily_creation scheduler logs.

- [ ] **Step 2: Implement bounded date and limit parsing**

Default date to the current Asia/Shanghai date and cap limit at 100. Convert the local date range to UTC before timestamp queries. Return a stable date string in the same timezone.

- [ ] **Step 3: Batch-load related records**

Load rules and next/last run data once. Load selected runs, then fetch all linked ContentJobs, Steps, Events, AgentExecutions, AgentToolCalls, and CollectLog(job=daily_creation) with IN queries. Build maps by ID and avoid per-run database queries.

- [ ] **Step 4: Build summary and sanitized log payloads**

Count statuses, sum requested and created counts, and choose the earliest enabled rule next run. Truncate step/tool errors to 500 characters and reuse existing secret redaction. Do not return full tool inputs or model prompts.

- [ ] **Step 5: Add TypeScript response types and API function**

Define CreationDashboard, CreationDashboardRun, CreationDashboardJob, CreationDashboardStep, CreationDashboardEvent, and CreationSchedulerLog in lib/api/creation-rules.ts. Add getCreationDashboard(date?, limit?) with URL-encoded query parameters.

- [ ] **Step 6: Run API regression tests**

~~~bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  backend/tests/test_daily_creation_rules_router.py \
  backend/tests/test_daily_creation_scheduler.py -q
~~~

Expected: all selected tests pass.

### Task 5: Refactor /creation-rules into the “任务看板”

**Files:**
- Modify: web/app/creation-rules/CreationRulesClient.tsx
- Modify: web/app/creation-rules/CreationRulesPanel.tsx
- Create: web/app/creation-rules/CreationDashboard.tsx
- Create: web/app/creation-rules/CreationRunLog.tsx
- Modify: web/app/creation-rules/CreationRulesClient.test.tsx
- Create: web/app/creation-rules/CreationRunLog.test.tsx

**Interfaces:**
- Consumes: getCreationDashboard, existing rule mutation APIs, directory/Skill APIs, and current dialog props.
- Produces: heading 任务看板, five summary cards, rule management, expandable Job log, manual refresh, and 30-second dashboard refresh.

- [ ] **Step 1: Write frontend RED tests**

Mock getCreationDashboard and assert:

~~~tsx
expect(await screen.findByRole("heading", { name: "任务看板" })).toBeInTheDocument()
expect(screen.getByText("今日产出")).toBeInTheDocument()
expect(screen.getByText("运行日志")).toBeInTheDocument()
expect(screen.getByText("数据库字段不匹配")).toBeInTheDocument()
~~~

Add CreationRunLog.test.tsx with a failed run fixture. Assert the row summary is visible, error is hidden before expansion, and Job step/error appears after clicking the row.

- [ ] **Step 2: Create the dashboard summary component**

Implement CreationDashboard as a presentational component receiving dashboard.summary and rendering five accessible cards. Render zero values as values, not as missing data.

- [ ] **Step 3: Create the expandable run log component**

Implement CreationRunLog with local expanded run IDs. Each row shows rule name, scheduled time, Job ID, status, created_count/requested_count, and latest step. Use details or a button with aria-expanded; render steps, events, scheduler logs, and Agent tool summaries only when expanded.

- [ ] **Step 4: Recompose the page client**

Replace the heading with 任务看板. Fetch dashboard, directories, and Skills in parallel. Add a 30-second timer that calls only the dashboard loader. Keep editingRule independent so refresh cannot close or reset CreationRuleDialog. Wire existing mutation handlers to reload dashboard data.

- [ ] **Step 5: Preserve rule operations and empty states**

Keep CreationRulesPanel operations unchanged. Add empty states for no rules, no runs today, and failed runs with zero output. Use the labels 任务看板、定时任务、运行日志、今日产出 consistently.

- [ ] **Step 6: Run frontend tests and lint**

~~~bash
pnpm exec vitest run \
  app/creation-rules/CreationRulesClient.test.tsx \
  app/creation-rules/CreationRunLog.test.tsx \
  app/creation-rules/CreationRuleDialog.test.tsx
pnpm exec eslint \
  app/creation-rules/CreationRulesClient.tsx \
  app/creation-rules/CreationDashboard.tsx \
  app/creation-rules/CreationRunLog.tsx \
  app/creation-rules/CreationRulesPanel.tsx \
  lib/api/creation-rules.ts
~~~

Expected: selected tests pass and ESLint reports no new errors.

### Task 6: End-to-end verification and live schema check

**Files:**
- Modify: no production files unless verification exposes a scoped defect.
- Test: existing backend and frontend suites listed below.

**Interfaces:**
- Consumes: completed Tasks 1–5.
- Produces: evidence that the live schema no longer has plan_item_ids, the failed run is explainable in the UI, and a fresh manual run can persist without the legacy-column error.

- [ ] **Step 1: Run the focused backend suite**

~~~bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  backend/tests/test_daily_creation_service.py \
  backend/tests/test_daily_creation_scheduler.py \
  backend/tests/test_daily_creation_rules_router.py \
  backend/tests/test_agent_execution_service.py \
  backend/tests/test_agent_executions_router.py \
  backend/tests/test_content_jobs.py -q
~~~

- [ ] **Step 2: Run the focused frontend suite**

~~~bash
pnpm exec vitest run \
  app/creation-rules \
  lib/ai/daily-creation-agent-job.test.ts
~~~

- [ ] **Step 3: Run static checks**

~~~bash
python3 -m compileall -q \
  backend/database.py backend/daily_creation_service.py \
  backend/agent_execution_service.py backend/routers/agent_executions.py \
  backend/routers/creation_rules.py
pnpm exec tsc --noEmit
git diff --check
~~~

Record unrelated pre-existing TypeScript failures separately; do not modify unrelated worktree changes.

- [ ] **Step 4: Verify the live database read-only**

Query information_schema.columns and assert plan_item_ids is absent from daily_creation_output_batches. Confirm run 24 remains failed with zero outputs and was not automatically rerun.

- [ ] **Step 5: Browser validation**

The flow under test is:

~~~text
/creation-rules → 任务看板 → inspect dashboard cards → expand failed run → read Job step error → toggle a rule → confirm dashboard refresh
~~~

Capture page identity, meaningful DOM, console health, expanded error state, and one mobile-sized viewport when practical. Do not write screenshots or reports into the repository.

