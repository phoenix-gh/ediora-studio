import asyncio
import sys
from types import SimpleNamespace

from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import create_async_engine


def _reload_database_modules():
    for module_name in list(sys.modules):
        if module_name.startswith(("database", "models")):
            sys.modules.pop(module_name, None)


async def _table_snapshot(connection):
    return await connection.run_sync(
        lambda sync_connection: {
            table_name: {
                column["name"]
                for column in inspect(sync_connection).get_columns(table_name)
            }
            for table_name in inspect(sync_connection).get_table_names()
        }
    )


def test_retired_table_drop_keeps_postgresql_cascade():
    from database import _drop_tables

    class RecordingConnection:
        dialect = SimpleNamespace(name="postgresql")

        def __init__(self):
            self.statements = []

        async def execute(self, statement):
            self.statements.append(str(statement))

    connection = RecordingConnection()

    asyncio.run(_drop_tables(connection, ("legacy_one", "legacy_two")))

    assert connection.statements == [
        'DROP TABLE IF EXISTS "legacy_one" CASCADE',
        'DROP TABLE IF EXISTS "legacy_two" CASCADE',
    ]


def test_init_db_twice_creates_postgresql_core_tables(postgres_env):
    _reload_database_modules()
    import models  # noqa: F401
    from database import engine, init_db

    async def run():
        await init_db()
        await init_db()
        async with engine.connect() as connection:
            snapshot = await _table_snapshot(connection)
        await engine.dispose()
        return snapshot

    tables = asyncio.run(run())

    assert {
        "app_settings",
        "content_jobs",
        "text_video_projects",
        "text_video_speech_assets",
        "daily_creation_rules",
        "daily_creation_runs",
        "daily_creation_output_batches",
        "content_usage_ledger",
        "agent_executions",
        "agent_tool_calls",
        "agent_message_logs",
    } <= tables.keys()
    assert {
        "script",
        "paragraphs",
        "master_audio",
        "scene_plan",
        "render_input",
    } <= tables["text_video_projects"]
    assert {"sample_count", "sample_rate"} <= tables[
        "text_video_speech_assets"
    ]
    assert {
        "intelligence_enabled",
        "intelligence_enabled_at",
        "collect_interval_minutes",
    } <= tables["x_subscriptions"]
    assert "session_ciphertext" in tables["x_credential_accounts"]
    assert "screening_prompt" in tables["topic_source_rules"]
    assert {"notify_new_posts", "notify_enabled_at"}.isdisjoint(
        tables["x_subscriptions"]
    )
    assert "daily_plans" not in tables
    assert "daily_plan_items" not in tables
    assert "linked_draft_id" not in tables["article_drafts"]
    assert "draft_id" in tables["draft_images"]
    assert "root_draft_id" not in tables["draft_images"]


