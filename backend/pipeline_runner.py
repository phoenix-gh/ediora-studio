"""Durable, one-Stage-at-a-time execution for Skill Pipeline Jobs."""

from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Protocol

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from agent_execution_service import (
    complete_agent_execution,
    ensure_agent_execution,
    fail_agent_execution,
    update_agent_checkpoint,
)
from agent_log_service import append_agent_log_event
from content_jobs import (
    fail_locked_step,
    lock_content_job_row,
    succeed_job,
    succeed_locked_step,
)
from database import SessionLocal
from execution_artifacts import append_execution_artifact
from job_queue import enqueue_job
from log_redaction import redact_secret_text
from models import (
    AgentExecution,
    ContentJob,
    ContentJobEvent,
    ContentJobStep,
    ExecutionArtifact,
)


class PipelineRuntimeNotConfigured(RuntimeError):
    """Raised until the production Skill runtime adapter is installed."""


class PipelineRetryableError(RuntimeError):
    """A transient executor failure that can be retried explicitly."""


class PipelineUncertainError(RuntimeError):
    """A side effect may have happened and must not be retried automatically."""


class PipelineOutputError(ValueError):
    """Raised when an executor returns an unsafe or unusable artifact."""


class PipelineRunnerState(RuntimeError):
    """Raised when durable Stage state cannot be reconciled safely."""


@dataclass(frozen=True)
class PipelineAuxiliaryResult:
    kind: str
    title: str
    text_content: str | None = None
    structured_content: object | None = None


@dataclass(frozen=True)
class PipelineStageResult:
    primary_kind: str
    primary_title: str
    primary_text: str | None = None
    primary_structured: object | None = None
    auxiliary: tuple[PipelineAuxiliaryResult, ...] = ()


class PipelineStageExecutor(Protocol):
    async def execute(
        self,
        session: AsyncSession,
        job: ContentJob,
        step: ContentJobStep,
        execution: AgentExecution,
    ) -> PipelineStageResult:
        """Execute one frozen Stage and return append-only artifacts."""


class FailClosedPipelineExecutor:
    """Safe default: orchestration is observable but cannot invent content."""

    async def execute(
        self,
        _session: AsyncSession,
        _job: ContentJob,
        _step: ContentJobStep,
        _execution: AgentExecution,
    ) -> PipelineStageResult:
        raise PipelineRuntimeNotConfigured(
            "Skill Pipeline runtime adapter is not configured"
        )


_SECRET_KEYS = frozenset({
    "apikey",
    "apisecret",
    "accesstoken",
    "refreshtoken",
    "clientsecret",
    "authorization",
    "cookie",
    "sessioncookie",
    "password",
    "secret",
})


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _normalized_key(key: object) -> str:
    if not isinstance(key, str):
        return ""
    return "".join(character for character in key.casefold() if character.isalnum())


def _contains_credentials(value: object) -> bool:
    if isinstance(value, dict):
        for key, nested in value.items():
            if _normalized_key(key) in _SECRET_KEYS:
                return True
            if _contains_credentials(nested):
                return True
        return False
    if isinstance(value, (list, tuple, set, frozenset)):
        return any(_contains_credentials(item) for item in value)
    return False


