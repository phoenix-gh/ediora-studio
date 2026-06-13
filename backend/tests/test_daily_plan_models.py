import sys, asyncio, pytest
from sqlalchemy import select


@pytest.fixture
def env(monkeypatch, tmp_path):
    db_file = tmp_path / "t.db"
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{db_file}")
    for mod in list(sys.modules):
        if mod.startswith(("database", "models", "config")):
            sys.modules.pop(mod, None)
    from database import engine, Base
    import models  # noqa
    async def _setup():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    asyncio.new_event_loop().run_until_complete(_setup())


def test_daily_plan_roundtrip_and_defaults(env):
    from database import SessionLocal
    from models import DailyPlan, DailyPlanItem, PublishAccount

    async def _run():
        async with SessionLocal() as db:
            db.add(PublishAccount(id="acc1", name="号一",
                                  daily_quota={"long": 1, "short": 2}))
            plan = DailyPlan(plan_date="2026-06-12")
            db.add(plan)
            await db.commit()
            await db.refresh(plan)
            db.add(DailyPlanItem(plan_id=plan.id, account_id="acc1",
                                 title="选题A", content_type="long",
                                 group_key="g1", is_primary=True))
            await db.commit()

            acc = await db.get(PublishAccount, "acc1")
            assert acc.daily_quota == {"long": 1, "short": 2}
            assert plan.status == "planning"
            assert plan.kanban_task_id == ""
            item = (await db.execute(select(DailyPlanItem))).scalars().one()
            assert item.status == "suggested"
            assert item.sources == []
            assert item.pipeline_task_id is None
            assert item.draft_id is None
    asyncio.new_event_loop().run_until_complete(_run())


def test_plan_date_unique(env):
    from sqlalchemy.exc import IntegrityError
    from database import SessionLocal
    from models import DailyPlan

    async def _run():
        async with SessionLocal() as db:
            db.add(DailyPlan(plan_date="2026-06-12"))
            await db.commit()
            db.add(DailyPlan(plan_date="2026-06-12"))
            with pytest.raises(IntegrityError):
                await db.commit()
    asyncio.new_event_loop().run_until_complete(_run())


def test_publish_account_schemas_carry_daily_quota(env):
    from schemas import PublishAccountCreate, PublishAccountOut, PublishAccountUpdate
    c = PublishAccountCreate(id="a", name="n")
    assert c.daily_quota == {}
    u = PublishAccountUpdate(daily_quota={"long": 1})
    assert u.model_dump(exclude_none=True) == {"daily_quota": {"long": 1}}
    assert "daily_quota" in PublishAccountOut.model_fields
