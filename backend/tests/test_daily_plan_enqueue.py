import sys, asyncio, pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch, tmp_path):
    db_file = tmp_path / "test.db"
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{db_file}")
    monkeypatch.setenv("WMS_DISABLE_SCHEDULER", "1")
    for mod in list(sys.modules):
        if mod.startswith(("database", "models", "main", "routers", "config", "schemas",
                            "hermes_kanban_client", "mcp_server", "pipeline_template",
                            "daily_planner", "logger", "scheduler")):
            sys.modules.pop(mod, None)
    from database import engine, Base
    import models  # noqa
    async def _create():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    asyncio.new_event_loop().run_until_complete(_create())
    from main import app
    return TestClient(app)


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _patch_kanban(monkeypatch):
    calls = []
    async def fake_kanban_create(title, assignee, body, parent, env):
        calls.append({"title": title, "assignee": assignee, "body": body, "parent": parent})
        return f"t_dp_{len(calls)}"
    import routers.studio as studio
    monkeypatch.setattr(studio, "_kanban_create", fake_kanban_create)
    return calls


def _seed(client):
    """plan + 3 items：g1 组（acc1 主笔 short + acc2 组员 short）+ acc1 独立 long。"""
    from database import SessionLocal
    from models import DailyPlan, DailyPlanItem, PublishAccount

    async def _mk():
        async with SessionLocal() as db:
            db.add(PublishAccount(id="acc1", name="号一", positioning="AI 观察",
                                  audience="技术人", tone="犀利"))
            db.add(PublishAccount(id="acc2", name="号二"))
            plan = DailyPlan(plan_date="2026-06-12", status="ready")
            db.add(plan)
            await db.commit()
            await db.refresh(plan)
            items = [
                DailyPlanItem(plan_id=plan.id, account_id="acc1", title="撞题选题",
                              angle="共享角度", content_type="short", group_key="g1",
                              is_primary=True,
                              sources=[{"platform": "x", "title": "原帖", "url": "https://x.com/1"}]),
                DailyPlanItem(plan_id=plan.id, account_id="acc2", title="撞题选题",
                              angle="共享角度", content_type="short", group_key="g1",
                              is_primary=False),
                DailyPlanItem(plan_id=plan.id, account_id="acc1", title="独立长文",
                              angle="长文角度", content_type="long"),
            ]
            db.add_all(items)
            await db.commit()
            return plan.id, [i.id for i in items]
    return _run(_mk())


def _items_by_id(ids):
    from database import SessionLocal
    from models import DailyPlanItem
    async def _q():
        async with SessionLocal() as db:
            return {i: await db.get(DailyPlanItem, i) for i in ids}
    return _run(_q())


def test_enqueue_dedupes_groups_and_shares_pipeline_task(client, monkeypatch):
    calls = _patch_kanban(monkeypatch)
    plan_id, ids = _seed(client)

    r = client.post(f"/api/daily-plan/{plan_id}/enqueue", json={"item_ids": ids})
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["enqueued_items"] == 3
    assert data["chains"] == 2  # g1 组合并成一条链 + 独立 long 一条

    # topic_short 链 2 棒（writer/illustrator）+ topic_long 链 3 棒 = 5 个任务
    assert len(calls) == 5
    assignees = [c["assignee"] for c in calls]
    assert assignees.count("wms_editor") == 1      # 只有 long 链有 editor
    # 主笔角度与来源进了 writer body
    short_writer_body = [c["body"] for c in calls if "撞题选题" in c["title"]][0]
    assert "共享角度" in short_writer_body
    assert "https://x.com/1" in short_writer_body
    assert "account_id: acc1" in short_writer_body  # 用主笔账号画像写

    items = _items_by_id(ids)
    assert all(it.status == "enqueued" for it in items.values())
    # g1 组共享同一 pipeline_task_id；独立 long 不同
    assert items[ids[0]].pipeline_task_id == items[ids[1]].pipeline_task_id
    assert items[ids[2]].pipeline_task_id != items[ids[0]].pipeline_task_id


def test_enqueue_partial_group_uses_first_selected(client, monkeypatch):
    calls = _patch_kanban(monkeypatch)
    plan_id, ids = _seed(client)
    # 只选组员（主笔未选）→ 用组员账号画像建链
    r = client.post(f"/api/daily-plan/{plan_id}/enqueue", json={"item_ids": [ids[1]]})
    assert r.status_code == 200
    assert r.json()["chains"] == 1
    assert "account_id: acc2" in calls[0]["body"]
    items = _items_by_id(ids)
    assert items[ids[1]].status == "enqueued"
    assert items[ids[0]].status == "suggested"  # 未选的主笔保持原状


def test_enqueue_skips_non_suggested_and_rejects_empty(client, monkeypatch):
    _patch_kanban(monkeypatch)
    plan_id, ids = _seed(client)
    client.post(f"/api/daily-plan/items/{ids[2]}/skip")  # 长文标 skipped
    r = client.post(f"/api/daily-plan/{plan_id}/enqueue", json={"item_ids": [ids[2]]})
    assert r.status_code == 400  # 没有可入队条目
    r = client.post(f"/api/daily-plan/{plan_id}/enqueue", json={"item_ids": []})
    assert r.status_code == 400
    r = client.post("/api/daily-plan/99999/enqueue", json={"item_ids": [1]})
    assert r.status_code == 404


def test_enqueue_twice_is_safe(client, monkeypatch):
    _patch_kanban(monkeypatch)
    plan_id, ids = _seed(client)
    r1 = client.post(f"/api/daily-plan/{plan_id}/enqueue", json={"item_ids": ids})
    assert r1.status_code == 200
    r2 = client.post(f"/api/daily-plan/{plan_id}/enqueue", json={"item_ids": ids})
    assert r2.status_code == 400  # 全部已 enqueued，无可入队条目
