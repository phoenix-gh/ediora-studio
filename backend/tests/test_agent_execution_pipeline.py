import asyncio

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


@pytest.fixture
async def db(postgres_database_url):
    from database import Base
    import models  # noqa: F401

    engine = create_async_engine(postgres_database_url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    async with sessions() as session:
        yield session
    await engine.dispose()


@pytest.mark.asyncio
async def test_stage_execution_identity_validates_step_job_and_attempt(db):
    from agent_execution_service import ensure_agent_execution
    from models import AgentExecution, ContentJob, ContentJobStep

    job = ContentJob(flow="skill_pipeline", title="pipeline", input_data={})
    other_job = ContentJob(flow="skill_pipeline", title="other", input_data={})
    db.add_all([job, other_job])
    await db.flush()
    step = ContentJobStep(job_id=job.id, step_key="research", attempt=2)
    db.add(step)
    await db.commit()
    await db.refresh(step)

    execution = await ensure_agent_execution(
        db,
        job_id=job.id,
        step_id=step.id,
        attempt=2,
        objective="research sources",
        skill_mode="manual",
        skill_name="source-research",
    )
    assert execution.step_id == step.id
    assert execution.attempt == 2

    same = await ensure_agent_execution(
        db,
        job_id=job.id,
        step_id=step.id,
        attempt=2,
        objective="changed objective must not replace identity",
        skill_mode="auto",
        skill_name=None,
    )
    assert same.id == execution.id
    assert same.objective == "research sources"

    with pytest.raises(ValueError, match="belongs to job"):
        await ensure_agent_execution(
            db,
            job_id=other_job.id,
            step_id=step.id,
            attempt=2,
            objective="wrong job",
            skill_mode="auto",
            skill_name=None,
        )
    with pytest.raises(ValueError, match="attempt"):
        await ensure_agent_execution(
            db,
            job_id=job.id,
            step_id=step.id,
            attempt=1,
            objective="wrong attempt",
            skill_mode="auto",
            skill_name=None,
        )
    with pytest.raises(KeyError, match="step"):
        await ensure_agent_execution(
            db,
            job_id=job.id,
            step_id=999999,
            attempt=1,
            objective="missing step",
            skill_mode="auto",
            skill_name=None,
        )

    assert (await db.scalar(
        select(func.count(AgentExecution.id)).where(
            AgentExecution.job_id == job.id,
        )
    )) == 1


@pytest.mark.asyncio
async def test_legacy_execution_creation_is_race_safe_and_logs_one_start(
    postgres_database_url,
):
    from agent_execution_service import ensure_agent_execution
    from models import AgentExecution, AgentLogEvent, ContentJob

    engine = create_async_engine(postgres_database_url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with engine.begin() as connection:
            from database import Base
            await connection.run_sync(Base.metadata.create_all)
        async with sessions() as session:
            job = ContentJob(flow="skill_pipeline", title="race", input_data={})
            session.add(job)
            await session.commit()
            job_id = job.id

        async def create_one():
            async with sessions() as session:
                return await ensure_agent_execution(
                    session,
                    job_id=job_id,
                    objective="race-safe",
                    skill_mode="auto",
                    skill_name=None,
                )

        first, second = await asyncio.gather(create_one(), create_one())
        assert first.id == second.id

        async with sessions() as session:
            assert (await session.scalar(
                select(func.count(AgentExecution.id)).where(
                    AgentExecution.job_id == job_id,
                    AgentExecution.step_id.is_(None),
                )
            )) == 1
            assert (await session.scalar(
                select(func.count(AgentLogEvent.id)).where(
                    AgentLogEvent.execution_id == first.id,
                    AgentLogEvent.event_type == "execution/start",
                )
            )) == 1
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_latest_execution_helpers_order_stage_runs_by_newest_state(db):
    from agent_execution_service import (
        ensure_agent_execution,
        latest_agent_execution_for_job,
        latest_agent_executions_for_jobs,
    )
    from models import ContentJob, ContentJobStep

    first_job = ContentJob(flow="skill_pipeline", title="first", input_data={})
    second_job = ContentJob(flow="skill_pipeline", title="second", input_data={})
    db.add_all([first_job, second_job])
    await db.flush()
    first_step = ContentJobStep(job_id=first_job.id, step_key="research", attempt=1)
    second_step = ContentJobStep(job_id=first_job.id, step_key="write", attempt=1)
    other_step = ContentJobStep(job_id=second_job.id, step_key="research", attempt=1)
    db.add_all([first_step, second_step, other_step])
    await db.commit()
    await db.refresh(first_step)
    await db.refresh(second_step)
    await db.refresh(other_step)

    first_execution = await ensure_agent_execution(
        db, job_id=first_job.id, step_id=first_step.id, attempt=1,
        objective="first", skill_mode="auto", skill_name=None,
    )
    second_execution = await ensure_agent_execution(
        db, job_id=first_job.id, step_id=second_step.id, attempt=1,
        objective="second", skill_mode="auto", skill_name=None,
    )
    other_execution = await ensure_agent_execution(
        db, job_id=second_job.id, step_id=other_step.id, attempt=1,
        objective="other", skill_mode="auto", skill_name=None,
    )

    latest = await latest_agent_execution_for_job(db, first_job.id)
    assert latest is not None
    assert latest.id == second_execution.id
    assert (await latest_agent_execution_for_job(db, 999999)) is None

    latest_by_job = await latest_agent_executions_for_jobs(
        db, [first_job.id, second_job.id, 999999]
    )
    assert latest_by_job == {
        first_job.id: second_execution,
        second_job.id: other_execution,
    }
    assert first_execution.id != latest_by_job[first_job.id].id
