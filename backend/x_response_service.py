"""Domain policy and persistence for X realtime-response decisions."""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models import XPost, XResponseDecision


IMMEDIATE_SCORE = 75
DIGEST_SCORE = 50
MIN_IMMEDIATE_CONFIDENCE = 0.70
POLICY_VERSION = "x-response-v1"
VALID_ACTIONS = {"comment", "translate_quote", "watch", "ignore"}
VALID_VERIFICATION = {"verified", "not_required", "unverified"}


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
