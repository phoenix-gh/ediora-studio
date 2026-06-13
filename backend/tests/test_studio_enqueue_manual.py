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
                            "schemas", "hermes_kanban_client", "mcp_server", "pipeline_template")):
            sys.modules.pop(mod, None)
    from database import engine, Base
    import models  # noqa: F401

    async def _create():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    asyncio.new_event_loop().run_until_complete(_create())
    from main import app
    return TestClient(app)


@pytest.fixture
def seeded(client):
    from database import SessionLocal
    from models import PublishAccount

    async def _seed():
        async with SessionLocal() as db:
            db.add(PublishAccount(
                id="acc1", name="测试号", platform="wechat",
                positioning="AI 观察", audience="技术人", tone="犀利",
            ))
            await db.commit()
    asyncio.new_event_loop().run_until_complete(_seed())
    return client


def _patch_kanban(monkeypatch):
    calls = []

    async def fake_kanban_create(title, assignee, body, parent, env):
        calls.append({"title": title, "assignee": assignee, "body": body, "parent": parent})
        return f"t_manual_{len(calls)}"

    import routers.studio as studio
    monkeypatch.setattr(studio, "_kanban_create", fake_kanban_create)
    return calls


def test_enqueue_manual_creates_chained_tasks(seeded, monkeypatch):
    calls = _patch_kanban(monkeypatch)

    r = seeded.post("/api/studio/enqueue-manual", json={
        "account_id": "acc1",
        "title": "为什么本地优先软件又火了",
        "idea": "从 CRDT 落地难讲起",
        "genre": "tutorial",
        "note": "别写成科普",
    })
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["task_id"] == "t_manual_1"
    assert data["task_ids"] == ["t_manual_1", "t_manual_2", "t_manual_3"]

    assert [c["assignee"] for c in calls] == ["wms_editor", "wms_writer", "wms_illustrator"]
    # parent 链：editor 无 parent，后棒挂前棒
    assert calls[0]["parent"] is None
    assert calls[1]["parent"] == "t_manual_1"
    assert calls[2]["parent"] == "t_manual_2"
    # editor body 带用户输入
    assert "从 CRDT 落地难讲起" in calls[0]["body"]
    assert "别写成科普" in calls[0]["body"]


def test_enqueue_manual_persists_pipeline_task(seeded, monkeypatch):
    _patch_kanban(monkeypatch)

    r = seeded.post("/api/studio/enqueue-manual", json={
        "account_id": "acc1",
        "title": "手动主题",
    })
    assert r.status_code == 200, r.text

    from database import SessionLocal
    from models import PipelineTask
    from sqlalchemy import select as sa_select

    async def _fetch():
        async with SessionLocal() as db:
            return (await db.execute(sa_select(PipelineTask))).scalars().all()
    rows = asyncio.new_event_loop().run_until_complete(_fetch())
    assert len(rows) == 1
    row = rows[0]
    assert row.account_id == "acc1"
    assert row.title == "手动主题"
    assert row.source_url == ""
    assert row.task_ids == {
        "editor": "t_manual_1", "writer": "t_manual_2", "illustrator": "t_manual_3",
    }
    assert r.json()["pipeline_task_id"] == row.id


def test_enqueue_manual_genre_flows_into_writer_body(seeded, monkeypatch):
    calls = _patch_kanban(monkeypatch)

    r = seeded.post("/api/studio/enqueue-manual", json={
        "account_id": "acc1", "title": "手动主题", "genre": "tutorial",
    })
    assert r.status_code == 200, r.text
    writer_body = calls[1]["body"]
    assert "操作教程" in writer_body          # tutorial 结构块生效
    assert "humanizer" not in writer_body     # tutorial 不开 humanizer


def test_enqueue_manual_rejects_unknown_account(client, monkeypatch):
    _patch_kanban(monkeypatch)
    r = client.post("/api/studio/enqueue-manual", json={
        "account_id": "nope", "title": "手动主题",
    })
    assert r.status_code == 400


def test_enqueue_manual_rejects_bad_genre(seeded, monkeypatch):
    _patch_kanban(monkeypatch)
    r = seeded.post("/api/studio/enqueue-manual", json={
        "account_id": "acc1", "title": "手动主题", "genre": "poem",
    })
    assert r.status_code == 400


def test_enqueue_manual_rejects_blank_title(seeded, monkeypatch):
    _patch_kanban(monkeypatch)
    r = seeded.post("/api/studio/enqueue-manual", json={
        "account_id": "acc1", "title": "   ",
    })
    assert r.status_code == 400
