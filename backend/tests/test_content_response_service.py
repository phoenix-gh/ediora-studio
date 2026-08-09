import asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import pytest


def valid_analysis():
    return {
        "content_value_score": 78,
        "value_dimensions": {
            key: {"score": 70, "reason": "有具体信息"}
            for key in (
                "novelty",
                "practicality",
                "credibility",
                "writing_space",
                "evergreen_value",
            )
        },
        "summary_cn": "中文摘要",
        "core_thesis": "核心思想",
        "value_points": ["价值"],
        "evidence": [{"text": "证据", "type": "source_claim"}],
        "risks": [],
        "verification_items": [],
        "recommended_content_types": ["research", "tutorial"],
        "recommended_disposition": "worth_writing",
        "recommendation_reason": "值得扩写",
        "suggested_title": "一篇值得写的文章",
        "suggested_angle": "从实践路径切入",
        "target_reader": "正在搭建内容系统的创作者",
        "suggested_structure": ["开篇", "论证", "结论"],
    }


def _x_subscription_and_post(*, intelligence_enabled, intelligence_enabled_at, collected_at):
    from models import XPost, XSubscription

    subscription = XSubscription(
        url="https://x.com/intelligence-source",
        label="情报来源",
        enabled=True,
        intelligence_enabled=intelligence_enabled,
        intelligence_enabled_at=intelligence_enabled_at,
    )
    post = XPost(
        tweet_id="intel-post-1",
        subscription_id=0,
        username="source",
        display_name="Source",
        content="一条有价值的新帖",
        url="https://x.com/source/status/intel-post-1",
        published_at=collected_at,
        collected_at=collected_at,
    )
    return subscription, post


def test_dispatch_skips_subscription_without_intelligence_enabled(
    postgres_database_url,
):
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from content_response_service import dispatch_intelligence_posts
    from database import Base
    from models import ContentResponseItem

    async def run():
        engine = create_async_engine(postgres_database_url)
        session_factory = async_sessionmaker(engine, expire_on_commit=False)
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with session_factory() as db:
            now = datetime.now(timezone.utc)
            subscription, post = _x_subscription_and_post(
                intelligence_enabled=False,
                intelligence_enabled_at=None,
                collected_at=now,
            )
            db.add(subscription)
            await db.flush()
            post.subscription_id = subscription.id
            db.add(post)
            await db.flush()
            result = await dispatch_intelligence_posts(
                db, subscription, [post.tweet_id], enqueue=AsyncMock(),
            )
            item = await db.scalar(select(ContentResponseItem))
        await engine.dispose()
        return result, item

    result, item = asyncio.run(run())
    assert result == {"created": 0, "enqueued": 0, "errors": []}
    assert item is None


def test_dispatch_skips_post_collected_before_intelligence_enabled(
    postgres_database_url,
):
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from content_response_service import dispatch_intelligence_posts
    from database import Base
    from models import ContentResponseItem

    async def run():
        engine = create_async_engine(postgres_database_url)
        session_factory = async_sessionmaker(engine, expire_on_commit=False)
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with session_factory() as db:
            now = datetime.now(timezone.utc)
            subscription, post = _x_subscription_and_post(
                intelligence_enabled=True,
                intelligence_enabled_at=now,
                collected_at=now - timedelta(seconds=1),
            )
            db.add(subscription)
            await db.flush()
            post.subscription_id = subscription.id
            db.add(post)
            await db.flush()
            result = await dispatch_intelligence_posts(
                db, subscription, [post.tweet_id], enqueue=AsyncMock(),
            )
            item = await db.scalar(select(ContentResponseItem))
        await engine.dispose()
        return result, item

    result, item = asyncio.run(run())
    assert result == {"created": 0, "enqueued": 0, "errors": []}
    assert item is None


def test_dispatch_persists_subscription_on_new_intelligence_item(
    postgres_database_url,
):
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from content_response_service import dispatch_intelligence_posts
    from database import Base
    from models import ContentResponseItem

    async def run():
        engine = create_async_engine(postgres_database_url)
        session_factory = async_sessionmaker(engine, expire_on_commit=False)
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with session_factory() as db:
            now = datetime.now(timezone.utc)
            subscription, post = _x_subscription_and_post(
                intelligence_enabled=True,
                intelligence_enabled_at=now - timedelta(minutes=1),
                collected_at=now,
            )
            db.add(subscription)
            await db.flush()
            post.subscription_id = subscription.id
            db.add(post)
            await db.flush()
            result = await dispatch_intelligence_posts(
                db, subscription, [post.tweet_id], enqueue=AsyncMock(),
            )
            item = await db.scalar(select(ContentResponseItem))
        await engine.dispose()
        return result, item

    result, item = asyncio.run(run())
    assert result["created"] == 1
    assert item is not None
    assert item.subscription_id == 1


def test_analysis_contract_requires_all_five_value_dimensions():
    from content_response_service import validate_analysis_payload

    payload = valid_analysis()
    del payload["value_dimensions"]["credibility"]

    with pytest.raises(ValueError, match="value_dimensions"):
        validate_analysis_payload(payload)


def test_low_value_analysis_is_valid_and_kept():
    from content_response_service import validate_analysis_payload

    payload = valid_analysis()
    payload["content_value_score"] = 12

    assert validate_analysis_payload(payload)["content_value_score"] == 12


def test_invalid_content_type_is_rejected():
    from content_response_service import validate_analysis_payload

    payload = valid_analysis()
    payload["recommended_content_types"] = ["commentary"]

    with pytest.raises(ValueError, match="content type"):
        validate_analysis_payload(payload)


def test_invalid_recommended_disposition_is_rejected():
    from content_response_service import validate_analysis_payload

    payload = valid_analysis()
    payload["recommended_disposition"] = "later"

    with pytest.raises(ValueError, match="disposition"):
        validate_analysis_payload(payload)


def test_persist_analysis_preserves_user_classification_on_reanalysis(
    postgres_database_url,
):
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from content_response_service import persist_analysis
    from database import Base
    from models import ContentAnalysisRun, ContentResponseItem

    engine = create_async_engine(postgres_database_url)
    SessionLocal = async_sessionmaker(engine, expire_on_commit=False)

    async def run():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with SessionLocal() as db:
            item = ContentResponseItem(
                source_type="x_post",
                source_id="post-1",
                content_types=["tool"],
                decision_status="creative_asset",
            )
            db.add(item)
            await db.flush()
            analysis_run = ContentAnalysisRun(
                response_item_id=item.id,
                version=1,
            )
            db.add(analysis_run)
            await db.flush()
            await persist_analysis(db, item.id, analysis_run.id, valid_analysis())
            await db.refresh(item)
            await db.refresh(analysis_run)
            result = {
                "decision_status": item.decision_status,
                "content_types": item.content_types,
                "recommended_content_types": analysis_run.recommended_content_types,
                "suggested_title": analysis_run.suggested_title,
                "workflow_status": item.workflow_status,
            }
        await engine.dispose()
        return result

    assert asyncio.run(run()) == {
        "decision_status": "creative_asset",
        "content_types": ["tool"],
        "recommended_content_types": ["research", "tutorial"],
        "suggested_title": "一篇值得写的文章",
        "workflow_status": "ready",
    }
