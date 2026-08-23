"""Durable, redacted Agent event streams for Chat and Job runtimes."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from agent_trajectory import (
    canonical_event_status,
    validate_agent_session_event,
)
from log_redaction import redact_log_value
from models import AgentLogEvent


async def append_agent_log_event(
    session: AsyncSession,
    *,
    stream_kind: str,
    stream_key: str,
    event_type: str,
    phase: str = "",
    status: str = "info",
    session_id: int | None = None,
    job_id: int | None = None,
    execution_id: int | None = None,
    turn_id: str | None = None,
    step_id: str | None = None,
    payload: object = None,
    usage: dict | None = None,
    duration_ms: int | None = None,
) -> AgentLogEvent:
    event = AgentLogEvent(
        stream_kind=stream_kind,
        stream_key=stream_key,
        session_id=session_id,
        job_id=job_id,
        execution_id=execution_id,
        turn_id=turn_id,
        step_id=step_id,
        event_type=event_type,
        phase=phase,
        status=status,
        payload_data=redact_log_value(payload),
        usage_data=redact_log_value(usage) if usage is not None else None,
        duration_ms=duration_ms,
    )
    session.add(event)
    await session.commit()
    await session.refresh(event)
    return event


async def append_agent_session_event(
    session: AsyncSession,
    *,
    stream_kind: str,
    stream_key: str,
    event_type: str,
    data: dict,
    session_id: int | None = None,
    job_id: int | None = None,
    execution_id: int | None = None,
    turn_id: str | None = None,
    step_id: str | None = None,
    turn: int | None = None,
    step: int | None = None,
) -> AgentLogEvent:
    """Validate and append one canonical Agent session event.

    This function intentionally does not catch persistence errors.  A failed
    canonical append must be visible to the caller instead of leaving a trace
    that claims a turn was completed when its event was never stored.
    """

    payload = dict(data)
    existing = []
    if turn is None:
        candidate = payload.get("turn")
        if isinstance(candidate, int) and candidate > 0:
            turn = candidate
        elif turn_id:
            scoped = await _recent_scoped_events(
                session,
                stream_key=stream_key,
                turn_id=turn_id,
            )
            for prior in scoped:
                if not isinstance(prior.payload_data, dict):
                    continue
                candidate = prior.payload_data.get("turn")
                if isinstance(candidate, int) and candidate > 0:
                    turn = candidate
                    break
    if step is None:
        candidate = payload.get("step")
        if isinstance(candidate, int) and candidate > 0:
            step = candidate
        elif step_id:
            scoped = await _recent_scoped_events(
                session,
                stream_key=stream_key,
                step_id=step_id,
            )
            for prior in scoped:
                if not isinstance(prior.payload_data, dict):
                    continue
                candidate = prior.payload_data.get("step")
                if isinstance(candidate, int) and candidate > 0:
                    step = candidate
                    break
    if event_type == "turn/start" and payload.get("turn") is None:
        if not existing:
            existing = await list_agent_log_events(
                session,
                stream_key=stream_key,
                limit=500,
            )
        turns = [
            value
            for event in existing
            for value in (
                event.payload_data.get("turn")
                if isinstance(event.payload_data, dict)
                else None,
            )
            if isinstance(value, int) and value > 0
        ]
        payload["turn"] = max(turns, default=0) + 1
    if turn is not None and event_type not in {"turn/start", "turn/end"}:
        payload.setdefault("turn", turn)
    if step is not None and event_type not in {"turn/start", "turn/end", "request/header"}:
        payload.setdefault("step", step)
    normalized = validate_agent_session_event(event_type, payload)
    resolved_turn = turn
    if resolved_turn is None and isinstance(normalized.get("turn"), int):
        resolved_turn = normalized["turn"]
    resolved_step = step
    if resolved_step is None and isinstance(normalized.get("step"), int):
        resolved_step = normalized["step"]
    if event_type == "turn/end" and resolved_turn is not None:
        normalized["turn"] = resolved_turn
    return await append_agent_log_event(
        session,
        stream_kind=stream_kind,
        stream_key=stream_key,
        session_id=session_id,
        job_id=job_id,
        execution_id=execution_id,
        turn_id=turn_id or (str(resolved_turn) if resolved_turn is not None else None),
        step_id=step_id or (str(resolved_step) if resolved_step is not None else None),
        event_type=event_type,
        phase="trajectory",
        status=canonical_event_status(event_type, normalized),
        payload=normalized,
    )


async def _recent_scoped_events(
    session: AsyncSession,
    *,
    stream_key: str,
    turn_id: str | None = None,
    step_id: str | None = None,
) -> list[AgentLogEvent]:
    """Read recent events for the current turn/step, not the stream's first page."""

    statement = select(AgentLogEvent).where(AgentLogEvent.stream_key == stream_key)
    if turn_id is not None:
        statement = statement.where(AgentLogEvent.turn_id == turn_id)
    if step_id is not None:
        statement = statement.where(AgentLogEvent.step_id == step_id)
    statement = statement.order_by(AgentLogEvent.id.desc()).limit(500)
    return list((await session.execute(statement)).scalars().all())


