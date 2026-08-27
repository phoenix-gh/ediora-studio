"""Global, time-bounded topic novelty checks for Agent-created drafts."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import json
from typing import Awaitable, Callable, Literal, Sequence

from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from models import AgentTopicClaim
from text_dedupe import PreparedText, similarity


NoveltyDecisionName = Literal[
    "novel", "duplicate", "new_development", "uncertain"
]
SuggestedAction = Literal["continue", "change_topic", "ask_user"]
NoveltyJudge = Callable[
    ["NoveltyCandidate", list[dict]], Awaitable[dict]
]


@dataclass(frozen=True)
class AgentIdentity:
    mode: Literal["chat", "scheduled"]
    session_id: int | None = None
    daily_creation_run_id: int | None = None


@dataclass(frozen=True)
class NoveltyCandidate:
    topic: str
    core_claim: str
    key_facts: Sequence[str] = ()
    event_time: datetime | None = None
    source_item_ids: Sequence[int] = ()


@dataclass(frozen=True)
class NoveltyDecision:
    decision: NoveltyDecisionName
    conflicts: tuple[dict, ...]
    reason: str
    novelty_basis: str
    suggested_action: SuggestedAction


def _bounded_text(value: object, *, name: str, limit: int) -> str:
    normalized = " ".join(str(value or "").split())
    if not normalized:
        raise ValueError(f"{name} is required")
    if len(normalized) > limit:
        raise ValueError(f"{name} must contain at most {limit} characters")
    return normalized


def normalize_candidate(candidate: NoveltyCandidate) -> NoveltyCandidate:
    facts: list[str] = []
    for value in candidate.key_facts:
        normalized = _bounded_text(value, name="key_facts item", limit=500)
        if normalized not in facts:
            facts.append(normalized)
    if len(facts) > 20:
        raise ValueError("key_facts must contain at most 20 items")

    source_ids: list[int] = []
    for value in candidate.source_item_ids:
        parsed = int(value)
        if parsed <= 0:
            raise ValueError("source_item_ids must contain positive integers")
        if parsed not in source_ids:
            source_ids.append(parsed)
    if len(source_ids) > 100:
        raise ValueError("source_item_ids must contain at most 100 items")

    return NoveltyCandidate(
        topic=_bounded_text(candidate.topic, name="topic", limit=1_000),
        core_claim=_bounded_text(
            candidate.core_claim, name="core_claim", limit=1_000
        ),
        key_facts=tuple(facts),
        event_time=candidate.event_time,
        source_item_ids=tuple(source_ids),
    )


def _bounded_days(window_days: int) -> int:
    parsed = int(window_days)
    if parsed < 1 or parsed > 90:
        raise ValueError("window_days must be between 1 and 90")
    return parsed


def _iso(value: datetime | None) -> str:
    if value is None:
        return ""
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


def _claim_evidence(claim: AgentTopicClaim, score: float) -> dict:
    return {
        "id": claim.id,
        "draft_id": claim.draft_id,
        "topic": claim.topic,
        "core_claim": claim.core_claim,
        "key_facts": claim.key_facts or [],
        "event_time": _iso(claim.event_time),
        "claimed_at": _iso(claim.claimed_at),
        "similarity": round(score, 4),
    }


def _uncertain(conflicts: list[dict]) -> NoveltyDecision:
    return NoveltyDecision(
        decision="uncertain",
        conflicts=tuple(conflicts),
        reason="Unable to determine topic novelty reliably",
        novelty_basis="",
        suggested_action="ask_user",
    )


def _normalize_verdict(value: object, conflicts: list[dict]) -> NoveltyDecision:
    if not isinstance(value, dict):
        raise ValueError("novelty verdict must be an object")
    allowed_keys = {
        "decision", "reason", "novelty_basis", "suggested_action"
    }
    if not set(value).issubset(allowed_keys):
        raise ValueError("novelty verdict contains unknown fields")
    decision = value.get("decision")
    if decision not in {"novel", "duplicate", "new_development", "uncertain"}:
        raise ValueError("novelty verdict decision is invalid")
    reason = _bounded_text(value.get("reason"), name="reason", limit=2_000)
    novelty_basis = " ".join(str(value.get("novelty_basis") or "").split())
    if len(novelty_basis) > 2_000:
        raise ValueError("novelty_basis must contain at most 2000 characters")
    if decision == "new_development" and not novelty_basis:
        raise ValueError("novelty_basis is required for new_development")
    expected_actions: dict[str, SuggestedAction] = {
        "novel": "continue",
        "duplicate": "change_topic",
        "new_development": "continue",
        "uncertain": "ask_user",
    }
    action = value.get("suggested_action")
    if action != expected_actions[decision]:
        raise ValueError("novelty verdict suggested_action is invalid")
    return NoveltyDecision(
        decision=decision,
        conflicts=tuple(conflicts),
        reason=reason,
        novelty_basis=novelty_basis,
        suggested_action=action,
    )


async def check_content_novelty(
    session: AsyncSession,
    *,
    candidate: NoveltyCandidate,
    window_days: int,
    judge: NoveltyJudge,
    now: datetime | None = None,
) -> NoveltyDecision:
    normalized = normalize_candidate(candidate)
    days = _bounded_days(window_days)
    reference = now or datetime.now(timezone.utc)
    if reference.tzinfo is None:
        reference = reference.replace(tzinfo=timezone.utc)
    since = reference.astimezone(timezone.utc) - timedelta(days=days)
    rows = (
        await session.execute(
            select(AgentTopicClaim)
            .where(
                AgentTopicClaim.released_at.is_(None),
                AgentTopicClaim.claimed_at >= since,
            )
            .order_by(desc(AgentTopicClaim.claimed_at), desc(AgentTopicClaim.id))
            .limit(500)
        )
    ).scalars().all()

    prepared = PreparedText(f"{normalized.topic} {normalized.core_claim}")
    scored = [
        (
            row,
            similarity(
                prepared,
                PreparedText(f"{row.topic or ''} {row.core_claim or ''}"),
            ),
        )
        for row in rows
    ]
    scored = [item for item in scored if item[1] > 0]
    scored.sort(key=lambda item: item[1], reverse=True)
    conflicts = [_claim_evidence(row, score) for row, score in scored[:10]]
    if not conflicts:
        return NoveltyDecision(
            decision="novel",
            conflicts=(),
            reason="No similar Agent-created topic exists in the active window",
            novelty_basis="",
            suggested_action="continue",
        )
    try:
        verdict = await judge(normalized, conflicts)
        return _normalize_verdict(verdict, conflicts)
    except Exception:
        return _uncertain(conflicts)


def _first_json_object(raw: str) -> dict:
    start = raw.find("{")
    end = raw.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("novelty model returned no JSON object")
    value = json.loads(raw[start:end + 1])
    if not isinstance(value, dict):
        raise ValueError("novelty model returned a non-object")
    return value


def build_novelty_prompt(
    candidate: NoveltyCandidate,
    conflicts: list[dict],
) -> str:
    payload = {
        "candidate": {
            "topic": candidate.topic,
            "core_claim": candidate.core_claim,
            "key_facts": list(candidate.key_facts),
            "event_time": _iso(candidate.event_time),
        },
        "recent_claims": conflicts,
    }
    return (
        "Judge whether the candidate repeats a recent topic and core claim. "
        "A new title, structure, tone, or examples do not make the same core "
        "conclusion novel. A materially different conclusion is novel. Facts "
        "that occurred after the earlier work may be new_development only when "
        "they justify a new piece. Return one JSON object with exactly decision "
        "(novel|duplicate|new_development|uncertain), reason, novelty_basis, "
        "and suggested_action (continue|change_topic|ask_user).\n"
        + json.dumps(payload, ensure_ascii=False)
    )


async def judge_novelty_with_model(
    candidate: NoveltyCandidate,
    conflicts: list[dict],
) -> dict:
    import llm

    raw = await llm._call(
        build_novelty_prompt(candidate, conflicts),
        max_tokens=1_200,
    )
    value = _first_json_object(raw)
    _normalize_verdict(value, conflicts)
    return value
