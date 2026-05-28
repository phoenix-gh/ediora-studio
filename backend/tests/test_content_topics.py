import sys
import asyncio
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch, tmp_path):
    db_file = tmp_path / "test.db"
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{db_file}")
    monkeypatch.setenv("WMS_DISABLE_SCHEDULER", "1")

    for mod in list(sys.modules):
        if mod.startswith(("database", "models", "main", "routers", "config",
                            "schemas", "hermes_kanban_client")):
            sys.modules.pop(mod, None)

    from database import engine, Base
    import models  # noqa: F401

    async def _create():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    asyncio.new_event_loop().run_until_complete(_create())

    from main import app
    return TestClient(app)


# ── Tag CRUD ──────────────────────────────────────────────────────────────────

def test_create_tag(client):
    r = client.post("/api/content-topics/tags", json={"name": "AI"})
    assert r.status_code == 201
    data = r.json()
    assert data["name"] == "AI"
    assert data["color"].startswith("#")
    assert "id" in data


def test_create_tag_duplicate_case_insensitive(client):
    r1 = client.post("/api/content-topics/tags", json={"name": "AI"})
    assert r1.status_code == 201
    r2 = client.post("/api/content-topics/tags", json={"name": "ai"})
    assert r2.status_code == 201
    assert r1.json()["id"] == r2.json()["id"]


def test_list_tags(client):
    client.post("/api/content-topics/tags", json={"name": "创业"})
    client.post("/api/content-topics/tags", json={"name": "AI"})
    r = client.get("/api/content-topics/tags")
    assert r.status_code == 200
    names = [t["name"] for t in r.json()]
    assert "AI" in names
    assert "创业" in names


def test_delete_tag_removes_associations(client):
    tag_r = client.post("/api/content-topics/tags", json={"name": "TechTag"})
    tag_id = tag_r.json()["id"]
    topic_r = client.post("/api/content-topics", json={"title": "测试选题", "tags": ["TechTag"]})
    topic_id = topic_r.json()["id"]

    del_r = client.delete(f"/api/content-topics/tags/{tag_id}")
    assert del_r.status_code == 204

    # Topic still exists, but has no tags
    get_r = client.get(f"/api/content-topics/{topic_id}")
    assert get_r.status_code == 200
    assert get_r.json()["tags"] == []


# ── Topic CRUD ────────────────────────────────────────────────────────────────

def test_create_topic_with_tags(client):
    r = client.post("/api/content-topics", json={
        "title": "AI 一人公司",
        "brief": "调研 AI 创业案例",
        "tags": ["AI", "创业"],
        "priority": 1,
    })
    assert r.status_code == 201
    data = r.json()
    assert data["title"] == "AI 一人公司"
    assert data["brief"] == "调研 AI 创业案例"
    assert len(data["tags"]) == 2
    tag_names = {t["name"] for t in data["tags"]}
    assert tag_names == {"AI", "创业"}


def test_list_topics_flat(client):
    client.post("/api/content-topics", json={"title": "选题A", "tags": ["AI"]})
    client.post("/api/content-topics", json={"title": "选题B", "tags": ["创业"]})
    r = client.get("/api/content-topics")
    assert r.status_code == 200
    titles = {t["title"] for t in r.json()}
    assert "选题A" in titles
    assert "选题B" in titles


def test_list_topics_filter_by_tag(client):
    client.post("/api/content-topics", json={"title": "AI选题", "tags": ["AI"]})
    client.post("/api/content-topics", json={"title": "创业选题", "tags": ["创业"]})
    r = client.get("/api/content-topics?tags=AI")
    assert r.status_code == 200
    titles = [t["title"] for t in r.json()]
    assert "AI选题" in titles
    assert "创业选题" not in titles


def test_list_topics_filter_multi_tag_or_logic(client):
    client.post("/api/content-topics", json={"title": "AI选题", "tags": ["AI"]})
    client.post("/api/content-topics", json={"title": "创业选题", "tags": ["创业"]})
    client.post("/api/content-topics", json={"title": "其他选题", "tags": ["其他"]})
    r = client.get("/api/content-topics?tags=AI,创业")
    assert r.status_code == 200
    titles = {t["title"] for t in r.json()}
    assert "AI选题" in titles
    assert "创业选题" in titles
    assert "其他选题" not in titles


def test_update_topic_tags(client):
    r = client.post("/api/content-topics", json={"title": "选题", "tags": ["AI"]})
    topic_id = r.json()["id"]
    patch_r = client.patch(f"/api/content-topics/{topic_id}", json={"tags": ["创业", "产品"]})
    assert patch_r.status_code == 200
    tag_names = {t["name"] for t in patch_r.json()["tags"]}
    assert tag_names == {"创业", "产品"}


def test_delete_topic_detaches_sources(client):
    r = client.post("/api/content-topics", json={"title": "选题", "tags": []})
    topic_id = r.json()["id"]
    client.post(f"/api/content-topics/{topic_id}/sources", json={
        "topic_id": topic_id, "url": "https://example.com", "title": "来源"
    })
    del_r = client.delete(f"/api/content-topics/{topic_id}")
    assert del_r.status_code == 204
    get_r = client.get(f"/api/content-topics/{topic_id}")
    assert get_r.status_code == 404


