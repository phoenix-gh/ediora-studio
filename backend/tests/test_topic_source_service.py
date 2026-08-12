"""Automatic X-to-topic-material dispatch must be durable and idempotent."""

import asyncio
import sys
from datetime import datetime, timedelta, timezone

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
                CreativeAssetDirectory(
                    name="图片提示词",
                    asset_type="prompt",
                    ai_ingestion_enabled=True,
                    ai_ingestion_prompt="只接受可复用的图片提示词",
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
                XSubscriptionIngestionDirectory(
                    subscription_id=subscription.id,
                    directory_id=directories[2].id,
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
            "directory_ids": [1, 2, 3],
            "tweet_ids": ["tweet-1", "tweet-2"],
        },
    ]
    assert enqueued == [job.id for job in jobs]


def test_backfill_dispatches_only_undecided_posts_inside_window(service_env):
    from database import SessionLocal
    from models import (
        AssetIngestionDecision,
        ContentJob,
        CreativeAssetDirectory,
        XPost,
        XSubscription,
        XSubscriptionIngestionDirectory,
    )
    from topic_source_service import dispatch_topic_source_backfill

    enqueued: list[int] = []

    async def enqueue(job_id: int):
        enqueued.append(job_id)

    async def run():
        async with SessionLocal() as db:
            now = datetime.now(timezone.utc)
            subscription = XSubscription(
                url="https://x.com/backfill-window",
                label="Backfill window",
            )
            directory = CreativeAssetDirectory(
                name="回填文章",
                asset_type="article",
                ai_ingestion_enabled=True,
                ai_ingestion_prompt="只接受可复用的文章素材",
            )
            db.add_all([subscription, directory])
            await db.flush()
            db.add(XSubscriptionIngestionDirectory(
                subscription_id=subscription.id,
                directory_id=directory.id,
            ))
            db.add_all([
                XPost(
                    tweet_id="decided-accepted",
                    subscription_id=subscription.id,
                    username="author",
                    content="已处理的文章",
                    url="https://x.com/author/status/1",
                    published_at=now - timedelta(days=2),
                ),
                XPost(
                    tweet_id="decided-rejected",
                    subscription_id=subscription.id,
                    username="author",
                    content="已判断不入库的文章",
                    url="https://x.com/author/status/2",
                    published_at=now - timedelta(days=3),
                ),
                XPost(
                    tweet_id="pending-new",
                    subscription_id=subscription.id,
                    username="author",
                    content="等待处理的新文章",
                    url="https://x.com/author/status/3",
                    published_at=now - timedelta(days=1),
                ),
                XPost(
                    tweet_id="pending-old",
                    subscription_id=subscription.id,
                    username="author",
                    content="等待处理的旧文章",
                    url="https://x.com/author/status/4",
                    published_at=now - timedelta(days=8),
                ),
                XPost(
                    tweet_id="pending-second",
                    subscription_id=subscription.id,
                    username="author",
                    content="等待处理的第二篇文章",
                    url="https://x.com/author/status/5",
                    published_at=now - timedelta(days=4),
                ),
            ])
            await db.flush()
            db.add_all([
                AssetIngestionDecision(
                    subscription_id=subscription.id,
                    tweet_id="decided-accepted",
                    directory_id=directory.id,
                ),
                AssetIngestionDecision(
                    subscription_id=subscription.id,
                    tweet_id="decided-rejected",
                    directory_id=None,
                ),
            ])
            await db.commit()

            first = await dispatch_topic_source_backfill(
                db, subscription.id, 7, enqueue=enqueue,
            )
            jobs_after_first = (await db.execute(
                select(ContentJob).order_by(ContentJob.id)
            )).scalars().all()

            db.add_all([
                AssetIngestionDecision(
                    subscription_id=subscription.id,
                    tweet_id="pending-new",
                    directory_id=directory.id,
                ),
                AssetIngestionDecision(
                    subscription_id=subscription.id,
                    tweet_id="pending-second",
                    directory_id=None,
                ),
            ])
            await db.commit()
            repeated = await dispatch_topic_source_backfill(
                db, subscription.id, 7, enqueue=enqueue,
            )
            jobs_after_repeat = (await db.execute(
                select(ContentJob).order_by(ContentJob.id)
            )).scalars().all()
            return first, repeated, jobs_after_first, jobs_after_repeat

    first, repeated, jobs_after_first, jobs_after_repeat = asyncio.run(run())

    assert first == {
        "candidate_count": 2,
        "skipped_count": 2,
        "created": 1,
        "enqueued": 1,
        "errors": [],
    }
    assert repeated == {
        "candidate_count": 0,
        "skipped_count": 4,
        "created": 0,
        "enqueued": 0,
        "errors": [],
    }
    assert len(jobs_after_first) == len(jobs_after_repeat) == 1
    assert jobs_after_first[0].input_data["tweet_ids"] == [
        "pending-new",
        "pending-second",
    ]


