import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


@pytest.fixture
async def db(tmp_path):
    from database import Base
    import models  # noqa: F401

    engine = create_async_engine(
        f"sqlite+aiosqlite:///{tmp_path / 'agent-execution-service.db'}"
    )
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    async with sessions() as session:
        yield session
    await engine.dispose()


async def seed_job(db):
    from models import ContentJob

    job = ContentJob(flow="daily_creation", title="Agent run", input_data={})
    db.add(job)
    await db.commit()
    await db.refresh(job)
    return job


@pytest.mark.asyncio
async def test_completed_tool_call_replays_without_execution(db):
    from agent_execution_service import (
        claim_agent_tool_call,
        complete_agent_tool_call,
        ensure_agent_execution,
    )

    job = await seed_job(db)
    execution = await ensure_agent_execution(
        db, job_id=job.id, objective="create posts",
        skill_mode="auto", skill_name=None,
    )
    first = await claim_agent_tool_call(
        db, execution_id=execution.id, tool_call_id="call-1",
        tool_name="save_item", input_summary={"value": "x"},
        auto_approved=True, side_effecting=True,
    )
    assert first.action == "execute"

    await complete_agent_tool_call(
        db, execution.id, "call-1", {"id": 7},
    )
    replay = await claim_agent_tool_call(
        db, execution_id=execution.id, tool_call_id="call-1",
        tool_name="save_item", input_summary={"value": "x"},
        auto_approved=True, side_effecting=True,
    )

    assert replay.action == "replay"
    assert replay.output == {"id": 7}
    assert replay.error is None


@pytest.mark.asyncio
async def test_unfinished_write_is_uncertain_but_read_can_be_reclaimed(db):
    from agent_execution_service import (
        claim_agent_tool_call,
        ensure_agent_execution,
    )

    job = await seed_job(db)
    execution = await ensure_agent_execution(
        db, job_id=job.id, objective="create posts",
        skill_mode="auto", skill_name=None,
    )
    await claim_agent_tool_call(
        db, execution_id=execution.id, tool_call_id="write-1",
        tool_name="save_item", input_summary={},
        auto_approved=True, side_effecting=True,
    )
    uncertain = await claim_agent_tool_call(
        db, execution_id=execution.id, tool_call_id="write-1",
        tool_name="save_item", input_summary={},
        auto_approved=True, side_effecting=True,
    )
    assert uncertain.action == "uncertain"
    assert "unknown" in (uncertain.error or "").lower()

    await claim_agent_tool_call(
        db, execution_id=execution.id, tool_call_id="read-1",
        tool_name="search_assets", input_summary={},
        auto_approved=False, side_effecting=False,
    )
    reclaimed = await claim_agent_tool_call(
        db, execution_id=execution.id, tool_call_id="read-1",
        tool_name="search_assets", input_summary={},
        auto_approved=False, side_effecting=False,
    )
    assert reclaimed.action == "execute"


@pytest.mark.asyncio
async def test_checkpoint_updates_are_optimistic_and_completion_is_durable(db):
    from agent_execution_service import (
        AgentExecutionConflict,
        complete_agent_execution,
        ensure_agent_execution,
        update_agent_checkpoint,
    )

    job = await seed_job(db)
    execution = await ensure_agent_execution(
        db, job_id=job.id, objective="create posts",
        skill_mode="manual", skill_name="human-social-copy",
    )
    updated = await update_agent_checkpoint(
        db, execution_id=execution.id, expected_version=1,
        phase="execute", checkpoint={"parts": [{"type": "text"}]},
        audit={"loaded_references": ["references/finance-writing.md"]},
    )
    assert updated.version == 2
    assert updated.phase == "execute"

    with pytest.raises(AgentExecutionConflict):
        await update_agent_checkpoint(
            db, execution_id=execution.id, expected_version=1,
            phase="validate", checkpoint={}, audit={},
        )

    completed = await complete_agent_execution(
        db, execution.id,
        {"tool_name": "save_daily_creation_outputs", "created_count": 2},
    )
    assert completed.status == "succeeded"
    assert completed.completion_evidence["created_count"] == 2
