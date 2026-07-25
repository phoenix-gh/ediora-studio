"""Inbox and worker APIs for X realtime-response decisions."""

from __future__ import annotations

import re
import uuid
from datetime import date, datetime, time, timedelta, timezone
from typing import Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import desc, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from config import get_config
from database import get_db
from log_redaction import redact_secret_text
from models import PublishAccount, XPost, XResponseDecision, XSubscription
from x_response_links import extract_external_urls, verify_urls
from x_response_service import persist_decision


router = APIRouter(prefix="/x/responses", tags=["x-responses"])
CJK_RE = re.compile(r"[\u3400-\u9fff]")


class ClaimIn(BaseModel):
    text: str
    source_url: str = ""
    verified: bool = False


class DecisionIn(BaseModel):
    action: Literal["comment", "translate_quote", "watch", "ignore"]
    score: int = Field(ge=0, le=100)
    confidence: float = Field(ge=0, le=1)
    reason: str = Field(min_length=1, max_length=500)
    summary_cn: str = Field(min_length=1)
    comment_draft: str | None = None
    quote_draft: str | None = None
    claims: list[ClaimIn] = Field(default_factory=list)
    verification_status: Literal["verified", "not_required", "unverified"]
    verified_urls: list[dict] = Field(default_factory=list)
    model_provider: str = ""
    model_name: str = ""
    prompt_version: str = ""

    @field_validator("comment_draft", "quote_draft")
    @classmethod
    def validate_chinese_draft(cls, value: str | None):
        if value and not CJK_RE.search(value):
            raise ValueError("publishable drafts must contain Chinese")
        return value


class FeedbackIn(BaseModel):
    status: Literal["used", "ignored"]


class DigestIn(BaseModel):
    date: date


CLAIMABLE_IMMEDIATE_STATUSES = {"pending", "failed"}
CLAIMABLE_DIGEST_STATUSES = {"not_required", "failed"}


def _aware(value: datetime | None) -> datetime | None:
    if value is None or value.tzinfo is not None:
        return value
    return value.replace(tzinfo=timezone.utc)


def _eligible(post: XPost, sub: XSubscription) -> tuple[bool, str]:
    now = datetime.now(timezone.utc)
    if not sub.enabled or not sub.notify_new_posts:
        return False, "subscription_disabled"
    if sub.kind != "timeline":
        return False, "search_subscription"
    if post.is_reply:
        return False, "reply_post"
    enabled_at = _aware(sub.notify_enabled_at)
    collected_at = _aware(post.collected_at)
    if not enabled_at or not collected_at or collected_at < enabled_at:
        return False, "before_enabled"
    published_at = _aware(post.published_at)
    if not published_at or published_at < now - timedelta(hours=48):
        return False, "stale_post"
    return True, ""


async def _joined(db: AsyncSession, decision_id: int):
    return (await db.execute(
        select(XResponseDecision, XPost, XSubscription)
        .join(XPost, XPost.tweet_id == XResponseDecision.tweet_id)
        .join(XSubscription, XSubscription.id == XResponseDecision.subscription_id)
        .where(XResponseDecision.id == decision_id)
    )).first()


def _payload(decision: XResponseDecision, post: XPost, sub: XSubscription) -> dict:
    return {
        "id": decision.id,
        "tweet_id": decision.tweet_id,
        "subscription_id": decision.subscription_id,
        "source_label": sub.label,
        "username": post.username,
        "display_name": post.display_name,
        "post_content": post.content,
        "post_url": post.url,
        "published_at": post.published_at,
        "action": decision.action,
        "score": decision.score,
        "confidence": decision.confidence,
        "reason": decision.reason,
        "summary_cn": decision.summary_cn,
        "comment_draft": decision.comment_draft,
        "quote_draft": decision.quote_draft,
        "claims": decision.claims or [],
        "verification_status": decision.verification_status,
        "verified_urls": decision.verified_urls or [],
        "notification_tier": decision.notification_tier,
        "workflow_status": decision.workflow_status,
        "telegram_status": decision.telegram_status,
        "telegram_message_ids": decision.telegram_message_ids or [],
        "telegram_last_error": decision.telegram_last_error,
        "notified_at": decision.notified_at,
        "created_at": decision.created_at,
    }


