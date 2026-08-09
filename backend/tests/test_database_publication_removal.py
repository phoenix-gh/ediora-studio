import asyncio

from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import create_async_engine


def test_removed_publication_schema_drops_rows_and_is_idempotent(
    postgres_database_url,
):
    from database import migrate_removed_publication_schema

    engine = create_async_engine(postgres_database_url)

    async def run():
        async with engine.begin() as connection:
            await connection.execute(text(
                "CREATE TABLE publications "
                "(id INTEGER PRIMARY KEY, title VARCHAR NOT NULL)"
            ))
            await connection.execute(text(
                "INSERT INTO publications (id, title) VALUES (1, '历史记录')"
            ))
            await migrate_removed_publication_schema(connection)
            await migrate_removed_publication_schema(connection)
            tables = set(await connection.run_sync(
                lambda sync_connection: inspect(sync_connection).get_table_names()
            ))
        await engine.dispose()
        return tables

    assert "publications" not in asyncio.run(run())


def test_removed_publication_schema_accepts_database_without_legacy_table(
    postgres_database_url,
):
    from database import migrate_removed_publication_schema

    engine = create_async_engine(postgres_database_url)

    async def run():
        async with engine.begin() as connection:
            await migrate_removed_publication_schema(connection)
        await engine.dispose()

    asyncio.run(run())
