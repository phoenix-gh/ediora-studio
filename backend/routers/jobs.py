"""Public API for durable Hermes-free content jobs."""

from __future__ import annotations

import base64
import json
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import and_, desc, exists, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from content_jobs import InvalidJobTransition, cancel_job, create_job, fail_step, record_event, retry_step, start_step, succeed_job, succeed_step
from database import get_db
from job_queue import RedisJobQueue, enqueue_job
from job_reconciliation import reconcile_content_jobs
from log_redaction import redact_log_value, redact_secret_text
from models import AgentExecution, AgentMessageLog, AgentToolCall, ContentJob, ContentJobEvent, ContentJobStep, DailyCreationRun
from worker_auth import require_worker_token


router = APIRouter(prefix="/jobs", tags=["jobs"])

JobKind = Literal["scheduled", "manual"]
_JOB_STATUSES = {"queued", "running", "succeeded", "failed", "cancelled"}


class JobCreate(BaseModel):
    flow: str = Field(min_length=1, max_length=64)
    title: str = Field(min_length=1, max_length=500)
    input_data: dict = Field(default_factory=dict, alias="input")
    idempotency_key: str = Field(default="", max_length=128)

    model_config = ConfigDict(populate_by_name=True)


class RetryRequest(BaseModel):
    step_key: str = Field(min_length=1, max_length=64)


class StepOutputRequest(BaseModel):
    output: dict = Field(default_factory=dict)


class StepFailureRequest(BaseModel):
    error: str = Field(min_length=1, max_length=500)
    retryable: bool = True


class JobEventRequest(BaseModel):
    kind: str = Field(min_length=1, max_length=64)
    payload: dict = Field(default_factory=dict)


@router.post(
    "/worker-reconcile",
    dependencies=[Depends(require_worker_token)],
)
async def post_worker_reconcile():
    from runtime_config import get_runtime_settings

    settings = get_runtime_settings()
    async with RedisJobQueue() as queue:
        if queue.name == settings.video_worker_queue:
            return await reconcile_content_jobs(queue, video_queue=queue)
        async with RedisJobQueue(
            queue_name=settings.video_worker_queue,
        ) as video_queue:
            return await reconcile_content_jobs(
                queue,
                video_queue=video_queue,
            )


def _step_payload(step: ContentJobStep) -> dict:
    return {
        "id": step.id,
        "key": step.step_key,
        "attempt": step.attempt,
        "status": step.status,
        "output": step.output_data,
        "error": step.error,
        "retryable": step.retryable,
        "created_at": step.created_at,
        "started_at": step.started_at,
        "completed_at": step.completed_at,
    }


async def _schedule_payload(db: AsyncSession, job_id: int) -> dict | None:
    run = await db.scalar(
        select(DailyCreationRun)
        .where(DailyCreationRun.content_job_id == job_id)
        .order_by(DailyCreationRun.created_at.desc(), DailyCreationRun.id.desc())
        .limit(1)
    )
    if run is None:
        return None
    snapshot = run.rule_snapshot or {}
    scheduled_for = run.scheduled_for
    if scheduled_for.tzinfo is None:
        scheduled_for = scheduled_for.replace(tzinfo=timezone.utc)
    return {
        "run_id": run.id,
        "rule_name": snapshot.get("name") or f"规则 #{run.rule_id}",
        "trigger_kind": run.trigger_kind,
        "scheduled_for": scheduled_for,
    }


async def _job_payload(db: AsyncSession, job: ContentJob, *, schedule: dict | None = None) -> dict:
    steps = (await db.execute(
        select(ContentJobStep).where(ContentJobStep.job_id == job.id)
        .order_by(ContentJobStep.created_at, ContentJobStep.attempt)
    )).scalars().all()
    events = (await db.execute(
        select(ContentJobEvent).where(ContentJobEvent.job_id == job.id)
        .order_by(ContentJobEvent.created_at.desc()).limit(100)
    )).scalars().all()
    return {
        "id": job.id,
        "flow": job.flow,
        "title": job.title,
        "status": job.status,
        "input": job.input_data,
        "created_at": job.created_at,
        "started_at": job.started_at,
        "completed_at": job.completed_at,
        "schedule": await _schedule_payload(db, job.id) if schedule is None else schedule,
        "steps": [_step_payload(step) for step in steps],
        "events": [{"id": event.id, "kind": event.kind, "payload": event.payload, "created_at": event.created_at} for event in events],
    }


