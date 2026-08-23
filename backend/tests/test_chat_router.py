import asyncio
import sys
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch, postgres_env):
    monkeypatch.setenv(
        "WORKER_TOKEN",
        "test-worker-token-at-least-32-characters",
    )
    for module in list(sys.modules):
        if module.startswith(("database", "models", "routers.chat")):
            sys.modules.pop(module, None)
    from database import Base, SessionLocal, engine, get_db
    import models  # noqa: F401
    import routers.chat as chat_module

    async def setup():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.new_event_loop().run_until_complete(setup())
    app = FastAPI()
    app.include_router(chat_module.router, prefix="/api")

    async def override_db():
        async with SessionLocal() as session:
            yield session

    app.dependency_overrides[get_db] = override_db
    app.state.session_local = SessionLocal
    return TestClient(app)


def _chat_pipeline_invocation(name="source-research", invocation_id="one"):
    return {
        "invocation_id": invocation_id,
        "skill_name": name,
        "skill_display_name": name,
        "skill_snapshot": {
            "name": name,
            "version": "1.0.0",
            "digest": "a" * 64,
            "source": "builtin",
        },
        "binding_snapshot": {
            "primaryOutput": "article",
            "capabilityProfile": "writing",
            "requestedAllowedTools": ["read_context"],
            "profileAllowedTools": ["read_context"],
        },
        "capability_snapshot": {
            "schemaVersion": 1,
            "mode": "job",
            "skill": {"name": name},
            "tools": [],
            "policy": {
                "approvalPolicy": "automatic",
                "allowedToolNames": ["read_context"],
            },
        },
    }


def test_chat_pipeline_creation_is_interactive_atomic_and_idempotent(client):
    session_id = client.post("/api/chat/sessions", json={}).json()["id"]
    body = {
        "client_message_id": "chat-message-1",
        "objective": "Write a sourced article",
        "title": "Chat pipeline",
        "invocations": [_chat_pipeline_invocation()],
    }

    denied = client.post(f"/api/chat/sessions/{session_id}/pipelines", json=body)
    assert denied.status_code == 403

    headers = {"X-Worker-Token": "test-worker-token-at-least-32-characters"}
    created = client.post(
        f"/api/chat/sessions/{session_id}/pipelines",
        json=body,
        headers=headers,
    )
    assert created.status_code == 201, created.text
    payload = created.json()
    assert payload["job"]["status"] == "awaiting_confirmation"
    assert payload["job"]["flow"] == "skill_pipeline"
    assert payload["user_message_id"] > 0
    assert payload["assistant_message_id"] > 0

    repeated = client.post(
        f"/api/chat/sessions/{session_id}/pipelines",
        json=body,
        headers=headers,
    )
    assert repeated.status_code == 201
    assert repeated.json()["job"]["id"] == payload["job"]["id"]
    assert repeated.json()["user_message_id"] == payload["user_message_id"]
    assert repeated.json()["assistant_message_id"] == payload["assistant_message_id"]

    detail = client.get(f"/api/chat/sessions/{session_id}")
    assert detail.status_code == 200
    messages = detail.json()["messages"]
    assert len(messages) == 2
    assert messages[1]["parts"][0]["type"] == "skill-pipeline-ref"
    assert messages[1]["parts"][0]["jobId"] == payload["job"]["id"]


def _add_searchable_sources(client):
    from models import WritingPlan

    async def insert():
        async with client.app.state.session_local() as session:
            plan = WritingPlan(
                title="AI 产品研究计划",
                strategy="关注 AI 产品的发布节奏与用户反馈。",
            )
            session.add(plan)
            await session.commit()
            await session.refresh(plan)
            return plan.id

    return asyncio.new_event_loop().run_until_complete(insert())


def test_create_session_append_message_and_get_messages_in_chronological_order(client):
    created = client.post("/api/chat/sessions", json={"title": "研究助手"})

    assert created.status_code == 201
    session_id = created.json()["id"]

    appended = client.post(
        f"/api/chat/sessions/{session_id}/messages",
        json={"role": "user", "parts": [{"type": "text", "text": "今天有什么新信息？"}], "text": "今天有什么新信息？"},
    )

    assert appended.status_code == 201
    detail = client.get(f"/api/chat/sessions/{session_id}")

    assert detail.status_code == 200
    assert detail.json()["is_running"] is False
    assert detail.json()["title"] == "研究助手"
    assert detail.json()["messages"] == [{
        "id": appended.json()["id"],
        "role": "user",
        "parts": [{"type": "text", "text": "今天有什么新信息？"}],
        "text": "今天有什么新信息？",
        "created_at": appended.json()["created_at"],
    }]


