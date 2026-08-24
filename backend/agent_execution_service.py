"""Durable Agent checkpoints and idempotent tool-call transitions."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from agent_log_service import append_agent_log_event
from log_redaction import redact_log_value, redact_secret_text
from models import (
    AgentExecution,
    AgentMessageLog,
    AgentToolCall,
    ContentJob,
    ContentJobStep,
)


class AgentExecutionConflict(RuntimeError):
    pass


class AgentCapabilityDrift(RuntimeError):
    pass


@dataclass(frozen=True)
class ToolCallClaim:
    action: Literal["execute", "replay", "uncertain"]
    output: object | None = None
    error: str | None = None


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _normalized_capability_pin(value: dict) -> dict:
    normalized = dict(value)
    skill = normalized.get("skill")
    if isinstance(skill, dict):
        normalized["skill"] = {
            key: nested for key, nested in skill.items() if key != "activation"
        }
    return normalized


def _capability_pin_drift(expected: dict, candidate: dict) -> bool:
    expected_normalized = _normalized_capability_pin(expected)
    candidate_normalized = _normalized_capability_pin(candidate)
    expected_skill = expected_normalized.get("skill")
    candidate_skill = candidate_normalized.get("skill")
    expected_normalized["skill"] = _comparable_skill(expected_skill)
    candidate_normalized["skill"] = _comparable_skill(candidate_skill)
    if isinstance(expected_skill, dict) and isinstance(candidate_skill, dict):
        candidate_reference_items = candidate_skill.get("references", [])
        expected_reference_items = expected_skill.get("references", [])
        if not isinstance(candidate_reference_items, list):
            candidate_reference_items = []
        if not isinstance(expected_reference_items, list):
            expected_reference_items = []
        candidate_references = {
            item.get("path"): item
            for item in candidate_reference_items
            if isinstance(item, dict)
        }
        for expected_reference in expected_reference_items:
            if not isinstance(expected_reference, dict):
                continue
            expected_digest = expected_reference.get("contentDigest")
            current_reference = candidate_references.get(expected_reference.get("path"))
            current_digest = (
                current_reference.get("contentDigest")
                if isinstance(current_reference, dict) else None
            )
            if expected_digest and current_digest and expected_digest != current_digest:
                return True
    expected_tools = expected_normalized.pop("tools", None)
    candidate_tools = candidate_normalized.pop("tools", None)
    if expected_normalized != candidate_normalized:
        return True
    if not isinstance(expected_tools, list) or not isinstance(candidate_tools, list):
        return expected_tools != candidate_tools
    if len(expected_tools) != len(candidate_tools):
        return True
    metadata_keys = {"concurrencyPolicy", "idempotencyPolicy"}
    for expected_tool, candidate_tool in zip(expected_tools, candidate_tools):
        if not isinstance(expected_tool, dict) or not isinstance(candidate_tool, dict):
            if expected_tool != candidate_tool:
                return True
            continue
        expected_base = {
            key: value for key, value in expected_tool.items() if key not in metadata_keys
        }
        candidate_base = {
            key: value for key, value in candidate_tool.items() if key not in metadata_keys
        }
        if expected_base != candidate_base:
            return True
        if any(
            key in expected_tool and key in candidate_tool
            and expected_tool[key] != candidate_tool[key]
            for key in metadata_keys
        ):
            return True
    return False


def _comparable_skill(skill: object) -> object:
    if not isinstance(skill, dict):
        return skill
    reference_items = skill.get("references", [])
    if not isinstance(reference_items, list):
        reference_items = []
    return {
        key: value
        for key, value in skill.items()
        if key not in {"activation", "references"}
    } | {
        "references": [
            {
                "path": item.get("path"),
                "bytes": item.get("bytes"),
            }
            for item in reference_items
            if isinstance(item, dict)
        ],
    }


def _capability_pin_can_bootstrap_skill(expected: dict, candidate: dict) -> bool:
    if expected.get("skill") is not None or candidate.get("skill") is None:
        return False
    expected_without_skill = dict(expected)
    candidate_without_skill = dict(candidate)
    expected_without_skill["skill"] = None
    candidate_without_skill["skill"] = None
    return not _capability_pin_drift(expected_without_skill, candidate_without_skill)


async def ensure_agent_execution(
    session: AsyncSession,
    *,
    job_id: int,
    step_id: int | None = None,
    attempt: int = 1,
    objective: str,
    skill_mode: str,
    skill_name: str | None,
) -> AgentExecution:
    if attempt <= 0:
        raise ValueError("attempt must be positive")
    if await session.get(ContentJob, job_id) is None:
        raise KeyError(f"job {job_id} not found")
    if step_id is not None:
        step = await session.scalar(
            select(ContentJobStep)
            .where(ContentJobStep.id == step_id)
            .with_for_update()
        )
        if step is None:
            raise KeyError(f"job step {step_id} not found")
        if step.job_id != job_id:
            raise ValueError(f"step {step_id} belongs to job {step.job_id}")
        if step.attempt != attempt:
            raise ValueError(
                f"step {step_id} belongs to attempt {step.attempt}, not {attempt}"
            )

    identity = [AgentExecution.job_id == job_id]
    if step_id is None:
        identity.append(AgentExecution.step_id.is_(None))
    else:
        identity.extend([
            AgentExecution.step_id == step_id,
            AgentExecution.attempt == attempt,
        ])
    existing = await session.scalar(select(AgentExecution).where(*identity))
    if existing is not None:
        return existing
    execution = AgentExecution(
        job_id=job_id,
        step_id=step_id,
        attempt=attempt,
        status="running",
        objective=objective,
        skill_mode=skill_mode,
        skill_name=skill_name,
    )

    try:
        async with session.begin_nested():
            session.add(execution)
            await session.flush()
    except IntegrityError:
        winner = await session.scalar(select(AgentExecution).where(*identity))
        if winner is None:
            raise
        return winner

    await session.commit()
    await session.refresh(execution)
    await append_agent_log_event(
        session,
        stream_kind="job",
        stream_key=f"execution:{execution.id}",
        job_id=execution.job_id,
        execution_id=execution.id,
        event_type="execution/start",
        phase=execution.phase,
        status=execution.status,
        step_id=str(execution.step_id) if execution.step_id is not None else None,
        payload={
            "objective": execution.objective,
            "skill_mode": execution.skill_mode,
            "skill_name": execution.skill_name,
            "step_id": execution.step_id,
            "attempt": execution.attempt,
        },
    )
    return execution


def _newest_execution_order(statement):
    return statement.order_by(
        AgentExecution.updated_at.desc().nullslast(),
        AgentExecution.created_at.desc().nullslast(),
        AgentExecution.id.desc(),
    )


async def latest_agent_execution_for_job(
    session: AsyncSession,
    job_id: int,
) -> AgentExecution | None:
    return await session.scalar(_newest_execution_order(
        select(AgentExecution)
        .where(AgentExecution.job_id == job_id)
    ).limit(1))


async def latest_agent_executions_for_jobs(
    session: AsyncSession,
    job_ids: list[int] | set[int] | tuple[int, ...],
) -> dict[int, AgentExecution]:
    normalized_ids = sorted({job_id for job_id in job_ids if job_id > 0})
    if not normalized_ids:
        return {}
    rows = (await session.execute(
        _newest_execution_order(
            select(AgentExecution).where(AgentExecution.job_id.in_(normalized_ids))
        )
    )).scalars().all()
    latest: dict[int, AgentExecution] = {}
    for execution in rows:
        latest.setdefault(execution.job_id, execution)
    return latest


async def append_agent_message(
    session: AsyncSession,
    *,
    execution_id: int,
    phase: str,
    direction: str,
    payload: object,
) -> AgentMessageLog:
    execution = await session.get(AgentExecution, execution_id)
    if execution is None:
        raise KeyError(f"agent execution {execution_id} not found")
    message = AgentMessageLog(
        execution_id=execution_id,
        phase=phase,
        direction=direction,
        payload_data=redact_log_value(payload),
    )
    session.add(message)
    await session.commit()
    await session.refresh(message)
    event_type = {
        "model_request": "llm/request",
        "model_response": "llm/response",
        "model_error": "llm/error",
    }.get(direction, "llm/event")
    await append_agent_log_event(
        session,
        stream_kind="job",
        stream_key=f"execution:{execution.id}",
        job_id=execution.job_id,
        execution_id=execution.id,
        event_type=event_type,
        phase=phase,
        status="error" if direction == "model_error" else "completed",
        payload=payload,
    )
    return message


async def update_agent_checkpoint(
    session: AsyncSession,
    *,
    execution_id: int,
    expected_version: int,
    phase: str,
    checkpoint: dict,
    audit: dict,
    capability_pin: dict | None = None,
) -> AgentExecution:
    execution = await session.scalar(
        select(AgentExecution)
        .where(AgentExecution.id == execution_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if execution is None:
        raise KeyError(f"agent execution {execution_id} not found")
    if execution.version != expected_version:
        await session.rollback()
        if await session.get(AgentExecution, execution_id) is None:
            raise KeyError(f"agent execution {execution_id} not found")
        raise AgentExecutionConflict("agent execution checkpoint version conflict")
    pinned = execution.pinned_capability_snapshot
    next_pinned = pinned
    if capability_pin is not None:
        if pinned is not None and _capability_pin_drift(pinned, capability_pin):
            if _capability_pin_can_bootstrap_skill(pinned, capability_pin):
                next_pinned = capability_pin
            else:
                await session.rollback()
                if await session.get(AgentExecution, execution_id) is None:
                    raise KeyError(f"agent execution {execution_id} not found")
                raise AgentCapabilityDrift("agent capability pin drift detected")
        elif pinned is None:
            next_pinned = capability_pin
    statement = (
        update(AgentExecution)
        .where(
            AgentExecution.id == execution_id,
            AgentExecution.version == expected_version,
        )
        .values(
            phase=phase,
            checkpoint_data=checkpoint,
            audit_data=audit,
            pinned_capability_snapshot=next_pinned,
            version=expected_version + 1,
            updated_at=_now(),
        )
    )
    result = await session.execute(statement)
    if result.rowcount != 1:
        await session.rollback()
        if await session.get(AgentExecution, execution_id) is None:
            raise KeyError(f"agent execution {execution_id} not found")
        raise AgentExecutionConflict("agent execution checkpoint version conflict")
    await session.commit()
    execution = await session.get(AgentExecution, execution_id)
    assert execution is not None
    await append_agent_log_event(
        session,
        stream_kind="job",
        stream_key=f"execution:{execution.id}",
        job_id=execution.job_id,
        execution_id=execution.id,
        event_type="execution/checkpoint",
        phase=execution.phase,
        status="completed",
        payload={
            "checkpoint": execution.checkpoint_data,
            "audit": execution.audit_data,
            "capability_pin": execution.pinned_capability_snapshot,
            "version": execution.version,
        },
    )
    return execution


async def claim_agent_tool_call(
    session: AsyncSession,
    *,
    execution_id: int,
    tool_call_id: str,
    tool_name: str,
    input_summary: dict,
    auto_approved: bool,
    side_effecting: bool,
) -> ToolCallClaim:
    if await session.get(AgentExecution, execution_id) is None:
        raise KeyError(f"agent execution {execution_id} not found")
    call = await session.scalar(
        select(AgentToolCall).where(
            AgentToolCall.execution_id == execution_id,
            AgentToolCall.tool_call_id == tool_call_id,
        )
    )
    if call is not None:
        if call.tool_name != tool_name or call.input_summary != input_summary:
            return ToolCallClaim(
                "uncertain", error="tool call identity does not match prior evidence"
            )
        if call.status == "succeeded":
            return ToolCallClaim("replay", output=call.output_data)
        if call.status == "uncertain" or (
            call.status == "running" and call.side_effecting
        ):
            return ToolCallClaim(
                "uncertain", error="prior side-effecting tool outcome is unknown"
            )
        call.status = "running"
        call.error = ""
        call.completed_at = None
        call.updated_at = _now()
        await session.commit()
        return ToolCallClaim("execute")

    if side_effecting:
        prior_calls = (await session.execute(
            select(AgentToolCall).where(
                AgentToolCall.execution_id == execution_id,
                AgentToolCall.tool_name == tool_name,
                AgentToolCall.side_effecting.is_(True),
            ).order_by(AgentToolCall.id.desc())
        )).scalars().all()
        prior = next(
            (item for item in prior_calls if item.input_summary == input_summary),
            None,
        )
        if prior is not None:
            if prior.status == "succeeded":
                session.add(AgentToolCall(
                    execution_id=execution_id,
                    tool_call_id=tool_call_id,
                    tool_name=tool_name,
                    status="succeeded",
                    input_summary=input_summary,
                    output_data=prior.output_data,
                    auto_approved=auto_approved,
                    side_effecting=True,
                    completed_at=_now(),
                ))
                await session.commit()
                return ToolCallClaim("replay", output=prior.output_data)
            if prior.status in {"running", "uncertain"}:
                error = "prior equivalent side-effecting tool outcome is unknown"
                session.add(AgentToolCall(
                    execution_id=execution_id,
                    tool_call_id=tool_call_id,
                    tool_name=tool_name,
                    status="uncertain",
                    input_summary=input_summary,
                    error=error,
                    auto_approved=auto_approved,
                    side_effecting=True,
                    completed_at=_now(),
                ))
                await session.commit()
                return ToolCallClaim(
                    "uncertain",
                    error=error,
                )

    call = AgentToolCall(
        execution_id=execution_id,
        tool_call_id=tool_call_id,
        tool_name=tool_name,
        status="running",
        input_summary=input_summary,
        auto_approved=auto_approved,
        side_effecting=side_effecting,
    )
    session.add(call)
    await session.commit()
    return ToolCallClaim("execute")


async def complete_agent_tool_call(
    session: AsyncSession,
    execution_id: int,
    tool_call_id: str,
    output: object,
) -> AgentToolCall:
    call = await session.scalar(
        select(AgentToolCall).where(
            AgentToolCall.execution_id == execution_id,
            AgentToolCall.tool_call_id == tool_call_id,
        )
    )
    if call is None:
        raise KeyError(f"agent tool call {tool_call_id} not found")
    call.status = "succeeded"
    call.output_data = output
    call.error = ""
    call.completed_at = _now()
    await session.commit()
    await session.refresh(call)
    return call


async def fail_agent_tool_call(
    session: AsyncSession,
    execution_id: int,
    tool_call_id: str,
    error: str,
    uncertain: bool,
) -> AgentToolCall:
    call = await session.scalar(
        select(AgentToolCall).where(
            AgentToolCall.execution_id == execution_id,
            AgentToolCall.tool_call_id == tool_call_id,
        )
    )
    if call is None:
        raise KeyError(f"agent tool call {tool_call_id} not found")
    if call.status == "succeeded":
        return call
    call.status = "uncertain" if uncertain else "failed"
    call.error = error
    call.completed_at = _now()
    await session.commit()
    await session.refresh(call)
    return call


async def complete_agent_execution(
    session: AsyncSession,
    execution_id: int,
    completion_evidence: dict,
) -> AgentExecution:
    execution = await session.get(AgentExecution, execution_id)
    if execution is None:
        raise KeyError(f"agent execution {execution_id} not found")
    execution.status = "succeeded"
    execution.phase = "complete"
    execution.completion_evidence = completion_evidence
    execution.error = ""
    execution.completed_at = _now()
    execution.updated_at = _now()
    await session.commit()
    await session.refresh(execution)
    await append_agent_log_event(
        session,
        stream_kind="job",
        stream_key=f"execution:{execution.id}",
        job_id=execution.job_id,
        execution_id=execution.id,
        event_type="execution/complete",
        phase=execution.phase,
        status=execution.status,
        payload={"completion_evidence": completion_evidence},
    )
    return execution


async def fail_agent_execution(
    session: AsyncSession,
    execution_id: int,
    error: str,
) -> AgentExecution:
    execution = await session.get(AgentExecution, execution_id)
    if execution is None:
        raise KeyError(f"agent execution {execution_id} not found")
    if execution.status in {"succeeded", "failed", "cancelled"}:
        return execution
    execution.status = "failed"
    execution.phase = "failed"
    execution.error = redact_secret_text(str(error))[:2_000]
    execution.updated_at = _now()
    execution.completed_at = execution.updated_at
    await session.commit()
    await session.refresh(execution)
    await append_agent_log_event(
        session,
        stream_kind="job",
        stream_key=f"execution:{execution.id}",
        job_id=execution.job_id,
        execution_id=execution.id,
        event_type="execution/error",
        phase=execution.phase,
        status=execution.status,
        payload={"error": execution.error},
    )
    return execution
