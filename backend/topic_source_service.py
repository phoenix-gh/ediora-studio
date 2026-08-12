"""Durable dispatch for automatic X topic-material selection."""

from __future__ import annotations

import hashlib
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta, timezone

from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from content_jobs import (
    add_locked_job_event,
    create_job,
    lock_content_job_row,
    record_event,
)
from job_queue import enqueue_job
from models import (
    AssetIngestionDecision,
    ContentJob,
    CreativeAssetDirectory,
    XPost,
    XSubscriptionIngestionDirectory,
)


class TopicSourceConfigurationError(ValueError):
    """The subscription has no usable AI material-ingestion directory."""


def _idempotency_key(subscription_id: int, tweet_ids: list[str]) -> str:
    joined = ",".join(sorted(set(tweet_ids)))
    digest = hashlib.sha256(joined.encode("utf-8")).hexdigest()[:20]
    return f"topic-source:{subscription_id}:{digest}"


def _positive_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def is_valid_topic_source_payload(input_data: object) -> bool:
    """Accept only the current merged payload or the supported legacy shape."""
    if not isinstance(input_data, dict):
        return False
    directory_ids = input_data.get("directory_ids")
    if (
        _positive_int(input_data.get("subscription_id"))
        and isinstance(directory_ids, list)
        and bool(directory_ids)
        and all(_positive_int(directory_id) for directory_id in directory_ids)
    ):
        return True
    return _positive_int(input_data.get("rule_id"))


async def dispatch_topic_source_posts(
    db: AsyncSession,
    subscription_id: int,
    tweet_ids: list[str],
    *,
    enqueue: Callable[[int], Awaitable[None]] = enqueue_job,
) -> dict:
    """Create one merged AI classification and prompt-extraction job for fresh X posts."""
    unique_ids = sorted(set(tweet_ids))
    if not unique_ids:
        return {"created": 0, "enqueued": 0, "errors": []}
    directories = (await db.execute(
        select(CreativeAssetDirectory)
        .join(
            XSubscriptionIngestionDirectory,
            XSubscriptionIngestionDirectory.directory_id == CreativeAssetDirectory.id,
        )
        .where(
            XSubscriptionIngestionDirectory.subscription_id == subscription_id,
            CreativeAssetDirectory.asset_type.in_(("article", "prompt")),
            CreativeAssetDirectory.ai_ingestion_enabled.is_(True),
        )
        .order_by(CreativeAssetDirectory.id)
    )).scalars().all()
    if not directories:
        return {"created": 0, "enqueued": 0, "errors": []}
    created = 0
    enqueued = 0
    errors: list[str] = []
    key = _idempotency_key(subscription_id, unique_ids)
    existing = await db.scalar(
        select(ContentJob.id).where(ContentJob.idempotency_key == key)
    )
    if existing is not None:
        return {"created": 0, "enqueued": 0, "errors": []}
    job = await create_job(
        db,
        flow="topic_source",
        title="X：AI 素材归类与提示词提取",
        input_data={
            "subscription_id": subscription_id,
            "directory_ids": [directory.id for directory in directories],
            "tweet_ids": unique_ids,
        },
        idempotency_key=key,
    )
    created += 1
    try:
        await enqueue(job.id)
        await record_event(db, job.id, "topic_source_queue_dispatched")
        enqueued += 1
    except Exception as exc:  # DB job remains queued for reconciliation/retry.
        errors.append(f"订阅 {subscription_id}: {exc}")
    return {"created": created, "enqueued": enqueued, "errors": errors}


async def dispatch_topic_source_backfill(
    db: AsyncSession,
    subscription_id: int,
    days: int,
    *,
    enqueue: Callable[[int], Awaitable[None]] = enqueue_job,
) -> dict:
    """Dispatch locally stored, undecided X posts from a recent time window."""
    directories = (await db.execute(
        select(CreativeAssetDirectory)
        .join(
            XSubscriptionIngestionDirectory,
            XSubscriptionIngestionDirectory.directory_id == CreativeAssetDirectory.id,
        )
        .where(
            XSubscriptionIngestionDirectory.subscription_id == subscription_id,
            CreativeAssetDirectory.asset_type.in_(("article", "prompt")),
            CreativeAssetDirectory.ai_ingestion_enabled.is_(True),
        )
    )).scalars().all()
    if not any((directory.ai_ingestion_prompt or "").strip() for directory in directories):
        raise TopicSourceConfigurationError(
            "X 订阅未配置有效的 AI 素材入库目录"
        )

    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    window = (
        XPost.subscription_id == subscription_id,
        XPost.published_at >= cutoff,
    )
    total_count = int((await db.scalar(
        select(func.count(XPost.tweet_id)).where(*window)
    )) or 0)
    pending_ids = list((await db.execute(
        select(XPost.tweet_id)
        .where(
            *window,
            ~select(AssetIngestionDecision.id)
            .where(
                AssetIngestionDecision.subscription_id == subscription_id,
                AssetIngestionDecision.tweet_id == XPost.tweet_id,
            )
            .exists(),
        )
        .order_by(desc(XPost.published_at), desc(XPost.tweet_id))
    )).scalars().all())
    result = {
        "candidate_count": len(pending_ids),
        "skipped_count": max(0, total_count - len(pending_ids)),
        "created": 0,
        "enqueued": 0,
        "errors": [],
    }
    for start in range(0, len(pending_ids), 50):
        dispatched = await dispatch_topic_source_posts(
            db,
            subscription_id,
            pending_ids[start:start + 50],
            enqueue=enqueue,
        )
        result["created"] += dispatched["created"]
        result["enqueued"] += dispatched["enqueued"]
        result["errors"].extend(dispatched["errors"])
    return result


async def reconcile_topic_source_jobs(
    *,
    enqueue: Callable[[int], Awaitable[None]] = enqueue_job,
) -> dict:
    """Requeue durable topic jobs that were committed before Redis failed."""
    from database import SessionLocal
    from models import ContentJobEvent

    enqueued = 0
    cancelled = 0
    errors: list[str] = []
    async with SessionLocal() as db:
        jobs = (await db.execute(
            select(ContentJob).where(
                ContentJob.flow == "topic_source",
                ContentJob.status == "queued",
            ).order_by(ContentJob.created_at)
        )).scalars().all()
        for job in jobs:
            if not is_valid_topic_source_payload(job.input_data):
                locked_job = await lock_content_job_row(db, job.id)
                if locked_job is None or locked_job.status != "queued":
                    continue
                locked_job.status = "cancelled"
                locked_job.completed_at = datetime.now(timezone.utc)
                await add_locked_job_event(
                    db,
                    locked_job.id,
                    "job_reconciled",
                    payload={"action": "invalid_topic_source_payload_cancelled"},
                )
                await db.commit()
                cancelled += 1
                continue
            dispatched = await db.scalar(
                select(ContentJobEvent.id).where(
                    ContentJobEvent.job_id == job.id,
                    ContentJobEvent.kind == "topic_source_queue_dispatched",
                )
            )
            if dispatched is not None:
                continue
            try:
                await enqueue(job.id)
                await record_event(db, job.id, "topic_source_queue_dispatched")
                enqueued += 1
            except Exception as exc:
                errors.append(f"任务 {job.id}: {exc}")
    return {"enqueued": enqueued, "cancelled": cancelled, "errors": errors}
