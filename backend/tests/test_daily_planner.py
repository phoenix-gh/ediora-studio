import sys, asyncio, pytest
from sqlalchemy import select


@pytest.fixture
def env(monkeypatch, tmp_path):
    db_file = tmp_path / "t.db"
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{db_file}")
    for mod in list(sys.modules):
        if mod.startswith(("database", "models", "config", "logger", "scheduler",
                            "daily_planner", "hermes_kanban_client", "pipeline_template")):
            sys.modules.pop(mod, None)
    from database import engine, Base
    import models  # noqa
    async def _setup():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    asyncio.new_event_loop().run_until_complete(_setup())


def _seed_account(**kw):
    from database import SessionLocal
    from models import PublishAccount
    defaults = dict(id="acc1", name="号一", platform="wechat",
                    positioning="AI 观察", audience="技术人", tone="犀利",
                    topic_focus=["AI"], taboo=["政治"],
                    daily_quota={"long": 1, "short": 2})
    defaults.update(kw)
    async def _mk():
        async with SessionLocal() as db:
            db.add(PublishAccount(**defaults))
            await db.commit()
    asyncio.new_event_loop().run_until_complete(_mk())


class FakeKanban:
    created: list[dict] = []
    def __init__(self, *a, **kw): pass
    async def create_task(self, *, title, body, assignee, parents=None):
        FakeKanban.created.append({"title": title, "body": body, "assignee": assignee})
        return f"t_plan_{len(FakeKanban.created)}"


@pytest.fixture
def fake_kanban(env, monkeypatch):
    FakeKanban.created = []
    import hermes_kanban_client
    monkeypatch.setattr(hermes_kanban_client, "HermesKanbanClient", FakeKanban)
    return FakeKanban


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def test_create_plan_creates_row_and_kanban_task(fake_kanban):
    _seed_account()
    from daily_planner import create_today_plan
    plan = _run(create_today_plan())
    assert plan is not None
    assert plan.status == "planning"
    assert plan.kanban_task_id == "t_plan_1"
    assert len(fake_kanban.created) == 1
    task = fake_kanban.created[0]
    assert task["assignee"] == "wms_scout"
    assert "acc1" in task["body"]            # 账号画像注入
    assert '"long": 1' in task["body"]       # 配额注入
    assert f"plan_id={plan.id}" in task["body"]


def test_same_day_idempotent(fake_kanban):
    _seed_account()
    from daily_planner import create_today_plan
    p1 = _run(create_today_plan())
    p2 = _run(create_today_plan())
    assert p2.id == p1.id
    assert len(fake_kanban.created) == 1     # 没有重复建任务


def test_force_recreates_plan_and_items(fake_kanban):
    _seed_account()
    from daily_planner import create_today_plan
    from database import SessionLocal
    from models import DailyPlanItem
    p1 = _run(create_today_plan())

    async def _add_item():
        async with SessionLocal() as db:
            db.add(DailyPlanItem(plan_id=p1.id, account_id="acc1", title="旧item"))
            await db.commit()
    _run(_add_item())

    p2 = _run(create_today_plan(force=True))
    # 注意：不能断言 p2.id != p1.id——SQLite 删掉最大 rowid 后新插入会复用同一 id
    assert p2.kanban_task_id == "t_plan_2"
    assert len(fake_kanban.created) == 2

    async def _count():
        async with SessionLocal() as db:
            return len((await db.execute(select(DailyPlanItem))).scalars().all())
    assert _run(_count()) == 0               # 旧 items 连带删除


def test_skip_when_no_quota(fake_kanban):
    _seed_account(daily_quota={})
    from daily_planner import create_today_plan
    from database import SessionLocal
    from models import DailyPlan
    plan = _run(create_today_plan())
    assert plan is None
    assert fake_kanban.created == []

    async def _count():
        async with SessionLocal() as db:
            return len((await db.execute(select(DailyPlan))).scalars().all())
    assert _run(_count()) == 0


def test_recent_draft_titles_in_body(fake_kanban):
    _seed_account()
    from database import SessionLocal
    from models import ArticleDraft

    async def _add_draft():
        async with SessionLocal() as db:
            db.add(ArticleDraft(topic_id="t1", title="昨天已写过的稿子"))
            await db.commit()
    _run(_add_draft())

    from daily_planner import create_today_plan
    _run(create_today_plan())
    assert "昨天已写过的稿子" in fake_kanban.created[0]["body"]