def test_session_detail_reports_an_active_chat_turn(client):
    session_id = client.post("/api/chat/sessions", json={"title": "运行中的会话"}).json()["id"]
    from models import AgentLogEvent

    async def append_event(event_type, status):
        async with client.app.state.session_local() as db:
            db.add(AgentLogEvent(
                stream_kind="chat",
                stream_key=f"chat:{session_id}",
                session_id=session_id,
                event_type=event_type,
                phase="chat",
                status=status,
            ))
            await db.commit()

    asyncio.new_event_loop().run_until_complete(append_event("session/turn-start", "running"))

    active = client.get(f"/api/chat/sessions/{session_id}")

    assert active.status_code == 200
    assert active.json()["is_running"] is True

    asyncio.new_event_loop().run_until_complete(append_event("session/turn-end", "completed"))

    completed = client.get(f"/api/chat/sessions/{session_id}")

    assert completed.json()["is_running"] is False

    asyncio.new_event_loop().run_until_complete(append_event("session/turn-start", "running"))
    asyncio.new_event_loop().run_until_complete(append_event("session/error", "error"))

    failed = client.get(f"/api/chat/sessions/{session_id}")

    assert failed.json()["is_running"] is False


def test_delete_session_removes_its_messages(client):
    created = client.post("/api/chat/sessions", json={"title": "待删除会话"})
    session_id = created.json()["id"]
    client.post(
        f"/api/chat/sessions/{session_id}/messages",
        json={"role": "user", "parts": [{"type": "text", "text": "删除我"}], "text": "删除我"},
    )

    deleted = client.delete(f"/api/chat/sessions/{session_id}")

    assert deleted.status_code == 204
    assert client.get(f"/api/chat/sessions/{session_id}").status_code == 404
    assert client.get("/api/chat/sessions").json() == []


def test_delete_missing_session_returns_404(client):
    assert client.delete("/api/chat/sessions/999999").status_code == 404


def test_renames_session(client):
    created = client.post("/api/chat/sessions", json={}).json()

    renamed = client.patch(f"/api/chat/sessions/{created['id']}", json={"title": "AI 趋势研究"})

    assert renamed.status_code == 200
    assert renamed.json()["title"] == "AI 趋势研究"


def test_replaces_assistant_message_parts_for_tool_approval(client):
    session = client.post("/api/chat/sessions", json={}).json()
    message = client.post(
        f"/api/chat/sessions/{session['id']}/messages",
        json={
            "role": "assistant",
            "parts": [{
                "type": "tool-update_draft",
                "toolCallId": "call-1",
                "state": "approval-requested",
                "approval": {"id": "approval-1"},
            }],
        },
    ).json()

    replacement = [{
        "type": "tool-update_draft",
        "toolCallId": "call-1",
        "state": "approval-responded",
        "approval": {"id": "approval-1", "approved": True},
    }]
    response = client.patch(
        f"/api/chat/sessions/{session['id']}/messages/{message['id']}",
        json={"parts": replacement},
    )

    assert response.status_code == 200
    assert response.json()["parts"] == replacement


def test_persists_a_bounded_skill_run_audit_without_reference_or_tool_bodies(client):
    session = client.post("/api/chat/sessions", json={}).json()
    audit = {
        "skillName": "Alpha",
        "activation": "automatic",
        "steps": [{
            "id": "read",
            "status": "completed",
            "evidence": ["reference:references/rules.md"],
        }],
        "loadedReferences": ["references/rules.md"],
        "toolEvidence": [{
            "toolName": "search_assets",
            "toolCallId": "call-1",
            "state": "succeeded",
        }],
        "validation": {"passed": True, "violations": []},
        "revisionCount": 0,
    }

    created = client.post(
        f"/api/chat/sessions/{session['id']}/messages",
        json={"role": "assistant", "parts": [{"type": "text", "text": "完成"}], "text": "完成", "skill_run": audit},
    )

    assert created.status_code == 201
    assert created.json()["skill_run"] == audit
    detail = client.get(f"/api/chat/sessions/{session['id']}")
    assert detail.json()["messages"][0]["skill_run"] == audit

    for invalid_audit in [
        {**audit, "referenceBodies": [{"path": "references/rules.md", "content": "secret"}]},
        {**audit, "toolOutputs": [{"toolName": "search_assets", "output": {"secret": True}}]},
        {**audit, "steps": [{"id": "x", "status": "completed", "evidence": ["x" * 501]}]},
        {**audit, "steps": [{"id": str(index), "status": "completed", "evidence": []} for index in range(13)]},
    ]:
        rejected = client.post(
            f"/api/chat/sessions/{session['id']}/messages",
            json={"role": "assistant", "skill_run": invalid_audit},
        )
        assert rejected.status_code == 422


