"""State transitions for durable content jobs."""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models import ContentJob, ContentJobEvent, ContentJobStep, DailyPlan


class InvalidJobTransition(ValueError):
    pass


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def _event(session: AsyncSession, job_id: int, kind: str, *, step_id: int | None = None, payload: dict | None = None) -> None:
    session.add(ContentJobEvent(job_id=job_id, step_id=step_id, kind=kind, payload=payload or {}))


async def create_job(session: AsyncSession, *, flow: str, title: str, input_data: dict, idempotency_key: str = "") -> ContentJob:
    job = ContentJob(flow=flow, title=title, input_data=input_data, idempotency_key=idempotency_key)
    session.add(job)
    await session.flush()
    await _event(session, job.id, "job_queued")
    await session.commit()
    await session.refresh(job)
    return job


async def _latest_step(session: AsyncSession, job_id: int, step_key: str) -> ContentJobStep | None:
    result = await session.execute(
        select(ContentJobStep)
        .where(ContentJobStep.job_id == job_id, ContentJobStep.step_key == step_key)
        .order_by(ContentJobStep.attempt.desc())
    )
    return result.scalars().first()


async def start_step(session: AsyncSession, job_id: int, step_key: str) -> ContentJobStep:
    job = await session.get(ContentJob, job_id)
    if job is None:
        raise KeyError(f"job {job_id} not found")
    if job.status in {"cancelled", "succeeded"}:
        raise InvalidJobTransition(f"cannot start a step for {job.status} job")
    step = await _latest_step(session, job_id, step_key)
    if step is None:
        step = ContentJobStep(job_id=job_id, step_key=step_key)
        session.add(step)
        await session.flush()
    if step.status != "queued":
        raise InvalidJobTransition(f"cannot start {step.status} step")
    now = _now()
    step.status = "running"
    step.started_at = now
    job.status = "running"
    job.started_at = job.started_at or now
    await _event(session, job_id, "step_started", step_id=step.id, payload={"step_key": step_key, "attempt": step.attempt})
    await session.commit()
    await session.refresh(step)
    return step


async def succeed_step(session: AsyncSession, step_id: int, output_data: dict) -> ContentJobStep:
    step = await session.get(ContentJobStep, step_id)
    if step is None:
        raise KeyError(f"step {step_id} not found")
    if step.status != "running":
        raise InvalidJobTransition(f"cannot succeed {step.status} step")
    step.status = "succeeded"
    step.output_data = output_data
    step.completed_at = _now()
    await _event(session, step.job_id, "step_succeeded", step_id=step.id, payload={"step_key": step.step_key, "attempt": step.attempt})
    await session.commit()
    await session.refresh(step)
    return step


async def fail_step(session: AsyncSession, step_id: int, error: str, *, retryable: bool) -> ContentJobStep:
    step = await session.get(ContentJobStep, step_id)
    if step is None:
        raise KeyError(f"step {step_id} not found")
    if step.status != "running":
        raise InvalidJobTransition(f"cannot fail {step.status} step")
    step.status = "failed"
    step.error = error[:500]
    step.retryable = retryable
    step.completed_at = _now()
    job = await session.get(ContentJob, step.job_id)
    assert job is not None
    job.status = "failed"
    job.completed_at = step.completed_at
    if job.flow == "daily_plan":
        plan_id = job.input_data.get("plan_id")
        if isinstance(plan_id, int):
            plan = await session.get(DailyPlan, plan_id)
            if plan is not None and plan.status == "planning":
                plan.status = "failed"
    await _event(session, step.job_id, "step_failed", step_id=step.id, payload={"step_key": step.step_key, "retryable": retryable})
    await session.commit()
    await session.refresh(step)
    return step


async def retry_step(session: AsyncSession, job_id: int, step_key: str) -> ContentJobStep:
    job = await session.get(ContentJob, job_id)
    if job is None:
        raise KeyError(f"job {job_id} not found")
    previous = await _latest_step(session, job_id, step_key)
    if previous is None or previous.status != "failed" or not previous.retryable:
        raise InvalidJobTransition("only a retryable failed step can be retried")
    step = ContentJobStep(job_id=job_id, step_key=step_key, attempt=previous.attempt + 1)
    session.add(step)
    job.status = "queued"
    job.completed_at = None
    await session.flush()
    await _event(session, job_id, "step_retried", step_id=step.id, payload={"step_key": step_key, "attempt": step.attempt})
    await session.commit()
    await session.refresh(step)
    return step


async def cancel_job(session: AsyncSession, job_id: int) -> ContentJob:
    job = await session.get(ContentJob, job_id)
    if job is None:
        raise KeyError(f"job {job_id} not found")
    if job.status in {"succeeded", "cancelled"}:
        raise InvalidJobTransition(f"cannot cancel {job.status} job")
    job.status = "cancelled"
    job.completed_at = _now()
    await _event(session, job_id, "job_cancelled")
    await session.commit()
    await session.refresh(job)
    return job


async def succeed_job(session: AsyncSession, job_id: int) -> ContentJob:
    job = await session.get(ContentJob, job_id)
    if job is None:
        raise KeyError(f"job {job_id} not found")
    if job.status != "running":
        raise InvalidJobTransition(f"cannot succeed {job.status} job")
    job.status = "succeeded"
    job.completed_at = _now()
    await _event(session, job_id, "job_succeeded")
    await session.commit()
    await session.refresh(job)
    return job
