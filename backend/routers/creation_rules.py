"""Scheduled and one-time creation rules and their execution history."""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from log_redaction import redact_log_value, redact_secret_text
from models import (
    AgentExecution,
    AgentMessageLog,
    AgentToolCall,
    CollectLog,
    ContentJob,
    ContentJobEvent,
    ContentJobStep,
    ContentUsageLedger,
    CreativeAssetDirectory,
    DailyCreationRule,
    DailyCreationRun,
    PublishAccount,
)
from worker_auth import require_worker_token

router = APIRouter(prefix="/creation-rules", tags=["creation-rules"])

CN_TZ = timezone(timedelta(hours=8))


class CreationRuleIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    prompt: str = Field(min_length=1, max_length=20_000)
    asset_type: Literal["article", "media"] = "article"
    directory: str | None = Field(default=None, max_length=200)
    directories: list[str] | None = None
    output_type: Literal["x_short_post"] = "x_short_post"
    target_count: int = Field(default=1, ge=1, le=50)
    execution_mode: Literal["once", "recurring"]
    scheduled_date: date | None = None
    scheduled_time: time
    timezone: str = "Asia/Shanghai"
    lookback_days: int = Field(default=7, ge=1, le=90)
    delivery_mode: Literal["drafts"] = "drafts"
    account_id: str | None = None
    instructions: str = Field(default="", max_length=4000)
    skill_mode: Literal["auto", "manual"] = "auto"
    skill_name: str | None = Field(default=None, max_length=200)
    enabled: bool = True

    @field_validator("prompt")
    @classmethod
    def normalize_prompt(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("prompt must not be blank")
        return normalized

    @model_validator(mode="after")
    def validate_schedule(self):
        from daily_creation_service import normalize_creation_directories

        if self.directories or self.directory:
            normalized = normalize_creation_directories(
                self.directories,
                self.directory,
            )
            self.directories = normalized
            self.directory = normalized[0] if normalized else ""
        else:
            self.directories = []
            self.directory = ""
        if self.skill_mode == "manual":
            if not (self.skill_name or "").strip():
                raise ValueError("skill_name is required in manual mode")
            self.skill_name = self.skill_name.strip()
        else:
            self.skill_name = None
        if self.execution_mode == "once" and self.scheduled_date is None:
            raise ValueError("scheduled_date is required for once rules")
        if self.execution_mode == "recurring" and self.scheduled_date is not None:
            raise ValueError("scheduled_date is only valid for once rules")
        try:
            ZoneInfo(self.timezone)
        except ZoneInfoNotFoundError as exc:
            raise ValueError("timezone is invalid") from exc
        return self


class CreationRulePatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    prompt: str | None = Field(default=None, max_length=20_000)
    asset_type: Literal["article", "media"] | None = None
    directory: str | None = Field(default=None, max_length=200)
    directories: list[str] | None = None
    output_type: Literal["x_short_post"] | None = None
    target_count: int | None = Field(default=None, ge=1, le=50)
    execution_mode: Literal["once", "recurring"] | None = None
    scheduled_date: date | None = None
    scheduled_time: time | None = None
    timezone: str | None = None
    lookback_days: int | None = Field(default=None, ge=1, le=90)
    delivery_mode: Literal["drafts"] | None = None
    account_id: str | None = None
    instructions: str | None = Field(default=None, max_length=4000)
    skill_mode: Literal["auto", "manual"] | None = None
    skill_name: str | None = Field(default=None, max_length=200)
    enabled: bool | None = None


def _rule_out(rule: DailyCreationRule) -> dict:
    from daily_creation_service import normalize_creation_directories

    directories = (
        normalize_creation_directories(rule.directories, rule.directory)
        if rule.directories or rule.directory
        else []
    )
    return {
        "id": rule.id, "name": rule.name, "asset_type": rule.asset_type,
        "directory": directories[0] if directories else "", "directories": directories,
        "output_type": rule.output_type,
        "target_count": rule.target_count, "execution_mode": rule.execution_mode,
        "scheduled_date": rule.scheduled_date,
        "scheduled_time": rule.scheduled_time, "timezone": rule.timezone,
        "lookback_days": rule.lookback_days, "delivery_mode": rule.delivery_mode,
        "account_id": rule.account_id, "instructions": rule.instructions or "",
        "prompt": rule.prompt,
        "skill_mode": rule.skill_mode or "auto", "skill_name": rule.skill_name,
        "enabled": rule.enabled,
        "deleted_at": rule.deleted_at.isoformat() if rule.deleted_at else None,
        "created_at": rule.created_at.isoformat() if rule.created_at else "",
        "updated_at": rule.updated_at.isoformat() if rule.updated_at else "",
    }


def _next_run_at(rule: DailyCreationRule) -> datetime | None:
    if not rule.enabled:
        return None
    zone = ZoneInfo(rule.timezone)
    now = datetime.now(zone)
    scheduled_time = time.fromisoformat(rule.scheduled_time)
    if rule.execution_mode == "once":
        if not rule.scheduled_date:
            return None
        candidate = datetime.combine(
            date.fromisoformat(rule.scheduled_date), scheduled_time, zone,
        )
        return candidate.astimezone(timezone.utc) if candidate > now else None
    candidate = datetime.combine(now.date(), scheduled_time, zone)
    if candidate <= now:
        candidate += timedelta(days=1)
    return candidate.astimezone(timezone.utc)


def _iso(value: datetime | None) -> str | None:
    return value.astimezone(timezone.utc).isoformat() if value else None


def _safe_log_text(value: object, limit: int = 500) -> str:
    return redact_secret_text(str(value or ""))[:limit]


def _run_out(creation_run: DailyCreationRun) -> dict:
    return {
        "id": creation_run.id, "rule_id": creation_run.rule_id,
        "content_job_id": creation_run.content_job_id,
        "scheduled_for": creation_run.scheduled_for.isoformat(),
        "trigger_kind": creation_run.trigger_kind, "status": creation_run.status,
        "requested_count": creation_run.requested_count,
        "created_count": creation_run.created_count,
        "detail": creation_run.detail or {},
        "rule": creation_run.rule_snapshot or {},
        "created_at": creation_run.created_at.isoformat() if creation_run.created_at else "",
    }


async def _rule_out_with_schedule(
    db: AsyncSession,
    rule: DailyCreationRule,
) -> dict:
    last_run_at = await db.scalar(select(func.max(
        DailyCreationRun.scheduled_for
    )).where(DailyCreationRun.rule_id == rule.id))
    return {
        **_rule_out(rule),
        "last_run_at": _iso(last_run_at),
        "next_run_at": _iso(_next_run_at(rule)),
    }


def _bounded_completion(value: object) -> dict | None:
    if not isinstance(value, dict) or not value:
        return None
    allowed = (
        "kind", "executionId", "finalText", "toolCallCount",
        "toolName", "toolCallId", "runId", "createdCount",
        "outputIds", "usageIds",
    )
    return {key: value[key] for key in allowed if key in value}


def _loaded_reference_summary(audit: dict) -> list[dict]:
    skill_run = audit.get("skillRun") or audit.get("skill_run") or {}
    raw = audit.get("loaded_references")
    if not isinstance(raw, list) and isinstance(skill_run, dict):
        raw = skill_run.get("loadedReferences") or skill_run.get("loaded_references")
    if not isinstance(raw, list):
        return []
    references: list[dict] = []
    seen: set[str] = set()
    for item in raw[:100]:
        if isinstance(item, str):
            path, size = item, 0
        elif isinstance(item, dict):
            path = item.get("path")
            size = item.get("bytes", 0)
        else:
            continue
        if not isinstance(path, str) or not path.strip() or path in seen:
            continue
        seen.add(path)
        references.append({
            "path": path[:500],
            "bytes": size if isinstance(size, int) and size >= 0 else 0,
        })
    return references


def _agent_execution_summary_from_records(
    execution: AgentExecution,
    calls: list[AgentToolCall],
    detail: object,
) -> dict:
    audit = execution.audit_data if isinstance(execution.audit_data, dict) else {}
    skill_run = audit.get("skillRun") or audit.get("skill_run") or {}
    skill = audit.get("skill") if isinstance(audit.get("skill"), dict) else {}
    if not isinstance(skill_run, dict):
        skill_run = {}
    skill_name = (
        execution.skill_name
        or skill_run.get("skillName")
        or skill_run.get("skill_name")
        or skill.get("activeSkillName")
    )
    activation = (
        execution.skill_activation
        or skill_run.get("activation")
        or skill.get("source")
        or ""
    )
    if activation not in {"manual", "automatic"}:
        activation = ""
    tools = [{
        "tool_name": call.tool_name,
        "status": call.status,
        "auto_approved": call.auto_approved,
        "occurred_at": (
            call.completed_at or call.started_at
        ).isoformat() if (call.completed_at or call.started_at) else "",
        "error": _safe_log_text(call.error),
    } for call in calls]
    detail = detail if isinstance(detail, dict) else {}
    self_validation = detail.get("self_validation")
    return {
        "status": execution.status,
        "phase": execution.phase,
        "skill_name": skill_name if isinstance(skill_name, str) else None,
        "skill_activation": activation,
        "loaded_references": _loaded_reference_summary(audit),
        "tools": tools,
        "self_validation": (
            self_validation if isinstance(self_validation, dict) else {}
        ),
        "completion": _bounded_completion(execution.completion_evidence),
    }


def _agent_message_log_payload(message: AgentMessageLog) -> dict:
    return {
        "id": message.id,
        "execution_id": message.execution_id,
        "phase": message.phase,
        "direction": message.direction,
        "payload": redact_log_value(message.payload_data),
        "created_at": _iso(message.created_at),
    }


def _agent_tool_log_payload(call: AgentToolCall) -> dict:
    return {
        "id": call.id,
        "tool_call_id": call.tool_call_id,
        "tool_name": call.tool_name,
        "status": call.status,
        "auto_approved": call.auto_approved,
        "side_effecting": call.side_effecting,
        "input_summary": redact_log_value(call.input_summary),
        "output": redact_log_value(call.output_data),
        "error": redact_secret_text(call.error or ""),
        "started_at": _iso(call.started_at),
        "completed_at": _iso(call.completed_at),
    }


async def _agent_execution_summary(
    db: AsyncSession,
    creation_run: DailyCreationRun,
) -> dict | None:
    if creation_run.content_job_id is None:
        return None
    execution = await db.scalar(select(AgentExecution).where(
        AgentExecution.job_id == creation_run.content_job_id
    ))
    if execution is None:
        return None
    calls = list((await db.execute(
        select(AgentToolCall).where(
            AgentToolCall.execution_id == execution.id
        ).order_by(AgentToolCall.id.asc()).limit(100)
    )).scalars().all())
    return _agent_execution_summary_from_records(
        execution, calls, creation_run.detail,
    )


async def _run_out_with_agent(
    db: AsyncSession,
    creation_run: DailyCreationRun,
) -> dict:
    return {
        **_run_out(creation_run),
        "agent_execution": await _agent_execution_summary(db, creation_run),
    }


def _dashboard_date_bounds(value: str | None) -> tuple[date, datetime, datetime]:
    selected = datetime.now(CN_TZ).date() if value is None else date.fromisoformat(value)
    start_local = datetime.combine(selected, time.min, CN_TZ)
    end_local = start_local + timedelta(days=1)
    return (
        selected,
        start_local.astimezone(timezone.utc),
        end_local.astimezone(timezone.utc),
    )


def _dashboard_timestamp(value: datetime | None) -> str | None:
    if value is None:
        return None
    return _iso(value)


async def _dashboard_run_payload(
    creation_run: DailyCreationRun,
    jobs: dict[int, ContentJob],
    steps_by_job: dict[int, list[ContentJobStep]],
    events_by_job: dict[int, list[ContentJobEvent]],
    executions_by_job: dict[int, AgentExecution],
    calls_by_execution: dict[int, list[AgentToolCall]],
) -> dict:
    job = jobs.get(creation_run.content_job_id or -1)
    job_payload = None
    agent_execution = None
    if job is not None:
        job_payload = {
            "id": job.id,
            "status": job.status,
            "started_at": _dashboard_timestamp(job.started_at),
            "completed_at": _dashboard_timestamp(job.completed_at),
            "steps": [{
                "key": step.step_key,
                "attempt": step.attempt,
                "status": step.status,
                "started_at": _dashboard_timestamp(step.started_at),
                "completed_at": _dashboard_timestamp(step.completed_at),
                "error": _safe_log_text(step.error),
            } for step in steps_by_job.get(job.id, [])],
            "events": [{
                "kind": event.kind,
                "payload": event.payload,
                "created_at": _dashboard_timestamp(event.created_at),
            } for event in events_by_job.get(job.id, [])],
        }
        execution = executions_by_job.get(job.id)
        if execution is not None:
            agent_execution = _agent_execution_summary_from_records(
                execution,
                calls_by_execution.get(execution.id, []),
                creation_run.detail,
            )
    return {
        **_run_out(creation_run),
        "job": job_payload,
        "agent_execution": agent_execution,
    }


async def _validate_rule_references(db: AsyncSession, body: CreationRuleIn) -> None:
    if body.directories:
        rows = (await db.execute(
            select(CreativeAssetDirectory.name).where(
                CreativeAssetDirectory.asset_type == body.asset_type,
                CreativeAssetDirectory.name.in_(body.directories),
            )
        )).scalars().all()
        existing = set(rows)
        missing = next(
            (name for name in body.directories if name not in existing),
            None,
        )
        if missing is not None:
            raise HTTPException(
                400,
                f"creative asset directory not found: {missing}",
            )
    if body.account_id is not None and await db.get(PublishAccount, body.account_id) is None:
        raise HTTPException(400, "publish account not found")


@router.get("")
async def list_creation_rules(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(
        select(DailyCreationRule).where(DailyCreationRule.deleted_at.is_(None))
        .order_by(DailyCreationRule.created_at, DailyCreationRule.id)
    )).scalars().all()
    last_runs = dict((await db.execute(
        select(DailyCreationRun.rule_id, func.max(DailyCreationRun.scheduled_for))
        .group_by(DailyCreationRun.rule_id)
    )).all())
    return [{
        **_rule_out(row),
        "last_run_at": _iso(last_runs.get(row.id)),
        "next_run_at": _iso(_next_run_at(row)),
    } for row in rows]


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_creation_rule(body: CreationRuleIn, db: AsyncSession = Depends(get_db)):
    await _validate_rule_references(db, body)
    values = body.model_dump(mode="json")
    values["name"] = body.name.strip()
    values["directories"] = body.directories
    values["directory"] = body.directory
    values["scheduled_time"] = body.scheduled_time.strftime("%H:%M")
    values["scheduled_date"] = body.scheduled_date.isoformat() if body.scheduled_date else None
    rule = DailyCreationRule(**values)
    db.add(rule)
    await db.commit()
    await db.refresh(rule)
    return await _rule_out_with_schedule(db, rule)


@router.patch("/{rule_id}")
async def update_creation_rule(
    rule_id: int, body: CreationRulePatch, db: AsyncSession = Depends(get_db),
):
    rule = await db.get(DailyCreationRule, rule_id)
    if rule is None or rule.deleted_at is not None:
        raise HTTPException(404, "creation rule not found")
    current = _rule_out(rule)
    patch = body.model_dump(exclude_unset=True, mode="json")
    if "directory" in patch and "directories" not in patch:
        patch["directories"] = [patch["directory"]]
    current.update(patch)
    current.pop("id", None)
    current.pop("created_at", None)
    current.pop("updated_at", None)
    merged = CreationRuleIn.model_validate(current)
    await _validate_rule_references(db, merged)
    values = merged.model_dump(mode="json")
    values["directories"] = merged.directories
    values["directory"] = merged.directory
    values["scheduled_time"] = merged.scheduled_time.strftime("%H:%M")
    values["scheduled_date"] = merged.scheduled_date.isoformat() if merged.scheduled_date else None
    for key, value in values.items():
        setattr(rule, key, value)
    await db.commit()
    await db.refresh(rule)
    return await _rule_out_with_schedule(db, rule)


@router.delete("/{rule_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_creation_rule(rule_id: int, db: AsyncSession = Depends(get_db)):
    rule = await db.get(DailyCreationRule, rule_id)
    if rule is None or rule.deleted_at is not None:
        raise HTTPException(404, "creation rule not found")
    rule.enabled = False
    rule.deleted_at = datetime.now(timezone.utc)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{rule_id}/run", status_code=status.HTTP_202_ACCEPTED)
async def run_creation_rule(rule_id: int, db: AsyncSession = Depends(get_db)):
    from daily_creation_service import create_daily_creation_run
    from job_queue import enqueue_job

    rule = await db.get(DailyCreationRule, rule_id)
    if rule is None or rule.deleted_at is not None:
        raise HTTPException(404, "creation rule not found")
    try:
        creation_run, created = await create_daily_creation_run(
            db, rule=rule, scheduled_for=datetime.now(timezone.utc),
            trigger_kind="explicit",
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if created:
        await db.commit()
        await db.refresh(creation_run)
        await enqueue_job(creation_run.content_job_id)
    return await _run_out_with_agent(db, creation_run)


@router.get("/dashboard")
async def get_creation_dashboard(
    date: str | None = None,
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
):
    try:
        selected_date, start_utc, end_utc = _dashboard_date_bounds(date)
    except ValueError as exc:
        raise HTTPException(400, "date must be YYYY-MM-DD") from exc
    limit = max(1, min(limit, 100))

    rules = list((await db.execute(
        select(DailyCreationRule)
        .where(DailyCreationRule.deleted_at.is_(None))
        .order_by(DailyCreationRule.created_at, DailyCreationRule.id)
    )).scalars().all())
    last_runs = dict((await db.execute(
        select(DailyCreationRun.rule_id, func.max(DailyCreationRun.scheduled_for))
        .group_by(DailyCreationRun.rule_id)
    )).all())
    rule_payloads = [{
        **_rule_out(rule),
        "last_run_at": _iso(last_runs.get(rule.id)),
        "next_run_at": _iso(_next_run_at(rule)),
    } for rule in rules]

    runs = list((await db.execute(
        select(DailyCreationRun)
        .where(
            DailyCreationRun.scheduled_for >= start_utc,
            DailyCreationRun.scheduled_for < end_utc,
        )
        .order_by(DailyCreationRun.created_at.desc(), DailyCreationRun.id.desc())
        .limit(limit)
    )).scalars().all())
    run_rule_ids = {run.rule_id for run in runs}
    # A deleted rule remains visible in historical run snapshots, but is not
    # included in the editable rule list above.
    if run_rule_ids:
        missing_rule_ids = run_rule_ids - {rule.id for rule in rules}
        if missing_rule_ids:
            historical_rules = list((await db.execute(
                select(DailyCreationRule).where(
                    DailyCreationRule.id.in_(missing_rule_ids)
                )
            )).scalars().all())
            rule_payloads.extend({
                **_rule_out(rule),
                "last_run_at": _iso(last_runs.get(rule.id)),
                "next_run_at": None,
            } for rule in historical_rules)

    job_ids = {run.content_job_id for run in runs if run.content_job_id is not None}
    jobs = {}
    steps_by_job: dict[int, list[ContentJobStep]] = {}
    events_by_job: dict[int, list[ContentJobEvent]] = {}
    executions_by_job: dict[int, AgentExecution] = {}
    calls_by_execution: dict[int, list[AgentToolCall]] = {}
    if job_ids:
        jobs = {
            job.id: job for job in (await db.execute(
                select(ContentJob).where(ContentJob.id.in_(job_ids))
            )).scalars().all()
        }
        steps = list((await db.execute(
            select(ContentJobStep)
            .where(ContentJobStep.job_id.in_(job_ids))
            .order_by(ContentJobStep.created_at, ContentJobStep.attempt)
        )).scalars().all())
        for step in steps:
            steps_by_job.setdefault(step.job_id, []).append(step)
        events = list((await db.execute(
            select(ContentJobEvent)
            .where(ContentJobEvent.job_id.in_(job_ids))
            .order_by(ContentJobEvent.created_at.desc())
        )).scalars().all())
        for event in events:
            events_by_job.setdefault(event.job_id, []).append(event)
        executions = list((await db.execute(
            select(AgentExecution).where(AgentExecution.job_id.in_(job_ids))
        )).scalars().all())
        executions_by_job = {execution.job_id: execution for execution in executions}
        execution_ids = {execution.id for execution in executions}
        if execution_ids:
            calls = list((await db.execute(
                select(AgentToolCall)
                .where(AgentToolCall.execution_id.in_(execution_ids))
                .order_by(AgentToolCall.id)
            )).scalars().all())
            for call in calls:
                calls_by_execution.setdefault(call.execution_id, []).append(call)

    logs = list((await db.execute(
        select(CollectLog)
        .where(
            CollectLog.job == "daily_creation",
            CollectLog.created_at >= start_utc,
            CollectLog.created_at < end_utc,
        )
        .order_by(CollectLog.created_at.desc(), CollectLog.id.desc())
        .limit(100)
    )).scalars().all())

    status_counts = {
        status_name: sum(run.status == status_name for run in runs)
        for status_name in (
            "queued", "running", "succeeded", "partial", "failed", "cancelled",
        )
    }
    next_runs = [
        next_run for rule in rules
        if (next_run := _next_run_at(rule)) is not None
    ]
    summary = {
        "enabled_rules": sum(rule.enabled for rule in rules),
        "scheduled_runs": len(runs),
        **status_counts,
        "next_run_at": _iso(min(next_runs)) if next_runs else None,
    }
    return {
        "date": selected_date.isoformat(),
        "summary": summary,
        "rules": rule_payloads,
        "runs": [await _dashboard_run_payload(
            run, jobs, steps_by_job, events_by_job,
            executions_by_job, calls_by_execution,
        ) for run in runs],
        "scheduler_logs": [{
            "status": log.status,
            "message": _safe_log_text(log.message),
            "detail": _safe_log_text(log.detail),
            "created_at": _dashboard_timestamp(log.created_at),
        } for log in logs],
    }


@router.get("/runs")
async def list_creation_runs(
    date: str | None = None, rule_id: int | None = None,
    db: AsyncSession = Depends(get_db),
):
    statement = select(DailyCreationRun)
    if rule_id is not None:
        statement = statement.where(DailyCreationRun.rule_id == rule_id)
    rows = (await db.execute(
        statement.order_by(DailyCreationRun.created_at.desc(), DailyCreationRun.id.desc())
    )).scalars().all()
    if date:
        rows = [row for row in rows if row.scheduled_for.date().isoformat() == date]
    return [await _run_out_with_agent(db, row) for row in rows]


@router.get("/runs/{run_id}")
async def get_creation_run(run_id: int, db: AsyncSession = Depends(get_db)):
    creation_run = await db.get(DailyCreationRun, run_id)
    if creation_run is None:
        raise HTTPException(404, "creation run not found")
    return await _run_out_with_agent(db, creation_run)


@router.get("/runs/{run_id}/agent-log")
async def get_creation_run_agent_log(run_id: int, db: AsyncSession = Depends(get_db)):
    creation_run = await db.get(DailyCreationRun, run_id)
    if creation_run is None:
        raise HTTPException(404, "creation run not found")
    if creation_run.content_job_id is None:
        return {"execution": None, "messages": [], "tools": []}
    execution = await db.scalar(select(AgentExecution).where(
        AgentExecution.job_id == creation_run.content_job_id
    ))
    if execution is None:
        return {"execution": None, "messages": [], "tools": []}
    messages = list((await db.execute(
        select(AgentMessageLog)
        .where(AgentMessageLog.execution_id == execution.id)
        .order_by(AgentMessageLog.id.asc())
    )).scalars().all())
    calls = list((await db.execute(
        select(AgentToolCall)
        .where(AgentToolCall.execution_id == execution.id)
        .order_by(AgentToolCall.id.asc())
    )).scalars().all())
    return {
        "execution": {
            "id": execution.id,
            "job_id": execution.job_id,
            "status": execution.status,
            "objective": execution.objective,
            "phase": execution.phase,
            "error": redact_secret_text(execution.error or ""),
            "created_at": _iso(execution.created_at),
            "updated_at": _iso(execution.updated_at),
            "completed_at": _iso(execution.completed_at),
        },
        "messages": [_agent_message_log_payload(message) for message in messages],
        "tools": [_agent_tool_log_payload(call) for call in calls],
    }


@router.get(
    "/runs/{run_id}/context",
    dependencies=[Depends(require_worker_token)],
)
async def get_creation_run_context(run_id: int, db: AsyncSession = Depends(get_db)):
    creation_run = await db.get(DailyCreationRun, run_id)
    if creation_run is None:
        raise HTTPException(404, "creation run not found")
    return _run_out(creation_run)


class CreationOutputIn(BaseModel):
    asset_id: int = Field(gt=0)
    title: str = Field(min_length=1, max_length=300)
    text: str = Field(min_length=1, max_length=5000)
    topic: str = Field(min_length=1, max_length=300)
    angle: str = Field(min_length=1, max_length=500)
    reuse_decision: Literal["fresh", "reuse_allowed"]
    reuse_explanation: str = Field(default="", max_length=1000)


@router.post(
    "/runs/{run_id}/outputs",
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_worker_token)],
)
async def persist_creation_output(
    run_id: int, body: CreationOutputIn, db: AsyncSession = Depends(get_db),
):
    from daily_creation_service import persist_x_draft_with_usage

    creation_run = await db.get(DailyCreationRun, run_id)
    if creation_run is None:
        raise HTTPException(404, "creation run not found")
    existing = await db.scalar(select(ContentUsageLedger).where(
        ContentUsageLedger.run_id == run_id,
        ContentUsageLedger.creative_asset_id == body.asset_id,
        ContentUsageLedger.topic == body.topic.strip(),
        ContentUsageLedger.angle == body.angle.strip(),
        ContentUsageLedger.excerpt == " ".join(body.text.split())[:500],
    ))
    if existing is not None:
        return {
            "output_kind": existing.output_kind, "output_id": existing.output_id,
            "draft_id": existing.draft_id,
        }
    snapshot = creation_run.rule_snapshot or {}
    try:
        output, usage = await persist_x_draft_with_usage(
            db, run_id=run_id, asset_id=body.asset_id,
            title=body.title, text=body.text, topic=body.topic,
            angle=body.angle, reuse_decision=body.reuse_decision,
            reuse_explanation=body.reuse_explanation,
            account_id=snapshot.get("account_id"),
        )
        detail = dict(creation_run.detail or {})
        outputs = list(detail.get("outputs") or [])
        outputs.append({
            "output_kind": usage.output_kind,
            "output_id": output.id,
            "draft_id": usage.draft_id,
        })
        detail["outputs"] = outputs
        creation_run.detail = detail
        await db.commit()
    except ValueError as exc:
        await db.rollback()
        raise HTTPException(400, str(exc)) from exc
    return {
        "output_kind": usage.output_kind, "output_id": output.id,
        "draft_id": usage.draft_id,
    }


class CreationRunCompleteIn(BaseModel):
    status: Literal["failed", "partial", "succeeded"]
    created_count: int = Field(ge=0)
    detail: dict = Field(default_factory=dict)


@router.post(
    "/runs/{run_id}/complete",
    dependencies=[Depends(require_worker_token)],
)
async def complete_creation_run(
    run_id: int, body: CreationRunCompleteIn, db: AsyncSession = Depends(get_db),
):
    creation_run = await db.get(DailyCreationRun, run_id)
    if creation_run is None:
        raise HTTPException(404, "creation run not found")
    expected_status = (
        "failed" if body.created_count == 0
        else "partial" if body.created_count < creation_run.requested_count
        else "succeeded"
    )
    if body.created_count > creation_run.requested_count or body.status != expected_status:
        raise HTTPException(400, "status and created_count do not match the run")
    creation_run.status = body.status
    creation_run.created_count = body.created_count
    detail = dict(body.detail)
    detail["outputs"] = list((creation_run.detail or {}).get("outputs") or [])
    creation_run.detail = detail
    creation_run.completed_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(creation_run)
    return _run_out(creation_run)
