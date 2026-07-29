import asyncio

from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import create_async_engine


def test_text_video_project_migration_is_idempotent(tmp_path):
    from database import migrate_text_video_project_schema

    engine = create_async_engine(
        f"sqlite+aiosqlite:///{tmp_path / 'text-video-migration.db'}",
    )

    async def run():
        async with engine.begin() as connection:
            await connection.execute(text(
                "CREATE TABLE text_video_projects "
                "(id INTEGER PRIMARY KEY, title VARCHAR NOT NULL)"
            ))
            await migrate_text_video_project_schema(connection)
            await migrate_text_video_project_schema(connection)
            columns = {
                column["name"]
                for column in await connection.run_sync(
                    lambda sync_connection: inspect(sync_connection)
                    .get_columns("text_video_projects")
                )
            }
        await engine.dispose()
        return columns

    columns = asyncio.run(run())

    assert {
        "id",
        "title",
        "status",
        "stage",
        "script",
        "voice_settings",
        "paragraphs",
        "render_input",
        "cover_asset_url",
        "output_asset_url",
        "revision",
        "created_at",
        "updated_at",
    } <= columns
