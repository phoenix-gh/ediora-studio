import asyncio

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine


def test_existing_sqlite_response_table_gains_claim_column_and_index_idempotently(
    tmp_path,
):
    from database import migrate_x_response_claim_schema

    engine = create_async_engine(
        f"sqlite+aiosqlite:///{tmp_path / 'migration.db'}",
    )

    async def run():
        async with engine.begin() as connection:
            await connection.execute(text(
                "CREATE TABLE x_response_decisions ("
                "id INTEGER PRIMARY KEY, telegram_status VARCHAR NOT NULL"
                ")"
            ))
            await migrate_x_response_claim_schema(connection)
            await migrate_x_response_claim_schema(connection)
            columns = {
                row[1]
                for row in (
                    await connection.execute(
                        text("PRAGMA table_info(x_response_decisions)")
                    )
                ).all()
            }
            indexes = {
                row[1]
                for row in (
                    await connection.execute(
                        text("PRAGMA index_list(x_response_decisions)")
                    )
                ).all()
            }
        await engine.dispose()
        return columns, indexes

    columns, indexes = asyncio.run(run())

    assert "telegram_claim_token" in columns
    assert "ix_x_response_decisions_telegram_claim_token" in indexes


def test_new_sqlite_schema_contains_claim_column_and_index(tmp_path):
    import models  # noqa: F401
    from database import Base

    engine = create_async_engine(
        f"sqlite+aiosqlite:///{tmp_path / 'new.db'}",
    )

    async def run():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
            columns = {
                row[1]
                for row in (
                    await connection.execute(
                        text("PRAGMA table_info(x_response_decisions)")
                    )
                ).all()
            }
            indexes = {
                row[1]
                for row in (
                    await connection.execute(
                        text("PRAGMA index_list(x_response_decisions)")
                    )
                ).all()
            }
        await engine.dispose()
        return columns, indexes

    columns, indexes = asyncio.run(run())

    assert "telegram_claim_token" in columns
    assert "ix_x_response_decisions_telegram_claim_token" in indexes
