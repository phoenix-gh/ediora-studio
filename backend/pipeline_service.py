"""Persistence and read projections for ordered Skill Pipelines."""

from __future__ import annotations

from collections.abc import Mapping
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from content_jobs import create_or_get_job
from execution_artifacts import (
    list_execution_artifacts,
    supersede_execution_artifacts,
)
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


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _private_key(key: object) -> bool:
    normalized = str(key).lower().replace("-", "").replace("_", "")
    return normalized in {
        "apikey",
        "apisecret",
        "token",
        "secret",
        "password",
        "authorization",
        "cookie",
        "sessioncookie",
        "appid",
        "appsecret",
        "accesstoken",
        "refreshtoken",
        "instructions",
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


def _require_request_id(request_id: str) -> str:
    normalized = request_id.strip()
    if not normalized or len(normalized) > 200:
        raise PipelineCommandConflict("request_id is required")
    return normalized


async def _locked_pipeline_job(
    session: AsyncSession,
    job_id: int,
) -> ContentJob:
    from content_jobs import lock_content_job_row

    job = await lock_content_job_row(session, job_id)
    if job is None:
        raise PipelineJobNotFound(f"job {job_id} not found")
    if job.flow != "skill_pipeline":
        raise PipelineInvalidState(f"job {job_id} is not a Skill Pipeline")
    return job


async def _existing_command(
    session: AsyncSession,
    job_id: int,
    command: str,
    request_id: str,
) -> bool:
    events = (await session.execute(
        select(ContentJobEvent)
        .where(
            ContentJobEvent.job_id == job_id,
            ContentJobEvent.kind == "pipeline_command",
        )
        .order_by(ContentJobEvent.id.asc())
    )).scalars().all()
    for event in events:
        payload = event.payload or {}
        if payload.get("request_id") != request_id:
            continue
        if payload.get("command") != command:
            raise PipelineCommandConflict(
                f"request_id already belongs to command {payload.get('command', '')}"
            )
        return True
    return False


async def _record_command(
    session: AsyncSession,
    job: ContentJob,
    *,
    command: str,
    request_id: str,
    result: dict[str, Any] | None = None,
) -> None:
    session.add(ContentJobEvent(
        job_id=job.id,
        kind="pipeline_command",
        payload={
            "command": command,
            "request_id": request_id,
            "result": result or {"status": job.status},
        },
    ))


async def _latest_stage(
    session: AsyncSession,
    job_id: int,
    stage_key: str,
) -> ContentJobStep | None:
    return await session.scalar(
        select(ContentJobStep)
        .where(
            ContentJobStep.job_id == job_id,
            ContentJobStep.step_key == stage_key,
        )
        .order_by(ContentJobStep.attempt.desc(), ContentJobStep.id.desc())
        .limit(1)
        .with_for_update()
    )


async def _stage_rows(
    session: AsyncSession,
    job_id: int,
) -> list[ContentJobStep]:
    return list((await session.execute(
        select(ContentJobStep)
        .where(
            ContentJobStep.job_id == job_id,
            ContentJobStep.step_key != "pipeline_plan",
        )
        .order_by(ContentJobStep.id.asc())
        .with_for_update()
    )).scalars().all())


def _plan_for(job: ContentJob) -> dict[str, Any]:
    pipeline = job.input_data.get("pipeline")
    if not isinstance(pipeline, dict):
        raise PipelineInvalidState("pipeline plan is missing")
    plan = pipeline.get("plan")
    if not isinstance(plan, dict) or not isinstance(plan.get("stages"), list):
        raise PipelineInvalidState("pipeline plan is invalid")
    return deepcopy(plan)


async def confirm_pipeline(
    session: AsyncSession,
    *,
    job_id: int,
    plan_version: int,
    request_id: str,
) -> ContentJob:
    request_id = _require_request_id(request_id)
    job = await _locked_pipeline_job(session, job_id)
    if await _existing_command(session, job.id, "confirm", request_id):
        return job
    if job.plan_version != plan_version:
        raise PipelinePlanConflict(
            f"plan version {plan_version} is stale; current version is {job.plan_version}"
        )
    if job.status != "awaiting_confirmation":
        raise PipelineInvalidState(f"cannot confirm a {job.status} pipeline")
    job.status = "queued"
    job.completed_at = None
    await _record_command(
        session,
        job,
        command="confirm",
        request_id=request_id,
        result={"status": "queued", "plan_version": job.plan_version},
    )
    await session.flush()
    await session.commit()
    await session.refresh(job)
    return job


async def revise_pipeline_plan(
    session: AsyncSession,
    *,
    job_id: int,
    plan_version: int,
    request_id: str,
    stage_instructions: dict[str, str],
) -> ContentJob:
    request_id = _require_request_id(request_id)
    job = await _locked_pipeline_job(session, job_id)
    if await _existing_command(session, job.id, "revise", request_id):
        return job
    if job.plan_version != plan_version:
        raise PipelinePlanConflict(
            f"plan version {plan_version} is stale; current version is {job.plan_version}"
        )
    if job.status != "awaiting_confirmation":
        raise PipelineInvalidState(f"cannot revise a {job.status} pipeline")
    plan = _plan_for(job)
    plan_stages = {stage.get("step_key"): stage for stage in plan["stages"]}
    unknown = set(stage_instructions) - set(plan_stages)
    if unknown:
        raise PipelineInvalidState(
            f"cannot revise unknown pipeline stages: {', '.join(sorted(unknown))}"
        )
    for stage_key, instruction in stage_instructions.items():
        normalized = instruction.strip()
        if not normalized or len(normalized) > 4_000:
            raise PipelineCommandConflict("stage instruction is empty or too large")
        plan_stages[stage_key]["instruction"] = normalized

    next_version = job.plan_version + 1
    input_data = deepcopy(job.input_data)
    input_data["pipeline"]["plan"] = plan
    job.input_data = input_data
    job.plan_version = next_version
    for step in await _stage_rows(session, job.id):
        if step.step_key not in stage_instructions:
            continue
        step_input = deepcopy(step.input_data)
        step_input["plan_stage"] = deepcopy(plan_stages[step.step_key])
        step_input["plan_version"] = next_version
        step.input_data = step_input
    await _record_command(
        session,
        job,
        command="revise",
        request_id=request_id,
        result={"status": job.status, "plan_version": next_version},
    )
    await session.flush()
    await session.commit()
    await session.refresh(job)
    return job


async def cancel_pipeline(
    session: AsyncSession,
    *,
    job_id: int,
    request_id: str,
) -> ContentJob:
    request_id = _require_request_id(request_id)
    job = await _locked_pipeline_job(session, job_id)
    if await _existing_command(session, job.id, "cancel", request_id):
        return job
    if job.status in {"succeeded", "cancelled"}:
        raise PipelineInvalidState(f"cannot cancel a {job.status} pipeline")
    if job.status not in {"awaiting_confirmation", "queued", "running"}:
        raise PipelineInvalidState(f"cannot cancel a {job.status} pipeline")
    job.status = "cancelled"
    job.completed_at = _now()
    for step in await _stage_rows(session, job.id):
        if step.status in {"queued", "running"}:
            step.status = "cancelled"
            step.completed_at = job.completed_at
    await _record_command(
        session,
        job,
        command="cancel",
        request_id=request_id,
        result={"status": "cancelled"},
    )
    await session.flush()
    await session.commit()
    await session.refresh(job)
    return job


async def retry_pipeline_stage(
    session: AsyncSession,
    *,
    job_id: int,
    stage_key: str,
    request_id: str,
) -> ContentJob:
    request_id = _require_request_id(request_id)
    job = await _locked_pipeline_job(session, job_id)
    if await _existing_command(session, job.id, "retry", request_id):
        return job
    if job.status != "failed":
        raise PipelineInvalidState("only a failed pipeline can retry a Stage")
    previous = await _latest_stage(session, job.id, stage_key)
    if previous is None:
        raise PipelineJobNotFound(f"pipeline Stage {stage_key} not found")
    if previous.status != "failed" or not previous.retryable:
        raise PipelineInvalidState("only a retryable failed Stage can be retried")
    next_epoch = job.run_epoch + 1
    next_input = deepcopy(previous.input_data)
    next_input["run_epoch"] = next_epoch
    next_input["previous_primary_artifact_id"] = None
    session.add(ContentJobStep(
        job_id=job.id,
        step_key=stage_key,
        attempt=previous.attempt + 1,
        status="queued",
        input_data=next_input,
        output_data={},
    ))
    job.status = "queued"
    job.run_epoch = next_epoch
    job.completed_at = None
    await _record_command(
        session,
        job,
        command="retry",
        request_id=request_id,
        result={"status": "queued", "stage_key": stage_key, "attempt": previous.attempt + 1},
    )
    await session.flush()
    await session.commit()
    await session.refresh(job)
    return job


async def rerun_pipeline_stage(
    session: AsyncSession,
    *,
    job_id: int,
    stage_key: str,
    request_id: str,
) -> ContentJob:
    request_id = _require_request_id(request_id)
    job = await _locked_pipeline_job(session, job_id)
    if await _existing_command(session, job.id, "rerun", request_id):
        return job
    if job.status != "succeeded":
        raise PipelineInvalidState("only a succeeded pipeline can rerun a Stage")
    stages = await _stage_rows(session, job.id)
    selected_index = next(
        (index for index, step in enumerate(stages) if step.step_key == stage_key),
        None,
    )
    if selected_index is None:
        raise PipelineJobNotFound(f"pipeline Stage {stage_key} not found")
    selected = stages[selected_index]
    if selected.status != "succeeded":
        raise PipelineInvalidState("only a succeeded Stage can be rerun")

    downstream = stages[selected_index:]
    await supersede_execution_artifacts(
        session,
        job_id=job.id,
        step_ids=[step.id for step in downstream],
    )
    next_epoch = job.run_epoch + 1
    for previous in downstream:
        previous.status = "superseded"
        previous.completed_at = previous.completed_at or _now()
        next_input = deepcopy(previous.input_data)
        next_input["run_epoch"] = next_epoch
        next_input["previous_primary_artifact_id"] = None
        session.add(ContentJobStep(
            job_id=job.id,
            step_key=previous.step_key,
            attempt=previous.attempt + 1,
            status="queued",
            input_data=next_input,
            output_data={},
        ))
    job.status = "queued"
    job.run_epoch = next_epoch
    job.completed_at = None
    await _record_command(
        session,
        job,
        command="rerun",
        request_id=request_id,
        result={
            "status": "queued",
            "stage_key": stage_key,
            "run_epoch": next_epoch,
        },
    )
    await session.flush()
    await session.commit()
    await session.refresh(job)
    return job
