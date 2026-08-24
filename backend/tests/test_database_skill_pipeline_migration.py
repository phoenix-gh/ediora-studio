import asyncio
import json
import sys
from datetime import datetime, timezone

import pytest
from sqlalchemy import inspect, text
from sqlalchemy.exc import IntegrityError


def _reload_database_modules():
    for module_name in list(sys.modules):
        if module_name.startswith(("database", "models")):
            sys.modules.pop(module_name, None)


async def _table_columns(connection, table_name: str) -> set[str]:
    return await connection.run_sync(
        lambda sync_connection: {
            column["name"]
            for column in inspect(sync_connection).get_columns(table_name)
        }
    )


async def _table_names(connection) -> set[str]:
    return await connection.run_sync(
        lambda sync_connection: set(inspect(sync_connection).get_table_names())
    )


async def _insert_id(connection, statement: str, values: dict) -> int:
    return (await connection.execute(text(statement), values)).scalar_one()


def _json(value: object) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=lambda item: item.isoformat() if isinstance(item, datetime) else str(item),
    )


async def _downgrade_skill_pipeline_schema(connection) -> None:
    await connection.execute(text("DROP TABLE IF EXISTS execution_artifacts CASCADE"))
    await connection.execute(text("DROP INDEX IF EXISTS uq_agent_executions_legacy_job"))
    await connection.execute(text("DROP INDEX IF EXISTS uq_agent_executions_stage_attempt"))
    await connection.execute(text("ALTER TABLE agent_executions DROP COLUMN IF EXISTS step_id"))
    await connection.execute(text("ALTER TABLE agent_executions DROP COLUMN IF EXISTS attempt"))
    await connection.execute(text("ALTER TABLE content_jobs DROP COLUMN IF EXISTS plan_version"))
    await connection.execute(text("ALTER TABLE content_jobs DROP COLUMN IF EXISTS run_epoch"))
    await connection.execute(text("ALTER TABLE content_jobs DROP COLUMN IF EXISTS updated_at"))
    await connection.execute(text(
        "ALTER TABLE agent_executions "
        "ADD CONSTRAINT agent_executions_job_id_key UNIQUE (job_id)"
    ))


