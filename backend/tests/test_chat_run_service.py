import sys

import pytest


def _reload_modules():
    for name in list(sys.modules):
        if name.startswith(("database", "models", "services.chat_runs")):
            sys.modules.pop(name, None)


async def _seed_run(SessionLocal, models, service):
    async with SessionLocal() as db:
        chat_session = models.ChatSession(title="checkpoint")
        db.add(chat_session)
        await db.flush()
        message = models.ChatMessage(
            session_id=chat_session.id,
            role="user",
            parts=[{"type": "text", "text": "write"}],
            text="write",
        )
        db.add(message)
        await db.flush()
        run = await service.create_run(
            db,
            session_id=chat_session.id,
            user_message_id=message.id,
            objective="write",
        )
        await db.commit()
        return chat_session.id, run.id


@pytest.mark.asyncio
async def test_run_freezes_preparation_and_appends_pending_tool_atomically(postgres_env):
    _reload_modules()
    import models
    from database import Base, SessionLocal, engine
    from services import chat_runs

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    session_id, run_id = await _seed_run(SessionLocal, models, chat_runs)

    async with SessionLocal() as db:
        run = await chat_runs.freeze_preparation(
            db,
            run_id,
            skill_invocation={"name": "writing-plan", "activation": "manual"},
            validated_plan={"steps": [{"id": "step-1"}]},
            capability_snapshot={"tools": [{"name": "save_draft"}]},
            expected_version=0,
        )
        step = await chat_runs.append_step(
            db,
            run_id,
            assistant_content=[{"type": "reasoning", "text": "save it"}],
            tool_calls=[{
                "tool_call_id": "call-1",
                "tool_name": "save_draft",
                "input_data": {"title": "one"},
                "approval_id": "approval-1",
                "side_effecting": True,
                "replay_policy": "claim",
                "tool_version": "1",
                "contract_digest": "a" * 64,
            }],
            expected_version=run.checkpoint_version,
        )
        await db.commit()

    async with SessionLocal() as db:
        checkpoint = await chat_runs.load_checkpoint(db, run_id, session_id=session_id)

    assert checkpoint.run.status == "waiting_approval"
    assert checkpoint.run.skill_invocation["name"] == "writing-plan"
    assert step.status == "waiting_approval"
    assert checkpoint.tool_calls[0].status == "pending_approval"
    assert checkpoint.tool_calls[0].idempotency_key == f"chat-run:{run_id}:call-1"
    await engine.dispose()


@pytest.mark.asyncio
async def test_approval_is_idempotent_and_opposite_decision_conflicts(postgres_env):
    _reload_modules()
    import models
    from database import Base, SessionLocal, engine
    from services import chat_runs

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    session_id, run_id = await _seed_run(SessionLocal, models, chat_runs)
    async with SessionLocal() as db:
        run = await chat_runs.freeze_preparation(
            db, run_id, skill_invocation=None, validated_plan={"steps": []},
            capability_snapshot={"tools": []}, expected_version=0,
        )
        await chat_runs.append_step(
            db, run_id, assistant_content=[], expected_version=run.checkpoint_version,
            tool_calls=[{
                "tool_call_id": "call-1", "tool_name": "save_draft",
                "input_data": {}, "approval_id": "approval-1", "side_effecting": True,
            }],
        )
        await db.commit()

    async with SessionLocal() as db:
        first = await chat_runs.decide_approval(
            db, run_id, session_id=session_id, approval_id="approval-1",
            tool_call_id="call-1", approved=True,
        )
        await db.commit()
    async with SessionLocal() as db:
        duplicate = await chat_runs.decide_approval(
            db, run_id, session_id=session_id, approval_id="approval-1",
            tool_call_id="call-1", approved=True,
        )
        with pytest.raises(chat_runs.ChatRunConflict, match="opposite"):
            await chat_runs.decide_approval(
                db, run_id, session_id=session_id, approval_id="approval-1",
                tool_call_id="call-1", approved=False,
            )

    assert first.duplicate is False
    assert duplicate.duplicate is True
    assert first.checkpoint_version == duplicate.checkpoint_version
    await engine.dispose()


