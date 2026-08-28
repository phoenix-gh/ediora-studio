"""Transactional state machine for durable interactive Chat Runs."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models import ChatRun, ChatRunStep, ChatRunToolCall


class ChatRunNotFound(KeyError):
    pass


class ChatRunConflict(RuntimeError):
    pass


class ChatRunInvalidState(RuntimeError):
    pass


class ChatRunNeedsReconciliation(RuntimeError):
    pass


@dataclass(frozen=True)
class ChatRunCheckpoint:
    run: ChatRun
    steps: list[ChatRunStep]
    tool_calls: list[ChatRunToolCall]


@dataclass(frozen=True)
class ApprovalDecisionResult:
    run_id: str
    tool_call_id: str
    decision: Literal["approved", "rejected"]
    duplicate: bool
    run_status: str
    checkpoint_version: int


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def _locked_run(db: AsyncSession, run_id: str) -> ChatRun:
    run = await db.scalar(
        select(ChatRun).where(ChatRun.id == run_id).with_for_update()
    )
    if run is None:
        raise ChatRunNotFound(run_id)
    return run


def _check_version(run: ChatRun, expected_version: int) -> None:
    if run.checkpoint_version != expected_version:
        raise ChatRunConflict(
            f"chat run version conflict: expected {expected_version}, "
            f"current {run.checkpoint_version}"
        )


async def create_run(
    db: AsyncSession,
    *,
    session_id: int,
    user_message_id: int,
    objective: str,
    run_id: str | None = None,
) -> ChatRun:
    run = ChatRun(
        id=run_id or str(uuid4()),
        session_id=session_id,
        user_message_id=user_message_id,
        status="preparing",
        objective=objective,
        checkpoint_version=0,
    )
    db.add(run)
    await db.flush()
    return run


async def freeze_preparation(
    db: AsyncSession,
    run_id: str,
    *,
    skill_invocation: dict | None,
    validated_plan: dict | None,
    capability_snapshot: dict,
    expected_version: int,
) -> ChatRun:
    run = await _locked_run(db, run_id)
    _check_version(run, expected_version)
    if run.status != "preparing":
        raise ChatRunInvalidState(f"cannot freeze a {run.status} chat run")
    run.skill_invocation = skill_invocation
    run.validated_plan = validated_plan
    run.capability_snapshot = capability_snapshot
    run.status = "running"
    run.checkpoint_version += 1
    run.updated_at = _now()
    await db.flush()
    return run


async def append_step(
    db: AsyncSession,
    run_id: str,
    *,
    assistant_content: list[dict],
    tool_calls: list[dict],
    expected_version: int,
    finish_reason: str | None = None,
    usage_data: dict | None = None,
) -> ChatRunStep:
    run = await _locked_run(db, run_id)
    _check_version(run, expected_version)
    if run.status not in {"running", "resuming"}:
        raise ChatRunInvalidState(f"cannot append a step to a {run.status} chat run")
    pending = [call for call in tool_calls if call.get("approval_id")]
    if len(pending) > 1:
        raise ChatRunInvalidState("only one pending approval is allowed per step")
    ordinal = run.current_step + 1
    step_status = "waiting_approval" if pending else "completed"
    step = ChatRunStep(
        run_id=run_id,
        ordinal=ordinal,
        status=step_status,
        assistant_content=assistant_content,
        finish_reason=finish_reason,
        usage_data=usage_data,
        completed_at=None if pending else _now(),
    )
    db.add(step)
    await db.flush()
    for call in tool_calls:
        approval_id = call.get("approval_id")
        terminal_status = call.get("status")
        tool_call_id = str(call["tool_call_id"])
        db.add(ChatRunToolCall(
            run_id=run_id,
            step_id=step.id,
            tool_call_id=tool_call_id,
            tool_name=str(call["tool_name"]),
            input_data=call.get("input_data") or {},
            status="pending_approval" if approval_id else (terminal_status or "executing"),
            approval_id=approval_id,
            output_data=call.get("output_data") if terminal_status else None,
            error_data=call.get("error_data") if terminal_status else None,
            side_effecting=bool(call.get("side_effecting", False)),
            replay_policy=str(call.get("replay_policy") or "never"),
            concurrency_policy=str(call.get("concurrency_policy") or "serial"),
            idempotency_key=str(
                call.get("idempotency_key") or f"chat-run:{run_id}:{tool_call_id}"
            ),
            tool_version=str(call.get("tool_version") or ""),
            contract_digest=str(call.get("contract_digest") or ""),
            completed_at=_now() if terminal_status else None,
        ))
    run.current_step = ordinal
    run.status = "waiting_approval" if pending else "running"
    run.checkpoint_version += 1
    run.updated_at = _now()
    await db.flush()
    return step


async def decide_approval(
    db: AsyncSession,
    run_id: str,
    *,
    session_id: int,
    approval_id: str,
    tool_call_id: str,
    approved: bool,
    reason: str | None = None,
) -> ApprovalDecisionResult:
    run = await _locked_run(db, run_id)
    if run.session_id != session_id:
        raise ChatRunNotFound(run_id)
    if run.status == "needs_reconciliation":
        raise ChatRunNeedsReconciliation(run_id)
    tool_call = await db.scalar(
        select(ChatRunToolCall).where(
            ChatRunToolCall.run_id == run_id,
            ChatRunToolCall.approval_id == approval_id,
            ChatRunToolCall.tool_call_id == tool_call_id,
        ).with_for_update()
    )
    if tool_call is None:
        raise ChatRunConflict("approval does not match this chat run")
    decision: Literal["approved", "rejected"] = "approved" if approved else "rejected"
    if tool_call.approval_decision is not None:
        recorded = tool_call.approval_decision.get("decision")
        if recorded != decision:
            raise ChatRunConflict("opposite approval decision was already recorded")
        return ApprovalDecisionResult(
            run_id, tool_call_id, decision, True, run.status, run.checkpoint_version
        )
    if run.status != "waiting_approval" or tool_call.status != "pending_approval":
        raise ChatRunConflict("approval is stale or no longer pending")
    tool_call.approval_decision = {"decision": decision, "reason": reason}
    tool_call.approved_at = _now()
    if approved:
        tool_call.status = "approved"
        run.status = "resuming"
    else:
        tool_call.status = "rejected"
        tool_call.output_data = {
            "approved": False,
            "error": "tool_execution_denied",
            "reason": reason,
        }
        tool_call.completed_at = _now()
        step = await db.get(ChatRunStep, tool_call.step_id)
        if step is not None:
            step.status = "completed"
            step.completed_at = _now()
        run.status = "completed"
        run.completed_at = _now()
    run.checkpoint_version += 1
    run.updated_at = _now()
    await db.flush()
    return ApprovalDecisionResult(
        run_id, tool_call_id, decision, False, run.status, run.checkpoint_version
    )


async def complete_tool_call(
    db: AsyncSession,
    run_id: str,
    *,
    tool_call_id: str,
    status: Literal["succeeded", "failed", "outcome_unknown"],
    output_data=None,
    error_data: dict | None = None,
) -> ChatRunToolCall:
    run = await _locked_run(db, run_id)
    tool_call = await db.scalar(
        select(ChatRunToolCall).where(
            ChatRunToolCall.run_id == run_id,
            ChatRunToolCall.tool_call_id == tool_call_id,
        ).with_for_update()
    )
    if tool_call is None:
        raise ChatRunNotFound(tool_call_id)
    if tool_call.status in {"succeeded", "failed", "outcome_unknown", "rejected"}:
        if tool_call.status == status and tool_call.output_data == output_data and tool_call.error_data == error_data:
            return tool_call
        raise ChatRunConflict("tool call already has a different terminal result")
    if tool_call.status not in {"approved", "executing"}:
        raise ChatRunInvalidState(f"cannot complete a {tool_call.status} tool call")
    tool_call.status = status
    tool_call.output_data = output_data
    tool_call.error_data = error_data
    tool_call.completed_at = _now()
    step = await db.get(ChatRunStep, tool_call.step_id)
    if step is not None:
        step.status = "failed" if status == "failed" else "completed"
        step.completed_at = _now()
    run.status = "needs_reconciliation" if status == "outcome_unknown" else "running"
    if status == "outcome_unknown":
        run.error_data = error_data or {"code": "tool_outcome_unknown"}
    run.checkpoint_version += 1
    run.updated_at = _now()
    await db.flush()
    return tool_call


async def transition_run(
    db: AsyncSession,
    run_id: str,
    *,
    status: Literal["completed", "failed", "needs_reconciliation"],
    expected_version: int,
    error_data: dict | None = None,
) -> ChatRun:
    run = await _locked_run(db, run_id)
    _check_version(run, expected_version)
    if run.status in {"completed", "failed", "needs_reconciliation"}:
        raise ChatRunInvalidState(f"chat run is already {run.status}")
    run.status = status
    run.error_data = error_data
    run.checkpoint_version += 1
    run.updated_at = _now()
    if status in {"completed", "failed"}:
        run.completed_at = _now()
    await db.flush()
    return run


async def load_checkpoint(
    db: AsyncSession,
    run_id: str,
    *,
    session_id: int,
) -> ChatRunCheckpoint:
    run = await db.scalar(select(ChatRun).where(
        ChatRun.id == run_id,
        ChatRun.session_id == session_id,
    ))
    if run is None:
        raise ChatRunNotFound(run_id)
    steps = list((await db.scalars(
        select(ChatRunStep).where(ChatRunStep.run_id == run_id).order_by(ChatRunStep.ordinal)
    )).all())
    tool_calls = list((await db.scalars(
        select(ChatRunToolCall)
        .where(ChatRunToolCall.run_id == run_id)
        .order_by(ChatRunToolCall.step_id, ChatRunToolCall.id)
    )).all())
    return ChatRunCheckpoint(run=run, steps=steps, tool_calls=tool_calls)