async def _insert_legacy_rows(connection) -> dict[str, int]:
    timestamp = datetime.now(timezone.utc)
    job_id = await _insert_id(connection, """
        INSERT INTO content_jobs
          (flow, title, status, input_data, idempotency_key, created_at, started_at, completed_at)
        VALUES
          ('skill-pipeline', 'legacy job', 'running', CAST(:input_data AS JSON),
           'legacy-job-key', :created_at, NULL, NULL)
        RETURNING id
    """, {"input_data": _json({"topic": "迁移保留"}), "created_at": timestamp})
    step_one_id = await _insert_id(connection, """
        INSERT INTO content_job_steps
          (job_id, step_key, attempt, status, input_data, output_data, error, retryable,
           created_at, started_at, completed_at)
        VALUES
          (:job_id, 'research', 1, 'succeeded', CAST(:input_data AS JSON),
           CAST(:output_data AS JSON), '', FALSE, :created_at, :created_at, :created_at)
        RETURNING id
    """, {
        "job_id": job_id,
        "input_data": _json({"query": "old"}),
        "output_data": _json({"sources": ["source-1"]}),
        "created_at": timestamp,
    })
    step_two_id = await _insert_id(connection, """
        INSERT INTO content_job_steps
          (job_id, step_key, attempt, status, input_data, output_data, error, retryable,
           created_at, started_at, completed_at)
        VALUES
          (:job_id, 'write', 1, 'queued', CAST(:input_data AS JSON),
           CAST(:output_data AS JSON), '', TRUE, :created_at, NULL, NULL)
        RETURNING id
    """, {
        "job_id": job_id,
        "input_data": _json({"source_step": "research"}),
        "output_data": _json({}),
        "created_at": timestamp,
    })
    event_id = await _insert_id(connection, """
        INSERT INTO content_job_events (job_id, step_id, kind, payload, created_at)
        VALUES (:job_id, :step_id, 'step/succeeded', CAST(:payload AS JSON), :created_at)
        RETURNING id
    """, {
        "job_id": job_id,
        "step_id": step_one_id,
        "payload": _json({"preserved": True, "count": 1}),
        "created_at": timestamp,
    })
    execution_id = await _insert_id(connection, """
        INSERT INTO agent_executions
          (job_id, status, objective, skill_mode, skill_name, skill_activation, phase,
           checkpoint_data, audit_data, pinned_capability_snapshot, completion_evidence,
           final_summary, version, error, created_at, updated_at, completed_at)
        VALUES
          (:job_id, 'running', 'legacy objective', 'manual', 'source-research', 'manual',
           'execute', CAST(:checkpoint_data AS JSON), CAST(:audit_data AS JSON),
           CAST(:pinned AS JSON), CAST(:evidence AS JSON), 'legacy checkpoint', 3, '',
           :created_at, :created_at, NULL)
        RETURNING id
    """, {
        "job_id": job_id,
        "checkpoint_data": _json({"cursor": 4}),
        "audit_data": _json({"tool": "search"}),
        "pinned": _json({"digest": "a" * 64}),
        "evidence": _json({"sources": ["source-1"]}),
        "created_at": timestamp,
    })
    tool_call_id = await _insert_id(connection, """
        INSERT INTO agent_tool_calls
          (execution_id, tool_call_id, tool_name, status, auto_approved, side_effecting,
           input_summary, output_data, error, started_at, completed_at, updated_at)
        VALUES
          (:execution_id, 'call-legacy', 'search', 'succeeded', TRUE, FALSE,
           CAST(:input_summary AS JSON), CAST(:output_data AS JSON), '', :created_at,
           :created_at, :created_at)
        RETURNING id
    """, {
        "execution_id": execution_id,
        "input_summary": _json({"q": "old"}),
        "output_data": _json({"items": [1]}),
        "created_at": timestamp,
    })
    message_id = await _insert_id(connection, """
        INSERT INTO agent_message_logs
          (execution_id, phase, direction, payload_data, created_at)
        VALUES (:execution_id, 'execute', 'model_response', CAST(:payload AS JSON), :created_at)
        RETURNING id
    """, {
        "execution_id": execution_id,
        "payload": _json({"text": "old answer", "usage": {"tokens": 9}}),
        "created_at": timestamp,
    })
    log_id = await _insert_id(connection, """
        INSERT INTO agent_log_events
          (stream_kind, stream_key, session_id, job_id, execution_id, turn_id, step_id,
           event_type, phase, status, payload_data, usage_data, duration_ms, created_at)
        VALUES
          ('job', 'job:legacy', NULL, :job_id, :execution_id, NULL, 'research',
           'execution/checkpoint', 'execute', 'completed', CAST(:payload AS JSON),
           CAST(:usage AS JSON), 17, :created_at)
        RETURNING id
    """, {
        "job_id": job_id,
        "execution_id": execution_id,
        "payload": _json({"checkpoint": "old"}),
        "usage": _json({"input": 3, "output": 6}),
        "created_at": timestamp,
    })
    session_id = await _insert_id(connection, """
        INSERT INTO chat_sessions (title, created_at, updated_at)
        VALUES ('迁移会话', :created_at, :created_at)
        RETURNING id
    """, {"created_at": timestamp})
    message_row_id = await _insert_id(connection, """
        INSERT INTO chat_messages
          (session_id, role, parts, text, skill_run, capability_snapshot, created_at)
        VALUES
          (:session_id, 'assistant', CAST(:parts AS JSON), '保留消息',
           CAST(:skill_run AS JSON), CAST(:capability AS JSON), :created_at)
        RETURNING id
    """, {
        "session_id": session_id,
        "parts": _json([{"type": "text", "text": "保留消息"}]),
        "skill_run": _json({"status": "completed"}),
        "capability": _json({"version": 1}),
        "created_at": timestamp,
    })
    rule_id = await _insert_id(connection, """
        INSERT INTO daily_creation_rules
          (name, asset_type, directory, directories, output_type, target_count,
           execution_mode, scheduled_date, scheduled_time, timezone, lookback_days,
           delivery_mode, account_id, instructions, prompt, skill_mode, skill_name,
           enabled, deleted_at, created_at, updated_at)
        VALUES
          ('迁移规则', 'article', 'default', CAST(:directories AS JSON), 'x_short_post', 1,
           'once', NULL, '09:00', 'Asia/Shanghai', 3, 'drafts', NULL, '保留指令',
           '保留提示', 'manual', 'source-research', TRUE, NULL, :created_at, :created_at)
        RETURNING id
    """, {
        "directories": _json(["default"]),
        "created_at": timestamp,
    })
    return {
        "job": job_id,
        "step_one": step_one_id,
        "step_two": step_two_id,
        "event": event_id,
        "execution": execution_id,
        "tool_call": tool_call_id,
        "message": message_id,
        "log": log_id,
        "chat_session": session_id,
        "chat_message": message_row_id,
        "rule": rule_id,
    }


