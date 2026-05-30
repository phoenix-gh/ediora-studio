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


def test_illustrate_body_strips_old_and_dispatches(client, monkeypatch):
    captured = {}

    async def fake_kanban_create(title, assignee, body, parent, env):
        captured["body"] = body
        captured["assignee"] = assignee
        return "t_illus_1"

    import routers.studio as studio
    monkeypatch.setattr(studio, "_kanban_create", fake_kanban_create)

    from database import SessionLocal
    from models import PublishAccount, ArticleDraft

    async def _seed():
        async with SessionLocal() as db:
            db.add(PublishAccount(id="acc1", name="A", platform="wechat", image_style="账号插画"))
            db.add(ArticleDraft(
                id=10, topic_id="agent", title="T",
                content="正文\n\n<!-- wms-illus -->\n![old](old.png)\n<!-- /wms-illus -->\n\n尾",
            ))
            await db.commit()
    asyncio.new_event_loop().run_until_complete(_seed())

    r = client.post("/api/studio/illustrate-body", json={
        "draft_id": 10, "account_id": "acc1", "max_images": 2,
    })
    assert r.status_code == 200, r.text
    assert r.json()["task_id"] == "t_illus_1"
    assert captured["assignee"] == "wms_illustrator"
    assert "≤ 2 个" in captured["body"]
    assert "账号插画" in captured["body"]

    async def _check():
        async with SessionLocal() as db:
            d = await db.get(ArticleDraft, 10)
            return d.content
    content = asyncio.new_event_loop().run_until_complete(_check())
    assert "old.png" not in content      # 旧自动插图已剥
    assert content == "正文\n\n尾"
