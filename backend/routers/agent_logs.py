"""Public Agent event-log query and worker-only event ingestion API."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from typing import Literal
from sqlalchemy.ext.asyncio import AsyncSession

from agent_trajectory import (
    CANONICAL_EVENT_TYPES,
    agent_session_event_payload,
    derive_agent_trajectory_state,
    trajectory_event_payloads,
)
from agent_log_service import (
    agent_log_event_payload,
    append_agent_log_event,
    append_agent_session_event,
    list_all_agent_log_events,
    list_agent_log_events,
)
from database import get_db
from worker_auth import require_worker_token


router = APIRouter(prefix="/agent-logs", tags=["agent-logs"])


class AgentLogEventCreate(BaseModel):
    stream_kind: Literal["chat", "job"]
    stream_key: str = Field(min_length=1, max_length=200)
    session_id: int | None = Field(default=None, gt=0)
    job_id: int | None = Field(default=None, gt=0)
    execution_id: int | None = Field(default=None, gt=0)
    turn_id: str | None = Field(default=None, max_length=200)
    step_id: str | None = Field(default=None, max_length=200)
    event_type: str = Field(min_length=1, max_length=120)
    phase: str = Field(default="", max_length=120)
    status: str = Field(default="info", max_length=40)
    payload: object = None
    usage: dict | None = None
    duration_ms: int | None = Field(default=None, ge=0, le=86_400_000)


def _validate_scope(body: AgentLogEventCreate) -> None:
    if body.stream_kind == "chat" and body.session_id is None:
        raise HTTPException(422, "chat event requires session_id")
    if body.stream_kind == "job" and body.job_id is None and body.execution_id is None:
        raise HTTPException(422, "job event requires job_id or execution_id")
    if body.event_type in CANONICAL_EVENT_TYPES:
        if body.stream_kind == "chat" and (body.job_id is not None or body.execution_id is not None):
            raise HTTPException(422, "canonical chat event only accepts session_id scope")
        if body.stream_kind == "job" and body.execution_id is None:
            raise HTTPException(422, "canonical job event requires execution_id scope")


@router.post(
    "/events",
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_worker_token)],
)
async def post_agent_log_event(
    body: AgentLogEventCreate,
    db: AsyncSession = Depends(get_db),
):
    _validate_scope(body)
    if body.event_type in CANONICAL_EVENT_TYPES:
        if not isinstance(body.payload, dict):
            raise HTTPException(422, "canonical Agent event payload must be an object")
        try:
            event = await append_agent_session_event(
                db,
                stream_kind=body.stream_kind,
                stream_key=body.stream_key,
                session_id=body.session_id,
                job_id=body.job_id,
                execution_id=body.execution_id,
                turn_id=body.turn_id,
                step_id=body.step_id,
                event_type=body.event_type,
                data=body.payload,
            )
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        return agent_session_event_payload(event)
    event = await append_agent_log_event(
        db,
        stream_kind=body.stream_kind,
        stream_key=body.stream_key,
        session_id=body.session_id,
        job_id=body.job_id,
        execution_id=body.execution_id,
        turn_id=body.turn_id,
        step_id=body.step_id,
        event_type=body.event_type,
        phase=body.phase,
        status=body.status,
        payload=body.payload,
        usage=body.usage,
        duration_ms=body.duration_ms,
    )
    return agent_log_event_payload(event)


@router.get("/trajectory")
async def get_agent_trajectory(
    session_id: int | None = Query(default=None, gt=0),
    job_id: int | None = Query(default=None, gt=0),
    execution_id: int | None = Query(default=None, gt=0),
    after_sequence: int | None = Query(default=None, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    scopes = [
        ("session_id", session_id),
        ("job_id", job_id),
        ("execution_id", execution_id),
    ]
    selected = [(name, value) for name, value in scopes if value is not None]
    if len(selected) != 1:
        raise HTTPException(422, "trajectory requires exactly one session_id, job_id, or execution_id")

    scope_name, scope_value = selected[0]
    rows = await list_all_agent_log_events(
        db,
        **{scope_name: scope_value},
    )
    canonical_rows = [
        row for row in rows
        if row.event_type in CANONICAL_EVENT_TYPES
    ]
    replay = trajectory_event_payloads(rows)
    visible = [item for item in replay if after_sequence is None or item["seq"] > after_sequence]
    page = visible[: limit + 1]
    has_more = len(page) > limit
    page = page[:limit]
    state = derive_agent_trajectory_state(replay)
    first_row = rows[0] if rows else None
    session_key = first_row.stream_key if first_row is not None else {
        "session_id": f"chat:{session_id}",
        "job_id": f"job:{job_id}",
        "execution_id": f"execution:{execution_id}",
    }[scope_name]
    return {
        "session_key": session_key,
        "events": page,
        "next_sequence": page[-1]["seq"] if page else after_sequence,
        "has_more": has_more,
        "is_running": state["is_running"],
        "last_error": state["last_error"],
        "unsupported_format": bool(rows) and not canonical_rows,
    }


@router.get("")
async def get_agent_log_events(
    stream_key: str | None = Query(default=None, max_length=200),
    session_id: int | None = Query(default=None, gt=0),
    job_id: int | None = Query(default=None, gt=0),
    execution_id: int | None = Query(default=None, gt=0),
    event_type: str | None = Query(default=None, max_length=120),
    phase: str | None = Query(default=None, max_length=120),
    status: str | None = Query(default=None, max_length=40),
    after_sequence: int | None = Query(default=None, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    events = await list_agent_log_events(
        db,
        stream_key=stream_key,
        session_id=session_id,
        job_id=job_id,
        execution_id=execution_id,
        event_type=event_type,
        phase=phase,
        status=status,
        after_sequence=after_sequence,
        limit=limit + 1,
    )
    has_more = len(events) > limit
    page = events[:limit]
    return {
        "events": [agent_log_event_payload(event) for event in page],
        "next_sequence": page[-1].sequence if has_more and page else None,
        "has_more": has_more,
    }
