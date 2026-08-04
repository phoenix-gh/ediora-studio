# Daily Creation Draft Usage Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Release a daily-creation source asset from recent-use deduplication when its generated draft is deleted.

**Architecture:** Extend the existing draft deletion transaction to remove only `ContentUsageLedger` rows bound to that draft and output kind. Keep task, run, Agent execution, and output-batch audit records unchanged.

**Tech Stack:** FastAPI, SQLAlchemy async ORM, pytest, SQLite test database.

## Global Constraints

- Only usage rows with `output_kind="draft"` and the deleted `draft_id` may be removed.
- Draft deletion and usage deletion must commit atomically.
- Creative assets and execution audit records must remain unchanged.
- Existing draft-image deletion behavior must remain intact.

---

### Task 1: Release Daily-Creation Usage During Draft Deletion

**Files:**
- Create: `backend/tests/test_drafts_router.py`
- Modify: `backend/routers/drafts.py:17-18,447-467`

**Interfaces:**
- Consumes: `ContentUsageLedger.output_kind`, `ContentUsageLedger.draft_id`, and the existing `DELETE /api/drafts/{draft_id}` endpoint.
- Produces: deletion semantics in which matching usage disappears in the same commit as the draft.

- [ ] **Step 1: Write the failing daily-creation regression test**

Create an isolated FastAPI/SQLite fixture that imports `routers.drafts`, seeds an `ArticleDraft`, a matching `ContentUsageLedger`, and minimal retained audit records. Delete through `/api/drafts/{draft_id}` and assert:

```python
assert response.status_code == 204
assert await session.get(ArticleDraft, draft_id) is None
assert await session.get(ContentUsageLedger, usage_id) is None
assert await session.get(DailyCreationRun, run_id) is not None
assert await session.get(DailyCreationOutputBatch, batch_id) is not None
```

- [ ] **Step 2: Write the unrelated-usage safety test**

Seed a normal draft and a usage row bound to a different draft ID, delete the normal draft, and assert:

```python
assert response.status_code == 204
assert await session.get(ContentUsageLedger, unrelated_usage_id) is not None
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
conda run --no-capture-output -n wems python -m pytest -q backend/tests/test_drafts_router.py
```

Expected: the matching usage assertion fails because the current endpoint deletes only the draft and images. The unrelated-usage test passes.

- [ ] **Step 4: Implement the minimal transactional deletion**

Import `delete` and `ContentUsageLedger`, then execute this statement before deleting the draft and before the endpoint's existing single commit:

```python
await db.execute(
    delete(ContentUsageLedger).where(
        ContentUsageLedger.output_kind == "draft",
        ContentUsageLedger.draft_id == draft_id,
    )
)
```

- [ ] **Step 5: Run focused and related tests and verify GREEN**

Run:

```bash
conda run --no-capture-output -n wems python -m pytest -q backend/tests/test_drafts_router.py backend/tests/test_daily_creation_service.py
```

Expected: all selected tests pass with no errors.

- [ ] **Step 6: Run static and diff checks**

Run:

```bash
conda run --no-capture-output -n wems python -m compileall -q backend/routers/drafts.py backend/tests/test_drafts_router.py
git diff --check -- backend/routers/drafts.py backend/tests/test_drafts_router.py
```

Expected: both commands exit successfully with no output.

- [ ] **Step 7: Commit only the implementation files**

```bash
git add backend/routers/drafts.py backend/tests/test_drafts_router.py docs/superpowers/plans/2026-08-04-daily-creation-draft-usage-release.md
git commit -m "fix: release daily creation usage with draft"
```