def _safe_telegram_error(exc: Exception, token: str) -> str:
    safe = redact_secret_text(str(exc))
    if token:
        safe = safe.replace(token, "***")
    return safe[:500]


def _telegram_retryable(exc: Exception) -> bool:
    return bool(getattr(exc, "retryable", False)) and not (
        bool(getattr(exc, "delivery_unknown", False))
        or bool(getattr(exc, "message_ids", []) or [])
    )


def _retryability_headers(exc: Exception) -> dict[str, str]:
    return {
        "X-WMS-Retryable": "true" if _telegram_retryable(exc) else "false",
    }


async def _claim_decision(
    db: AsyncSession,
    decision_id: int,
    claimable_statuses: set[str],
) -> str | None:
    claim_token = uuid.uuid4().hex
    result = await db.execute(
        update(XResponseDecision)
        .where(XResponseDecision.id == decision_id)
        .where(XResponseDecision.telegram_status.in_(claimable_statuses))
        .values(
            telegram_status="sending",
            telegram_claim_token=claim_token,
            telegram_attempts=XResponseDecision.telegram_attempts + 1,
            telegram_last_error="",
        )
    )
    await db.commit()
    return claim_token if result.rowcount == 1 else None


async def _finish_claim_failure(
    db: AsyncSession,
    *,
    claim_token: str,
    exc: Exception,
    configured_token: str,
) -> str:
    message_ids = list(getattr(exc, "message_ids", []) or [])
    delivery_unknown = bool(getattr(exc, "delivery_unknown", False))
    status = "unknown" if delivery_unknown or message_ids else "failed"
    await db.execute(
        update(XResponseDecision)
        .where(XResponseDecision.telegram_claim_token == claim_token)
        .where(XResponseDecision.telegram_status == "sending")
        .values(
            telegram_status=status,
            telegram_message_ids=message_ids,
            telegram_last_error=_safe_telegram_error(exc, configured_token),
        )
    )
    await db.commit()
    return status


@router.get("/internal/{tweet_id}/context")
async def worker_context(tweet_id: str, db: AsyncSession = Depends(get_db)):
    post = await db.get(XPost, tweet_id)
    if post is None:
        raise HTTPException(404, "post not found")
    sub = await db.get(XSubscription, post.subscription_id)
    if sub is None:
        raise HTTPException(404, "subscription not found")
    eligible, skip_reason = _eligible(post, sub)
    cfg = await get_config()
    account = None
    account_id = cfg.get("x_response_account_id", "").strip()
    if account_id:
        account = await db.get(PublishAccount, account_id)
        if (
            account is None
            or not account.is_active
            or account.platform.strip().casefold() not in {"x", "twitter"}
        ):
            account = None
    profile = {
        "id": account.id if account else "",
        "name": account.name if account else "中文科技从业者",
        "positioning": account.positioning if account else "中文科技从业者",
        "audience": account.audience if account else "关注 AI 与软件产品的中文读者",
        "tone": account.tone if account else "准确、直接、有信息增量",
        "topic_focus": account.topic_focus if account else ["人工智能", "开发者工具", "产品动态"],
        "taboo": account.taboo if account else ["无依据推断", "空泛夸奖"],
    }
    return {
        "eligible": eligible,
        "skip_reason": skip_reason,
        "post": {
            "tweet_id": post.tweet_id, "username": post.username,
            "display_name": post.display_name, "content": post.content,
            "raw_markdown": post.raw_markdown, "url": post.url,
            "published_at": post.published_at, "views": post.views,
            "likes": post.likes, "reposts": post.reposts, "replies": post.replies,
        },
        "subscription": {"id": sub.id, "label": sub.label, "kind": sub.kind},
        "account_profile": profile,
        "external_urls": extract_external_urls(post.content, post.raw_markdown, post.url),
    }


@router.post("/internal/{tweet_id}/verify-links")
async def worker_verify_links(tweet_id: str, db: AsyncSession = Depends(get_db)):
    context = await worker_context(tweet_id, db)
    return await verify_urls(context["external_urls"])