def test_backfill_splits_pending_posts_into_fifty_item_jobs(service_env):
    from database import SessionLocal
    from models import (
        ContentJob,
        CreativeAssetDirectory,
        XPost,
        XSubscription,
        XSubscriptionIngestionDirectory,
    )
    from topic_source_service import dispatch_topic_source_backfill

    enqueued: list[int] = []

    async def enqueue(job_id: int):
        enqueued.append(job_id)

    async def run():
        async with SessionLocal() as db:
            now = datetime.now(timezone.utc)
            subscription = XSubscription(
                url="https://x.com/backfill-batches",
                label="Backfill batches",
            )
            directory = CreativeAssetDirectory(
                name="批量回填",
                asset_type="article",
                ai_ingestion_enabled=True,
                ai_ingestion_prompt="只接受相关内容",
            )
            db.add_all([subscription, directory])
            await db.flush()
            db.add(XSubscriptionIngestionDirectory(
                subscription_id=subscription.id,
                directory_id=directory.id,
            ))
            db.add_all([
                XPost(
                    tweet_id=f"batch-{index:03d}",
                    subscription_id=subscription.id,
                    username="author",
                    content=f"批量帖子 {index}",
                    url=f"https://x.com/author/status/{index}",
                    published_at=now - timedelta(minutes=index),
                )
                for index in range(51)
            ])
            await db.commit()

            result = await dispatch_topic_source_backfill(
                db, subscription.id, 7, enqueue=enqueue,
            )
            jobs = (await db.execute(
                select(ContentJob).order_by(ContentJob.id)
            )).scalars().all()
            return result, jobs

    result, jobs = asyncio.run(run())

    assert result == {
        "candidate_count": 51,
        "skipped_count": 0,
        "created": 2,
        "enqueued": 2,
        "errors": [],
    }
    assert len(jobs) == 2
    assert sorted(
        len(job.input_data["tweet_ids"]) for job in jobs
    ) == [1, 50]
    assert len(enqueued) == 2


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
    assert first == {"enqueued": 1, "cancelled": 0, "errors": []}
    assert second == {"enqueued": 0, "cancelled": 0, "errors": []}
    assert enqueued == [job_id]


def test_reconciliation_cancels_invalid_topic_job_even_after_dispatch_event(service_env):
    from content_jobs import create_job
    from database import SessionLocal
    from models import ContentJobEvent
    from topic_source_service import reconcile_topic_source_jobs

    enqueued: list[int] = []

    async def enqueue(job_id: int):
        enqueued.append(job_id)

    async def run():
        async with SessionLocal() as db:
            job = await create_job(
                db,
                flow="topic_source",
                title="旧主题素材甄选任务",
                input_data={"tweet_ids": ["legacy-post"]},
                idempotency_key="topic-source:legacy:invalid",
            )
            db.add(ContentJobEvent(
                job_id=job.id,
                kind="topic_source_queue_dispatched",
            ))
            await db.commit()
            job_id = job.id

        first = await reconcile_topic_source_jobs(enqueue=enqueue)
        second = await reconcile_topic_source_jobs(enqueue=enqueue)
        async with SessionLocal() as db:
            saved = await db.get(type(job), job_id)
            events = (await db.execute(
                select(ContentJobEvent)
                .where(ContentJobEvent.job_id == job_id)
                .order_by(ContentJobEvent.id)
            )).scalars().all()
        return job_id, first, second, saved, events

    job_id, first, second, saved, events = asyncio.run(run())
    assert first == {"enqueued": 0, "cancelled": 1, "errors": []}
    assert second == {"enqueued": 0, "cancelled": 0, "errors": []}
    assert enqueued == []
    assert saved.id == job_id
    assert saved.status == "cancelled"
    assert events[-1].kind == "job_reconciled"
    assert events[-1].payload == {
        "action": "invalid_topic_source_payload_cancelled",
    }
