import asyncio
import sys

from sqlalchemy import inspect, text


def _reload_database_modules():
    for module_name in list(sys.modules):
        if module_name.startswith(("database", "models")):
            sys.modules.pop(module_name, None)


async def _chat_run_schema(connection):
    def snapshot(sync_connection):
        inspector = inspect(sync_connection)
        return {
            "tables": set(inspector.get_table_names()),
            "chat_message_columns": {
                column["name"] for column in inspector.get_columns("chat_messages")
            },
            "step_uniques": inspector.get_unique_constraints("chat_run_steps"),
            "tool_uniques": inspector.get_unique_constraints("chat_run_tool_calls"),
            "tool_indexes": inspector.get_indexes("chat_run_tool_calls"),
            "run_foreign_keys": inspector.get_foreign_keys("chat_runs"),
        }

    return await connection.run_sync(snapshot)


def test_init_db_twice_creates_durable_chat_run_checkpoint_schema(postgres_env):
    _reload_database_modules()
    import models  # noqa: F401
    from database import engine, init_db

    async def run():
        await init_db()
        await init_db()
        async with engine.connect() as connection:
            result = await _chat_run_schema(connection)
        await engine.dispose()
        return result

    schema = asyncio.run(run())

    assert {"chat_runs", "chat_run_steps", "chat_run_tool_calls"} <= schema["tables"]
    assert "run_id" in schema["chat_message_columns"]
    assert any(
        constraint["column_names"] == ["run_id", "ordinal"]
        for constraint in schema["step_uniques"]
    )
    assert any(
        constraint["column_names"] == ["run_id", "tool_call_id"]
        for constraint in schema["tool_uniques"]
    )
    assert any(
        index["name"] == "uq_chat_run_tool_calls_approval_id"
        and index["unique"]
        for index in schema["tool_indexes"]
    )
    assert {
        tuple(foreign_key["constrained_columns"])
        for foreign_key in schema["run_foreign_keys"]
    } >= {("session_id",), ("user_message_id",), ("assistant_message_id",)}


def test_init_db_repairs_chat_run_projection_column_and_partial_index(postgres_env):
    _reload_database_modules()
    import models  # noqa: F401
    from database import engine, init_db

    async def run():
        await init_db()
        async with engine.begin() as connection:
            await connection.execute(text(
                "INSERT INTO chat_sessions (id, title, created_at, updated_at) "
                "VALUES (7001, 'kept', NOW(), NOW())"
            ))
            await connection.execute(text(
                "INSERT INTO chat_messages (id, session_id, role, parts, text, created_at) "
                "VALUES (7002, 7001, 'user', '[]'::json, 'preserve me', NOW())"
            ))
            await connection.execute(text(
                "DROP INDEX uq_chat_run_tool_calls_approval_id"
            ))
            await connection.execute(text(
                "ALTER TABLE chat_messages DROP COLUMN run_id"
            ))
        await init_db()
        async with engine.connect() as connection:
            schema = await _chat_run_schema(connection)
            preserved = (await connection.execute(text(
                "SELECT text FROM chat_messages WHERE id = 7002"
            ))).scalar_one()
        await engine.dispose()
        return schema, preserved

    schema, preserved = asyncio.run(run())

    assert "run_id" in schema["chat_message_columns"]
    assert any(
        index["name"] == "uq_chat_run_tool_calls_approval_id"
        and index["unique"]
        for index in schema["tool_indexes"]
    )
    assert preserved == "preserve me"
