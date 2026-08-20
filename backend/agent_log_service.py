"""Durable, redacted Agent event streams for Chat and Job runtimes."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

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