def _encode_cursor(job: ContentJob) -> str:
    value = json.dumps(
        {"created_at": job.created_at.isoformat(), "id": job.id},
        separators=(",", ":"),
    ).encode()
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def _decode_cursor(value: str) -> tuple[datetime, int]:
    try:
        padding = "=" * (-len(value) % 4)
        decoded = json.loads(base64.urlsafe_b64decode(value + padding))
        created_at = datetime.fromisoformat(decoded["created_at"])
        job_id = int(decoded["id"])
        if job_id <= 0:
            raise ValueError
    except (ValueError, KeyError, TypeError, json.JSONDecodeError, base64.binascii.Error) as exc:
        raise HTTPException(400, "cursor is invalid") from exc
    return created_at, job_id


@router.post("", status_code=status.HTTP_201_CREATED)
async def post_job(body: JobCreate, db: AsyncSession = Depends(get_db)):
    if body.idempotency_key:
        existing = (await db.execute(
            select(ContentJob).where(ContentJob.idempotency_key == body.idempotency_key)
        )).scalars().first()
        if existing is not None:
            return await _job_payload(db, existing)
    job = await create_job(
        db, flow=body.flow, title=body.title,
        input_data=body.input_data, idempotency_key=body.idempotency_key,
    )
    await enqueue_job(job.id)
    return await _job_payload(db, job)


@router.get("")
async def list_jobs(
    limit: int = 30,
    cursor: str | None = None,
    kind: JobKind | None = None,
    status_filter: str | None = Query(default=None, alias="status"),
    db: AsyncSession = Depends(get_db),
):
    limit = max(1, min(limit, 100))
    if status_filter is not None and status_filter not in _JOB_STATUSES:
        raise HTTPException(400, "status is invalid")

    statement = select(ContentJob)
    scheduled_exists = exists(
        select(DailyCreationRun.id).where(DailyCreationRun.content_job_id == ContentJob.id)
    )
    if kind == "scheduled":
        statement = statement.where(scheduled_exists)
    elif kind == "manual":
        statement = statement.where(~scheduled_exists)
    if status_filter is not None:
        statement = statement.where(ContentJob.status == status_filter)
    if cursor is not None:
        created_at, job_id = _decode_cursor(cursor)
        statement = statement.where(or_(
            ContentJob.created_at < created_at,
            and_(ContentJob.created_at == created_at, ContentJob.id < job_id),
        ))

    jobs = list((await db.execute(
        statement.order_by(ContentJob.created_at.desc(), ContentJob.id.desc()).limit(limit + 1)
    )).scalars().all())
    has_more = len(jobs) > limit
    page = jobs[:limit]
    return {
        "jobs": [await _job_payload(db, job) for job in page],
        "next_cursor": _encode_cursor(page[-1]) if has_more and page else None,
        "has_more": has_more,
    }


