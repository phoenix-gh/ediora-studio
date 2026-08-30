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
    for event_type, status in (("llm/request", "completed"), ("llm/error", "error")):
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


def test_agent_log_event_ingest_rejects_legacy_tool_payload(client):
    response = client.post(
        "/api/agent-logs/events",
        headers={"X-Worker-Token": TOKEN},
        json={
            "stream_kind": "job",
            "stream_key": "execution:9",
            "job_id": 5,
            "execution_id": 9,
            "event_type": "tool/call",
            "phase": "execute",
            "status": "completed",
            "payload": {"tool_call_id": "legacy-call"},
        },
    )

    assert response.status_code == 422


def test_canonical_context_events_accept_derived_turn_and_step(client):
    start = client.post(
        "/api/agent-logs/events",
        headers={"X-Worker-Token": TOKEN},
        json={
            "stream_kind": "chat",
            "stream_key": "chat:14",
            "session_id": 14,
            "turn_id": "turn-2",
            "event_type": "turn/start",
            "payload": {"turn": 2},
        },
    )
    assert start.status_code == 201, start.text

    user = client.post(
        "/api/agent-logs/events",
        headers={"X-Worker-Token": TOKEN},
        json={
            "stream_kind": "chat",
            "stream_key": "chat:14",
            "session_id": 14,
            "turn_id": "turn-2",
            "event_type": "user/message",
            "payload": {
                "content": [{"kind": "text", "text": "继续"}],
                "source": {"kind": "user"},
            },
        },
    )
    assert user.status_code == 201, user.text
    assert user.json()["data"]["turn"] == 2

    step_start = client.post(
        "/api/agent-logs/events",
        headers={"X-Worker-Token": TOKEN},
        json={
            "stream_kind": "chat",
            "stream_key": "chat:14",
            "session_id": 14,
            "turn_id": "turn-2",
            "step_id": "1",
            "event_type": "step/start",
            "payload": {"turn": 2, "step": 1, "phase": "skill_selection"},
        },
    )
    assert step_start.status_code == 201, step_start.text
    assert step_start.json()["data"]["phase"] == "skill_selection"

    request_header = client.post(
        "/api/agent-logs/events",
        headers={"X-Worker-Token": TOKEN},
        json={
            "stream_kind": "chat",
            "stream_key": "chat:14",
            "session_id": 14,
            "turn_id": "turn-2",
            "step_id": "1",
            "event_type": "request/header",
            "payload": {
                "turn": 2,
                "step": 1,
                "phase": "skill_selection",
                "request": {"toolNames": ["search_source_items"]},
            },
        },
    )
    assert request_header.status_code == 201, request_header.text
    assert request_header.json()["data"]["phase"] == "skill_selection"

    skill = client.post(
        "/api/agent-logs/events",
        headers={"X-Worker-Token": TOKEN},
        json={
            "stream_kind": "chat",
            "stream_key": "chat:14",
            "session_id": 14,
            "turn_id": "turn-2",
            "step_id": "1",
            "event_type": "agent/skill",
            "payload": {"name": "research"},
        },
    )
    assert skill.status_code == 201, skill.text
    assert skill.json()["data"] == {
        "name": "research",
        "references": [],
        "turn": 2,
        "step": 1,
    }


def test_agent_trajectory_reports_unsupported_legacy_rows(client):
    created = client.post(
        "/api/agent-logs/events",
        headers={"X-Worker-Token": TOKEN},
        json={
            "stream_kind": "chat",
            "stream_key": "chat:13",
            "session_id": 13,
            "event_type": "llm/response",
            "phase": "execute",
            "status": "completed",
            "payload": {"text": "旧格式响应"},
        },
    )
    assert created.status_code == 201, created.text

    response = client.get("/api/agent-logs/trajectory?session_id=13")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["unsupported_format"] is True
    assert body["events"] == []
