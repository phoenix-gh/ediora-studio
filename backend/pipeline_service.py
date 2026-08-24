"""Persistence and read projections for ordered Skill Pipelines."""

from __future__ import annotations

from collections.abc import Mapping
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from content_jobs import (
    create_or_get_job,
    fail_locked_step,
    lock_content_job_row,
    succeed_locked_step,
)
from agent_log_service import get_agent_token_usage
from execution_artifacts import (
    list_execution_artifacts,
    supersede_execution_artifacts,
)
from log_redaction import redact_log_value, redact_secret_text
from models import (
    AgentExecution,
    AgentLogEvent,
    ContentJob,
    ContentJobEvent,
    ContentJobStep,
    ExecutionArtifact,
)
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


class PipelineArtifactError(ValueError):
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


def _step_payload(step: ContentJobStep) -> dict[str, Any]:
    return {
        "id": step.id,
        "key": step.step_key,
        "attempt": step.attempt,
        "status": step.status,
        "output": _public_value(step.output_data),
        "error": redact_secret_text(step.error or ""),
        "retryable": step.retryable,
        "created_at": step.created_at,
        "started_at": step.started_at,
        "completed_at": step.completed_at,
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
    token_usage = await get_agent_token_usage(session, job_id=job.id)
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
        "token_usage": token_usage,
        "steps": [_step_payload(step) for step in steps],
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


def _pipeline_stage_keys(job: ContentJob) -> list[str]:
    plan = _plan_for(job)
    keys = [stage.get("step_key") for stage in plan["stages"]]
    if not keys or any(not isinstance(key, str) or not key for key in keys):
        raise PipelineInvalidState("pipeline plan contains invalid Stage keys")
    return keys


async def _locked_pipeline_stage(
    session: AsyncSession,
    job: ContentJob,
    step_id: int,
) -> ContentJobStep:
    step = await session.scalar(
        select(ContentJobStep)
        .where(ContentJobStep.id == step_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if step is None or step.job_id != job.id or step.step_key == "pipeline_plan":
        raise PipelineJobNotFound(f"pipeline Stage {step_id} not found")
    return step


def _assert_worker_artifact_safe(value: object, *, path: str = "artifact") -> None:
    secret_keys = {
        "apikey", "apisecret", "authorization", "cookie", "password",
        "secret", "token", "accesstoken", "refreshtoken", "appid", "appsecret",
    }
    if isinstance(value, dict):
        for key, nested in value.items():
            normalized = "".join(character for character in str(key).casefold() if character.isalnum())
            if normalized in secret_keys or normalized.endswith("token"):
                raise PipelineArtifactError(f"credential-looking field is not allowed in {path}.{key}")
            _assert_worker_artifact_safe(nested, path=f"{path}.{key}")
        return
    if isinstance(value, (list, tuple, set, frozenset)):
        for index, nested in enumerate(value):
            _assert_worker_artifact_safe(nested, path=f"{path}[{index}]")
        return
    if isinstance(value, str) and redact_secret_text(value) != value:
        raise PipelineArtifactError(f"secret pattern is not allowed in {path}")


def _validate_worker_artifact(value: dict, *, role: str) -> dict:
    if role not in {"primary", "auxiliary"}:
        raise PipelineArtifactError("artifact role is invalid")
    allowed = {"kind", "title", "text_content", "structured_content"}
    unknown = set(value) - allowed
    if unknown:
        raise PipelineArtifactError(
            f"artifact contains unknown fields: {', '.join(sorted(unknown))}"
        )
    kind = value.get("kind")
    title = value.get("title")
    text_content = value.get("text_content")
    structured_content = value.get("structured_content")
    if not isinstance(kind, str) or not kind.strip() or len(kind) > 120:
        raise PipelineArtifactError("artifact kind is invalid")
    if not isinstance(title, str) or not title.strip() or len(title) > 500:
        raise PipelineArtifactError("artifact title is invalid")
    if text_content is not None and (
        not isinstance(text_content, str) or len(text_content) > 1_000_000
    ):
        raise PipelineArtifactError("artifact text is invalid or too large")
    if not (isinstance(text_content, str) and text_content.strip()) and structured_content is None:
        raise PipelineArtifactError("artifact must contain text_content or structured_content")
    _assert_worker_artifact_safe(text_content, path="artifact.text_content")
    _assert_worker_artifact_safe(structured_content, path="artifact.structured_content")
    return {
        "kind": kind.strip(),
        "title": title.strip(),
        "text_content": text_content,
        "structured_content": structured_content,
    }


async def start_pipeline_stage(
    session: AsyncSession,
    *,
    job_id: int,
    step_id: int,
    attempt: int,
    run_epoch: int,
) -> ContentJobStep:
    job = await _locked_pipeline_job(session, job_id)
    if job.run_epoch != run_epoch:
        raise PipelineInvalidState(
            f"pipeline run epoch {run_epoch} is stale; current epoch is {job.run_epoch}"
        )
    step = await _locked_pipeline_stage(session, job, step_id)
    if step.attempt != attempt:
        raise PipelineInvalidState(
            f"Stage attempt {attempt} is stale; current attempt is {step.attempt}"
        )
    if step.status == "running":
        await session.commit()
        await session.refresh(step)
        return step
    if step.status != "queued":
        raise PipelineInvalidState(f"cannot start a {step.status} Stage")
    if job.status not in {"queued", "running"}:
        raise PipelineInvalidState(f"cannot start a Stage for a {job.status} pipeline")
    keys = _pipeline_stage_keys(job)
    try:
        index = keys.index(step.step_key)
    except ValueError as error:
        raise PipelineInvalidState("Stage is not present in the current plan") from error
    if index > 0:
        previous = await _latest_stage(session, job.id, keys[index - 1])
        if previous is None or previous.status != "succeeded":
            raise PipelineInvalidState("previous Stage has not succeeded")
    now = _now()
    step.status = "running"
    step.started_at = step.started_at or now
    job.status = "running"
    job.started_at = job.started_at or now
    session.add(ContentJobEvent(
        job_id=job.id,
        step_id=step.id,
        kind="pipeline_stage_started",
        payload={"step_key": step.step_key, "attempt": step.attempt, "run_epoch": job.run_epoch},
    ))
    await session.commit()
    await session.refresh(step)
    return step


async def complete_pipeline_stage(
    session: AsyncSession,
    *,
    job_id: int,
    step_id: int,
    attempt: int,
    run_epoch: int,
    execution_id: int,
    primary: dict,
    auxiliary: list[dict],
    completion_evidence: dict,
) -> ContentJob:
    job = await _locked_pipeline_job(session, job_id)
    if job.run_epoch != run_epoch:
        raise PipelineInvalidState(
            f"pipeline run epoch {run_epoch} is stale; current epoch is {job.run_epoch}"
        )
    step = await _locked_pipeline_stage(session, job, step_id)
    if step.attempt != attempt:
        raise PipelineInvalidState(
            f"Stage attempt {attempt} is stale; current attempt is {step.attempt}"
        )
    if step.status == "succeeded":
        await session.commit()
        await session.refresh(job)
        return job
    if step.status != "running":
        raise PipelineInvalidState(f"cannot complete a {step.status} Stage")
    execution = await session.scalar(
        select(AgentExecution)
        .where(AgentExecution.id == execution_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if (
        execution is None
        or execution.job_id != job.id
        or execution.step_id != step.id
        or execution.attempt != step.attempt
    ):
        raise PipelineInvalidState("Agent execution does not belong to this Stage attempt")
    if execution.status not in {"running", "succeeded"}:
        raise PipelineInvalidState(
            f"cannot complete Stage with Agent execution {execution.status}"
        )
    if execution.status == "succeeded":
        # A legacy/runtime recovery may have committed the Agent completion
        # before the Stage acknowledgement. Reuse its already-safe artifacts;
        # never run the Skill or append a second copy.
        existing_artifacts = list((await session.execute(
            select(ExecutionArtifact)
            .where(
                ExecutionArtifact.job_id == job.id,
                ExecutionArtifact.step_id == step.id,
                ExecutionArtifact.attempt == step.attempt,
                ExecutionArtifact.status == "active",
            )
            .order_by(ExecutionArtifact.id.asc())
        )).scalars().all())
        existing_primary = next(
            (artifact for artifact in existing_artifacts if artifact.role == "primary"),
            None,
        )
        if existing_primary is None:
            raise PipelineInvalidState(
                "Agent execution succeeded before a primary artifact was persisted"
            )
        auxiliary_ids = [
            artifact.id
            for artifact in existing_artifacts
            if artifact.role == "auxiliary"
        ]
        await succeed_locked_step(session, job, step, {
            "run_epoch": job.run_epoch,
            "attempt": step.attempt,
            "primary_artifact_id": existing_primary.id,
            "auxiliary_artifact_ids": auxiliary_ids,
        })
        keys = _pipeline_stage_keys(job)
        is_final = step.step_key == keys[-1]
        if is_final:
            job.status = "succeeded"
            job.completed_at = _now()
            session.add(ContentJobEvent(
                job_id=job.id,
                kind="job_succeeded",
                payload={"run_epoch": job.run_epoch, "recovered": True},
            ))
        else:
            job.status = "queued"
            job.completed_at = None
        session.add(ContentJobEvent(
            job_id=job.id,
            step_id=step.id,
            kind="pipeline_stage_succeeded",
            payload={
                "step_key": step.step_key,
                "attempt": step.attempt,
                "run_epoch": job.run_epoch,
                "primary_artifact_id": existing_primary.id,
                "recovered": True,
            },
        ))
        await session.commit()
        await session.refresh(job)
        return job
    if not isinstance(completion_evidence, dict):
        raise PipelineArtifactError("completion evidence must be an object")
    if len(auxiliary) > 24:
        raise PipelineArtifactError("too many auxiliary artifacts")

    normalized_primary = _validate_worker_artifact(primary, role="primary")
    normalized_auxiliary = [
        _validate_worker_artifact(item, role="auxiliary")
        for item in auxiliary
    ]
    from execution_artifacts import append_execution_artifact

    auxiliary_ids: list[int] = []
    for artifact in normalized_auxiliary:
        saved = await append_execution_artifact(
            session,
            job_id=job.id,
            step_id=step.id,
            attempt=step.attempt,
            kind=artifact["kind"],
            role="auxiliary",
            title=artifact["title"],
            text_content=artifact["text_content"],
            structured_content=artifact["structured_content"],
        )
        auxiliary_ids.append(saved.id)
    saved_primary = await append_execution_artifact(
        session,
        job_id=job.id,
        step_id=step.id,
        attempt=step.attempt,
        kind=normalized_primary["kind"],
        role="primary",
        title=normalized_primary["title"],
        text_content=normalized_primary["text_content"],
        structured_content=normalized_primary["structured_content"],
    )
    output_data = {
        "run_epoch": job.run_epoch,
        "attempt": step.attempt,
        "primary_artifact_id": saved_primary.id,
        "auxiliary_artifact_ids": auxiliary_ids,
    }
    await succeed_locked_step(session, job, step, output_data)
    execution.status = "succeeded"
    execution.phase = "complete"
    execution.completion_evidence = redact_log_value(completion_evidence)
    execution.error = ""
    execution.completed_at = _now()
    execution.updated_at = execution.completed_at
    session.add(AgentLogEvent(
        stream_kind="job",
        stream_key=f"execution:{execution.id}",
        job_id=job.id,
        execution_id=execution.id,
        event_type="execution/complete",
        phase="complete",
        status="completed",
        payload_data=redact_log_value(completion_evidence),
    ))
    keys = _pipeline_stage_keys(job)
    is_final = step.step_key == keys[-1]
    if is_final:
        job.status = "succeeded"
        job.completed_at = _now()
        session.add(ContentJobEvent(
            job_id=job.id,
            kind="job_succeeded",
            payload={"run_epoch": job.run_epoch},
        ))
    else:
        job.status = "queued"
        job.completed_at = None
    session.add(ContentJobEvent(
        job_id=job.id,
        step_id=step.id,
        kind="pipeline_stage_succeeded",
        payload={
            "step_key": step.step_key,
            "attempt": step.attempt,
            "run_epoch": job.run_epoch,
            "primary_artifact_id": saved_primary.id,
        },
    ))
    await session.commit()
    await session.refresh(job)
    return job


async def fail_pipeline_stage(
    session: AsyncSession,
    *,
    job_id: int,
    step_id: int,
    attempt: int,
    run_epoch: int,
    error: str,
    retryable: bool,
) -> ContentJob:
    job = await _locked_pipeline_job(session, job_id)
    if job.run_epoch != run_epoch:
        raise PipelineInvalidState(
            f"pipeline run epoch {run_epoch} is stale; current epoch is {job.run_epoch}"
        )
    step = await _locked_pipeline_stage(session, job, step_id)
    if step.attempt != attempt:
        raise PipelineInvalidState(
            f"Stage attempt {attempt} is stale; current attempt is {step.attempt}"
        )
    if step.status == "failed":
        await session.commit()
        await session.refresh(job)
        return job
    if step.status != "running":
        raise PipelineInvalidState(f"cannot fail a {step.status} Stage")
    await fail_locked_step(
        session,
        job,
        step,
        redact_secret_text(error)[:500],
        retryable=retryable,
    )
    await session.commit()
    await session.refresh(job)
    return job


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
