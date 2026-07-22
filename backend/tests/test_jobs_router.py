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
    from routers.jobs import router

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


def test_retry_unknown_job_returns_404(client):
    response = client.post("/api/jobs/999/retry", json={"step_key": "draft"})

    assert response.status_code == 404
