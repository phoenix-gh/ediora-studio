import asyncio
import sys

import pytest


@pytest.fixture
def session_factory(monkeypatch, tmp_path):
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{tmp_path / 'jobs.db'}")
    for module in list(sys.modules):
        if module.startswith(("database", "models", "content_jobs")):
            sys.modules.pop(module, None)

    from database import Base, SessionLocal, engine
    import models  # noqa: F401

    async def setup():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.new_event_loop().run_until_complete(setup())
    return SessionLocal


def test_retrying_failed_step_preserves_completed_steps(session_factory):
    from content_jobs import create_job, fail_step, retry_step, start_step, succeed_step

    async def run():
        async with session_factory() as session:
            job = await create_job(session, flow="draft", title="T", input_data={})
            brief = await start_step(session, job.id, "brief")
            await succeed_step(session, brief.id, {"brief": "ok"})
            draft = await start_step(session, job.id, "draft")
            await fail_step(session, draft.id, "provider timeout", retryable=True)

            retry = await retry_step(session, job.id, "draft")

            assert retry.attempt == 2
            assert retry.status == "queued"
            assert brief.status == "succeeded"

    asyncio.new_event_loop().run_until_complete(run())


def test_cancelling_queued_job_marks_job_cancelled(session_factory):
    from content_jobs import cancel_job, create_job

    async def run():
        async with session_factory() as session:
            job = await create_job(session, flow="draft", title="T", input_data={})
            await cancel_job(session, job.id)
            assert job.status == "cancelled"

    asyncio.new_event_loop().run_until_complete(run())


def test_completed_step_cannot_be_started_again(session_factory):
    from content_jobs import InvalidJobTransition, create_job, start_step, succeed_step

    async def run():
        async with session_factory() as session:
            job = await create_job(session, flow="draft", title="T", input_data={})
            step = await start_step(session, job.id, "brief")
            await succeed_step(session, step.id, {"brief": "ok"})
            with pytest.raises(InvalidJobTransition):
                await start_step(session, job.id, "brief")

    asyncio.new_event_loop().run_until_complete(run())


def test_daily_plan_job_failure_marks_plan_failed(session_factory):
    from content_jobs import create_job, fail_step, start_step
    from models import DailyPlan

    async def run():
        async with session_factory() as session:
            plan = DailyPlan(plan_date="2099-01-01", status="planning")
            session.add(plan)
            await session.commit()
            await session.refresh(plan)
            job = await create_job(session, flow="daily_plan", title="Plan", input_data={"plan_id": plan.id})
            step = await start_step(session, job.id, "daily_plan")
            await fail_step(session, step.id, "invalid key", retryable=True)
            await session.refresh(plan)
            assert plan.status == "failed"

    asyncio.new_event_loop().run_until_complete(run())


def test_fail_step_redacts_secrets_before_database_persistence(session_factory):
    from content_jobs import create_job, fail_step, start_step

    async def run():
        token = "123456:secret-token"
        async with session_factory() as session:
            job = await create_job(
                session,
                flow="x_response",
                title="secret boundary",
                input_data={},
            )
            step = await start_step(session, job.id, "notify")
            failed = await fail_step(
                session,
                step.id,
                f"POST https://api.telegram.org/bot{token}/sendMessage auth_token=x-secret",
                retryable=True,
            )

            assert token not in failed.error
            assert "x-secret" not in failed.error
            assert "bot***/sendMessage" in failed.error

    asyncio.new_event_loop().run_until_complete(run())
