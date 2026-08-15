# Daily Creation Agent-Only Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the shared Agent runtime the only daily-creation executor, remove version compatibility and the old Runner, and clear existing daily-creation task history.

**Architecture:** Dispatch is based only on `ContentJob.flow`; `daily_creation` maps directly to `runDailyCreationAgentJob`. Backend job creation and reconciliation no longer carry or inspect a runtime version. Existing daily-creation execution records are removed once with a scoped transaction while generated content and semantic-usage evidence remain.

**Tech Stack:** TypeScript, Vitest, Next.js worker, Python, SQLAlchemy, pytest, PostgreSQL.

## Global Constraints

- Do not modify or delete jobs whose flow is not `daily_creation`.
- Preserve generated drafts, plan items, assets, and `content_usage_ledger`.
- Do not add a startup cleanup that could delete future jobs.
- Preserve unrelated user changes in the current mixed worktree.

---

### Task 1: Lock the version-free backend contract

**Files:**
- Modify: `backend/tests/test_daily_creation_service.py`
- Modify: `backend/tests/test_daily_creation_rules_router.py`
- Modify: `backend/tests/test_job_reconciliation.py`
- Modify: `backend/daily_creation_service.py`
- Modify: `backend/job_reconciliation.py`

**Interfaces:**
- Consumes: `create_daily_creation_run(...)->(DailyCreationRun, bool)` and job reconciliation decisions.
- Produces: daily job input `{ "run_id": int }` and unconditional Agent resume for active `daily_creation` jobs.

- [ ] Change the job-creation assertions to require the literal payload `{ "run_id": run.id }`.
- [ ] Add a reconciliation case where a version-free daily job is queued/running and must be enqueued with reason `agent_runtime_resume`.
- [ ] Run the focused pytest cases and verify they fail because production still writes/checks `runtime_version`.
- [ ] Remove the version field from job creation and the version condition from reconciliation.
- [ ] Re-run the focused pytest cases and verify they pass.

### Task 2: Make Agent dispatch unconditional

**Files:**
- Modify: `web/scripts/content-worker.test.ts`
- Modify: `web/scripts/content-worker.ts`
- Modify: `web/lib/ai/daily-creation-agent-job.test.ts`
- Modify: `web/lib/ai/daily-creation-agent-integration.test.ts`
- Modify: `web/lib/ai/content-job.ts`
- Modify: `web/lib/ai/content-job.test.ts`
- Delete: `web/lib/ai/daily-creation-job.ts`
- Delete: `web/lib/ai/daily-creation-job.test.ts`

**Interfaces:**
- Consumes: `resolveContentJobRunner(flow, dependencies)`.
- Produces: `resolveContentJobRunner('daily_creation') === runDailyCreationAgentJob` for every daily job.

- [ ] Update the worker dispatch test to resolve a daily job without a version and expect the Agent Runner.
- [ ] Update the worker loop test to assert dispatch receives no runtime-version dependency.
- [ ] Run the focused Vitest file and verify failure against the compatibility branch.
- [ ] Remove `runtimeVersion`, `UnsupportedDailyCreationRuntimeError`, the legacy import/fallback, and version forwarding.
- [ ] Update Agent fixtures to `{ run_id }`; delete the legacy Runner and its tests.
- [ ] Remove legacy daily-selection, batch-parser, and validation helpers from `content-job.ts` together with their obsolete tests.
- [ ] Re-run worker and Agent tests and verify they pass.

### Task 3: Verify the code cutover

**Files:**
- Verify all files modified by Tasks 1 and 2.

**Interfaces:**
- Consumes: repository source and targeted test commands.
- Produces: evidence that no old daily runtime remains.

- [ ] Search the repository for `runtime_version`, `runtimeVersion`, `runDailyCreationJob`, and `UnsupportedDailyCreationRuntimeError`; require no production/test hits.
- [ ] Run the focused backend daily-creation/reconciliation tests.
- [ ] Run the worker, Agent runtime, Agent integration, and related daily-creation frontend tests.
- [ ] Run broader backend and frontend test suites if focused suites are green; report unrelated failures separately with exact evidence.

### Task 4: Clear existing daily-creation task history

**Files:**
- No repository files; execute one explicit transaction against the live development PostgreSQL database.

**Interfaces:**
- Consumes: `content_jobs.flow = 'daily_creation'` and linked IDs.
- Produces: zero stored daily jobs/runs/executions while preserving all non-daily jobs and content outputs.

- [ ] Capture counts for matching jobs, runs, steps, events, executions, tool calls, output batches, and all non-daily jobs.
- [ ] In one transaction, delete linked tool calls, executions, events, steps, output batches, runs, and daily jobs in dependency order.
- [ ] Verify daily job/run/execution counts are zero and the non-daily job count is unchanged.
- [ ] Verify generated drafts and usage-ledger counts are unchanged.

### Task 5: Final audit

**Files:**
- Verify: `git diff`, targeted source paths, and live database counts.

**Interfaces:**
- Consumes: the approved design requirements.
- Produces: requirement-by-requirement completion evidence.

- [ ] Confirm only task-scoped files changed beyond the user's pre-existing dirty worktree.
- [ ] Confirm new daily jobs cannot select the old Runner because it no longer exists.
- [ ] Confirm all existing daily task records were removed without deleting generated content or other flow history.
- [ ] Summarize tests, database counts, and any unrelated baseline failures.