def test_init_db_removes_daily_plan_tables_and_backfills_rule_directories(
    postgres_env, caplog,
):
    _reload_database_modules()
    import models  # noqa: F401
    from database import engine, init_db

    async def run():
        async with engine.begin() as connection:
            await connection.execute(text(
                "CREATE TABLE daily_plan_items ("
                "id INTEGER PRIMARY KEY, plan_id INTEGER NOT NULL, "
                "account_id VARCHAR NOT NULL, title VARCHAR NOT NULL)"
            ))
            await connection.execute(text(
                "CREATE TABLE daily_plans ("
                "id INTEGER PRIMARY KEY, plan_date VARCHAR NOT NULL)"
            ))
            await connection.execute(text(
                "CREATE TABLE daily_creation_rules ("
                "id INTEGER PRIMARY KEY, name VARCHAR NOT NULL, "
                "asset_type VARCHAR NOT NULL, directory VARCHAR NOT NULL, "
                "output_type VARCHAR NOT NULL, target_count VARCHAR NOT NULL, "
                "execution_mode VARCHAR NOT NULL, scheduled_date VARCHAR, "
                "scheduled_time VARCHAR NOT NULL, timezone VARCHAR NOT NULL, "
                "lookback_days INTEGER NOT NULL, delivery_mode VARCHAR NOT NULL, "
                "account_id VARCHAR, instructions TEXT NOT NULL DEFAULT '', "
                "skill_mode VARCHAR NOT NULL DEFAULT 'auto', skill_name VARCHAR, "
                "enabled BOOLEAN NOT NULL DEFAULT TRUE, deleted_at TIMESTAMPTZ, "
                "created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL)"
            ))
            await connection.execute(text(
                "INSERT INTO daily_creation_rules ("
                "id, name, asset_type, directory, output_type, target_count, "
                "execution_mode, scheduled_time, timezone, lookback_days, "
                "delivery_mode, account_id, skill_mode, skill_name, "
                "created_at, updated_at) VALUES ("
                "1, '旧规则', 'media', '增长实验', 'x_short_post', 2, "
                "'recurring', '09:00', 'Asia/Shanghai', 7, 'drafts', "
                "'x-account-42', 'manual', 'x-article-writing', NOW(), NOW())"
            ))
            await connection.execute(text(
                "INSERT INTO daily_creation_rules ("
                "id, name, asset_type, directory, output_type, target_count, "
                "execution_mode, scheduled_time, timezone, lookback_days, "
                "delivery_mode, created_at, updated_at) VALUES ("
                "2, '损坏规则', 'article', '异常目录', 'x_short_post', 'invalid', "
                "'recurring', '09:00', 'Asia/Shanghai', 7, 'drafts', NOW(), NOW())"
            ))
        await init_db()
        await init_db()
        async with engine.connect() as connection:
            tables = await _table_snapshot(connection)
            rows = (
                await connection.execute(text(
                    "SELECT id, directories, skill_mode, skill_name, prompt, enabled "
                    "FROM daily_creation_rules ORDER BY id"
                ))
            ).all()
        await engine.dispose()
        return tables, rows

    tables, rows = asyncio.run(run())

    assert "daily_plans" not in tables
    assert "daily_plan_items" not in tables
    assert {"directories", "skill_mode", "skill_name", "prompt"} <= tables[
        "daily_creation_rules"
    ]
    assert rows[0][:4] == (1, ["增长实验"], "manual", "x-article-writing")
    assert "增长实验" in rows[0][4]
    assert "媒体素材" in rows[0][4]
    assert "x-account-42" in rows[0][4]
    assert "x-article-writing" in rows[0][4]
    assert "record_content_usage" in rows[0][4]
    assert 'draft_type="x"' in rows[0][4]
    assert rows[0][5] is True
    assert rows[1] == (2, ["异常目录"], "auto", None, "", False)
    warning = "\n".join(record.getMessage() for record in caplog.records)
    assert "daily creation rule 2" in warning
    assert "invalid" not in warning


def test_intelligence_subscription_migration_removes_legacy_runtime_columns(
    postgres_database_url,
):
    from database import migrate_intelligence_subscription_schema

    async def run():
        engine = create_async_engine(postgres_database_url)
        async with engine.begin() as connection:
            await connection.execute(text(
                "CREATE TABLE x_subscriptions ("
                "id INTEGER PRIMARY KEY, "
                "notify_new_posts BOOLEAN NOT NULL DEFAULT FALSE, "
                "notify_enabled_at TIMESTAMPTZ)"
            ))
            await connection.execute(text(
                "CREATE TABLE x_posts ("
                "tweet_id VARCHAR PRIMARY KEY, x_reply_score FLOAT, "
                "x_reply_draft TEXT, x_reply_notified_at TIMESTAMPTZ)"
            ))
            await migrate_intelligence_subscription_schema(connection)
            snapshot = await _table_snapshot(connection)
        await engine.dispose()
        return snapshot

    tables = asyncio.run(run())
    assert {"intelligence_enabled", "intelligence_enabled_at"} <= tables[
        "x_subscriptions"
    ]
    assert {"notify_new_posts", "notify_enabled_at"}.isdisjoint(
        tables["x_subscriptions"]
    )
    assert {
        "x_reply_score",
        "x_reply_draft",
        "x_reply_notified_at",
    }.isdisjoint(tables["x_posts"])


def test_daily_creation_batch_migration_removes_legacy_plan_item_column(
    postgres_database_url,
):
    from database import migrate_daily_creation_output_batch_schema

    async def run():
        engine = create_async_engine(postgres_database_url)
        async with engine.begin() as connection:
            await connection.execute(text(
                "CREATE TABLE daily_creation_output_batches ("
                "id INTEGER PRIMARY KEY, plan_item_ids JSON NOT NULL)"
            ))
            await migrate_daily_creation_output_batch_schema(connection)
            snapshot = await _table_snapshot(connection)
        await engine.dispose()
        return snapshot

    tables = asyncio.run(run())
    assert "plan_item_ids" not in tables["daily_creation_output_batches"]
