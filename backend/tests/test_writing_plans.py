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
                            "schemas", "hermes_kanban_client", "mcp_server")):
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
    r = client.post("/api/writing-plans/tags", json={"name": "AI"})
    assert r.status_code == 201
    data = r.json()
    assert data["name"] == "AI"
    assert data["color"].startswith("#")
    assert "id" in data


def test_create_tag_duplicate_case_insensitive(client):
    r1 = client.post("/api/writing-plans/tags", json={"name": "AI"})
    assert r1.status_code == 201
    r2 = client.post("/api/writing-plans/tags", json={"name": "ai"})
    assert r2.status_code == 201
    assert r1.json()["id"] == r2.json()["id"]


def test_list_tags(client):
    client.post("/api/writing-plans/tags", json={"name": "创业"})
    client.post("/api/writing-plans/tags", json={"name": "AI"})
    r = client.get("/api/writing-plans/tags")
    assert r.status_code == 200
    names = [t["name"] for t in r.json()]
    assert "AI" in names
    assert "创业" in names


def test_delete_tag_removes_associations(client):
    tag_r = client.post("/api/writing-plans/tags", json={"name": "TechTag"})
    tag_id = tag_r.json()["id"]
    plan_r = client.post("/api/writing-plans", json={"title": "测试方案", "tags": ["TechTag"]})
    plan_id = plan_r.json()["id"]

    del_r = client.delete(f"/api/writing-plans/tags/{tag_id}")
    assert del_r.status_code == 204

    # Plan still exists, but has no tags
    get_r = client.get(f"/api/writing-plans/{plan_id}")
    assert get_r.status_code == 200
    assert get_r.json()["tags"] == []


# ── Plan CRUD ─────────────────────────────────────────────────────────────────

