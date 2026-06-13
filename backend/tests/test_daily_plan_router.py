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


def _seed_plan(client, *, date="2026-06-12", status="ready"):
    """返回 (plan_id, item_ids)。两个账号、三条 item：acc1 两条（g1 组主笔 + 独立），acc2 一条（g1 组员）。"""
    from database import SessionLocal
    from models import DailyPlan, DailyPlanItem, PublishAccount

    async def _mk():
        async with SessionLocal() as db:
            db.add(PublishAccount(id="acc1", name="号一", positioning="AI 观察"))
            db.add(PublishAccount(id="acc2", name="号二"))
            plan = DailyPlan(plan_date=date, status=status, planner_note="今天就这些")
            db.add(plan)
            await db.commit()
            await db.refresh(plan)
            items = [
                DailyPlanItem(plan_id=plan.id, account_id="acc1", title="撞题选题",
                              angle="角度1", content_type="short", group_key="g1",
                              is_primary=True, sources=[{"platform": "x", "title": "s", "url": "u"}]),
                DailyPlanItem(plan_id=plan.id, account_id="acc2", title="撞题选题",
                              angle="角度1", content_type="short", group_key="g1",
                              is_primary=False),
                DailyPlanItem(plan_id=plan.id, account_id="acc1", title="独立长文",
                              angle="角度2", content_type="long"),
            ]
            db.add_all(items)
            await db.commit()
            return plan.id, [i.id for i in items]
    return _run(_mk())


def test_today_returns_null_when_absent(client):
    r = client.get("/api/daily-plan/today")
    assert r.status_code == 200
    assert r.json() == {"plan": None}


def test_today_returns_plan_with_items(client):
    plan_id, _ = _seed_plan(client)
    r = client.get("/api/daily-plan/today?date=2026-06-12")
    assert r.status_code == 200
    plan = r.json()["plan"]
    assert plan["id"] == plan_id
    assert plan["status"] == "ready"
    assert plan["planner_note"] == "今天就这些"
    assert len(plan["items"]) == 3
    first = [i for i in plan["items"] if i["group_key"] == "g1" and i["is_primary"]][0]
    assert first["account_name"] == "号一"
    assert first["sources"] == [{"platform": "x", "title": "s", "url": "u"}]


def test_today_backfills_draft_id_from_pipeline_task(client):
    plan_id, item_ids = _seed_plan(client)
    from database import SessionLocal
    from models import DailyPlanItem, PipelineTask

    async def _link():
        async with SessionLocal() as db:
            pt = PipelineTask(account_id="acc1", title="撞题选题", task_ids={}, draft_id=42)
            db.add(pt)
            await db.commit()
            await db.refresh(pt)
            it = await db.get(DailyPlanItem, item_ids[0])
            it.pipeline_task_id = pt.id
            it.status = "enqueued"
            await db.commit()
    _run(_link())

    r = client.get("/api/daily-plan/today?date=2026-06-12")
    item = [i for i in r.json()["plan"]["items"] if i["id"] == item_ids[0]][0]
    assert item["draft_id"] == 42


def test_skip_toggles_and_rejects_enqueued(client):
    _, item_ids = _seed_plan(client)
    r = client.post(f"/api/daily-plan/items/{item_ids[2]}/skip")
    assert r.status_code == 200 and r.json()["status"] == "skipped"
    r = client.post(f"/api/daily-plan/items/{item_ids[2]}/skip")
    assert r.status_code == 200 and r.json()["status"] == "suggested"

    from database import SessionLocal
    from models import DailyPlanItem
    async def _enqueue_it():
        async with SessionLocal() as db:
            it = await db.get(DailyPlanItem, item_ids[2])
            it.status = "enqueued"
            await db.commit()
    _run(_enqueue_it())
    r = client.post(f"/api/daily-plan/items/{item_ids[2]}/skip")
    assert r.status_code == 400
    r = client.post("/api/daily-plan/items/99999/skip")
    assert r.status_code == 404


def test_generate_force_recreates(client, monkeypatch):
    from database import SessionLocal
    from models import PublishAccount

    async def _acc():
        async with SessionLocal() as db:
            db.add(PublishAccount(id="acc1", name="号一", daily_quota={"long": 1}))
            await db.commit()
    _run(_acc())

    class FakeKanban:
        created = []
        def __init__(self, *a, **kw): pass
        async def create_task(self, *, title, body, assignee, parents=None):
            FakeKanban.created.append(title)
            return f"t_gen_{len(FakeKanban.created)}"
    FakeKanban.created = []
    import hermes_kanban_client
    monkeypatch.setattr(hermes_kanban_client, "HermesKanbanClient", FakeKanban)

    r = client.post("/api/daily-plan/generate")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "planning"
    r2 = client.post("/api/daily-plan/generate")
    assert r2.status_code == 200
    # force 重建：旧计划被删、重新建了策划任务（SQLite 会复用 rowid，不能断言 plan_id 不同）
    assert len(FakeKanban.created) == 2

    from database import SessionLocal
    from models import DailyPlan
    from sqlalchemy import select
    async def _count():
        async with SessionLocal() as db:
            return len((await db.execute(select(DailyPlan))).scalars().all())
    assert _run(_count()) == 1


def test_generate_400_when_no_quota(client):
    r = client.post("/api/daily-plan/generate")
    assert r.status_code == 400


@pytest.mark.skip(reason="Task 10 实现 dashboard alert 后启用")
def test_dashboard_alert_for_ready_plan(client, monkeypatch):
    import daily_planner
    monkeypatch.setattr(daily_planner, "today_str", lambda: "2026-06-12")
    _seed_plan(client)
    r = client.get("/api/dashboard/overview")
    assert r.status_code == 200
    texts = [a["text"] for a in r.json()["alerts"]]
    assert any("今日计划已就绪，3 条待确认" in t for t in texts)
