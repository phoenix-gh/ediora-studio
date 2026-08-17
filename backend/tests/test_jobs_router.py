import asyncio
import sys
from datetime import datetime, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch, postgres_env):
    monkeypatch.setenv(
        "WORKER_TOKEN",
        "test-worker-token-at-least-32-characters",
    )
    monkeypatch.setenv("WORKER_QUEUE", "api-private-content-jobs")
    for module in list(sys.modules):
        if module.startswith(("database", "models", "content_jobs", "routers.jobs")):
            sys.modules.pop(module, None)
    from database import Base, SessionLocal, engine, get_db
    import models  # noqa: F401
    import routers.jobs as jobs_module
    router = jobs_module.router

    async def no_op_enqueue(_job_id: int):
        return None

    monkeypatch.setattr(jobs_module, "enqueue_job", no_op_enqueue)

    async def setup():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.new_event_loop().run_until_complete(setup())
    app = FastAPI()
    app.include_router(router, prefix="/api")

    async def override_db():
        async with SessionLocal() as session:
            yield session

    app.dependency_overrides[get_db] = override_db
    return TestClient(app)


def test_create_job_returns_queued_job(client):
    response = client.post("/api/jobs", json={
        "flow": "draft", "title": "Test", "input": {}, "idempotency_key": "one",
    })

    assert response.status_code == 201
    assert response.json()["status"] == "queued"
    assert response.json()["id"] > 0


def test_list_jobs_returns_stable_cursor_pages(client):
    created_ids = [
        client.post("/api/jobs", json={"flow": "draft", "title": f"Job {index}", "input": {}}).json()["id"]
        for index in range(3)
    ]

    first = client.get("/api/jobs?limit=2")
    assert first.status_code == 200
    first_payload = first.json()
    assert [job["id"] for job in first_payload["jobs"]] == created_ids[::-1][:2]
    assert first_payload["has_more"] is True
    assert first_payload["next_cursor"]

    second = client.get(
        f"/api/jobs?limit=2&cursor={first_payload['next_cursor']}"
    )
    assert second.status_code == 200
    assert [job["id"] for job in second.json()["jobs"]] == [created_ids[0]]
    assert second.json()["has_more"] is False
    assert second.json()["next_cursor"] is None


def test_list_jobs_filters_scheduled_jobs_and_exposes_schedule_summary(client):
    scheduled = client.post("/api/jobs", json={
        "flow": "daily_creation", "title": "定时短帖", "input": {},
    }).json()
    manual = client.post("/api/jobs", json={
        "flow": "draft", "title": "手动草稿", "input": {},
    }).json()

    from database import SessionLocal
    from models import DailyCreationRun

    async def seed_schedule():
        async with SessionLocal() as session:
            session.add(DailyCreationRun(
                rule_id=99,
                content_job_id=scheduled["id"],
                scheduled_for=datetime(2026, 8, 6, 1, 30, tzinfo=timezone.utc),
                trigger_kind="schedule",
                requested_count=3,
                rule_snapshot={"name": "每日短帖", "directory": "产品实验"},
            ))
            await session.commit()

    asyncio.new_event_loop().run_until_complete(seed_schedule())

    scheduled_response = client.get("/api/jobs?kind=scheduled")
    assert scheduled_response.status_code == 200
    scheduled_jobs = scheduled_response.json()["jobs"]
    assert [job["id"] for job in scheduled_jobs] == [scheduled["id"]]
    assert scheduled_jobs[0]["schedule"] == {
        "run_id": 1,
        "rule_name": "每日短帖",
        "trigger_kind": "schedule",
        "scheduled_for": "2026-08-06T01:30:00+00:00",
    }

    manual_response = client.get("/api/jobs?kind=manual")
    assert manual_response.status_code == 200
    assert [job["id"] for job in manual_response.json()["jobs"]] == [manual["id"]]


def test_list_jobs_filters_by_status_and_rejects_malformed_cursor(client):
    created = client.post("/api/jobs", json={"flow": "draft", "title": "失败任务", "input": {}}).json()
    started = client.post(f"/api/jobs/{created['id']}/steps/draft/start").json()
    client.post(
        f"/api/jobs/{created['id']}/steps/{started['id']}/fail",
        json={"error": "failed", "retryable": False},
    )

    failed = client.get("/api/jobs?status=failed")
    assert failed.status_code == 200
    assert [job["id"] for job in failed.json()["jobs"]] == [created["id"]]

    malformed = client.get("/api/jobs?cursor=not-a-valid-cursor")
    assert malformed.status_code == 400


def test_create_job_enqueues_worker_execution(client, monkeypatch):
    import routers.jobs as jobs_router
    queued: list[int] = []

    async def enqueue(job_id: int):
        queued.append(job_id)

    monkeypatch.setattr(jobs_router, "enqueue_job", enqueue)
    response = client.post("/api/jobs", json={"flow": "draft", "title": "Queued", "input": {}})

    assert response.status_code == 201
    assert queued == [response.json()["id"]]


def test_retry_unknown_job_returns_404(client):
    response = client.post("/api/jobs/999/retry", json={"step_key": "draft"})

    assert response.status_code == 404


