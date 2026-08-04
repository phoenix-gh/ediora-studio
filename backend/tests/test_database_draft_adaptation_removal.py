import asyncio

from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import create_async_engine


def test_removes_adapted_children_and_legacy_columns_idempotently(tmp_path):
    from database import migrate_removed_draft_adaptation_schema

    engine = create_async_engine(
        f"sqlite+aiosqlite:///{tmp_path / 'draft-adaptation.db'}",
    )

    async def run():
        async with engine.begin() as connection:
            await connection.execute(text("""
                CREATE TABLE article_drafts (
                    id INTEGER PRIMARY KEY,
                    title VARCHAR NOT NULL,
                    draft_type VARCHAR NOT NULL,
                    linked_draft_id INTEGER
                )
            """))
            await connection.execute(text("""
                CREATE TABLE draft_images (
                    id INTEGER PRIMARY KEY,
                    root_draft_id INTEGER NOT NULL,
                    filename VARCHAR NOT NULL
                )
            """))
            await connection.execute(text("""
                CREATE TABLE draft_chat_logs (
                    id INTEGER PRIMARY KEY,
                    draft_id INTEGER NOT NULL
                )
            """))
            await connection.execute(text("""
                CREATE TABLE content_usage_ledger (
                    id INTEGER PRIMARY KEY,
                    output_kind VARCHAR NOT NULL,
                    draft_id INTEGER
                )
            """))
            await connection.execute(text("""
                INSERT INTO article_drafts VALUES
                    (10, 'parent', 'article', NULL),
                    (11, 'adapted', 'x', 10),
                    (12, 'daily X', 'x_post', NULL)
            """))
            await connection.execute(text("""
                INSERT INTO draft_images VALUES (1, 10, 'cover.png')
            """))
            await connection.execute(text("""
                INSERT INTO draft_chat_logs VALUES (1, 11)
            """))
            await connection.execute(text("""
                INSERT INTO content_usage_ledger VALUES
                    (1, 'draft', 11),
                    (2, 'plan_item', 11)
            """))

            await migrate_removed_draft_adaptation_schema(connection)
            await migrate_removed_draft_adaptation_schema(connection)

            drafts = (await connection.execute(text(
                "SELECT id, draft_type FROM article_drafts ORDER BY id"
            ))).all()
            article_columns = {
                column["name"]
                for column in await connection.run_sync(
                    lambda sync: inspect(sync).get_columns("article_drafts")
                )
            }
            image_columns = {
                column["name"]
                for column in await connection.run_sync(
                    lambda sync: inspect(sync).get_columns("draft_images")
                )
            }
            image = (await connection.execute(text(
                "SELECT id, draft_id FROM draft_images"
            ))).one()
            chat_count = (await connection.execute(text(
                "SELECT count(*) FROM draft_chat_logs"
            ))).scalar_one()
            usage_rows = (await connection.execute(text(
                "SELECT id, output_kind, draft_id "
                "FROM content_usage_ledger ORDER BY id"
            ))).all()
        await engine.dispose()
        return (
            drafts,
            article_columns,
            image_columns,
            image,
            chat_count,
            usage_rows,
        )

    result = asyncio.run(run())
    drafts, article_columns, image_columns, image, chat_count, usage_rows = result
    assert drafts == [(10, "article"), (12, "x")]
    assert "linked_draft_id" not in article_columns
    assert "root_draft_id" not in image_columns
    assert "draft_id" in image_columns
    assert image == (1, 10)
    assert chat_count == 0
    assert usage_rows == [(2, "plan_item", 11)]


def test_accepts_fresh_database_without_legacy_tables(tmp_path):
    from database import migrate_removed_draft_adaptation_schema

    engine = create_async_engine(
        f"sqlite+aiosqlite:///{tmp_path / 'fresh.db'}",
    )

    async def run():
        async with engine.begin() as connection:
            await migrate_removed_draft_adaptation_schema(connection)
        await engine.dispose()

    asyncio.run(run())
