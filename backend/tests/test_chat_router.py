import asyncio
import sys

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
    return TestClient(app)


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