async def _snapshot_rows(connection, ids: dict[str, int]) -> dict[str, dict]:
    queries = {
        "job": "SELECT id, flow, title, status, input_data, idempotency_key, created_at, started_at, completed_at FROM content_jobs WHERE id = :id",
        "step_one": "SELECT id, job_id, step_key, attempt, status, input_data, output_data, error, retryable, created_at, started_at, completed_at FROM content_job_steps WHERE id = :id",
        "step_two": "SELECT id, job_id, step_key, attempt, status, input_data, output_data, error, retryable, created_at, started_at, completed_at FROM content_job_steps WHERE id = :id",
        "event": "SELECT id, job_id, step_id, kind, payload, created_at FROM content_job_events WHERE id = :id",
        "execution": "SELECT id, job_id, status, objective, skill_mode, skill_name, skill_activation, phase, checkpoint_data, audit_data, pinned_capability_snapshot, completion_evidence, final_summary, version, error, created_at, updated_at, completed_at FROM agent_executions WHERE id = :id",
        "tool_call": "SELECT id, execution_id, tool_call_id, tool_name, status, auto_approved, side_effecting, input_summary, output_data, error, started_at, completed_at, updated_at FROM agent_tool_calls WHERE id = :id",
        "message": "SELECT id, execution_id, phase, direction, payload_data, created_at FROM agent_message_logs WHERE id = :id",
        "log": "SELECT id, stream_kind, stream_key, job_id, execution_id, step_id, event_type, phase, status, payload_data, usage_data, duration_ms, created_at FROM agent_log_events WHERE id = :id",
        "chat_session": "SELECT id, title, created_at, updated_at FROM chat_sessions WHERE id = :id",
        "chat_message": "SELECT id, session_id, role, parts, text, skill_run, capability_snapshot, created_at FROM chat_messages WHERE id = :id",
        "rule": "SELECT id, name, asset_type, directory, directories, output_type, target_count, execution_mode, scheduled_date, scheduled_time, timezone, lookback_days, delivery_mode, account_id, instructions, prompt, skill_mode, skill_name, enabled, deleted_at, created_at, updated_at FROM daily_creation_rules WHERE id = :id",
    }
    snapshots: dict[str, dict] = {}
    for key, query in queries.items():
        row = (await connection.execute(text(query), {"id": ids[key]})).mappings().one()
        snapshots[key] = json.loads(_json(dict(row)))
    return snapshots


def test_populated_previous_schema_migrates_idempotently_without_data_loss(postgres_env):
    _reload_database_modules()
    import models  # noqa: F401
    from database import Base, engine, init_db

    async def run():
        from sqlalchemy import text

        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
            await _downgrade_skill_pipeline_schema(connection)
            ids = await _insert_legacy_rows(connection)
            before = await _snapshot_rows(connection, ids)

        await init_db()
        await init_db()

        async with engine.begin() as connection:
            tables = await _table_names(connection)
            after = await _snapshot_rows(connection, ids)
            assert before == after
            assert {"plan_version", "run_epoch", "updated_at"} <= await _table_columns(connection, "content_jobs")
            assert {"step_id", "attempt"} <= await _table_columns(connection, "agent_executions")
            assert "execution_artifacts" in tables
            assert (await connection.execute(text(
                "SELECT COUNT(*) FROM agent_executions WHERE step_id IS NULL"
            ))).scalar_one() == 1

            step_one = await _insert_id(connection, """
                INSERT INTO content_job_steps
                  (job_id, step_key, attempt, status, input_data, output_data, error, retryable, created_at)
                VALUES (:job_id, 'stage-one', 1, 'queued', '{}'::json, '{}'::json, '', FALSE, CURRENT_TIMESTAMP)
                RETURNING id
            """, {"job_id": ids["job"]})
            step_two = await _insert_id(connection, """
                INSERT INTO content_job_steps
                  (job_id, step_key, attempt, status, input_data, output_data, error, retryable, created_at)
                VALUES (:job_id, 'stage-two', 1, 'queued', '{}'::json, '{}'::json, '', FALSE, CURRENT_TIMESTAMP)
                RETURNING id
            """, {"job_id": ids["job"]})

            execution_values = {
                "job_id": ids["job"],
                "objective": "stage objective",
                "step_id": step_one,
                "checkpoint": _json({}),
                "audit": _json({}),
                "evidence": _json({}),
            }
            execution_sql = """
                INSERT INTO agent_executions
                  (job_id, step_id, attempt, status, objective, skill_mode, skill_name,
                   skill_activation, phase, checkpoint_data, audit_data, completion_evidence,
                   final_summary, version, error, created_at, updated_at)
                VALUES (:job_id, :step_id, 1, 'running', :objective, 'manual', 'source-research',
                        'manual', 'prepare', CAST(:checkpoint AS JSON), CAST(:audit AS JSON),
                        CAST(:evidence AS JSON), '', 1, '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                RETURNING id
            """
            await _insert_id(connection, execution_sql, execution_values)
            await _insert_id(connection, execution_sql, {**execution_values, "step_id": step_two})

            with pytest.raises(IntegrityError):
                async with connection.begin_nested():
                    await connection.execute(text(execution_sql), execution_values)
            with pytest.raises(IntegrityError):
                async with connection.begin_nested():
                    await connection.execute(text(execution_sql), {**execution_values, "step_id": step_one})

        await engine.dispose()

    asyncio.run(run())


def test_skill_pipeline_migration_rolls_back_with_outer_postgresql_transaction(postgres_env):
    _reload_database_modules()
    import models  # noqa: F401
    from database import Base, engine, migrate_skill_pipeline_schema

    async def run():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
            await _downgrade_skill_pipeline_schema(connection)

        with pytest.raises(RuntimeError, match="abort migration"):
            async with engine.begin() as connection:
                await migrate_skill_pipeline_schema(connection, assert_complete=False)
                raise RuntimeError("abort migration")

        async with engine.connect() as connection:
            columns = await _table_columns(connection, "agent_executions")
            assert "step_id" not in columns
        await engine.dispose()

    asyncio.run(run())
