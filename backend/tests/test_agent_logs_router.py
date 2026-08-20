import asyncio
import sys

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


TOKEN = "agent-log-worker-token-at-least-32-chars"


@pytest.fixture
def client(monkeypatch, postgres_env):
    monkeypatch.setenv("WORKER_TOKEN", TOKEN)
    for module_name in list(sys.modules):
        if module_name.startswith((
            "database", "models", "agent_log_service", "routers.agent_logs",
        )):
            sys.modules.pop(module_name, None)

    from database import Base, SessionLocal, engine, get_db
    import models  # noqa: F401
    import routers.agent_logs as agent_logs_router

    async def setup():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.run(setup())
    app = FastAPI()
    app.include_router(agent_logs_router.router, prefix="/api")

    async def override_db():
        async with SessionLocal() as session:
            yield session

    app.dependency_overrides[get_db] = override_db
    try:
        with TestClient(app) as test_client:
            yield test_client
    finally:
        asyncio.run(engine.dispose())


def test_agent_log_event_ingest_requires_worker_auth(client):
    response = client.post("/api/agent-logs/events", json={
        "stream_kind": "chat",
        "stream_key": "chat:1",
        "session_id": 1,
        "event_type": "llm/request",
        "phase": "execute",
        "payload": {"prompt": "hello"},
    })

    assert response.status_code == 403


def test_agent_log_event_ingest_requires_stream_scope(client):
    response = client.post(
        "/api/agent-logs/events",
        headers={"X-Worker-Token": TOKEN},
        json={
            "stream_kind": "job",
            "stream_key": "job:missing-scope",
            "event_type": "session/turn-start",
        },
    )

    assert response.status_code == 422


def test_agent_log_event_ingest_and_query_return_typed_stream(client):
    created = client.post(
        "/api/agent-logs/events",
        headers={"X-Worker-Token": TOKEN},
        json={
            "stream_kind": "chat",
            "stream_key": "chat:12",
            "session_id": 12,
            "turn_id": "turn-1",
            "event_type": "llm/response",
            "phase": "execute",
            "status": "completed",
            "payload": {"text": "answer", "api_key": "secret"},
            "usage": {"inputTokens": 3},
            "duration_ms": 42,
        },
    )
    assert created.status_code == 201, created.text
    assert created.json()["payload"]["api_key"] == "***"

    response = client.get("/api/agent-logs?session_id=12&event_type=llm/response")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["has_more"] is False
    assert body["events"][0]["stream_kind"] == "chat"
    assert body["events"][0]["sequence"] == created.json()["sequence"]
    assert body["events"][0]["usage"] == {"inputTokens": 3}


def test_agent_log_global_query_can_filter_job_errors(client):
    for event_type, status in (("tool/call", "completed"), ("llm/error", "error")):
        response = client.post(
            "/api/agent-logs/events",
            headers={"X-Worker-Token": TOKEN},
            json={
                "stream_kind": "job",
                "stream_key": "execution:8",
                "job_id": 5,
                "execution_id": 8,
                "event_type": event_type,
                "phase": "execute",
                "status": status,
                "payload": {"event_type": event_type},
            },
        )
        assert response.status_code == 201

    response = client.get("/api/agent-logs?job_id=5&status=error")

    assert response.status_code == 200
    assert [event["event_type"] for event in response.json()["events"]] == ["llm/error"]
