import asyncio
import sys

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{tmp_path / 'jobs-router.db'}")
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


def test_step_lifecycle_api_records_success(client):
    created = client.post("/api/jobs", json={"flow": "draft", "title": "Lifecycle", "input": {}}).json()
    started = client.post(f"/api/jobs/{created['id']}/steps/brief/start")

    assert started.status_code == 200
    assert started.json()["status"] == "running"

    completed = client.post(f"/api/jobs/{created['id']}/steps/{started.json()['id']}/succeed", json={"output": {"brief": "ok"}})
    assert completed.status_code == 200
    assert completed.json()["status"] == "succeeded"


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
