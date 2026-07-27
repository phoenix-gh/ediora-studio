"""Durable dispatch for automatic X topic-material selection."""

from __future__ import annotations

import hashlib
from collections.abc import Awaitable, Callable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from content_jobs import create_job, record_event
from job_queue import enqueue_job
from models import ContentJob, TopicSourceRule


def _idempotency_key(rule_id: int, tweet_ids: list[str]) -> str:
    joined = ",".join(sorted(set(tweet_ids)))
    digest = hashlib.sha256(joined.encode("utf-8")).hexdigest()[:20]
    return f"topic-source:{rule_id}:{digest}"


async def dispatch_topic_source_posts(
    db: AsyncSession,
    subscription_id: int,
    tweet_ids: list[str],
    *,
    enqueue: Callable[[int], Awaitable[None]] = enqueue_job,
) -> dict:
    """Create one job per enabled rule for a fresh X-post batch.

    The worker later filters by keywords and persists both accepted and rejected
    decisions.  Idempotency is based on a rule plus the exact fresh-post batch.
    """
    unique_ids = sorted(set(tweet_ids))
    if not unique_ids:
        return {"created": 0, "enqueued": 0, "errors": []}
    rules = (await db.execute(
        select(TopicSourceRule).where(
            TopicSourceRule.subscription_id == subscription_id,
            TopicSourceRule.enabled.is_(True),
        )
    )).scalars().all()
    created = 0
    enqueued = 0
    errors: list[str] = []
    for rule in rules:
        key = _idempotency_key(rule.id, unique_ids)
        existing = await db.scalar(
            select(ContentJob.id).where(ContentJob.idempotency_key == key)
        )
        if existing is not None:
            continue
        job = await create_job(
            db,
            flow="topic_source",
            title=f"{rule.directory}：X 主题素材甄选",
            input_data={"rule_id": rule.id, "tweet_ids": unique_ids},
            idempotency_key=key,
        )
        created += 1
        try:
            await enqueue(job.id)
            await record_event(db, job.id, "topic_source_queue_dispatched")
            enqueued += 1
        except Exception as exc:  # DB job remains queued for reconciliation/retry.
            errors.append(f"规则 {rule.id}: {exc}")
    return {"created": created, "enqueued": enqueued, "errors": errors}


async def reconcile_topic_source_jobs(
    *,
    enqueue: Callable[[int], Awaitable[None]] = enqueue_job,
) -> dict:
    """Requeue durable topic jobs that were committed before Redis failed."""
    from database import SessionLocal
    from models import ContentJobEvent

    enqueued = 0
    errors: list[str] = []
    async with SessionLocal() as db:
        jobs = (await db.execute(
            select(ContentJob).where(
                ContentJob.flow == "topic_source",
                ContentJob.status == "queued",
            ).order_by(ContentJob.created_at)
        )).scalars().all()
        for job in jobs:
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
    return {"enqueued": enqueued, "errors": errors}