@router.post("/internal/{tweet_id}/decision")
async def worker_persist_decision(
    tweet_id: str,
    body: DecisionIn,
    db: AsyncSession = Depends(get_db),
):
    decision = await persist_decision(
        db,
        tweet_id,
        body.model_dump(include={
            "action", "score", "confidence", "reason", "summary_cn",
            "comment_draft", "quote_draft", "claims",
        }),
        {
            "verification_status": body.verification_status,
            "verified_urls": body.verified_urls,
            "model_provider": body.model_provider,
            "model_name": body.model_name,
            "prompt_version": body.prompt_version,
        },
    )
    row = await _joined(db, decision.id)
    assert row is not None
    return _payload(*row)


@router.get("")
async def list_responses(
    action: str | None = None,
    workflow_status: str | None = None,
    notification_tier: str | None = None,
    subscription_id: int | None = None,
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
):
    query = (
        select(XResponseDecision, XPost, XSubscription)
        .join(XPost, XPost.tweet_id == XResponseDecision.tweet_id)
        .join(XSubscription, XSubscription.id == XResponseDecision.subscription_id)
    )
    if action:
        query = query.where(XResponseDecision.action == action)
    if workflow_status:
        query = query.where(XResponseDecision.workflow_status == workflow_status)
    if notification_tier:
        query = query.where(XResponseDecision.notification_tier == notification_tier)
    if subscription_id is not None:
        query = query.where(XResponseDecision.subscription_id == subscription_id)
    rows = (await db.execute(
        query.order_by(
            XResponseDecision.workflow_status != "ready",
            desc(XResponseDecision.score),
            desc(XPost.published_at),
        ).limit(max(1, min(limit, 100)))
    )).all()
    return {"items": [_payload(*row) for row in rows]}


@router.post("/digest/send")
async def send_digest(body: DigestIn, db: AsyncSession = Depends(get_db)):
    """Send one idempotent Asia/Shanghai digest for the requested calendar day."""
    shanghai = ZoneInfo("Asia/Shanghai")
    start = datetime.combine(body.date, time.min, shanghai).astimezone(timezone.utc)
    end = start + timedelta(days=1)
    rows = (await db.execute(
        select(XResponseDecision, XPost, XSubscription)
        .join(XPost, XPost.tweet_id == XResponseDecision.tweet_id)
        .join(XSubscription, XSubscription.id == XResponseDecision.subscription_id)
        .where(XResponseDecision.notification_tier == "digest")
        .where(
            XResponseDecision.telegram_status.in_(CLAIMABLE_DIGEST_STATUSES)
        )
        .where(XResponseDecision.created_at >= start)
        .where(XResponseDecision.created_at < end)
        .order_by(desc(XResponseDecision.score), desc(XPost.published_at))
    )).all()
    if not rows:
        return {"sent": 0, "message_ids": []}

    import telegram_notifier
    cfg = await get_config()
    claim_token = uuid.uuid4().hex
    candidate_ids = [row[0].id for row in rows]
    await db.execute(
        update(XResponseDecision)
        .where(XResponseDecision.id.in_(candidate_ids))
        .where(
            XResponseDecision.telegram_status.in_(CLAIMABLE_DIGEST_STATUSES)
        )
        .values(
            telegram_status="sending",
            telegram_claim_token=claim_token,
            telegram_attempts=XResponseDecision.telegram_attempts + 1,
            telegram_last_error="",
        )
    )
    await db.commit()
    db.expire_all()
    rows = (await db.execute(
        select(XResponseDecision, XPost, XSubscription)
        .join(XPost, XPost.tweet_id == XResponseDecision.tweet_id)
        .join(XSubscription, XSubscription.id == XResponseDecision.subscription_id)
        .where(XResponseDecision.telegram_claim_token == claim_token)
        .where(XResponseDecision.telegram_status == "sending")
        .order_by(desc(XResponseDecision.score), desc(XPost.published_at))
    )).all()
    if not rows:
        return {"sent": 0, "message_ids": []}

    decisions = [row[0] for row in rows]
    messages = telegram_notifier.render_digest_messages(
        rows,
        body.date.isoformat(),
        "http://localhost:3000/x-responses",
    )
    try:
        message_ids = await telegram_notifier.send_html_messages(
            cfg.get("telegram_bot_token", ""),
            cfg.get("telegram_chat_id", ""),
            messages,
        )
    except telegram_notifier.TelegramSendError as exc:
        configured_token = cfg.get("telegram_bot_token", "")
        await _finish_claim_failure(
            db,
            claim_token=claim_token,
            exc=exc,
            configured_token=configured_token,
        )
        raise HTTPException(
            503,
            _safe_telegram_error(exc, configured_token),
            headers=_retryability_headers(exc),
        ) from None

    sent_at = datetime.now(timezone.utc)
    await db.execute(
        update(XResponseDecision)
        .where(XResponseDecision.telegram_claim_token == claim_token)
        .where(XResponseDecision.telegram_status == "sending")
        .values(
            telegram_status="sent",
            telegram_message_ids=message_ids,
            telegram_last_error="",
            notified_at=sent_at,
        )
    )
    await db.commit()
    return {"sent": len(decisions), "message_ids": message_ids}


