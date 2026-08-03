"""Durable Agent checkpoints and idempotent tool-call transitions."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from models import AgentExecution, AgentToolCall, ContentJob


class AgentExecutionConflict(RuntimeError):
    pass


@dataclass(frozen=True)
class ToolCallClaim:
    action: Literal["execute", "replay", "uncertain"]
    output: object | None = None
    error: str | None = None


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def ensure_agent_execution(
    session: AsyncSession,
    *,
    job_id: int,
    objective: str,
    skill_mode: str,
    skill_name: str | None,
) -> AgentExecution:
    existing = await session.scalar(
        select(AgentExecution).where(AgentExecution.job_id == job_id)
    )
    if existing is not None:
        return existing
    if await session.get(ContentJob, job_id) is None:
        raise KeyError(f"job {job_id} not found")
    execution = AgentExecution(
        job_id=job_id,
        status="running",
        objective=objective,
        skill_mode=skill_mode,
        skill_name=skill_name,
    )
    session.add(execution)
    await session.commit()
    await session.refresh(execution)
    return execution


async def update_agent_checkpoint(
    session: AsyncSession,
    *,
    execution_id: int,
    expected_version: int,
    phase: str,
    checkpoint: dict,
    audit: dict,
) -> AgentExecution:
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
    return execution
