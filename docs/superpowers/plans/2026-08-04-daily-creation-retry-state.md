# Daily Creation Retry State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore a failed daily-creation Run when its retryable Job step is retried and audit MCP error results as failures.

**Architecture:** Keep persistence eligibility strict and repair state at the retry boundary. Normalize MCP error-result semantics once in the global Agent tool policy so every Skill and Agent consumer receives accurate audit status.

**Tech Stack:** Python 3.11, SQLAlchemy async ORM, pytest, TypeScript, Vitest, AI SDK ToolSet.

## Global Constraints

- Do not permit persistence for a Run that has not been explicitly retried.
- Restore Job and Run in the same database transaction.
- Return MCP `isError: true` results to the model, but never audit them as succeeded.
- Run only tests directly related to the changed code paths.

---

### Task 1: Restore Daily Creation Run on Retry

**Files:**
- Modify: `backend/tests/test_content_jobs.py`
- Modify: `backend/content_jobs.py:621-660`

**Interfaces:**
- Consumes: `retry_locked_step(session, job, previous)` and `DailyCreationRun` linked through `job.input_data["run_id"]`.
- Produces: a queued Run with cleared `detail` and `completed_at` whenever a failed daily-creation Job is queued for another attempt.

- [ ] Add a test that creates a daily-creation Job and Run, fails the Agent step, retries it, and asserts Job, new step, and Run are queued while Run error state is cleared.
- [ ] Run only that test and confirm it fails because Run remains failed.
- [ ] Add the daily-creation restoration branch inside `retry_locked_step` before flush.
- [ ] Run the new test plus existing retry-focused content-job tests and confirm they pass.

### Task 2: Audit MCP Error Results as Failed

**Files:**
- Modify: `web/lib/ai/agent-tool-policy.test.ts`
- Modify: `web/lib/ai/agent-tool-policy.ts`

**Interfaces:**
- Consumes: a tool execution result shaped as `{ isError: true, content: [...] }`.
- Produces: a failed `AgentToolAudit` containing bounded output and extracted error text while returning the original result to the model.

- [ ] Add a test whose real wrapped tool returns an MCP error result; assert the caller receives that result and the final audit status is failed rather than succeeded.
- [ ] Run only the tool-policy test and confirm the new assertion fails with status succeeded.
- [ ] Add a narrow MCP error-result detector and use it after tool execution and durable replay.
- [ ] Run tool-policy, daily-creation Agent job, Agent runtime, and Skill-run tests; confirm all related tests pass.

### Task 3: Verify and Commit

**Files:**
- Verify only the four implementation/test files above.

**Interfaces:**
- Consumes: both completed fixes.
- Produces: one scoped commit with no unrelated worktree changes.

- [ ] Run Python compile checks, targeted ESLint, and `git diff --check`.
- [ ] Inspect the staged diff and commit only the four implementation/test files.
- [ ] Retry Job `746` after repairing its now non-retryable failed step/run state, then verify Agent completion evidence and 10 persisted outputs.