def test_retry_enqueues_job_again(client, monkeypatch):
    import routers.jobs as jobs_router
    queued: list[int] = []

    async def enqueue(job_id: int):
        queued.append(job_id)

    monkeypatch.setattr(jobs_router, "enqueue_job", enqueue)
    created = client.post("/api/jobs", json={"flow": "draft", "title": "Retry", "input": {}}).json()
    started = client.post(f"/api/jobs/{created['id']}/steps/draft/start").json()
    client.post(f"/api/jobs/{created['id']}/steps/{started['id']}/fail", json={"error": "timeout", "retryable": True})

    response = client.post(f"/api/jobs/{created['id']}/retry", json={"step_key": "draft"})

    assert response.status_code == 200
    assert queued == [created["id"], created["id"]]


def test_step_lifecycle_api_records_success(client):
    created = client.post("/api/jobs", json={"flow": "draft", "title": "Lifecycle", "input": {}}).json()
    started = client.post(f"/api/jobs/{created['id']}/steps/brief/start")

    assert started.status_code == 200
    assert started.json()["status"] == "running"

    completed = client.post(f"/api/jobs/{created['id']}/steps/{started.json()['id']}/succeed", json={"output": {"brief": "ok"}})
    assert completed.status_code == 200
    assert completed.json()["status"] == "succeeded"


def test_job_event_api_persists_auditable_generation_trace(client):
    created = client.post("/api/jobs", json={"flow": "cover", "title": "Trace", "input": {}}).json()

    response = client.post(
        f"/api/jobs/{created['id']}/events",
        json={"kind": "skill_loaded", "payload": {"skill": "baoyu-cover-image"}},
    )

    assert response.status_code == 201
    job = client.get(f"/api/jobs/{created['id']}").json()
    assert job["events"][0]["kind"] == "skill_loaded"
    assert job["events"][0]["payload"] == {"skill": "baoyu-cover-image"}


def test_job_agent_log_returns_full_message_timeline(client):
    created = client.post("/api/jobs", json={"flow": "cover", "title": "Agent log", "input": {}}).json()

    from database import SessionLocal
    from models import AgentExecution, AgentMessageLog, ContentJob

    async def seed_messages():
        async with SessionLocal() as session:
            job = await session.get(ContentJob, created["id"])
            execution = AgentExecution(
                job_id=job.id,
                status="succeeded",
                objective="create a cover",
                skill_mode="auto",
                phase="complete",
            )
            session.add(execution)
            await session.flush()
            session.add(AgentMessageLog(
                execution_id=execution.id,
                phase="execute",
                direction="model_response",
                payload_data={"text": "cover ready"},
            ))
            await session.commit()

    asyncio.new_event_loop().run_until_complete(seed_messages())

    response = client.get(f"/api/jobs/{created['id']}/agent-log")

    assert response.status_code == 200, response.text
    assert response.json()["messages"][0]["payload"]["text"] == "cover ready"


def test_worker_reconcile_requires_worker_auth_takes_no_body_and_closes_queue(
    client,
    monkeypatch,
):
    import routers.jobs as jobs_router

    calls: list[object] = []

    class FakeQueue:
        def __init__(self, *args, **kwargs):
            assert args == ()
            self.kwargs = kwargs
            calls.append(("queue-created", kwargs))

        @property
        def name(self):
            return self.kwargs.get("queue_name") or "api-private-content-jobs"

        async def __aenter__(self):
            calls.append(("queue-open", self.name))
            return self

        async def __aexit__(self, *_args):
            calls.append(("queue-closed", self.name))

    async def reconcile(queue, video_queue=None, **_kwargs):
        calls.append(("reconcile", queue.name, getattr(video_queue, "name", None)))
        return {"enqueued": 2, "job_ids": [7, 8]}

    monkeypatch.setattr(jobs_router, "RedisJobQueue", FakeQueue)
    monkeypatch.setattr(
        jobs_router,
        "reconcile_content_jobs",
        reconcile,
    )

    denied = client.post("/api/jobs/worker-reconcile")
    assert denied.status_code == 403

    response = client.post(
        "/api/jobs/worker-reconcile",
        headers={
            "X-Worker-Token":
                "test-worker-token-at-least-32-characters",
        },
    )
    assert response.status_code == 200
    assert response.json() == {"enqueued": 2, "job_ids": [7, 8]}
    assert calls == [
        ("queue-created", {}),
        ("queue-open", "api-private-content-jobs"),
        ("queue-created", {"queue_name": "content-jobs:video"}),
        ("queue-open", "content-jobs:video"),
        ("reconcile", "api-private-content-jobs", "content-jobs:video"),
        ("queue-closed", "content-jobs:video"),
        ("queue-closed", "api-private-content-jobs"),
    ]
    operation = client.app.openapi()["paths"][
        "/api/jobs/worker-reconcile"
    ]["post"]
    assert "requestBody" not in operation


def test_step_failure_marks_job_failed_and_retryable(client):
    created = client.post("/api/jobs", json={"flow": "draft", "title": "Failure", "input": {}}).json()
    started = client.post(f"/api/jobs/{created['id']}/steps/draft/start").json()

    failed = client.post(
        f"/api/jobs/{created['id']}/steps/{started['id']}/fail",
        json={"error": "provider timeout", "retryable": True},
    )

    assert failed.status_code == 200
    assert failed.json()["status"] == "failed"
    assert failed.json()["retryable"] is True
    assert client.get(f"/api/jobs/{created['id']}").json()["status"] == "failed"
