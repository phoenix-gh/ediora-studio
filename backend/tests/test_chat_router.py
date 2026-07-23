import asyncio
import sys
from datetime import datetime

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{tmp_path / 'chat-router.db'}")
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


def _add_searchable_sources(client):
    from models import RefMaterial, WritingPlan

    async def insert():
        async with client.app.state.session_local() as session:
            plan = WritingPlan(
                title="AI 产品研究计划",
                strategy="关注 AI 产品的发布节奏与用户反馈。",
            )
            material = RefMaterial(
                platform="manual",
                text="AI 产品发布后，用户最在意真实工作流是否变得更快。",
                source_url="https://example.com/ai-product",
                published_at=datetime(2026, 7, 23),
            )
            session.add_all([plan, material])
            await session.commit()
            await session.refresh(plan)
            await session.refresh(material)
            return plan.id, material.id

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
    assert detail.json()["title"] == "研究助手"
    assert detail.json()["messages"] == [{
        "id": appended.json()["id"],
        "role": "user",
        "parts": [{"type": "text", "text": "今天有什么新信息？"}],
        "text": "今天有什么新信息？",
        "created_at": appended.json()["created_at"],
    }]


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


def test_source_search_validates_query_and_returns_writing_plan_and_reference_material(client):
    plan_id, material_id = _add_searchable_sources(client)

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
        {
            "source": "reference_material",
            "id": material_id,
            "title": "AI 产品发布后，用户最在意真实工作流是否变得更快。",
            "summary": "AI 产品发布后，用户最在意真实工作流是否变得更快。",
            "url": "https://example.com/ai-product",
            "published_at": "2026-07-23T00:00:00",
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
