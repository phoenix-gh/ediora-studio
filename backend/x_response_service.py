"""Domain policy and persistence for X realtime-response decisions."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from content_jobs import create_job
from models import (
    ContentJob, ContentJobEvent, XPost, XResponseDecision, XSubscription,
)


IMMEDIATE_SCORE = 75
DIGEST_SCORE = 50
MIN_IMMEDIATE_CONFIDENCE = 0.70
POLICY_VERSION = "x-response-v1"
VALID_ACTIONS = {"comment", "translate_quote", "watch", "ignore"}
VALID_VERIFICATION = {"verified", "not_required", "unverified"}


def _aware(value: datetime | None) -> datetime | None:
    if value is None or value.tzinfo is not None:
        return value
    return value.replace(tzinfo=timezone.utc)


def _post_is_eligible(
    post: XPost,
    subscription: XSubscription,
    *,
    now: datetime | None = None,
) -> bool:
    current = now or datetime.now(timezone.utc)
    if (
        subscription.kind != "timeline"
        or not subscription.enabled
        or not subscription.notify_new_posts
        or post.is_reply
    ):
        return False
    enabled_at = _aware(subscription.notify_enabled_at)
    collected_at = _aware(post.collected_at)
    published_at = _aware(post.published_at)
    return bool(
        enabled_at
        and collected_at
        and collected_at >= enabled_at
        and published_at
        and published_at >= current - timedelta(hours=48)
    )


async def ensure_response_job(
    db: AsyncSession,
    tweet_id: str,
) -> tuple[ContentJob, bool]:
    """Return the one durable response job for a tweet, creating it if absent."""
    key = f"x-response:{tweet_id}"
    existing = (await db.execute(
        select(ContentJob).where(ContentJob.idempotency_key == key)
    )).scalar_one_or_none()
    if existing is not None:
        return existing, False

    post = await db.get(XPost, tweet_id)
    if post is None:
        raise KeyError(f"X post {tweet_id} not found")
    job = await create_job(
        db,
        flow="x_response",
        title=f"即时响应 @{post.username}",
        input_data={"tweet_id": tweet_id},
        idempotency_key=key,
    )
    return job, True


async def _queue_was_dispatched(db: AsyncSession, job_id: int) -> bool:
    return (await db.execute(
        select(ContentJobEvent.id)
        .where(ContentJobEvent.job_id == job_id)
        .where(ContentJobEvent.kind == "queue_dispatched")
        .limit(1)
    )).scalar_one_or_none() is not None


async def _record_queue_dispatch(db: AsyncSession, job_id: int) -> None:
    db.add(ContentJobEvent(job_id=job_id, kind="queue_dispatched"))
    await db.commit()


async def enqueue_content_job_once(
    db: AsyncSession,
    job: ContentJob,
    *,
    enqueue: Callable[[int], Awaitable[None]] | None = None,
) -> bool:
    """Enqueue a queued job once, with an auditable repair marker."""
    if job.status != "queued" or await _queue_was_dispatched(db, job.id):
        return False
    if enqueue is None:
        from job_queue import enqueue_job
        enqueue = enqueue_job
    await enqueue(job.id)
    await _record_queue_dispatch(db, job.id)
    return True


async def dispatch_response_posts(
    db: AsyncSession,
    subscription: XSubscription,
    tweet_ids: list[str],
    *,
    enqueue: Callable[[int], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """Create and enqueue jobs only for newly collected, eligible original posts."""
    result: dict[str, Any] = {"created": 0, "enqueued": 0, "errors": []}
    if (
        not tweet_ids
        or subscription.kind != "timeline"
        or not subscription.enabled
        or not subscription.notify_new_posts
    ):
        return result
    if enqueue is None:
        from job_queue import enqueue_job
        enqueue = enqueue_job

    posts = (await db.execute(
        select(XPost).where(XPost.tweet_id.in_(tweet_ids))
    )).scalars().all()
    for post in posts:
        if not _post_is_eligible(post, subscription):
            continue
        job, created = await ensure_response_job(db, post.tweet_id)
        if not created:
            continue
        result["created"] += 1
        try:
            if await enqueue_content_job_once(db, job, enqueue=enqueue):
                result["enqueued"] += 1
        except Exception as exc:
            result["errors"].append(f"{post.tweet_id}: {exc}")
    return result


async def reconcile_response_jobs(
    *,
    enqueue: Callable[[int], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """Repair posts that were committed but never received a durable job."""
    from database import SessionLocal

    result: dict[str, Any] = {"created": 0, "enqueued": 0, "errors": []}
    if enqueue is None:
        from job_queue import enqueue_job
        enqueue = enqueue_job
    cutoff = datetime.now(timezone.utc) - timedelta(hours=48)

    async with SessionLocal() as db:
        rows = (await db.execute(
            select(XPost, XSubscription)
            .join(XSubscription, XSubscription.id == XPost.subscription_id)
            .where(XSubscription.kind == "timeline")
            .where(XSubscription.enabled.is_(True))
            .where(XSubscription.notify_new_posts.is_(True))
            .where(XPost.is_reply.is_(False))
            .where(XPost.published_at >= cutoff)
            .order_by(XPost.collected_at)
        )).all()
        for post, subscription in rows:
            if not _post_is_eligible(post, subscription):
                continue
            decision = (await db.execute(
                select(XResponseDecision.id).where(
                    XResponseDecision.tweet_id == post.tweet_id
                )
            )).scalar_one_or_none()
            if decision is not None:
                continue
            job, created = await ensure_response_job(db, post.tweet_id)
            if created:
                result["created"] += 1
            try:
                if await enqueue_content_job_once(db, job, enqueue=enqueue):
                    result["enqueued"] += 1
            except Exception as exc:
                result["errors"].append(f"{post.tweet_id}: {exc}")

        digest_jobs = (await db.execute(
            select(ContentJob)
            .where(ContentJob.flow == "x_response_digest")
            .where(ContentJob.status == "queued")
            .order_by(ContentJob.created_at)
        )).scalars().all()
        for job in digest_jobs:
            try:
                if await enqueue_content_job_once(db, job, enqueue=enqueue):
                    result["enqueued"] += 1
            except Exception as exc:
                result["errors"].append(f"digest:{job.id}: {exc}")
    return result


async def create_response_digest_job(
    date_key: str,
    *,
    db: AsyncSession | None = None,
) -> tuple[ContentJob, bool]:
    """Create the one Asia/Shanghai digest job for a calendar date."""
    from database import SessionLocal

    async def ensure(session: AsyncSession) -> tuple[ContentJob, bool]:
        key = f"x-response-digest:{date_key}"
        existing = (await session.execute(
            select(ContentJob).where(ContentJob.idempotency_key == key)
        )).scalar_one_or_none()
        if existing is not None:
            return existing, False
        job = await create_job(
            session,
            flow="x_response_digest",
            title=f"X 即时响应摘要 {date_key}",
            input_data={"date": date_key},
            idempotency_key=key,
        )
        return job, True

    if db is not None:
        return await ensure(db)
    async with SessionLocal() as session:
        return await ensure(session)


def notification_tier(score: int, confidence: float, verification_status: str) -> str:
    if (
        score >= IMMEDIATE_SCORE
        and confidence >= MIN_IMMEDIATE_CONFIDENCE
        and verification_status != "unverified"
    ):
        return "immediate"
    if score >= DIGEST_SCORE:
        return "digest"
    return "silent"


def normalize_decision(raw: dict[str, Any], verification_status: str) -> dict[str, Any]:
    if verification_status not in VALID_VERIFICATION:
        raise ValueError(f"invalid verification_status: {verification_status}")
    action = str(raw.get("action") or "").strip()
    if action not in VALID_ACTIONS:
        raise ValueError(f"invalid action: {action}")

    score = max(0, min(100, int(raw.get("score", 0))))
    confidence = max(0.0, min(1.0, float(raw.get("confidence", 0.0))))
    comment_draft = (str(raw.get("comment_draft")).strip()
                     if raw.get("comment_draft") else None)
    quote_draft = (str(raw.get("quote_draft")).strip()
                   if raw.get("quote_draft") else None)

    if verification_status == "unverified" and action in {"comment", "translate_quote"}:
        action = "watch"
    if action in {"watch", "ignore"}:
        comment_draft = None
        quote_draft = None
    elif action == "comment":
        if not comment_draft:
            raise ValueError("comment action requires comment_draft")
        quote_draft = None
    elif action == "translate_quote":
        if not quote_draft:
            raise ValueError("translate_quote action requires quote_draft")
        comment_draft = None

    return {
        "action": action,
        "score": score,
        "confidence": confidence,
        "reason": str(raw.get("reason") or "").strip(),
        "summary_cn": str(raw.get("summary_cn") or "").strip(),
        "comment_draft": comment_draft,
        "quote_draft": quote_draft,
        "claims": list(raw.get("claims") or []),
        "notification_tier": notification_tier(score, confidence, verification_status),
    }


async def persist_decision(
    db: AsyncSession,
    tweet_id: str,
    raw: dict[str, Any],
    metadata: dict[str, Any],
) -> XResponseDecision:
    existing = (await db.execute(
        select(XResponseDecision).where(XResponseDecision.tweet_id == tweet_id)
    )).scalar_one_or_none()
    if existing is not None:
        return existing

    post = await db.get(XPost, tweet_id)
    if post is None:
        raise KeyError(f"X post {tweet_id} not found")
    verification_status = str(metadata.get("verification_status") or "not_required")
    normalized = normalize_decision(raw, verification_status)
    tier = normalized["notification_tier"]
    decision = XResponseDecision(
        tweet_id=tweet_id,
        subscription_id=post.subscription_id,
        action=normalized["action"],
        score=normalized["score"],
        confidence=normalized["confidence"],
        reason=normalized["reason"],
        summary_cn=normalized["summary_cn"],
        comment_draft=normalized["comment_draft"],
        quote_draft=normalized["quote_draft"],
        claims=normalized["claims"],
        verification_status=verification_status,
        verified_urls=list(metadata.get("verified_urls") or []),
        notification_tier=tier,
        model_provider=str(metadata.get("model_provider") or ""),
        model_name=str(metadata.get("model_name") or ""),
        prompt_version=str(metadata.get("prompt_version") or ""),
        decision_policy_version=POLICY_VERSION,
        telegram_status="pending" if tier == "immediate" else "not_required",
    )
    db.add(decision)
    await db.commit()
    await db.refresh(decision)
    return decision