@router.get("/{decision_id}")
async def get_response(decision_id: int, db: AsyncSession = Depends(get_db)):
    row = await _joined(db, decision_id)
    if row is None:
        raise HTTPException(404, "response not found")
    return _payload(*row)


@router.post("/{decision_id}/feedback")
async def set_feedback(
    decision_id: int,
    body: FeedbackIn,
    db: AsyncSession = Depends(get_db),
):
    decision = await db.get(XResponseDecision, decision_id)
    if decision is None:
        raise HTTPException(404, "response not found")
    decision.workflow_status = body.status
    await db.commit()
    row = await _joined(db, decision_id)
    assert row is not None
    return _payload(*row)


@router.post("/{decision_id}/convert-to-topic")
async def convert_to_topic(decision_id: int, db: AsyncSession = Depends(get_db)):
    decision = await db.get(XResponseDecision, decision_id)
    if decision is None:
        raise HTTPException(404, "response not found")
    decision.workflow_status = "converted"
    await db.commit()
    row = await _joined(db, decision_id)
    assert row is not None
    return _payload(*row)


@router.post("/{decision_id}/notify")
async def notify_response(decision_id: int, db: AsyncSession = Depends(get_db)):
    row = await _joined(db, decision_id)
    if row is None:
        raise HTTPException(404, "response not found")
    decision, post, sub = row
    if decision.telegram_status == "sent":
        return _payload(decision, post, sub)
    if decision.telegram_status in {"sending", "unknown"}:
        return _payload(decision, post, sub)
    if decision.notification_tier != "immediate":
        return _payload(decision, post, sub)

    import telegram_notifier
    cfg = await get_config()
    claim_token = await _claim_decision(
        db,
        decision.id,
        CLAIMABLE_IMMEDIATE_STATUSES,
    )
    if claim_token is None:
        db.expire_all()
        current = await _joined(db, decision_id)
        assert current is not None
        return _payload(*current)
    await db.refresh(decision)
    messages = telegram_notifier.render_immediate_messages(
        decision, post, sub,
        f"http://localhost:3000/x-responses?decision={decision.id}",
    )
    try:
        message_ids = await telegram_notifier.send_html_messages(
            cfg.get("telegram_bot_token", ""),
            cfg.get("telegram_chat_id", ""),
            messages,
        )
    except telegram_notifier.TelegramSendError as exc:
        configured_token = cfg.get("telegram_bot_token", "")
        await _finish_claim_failure(
            db,
            claim_token=claim_token,
            exc=exc,
            configured_token=configured_token,
        )
        raise HTTPException(
            503,
            _safe_telegram_error(exc, configured_token),
            headers=_retryability_headers(exc),
        ) from None
    await db.execute(
        update(XResponseDecision)
        .where(XResponseDecision.telegram_claim_token == claim_token)
        .where(XResponseDecision.telegram_status == "sending")
        .values(
            telegram_status="sent",
            telegram_message_ids=message_ids,
            telegram_last_error="",
            notified_at=datetime.now(timezone.utc),
        )
    )
    await db.commit()
    db.expire_all()
    completed = await _joined(db, decision_id)
    assert completed is not None
    return _payload(*completed)
