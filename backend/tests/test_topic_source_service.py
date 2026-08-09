"""Automatic X-to-topic-material dispatch must be durable and idempotent."""

import asyncio
import sys
from datetime import datetime, timezone

import pytest
from sqlalchemy import select


@pytest.fixture
def service_env(monkeypatch, postgres_env):
    for name in list(sys.modules):
        if name.startswith(("database", "models", "topic_source_service", "content_jobs")):
            sys.modules.pop(name, None)

    from database import Base, engine
    import models  # noqa: F401

    async def create_schema():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.run(create_schema())


def test_new_x_posts_dispatch_one_merged_topic_job_per_subscription(service_env):
    from database import SessionLocal
    from models import (
        ContentJob,
        CreativeAssetDirectory,
        XSubscription,
        XSubscriptionIngestionDirectory,
    )
    from topic_source_service import dispatch_topic_source_posts

    enqueued: list[int] = []

    async def enqueue(job_id: int):
        enqueued.append(job_id)

    async def run():
        async with SessionLocal() as db:
            subscription = XSubscription(url="https://x.com/example", label="Example")
            db.add(subscription)
            await db.flush()
            directories = [
                CreativeAssetDirectory(
                    name="副业搞钱",
                    asset_type="article",
                    ai_ingestion_enabled=True,
                    ai_ingestion_prompt="副业实操",
                ),
                CreativeAssetDirectory(
                    name="AI",
                    asset_type="article",
                    ai_ingestion_enabled=True,
                    ai_ingestion_prompt="AI 工具",
                ),
            ]
            db.add_all(directories)
            await db.flush()
            db.add_all([
                XSubscriptionIngestionDirectory(
                    subscription_id=subscription.id,
                    directory_id=directories[0].id,
                ),
                XSubscriptionIngestionDirectory(
                    subscription_id=subscription.id,
                    directory_id=directories[1].id,
                ),
            ])
            await db.commit()

            first = await dispatch_topic_source_posts(db, subscription.id, ["tweet-2", "tweet-1"], enqueue=enqueue)
            repeated = await dispatch_topic_source_posts(db, subscription.id, ["tweet-1", "tweet-2"], enqueue=enqueue)
            jobs = (await db.execute(select(ContentJob).order_by(ContentJob.id))).scalars().all()
            return first, repeated, jobs

    first, repeated, jobs = asyncio.run(run())

    assert first == {"created": 1, "enqueued": 1, "errors": []}
    assert repeated == {"created": 0, "enqueued": 0, "errors": []}
    assert [job.input_data for job in jobs] == [
        {
            "subscription_id": 1,
            "directory_ids": [1, 2],
            "tweet_ids": ["tweet-1", "tweet-2"],
        },
    ]
    assert enqueued == [job.id for job in jobs]


def test_reconciliation_reenqueues_topic_job_once_after_queue_failure(service_env):
    from content_jobs import create_job
    from database import SessionLocal
    from topic_source_service import reconcile_topic_source_jobs

    enqueued: list[int] = []

    async def enqueue(job_id: int):
        enqueued.append(job_id)

    async def run():
        async with SessionLocal() as db:
            job = await create_job(
                db,
                flow="topic_source",
                title="副业搞钱：X 主题素材甄选",
                input_data={"rule_id": 1, "tweet_ids": ["retry-1"]},
                idempotency_key="topic-source:1:retry",
            )
            first = await reconcile_topic_source_jobs(enqueue=enqueue)
            second = await reconcile_topic_source_jobs(enqueue=enqueue)
            return job.id, first, second

    job_id, first, second = asyncio.run(run())
    assert first == {"enqueued": 1, "errors": []}
    assert second == {"enqueued": 0, "errors": []}
    assert enqueued == [job_id]