def test_create_plan_with_tags(client):
    r = client.post("/api/writing-plans", json={
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


def test_list_plans_flat(client):
    client.post("/api/writing-plans", json={"title": "方案A", "tags": ["AI"]})
    client.post("/api/writing-plans", json={"title": "方案B", "tags": ["创业"]})
    r = client.get("/api/writing-plans")
    assert r.status_code == 200
    titles = {t["title"] for t in r.json()}
    assert "方案A" in titles
    assert "方案B" in titles


def test_list_plans_filter_by_tag(client):
    client.post("/api/writing-plans", json={"title": "AI方案", "tags": ["AI"]})
    client.post("/api/writing-plans", json={"title": "创业方案", "tags": ["创业"]})
    r = client.get("/api/writing-plans?tags=AI")
    assert r.status_code == 200
    titles = [t["title"] for t in r.json()]
    assert "AI方案" in titles
    assert "创业方案" not in titles


def test_list_plans_filter_multi_tag_or_logic(client):
    client.post("/api/writing-plans", json={"title": "AI方案", "tags": ["AI"]})
    client.post("/api/writing-plans", json={"title": "创业方案", "tags": ["创业"]})
    client.post("/api/writing-plans", json={"title": "其他方案", "tags": ["其他"]})
    r = client.get("/api/writing-plans?tags=AI,创业")
    assert r.status_code == 200
    titles = {t["title"] for t in r.json()}
    assert "AI方案" in titles
    assert "创业方案" in titles
    assert "其他方案" not in titles


def test_update_plan_tags(client):
    r = client.post("/api/writing-plans", json={"title": "方案", "tags": ["AI"]})
    plan_id = r.json()["id"]
    patch_r = client.patch(f"/api/writing-plans/{plan_id}", json={"tags": ["创业", "产品"]})
    assert patch_r.status_code == 200
    tag_names = {t["name"] for t in patch_r.json()["tags"]}
    assert tag_names == {"创业", "产品"}


def test_delete_plan_detaches_sources(client):
    r = client.post("/api/writing-plans", json={"title": "方案", "tags": []})
    plan_id = r.json()["id"]
    client.post(f"/api/writing-plans/{plan_id}/sources", json={
        "plan_id": plan_id, "url": "https://example.com", "title": "来源"
    })
    del_r = client.delete(f"/api/writing-plans/{plan_id}")
    assert del_r.status_code == 204
    get_r = client.get(f"/api/writing-plans/{plan_id}")
    assert get_r.status_code == 404


# ── Drafts list ───────────────────────────────────────────────────────────────

def test_list_plan_drafts_empty(client):
    r = client.post("/api/writing-plans", json={"title": "方案", "tags": []})
    plan_id = r.json()["id"]
    dr = client.get(f"/api/writing-plans/{plan_id}/drafts")
    assert dr.status_code == 200
    assert dr.json() == []


def test_list_plan_drafts_returns_linked_drafts(client):
    from database import SessionLocal
    from models import ArticleDraft

    plan_r = client.post("/api/writing-plans", json={"title": "方案", "tags": []})
    plan_id = plan_r.json()["id"]

    async def _seed_draft():
        async with SessionLocal() as db:
            d = ArticleDraft(
                topic_id="manual",
                writing_plan_id=plan_id,
                title="草稿标题",
                draft_type="article",
                status="drafting",
            )
            db.add(d)
            await db.commit()
            return d.id

    draft_id = asyncio.new_event_loop().run_until_complete(_seed_draft())
    dr = client.get(f"/api/writing-plans/{plan_id}/drafts")
    assert dr.status_code == 200
    assert len(dr.json()) == 1
    assert dr.json()[0]["id"] == draft_id
    assert dr.json()[0]["title"] == "草稿标题"


# ── Dispatch ──────────────────────────────────────────────────────────────────

def test_dispatch_empty_brief_returns_400(client):
    r = client.post("/api/writing-plans", json={"title": "方案", "brief": "", "tags": []})
    plan_id = r.json()["id"]
    dr = client.post(f"/api/writing-plans/{plan_id}/dispatch", json={})
    assert dr.status_code == 400
    assert "Brief" in dr.json()["detail"] or "brief" in dr.json()["detail"].lower()


def test_dispatch_creates_hermes_task(client, monkeypatch):
    call_log: list[dict] = []

    async def _mock_create_task(self, *, title, body, assignee, parents=None):
        call_log.append({"title": title, "assignee": assignee, "parents": parents})
        return f"mock-task-{len(call_log)}"

    from hermes_kanban_client import HermesKanbanClient
    monkeypatch.setattr(HermesKanbanClient, "create_task", _mock_create_task)

    r = client.post("/api/writing-plans", json={
        "title": "AI 案例调研",
        "brief": "## 调研主题\nAI 一人公司成功案例",
        "tags": [],
    })
    plan_id = r.json()["id"]
    dr = client.post(f"/api/writing-plans/{plan_id}/dispatch", json={})
    assert dr.status_code == 200
    data = dr.json()
    assert data["kanban_url"] == "/studio"

    # Full pipeline: editor → writer → illustrator
    assert len(call_log) == 3
    assert "[创作]" in call_log[0]["title"]
    assert call_log[0]["assignee"] == "wms_editor"
    assert call_log[0]["parents"] is None
    assert call_log[1]["assignee"] == "wms_writer"
    assert call_log[1]["parents"] == ["mock-task-1"]
    assert call_log[2]["assignee"] == "wms_illustrator"
    assert call_log[2]["parents"] == ["mock-task-2"]
    assert data["task_id"] == "mock-task-1"  # editor task ID returned


def test_dispatch_short_plan_writer_respects_plan_wordcount(client, monkeypatch):
    """方案写的是 100-200 字短文案 → writer 任务必须按方案字数，
    不能落回账号 word_range / 长文默认，也不能强加 ≥250 字段落的长文结构规则。"""
    bodies: list[dict] = []

    async def _mock_create_task(self, *, title, body, assignee, parents=None):
        bodies.append({"assignee": assignee, "body": body})
        return f"mock-task-{len(bodies)}"

    from hermes_kanban_client import HermesKanbanClient
    monkeypatch.setattr(HermesKanbanClient, "create_task", _mock_create_task)

    r = client.post("/api/writing-plans", json={
        "title": "AI 数字商品变现",
        "brief": "## 文章模式\n拆解类短文案（100-200字），用具体案例揭示一种赚钱模式。",
        "tags": [],
    })
    plan_id = r.json()["id"]
    dr = client.post(f"/api/writing-plans/{plan_id}/dispatch", json={})
    assert dr.status_code == 200

    writer_body = next(b["body"] for b in bodies if b["assignee"] == "wms_writer")
    # 写稿被告知方案字数，不是长文默认
    assert "100-200" in writer_body
    assert "1500-2200" not in writer_body
    # 短文案结构块就位，长文的「≥1 段 ≥250 字」硬性段落规则被作废
    assert "短文案结构" in writer_body
    assert "全文必须存在 ≥1 段" not in writer_body


def test_dispatch_plan_without_wordcount_keeps_longform_rules(client, monkeypatch):
    """方案未写字数 → 回退账号 word_range 默认 + 保留长文结构规则（既有行为不回归）。"""
    bodies: list[dict] = []

    async def _mock_create_task(self, *, title, body, assignee, parents=None):
        bodies.append({"assignee": assignee, "body": body})
        return f"mock-task-{len(bodies)}"

    from hermes_kanban_client import HermesKanbanClient
    monkeypatch.setattr(HermesKanbanClient, "create_task", _mock_create_task)

    r = client.post("/api/writing-plans", json={
        "title": "AI 一人公司案例",
        "brief": "## 文章模式\n深度拆解类长文，讲清一个创业案例的来龙去脉。",
        "tags": [],
    })
    plan_id = r.json()["id"]
    dr = client.post(f"/api/writing-plans/{plan_id}/dispatch", json={})
    assert dr.status_code == 200

    writer_body = next(b["body"] for b in bodies if b["assignee"] == "wms_writer")
    assert "1500-2200" in writer_body
    assert "全文必须存在 ≥1 段" in writer_body


def test_dispatch_records_writing_plan_id_on_pipeline_task(client, monkeypatch):
    """dispatch 建的 PipelineTask 须带 writing_plan_id，供 save_draft 回链。"""
    async def _mock_create_task(self, *, title, body, assignee, parents=None):
        return "mock-task"

    from hermes_kanban_client import HermesKanbanClient
    monkeypatch.setattr(HermesKanbanClient, "create_task", _mock_create_task)

    r = client.post("/api/writing-plans", json={
        "title": "回链测试", "brief": "## 文章模式\n短文案（100-200字）", "tags": [],
    })
    plan_id = r.json()["id"]
    assert client.post(f"/api/writing-plans/{plan_id}/dispatch", json={}).status_code == 200

    from database import SessionLocal
    from models import PipelineTask
    from sqlalchemy import select

    async def _fetch():
        async with SessionLocal() as db:
            return (await db.execute(
                select(PipelineTask).where(PipelineTask.writing_plan_id == plan_id)
            )).scalars().all()

    rows = asyncio.new_event_loop().run_until_complete(_fetch())
    assert len(rows) == 1


def test_save_draft_links_draft_to_writing_plan(client):
    """save_draft 经 pipeline_task 把草稿回链到写作方案 → 方案 drafts tab 能查到。"""
    from database import SessionLocal
    from models import PipelineTask
    from mcp_server import save_draft

    plan_id = client.post("/api/writing-plans", json={"title": "方案", "tags": []}).json()["id"]

    async def _seed_pt():
        async with SessionLocal() as db:
            pt = PipelineTask(account_id="acc", title="方案", writing_plan_id=plan_id, task_ids={})
            db.add(pt)
            await db.commit()
            await db.refresh(pt)
            return pt.id

    loop = asyncio.new_event_loop()
    pt_id = loop.run_until_complete(_seed_pt())
    res = loop.run_until_complete(save_draft(
        title="回链草稿", content="正文", topic_id="agent", pipeline_task_id=pt_id,
    ))

    dr = client.get(f"/api/writing-plans/{plan_id}/drafts")
    assert dr.status_code == 200
    assert any(d["id"] == res["id"] for d in dr.json())


# ── Search ────────────────────────────────────────────────────────────────────

def test_search_returns_matches(client):
    client.post("/api/writing-plans", json={"title": "AI 创业案例", "brief": "调研 AI 一人公司", "tags": []})
    client.post("/api/writing-plans", json={"title": "健康饮食", "brief": "调研营养学", "tags": []})
    r = client.get("/api/writing-plans/search?q=AI")
    assert r.status_code == 200
    titles = [t["title"] for t in r.json()]
    assert "AI 创业案例" in titles
    assert "健康饮食" not in titles


def test_search_empty_query_returns_empty(client):
    r = client.get("/api/writing-plans/search?q=")
    assert r.status_code == 200
    assert r.json() == []


# ── Updates ───────────────────────────────────────────────────────────────────

def test_list_updates_empty(client):
    r = client.post("/api/writing-plans", json={"title": "方案", "tags": []})
    plan_id = r.json()["id"]
    ur = client.get(f"/api/writing-plans/{plan_id}/updates")
    assert ur.status_code == 200
    assert ur.json() == []


def test_list_updates_returns_entries(client):
    from database import SessionLocal
    from models import PlanUpdate

    r = client.post("/api/writing-plans", json={"title": "方案", "tags": []})
    plan_id = r.json()["id"]

    async def _seed():
        async with SessionLocal() as db:
            db.add(PlanUpdate(plan_id=plan_id, description="新增角度：产品化路径", source_url="https://example.com"))
            await db.commit()

    asyncio.new_event_loop().run_until_complete(_seed())
    ur = client.get(f"/api/writing-plans/{plan_id}/updates")
    assert ur.status_code == 200
    assert len(ur.json()) == 1
    assert ur.json()[0]["description"] == "新增角度：产品化路径"


# ── Analyze ───────────────────────────────────────────────────────────────────

def test_analyze_no_input_returns_400(client):
    r = client.post("/api/writing-plans/analyze", json={})
    assert r.status_code == 400


def test_analyze_dispatches_task(client, monkeypatch):
    async def _mock_create_task(self, *, title, body, assignee, parents=None):
        assert assignee == "wms_scout"
        assert "content-to-writing-plan" in body
        return "mock-analyze-task-1"

    from hermes_kanban_client import HermesKanbanClient
    monkeypatch.setattr(HermesKanbanClient, "create_task", _mock_create_task)

    r = client.post("/api/writing-plans/analyze", json={"url": "https://example.com/article"})
    assert r.status_code == 200
    assert r.json()["task_id"] == "mock-analyze-task-1"
    assert r.json()["kanban_url"] == "/studio"
