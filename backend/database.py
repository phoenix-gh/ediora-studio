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

async def init_db():
    from sqlalchemy import text
    async with engine.begin() as conn:
        # Drop legacy X tables (replaced by new schema). Dev DB only.
        # NOTE: x_posts is no longer dropped here — we keep collected data
        # across restarts and migrate the schema via ALTER TABLE below.
        await conn.execute(text("DROP TABLE IF EXISTS x_post_metrics CASCADE"))
        await conn.execute(text("DROP TABLE IF EXISTS x_blogger_candidates CASCADE"))

        if not DATABASE_URL.startswith("sqlite"):
            # Rename tables (idempotent)
            await conn.execute(text("ALTER TABLE IF EXISTS content_topics RENAME TO writing_plans"))
            await conn.execute(text("ALTER TABLE IF EXISTS topic_tags RENAME TO plan_tags"))
            await conn.execute(text("ALTER TABLE IF EXISTS content_topic_tags RENAME TO writing_plan_tags"))
            await conn.execute(text("ALTER TABLE IF EXISTS topic_sources RENAME TO plan_sources"))
            await conn.execute(text("ALTER TABLE IF EXISTS topic_updates RENAME TO plan_updates"))

        await conn.run_sync(Base.metadata.create_all)
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
            await conn.execute(text("ALTER TABLE ref_collect_rules ADD COLUMN IF NOT EXISTS source_subscription_id INTEGER"))
        # Lightweight in-place migrations for columns added after the original
        # table creation. PostgreSQL only — ADD COLUMN IF NOT EXISTS is no-op
        # when the column is already present.
        await conn.execute(text(
            "ALTER TABLE wechat_articles ADD COLUMN IF NOT EXISTS content TEXT NOT NULL DEFAULT ''"
        ))
        await conn.execute(text(
            "ALTER TABLE writer_personas ADD COLUMN IF NOT EXISTS model VARCHAR NOT NULL DEFAULT ''"
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

    # One-off: migrate legacy quotes into unified ref_materials (idempotent)
    try:
        from ref_migrate import migrate_quotes_to_materials
        async with SessionLocal() as db:
            await migrate_quotes_to_materials(db)
    except Exception as e:
        print(f"[init_db] quotes→materials migration skipped: {e}")
