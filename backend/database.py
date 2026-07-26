import os
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import DeclarativeBase

DATABASE_URL = os.getenv(
    "WMS_DATABASE_URL",
    "postgresql+asyncpg://postgres:123456@127.0.0.1:5432/wemedia",
)

_engine_kwargs: dict = dict(echo=False, pool_pre_ping=True)
if not DATABASE_URL.startswith("sqlite"):
    _engine_kwargs.update(pool_size=10, max_overflow=20)

engine = create_async_engine(DATABASE_URL, **_engine_kwargs)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)

class Base(DeclarativeBase):
    pass

async def get_db() -> AsyncSession:
    async with SessionLocal() as session:
        yield session

async def migrate_x_response_claim_schema(conn) -> None:
    """Add the delivery-claim column/index on both SQLite and PostgreSQL."""
    from sqlalchemy import text

    if conn.dialect.name == "sqlite":
        rows = (
            await conn.execute(text("PRAGMA table_info(x_response_decisions)"))
        ).all()
        if not rows:
            return
        columns = {row[1] for row in rows}
        if "telegram_claim_token" not in columns:
            await conn.execute(text(
                "ALTER TABLE x_response_decisions "
                "ADD COLUMN telegram_claim_token VARCHAR"
            ))
    else:
        await conn.execute(text(
            "ALTER TABLE x_response_decisions "
            "ADD COLUMN IF NOT EXISTS telegram_claim_token VARCHAR"
        ))
    await conn.execute(text(
        "CREATE INDEX IF NOT EXISTS "
        "ix_x_response_decisions_telegram_claim_token "
        "ON x_response_decisions (telegram_claim_token)"
    ))


async def migrate_removed_hot_topic_schema(conn) -> None:
    """Remove the retired topic generator while preserving processed history."""
    from sqlalchemy import inspect, text

    tables = set(await conn.run_sync(
        lambda sync_connection: inspect(sync_connection).get_table_names()
    ))
    if "x_response_decisions" in tables:
        await conn.execute(text(
            "UPDATE x_response_decisions "
            "SET workflow_status = 'used' "
            "WHERE workflow_status = 'converted'"
        ))
    await conn.execute(text("DROP TABLE IF EXISTS topic_generator_cache"))