# ── Drafts list ───────────────────────────────────────────────────────────────

def test_list_topic_drafts_empty(client):
    r = client.post("/api/content-topics", json={"title": "选题", "tags": []})
    topic_id = r.json()["id"]
    dr = client.get(f"/api/content-topics/{topic_id}/drafts")
    assert dr.status_code == 200
    assert dr.json() == []


def test_list_topic_drafts_returns_linked_drafts(client):
    from database import SessionLocal
    from models import ArticleDraft

    topic_r = client.post("/api/content-topics", json={"title": "选题", "tags": []})
    topic_id = topic_r.json()["id"]

    async def _seed_draft():
        async with SessionLocal() as db:
            d = ArticleDraft(
                topic_id="manual",
                content_topic_id=topic_id,
                title="草稿标题",
                draft_type="article",
                status="drafting",
            )
            db.add(d)
            await db.commit()
            return d.id

    draft_id = asyncio.new_event_loop().run_until_complete(_seed_draft())
    dr = client.get(f"/api/content-topics/{topic_id}/drafts")
    assert dr.status_code == 200
    assert len(dr.json()) == 1
    assert dr.json()[0]["id"] == draft_id
    assert dr.json()[0]["title"] == "草稿标题"


# ── Dispatch ──────────────────────────────────────────────────────────────────

def test_dispatch_empty_brief_returns_400(client):
    r = client.post("/api/content-topics", json={"title": "选题", "brief": "", "tags": []})
    topic_id = r.json()["id"]
    dr = client.post(f"/api/content-topics/{topic_id}/dispatch")
    assert dr.status_code == 400
    assert "Brief" in dr.json()["detail"] or "brief" in dr.json()["detail"].lower()


def test_dispatch_creates_hermes_task(client, monkeypatch):
    async def _mock_create_task(self, *, title, body, assignee, parents=None):
        assert "[调研]" in title
        assert body.strip() != ""
        assert assignee == "scout"
        return "mock-task-123"

    from hermes_kanban_client import HermesKanbanClient
    monkeypatch.setattr(HermesKanbanClient, "create_task", _mock_create_task)

    r = client.post("/api/content-topics", json={
        "title": "AI 案例调研",
        "brief": "## 调研主题\nAI 一人公司成功案例",
        "tags": [],
    })
    topic_id = r.json()["id"]
    dr = client.post(f"/api/content-topics/{topic_id}/dispatch")
    assert dr.status_code == 200
    data = dr.json()
    assert data["task_id"] == "mock-task-123"
    assert data["kanban_url"] == "/studio"


# ── Search ────────────────────────────────────────────────────────────────────

def test_search_returns_matches(client):
    client.post("/api/content-topics", json={"title": "AI 创业案例", "brief": "调研 AI 一人公司", "tags": []})
    client.post("/api/content-topics", json={"title": "健康饮食", "brief": "调研营养学", "tags": []})
    r = client.get("/api/content-topics/search?q=AI")
    assert r.status_code == 200
    titles = [t["title"] for t in r.json()]
    assert "AI 创业案例" in titles
    assert "健康饮食" not in titles


def test_search_empty_query_returns_empty(client):
    r = client.get("/api/content-topics/search?q=")
    assert r.status_code == 200
    assert r.json() == []


# ── Updates ───────────────────────────────────────────────────────────────────

def test_list_updates_empty(client):
    r = client.post("/api/content-topics", json={"title": "选题", "tags": []})
    topic_id = r.json()["id"]
    ur = client.get(f"/api/content-topics/{topic_id}/updates")
    assert ur.status_code == 200
    assert ur.json() == []


def test_list_updates_returns_entries(client):
    from database import SessionLocal
    from models import TopicUpdate

    r = client.post("/api/content-topics", json={"title": "选题", "tags": []})
    topic_id = r.json()["id"]

    async def _seed():
        async with SessionLocal() as db:
            db.add(TopicUpdate(topic_id=topic_id, description="新增角度：产品化路径", source_url="https://example.com"))
            await db.commit()

    asyncio.new_event_loop().run_until_complete(_seed())
    ur = client.get(f"/api/content-topics/{topic_id}/updates")
    assert ur.status_code == 200
    assert len(ur.json()) == 1
    assert ur.json()[0]["description"] == "新增角度：产品化路径"


# ── Analyze ───────────────────────────────────────────────────────────────────

def test_analyze_no_input_returns_400(client):
    r = client.post("/api/content-topics/analyze", json={})
    assert r.status_code == 400


def test_analyze_dispatches_task(client, monkeypatch):
    async def _mock_create_task(self, *, title, body, assignee, parents=None):
        assert assignee == "wms_scout"
        assert "content-to-topic" in body
        return "mock-analyze-task-1"

    from hermes_kanban_client import HermesKanbanClient
    monkeypatch.setattr(HermesKanbanClient, "create_task", _mock_create_task)

    r = client.post("/api/content-topics/analyze", json={"url": "https://example.com/article"})
    assert r.status_code == 200
    assert r.json()["task_id"] == "mock-analyze-task-1"
    assert r.json()["kanban_url"] == "/studio"
