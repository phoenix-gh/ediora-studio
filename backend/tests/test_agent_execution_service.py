import pytest
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
async def test_agent_message_log_preserves_model_turns_in_order(db):
    from agent_execution_service import (
        append_agent_message,
        ensure_agent_execution,
    )

    job = await seed_job(db)
    execution = await ensure_agent_execution(
        db, job_id=job.id, objective="create posts",
        skill_mode="auto", skill_name=None,
    )

    request = await append_agent_message(
        db,
        execution_id=execution.id,
        phase="execute",
        direction="model_request",
        payload={"messages": [{"role": "user", "content": "create posts"}]},
    )
    response = await append_agent_message(
        db,
        execution_id=execution.id,
        phase="execute",
        direction="model_response",
        payload={"text": "done", "toolResults": []},
    )

    assert request.id < response.id
    assert request.payload_data["messages"][0]["content"] == "create posts"
    assert response.payload_data["text"] == "done"


@pytest.mark.asyncio
async def test_completed_read_tool_replays_after_restart(db):
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
    await claim_agent_tool_call(
        db, execution_id=execution.id, tool_call_id="read-candidates",
        tool_name="list_creative_asset_candidates",
        input_summary={"directory": "搞钱副业"},
        auto_approved=False, side_effecting=False,
    )
    await complete_agent_tool_call(
        db, execution.id, "read-candidates", [{"id": 381}],
    )

    replay = await claim_agent_tool_call(
        db, execution_id=execution.id, tool_call_id="read-candidates",
        tool_name="list_creative_asset_candidates",
        input_summary={"directory": "搞钱副业"},
        auto_approved=False, side_effecting=False,
    )

    assert replay.action == "replay"
    assert replay.output == [{"id": 381}]


@pytest.mark.asyncio
async def test_late_failure_cannot_overwrite_a_succeeded_tool_call(db):
    from agent_execution_service import (
        claim_agent_tool_call,
        complete_agent_tool_call,
        ensure_agent_execution,
        fail_agent_tool_call,
    )

    job = await seed_job(db)
    execution = await ensure_agent_execution(
        db, job_id=job.id, objective="create posts",
        skill_mode="auto", skill_name=None,
    )
    await claim_agent_tool_call(
        db, execution_id=execution.id, tool_call_id="save-ack-lost",
        tool_name="save_item", input_summary={},
        auto_approved=True, side_effecting=True,
    )
    await complete_agent_tool_call(
        db, execution.id, "save-ack-lost", {"id": 17},
    )

    preserved = await fail_agent_tool_call(
        db, execution.id, "save-ack-lost", "response acknowledgement lost", True,
    )

    assert preserved.status == "succeeded"
    assert preserved.output_data == {"id": 17}


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
async def test_same_side_effect_input_replays_across_changed_tool_call_id(db):
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
    await claim_agent_tool_call(
        db, execution_id=execution.id, tool_call_id="original-call",
        tool_name="save_item", input_summary={"value": "same"},
        auto_approved=True, side_effecting=True,
    )
    await complete_agent_tool_call(
        db, execution.id, "original-call", {"id": 23},
    )

    replay = await claim_agent_tool_call(
        db, execution_id=execution.id, tool_call_id="new-model-call-id",
        tool_name="save_item", input_summary={"value": "same"},
        auto_approved=True, side_effecting=True,
    )

    assert replay.action == "replay"
    assert replay.output == {"id": 23}
    alias = await complete_agent_tool_call(
        db, execution.id, "new-model-call-id", replay.output,
    )
    assert alias.status == "succeeded"


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


@pytest.mark.asyncio
async def test_capability_pin_is_persisted_once_and_rejects_tool_drift(db):
    from agent_execution_service import (
        AgentCapabilityDrift,
        ensure_agent_execution,
        update_agent_checkpoint,
    )

    job = await seed_job(db)
    execution = await ensure_agent_execution(
        db, job_id=job.id, objective="create posts",
        skill_mode="auto", skill_name=None,
    )
    snapshot = {
        "schemaVersion": 1,
        "mode": "job",
        "skill": None,
        "tools": [{
            "name": "save_draft",
            "description": "Save",
            "inputSchemaDigest": None,
            "sideEffecting": True,
            "needsApproval": False,
            "replayPolicy": "uncertain-on-interruption",
        }],
        "policy": {"approvalPolicy": "automatic", "allowedToolNames": None},
    }
    updated = await update_agent_checkpoint(
        db, execution_id=execution.id, expected_version=1,
        phase="prepared", checkpoint={}, audit={"capabilities": snapshot},
        capability_pin=snapshot,
    )
    assert updated.pinned_capability_snapshot == snapshot

    repeated = await update_agent_checkpoint(
        db, execution_id=execution.id, expected_version=2,
        phase="execute", checkpoint={}, audit={"capabilities": snapshot},
        capability_pin=snapshot,
    )
    assert repeated.pinned_capability_snapshot == snapshot

    bootstrapped = {
        **snapshot,
        "skill": {
            "name": "Alpha",
            "version": "1.0.0",
            "source": "builtin",
            "activation": "automatic",
            "instructionsDigest": "a" * 64,
            "references": [],
        },
    }
    upgraded = await update_agent_checkpoint(
        db, execution_id=execution.id, expected_version=3,
        phase="execute", checkpoint={}, audit={"capabilities": bootstrapped},
        capability_pin=bootstrapped,
    )
    assert upgraded.pinned_capability_snapshot == bootstrapped

    restored = {
        **bootstrapped,
        "skill": {**bootstrapped["skill"], "activation": "restored"},
    }
    restored_checkpoint = await update_agent_checkpoint(
        db, execution_id=execution.id, expected_version=4,
        phase="execute", checkpoint={}, audit={"capabilities": restored},
        capability_pin=restored,
    )
    assert restored_checkpoint.pinned_capability_snapshot == bootstrapped

    drifted = {**bootstrapped, "tools": []}
    with pytest.raises(AgentCapabilityDrift):
        await update_agent_checkpoint(
            db, execution_id=execution.id, expected_version=5,
            phase="execute", checkpoint={}, audit={"capabilities": drifted},
            capability_pin=drifted,
        )


@pytest.mark.asyncio
async def test_agent_execution_failure_is_terminal_and_idempotent(db):
    from agent_execution_service import (
        ensure_agent_execution,
        fail_agent_execution,
    )

    job = await seed_job(db)
    execution = await ensure_agent_execution(
        db, job_id=job.id, objective="create posts",
        skill_mode="auto", skill_name=None,
    )

    failed = await fail_agent_execution(
        db, execution.id,
        "save_daily_creation_outputs failed with a secret=token-value",
    )
    failed_again = await fail_agent_execution(
        db, execution.id, "a later error must not overwrite the first failure",
    )

    assert failed.status == "failed"
    assert failed.phase == "failed"
    assert failed.error == "save_daily_creation_outputs failed with a secret=token-value"
    assert failed.completed_at is not None
    assert failed_again.status == "failed"
    assert failed_again.error == failed.error
    assert failed_again.completed_at == failed.completed_at
