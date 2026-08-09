import asyncio

from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import create_async_engine


def test_existing_response_table_gains_claim_column_and_index_idempotently(
    postgres_database_url,
):
    from database import migrate_x_response_claim_schema

    engine = create_async_engine(postgres_database_url)

    async def run():
        async with engine.begin() as connection:
            await connection.execute(text(
                "CREATE TABLE x_response_decisions ("
                "id INTEGER PRIMARY KEY, telegram_status VARCHAR NOT NULL"
                ")"
            ))
            await migrate_x_response_claim_schema(connection)
            await migrate_x_response_claim_schema(connection)
            columns, indexes = await connection.run_sync(
                lambda sync_connection: (
                    {
                        column["name"]
                        for column in inspect(sync_connection).get_columns(
                            "x_response_decisions"
                        )
                    },
                    {
                        index["name"]
                        for index in inspect(sync_connection).get_indexes(
                            "x_response_decisions"
                        )
                    },
                )
            )
        await engine.dispose()
        return columns, indexes

    columns, indexes = asyncio.run(run())

    assert "telegram_claim_token" in columns
    assert "ix_x_response_decisions_telegram_claim_token" in indexes


def test_new_postgres_schema_contains_claim_column_and_index(
    postgres_database_url,
):
    import models  # noqa: F401
    from database import Base

    engine = create_async_engine(postgres_database_url)

    async def run():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
            columns, indexes = await connection.run_sync(
                lambda sync_connection: (
                    {
                        column["name"]
                        for column in inspect(sync_connection).get_columns(
                            "x_response_decisions"
                        )
                    },
                    {
                        index["name"]
                        for index in inspect(sync_connection).get_indexes(
                            "x_response_decisions"
                        )
                    },
                )
            )
        await engine.dispose()
        return columns, indexes

    columns, indexes = asyncio.run(run())

    assert "telegram_claim_token" in columns
    assert "ix_x_response_decisions_telegram_claim_token" in indexes
