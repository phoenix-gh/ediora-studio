import asyncio
import sys
from datetime import datetime, timezone

import pytest
from sqlalchemy import func, select


@pytest.fixture
def env(monkeypatch, tmp_path):
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{tmp_path / 'creation-scheduler.db'}")
    for name in list(sys.modules):
        if name.startswith(("database", "models", "daily_planner", "content_jobs")):
            sys.modules.pop(name, None)
    from database import Base, engine
    import models  # noqa: F401

    async def setup():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.run(setup())
    yield
    asyncio.run(engine.dispose())


def test_dispatches_due_rules_once_across_modes_and_timezones(env):
    from daily_planner import dispatch_due_creation_rules
    from database import SessionLocal
    from models import ContentJob, DailyCreationRule, DailyCreationRun

    async def run():
        async with SessionLocal() as session:
            session.add_all([
                DailyCreationRule(
                    name="每日规则", asset_type="article", directory="目录甲",
                    output_type="x_short_post", target_count=2,
                    execution_mode="recurring", scheduled_time="09:00",
                    timezone="Asia/Shanghai", lookback_days=3,
                    delivery_mode="drafts",
                ),
                DailyCreationRule(
                    name="一次规则", asset_type="article", directory="目录乙",
                    output_type="x_short_post", target_count=1,
                    execution_mode="once", scheduled_date="2026-08-03",
                    scheduled_time="08:30", timezone="Asia/Shanghai",
                    lookback_days=2, delivery_mode="drafts",
                ),
                DailyCreationRule(
                    name="未来规则", asset_type="article", directory="目录丙",
                    output_type="x_short_post", target_count=1,
                    execution_mode="once", scheduled_date="2026-08-04",
                    scheduled_time="08:30", timezone="Asia/Shanghai",
                    lookback_days=2, delivery_mode="drafts",
                ),
                DailyCreationRule(
                    name="暂停规则", asset_type="article", directory="目录丁",
                    output_type="x_short_post", target_count=1,
                    execution_mode="recurring", scheduled_time="08:00",
                    timezone="Asia/Shanghai", lookback_days=2,
                    delivery_mode="drafts", enabled=False,
                ),
            ])
            await session.commit()

        enqueued = []
        async def enqueue(job_id):
            enqueued.append(job_id)

        now = datetime(2026, 8, 3, 1, 30, tzinfo=timezone.utc)
        first = await dispatch_due_creation_rules(now=now, enqueue=enqueue)
        second = await dispatch_due_creation_rules(now=now, enqueue=enqueue)

        assert first["created"] == 2
        assert second["created"] == 0
        assert len(enqueued) == 2
        async with SessionLocal() as session:
            assert await session.scalar(select(func.count(DailyCreationRun.id))) == 2
            assert await session.scalar(select(func.count(ContentJob.id))) == 2

    asyncio.run(run())


def test_recurring_rule_catches_up_latest_previous_local_day(env):
    from daily_planner import dispatch_due_creation_rules
    from database import SessionLocal
    from models import DailyCreationRule, DailyCreationRun

    async def run():
        async with SessionLocal() as session:
            session.add(DailyCreationRule(
                name="夜间创作",
                asset_type="article",
                directory="搞钱副业",
                directories=["搞钱副业"],
                output_type="x_short_post",
                target_count=10,
                execution_mode="recurring",
                scheduled_time="22:00",
                timezone="Asia/Shanghai",
                lookback_days=7,
                delivery_mode="drafts",
            ))
            await session.commit()

        enqueued = []

        async def enqueue(job_id):
            enqueued.append(job_id)

        now = datetime(2026, 8, 6, 0, 0, tzinfo=timezone.utc)
        first = await dispatch_due_creation_rules(now=now, enqueue=enqueue)
        second = await dispatch_due_creation_rules(now=now, enqueue=enqueue)

        assert first["created"] == 1
        assert second["created"] == 0
        assert len(enqueued) == 1
        async with SessionLocal() as session:
            creation_runs = list((await session.execute(
                select(DailyCreationRun)
            )).scalars().all())
            assert len(creation_runs) == 1
            scheduled_for = creation_runs[0].scheduled_for
            if scheduled_for.tzinfo is None:
                scheduled_for = scheduled_for.replace(tzinfo=timezone.utc)
            assert scheduled_for == datetime(
                2026, 8, 5, 14, 0, tzinfo=timezone.utc,
            )

    asyncio.run(run())


def test_recurring_rule_uses_today_after_local_schedule(env):
    from daily_planner import dispatch_due_creation_rules
    from database import SessionLocal
    from models import DailyCreationRule, DailyCreationRun

    async def run():
        async with SessionLocal() as session:
            session.add(DailyCreationRule(
                name="夜间创作",
                asset_type="article",
                directory="搞钱副业",
                directories=["搞钱副业"],
                output_type="x_short_post",
                target_count=10,
                execution_mode="recurring",
                scheduled_time="22:00",
                timezone="Asia/Shanghai",
                lookback_days=7,
                delivery_mode="drafts",
            ))
            await session.commit()

        enqueued = []

        async def enqueue(job_id):
            enqueued.append(job_id)

        result = await dispatch_due_creation_rules(
            now=datetime(2026, 8, 6, 15, 0, tzinfo=timezone.utc),
            enqueue=enqueue,
        )

        assert result["created"] == 1
        assert len(enqueued) == 1
        async with SessionLocal() as session:
            creation_run = await session.scalar(select(DailyCreationRun))
            scheduled_for = creation_run.scheduled_for
            if scheduled_for.tzinfo is None:
                scheduled_for = scheduled_for.replace(tzinfo=timezone.utc)
            assert scheduled_for == datetime(
                2026, 8, 6, 14, 0, tzinfo=timezone.utc,
            )

    asyncio.run(run())


def test_scheduler_registers_creation_dispatch_every_minute(env):
    from scheduler import register_jobs, scheduled_daily_creation_rules

    class Recorder:
        def __init__(self):
            self.jobs = []

        def add_job(self, function, **kwargs):
            self.jobs.append((function, kwargs))

    recorder = Recorder()
    register_jobs(recorder, {})
    matches = [kwargs for function, kwargs in recorder.jobs if function is scheduled_daily_creation_rules]
    assert len(matches) == 1
    assert matches[0]["trigger"] == "interval"
    assert matches[0]["minutes"] == 1
    assert matches[0]["id"] == "daily_creation_rules"
    assert isinstance(matches[0]["next_run_time"], datetime)
