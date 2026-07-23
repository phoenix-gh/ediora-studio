# Daily Plan Draft Job Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make daily-plan enqueue create AI SDK-compatible `draft` jobs for every selected plan group.

**Architecture:** `backend/routers/daily_plan.py` continues to group plan items and assemble writing context, but passes the supported `draft` flow to the durable job bridge in `routers.studio`. The existing bridge persists and enqueues `ContentJob` records; no legacy topic flow is executed.

**Tech Stack:** FastAPI, SQLAlchemy async, Redis durable queue, pytest.

## Global Constraints

- Preserve grouped one-draft-many-account behavior and existing response schema.
- Preserve `PipelineTask` compatibility by retaining its current numeric linkage field.
- Do not modify manual, cover, illustration, or ordinary studio draft endpoints.

---

### Task 1: Route selected daily-plan items to the supported draft flow

**Files:**
- Modify: `backend/routers/daily_plan.py:188-242`
- Test: `backend/tests/test_daily_plan_router.py`

**Interfaces:**
- Consumes: `routers.studio._run_pipeline_chain(flow: str, ctx: dict, *, account_id: str, title: str)`.
- Produces: `POST /api/daily-plan/{plan_id}/enqueue` creates `ContentJob.flow == "draft"` and returns its ID in `task_ids`.

- [ ] **Step 1: Write the failing test**

```python
def test_enqueue_daily_plan_uses_draft_job(client, monkeypatch):
    plan_id, item_ids = _seed_plan(client)
    captured = []

    async def fake_run(flow, ctx, *, account_id, title):
        captured.append((flow, ctx, account_id, title))
        return EnqueueOut(content_job_id=9, task_id="9", task_ids=["9"], pipeline_task_id=9)

    monkeypatch.setattr("routers.studio._run_pipeline_chain", fake_run)
    response = client.post(f"/api/daily-plan/{plan_id}/enqueue", json={"item_ids": [item_ids[0]]})

    assert response.status_code == 200
    assert captured[0][0] == "draft"
    assert captured[0][1]["content_type"] == "long"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `conda run -n wems pytest backend/tests/test_daily_plan_router.py::test_enqueue_daily_plan_uses_draft_job -q`

Expected: FAIL because the route passes `topic_long` for a long plan item.

- [ ] **Step 3: Write minimal implementation**

Replace the flow selection and invocation with:

```python
out = await _run_pipeline_chain("draft", ctx, account_id=leader.account_id, title=leader.title)
```

Keep `ctx`, `chains`, `first_task_ids`, group membership updates, and the `PipelineTask` linkage unchanged.

- [ ] **Step 4: Run the focused regression suite**

Run: `conda run -n wems pytest backend/tests/test_daily_plan_router.py backend/tests/test_content_jobs.py -q`

Expected: PASS with the new regression test and existing daily-plan/job lifecycle tests.

- [ ] **Step 5: Commit**

```bash
git add backend/routers/daily_plan.py backend/tests/test_daily_plan_router.py
git commit -m "fix(daily-plan): enqueue supported draft jobs"
```

### Task 2: Verify the local failed job path

**Files:**
- Modify: none

**Interfaces:**
- Consumes: local API on `127.0.0.1:8000`, Redis worker, and failed daily-plan task.
- Produces: a retried job that no longer reports `Unsupported content flow: topic_long`.

- [ ] **Step 1: Restart the local Node worker**

Run the worker with `WMS_REDIS_URL=redis://127.0.0.1:6379/0` and `WMS_API_URL=http://127.0.0.1:8000/api` from `wemedia-studio`.

- [ ] **Step 2: Retry the failed job or enqueue the failed plan item again**

Use the API endpoint that created the failed `topic_long` job, then inspect `GET /api/jobs/{id}`.

- [ ] **Step 3: Verify result**

Confirm the resulting job has `flow: "draft"`; if the model completes, confirm the draft step returns a `draft_id`. Report any provider-side error verbatim.
