import asyncio
from datetime import datetime, timezone

import pytest
from sqlalchemy import inspect, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


def _run_migration(postgres_database_url, *, migrate: bool):
    import models
    from database import (
        Base,
        migrate_content_response_schema,
        retire_x_response_decision_schema,
    )

    engine = create_async_engine(postgres_database_url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)

    async def run():
        now = datetime.now(timezone.utc)
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with sessions() as db:
            subscription = models.XSubscription(
                url="https://x.com/openai",
                label="OpenAI",
            )
            db.add(subscription)
            await db.flush()
            db.add(models.XPost(
                tweet_id="legacy-1",
                subscription_id=subscription.id,
                username="OpenAI",
                content="A durable legacy decision",
                url="https://x.com/openai/status/legacy-1",
                published_at=now,
            ))
            db.add(models.XResponseDecision(
                tweet_id="legacy-1",
                subscription_id=subscription.id,
                action="comment",
                score=82,
                confidence=0.88,
                reason="有明确的信息增量",
                summary_cn="这是一个值得响应的更新。",
                comment_draft="补充一个实际使用视角。",
                claims=[{"text": "已发布", "verified": True}],
                verification_status="verified",
                verified_urls=[{"url": "https://example.com/source"}],
                notification_tier="immediate",
                workflow_status="used",
                model_provider="openai",
                model_name="gpt-test",
                prompt_version="legacy-v1",
                telegram_status="sent",
                telegram_message_ids=[101],
                telegram_attempts=1,
                telegram_last_error="",
                notified_at=now,
            ))
            await db.commit()

        error = None
        try:
            async with engine.begin() as connection:
                if migrate:
                    await migrate_content_response_schema(connection)
                await retire_x_response_decision_schema(connection)
        except RuntimeError as exc:
            error = str(exc)

        async with engine.connect() as connection:
            tables = set(await connection.run_sync(
                lambda sync_connection: inspect(
                    sync_connection
                ).get_table_names()
            ))
            item = (await connection.execute(
                select(models.ContentResponseItem.__table__).where(
                    models.ContentResponseItem.__table__.c.source_id
                    == "legacy-1"
                )
            )).mappings().one_or_none()
            run_row = None
            if item and item["current_analysis_run_id"]:
                run_row = (await connection.execute(
                    select(models.ContentAnalysisRun.__table__).where(
                        models.ContentAnalysisRun.__table__.c.id
                        == item["current_analysis_run_id"]
                    )
                )).mappings().one()
        await engine.dispose()
        return error, tables, item, run_row

    return asyncio.run(run())


def test_legacy_x_decisions_migrate_then_table_is_retired(
    postgres_database_url,
):
    error, tables, item, run = _run_migration(
        postgres_database_url,
        migrate=True,
    )

    assert error is None
    assert "x_response_decisions" not in tables
    assert item["decision_status"] == "worth_writing"
    assert run["content_value_score"] == 82
    assert run["source_snapshot"]["x_response"]["confidence"] == 0.88


def test_legacy_x_table_is_preserved_when_parity_check_fails(
    postgres_database_url,
):
    error, tables, item, run = _run_migration(
        postgres_database_url,
        migrate=False,
    )

    assert "missing unified item" in error
    assert "x_response_decisions" in tables
    assert item is None
    assert run is None


def test_intelligence_station_migration_maps_legacy_decision_statuses(
    postgres_database_url,
):
    import models
    from database import Base, migrate_intelligence_station_schema

    engine = create_async_engine(postgres_database_url)

    async def run():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
            await connection.execute(models.ContentResponseItem.__table__.insert(), [
                {"source_type": "x_post", "source_id": "pending", "decision_status": "pending"},
                {"source_type": "x_post", "source_id": "adopted", "decision_status": "adopted"},
                {"source_type": "x_post", "source_id": "rejected", "decision_status": "rejected"},
                {"source_type": "x_post", "source_id": "later", "decision_status": "later"},
            ])
            await migrate_intelligence_station_schema(connection)
            await migrate_intelligence_station_schema(connection)

        async with engine.connect() as connection:
            rows = (await connection.execute(
                models.ContentResponseItem.__table__.select().order_by(
                    models.ContentResponseItem.__table__.c.source_id,
                )
            )).mappings().all()
        await engine.dispose()
        return {row["source_id"]: row["decision_status"] for row in rows}

    assert asyncio.run(run()) == {
        "adopted": "worth_writing",
        "later": "pending",
        "pending": "pending",
        "rejected": "not_processed",
    }
