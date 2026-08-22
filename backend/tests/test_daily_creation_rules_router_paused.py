import asyncio
import sys

import pytest
from fastapi.testclient import TestClient


TOKEN = "daily-creation-worker-token-at-least-32-chars"


@pytest.fixture
def client(monkeypatch, postgres_env):
    monkeypatch.setenv("WORKER_TOKEN", TOKEN)
    for module_name in list(sys.modules):
        if module_name.startswith((
            "database", "models", "main", "routers", "config", "schemas",
            "mcp_server", "daily_creation_scheduler", "daily_creation_service",
            "content_jobs", "job_queue", "scheduler",
        )):
            sys.modules.pop(module_name, None)
    from database import Base, engine
    import models  # noqa: F401

    async def setup():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.run(setup())
    from main import app
    with TestClient(app) as test_client:
        yield test_client
    asyncio.run(engine.dispose())


def test_run_now_is_available_for_a_paused_rule(client, monkeypatch):
    payload = {
        "name": "暂停后手动运行",
        "prompt": "暂停自动执行，但支持立即执行。",
        "execution_mode": "recurring",
        "scheduled_time": "09:00",
        "timezone": "Asia/Shanghai",
        "enabled": False,
    }
    enqueued = []

    async def fake_enqueue(job_id):
        enqueued.append(job_id)

    import job_queue
    monkeypatch.setattr(job_queue, "enqueue_job", fake_enqueue)

    rule = client.post("/api/creation-rules", json=payload).json()
    response = client.post(f"/api/creation-rules/{rule['id']}/run")

    assert response.status_code == 202, response.text
    assert response.json()["trigger_kind"] == "explicit"
    assert len(enqueued) == 1


def test_dashboard_marks_deleted_historical_rules_as_deleted(client, monkeypatch):
    async def fake_enqueue(_job_id):
        return None

    import job_queue
    monkeypatch.setattr(job_queue, "enqueue_job", fake_enqueue)

    rule = client.post(
        "/api/creation-rules",
        json={
            "name": "待删除规则",
            "prompt": "保留历史运行记录。",
            "execution_mode": "recurring",
            "scheduled_time": "09:00",
            "timezone": "Asia/Shanghai",
            "enabled": True,
        },
    ).json()
    run = client.post(f"/api/creation-rules/{rule['id']}/run")
    assert run.status_code == 202, run.text
    assert client.delete(f"/api/creation-rules/{rule['id']}").status_code == 204

    dashboard = client.get("/api/creation-rules/dashboard")

    assert dashboard.status_code == 200, dashboard.text
    historical = next(item for item in dashboard.json()["rules"] if item["id"] == rule["id"])
    assert historical["deleted_at"] is not None