def test_persists_capability_snapshot_without_bodies(client):
    session = client.post("/api/chat/sessions", json={}).json()
    snapshot = {
        "schemaVersion": 1,
        "mode": "chat",
        "skill": {
            "name": "Alpha",
            "version": "1.0.0",
            "source": "builtin",
            "activation": "automatic",
            "instructionsDigest": "a" * 64,
            "references": [{
                "path": "references/rules.md",
                "bytes": 32,
                "loaded": True,
                "contentDigest": "b" * 64,
            }],
        },
        "tools": [{
            "name": "search_drafts",
            "description": "Search drafts",
            "inputSchemaDigest": "c" * 64,
            "sideEffecting": False,
            "needsApproval": False,
            "replayPolicy": "replayable",
        }],
        "policy": {"approvalPolicy": "interactive", "allowedToolNames": None},
    }

    created = client.post(
        f"/api/chat/sessions/{session['id']}/messages",
        json={
            "role": "assistant",
            "parts": [{"type": "text", "text": "完成"}],
            "capability_snapshot": snapshot,
        },
    )

    assert created.status_code == 201
    returned_snapshot = created.json()["capability_snapshot"]
    assert returned_snapshot == {
        **snapshot,
        "tools": [{
            **snapshot["tools"][0],
            "concurrencyPolicy": "unknown",
            "idempotencyPolicy": "unknown",
        }],
        "policy": {"approvalPolicy": "interactive"},
    }
    assert client.get(f"/api/chat/sessions/{session['id']}").json()["messages"][0][
        "capability_snapshot"
    ] == returned_snapshot

    for invalid_snapshot in [
        {
            **snapshot,
            "skill": {
                **snapshot["skill"],
                "references": [{
                    **snapshot["skill"]["references"][0],
                    "content": "secret reference body",
                }],
            },
        },
        {**snapshot, "tools": snapshot["tools"] * 257},
        {
            **snapshot,
            "policy": {"approvalPolicy": "interactive", "allowedToolNames": ["x" * 201]},
        },
    ]:
        rejected = client.post(
            f"/api/chat/sessions/{session['id']}/messages",
            json={"role": "assistant", "capability_snapshot": invalid_snapshot},
        )
        assert rejected.status_code == 422


def test_source_search_validates_query_and_returns_writing_plan(client):
    plan_id = _add_searchable_sources(client)

    missing_query = client.get("/api/chat/sources/search")
    too_many = client.get("/api/chat/sources/search", params={"q": "AI", "limit": 21})
    response = client.get("/api/chat/sources/search", params={"q": "AI", "limit": 20})

    assert missing_query.status_code == 422
    assert too_many.status_code == 422
    assert response.status_code == 200
    assert response.json() == [
        {
            "source": "writing_plan",
            "id": plan_id,
            "title": "AI 产品研究计划",
            "summary": "关注 AI 产品的发布节奏与用户反馈。",
            "url": "",
            "published_at": response.json()[0]["published_at"],
        },
    ]


def test_writing_plan_search_and_read_include_description_when_strategy_is_present(client):
    from models import WritingPlan

    async def insert():
        async with client.app.state.session_local() as session:
            plan = WritingPlan(
                title="内容研究计划",
                strategy="追踪内容团队的长期选题策略。",
                description="重点关注只出现在描述中的独家信号。",
            )
            session.add(plan)
            await session.commit()
            await session.refresh(plan)
            return plan.id

    plan_id = asyncio.new_event_loop().run_until_complete(insert())

    search = client.get("/api/chat/sources/search", params={"q": "独家信号"})

    assert search.status_code == 200
    assert search.json()[0]["id"] == plan_id
    assert "独家信号" in search.json()[0]["summary"]

    read = client.get(f"/api/chat/sources/writing_plan/{plan_id}")

    assert read.status_code == 200
    assert "独家信号" in read.json()["content"]


def test_read_source_returns_explicit_empty_result_for_unknown_source_or_id(client):
    _add_searchable_sources(client)

    unknown_source = client.get("/api/chat/sources/unknown/1")
    unknown_id = client.get("/api/chat/sources/writing_plan/999")

    assert unknown_source.status_code == 200
    assert unknown_source.json() == {"source": "unknown", "id": 1, "found": False}
    assert unknown_id.status_code == 200
    assert unknown_id.json() == {"source": "writing_plan", "id": 999, "found": False}
