import sys
import asyncio
import json
from datetime import datetime, timezone, timedelta
import pytest
from fastapi.testclient import TestClient

FAKE_TOPICS = [
    {
        "title": f"选题{i}",
        "angle": f"角度{i}",
        "type": "long" if i % 2 == 0 else "short",
        "source_posts": [{"username": "@ai_user", "content": "内容片段", "url": "https://x.com/1"}],
    }
    for i in range(10)
]

LLM_JSON_RESPONSE = json.dumps(FAKE_TOPICS, ensure_ascii=False)


@pytest.fixture
def client(monkeypatch, tmp_path):
    db_file = tmp_path / "test.db"
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{db_file}")
    monkeypatch.setenv("WMS_DISABLE_SCHEDULER", "1")

    for mod in list(sys.modules):
        if mod.startswith(("database", "models", "main", "routers", "config",
                            "llm", "topic_generator")):
            sys.modules.pop(mod, None)

    from database import engine, Base
    import models  # noqa: F401

    async def _create():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    asyncio.new_event_loop().run_until_complete(_create())

    # Seed XPost rows in the past 24h
    from database import SessionLocal
    from models import XPost

    async def _seed():
        async with SessionLocal() as db:
            now = datetime.now(timezone.utc)
            for i in range(10):
                db.add(XPost(
                    tweet_id=f"tweet_{i}",
                    subscription_id=1,
                    username=f"user{i}",
                    display_name=f"User {i}",
                    content=f"AI 帖子内容 {i}，关于大模型的讨论",
                    url=f"https://x.com/user{i}/status/{i}",
                    published_at=now - timedelta(hours=i),
                    collected_at=now,
                    likes=100 - i * 5,
                    reposts=50 - i * 2,
                    replies=20,
                ))
            await db.commit()
    asyncio.new_event_loop().run_until_complete(_seed())

    # Mock llm._call
    import llm as llm_mod

    async def _fake_call(prompt, max_tokens=2048):
        return LLM_JSON_RESPONSE

    monkeypatch.setattr(llm_mod, "_call", _fake_call)

    from main import app
    return TestClient(app)


def test_generate_returns_ten_topics(client):
    r = client.post("/api/topic-generator/generate", json={"account_id": None, "sources": ["x"]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert "topics" in body
    assert len(body["topics"]) == 10
    t = body["topics"][0]
    assert "title" in t
    assert "angle" in t
    assert t["type"] in ("long", "short")
    assert isinstance(t["source_posts"], list)


def test_generate_warning_when_no_posts(monkeypatch, tmp_path):
    # Fresh empty DB — not using the `client` fixture (that one seeds 10 posts)
    db_file = tmp_path / "empty.db"
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{db_file}")
    monkeypatch.setenv("WMS_DISABLE_SCHEDULER", "1")

    for mod in list(sys.modules):
        if mod.startswith(("database", "models", "main", "routers", "config",
                            "llm", "topic_generator")):
            sys.modules.pop(mod, None)

    from database import engine, Base
    import models  # noqa: F401

    async def _create():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    asyncio.new_event_loop().run_until_complete(_create())

    import llm as llm_mod

    async def _fake_call(prompt, max_tokens=2048):
        return "[]"

    monkeypatch.setattr(llm_mod, "_call", _fake_call)

    from main import app
    from fastapi.testclient import TestClient as TC
    c = TC(app)
    r = c.post("/api/topic-generator/generate", json={"account_id": None, "sources": ["x"]})
    assert r.status_code == 200
    body = r.json()
    assert body["warning"] is not None


def test_enqueue_topic(client, monkeypatch):
    import hermes_kanban_client as hkc

    created_ids = []

    async def _fake_create(self, *, title, body, assignee, parents=None):
        created_ids.append({"title": title, "assignee": assignee, "body": body})
        return "task_001"

    monkeypatch.setattr(hkc.HermesKanbanClient, "create_task", _fake_create)

    payload = {
        "account_id": None,
        "topics": [
            {
                "title": "AI 大模型趋势深度报告",
                "angle": "从 GPT-4o 说起",
                "type": "long",
                "source_posts": [{"username": "@openai", "content": "...", "url": "https://x.com/1"}],
            }
        ],
    }
    r = client.post("/api/topic-generator/enqueue", json=payload)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["enqueued"] == 1
    assert len(created_ids) == 1
    assert created_ids[0]["assignee"] == "wms_editor"
    assert "long" in created_ids[0]["body"]
