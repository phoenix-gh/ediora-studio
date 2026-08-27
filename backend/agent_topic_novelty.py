"""Global, time-bounded topic novelty checks for Agent-created drafts."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import json
import secrets
from typing import Awaitable, Callable, Literal, Sequence

from sqlalchemy import desc, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from models import (
    AgentNoveltyOverride,
    AgentTopicClaim,
    ArticleDraft,
    PipelineTask,
)
from text_dedupe import PreparedText, similarity


NoveltyDecisionName = Literal[
    "novel", "duplicate", "new_development", "uncertain"
]
SuggestedAction = Literal["continue", "change_topic", "ask_user"]
NoveltyJudge = Callable[
    ["NoveltyCandidate", list[dict]], Awaitable[dict]
]
CandidateExtractor = Callable[[str, str], Awaitable["NoveltyCandidate"]]

AGENT_TOPIC_NOVELTY_LOCK_KEY = 6_947_221_401


@dataclass(frozen=True)
class AgentIdentity:
    mode: Literal["chat", "scheduled", "job"]
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


async def extract_candidate_with_model(title: str, content: str) -> NoveltyCandidate:
    import llm

    payload = {"title": title, "content": content[:20_000]}
    raw = await llm._call(
        "Extract the topic and principal claim of this draft. Return one JSON "
        "object with topic, core_claim, key_facts (array), event_time (ISO "
        "timestamp or null), and source_item_ids (positive integer array).\n"
        + json.dumps(payload, ensure_ascii=False),
        max_tokens=1_200,
    )
    value = _first_json_object(raw)
    event_time = value.get("event_time")
    parsed_event_time: datetime | None = None
    if event_time:
        parsed_event_time = datetime.fromisoformat(
            str(event_time).replace("Z", "+00:00")
        )
    return normalize_candidate(NoveltyCandidate(
        topic=value.get("topic", ""),
        core_claim=value.get("core_claim", ""),
        key_facts=tuple(value.get("key_facts") or ()),
        event_time=parsed_event_time,
        source_item_ids=tuple(value.get("source_item_ids") or ()),
    ))


def _candidate_payload(candidate: NoveltyCandidate) -> dict:
    return {
        "topic": candidate.topic,
        "core_claim": candidate.core_claim,
        "key_facts": list(candidate.key_facts),
        "event_time": _iso(candidate.event_time),
        "source_item_ids": list(candidate.source_item_ids),
    }


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _candidate_digest(candidate: NoveltyCandidate) -> str:
    return _sha256(json.dumps(
        _candidate_payload(candidate), ensure_ascii=False, sort_keys=True
    ))


async def _lock_agent_topic_history(session: AsyncSession) -> None:
    bind = session.get_bind()
    if bind.dialect.name == "postgresql":
        await session.execute(
            text("SELECT pg_advisory_xact_lock(:key)"),
            {"key": AGENT_TOPIC_NOVELTY_LOCK_KEY},
        )


def _decision_dict(decision: NoveltyDecision) -> dict:
    return {
        "decision": decision.decision,
        "conflicts": list(decision.conflicts),
        "reason": decision.reason,
        "novelty_basis": decision.novelty_basis,
        "suggested_action": decision.suggested_action,
    }


async def _valid_override(
    session: AsyncSession,
    *,
    token: str,
    identity: AgentIdentity,
    candidate_digest: str,
    conflict_ids: list[int],
    now: datetime,
) -> AgentNoveltyOverride | None:
    if identity.mode != "chat" or identity.session_id is None:
        return None
    challenge = await session.scalar(
        select(AgentNoveltyOverride).where(
            AgentNoveltyOverride.token_digest == _sha256(token),
            AgentNoveltyOverride.agent_session_id == identity.session_id,
            AgentNoveltyOverride.candidate_digest == candidate_digest,
            AgentNoveltyOverride.expires_at > now,
            AgentNoveltyOverride.consumed_at.is_(None),
        )
    )
    if challenge is None:
        return None
    if sorted(challenge.conflict_claim_ids or []) != sorted(conflict_ids):
        return None
    return challenge


async def save_agent_draft_with_novelty_check(
    session: AsyncSession,
    *,
    title: str,
    content: str,
    topic_id: str,
    status: str,
    pipeline_task_id: int | None,
    draft_type: str,
    identity: AgentIdentity,
    window_days: int,
    override_token: str | None = None,
    extract_candidate: CandidateExtractor = extract_candidate_with_model,
    judge: NoveltyJudge = judge_novelty_with_model,
    now: datetime | None = None,
) -> dict:
    """Authoritatively check novelty and persist one Agent draft and claim."""
    if identity.mode == "chat":
        if identity.session_id is None or identity.session_id <= 0:
            raise ValueError("Chat Agent session identity is required")
    elif identity.mode == "scheduled":
        if (
            identity.daily_creation_run_id is None
            or identity.daily_creation_run_id <= 0
        ):
            raise ValueError("scheduled Agent run identity is required")
    elif identity.mode != "job":
        raise ValueError("Agent mode is invalid")

    normalized_title = _bounded_text(title, name="title", limit=500)
    normalized_content = str(content or "").strip()
    if not normalized_content:
        raise ValueError("content is required")
    candidate = normalize_candidate(
        await extract_candidate(normalized_title, normalized_content)
    )
    candidate_digest = _candidate_digest(candidate)
    reference = now or datetime.now(timezone.utc)
    if reference.tzinfo is None:
        reference = reference.replace(tzinfo=timezone.utc)
    reference = reference.astimezone(timezone.utc)
    transaction = (
        session.begin_nested() if session.in_transaction() else session.begin()
    )
    async with transaction:
        await _lock_agent_topic_history(session)
        decision = await check_content_novelty(
            session,
            candidate=candidate,
            window_days=window_days,
            judge=judge,
            now=reference,
        )
        conflict_ids = [
            int(item["id"]) for item in decision.conflicts
            if isinstance(item.get("id"), int)
        ]
        blocked = decision.decision in {"duplicate", "uncertain"}
        consumed_override: AgentNoveltyOverride | None = None
        override_error = ""
        if override_token:
            if identity.mode != "chat":
                override_error = (
                    "scheduled Agent cannot override novelty"
                    if identity.mode == "scheduled"
                    else "background Agent cannot override novelty"
                )
            elif blocked:
                consumed_override = await _valid_override(
                    session,
                    token=override_token,
                    identity=identity,
                    candidate_digest=candidate_digest,
                    conflict_ids=conflict_ids,
                    now=reference,
                )
                if consumed_override is None:
                    override_error = "novelty override is invalid or expired"
        if blocked and consumed_override is None:
            result = {"saved": False, "novelty": _decision_dict(decision)}
            if override_error:
                result["override_error"] = override_error
            elif identity.mode == "chat":
                plain_token = secrets.token_urlsafe(32)
                session.add(AgentNoveltyOverride(
                    token_digest=_sha256(plain_token),
                    candidate_digest=candidate_digest,
                    conflict_claim_ids=conflict_ids,
                    agent_session_id=identity.session_id,
                    expires_at=reference + timedelta(minutes=10),
                ))
                await session.flush()
                result["novelty_override_token"] = plain_token
            return result

        obj = ArticleDraft(
            topic_id=topic_id,
            title=normalized_title,
            content=normalized_content,
            status=status,
            draft_type=draft_type,
        )
        session.add(obj)
        await session.flush()
        if pipeline_task_id is not None:
            pipeline_task = await session.get(PipelineTask, pipeline_task_id)
            if pipeline_task is not None:
                pipeline_task.draft_id = obj.id
                if (
                    pipeline_task.writing_plan_id is not None
                    and obj.writing_plan_id is None
                ):
                    obj.writing_plan_id = pipeline_task.writing_plan_id
        token_digest = None
        if consumed_override is not None:
            consumed_override.consumed_at = reference
            token_digest = consumed_override.token_digest
        claim = AgentTopicClaim(
            draft_id=obj.id,
            topic=candidate.topic,
            core_claim=candidate.core_claim,
            key_facts=list(candidate.key_facts),
            event_time=candidate.event_time,
            novelty_basis=decision.novelty_basis,
            source_item_ids=list(candidate.source_item_ids),
            decision="override" if consumed_override else decision.decision,
            conflict_claim_ids=conflict_ids,
            reason=decision.reason,
            window_days=_bounded_days(window_days),
            agent_mode=identity.mode,
            agent_session_id=identity.session_id,
            daily_creation_run_id=identity.daily_creation_run_id,
            override_token_digest=token_digest,
            claimed_at=reference,
        )
        session.add(claim)
        await session.flush()

    return {
        "saved": True,
        "id": obj.id,
        "title": obj.title,
        "status": obj.status,
        "draft_type": obj.draft_type,
        "created_at": _iso(obj.created_at),
        "novelty": _decision_dict(decision),
    }
