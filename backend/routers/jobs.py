"""Public API for durable Hermes-free content jobs."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from content_jobs import InvalidJobTransition, cancel_job, create_job, retry_step, start_step, succeed_job, succeed_step
from database import get_db
from job_queue import enqueue_job
from models import ContentJob, ContentJobEvent, ContentJobStep


router = APIRouter(prefix="/jobs", tags=["jobs"])


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


async def _job_payload(db: AsyncSession, job: ContentJob) -> dict:
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
        "steps": [_step_payload(step) for step in steps],
        "events": [{"id": event.id, "kind": event.kind, "payload": event.payload, "created_at": event.created_at} for event in events],
    }


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
async def list_jobs(limit: int = 50, db: AsyncSession = Depends(get_db)):
    limit = max(1, min(limit, 100))
    jobs = (await db.execute(select(ContentJob).order_by(ContentJob.created_at.desc()).limit(limit))).scalars().all()
    return {"jobs": [await _job_payload(db, job) for job in jobs]}


@router.get("/{job_id}")
async def get_job(job_id: int, db: AsyncSession = Depends(get_db)):
    job = await db.get(ContentJob, job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    return await _job_payload(db, job)


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


@router.post("/{job_id}/succeed")
async def post_succeed_job(job_id: int, db: AsyncSession = Depends(get_db)):
    try:
        return await _job_payload(db, await succeed_job(db, job_id))
    except KeyError:
        raise HTTPException(404, "job not found") from None
    except InvalidJobTransition as exc:
        raise HTTPException(409, str(exc)) from exc
