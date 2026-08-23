"""Worker-only API for durable Agent execution checkpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from typing import Literal
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from agent_execution_service import (
    AgentExecutionConflict,
    AgentCapabilityDrift,
    append_agent_message,
    claim_agent_tool_call,
    complete_agent_execution,
    complete_agent_tool_call,
    ensure_agent_execution,
    fail_agent_execution,
    fail_agent_tool_call,
    latest_agent_execution_for_job,
    update_agent_checkpoint,
)
from agent_log_service import append_agent_log_event
from database import get_db
from models import AgentExecution, AgentToolCall
from worker_auth import require_worker_token


router = APIRouter(
    prefix="/agent-executions",
    tags=["agent-executions"],
    dependencies=[Depends(require_worker_token)],
)


class ExecutionCreate(BaseModel):
    job_id: int = Field(gt=0)
    step_id: int | None = Field(default=None, gt=0)
    attempt: int = Field(default=1, gt=0)
    objective: str = Field(min_length=1, max_length=20_000)
    skill_mode: str = Field(pattern="^(auto|manual)$")
    skill_name: str | None = Field(default=None, max_length=200)


class CheckpointUpdate(BaseModel):
    expected_version: int = Field(gt=0)
    phase: str = Field(min_length=1, max_length=64)
    checkpoint: dict = Field(default_factory=dict)
    audit: dict = Field(default_factory=dict)
    capability_pin: dict | None = None


class ToolCallClaimRequest(BaseModel):
    tool_name: str = Field(min_length=1, max_length=200)
    input_summary: dict = Field(default_factory=dict)
    auto_approved: bool = False
    side_effecting: bool = False


class ToolCallSuccessRequest(BaseModel):
    output: object


class ToolCallFailureRequest(BaseModel):
    error: str = Field(min_length=1, max_length=2_000)
    uncertain: bool = False


class MessageLogRequest(BaseModel):
    phase: str = Field(min_length=1, max_length=64)
    direction: Literal["model_request", "model_response", "model_error"]
    payload: object


class ExecutionCompleteRequest(BaseModel):
    completion_evidence: dict


class ExecutionFailureRequest(BaseModel):
    error: str = Field(min_length=1, max_length=2_000)


def _execution_payload(execution: AgentExecution) -> dict:
    return {
        "id": execution.id,
        "job_id": execution.job_id,
        "step_id": execution.step_id,
        "attempt": execution.attempt,
        "status": execution.status,
        "objective": execution.objective,
        "skill_mode": execution.skill_mode,
        "skill_name": execution.skill_name,
        "skill_activation": execution.skill_activation,
        "phase": execution.phase,
        "checkpoint": execution.checkpoint_data,
        "audit": execution.audit_data,
        "capability_pin": execution.pinned_capability_snapshot,
        "completion_evidence": execution.completion_evidence,
        "final_summary": execution.final_summary,
        "version": execution.version,
        "error": execution.error,
        "created_at": execution.created_at,
        "updated_at": execution.updated_at,
        "completed_at": execution.completed_at,
    }


def _tool_call_payload(call: AgentToolCall) -> dict:
    return {
        "id": call.id,
        "execution_id": call.execution_id,
        "tool_call_id": call.tool_call_id,
        "tool_name": call.tool_name,
        "status": call.status,
        "auto_approved": call.auto_approved,
        "side_effecting": call.side_effecting,
        "input_summary": call.input_summary,
        "output": call.output_data,
        "error": call.error,
        "started_at": call.started_at,
        "completed_at": call.completed_at,
    }


@router.post("", status_code=status.HTTP_201_CREATED)
async def post_execution(
    body: ExecutionCreate,
    db: AsyncSession = Depends(get_db),
):
    try:
        execution = await ensure_agent_execution(
            db,
            job_id=body.job_id,
            step_id=body.step_id,
            attempt=body.attempt,
            objective=body.objective,
            skill_mode=body.skill_mode,
            skill_name=body.skill_name,
        )
    except KeyError as error:
        raise HTTPException(404, str(error)) from None
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
    return _execution_payload(execution)


@router.get("/by-job/{job_id}")
async def get_execution_by_job(
    job_id: int,
    db: AsyncSession = Depends(get_db),
):
    execution = await latest_agent_execution_for_job(db, job_id)
    if execution is None:
        raise HTTPException(404, "agent execution not found")
    return _execution_payload(execution)


@router.get("/{execution_id}/tool-calls")
async def get_execution_tool_calls(
    execution_id: int,
    db: AsyncSession = Depends(get_db),
):
    if await db.get(AgentExecution, execution_id) is None:
        raise HTTPException(404, "agent execution not found")
    calls = (await db.execute(
        select(AgentToolCall).where(
            AgentToolCall.execution_id == execution_id
        ).order_by(AgentToolCall.id)
    )).scalars().all()
    return [_tool_call_payload(call) for call in calls]


@router.post("/{execution_id}/messages", status_code=status.HTTP_201_CREATED)
async def post_execution_message(
    execution_id: int,
    body: MessageLogRequest,
    db: AsyncSession = Depends(get_db),
):
    try:
        message = await append_agent_message(
            db,
            execution_id=execution_id,
            phase=body.phase,
            direction=body.direction,
            payload=body.payload,
        )
    except KeyError as error:
        raise HTTPException(404, str(error)) from None
    return {
        "id": message.id,
        "execution_id": message.execution_id,
        "phase": message.phase,
        "direction": message.direction,
        "payload": message.payload_data,
        "created_at": message.created_at,
    }


@router.patch("/{execution_id}/checkpoint")
async def patch_checkpoint(
    execution_id: int,
    body: CheckpointUpdate,
    db: AsyncSession = Depends(get_db),
):
    try:
        execution = await update_agent_checkpoint(
            db,
            execution_id=execution_id,
            expected_version=body.expected_version,
            phase=body.phase,
            checkpoint=body.checkpoint,
            audit=body.audit,
            capability_pin=body.capability_pin,
        )
    except KeyError as error:
        raise HTTPException(404, str(error)) from None
    except AgentExecutionConflict as error:
        raise HTTPException(409, str(error)) from error
    except AgentCapabilityDrift as error:
        raise HTTPException(409, str(error)) from error
    return _execution_payload(execution)


@router.post("/{execution_id}/tool-calls/{tool_call_id}/claim")
async def post_tool_call_claim(
    execution_id: int,
    tool_call_id: str,
    body: ToolCallClaimRequest,
    db: AsyncSession = Depends(get_db),
):
    try:
        claim = await claim_agent_tool_call(
            db,
            execution_id=execution_id,
            tool_call_id=tool_call_id,
            tool_name=body.tool_name,
            input_summary=body.input_summary,
            auto_approved=body.auto_approved,
            side_effecting=body.side_effecting,
        )
    except KeyError as error:
        raise HTTPException(404, str(error)) from None
    execution = await db.get(AgentExecution, execution_id)
    if execution is not None:
        await append_agent_log_event(
            db,
            stream_kind="job",
            stream_key=f"execution:{execution.id}",
            job_id=execution.job_id,
            execution_id=execution.id,
            event_type="tool/call",
            phase=execution.phase,
            status={"execute": "running", "replay": "completed", "uncertain": "error"}[claim.action],
            payload={
                "tool_call_id": tool_call_id,
                "tool_name": body.tool_name,
                "input_summary": body.input_summary,
                "auto_approved": body.auto_approved,
                "side_effecting": body.side_effecting,
                "claim_action": claim.action,
                "error": claim.error,
            },
        )
    return {
        "action": claim.action,
        "output": claim.output,
        "error": claim.error,
    }


@router.post("/{execution_id}/tool-calls/{tool_call_id}/succeed")
async def post_tool_call_success(
    execution_id: int,
    tool_call_id: str,
    body: ToolCallSuccessRequest,
    db: AsyncSession = Depends(get_db),
):
    try:
        call = await complete_agent_tool_call(
            db, execution_id, tool_call_id, body.output
        )
    except KeyError as error:
        raise HTTPException(404, str(error)) from None
    execution = await db.get(AgentExecution, execution_id)
    if execution is not None:
        await append_agent_log_event(
            db,
            stream_kind="job",
            stream_key=f"execution:{execution.id}",
            job_id=execution.job_id,
            execution_id=execution.id,
            event_type="tool/result",
            phase=execution.phase,
            status=call.status,
            payload={
                "tool_call_id": call.tool_call_id,
                "tool_name": call.tool_name,
                "input_summary": call.input_summary,
                "output": call.output_data,
                "error": call.error,
            },
        )
    return _tool_call_payload(call)


@router.post("/{execution_id}/tool-calls/{tool_call_id}/fail")
async def post_tool_call_failure(
    execution_id: int,
    tool_call_id: str,
    body: ToolCallFailureRequest,
    db: AsyncSession = Depends(get_db),
):
    try:
        call = await fail_agent_tool_call(
            db, execution_id, tool_call_id, body.error, body.uncertain
        )
    except KeyError as error:
        raise HTTPException(404, str(error)) from None
    execution = await db.get(AgentExecution, execution_id)
    if execution is not None:
        await append_agent_log_event(
            db,
            stream_kind="job",
            stream_key=f"execution:{execution.id}",
            job_id=execution.job_id,
            execution_id=execution.id,
            event_type="tool/result",
            phase=execution.phase,
            status=call.status,
            payload={
                "tool_call_id": call.tool_call_id,
                "tool_name": call.tool_name,
                "input_summary": call.input_summary,
                "output": call.output_data,
                "error": call.error,
                "uncertain": body.uncertain,
            },
        )
    return _tool_call_payload(call)


@router.post("/{execution_id}/complete")
async def post_execution_complete(
    execution_id: int,
    body: ExecutionCompleteRequest,
    db: AsyncSession = Depends(get_db),
):
    try:
        execution = await complete_agent_execution(
            db, execution_id, body.completion_evidence
        )
    except KeyError as error:
        raise HTTPException(404, str(error)) from None
    return _execution_payload(execution)


@router.post("/{execution_id}/fail")
async def post_execution_failure(
    execution_id: int,
    body: ExecutionFailureRequest,
    db: AsyncSession = Depends(get_db),
):
    try:
        execution = await fail_agent_execution(db, execution_id, body.error)
    except KeyError as error:
        raise HTTPException(404, str(error)) from None
    return _execution_payload(execution)
