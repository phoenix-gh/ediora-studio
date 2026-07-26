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


async def migrate_removed_publication_schema(conn) -> None:
    """Remove the retired publication-record and statistics store."""
    from sqlalchemy import text

    await conn.execute(text("DROP TABLE IF EXISTS publications"))


async def _add_columns(conn, table_name: str, definitions: dict[str, str]) -> None:
    """Add missing columns on SQLite and PostgreSQL without rebuilding tables."""
    from sqlalchemy import inspect, text

    tables = set(await conn.run_sync(
        lambda sync_connection: inspect(sync_connection).get_table_names()
    ))
    if table_name not in tables:
        return
    columns = {
        column["name"]
        for column in await conn.run_sync(
            lambda sync_connection: inspect(sync_connection).get_columns(table_name)
        )
    }
    for name, definition in definitions.items():
        if name not in columns:
            await conn.execute(text(
                f'ALTER TABLE "{table_name}" ADD COLUMN "{name}" {definition}'
            ))


async def migrate_content_response_schema(conn) -> None:
    """Add YouTube response fields and copy legacy X decisions exactly once."""
    from sqlalchemy import inspect, select
    from models import (
        ContentAnalysisRun,
        ContentResponseItem,
        ContentResponseNotification,
        ContentResponseOutput,
        XPost,
        XResponseDecision,
    )

    json_default = "'[]'" if conn.dialect.name == "sqlite" else "'[]'::json"
    await _add_columns(conn, "youtube_channels", {
        "auto_analyze_new_videos": "BOOLEAN NOT NULL DEFAULT FALSE",
        "analysis_enabled_at": "TIMESTAMP",
    })
    await _add_columns(conn, "youtube_videos", {
        "transcript_status": "VARCHAR NOT NULL DEFAULT 'not_requested'",
        "transcript_source": "VARCHAR NOT NULL DEFAULT ''",
        "transcript_language": "VARCHAR NOT NULL DEFAULT ''",
        "transcript_text": "TEXT NOT NULL DEFAULT ''",
        "transcript_segments": f"JSON NOT NULL DEFAULT {json_default}",
        "transcript_content_hash": "VARCHAR NOT NULL DEFAULT ''",
        "transcript_fetched_at": "TIMESTAMP",
        "transcript_error_code": "VARCHAR NOT NULL DEFAULT ''",
        "transcript_error": "TEXT NOT NULL DEFAULT ''",
    })

    tables = set(await conn.run_sync(
        lambda sync_connection: inspect(sync_connection).get_table_names()
    ))
    if "x_response_decisions" not in tables:
        return

    decisions = (await conn.execute(select(XResponseDecision.__table__))).mappings().all()
    for decision in decisions:
        existing_item = (await conn.execute(
            select(ContentResponseItem.__table__.c.id).where(
                ContentResponseItem.__table__.c.source_type == "x_post",
                ContentResponseItem.__table__.c.source_id == decision["tweet_id"],
            )
        )).scalar_one_or_none()
        post = (await conn.execute(
            select(XPost.__table__).where(XPost.__table__.c.tweet_id == decision["tweet_id"])
        )).mappings().first()
        if existing_item is None:
            result = await conn.execute(ContentResponseItem.__table__.insert().values(
                source_type="x_post",
                source_id=decision["tweet_id"],
                source_url=(post or {}).get("url", ""),
                source_title=((post or {}).get("content", "") or "")[:500],
                source_author=(post or {}).get("username", ""),
                source_published_at=(post or {}).get("published_at"),
                workflow_status="ready",
                decision_status={
                    "used": "adopted",
                    "ignored": "rejected",
                }.get(decision["workflow_status"], "pending"),
                created_at=decision["created_at"],
                updated_at=decision["updated_at"],
            ))
            existing_item = result.inserted_primary_key[0]

        analysis_id = (await conn.execute(
            select(ContentAnalysisRun.__table__.c.id).where(
                ContentAnalysisRun.__table__.c.response_item_id == existing_item,
                ContentAnalysisRun.__table__.c.version == 1,
            )
        )).scalar_one_or_none()
        if analysis_id is None:
            result = await conn.execute(ContentAnalysisRun.__table__.insert().values(
                response_item_id=existing_item,
                version=1,
                status="succeeded",
                content_value_score=decision["score"],
                value_dimensions={"legacy_score": decision["score"]},
                summary_cn=decision["summary_cn"],
                core_thesis=decision["summary_cn"],
                evidence=decision["claims"] or [],
                recommended_action=decision["action"],
                recommendation_reason=decision["reason"],
                model_provider=decision["model_provider"],
                model_name=decision["model_name"],
                prompt_version=decision["prompt_version"],
                policy_version=decision["decision_policy_version"],
                source_snapshot={
                    "verification_status": decision["verification_status"],
                    "verified_urls": decision["verified_urls"] or [],
                },
                created_at=decision["created_at"],
                completed_at=decision["updated_at"],
            ))
            analysis_id = result.inserted_primary_key[0]

        await conn.execute(
            ContentResponseItem.__table__.update()
            .where(ContentResponseItem.__table__.c.id == existing_item)
            .values(current_analysis_run_id=analysis_id)
        )
        for output_type, content in (
            ("x_reply", decision["comment_draft"]),
            ("x_quote", decision["quote_draft"]),
        ):
            if not content:
                continue
            exists = (await conn.execute(
                select(ContentResponseOutput.__table__.c.id).where(
                    ContentResponseOutput.__table__.c.analysis_run_id == analysis_id,
                    ContentResponseOutput.__table__.c.output_type == output_type,
                )
            )).scalar_one_or_none()
            if exists is None:
                await conn.execute(ContentResponseOutput.__table__.insert().values(
                    response_item_id=existing_item,
                    analysis_run_id=analysis_id,
                    output_type=output_type,
                    status="draft_ready",
                    content=content,
                    source_attribution={"url": (post or {}).get("url", "")},
                    created_at=decision["created_at"],
                    updated_at=decision["updated_at"],
                ))

        notification = (await conn.execute(
            select(ContentResponseNotification.__table__.c.id).where(
                ContentResponseNotification.__table__.c.analysis_run_id == analysis_id,
                ContentResponseNotification.__table__.c.channel == "telegram",
                ContentResponseNotification.__table__.c.notification_tier
                == decision["notification_tier"],
            )
        )).scalar_one_or_none()
        if notification is None:
            await conn.execute(ContentResponseNotification.__table__.insert().values(
                response_item_id=existing_item,
                analysis_run_id=analysis_id,
                channel="telegram",
                notification_tier=decision["notification_tier"],
                status=decision["telegram_status"],
                message_ids=decision["telegram_message_ids"] or [],
                attempts=decision["telegram_attempts"],
                claim_token=decision["telegram_claim_token"],
                last_error=decision["telegram_last_error"],
                notified_at=decision["notified_at"],
                created_at=decision["created_at"],
                updated_at=decision["updated_at"],
            ))


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
        await migrate_removed_publication_schema(conn)
        await conn.run_sync(Base.metadata.create_all)
        await migrate_content_response_schema(conn)
        await conn.execute(text("ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS media_kind VARCHAR NOT NULL DEFAULT ''"))
        await conn.execute(text("ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS directory VARCHAR NOT NULL DEFAULT ''"))
        await conn.execute(text("ALTER TABLE creative_asset_directories ADD COLUMN IF NOT EXISTS asset_type VARCHAR NOT NULL DEFAULT 'article'"))
        await conn.execute(text("ALTER TABLE creative_asset_directories ADD COLUMN IF NOT EXISTS parent_id INTEGER"))
        await conn.execute(text(
            "ALTER TABLE creative_asset_directories "
            "ADD COLUMN IF NOT EXISTS system_key VARCHAR"
        ))
        if not DATABASE_URL.startswith("sqlite"):
            # The first version used a globally unique name. Directories now
            # have independent article/media trees, so the same name is valid
            # once in each tree.
            await conn.execute(text("ALTER TABLE creative_asset_directories DROP CONSTRAINT IF EXISTS creative_asset_directories_name_key"))
            await conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS uq_creative_asset_directories_asset_type_name ON creative_asset_directories (asset_type, name)"))
            await conn.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS "
                "uq_creative_asset_directories_system_key "
                "ON creative_asset_directories (system_key) "
                "WHERE system_key IS NOT NULL"
            ))
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
