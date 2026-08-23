"""Persistence and read projections for ordered Skill Pipelines."""

from __future__ import annotations

from collections.abc import Mapping
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from content_jobs import create_or_get_job
from execution_artifacts import list_execution_artifacts
from log_redaction import redact_secret_text
from models import ContentJob, ContentJobEvent, ContentJobStep
from pipeline_contracts import (
    PipelineCreateInput,
    build_macro_plan,
    normalize_invocations,
)


class PipelineJobNotFound(KeyError):
    pass


class PipelinePlanConflict(RuntimeError):
    pass


class PipelineCommandConflict(RuntimeError):
    pass


class PipelineInvalidState(RuntimeError):
    pass


_PRIVATE_KEYS = {
    "api_key",
    "apikey",
    "token",
    "secret",
    "app_id",
    "appid",
    "app_secret",
    "appsecret",
    "access_token",
    "accesstoken",
    "refresh_token",
    "refreshtoken",
    "instructions",
    "content",
    "directory",
    "requestedallowedtools",
    "requested_allowed_tools",
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _private_key(key: object) -> bool:
    normalized = str(key).lower().replace("-", "").replace("_", "")
    return normalized in {
        "apikey",
        "token",
        "secret",
        "appid",
        "appsecret",
        "accesstoken",
        "refreshtoken",
        "instructions",
        "content",
        "directory",
        "requestedallowedtools",
    }


def _public_value(value: object) -> object:
    if isinstance(value, Mapping):
        return {
            str(key): _public_value(nested)
            for key, nested in value.items()
            if not _private_key(key)
        }
    if isinstance(value, list):
        return [_public_value(item) for item in value]
    if isinstance(value, tuple):
        return [_public_value(item) for item in value]
    if isinstance(value, str):
        return redact_secret_text(value)
    return value


def _artifact_payload(artifact) -> dict[str, Any]:
    return {
        "id": artifact.id,
        "step_id": artifact.step_id,
        "attempt": artifact.attempt,
        "kind": artifact.kind,
        "role": artifact.role,
        "title": redact_secret_text(artifact.title),
        "text_content": redact_secret_text(artifact.text_content or ""),
        "structured_content": _public_value(artifact.structured_content),
        "digest": artifact.digest,
        "status": artifact.status,
        "created_at": artifact.created_at,
    }


async def _pipeline_steps(session: AsyncSession, job_id: int) -> list[ContentJobStep]:
    return list((await session.execute(
        select(ContentJobStep)
        .where(ContentJobStep.job_id == job_id)
        .order_by(ContentJobStep.id.asc())
    )).scalars().all())


async def create_pipeline_job(
    session: AsyncSession,
    request: PipelineCreateInput,
    *,
    commit: bool = True,
) -> ContentJob:
    """Persist a resolved pipeline and its immutable Stage input snapshots."""
    invocations = normalize_invocations(request.invocations)
    plan = build_macro_plan(request.objective, invocations)
    input_data = {
        "objective": request.objective,
        "confirmation": request.confirmation,
        "pipeline": {
            "version": 1,
            "plan": deepcopy(plan),
            "invocations": deepcopy(invocations),
        },
    }

    existing = None
    if request.idempotency_key:
        existing = await session.scalar(select(ContentJob).where(
            ContentJob.idempotency_key == request.idempotency_key,
        ))
    job = await create_or_get_job(
        session,
        flow="skill_pipeline",
        title=request.title,
        input_data=input_data,
        idempotency_key=request.idempotency_key,
        commit=False,
    )
    if existing is not None or await session.scalar(
        select(func.count(ContentJobStep.id)).where(ContentJobStep.job_id == job.id)
    ):
        return job

    job.status = "awaiting_confirmation" if request.confirmation == "interactive" else "queued"
    job.plan_version = 1
    job.run_epoch = 1
    session.add(ContentJobStep(
        job_id=job.id,
        step_key="pipeline_plan",
        status="succeeded",
        input_data={"kind": "pipeline_plan", "version": 1},
        output_data=deepcopy(plan),
        completed_at=_now(),
    ))
    for stage in plan["stages"]:
        invocation = invocations[stage["position"] - 1]
        session.add(ContentJobStep(
            job_id=job.id,
            step_key=stage["step_key"],
            attempt=1,
            status="queued",
            input_data={
                "position": stage["position"],
                "objective": request.objective,
                "plan_version": 1,
                "run_epoch": 1,
                "plan_stage": deepcopy(stage),
                "invocation": deepcopy(invocation),
                "parameter_snapshot": deepcopy(invocation.get("parameter_snapshot")),
                "previous_primary_artifact_id": None,
            },
            output_data={},
        ))
    session.add(ContentJobEvent(
        job_id=job.id,
        kind="pipeline_created",
        payload={
            "confirmation": request.confirmation,
            "stage_count": len(plan["stages"]),
            "plan_version": 1,
            "run_epoch": 1,
        },
    ))
    await session.flush()
    if commit:
        await session.commit()
        await session.refresh(job)
    return job


async def pipeline_job_payload(session: AsyncSession, job_id: int) -> dict[str, Any]:
    job = await session.get(ContentJob, job_id)
    if job is None:
        raise PipelineJobNotFound(f"job {job_id} not found")
    if job.flow != "skill_pipeline":
        raise PipelineInvalidState(f"job {job_id} is not a Skill Pipeline")

    steps = await _pipeline_steps(session, job.id)
    plan_step = next((step for step in steps if step.step_key == "pipeline_plan"), None)
    artifacts = await list_execution_artifacts(
        session,
        job_id=job.id,
        include_superseded=True,
    )
    by_step: dict[int, list[dict[str, Any]]] = {}
    for artifact in artifacts:
        by_step.setdefault(artifact.step_id, []).append(_artifact_payload(artifact))

    stages: list[dict[str, Any]] = []
    for step in steps:
        if step.step_key == "pipeline_plan":
            continue
        stages.append({
            "id": step.id,
            "key": step.step_key,
            "attempt": step.attempt,
            "status": step.status,
            "input": _public_value(step.input_data),
            "output": _public_value(step.output_data),
            "error": redact_secret_text(step.error or ""),
            "retryable": step.retryable,
            "artifacts": by_step.get(step.id, []),
            "created_at": step.created_at,
            "started_at": step.started_at,
            "completed_at": step.completed_at,
        })

    events = list((await session.execute(
        select(ContentJobEvent)
        .where(ContentJobEvent.job_id == job.id)
        .order_by(ContentJobEvent.id.asc())
    )).scalars().all())
    return {
        "id": job.id,
        "flow": job.flow,
        "title": job.title,
        "status": job.status,
        "input": _public_value(job.input_data),
        "plan_version": job.plan_version,
        "run_epoch": job.run_epoch,
        "created_at": job.created_at,
        "started_at": job.started_at,
        "completed_at": job.completed_at,
        "pipeline": {
            "plan": _public_value(plan_step.output_data if plan_step else job.input_data.get("pipeline", {}).get("plan", {})),
            "stages": stages,
            "artifacts": [_artifact_payload(artifact) for artifact in artifacts],
        },
        "events": [{
            "id": event.id,
            "kind": event.kind,
            "payload": _public_value(event.payload),
            "created_at": event.created_at,
        } for event in events],
    }