def _validate_artifact(
    *,
    label: str,
    kind: str,
    title: str,
    text_content: str | None,
    structured_content: object | None,
) -> None:
    if not isinstance(kind, str) or not kind.strip():
        raise PipelineOutputError(f"{label} kind must not be blank")
    if not isinstance(title, str) or not title.strip():
        raise PipelineOutputError(f"{label} title must not be blank")
    if text_content is not None and not isinstance(text_content, str):
        raise PipelineOutputError(f"{label} text must be a string or null")
    if not (text_content and text_content.strip()) and structured_content is None:
        raise PipelineOutputError(f"{label} must contain text or structured content")
    if _contains_credentials(structured_content):
        raise PipelineOutputError(f"{label} contains credential fields")
    if text_content and redact_secret_text(text_content) != text_content:
        raise PipelineOutputError(f"{label} contains a known secret pattern")
    try:
        json.dumps(
            structured_content,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
    except (TypeError, ValueError, OverflowError) as error:
        raise PipelineOutputError(f"{label} structured content is not JSON serializable") from error


def _validate_result(result: PipelineStageResult) -> None:
    if not isinstance(result, PipelineStageResult):
        raise PipelineOutputError("executor must return PipelineStageResult")
    _validate_artifact(
        label="primary artifact",
        kind=result.primary_kind,
        title=result.primary_title,
        text_content=result.primary_text,
        structured_content=result.primary_structured,
    )
    for index, auxiliary in enumerate(result.auxiliary):
        if not isinstance(auxiliary, PipelineAuxiliaryResult):
            raise PipelineOutputError(f"auxiliary artifact {index} has an invalid type")
        _validate_artifact(
            label=f"auxiliary artifact {index}",
            kind=auxiliary.kind,
            title=auxiliary.title,
            text_content=auxiliary.text_content,
            structured_content=auxiliary.structured_content,
        )


def _plan_stage_keys(job: ContentJob) -> list[str]:
    pipeline = (job.input_data or {}).get("pipeline")
    plan = pipeline.get("plan") if isinstance(pipeline, dict) else None
    stages = plan.get("stages") if isinstance(plan, dict) else None
    if not isinstance(stages, list) or not stages:
        raise PipelineRunnerState("pipeline plan has no stages")
    keys = [stage.get("step_key") for stage in stages if isinstance(stage, dict)]
    if not keys or any(not isinstance(key, str) or not key for key in keys):
        raise PipelineRunnerState("pipeline plan contains an invalid Stage key")
    return keys


def _current_stage_rows(
    rows: Sequence[ContentJobStep],
    *,
    run_epoch: int,
) -> dict[str, ContentJobStep]:
    del run_epoch
    latest: dict[str, ContentJobStep] = {}
    for row in rows:
        if row.step_key == "pipeline_plan":
            continue
        if row.status == "superseded":
            continue
        previous = latest.get(row.step_key)
        if previous is None or row.id > previous.id:
            latest[row.step_key] = row
    return latest


async def _locked_pipeline_steps(
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


async def _select_next_stage(
    session: AsyncSession,
    job: ContentJob,
) -> tuple[ContentJobStep | None, int | None, list[str]]:
    keys = _plan_stage_keys(job)
    rows = await _locked_pipeline_steps(session, job.id)
    current = _current_stage_rows(rows, run_epoch=job.run_epoch)
    for index, key in enumerate(keys):
        row = current.get(key)
        if row is None:
            raise PipelineRunnerState(f"Stage {key} is missing for run epoch {job.run_epoch}")
        if row.status in {"queued", "running"}:
            return row, index, keys
        if row.status == "failed":
            return None, None, keys
        if row.status != "succeeded":
            raise PipelineRunnerState(f"Stage {key} is in unsupported state {row.status}")
    return None, len(keys), keys


async def _append_job_event(
    session: AsyncSession,
    job_id: int,
    kind: str,
    *,
    step_id: int | None = None,
    payload: dict[str, Any] | None = None,
) -> None:
    session.add(ContentJobEvent(
        job_id=job_id,
        step_id=step_id,
        kind=kind,
        payload=payload or {},
    ))


async def _start_stage(
    session: AsyncSession,
    job: ContentJob,
    step: ContentJobStep,
) -> ContentJobStep:
    if step.status == "queued":
        now = _now()
        step.status = "running"
        step.started_at = step.started_at or now
        job.status = "running"
        job.started_at = job.started_at or now
        await _append_job_event(
            session,
            job.id,
            "step_started",
            step_id=step.id,
            payload={"step_key": step.step_key, "attempt": step.attempt},
        )
        await session.commit()
        await session.refresh(step)
        await session.refresh(job)
    elif step.status == "running" and job.status != "running":
        job.status = "running"
        await session.commit()
        await session.refresh(job)
    return step


def _latest_current_stage(
    rows: Sequence[ContentJobStep],
    step_key: str,
    run_epoch: int,
) -> ContentJobStep | None:
    del run_epoch
    candidates = [
        row for row in rows
        if row.step_key == step_key
        and row.status != "superseded"
    ]
    return max(candidates, key=lambda row: row.id, default=None)


async def _previous_primary(
    session: AsyncSession,
    job: ContentJob,
    step: ContentJobStep,
    stage_index: int,
    stage_keys: Sequence[str],
) -> int | None:
    if stage_index == 0:
        return None
    rows = await _locked_pipeline_steps(session, job.id)
    previous_candidates = [
        row for row in rows
        if row.step_key == stage_keys[stage_index - 1]
        and row.status == "succeeded"
    ]
    artifact = None
    for previous in sorted(previous_candidates, key=lambda row: row.id, reverse=True):
        artifact = await session.scalar(
            select(ExecutionArtifact)
            .where(
                ExecutionArtifact.job_id == job.id,
                ExecutionArtifact.step_id == previous.id,
                ExecutionArtifact.attempt == previous.attempt,
                ExecutionArtifact.role == "primary",
                ExecutionArtifact.status == "active",
            )
            .order_by(ExecutionArtifact.id.desc())
            .limit(1)
        )
        if artifact is not None:
            break
    if artifact is None:
        raise PipelineRunnerState(
            f"previous Stage {stage_keys[stage_index - 1]} has no active primary artifact"
        )
    input_data = deepcopy(step.input_data)
    input_data["previous_primary_artifact_id"] = artifact.id
    step.input_data = input_data
    await session.commit()
    await session.refresh(step)
    return artifact.id


def _execution_parameters(step: ContentJobStep) -> tuple[str, str | None, dict]:
    invocation = step.input_data.get("invocation") if isinstance(step.input_data, dict) else None
    if not isinstance(invocation, dict):
        raise PipelineRunnerState(f"Stage {step.step_key} invocation is missing")
    skill_name = invocation.get("skill_name")
    if not isinstance(skill_name, str) or not skill_name:
        raise PipelineRunnerState(f"Stage {step.step_key} skill name is missing")
    capability = invocation.get("capability_snapshot")
    if not isinstance(capability, dict):
        raise PipelineRunnerState(f"Stage {step.step_key} capability snapshot is missing")
    mode = capability.get("mode")
    if not isinstance(mode, str) or not mode:
        mode = "job"
    return mode, skill_name, capability


async def _prepare_execution(
    session: AsyncSession,
    job: ContentJob,
    step: ContentJobStep,
) -> AgentExecution:
    skill_mode, skill_name, capability = _execution_parameters(step)
    execution = await ensure_agent_execution(
        session,
        job_id=job.id,
        step_id=step.id,
        attempt=step.attempt,
        objective=str(step.input_data.get("objective") or job.input_data.get("objective") or ""),
        skill_mode=skill_mode,
        skill_name=skill_name,
    )
    if execution.status == "succeeded":
        return execution
    if execution.status in {"failed", "cancelled", "uncertain"}:
        raise PipelineRunnerState(
            f"Stage execution {execution.id} is already {execution.status}"
        )
    updated = await update_agent_checkpoint(
        session,
        execution_id=execution.id,
        expected_version=execution.version,
        phase="prepared",
        checkpoint={
            "stage_key": step.step_key,
            "attempt": step.attempt,
            "run_epoch": job.run_epoch,
        },
        audit={"capability_snapshot": capability},
        capability_pin=capability,
    )
    await append_agent_log_event(
        session,
        stream_kind="job",
        stream_key=f"execution:{updated.id}",
        job_id=job.id,
        execution_id=updated.id,
        event_type="pipeline/stage-running",
        phase="execute",
        status="running",
        step_id=str(step.id),
        payload={"step_key": step.step_key, "attempt": step.attempt},
    )
    return updated


async def _fail_stage(
    session: AsyncSession,
    *,
    job_id: int,
    step_id: int,
    error: str,
    retryable: bool,
) -> None:
    job = await lock_content_job_row(session, job_id)
    if job is None:
        return
    step = await session.scalar(
        select(ContentJobStep)
        .where(ContentJobStep.id == step_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if step is None or step.job_id != job_id:
        return
    if job.status == "cancelled":
        if step.status in {"queued", "running"}:
            step.status = "cancelled"
            step.completed_at = _now()
            await session.commit()
        return
    if step.status == "running":
        await fail_locked_step(
            session,
            job,
            step,
            redact_secret_text(error),
            retryable=retryable,
        )
    elif step.status == "queued":
        step.status = "failed"
        step.error = redact_secret_text(error)[:500]
        step.retryable = retryable
        step.completed_at = _now()
        job.status = "failed"
        job.completed_at = step.completed_at
        await _append_job_event(
            session,
            job.id,
            "step_failed",
            step_id=step.id,
            payload={"step_key": step.step_key, "retryable": retryable},
        )
    await session.commit()


async def _persist_success(
    session: AsyncSession,
    *,
    job_id: int,
    step_id: int,
    execution_id: int,
    stage_index: int,
    stage_count: int,
    result: PipelineStageResult,
    existing_artifact_ids: tuple[int, list[int]] | None = None,
    complete_execution: bool = True,
) -> None:
    job = await lock_content_job_row(session, job_id)
    if job is None:
        return
    step = await session.scalar(
        select(ContentJobStep)
        .where(ContentJobStep.id == step_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if step is None or step.job_id != job_id:
        return
    if job.status == "cancelled" or step.status == "cancelled":
        return
    if step.status == "succeeded":
        return
    if step.status != "running":
        raise PipelineRunnerState(f"cannot complete {step.status} Stage")

    if existing_artifact_ids is None:
        auxiliary_ids: list[int] = []
        for auxiliary in result.auxiliary:
            artifact = await append_execution_artifact(
                session,
                job_id=job_id,
                step_id=step.id,
                attempt=step.attempt,
                kind=auxiliary.kind,
                role="auxiliary",
                title=auxiliary.title,
                text_content=auxiliary.text_content,
                structured_content=auxiliary.structured_content,
            )
            auxiliary_ids.append(artifact.id)
        primary = await append_execution_artifact(
            session,
            job_id=job_id,
            step_id=step.id,
            attempt=step.attempt,
            kind=result.primary_kind,
            role="primary",
            title=result.primary_title,
            text_content=result.primary_text,
            structured_content=result.primary_structured,
        )
        primary_id = primary.id
    else:
        primary_id, auxiliary_ids = existing_artifact_ids
    output_data = {
        "run_epoch": job.run_epoch,
        "attempt": step.attempt,
        "primary_artifact_id": primary_id,
        "auxiliary_artifact_ids": auxiliary_ids,
    }
    await succeed_locked_step(session, job, step, output_data)
    is_last = stage_index == stage_count - 1
    if not is_last:
        job.status = "queued"
        job.completed_at = None
    await session.commit()

    if complete_execution:
        await complete_agent_execution(
            session,
            execution_id,
            {
                "primary_artifact_id": primary_id,
                "auxiliary_artifact_ids": auxiliary_ids,
                "stage_key": step.step_key,
                "attempt": step.attempt,
            },
        )
    if is_last:
        await succeed_job(session, job_id)
    else:
        try:
            await enqueue_job(job_id, flow="skill_pipeline")
        except Exception:
            # The Job remains durably queued; reconciliation can enqueue it again.
            return


async def _safe_execution_failure(
    session: AsyncSession,
    execution: AgentExecution | None,
    error: BaseException,
) -> None:
    if execution is None:
        return
    try:
        await fail_agent_execution(session, execution.id, str(error))
    except Exception:
        await session.rollback()


async def run_skill_pipeline_job(
    job_id: int,
    *,
    session_factory: Callable = SessionLocal,
    executor: PipelineStageExecutor | None = None,
) -> None:
    """Run at most one Stage and requeue the Job when another Stage remains."""
    stage_executor = executor or FailClosedPipelineExecutor()
    execution: AgentExecution | None = None
    async with session_factory() as session:
        job = await lock_content_job_row(session, job_id)
        if job is None or job.flow != "skill_pipeline":
            await session.rollback()
            return
        if job.status in {"cancelled", "succeeded", "awaiting_confirmation"}:
            await session.rollback()
            return
        try:
            step, stage_index, stage_keys = await _select_next_stage(session, job)
            if step is None:
                if stage_index == len(stage_keys) and job.status == "running":
                    await session.commit()
                    await succeed_job(session, job.id)
                else:
                    await session.rollback()
                return
            assert stage_index is not None
            step = await _start_stage(session, job, step)
            try:
                await _previous_primary(
                    session,
                    job,
                    step,
                    stage_index,
                    stage_keys,
                )
                execution = await _prepare_execution(session, job, step)
                if execution.status == "succeeded":
                    primary = await session.scalar(
                        select(ExecutionArtifact).where(
                            ExecutionArtifact.job_id == job.id,
                            ExecutionArtifact.step_id == step.id,
                            ExecutionArtifact.attempt == step.attempt,
                            ExecutionArtifact.role == "primary",
                            ExecutionArtifact.status == "active",
                        ).limit(1)
                    )
                    if primary is None:
                        raise PipelineUncertainError(
                            "completed AgentExecution has no active primary artifact"
                        )
                    auxiliary = list((await session.execute(
                        select(ExecutionArtifact.id)
                        .where(
                            ExecutionArtifact.job_id == job.id,
                            ExecutionArtifact.step_id == step.id,
                            ExecutionArtifact.attempt == step.attempt,
                            ExecutionArtifact.role == "auxiliary",
                            ExecutionArtifact.status == "active",
                        )
                        .order_by(ExecutionArtifact.id.asc())
                    )).scalars().all())
                    await _persist_success(
                        session,
                        job_id=job.id,
                        step_id=step.id,
                        execution_id=execution.id,
                        stage_index=stage_index,
                        stage_count=len(stage_keys),
                        result=PipelineStageResult(
                            primary_kind=primary.kind,
                            primary_title=primary.title,
                            primary_text=primary.text_content,
                            primary_structured=primary.structured_content,
                        ),
                        existing_artifact_ids=(primary.id, auxiliary),
                        complete_execution=False,
                    )
                else:
                    result = await stage_executor.execute(session, job, step, execution)
                    _validate_result(result)
                    await _persist_success(
                        session,
                        job_id=job.id,
                        step_id=step.id,
                        execution_id=execution.id,
                        stage_index=stage_index,
                        stage_count=len(stage_keys),
                        result=result,
                    )
            except (PipelineRetryableError, PipelineUncertainError, PipelineOutputError) as error:
                await _safe_execution_failure(session, execution, error)
                await _fail_stage(
                    session,
                    job_id=job.id,
                    step_id=step.id,
                    error=str(error),
                    retryable=isinstance(error, PipelineRetryableError),
                )
            except Exception as error:
                await _safe_execution_failure(session, execution, error)
                await _fail_stage(
                    session,
                    job_id=job.id,
                    step_id=step.id,
                    error=str(error),
                    retryable=False,
                )
        except Exception as error:
            await session.rollback()
            if 'step' in locals() and isinstance(step, ContentJobStep):
                await _fail_stage(
                    session,
                    job_id=job_id,
                    step_id=step.id,
                    error=str(error),
                    retryable=False,
                )
