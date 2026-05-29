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


# ── helpers for enqueue tests ────────────────────────────────────────────────

ACCOUNT_ID = "acc_test_001"


def _make_client_with_account(monkeypatch, tmp_path):
    """Client fixture that seeds one PublishAccount."""
    db_file = tmp_path / "test_acc.db"
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{db_file}")
    monkeypatch.setenv("WMS_DISABLE_SCHEDULER", "1")

    for mod in list(sys.modules):
        if mod.startswith(("database", "models", "main", "routers", "config",
                            "llm", "topic_generator")):
            sys.modules.pop(mod, None)

    from database import engine, Base
    import models as _m

    async def _setup():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        from database import SessionLocal
        async with SessionLocal() as db:
            db.add(_m.PublishAccount(
                id=ACCOUNT_ID,
                name="测试账号",
                platform="x",
                word_range={"min": 1500, "max": 3000},
            ))
            await db.commit()

    asyncio.new_event_loop().run_until_complete(_setup())

    import llm as llm_mod

    async def _fake_call(prompt, max_tokens=2048):
        return "[]"

    monkeypatch.setattr(llm_mod, "_call", _fake_call)

    from main import app
    return TestClient(app)


def _fake_kanban(monkeypatch):
    """Patch HermesKanbanClient.create_task; returns list of call records."""
    import hermes_kanban_client as hkc
    calls = []
    _counter = {"n": 0}

    async def _fake_create(self, *, title, body, assignee, parents=None):
        _counter["n"] += 1
        calls.append({"title": title, "assignee": assignee, "parents": parents})
        return f"t_{_counter['n']:03d}"

    monkeypatch.setattr(hkc.HermesKanbanClient, "create_task", _fake_create)
    return calls


# ── tests ────────────────────────────────────────────────────────────────────

def test_enqueue_without_account_returns_400(monkeypatch, tmp_path):
    c = _make_client_with_account(monkeypatch, tmp_path)
    payload = {
        "account_id": "",
        "topics": [{"title": "T", "angle": "A", "type": "long", "source_posts": []}],
    }
    r = c.post("/api/topic-generator/enqueue", json=payload)
    assert r.status_code == 400


def test_enqueue_long_creates_three_tasks_with_parent_chain(monkeypatch, tmp_path):
    c = _make_client_with_account(monkeypatch, tmp_path)
    calls = _fake_kanban(monkeypatch)

    payload = {
        "account_id": ACCOUNT_ID,
        "topics": [{
            "title": "AI 大模型趋势深度报告",
            "angle": "GPT-4o 之后的工具链",
            "type": "long",
            "source_posts": [{"username": "@openai", "content": "...", "url": "https://x.com/1"}],
        }],
    }
    r = c.post("/api/topic-generator/enqueue", json=payload)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["enqueued"] == 1
    assert len(body["task_ids"]) == 1
    assert len(body["pipeline_task_ids"]) == 1

    assert len(calls) == 3
    assert calls[0]["assignee"] == "wms_editor"
    assert calls[1]["assignee"] == "wms_writer"
    assert calls[2]["assignee"] == "wms_illustrator"

    assert calls[0]["parents"] is None
    assert calls[1]["parents"] == ["t_001"]
    assert calls[2]["parents"] == ["t_002"]


def test_enqueue_story_creates_writer_and_illustrator(monkeypatch, tmp_path):
    c = _make_client_with_account(monkeypatch, tmp_path)
    calls = _fake_kanban(monkeypatch)

    payload = {
        "account_id": ACCOUNT_ID,
        "topics": [{
            "title": "朋友用 AI 的那一刻",
            "angle": "身边真实瞬间",
            "type": "story",
            "source_posts": [],
        }],
    }
    r = c.post("/api/topic-generator/enqueue", json=payload)
    assert r.status_code == 200, r.text
    assert len(calls) == 2
    assert calls[0]["assignee"] == "wms_writer"
    assert calls[1]["assignee"] == "wms_illustrator"
    assert calls[1]["parents"] == ["t_001"]


def test_enqueue_share_creates_writer_and_illustrator(monkeypatch, tmp_path):
    c = _make_client_with_account(monkeypatch, tmp_path)
    calls = _fake_kanban(monkeypatch)

    payload = {
        "account_id": ACCOUNT_ID,
        "topics": [{
            "title": "发现一个开源邮件系统",
            "angle": "Cloudflare 自托管邮件",
            "type": "share",
            "source_posts": [{"username": "@dev", "content": "cool tool", "url": "https://github.com/x"}],
        }],
    }
    r = c.post("/api/topic-generator/enqueue", json=payload)
    assert r.status_code == 200, r.text
    assert len(calls) == 2
    assert calls[0]["assignee"] == "wms_writer"
    assert calls[1]["assignee"] == "wms_illustrator"


def test_enqueue_short_creates_writer_and_illustrator(monkeypatch, tmp_path):
    c = _make_client_with_account(monkeypatch, tmp_path)
    calls = _fake_kanban(monkeypatch)

    payload = {
        "account_id": ACCOUNT_ID,
        "topics": [{
            "title": "X 风格短评",
            "angle": "一个核心观点",
            "type": "short",
            "source_posts": [],
        }],
    }
    r = c.post("/api/topic-generator/enqueue", json=payload)
    assert r.status_code == 200, r.text
    assert len(calls) == 2
    assert calls[0]["assignee"] == "wms_writer"
    assert calls[1]["assignee"] == "wms_illustrator"


def test_enqueue_multiple_topics_creates_independent_chains(monkeypatch, tmp_path):
    c = _make_client_with_account(monkeypatch, tmp_path)
    calls = _fake_kanban(monkeypatch)

    payload = {
        "account_id": ACCOUNT_ID,
        "topics": [
            {"title": "长文选题", "angle": "A", "type": "long", "source_posts": []},
            {"title": "短文选题", "angle": "B", "type": "short", "source_posts": []},
        ],
    }
    r = c.post("/api/topic-generator/enqueue", json=payload)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["enqueued"] == 2
    assert len(body["task_ids"]) == 2
    assert len(body["pipeline_task_ids"]) == 2
    assert len(calls) == 5  # long=3 + short=2


def test_enqueue_unknown_account_returns_400(monkeypatch, tmp_path):
    c = _make_client_with_account(monkeypatch, tmp_path)
    _fake_kanban(monkeypatch)

    payload = {
        "account_id": "nonexistent_account",
        "topics": [{"title": "T", "angle": "A", "type": "long", "source_posts": []}],
    }
    r = c.post("/api/topic-generator/enqueue", json=payload)
    assert r.status_code == 400