@pytest.mark.asyncio
async def test_rejection_persists_denied_result_and_completes_without_execution(postgres_env):
    _reload_modules()
    import models
    from database import Base, SessionLocal, engine
    from services import chat_runs

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    session_id, run_id = await _seed_run(SessionLocal, models, chat_runs)
    async with SessionLocal() as db:
        run = await chat_runs.freeze_preparation(
            db, run_id, skill_invocation=None, validated_plan={"steps": []},
            capability_snapshot={"tools": []}, expected_version=0,
        )
        await chat_runs.append_step(
            db, run_id, assistant_content=[], expected_version=run.checkpoint_version,
            tool_calls=[{
                "tool_call_id": "call-1", "tool_name": "save_draft",
                "input_data": {}, "approval_id": "approval-1", "side_effecting": True,
            }],
        )
        await db.commit()
    async with SessionLocal() as db:
        decision = await chat_runs.decide_approval(
            db, run_id, session_id=session_id, approval_id="approval-1",
            tool_call_id="call-1", approved=False, reason="not now",
        )
        await db.commit()
    async with SessionLocal() as db:
        checkpoint = await chat_runs.load_checkpoint(db, run_id, session_id=session_id)

    assert decision.run_status == "completed"
    assert checkpoint.tool_calls[0].status == "rejected"
    assert checkpoint.tool_calls[0].output_data == {
        "approved": False, "error": "tool_execution_denied", "reason": "not now"
    }
    assert checkpoint.run.lease_token is None
    await engine.dispose()


@pytest.mark.asyncio
async def test_stale_version_and_cross_session_do_not_advance_run(postgres_env):
    _reload_modules()
    import models
    from database import Base, SessionLocal, engine
    from services import chat_runs

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    session_id, run_id = await _seed_run(SessionLocal, models, chat_runs)
    async with SessionLocal() as db:
        with pytest.raises(chat_runs.ChatRunConflict, match="version"):
            await chat_runs.freeze_preparation(
                db, run_id, skill_invocation=None, validated_plan={},
                capability_snapshot={}, expected_version=99,
            )
        with pytest.raises(chat_runs.ChatRunNotFound):
            await chat_runs.load_checkpoint(db, run_id, session_id=session_id + 1)
    await engine.dispose()


@pytest.mark.asyncio
async def test_unknown_write_outcome_requires_reconciliation_and_is_not_replayable(postgres_env):
    _reload_modules()
    import models
    from database import Base, SessionLocal, engine
    from services import chat_runs

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    session_id, run_id = await _seed_run(SessionLocal, models, chat_runs)
    async with SessionLocal() as db:
        run = await chat_runs.freeze_preparation(
            db, run_id, skill_invocation=None, validated_plan={"steps": []},
            capability_snapshot={"tools": []}, expected_version=0,
        )
        await chat_runs.append_step(
            db, run_id, assistant_content=[], expected_version=run.checkpoint_version,
            tool_calls=[{
                "tool_call_id": "call-1", "tool_name": "save_draft",
                "input_data": {}, "approval_id": "approval-1", "side_effecting": True,
                "replay_policy": "never",
            }],
        )
        await db.commit()
    async with SessionLocal() as db:
        await chat_runs.decide_approval(
            db, run_id, session_id=session_id, approval_id="approval-1",
            tool_call_id="call-1", approved=True,
        )
        await chat_runs.complete_tool_call(
            db, run_id, tool_call_id="call-1", status="outcome_unknown",
            error_data={"code": "connection_lost"},
        )
        await db.commit()
    async with SessionLocal() as db:
        checkpoint = await chat_runs.load_checkpoint(db, run_id, session_id=session_id)
        with pytest.raises(chat_runs.ChatRunNeedsReconciliation):
            await chat_runs.decide_approval(
                db, run_id, session_id=session_id, approval_id="approval-1",
                tool_call_id="call-1", approved=True,
            )

    assert checkpoint.run.status == "needs_reconciliation"
    assert checkpoint.tool_calls[0].status == "outcome_unknown"
    await engine.dispose()
