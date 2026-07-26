import asyncio

from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import create_async_engine


def test_removed_hot_topic_schema_migrates_state_drops_cache_and_is_idempotent(
    tmp_path,
):
    from database import migrate_removed_hot_topic_schema

    engine = create_async_engine(
        f"sqlite+aiosqlite:///{tmp_path / 'hot-topic-removal.db'}",
    )

    async def run():
        async with engine.begin() as connection:
            await connection.execute(text(
                "CREATE TABLE x_response_decisions "
                "(id INTEGER PRIMARY KEY, workflow_status VARCHAR NOT NULL)"
            ))
            await connection.execute(text(
                "INSERT INTO x_response_decisions (id, workflow_status) "
                "VALUES (1, 'converted'), (2, 'ignored')"
            ))
            await connection.execute(text(
                "CREATE TABLE topic_generator_cache "
                "(id INTEGER PRIMARY KEY, topics JSON)"
            ))
            await migrate_removed_hot_topic_schema(connection)
            await migrate_removed_hot_topic_schema(connection)
            statuses = (
                await connection.execute(text(
                    "SELECT id, workflow_status "
                    "FROM x_response_decisions ORDER BY id"
                ))
            ).all()
            tables = set(await connection.run_sync(
                lambda sync_connection: inspect(sync_connection).get_table_names()
            ))
        await engine.dispose()
        return statuses, tables

    statuses, tables = asyncio.run(run())

    assert statuses == [(1, "used"), (2, "ignored")]
    assert "topic_generator_cache" not in tables


def test_removed_hot_topic_schema_accepts_database_without_legacy_tables(tmp_path):
    from database import migrate_removed_hot_topic_schema

    engine = create_async_engine(
        f"sqlite+aiosqlite:///{tmp_path / 'empty.db'}",
    )

    async def run():
        async with engine.begin() as connection:
            await migrate_removed_hot_topic_schema(connection)
        await engine.dispose()

    asyncio.run(run())
