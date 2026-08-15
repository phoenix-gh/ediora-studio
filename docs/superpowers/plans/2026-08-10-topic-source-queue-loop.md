# Topic Source Queue Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with verification checkpoints.

**Goal:** Prevent malformed historical `topic_source` jobs from remaining queued and being re-enqueued forever, while preserving their audit records.

**Architecture:** The backend reconciler recognizes an invalid `topic_source` payload and transitions a queued historical job to `cancelled` with an audit event instead of enqueueing it. The topic-source scheduler has the same guard as a safety net for historical jobs that already carry a dispatch event. The content worker also persists a non-retryable failure for malformed topic-source input after creating a durable step, so newly malformed jobs cannot remain queued when the worker sees them first.

**Tech Stack:** FastAPI, SQLAlchemy async sessions, PostgreSQL, Redis queue, TypeScript content worker, Vitest, pytest.

## Global Constraints

- Preserve all existing job rows and events; do not physically delete historical jobs.
- Keep valid legacy `topic_source` jobs with a positive `rule_id` runnable.
- Keep valid merged `topic_source` jobs with a positive `subscription_id` and `directory_ids` array runnable.
- Run only focused backend and frontend tests related to job reconciliation and topic-source execution.

### Task 1: Reproduce malformed historical jobs in tests

**Files:** `backend/tests/test_job_reconciliation.py`, `web/lib/ai/topic-source-job.test.ts`

- Add a backend test for an invalid queued topic-source payload and assert cancellation without enqueue.
- Add a TypeScript test for missing `rule_id`/merged fields and assert a durable non-retryable step failure.
- Run both focused tests and confirm they fail before implementation.

### Task 2: Implement durable terminal handling

**Files:** `backend/job_reconciliation.py`, `backend/topic_source_service.py`, `backend/scheduler.py`, `web/lib/ai/topic-source-job.ts`

- Validate the two supported topic-source payload shapes in the reconciler.
- Cancel invalid queued historical jobs with an explicit `job_reconciled` audit action.
- Apply the same validation in the scheduled topic-source compensation path and report cancellations.
- Move legacy payload validation inside the worker step transaction and call `failStep(..., retryable=false)` for malformed input.
- Rerun the focused tests and neighboring job-worker suites.

### Task 3: Verify queue-loop behavior

- Confirm a second reconciliation pass does not enqueue the cancelled historical job.
- Confirm valid queued jobs and valid topic-source payloads remain runnable.
- Restart the stale Worker instance and verify the affected live topic-source batch reaches a terminal state.
- Run focused tests and `git diff --check`; report that existing live rows converge on the next reconciliation/startup pass and are not deleted.
