"""Worker-only API for durable Agent execution checkpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from agent_execution_service import (
    AgentExecutionConflict,
    claim_agent_tool_call,
    complete_agent_execution,
    complete_agent_tool_call,
    ensure_agent_execution,
    fail_agent_tool_call,
    update_agent_checkpoint,
)
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
    objective: str = Field(min_length=1, max_length=20_000)
    skill_mode: str = Field(pattern="^(auto|manual)$")
    skill_name: str | None = Field(default=None, max_length=200)


class CheckpointUpdate(BaseModel):
    expected_version: int = Field(gt=0)
    phase: str = Field(min_length=1, max_length=64)
    checkpoint: dict = Field(default_factory=dict)
    audit: dict = Field(default_factory=dict)


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


class ExecutionCompleteRequest(BaseModel):
    completion_evidence: dict


def _execution_payload(execution: AgentExecution) -> dict:
    return {
        "id": execution.id,
        "job_id": execution.job_id,
        "status": execution.status,
        "objective": execution.objective,
        "skill_mode": execution.skill_mode,
        "skill_name": execution.skill_name,
        "skill_activation": execution.skill_activation,
        "phase": execution.phase,
        "checkpoint": execution.checkpoint_data,
        "audit": execution.audit_data,
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
            objective=body.objective,
            skill_mode=body.skill_mode,
            skill_name=body.skill_name,
        )
    except KeyError as error:
        raise HTTPException(404, str(error)) from None
    return _execution_payload(execution)


@router.get("/by-job/{job_id}")
async def get_execution_by_job(
    job_id: int,
    db: AsyncSession = Depends(get_db),
):
    execution = await db.scalar(
        select(AgentExecution).where(AgentExecution.job_id == job_id)
    )
    if execution is None:
        raise HTTPException(404, "agent execution not found")
    return _execution_payload(execution)


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
        )
    except KeyError as error:
        raise HTTPException(404, str(error)) from None
    except AgentExecutionConflict as error:
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