async def list_agent_log_events(
    session: AsyncSession,
    *,
    stream_key: str | None = None,
    session_id: int | None = None,
    job_id: int | None = None,
    execution_id: int | None = None,
    event_type: str | None = None,
    phase: str | None = None,
    status: str | None = None,
    after_sequence: int | None = None,
    limit: int = 100,
) -> list[AgentLogEvent]:
    statement = select(AgentLogEvent)
    if stream_key:
        statement = statement.where(AgentLogEvent.stream_key == stream_key)
    if session_id is not None:
        statement = statement.where(AgentLogEvent.session_id == session_id)
    if job_id is not None:
        statement = statement.where(AgentLogEvent.job_id == job_id)
    if execution_id is not None:
        statement = statement.where(AgentLogEvent.execution_id == execution_id)
    if event_type:
        statement = statement.where(AgentLogEvent.event_type == event_type)
    if phase:
        statement = statement.where(AgentLogEvent.phase == phase)
    if status:
        statement = statement.where(AgentLogEvent.status == status)
    if after_sequence is not None:
        statement = statement.where(AgentLogEvent.id > after_sequence)
    statement = statement.order_by(AgentLogEvent.id.asc()).limit(max(1, min(limit, 501)))
    return list((await session.execute(statement)).scalars().all())


async def list_all_agent_log_events(
    session: AsyncSession,
    *,
    stream_key: str | None = None,
    session_id: int | None = None,
    job_id: int | None = None,
    execution_id: int | None = None,
) -> list[AgentLogEvent]:
    """Read a scoped stream in cursor-sized chunks for state derivation."""

    events: list[AgentLogEvent] = []
    after_sequence: int | None = None
    while True:
        page = await list_agent_log_events(
            session,
            stream_key=stream_key,
            session_id=session_id,
            job_id=job_id,
            execution_id=execution_id,
            after_sequence=after_sequence,
            limit=500,
        )
        events.extend(page)
        if len(page) < 500:
            return events
        next_sequence = page[-1].sequence
        if after_sequence == next_sequence:
            return events
        after_sequence = next_sequence


def agent_log_event_payload(event: AgentLogEvent) -> dict:
    return {
        "id": event.id,
        "sequence": event.sequence,
        "stream_kind": event.stream_kind,
        "stream_key": event.stream_key,
        "session_id": event.session_id,
        "job_id": event.job_id,
        "execution_id": event.execution_id,
        "turn_id": event.turn_id,
        "step_id": event.step_id,
        "event_type": event.event_type,
        "phase": event.phase,
        "status": event.status,
        "payload": redact_log_value(event.payload_data),
        "usage": redact_log_value(event.usage_data) if event.usage_data is not None else None,
        "duration_ms": event.duration_ms,
        "created_at": event.created_at,
    }
