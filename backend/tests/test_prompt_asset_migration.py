import asyncio

from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import create_async_engine


def _columns(connection, table_name):
    return {
        column["name"]: column
        for column in inspect(connection).get_columns(table_name)
    }


def test_prompt_generation_model_declares_history_contract():
    from models import PromptGeneration

    table = PromptGeneration.__table__

    assert table.name == "prompt_generations"
    assert table.c.prompt_asset_id.index is True
    assert table.c.media_asset_id.nullable is True
    assert table.c.job_id.nullable is True
    assert table.c.generated_at.nullable is True
    assert table.c.status.default.arg == "queued"


def test_prompt_asset_schema_migration_is_idempotent(postgres_database_url):
    from database import migrate_prompt_asset_schema

    async def run():
        engine = create_async_engine(postgres_database_url)
        async with engine.begin() as connection:
            await connection.execute(text(
                "CREATE TABLE creative_assets ("
                "id INTEGER PRIMARY KEY, "
                "asset_type VARCHAR NOT NULL, "
                "title VARCHAR NOT NULL DEFAULT '', "
                "content TEXT NOT NULL DEFAULT ''"
                ")"
            ))
            await connection.execute(text(
                "INSERT INTO creative_assets (id, asset_type, title, content) "
                "VALUES (1, 'article', '旧资产', '正文')"
            ))

            await migrate_prompt_asset_schema(connection)
            await migrate_prompt_asset_schema(connection)

            asset_columns = await connection.run_sync(
                lambda sync_connection: _columns(sync_connection, "creative_assets")
            )
            generation_columns = await connection.run_sync(
                lambda sync_connection: _columns(sync_connection, "prompt_generations")
            )
            old_row = (
                await connection.execute(text(
                    "SELECT prompt_kind FROM creative_assets WHERE id = 1"
                ))
            ).scalar_one()

        await engine.dispose()
        return asset_columns, generation_columns, old_row

    asset_columns, generation_columns, old_row = asyncio.run(run())

    assert "prompt_kind" in asset_columns
    assert old_row == ""
    assert {
        "prompt_asset_id",
        "media_asset_id",
        "provider",
        "model",
        "status",
        "job_id",
        "error",
        "generated_at",
        "created_at",
    } <= set(generation_columns)
