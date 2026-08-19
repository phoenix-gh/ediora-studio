import asyncio
import sys

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


TOKEN = "agent-execution-worker-token-at-least-32-chars"


@pytest.fixture
def client(monkeypatch, postgres_env):
    monkeypatch.setenv("WORKER_TOKEN", TOKEN)
    for module_name in list(sys.modules):
        if module_name.startswith((
            "database", "models", "agent_execution_service",
            "routers.agent_executions",
        )):
            sys.modules.pop(module_name, None)

    from database import Base, SessionLocal, engine, get_db
    import models
    import routers.agent_executions as agent_router

    async def setup():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with SessionLocal() as session:
            job = models.ContentJob(
                flow="daily_creation", title="Agent route", input_data={},
            )
            session.add(job)
            await session.commit()
            await session.refresh(job)
            return job.id

    job_id = asyncio.run(setup())
    app = FastAPI()
    app.include_router(agent_router.router, prefix="/api")

    async def override_db():
        async with SessionLocal() as session:
            yield session

    app.dependency_overrides[get_db] = override_db
    with TestClient(app) as test_client:
        yield test_client, job_id
    asyncio.run(engine.dispose())


def headers():
    return {"X-Worker-Token": TOKEN}


def test_agent_execution_routes_require_worker_auth(client):
    test_client, job_id = client

    response = test_client.post("/api/agent-executions", json={
        "job_id": job_id,
        "objective": "create posts",
        "skill_mode": "auto",
        "skill_name": None,
    })

    assert response.status_code == 403


def test_agent_execution_route_round_trips_checkpoint_and_tool_replay(client):
    test_client, job_id = client
    created = test_client.post(
        "/api/agent-executions",
        headers=headers(),
        json={
            "job_id": job_id,
            "objective": "create posts",
            "skill_mode": "auto",
            "skill_name": None,
        },
    )
    assert created.status_code == 201, created.text
    execution = created.json()
    assert execution["job_id"] == job_id
    assert execution["version"] == 1

    checkpoint = test_client.patch(
        f"/api/agent-executions/{execution['id']}/checkpoint",
        headers=headers(),
        json={
            "expected_version": 1,
            "phase": "execute",
            "checkpoint": {"parts": []},
            "audit": {"loaded_references": []},
            "capability_pin": {
                "schemaVersion": 1,
                "mode": "job",
                "skill": None,
                "tools": [],
                "policy": {"approvalPolicy": "automatic", "allowedToolNames": None},
            },
        },
    )
    assert checkpoint.status_code == 200, checkpoint.text
    assert checkpoint.json()["version"] == 2
    assert checkpoint.json()["capability_pin"]["mode"] == "job"
    conflict = test_client.patch(
        f"/api/agent-executions/{execution['id']}/checkpoint",
        headers=headers(),
        json={
            "expected_version": 1,
            "phase": "validate",
            "checkpoint": {},
            "audit": {},
        },
    )
    assert conflict.status_code == 409

    claim_url = (
        f"/api/agent-executions/{execution['id']}"
        "/tool-calls/call-save/claim"
    )
    claim_body = {
        "tool_name": "save_item",
        "input_summary": {"value": "x"},
        "auto_approved": True,
        "side_effecting": True,
    }
    assert test_client.post(
        claim_url, headers=headers(), json=claim_body,
    ).json()["action"] == "execute"
    succeeded = test_client.post(
        f"/api/agent-executions/{execution['id']}"
        "/tool-calls/call-save/succeed",
        headers=headers(),
        json={"output": {"id": 17}},
    )
    assert succeeded.status_code == 200, succeeded.text
    replay = test_client.post(
        claim_url, headers=headers(), json=claim_body,
    )
    assert replay.json() == {
        "action": "replay", "output": {"id": 17}, "error": None,
    }
    calls = test_client.get(
        f"/api/agent-executions/{execution['id']}/tool-calls",
        headers=headers(),
    )
    assert calls.status_code == 200
    assert calls.json()[0]["tool_call_id"] == "call-save"
    assert calls.json()[0]["output"] == {"id": 17}

    failed_claim_url = (
        f"/api/agent-executions/{execution['id']}"
        "/tool-calls/call-uncertain/claim"
    )
    failed_claim_body = {
        **claim_body,
        "input_summary": {"value": "different"},
    }
    assert test_client.post(
        failed_claim_url, headers=headers(), json=failed_claim_body,
    ).status_code == 200
    failed = test_client.post(
        f"/api/agent-executions/{execution['id']}"
        "/tool-calls/call-uncertain/fail",
        headers=headers(),
        json={"error": "connection lost", "uncertain": True},
    )
    assert failed.status_code == 200
    assert failed.json()["status"] == "uncertain"

    completed = test_client.post(
        f"/api/agent-executions/{execution['id']}/complete",
        headers=headers(),
        json={
            "completion_evidence": {
                "tool_name": "save_daily_creation_outputs",
                "created_count": 1,
            },
        },
    )
    assert completed.status_code == 200
    assert completed.json()["status"] == "succeeded"

    loaded = test_client.get(
        f"/api/agent-executions/by-job/{job_id}", headers=headers(),
    )
    assert loaded.status_code == 200
    assert loaded.json()["phase"] == "complete"


def test_agent_execution_route_persists_message_log(client):
    test_client, job_id = client
    created = test_client.post(
        "/api/agent-executions",
        headers=headers(),
        json={
            "job_id": job_id,
            "objective": "create posts",
            "skill_mode": "auto",
            "skill_name": None,
        },
    )
    execution_id = created.json()["id"]

    message = test_client.post(
        f"/api/agent-executions/{execution_id}/messages",
        headers=headers(),
        json={
            "phase": "execute",
            "direction": "model_request",
            "payload": {"messages": [{"role": "user", "content": "create posts"}]},
        },
    )

    assert message.status_code == 201, message.text
    assert message.json()["payload"]["messages"][0]["content"] == "create posts"


def test_agent_execution_failure_route_is_idempotent(client):
    test_client, job_id = client
    created = test_client.post(
        "/api/agent-executions",
        headers=headers(),
        json={
            "job_id": job_id,
            "objective": "create posts",
            "skill_mode": "auto",
            "skill_name": None,
        },
    )
    execution_id = created.json()["id"]

    first = test_client.post(
        f"/api/agent-executions/{execution_id}/fail",
        headers=headers(),
        json={"error": "save failed auth_token=secret"},
    )
    second = test_client.post(
        f"/api/agent-executions/{execution_id}/fail",
        headers=headers(),
        json={"error": "a later error"},
    )

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert first.json()["status"] == "failed"
    assert first.json()["phase"] == "failed"
    assert first.json()["error"] == "save failed auth_token=***"
    assert second.json()["error"] == first.json()["error"]