@router.get("/{job_id}")
async def get_job(job_id: int, db: AsyncSession = Depends(get_db)):
    job = await db.get(ContentJob, job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    return await _job_payload(db, job)


@router.get("/{job_id}/agent-log")
async def get_job_agent_log(job_id: int, db: AsyncSession = Depends(get_db)):
    job = await db.get(ContentJob, job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    execution = await db.scalar(select(AgentExecution).where(
        AgentExecution.job_id == job_id
    ))
    if execution is None:
        return {"execution": None, "messages": [], "tools": []}
    messages = list((await db.execute(
        select(AgentMessageLog)
        .where(AgentMessageLog.execution_id == execution.id)
        .order_by(AgentMessageLog.id.asc())
    )).scalars().all())
    calls = list((await db.execute(
        select(AgentToolCall)
        .where(AgentToolCall.execution_id == execution.id)
        .order_by(AgentToolCall.id.asc())
    )).scalars().all())
    return {
        "execution": {
            "id": execution.id,
            "job_id": execution.job_id,
            "status": execution.status,
            "objective": execution.objective,
            "phase": execution.phase,
            "error": redact_secret_text(execution.error or ""),
            "created_at": execution.created_at,
            "updated_at": execution.updated_at,
            "completed_at": execution.completed_at,
        },
        "messages": [{
            "id": message.id,
            "execution_id": message.execution_id,
            "phase": message.phase,
            "direction": message.direction,
            "payload": redact_log_value(message.payload_data),
            "created_at": message.created_at,
        } for message in messages],
        "tools": [{
            "id": call.id,
            "tool_call_id": call.tool_call_id,
            "tool_name": call.tool_name,
            "status": call.status,
            "auto_approved": call.auto_approved,
            "side_effecting": call.side_effecting,
            "input_summary": redact_log_value(call.input_summary),
            "output": redact_log_value(call.output_data),
            "error": redact_secret_text(call.error or ""),
            "started_at": call.started_at,
            "completed_at": call.completed_at,
        } for call in calls],
    }


@router.post("/{job_id}/events", status_code=status.HTTP_201_CREATED)
async def post_job_event(job_id: int, body: JobEventRequest, db: AsyncSession = Depends(get_db)):
    try:
        event = await record_event(db, job_id, body.kind, body.payload)
    except KeyError:
        raise HTTPException(404, "job not found") from None
    return {"id": event.id, "kind": event.kind, "payload": event.payload, "created_at": event.created_at}


@router.post("/{job_id}/cancel")
async def post_cancel(job_id: int, db: AsyncSession = Depends(get_db)):
    try:
        job = await cancel_job(db, job_id)
    except KeyError:
        raise HTTPException(404, "job not found") from None
    except InvalidJobTransition as exc:
        raise HTTPException(409, str(exc)) from exc
    return await _job_payload(db, job)


@router.post("/{job_id}/retry")
async def post_retry(job_id: int, body: RetryRequest, db: AsyncSession = Depends(get_db)):
    try:
        await retry_step(db, job_id, body.step_key)
    except KeyError:
        raise HTTPException(404, "job not found") from None
    except InvalidJobTransition as exc:
        raise HTTPException(409, str(exc)) from exc
    await enqueue_job(job_id)
    job = await db.get(ContentJob, job_id)
    assert job is not None
    return await _job_payload(db, job)


@router.post("/{job_id}/steps/{step_key}/start")
async def post_start_step(job_id: int, step_key: str, db: AsyncSession = Depends(get_db)):
    try:
        return _step_payload(await start_step(db, job_id, step_key))
    except KeyError:
        raise HTTPException(404, "job not found") from None
    except InvalidJobTransition as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post("/{job_id}/steps/{step_id}/succeed")
async def post_succeed_step(job_id: int, step_id: int, body: StepOutputRequest, db: AsyncSession = Depends(get_db)):
    step = await db.get(ContentJobStep, step_id)
    if step is None or step.job_id != job_id:
        raise HTTPException(404, "step not found")
    try:
        return _step_payload(await succeed_step(db, step_id, body.output))
    except InvalidJobTransition as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post("/{job_id}/steps/{step_id}/fail")
async def post_fail_step(job_id: int, step_id: int, body: StepFailureRequest, db: AsyncSession = Depends(get_db)):
    step = await db.get(ContentJobStep, step_id)
    if step is None or step.job_id != job_id:
        raise HTTPException(404, "step not found")
    try:
        return _step_payload(await fail_step(db, step_id, body.error, retryable=body.retryable))
    except InvalidJobTransition as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post("/{job_id}/succeed")
async def post_succeed_job(job_id: int, db: AsyncSession = Depends(get_db)):
    try:
        return await _job_payload(db, await succeed_job(db, job_id))
    except KeyError:
        raise HTTPException(404, "job not found") from None
    except InvalidJobTransition as exc:
        raise HTTPException(409, str(exc)) from exc