async def init_db():
    from sqlalchemy import text
    async with engine.begin() as conn:
        # Drop legacy X tables (replaced by new schema). Dev DB only.
        # NOTE: x_posts is no longer dropped here — we keep collected data
        # across restarts and migrate the schema via ALTER TABLE below.
        await conn.execute(text("DROP TABLE IF EXISTS x_post_metrics CASCADE"))
        await conn.execute(text("DROP TABLE IF EXISTS x_blogger_candidates CASCADE"))
        # GitHub issues 功能已整体移除（2026-06）：数据可随时从 GitHub 重新拉取
        await conn.execute(text("DROP TABLE IF EXISTS github_issues CASCADE"))
        await conn.execute(text("DROP TABLE IF EXISTS issue_pain_points CASCADE"))
        # 旧选题链路已整体移除（2026-06）：通用 collector/analyzer + Topic 聚类，产出无人消费
        await conn.execute(text("DROP TABLE IF EXISTS topics CASCADE"))
        await conn.execute(text("DROP TABLE IF EXISTS topic_clusters CASCADE"))
        await conn.execute(text("DROP TABLE IF EXISTS posts CASCADE"))
        await conn.execute(text("DROP TABLE IF EXISTS accounts CASCADE"))

        if not DATABASE_URL.startswith("sqlite"):
            # Rename tables (idempotent)
            await conn.execute(text("ALTER TABLE IF EXISTS content_topics RENAME TO writing_plans"))
            await conn.execute(text("ALTER TABLE IF EXISTS topic_tags RENAME TO plan_tags"))
            await conn.execute(text("ALTER TABLE IF EXISTS content_topic_tags RENAME TO writing_plan_tags"))
            await conn.execute(text("ALTER TABLE IF EXISTS topic_sources RENAME TO plan_sources"))
            await conn.execute(text("ALTER TABLE IF EXISTS topic_updates RENAME TO plan_updates"))

        await migrate_removed_hot_topic_schema(conn)
        await conn.run_sync(Base.metadata.create_all)
        await conn.execute(text("ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS media_kind VARCHAR NOT NULL DEFAULT ''"))
        await conn.execute(text("ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS directory VARCHAR NOT NULL DEFAULT ''"))
        await conn.execute(text("ALTER TABLE creative_asset_directories ADD COLUMN IF NOT EXISTS asset_type VARCHAR NOT NULL DEFAULT 'article'"))
        await conn.execute(text("ALTER TABLE creative_asset_directories ADD COLUMN IF NOT EXISTS parent_id INTEGER"))
        if not DATABASE_URL.startswith("sqlite"):
            # The first version used a globally unique name. Directories now
            # have independent article/media trees, so the same name is valid
            # once in each tree.
            await conn.execute(text("ALTER TABLE creative_asset_directories DROP CONSTRAINT IF EXISTS creative_asset_directories_name_key"))
            await conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS uq_creative_asset_directories_asset_type_name ON creative_asset_directories (asset_type, name)"))
        # x_posts column additions (idempotent)
        await conn.execute(text(
            "ALTER TABLE x_posts ADD COLUMN IF NOT EXISTS author_avatar VARCHAR NOT NULL DEFAULT ''"
        ))
        await conn.execute(text(
            "ALTER TABLE x_posts ADD COLUMN IF NOT EXISTS cover_image VARCHAR NOT NULL DEFAULT ''"
        ))
        if not DATABASE_URL.startswith("sqlite"):
            # X search-subscription + ref-consumer schema (idempotent, PG only)
            await conn.execute(text("ALTER TABLE x_posts ADD COLUMN IF NOT EXISTS possibly_sensitive BOOLEAN NOT NULL DEFAULT FALSE"))
            await conn.execute(text("ALTER TABLE x_subscriptions ADD COLUMN IF NOT EXISTS kind VARCHAR NOT NULL DEFAULT 'timeline'"))
            await conn.execute(text("ALTER TABLE x_subscriptions ADD COLUMN IF NOT EXISTS raw_query VARCHAR NOT NULL DEFAULT ''"))
            await conn.execute(text("ALTER TABLE x_subscriptions ADD COLUMN IF NOT EXISTS min_faves INTEGER NOT NULL DEFAULT 0"))
            await conn.execute(text("ALTER TABLE x_subscriptions ADD COLUMN IF NOT EXISTS min_retweets INTEGER NOT NULL DEFAULT 0"))
            await conn.execute(text("ALTER TABLE x_subscriptions ADD COLUMN IF NOT EXISTS lang VARCHAR NOT NULL DEFAULT ''"))
            await conn.execute(text("ALTER TABLE x_subscriptions ADD COLUMN IF NOT EXISTS days INTEGER NOT NULL DEFAULT 1"))
            await conn.execute(text("ALTER TABLE x_subscriptions ADD COLUMN IF NOT EXISTS extra_terms VARCHAR NOT NULL DEFAULT ''"))
            await conn.execute(text("ALTER TABLE x_subscriptions ADD COLUMN IF NOT EXISTS sort VARCHAR NOT NULL DEFAULT 'top'"))
            await conn.execute(text("ALTER TABLE x_subscriptions ADD COLUMN IF NOT EXISTS max_results INTEGER NOT NULL DEFAULT 100"))
            await conn.execute(text("ALTER TABLE x_subscriptions ALTER COLUMN url DROP NOT NULL"))
            await conn.execute(text("ALTER TABLE reddit_posts ADD COLUMN IF NOT EXISTS body TEXT NOT NULL DEFAULT ''"))
            await conn.execute(text("ALTER TABLE reddit_posts ADD COLUMN IF NOT EXISTS comments JSON NOT NULL DEFAULT '[]'::json"))
            await conn.execute(text("ALTER TABLE reddit_posts ADD COLUMN IF NOT EXISTS fetch_status VARCHAR NOT NULL DEFAULT 'ok'"))
        # Lightweight in-place migrations for columns added after the original
        # table creation. PostgreSQL only — ADD COLUMN IF NOT EXISTS is no-op
        # when the column is already present.
        await conn.execute(text(
            "ALTER TABLE wechat_articles ADD COLUMN IF NOT EXISTS content TEXT NOT NULL DEFAULT ''"
        ))
        await conn.execute(text(
            "ALTER TABLE publish_accounts ADD COLUMN IF NOT EXISTS voice_samples JSON NOT NULL DEFAULT '[]'::json"
        ))
        await conn.execute(text(
            "ALTER TABLE publish_accounts ADD COLUMN IF NOT EXISTS style_rules JSON NOT NULL DEFAULT '[]'::json"
        ))
        await conn.execute(text(
            "ALTER TABLE publish_accounts ADD COLUMN IF NOT EXISTS cover_style JSON NOT NULL DEFAULT '{}'::json"
        ))
        await conn.execute(text(
            "ALTER TABLE publish_accounts ADD COLUMN IF NOT EXISTS daily_quota JSON NOT NULL DEFAULT '{}'::json"
        ))
        await migrate_x_response_claim_schema(conn)

        if not DATABASE_URL.startswith("sqlite"):
            # Writing plans brief field (added in redesign; idempotent)
            await conn.execute(text(
                "ALTER TABLE writing_plans ADD COLUMN IF NOT EXISTS brief TEXT NOT NULL DEFAULT ''"
            ))
            # Copy description → brief for existing rows that have no brief yet
            await conn.execute(text(
                "UPDATE writing_plans SET brief = description WHERE brief = '' AND description <> ''"
            ))
            # Reset parent_id — tree hierarchy replaced by tag model
            await conn.execute(text(
                "UPDATE writing_plans SET parent_id = NULL WHERE parent_id IS NOT NULL"
            ))

            # Column renames (idempotent via DO blocks)
            await conn.execute(text("""
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='writing_plan_tags' AND column_name='topic_id') THEN
    ALTER TABLE writing_plan_tags RENAME COLUMN topic_id TO plan_id;
  END IF;
END $$
"""))
            await conn.execute(text("""
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='plan_sources' AND column_name='topic_id') THEN
    ALTER TABLE plan_sources RENAME COLUMN topic_id TO plan_id;
  END IF;
END $$
"""))
            await conn.execute(text("""
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='plan_updates' AND column_name='topic_id') THEN
    ALTER TABLE plan_updates RENAME COLUMN topic_id TO plan_id;
  END IF;
END $$
"""))
            await conn.execute(text("""
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='article_drafts' AND column_name='content_topic_id') THEN
    ALTER TABLE article_drafts RENAME COLUMN content_topic_id TO writing_plan_id;
  END IF;
END $$
"""))
            await conn.execute(text("""
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='quotes' AND column_name='content_topic_id') THEN
    ALTER TABLE quotes RENAME COLUMN content_topic_id TO writing_plan_id;
  END IF;
END $$
"""))
        # plan_updates: created by Base.metadata.create_all above (no raw DDL needed)

        await conn.execute(text("DROP TABLE IF EXISTS ref_seen CASCADE"))
        await conn.execute(text("DROP TABLE IF EXISTS ref_collect_rules CASCADE"))
        await conn.execute(text("DROP TABLE IF EXISTS ref_materials CASCADE"))
