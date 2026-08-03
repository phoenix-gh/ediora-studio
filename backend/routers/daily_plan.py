"""今日内容计划：查询 / 重新生成 / 跳过 / 入队。"""
from __future__ import annotations

from datetime import date, datetime, time, timezone
from typing import Literal, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import delete as sa_delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import (
    ContentUsageLedger,
    CreativeAssetDirectory,
    DailyCreationRule,
    DailyCreationRun,
    DailyPlan,
    DailyPlanItem,
    PipelineTask,
    PublishAccount,
)
from worker_auth import require_worker_token

router = APIRouter(prefix="/daily-plan", tags=["daily-plan"])

_WORD_RANGE: dict[str, str] = {
    "long": "1500-3000 字",
    "short": "200-500 字",
    "story": "5-6 句话",
    "share": "3-5 句话",
}

_TYPE_LABEL: dict[str, str] = {
    "long": "长文",
    "short": "短文",
    "story": "微故事",
    "share": "发现",
}


class ItemOut(BaseModel):
    id: int
    account_id: str
    account_name: str
    title: str
    angle: str
    reason: str
    content_type: str
    sources: list[dict]
    group_key: str
    is_primary: bool
    status: str
    pipeline_task_id: Optional[int]
    draft_id: Optional[int]


class PlanOut(BaseModel):
    id: int
    plan_date: str
    status: str
    planner_note: str
    kanban_task_id: str
    items: list[ItemOut]


class TodayOut(BaseModel):
    plan: Optional[PlanOut] = None


class CreationRuleIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    asset_type: Literal["article", "media"] = "article"
    directory: str = Field(min_length=1, max_length=200)
    output_type: Literal["x_short_post"] = "x_short_post"
    target_count: int = Field(ge=1, le=50)
    execution_mode: Literal["once", "recurring"]
    scheduled_date: date | None = None
    scheduled_time: time
    timezone: str = "Asia/Shanghai"
    lookback_days: int = Field(ge=1, le=90)
    delivery_mode: Literal["drafts", "plan_items"]
    account_id: str | None = None
    instructions: str = Field(default="", max_length=4000)
    enabled: bool = True

    @model_validator(mode="after")
    def validate_schedule(self):
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
    asset_type: Literal["article", "media"] | None = None
    directory: str | None = Field(default=None, min_length=1, max_length=200)
    output_type: Literal["x_short_post"] | None = None
    target_count: int | None = Field(default=None, ge=1, le=50)
    execution_mode: Literal["once", "recurring"] | None = None
    scheduled_date: date | None = None
    scheduled_time: time | None = None
    timezone: str | None = None
    lookback_days: int | None = Field(default=None, ge=1, le=90)
    delivery_mode: Literal["drafts", "plan_items"] | None = None
    account_id: str | None = None
    instructions: str | None = Field(default=None, max_length=4000)
    enabled: bool | None = None


def _rule_out(rule: DailyCreationRule) -> dict:
    return {
        "id": rule.id, "name": rule.name, "asset_type": rule.asset_type,
        "directory": rule.directory, "output_type": rule.output_type,
        "target_count": rule.target_count, "execution_mode": rule.execution_mode,
        "scheduled_date": rule.scheduled_date,
        "scheduled_time": rule.scheduled_time, "timezone": rule.timezone,
        "lookback_days": rule.lookback_days, "delivery_mode": rule.delivery_mode,
        "account_id": rule.account_id, "instructions": rule.instructions or "",
        "enabled": rule.enabled,
        "created_at": rule.created_at.isoformat() if rule.created_at else "",
        "updated_at": rule.updated_at.isoformat() if rule.updated_at else "",
    }


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


async def _validate_rule_references(db: AsyncSession, body: CreationRuleIn) -> None:
    directory_exists = await db.scalar(
        select(CreativeAssetDirectory.id).where(
            CreativeAssetDirectory.asset_type == body.asset_type,
            CreativeAssetDirectory.name == body.directory.strip(),
        )
    )
    if directory_exists is None:
        raise HTTPException(400, "creative asset directory not found")
    if body.account_id is not None and await db.get(PublishAccount, body.account_id) is None:
        raise HTTPException(400, "publish account not found")


@router.get("/creation-rules")
async def list_creation_rules(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(
        select(DailyCreationRule).where(DailyCreationRule.deleted_at.is_(None))
        .order_by(DailyCreationRule.created_at, DailyCreationRule.id)
    )).scalars().all()
    return [_rule_out(row) for row in rows]


@router.post("/creation-rules", status_code=status.HTTP_201_CREATED)
async def create_creation_rule(body: CreationRuleIn, db: AsyncSession = Depends(get_db)):
    await _validate_rule_references(db, body)
    values = body.model_dump(mode="json")
    values["name"] = body.name.strip()
    values["directory"] = body.directory.strip()
    values["scheduled_time"] = body.scheduled_time.strftime("%H:%M")
    values["scheduled_date"] = body.scheduled_date.isoformat() if body.scheduled_date else None
    rule = DailyCreationRule(**values)
    db.add(rule)
    await db.commit()
    await db.refresh(rule)
    return _rule_out(rule)


@router.patch("/creation-rules/{rule_id}")
async def update_creation_rule(
    rule_id: int, body: CreationRulePatch, db: AsyncSession = Depends(get_db),
):
    rule = await db.get(DailyCreationRule, rule_id)
    if rule is None or rule.deleted_at is not None:
        raise HTTPException(404, "creation rule not found")
    current = _rule_out(rule)
    patch = body.model_dump(exclude_unset=True, mode="json")
    current.update(patch)
    current.pop("id", None)
    current.pop("created_at", None)
    current.pop("updated_at", None)
    merged = CreationRuleIn.model_validate(current)
    await _validate_rule_references(db, merged)
    values = merged.model_dump(mode="json")
    values["scheduled_time"] = merged.scheduled_time.strftime("%H:%M")
    values["scheduled_date"] = merged.scheduled_date.isoformat() if merged.scheduled_date else None
    for key, value in values.items():
        setattr(rule, key, value)
    await db.commit()
    await db.refresh(rule)
    return _rule_out(rule)


@router.delete("/creation-rules/{rule_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_creation_rule(rule_id: int, db: AsyncSession = Depends(get_db)):
    rule = await db.get(DailyCreationRule, rule_id)
    if rule is None or rule.deleted_at is not None:
        raise HTTPException(404, "creation rule not found")
    rule.enabled = False
    rule.deleted_at = datetime.now(timezone.utc)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/creation-rules/{rule_id}/run", status_code=status.HTTP_202_ACCEPTED)
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
    return _run_out(creation_run)


@router.get("/creation-runs")
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
    return [_run_out(row) for row in rows]


@router.get("/creation-runs/{run_id}")
async def get_creation_run(run_id: int, db: AsyncSession = Depends(get_db)):
    creation_run = await db.get(DailyCreationRun, run_id)
    if creation_run is None:
        raise HTTPException(404, "creation run not found")
    return _run_out(creation_run)


@router.get(
    "/creation-runs/{run_id}/context",
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
    "/creation-runs/{run_id}/outputs",
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_worker_token)],
)
async def persist_creation_output(
    run_id: int, body: CreationOutputIn, db: AsyncSession = Depends(get_db),
):
    from daily_creation_service import (
        persist_plan_item_with_usage,
        persist_x_draft_with_usage,
    )

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
            "draft_id": existing.draft_id, "plan_item_id": existing.plan_item_id,
        }
    snapshot = creation_run.rule_snapshot or {}
    try:
        if snapshot.get("delivery_mode") == "drafts":
            output, usage = await persist_x_draft_with_usage(
                db, run_id=run_id, asset_id=body.asset_id,
                title=body.title, text=body.text, topic=body.topic,
                angle=body.angle, reuse_decision=body.reuse_decision,
                reuse_explanation=body.reuse_explanation,
                account_id=snapshot.get("account_id"),
            )
        else:
            account_id = snapshot.get("account_id")
            if not account_id:
                raise ValueError("account_id is required for plan item delivery")
            output, usage = await persist_plan_item_with_usage(
                db, run_id=run_id, asset_id=body.asset_id,
                account_id=account_id, title=body.title, text=body.text,
                topic=body.topic, angle=body.angle,
                reuse_decision=body.reuse_decision,
                reuse_explanation=body.reuse_explanation,
            )
        detail = dict(creation_run.detail or {})
        outputs = list(detail.get("outputs") or [])
        outputs.append({
            "output_kind": usage.output_kind,
            "output_id": output.id,
            "draft_id": usage.draft_id,
            "plan_item_id": usage.plan_item_id,
        })
        detail["outputs"] = outputs
        creation_run.detail = detail
        await db.commit()
    except ValueError as exc:
        await db.rollback()
        raise HTTPException(400, str(exc)) from exc
    return {
        "output_kind": usage.output_kind, "output_id": output.id,
        "draft_id": usage.draft_id, "plan_item_id": usage.plan_item_id,
    }


class CreationRunCompleteIn(BaseModel):
    status: Literal["failed", "partial", "succeeded"]
    created_count: int = Field(ge=0)
    detail: dict = Field(default_factory=dict)


@router.post(
    "/creation-runs/{run_id}/complete",
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


async def _plan_out(db: AsyncSession, plan: DailyPlan) -> PlanOut:
    items = (await db.execute(
        select(DailyPlanItem).where(DailyPlanItem.plan_id == plan.id)
        .order_by(DailyPlanItem.account_id, DailyPlanItem.id)
    )).scalars().all()

    # 读时回填 draft_id：writer save_draft 之后 PipelineTask.draft_id 才有值
    dirty = False
    for it in items:
        if it.pipeline_task_id and it.draft_id is None:
            pt = await db.get(PipelineTask, it.pipeline_task_id)
            if pt is not None and pt.draft_id:
                it.draft_id = pt.draft_id
                dirty = True
    if dirty:
        await db.commit()

    names = dict((await db.execute(
        select(PublishAccount.id, PublishAccount.name)
    )).all())
    return PlanOut(
        id=plan.id, plan_date=plan.plan_date, status=plan.status,
        planner_note=plan.planner_note, kanban_task_id=plan.kanban_task_id,
        items=[ItemOut(
            id=it.id, account_id=it.account_id,
            account_name=names.get(it.account_id, it.account_id),
            title=it.title, angle=it.angle, reason=it.reason,
            content_type=it.content_type, sources=it.sources or [],
            group_key=it.group_key, is_primary=it.is_primary, status=it.status,
            pipeline_task_id=it.pipeline_task_id, draft_id=it.draft_id,
        ) for it in items],
    )


@router.get("/today", response_model=TodayOut)
async def get_today_plan(date: Optional[str] = None, db: AsyncSession = Depends(get_db)):
    from daily_planner import today_str
    target = date or today_str()
    plan = (await db.execute(
        select(DailyPlan).where(DailyPlan.plan_date == target)
    )).scalar_one_or_none()
    if plan is None:
        return TodayOut(plan=None)
    return TodayOut(plan=await _plan_out(db, plan))


class GenerateOut(BaseModel):
    plan_id: int
    status: str


class PlannedItemIn(BaseModel):
    account_id: str
    title: str
    angle: str = ""
    reason: str = ""
    content_type: str = "long"
    sources: list[dict] = []
    group_key: str = ""
    is_primary: bool = True


class PlanItemsIn(BaseModel):
    items: list[PlannedItemIn]
    note: str = ""


@router.post("/{plan_id}/items", response_model=PlanOut)
async def save_plan_items(plan_id: int, body: PlanItemsIn, db: AsyncSession = Depends(get_db)):
    """Persist a planner result through the normal HTTP boundary (worker-safe)."""
    plan = await db.get(DailyPlan, plan_id)
    if plan is None:
        raise HTTPException(404, "plan not found")
    account_ids = set((await db.execute(select(PublishAccount.id))).scalars().all())
    allowed_types = {"long", "short", "story", "share"}
    if not body.items:
        raise HTTPException(400, "items cannot be empty")
    for index, item in enumerate(body.items):
        if item.account_id not in account_ids:
            raise HTTPException(400, f"items[{index}]: unknown account")
        if not item.title.strip() or item.content_type not in allowed_types:
            raise HTTPException(400, f"items[{index}]: invalid title or content_type")
    await db.execute(sa_delete(DailyPlanItem).where(
        DailyPlanItem.plan_id == plan_id,
        DailyPlanItem.origin == "planner",
    ))
    for item in body.items:
        db.add(DailyPlanItem(
            plan_id=plan_id, account_id=item.account_id, title=item.title.strip(),
            angle=item.angle.strip(), reason=item.reason.strip(), content_type=item.content_type,
            sources=item.sources, group_key=item.group_key.strip(),
            is_primary=item.is_primary if item.group_key.strip() else True,
        ))
    plan.status = "ready"
    plan.planner_note = body.note.strip()
    await db.commit()
    await db.refresh(plan)
    return await _plan_out(db, plan)


@router.post("/generate", response_model=GenerateOut)
async def generate_plan():
    """重新生成今日计划（删除当天旧计划重建，页面「重新生成」按钮）。"""
    from daily_planner import create_today_plan
    try:
        plan = await create_today_plan(force=True)
    except Exception as e:
        raise HTTPException(503, f"策划任务创建失败: {e}")
    if plan is None:
        raise HTTPException(400, "无 active 账号或所有账号 daily_quota 为空，无法生成今日计划")
    return GenerateOut(plan_id=plan.id, status=plan.status)


@router.post("/items/{item_id}/skip")
async def toggle_skip(item_id: int, db: AsyncSession = Depends(get_db)):
    """suggested ↔ skipped 互切；已入队的不可跳过。"""
    it = await db.get(DailyPlanItem, item_id)
    if it is None:
        raise HTTPException(404, "item not found")
    if it.status == "enqueued":
        raise HTTPException(400, "已入队的选题不能跳过")
    it.status = "skipped" if it.status == "suggested" else "suggested"
    await db.commit()
    return {"id": it.id, "status": it.status}


class EnqueueItemsIn(BaseModel):
    item_ids: list[int]


class EnqueueItemsOut(BaseModel):
    enqueued_items: int
    chains: int
    task_ids: list[str]   # 每条链第一棒的 kanban task id


@router.post("/{plan_id}/enqueue", response_model=EnqueueItemsOut)
async def enqueue_items(plan_id: int, body: EnqueueItemsIn,
                        db: AsyncSession = Depends(get_db)):
    """把勾选的计划条目入队创作链。

    撞题组（同 group_key）只建一条链：优先用主笔（is_primary）账号的画像；
    主笔未被勾选时退化为组内第一个被勾选的账号。组内所有勾选条目共享同一
    pipeline_task_id（一稿多发）。仅 suggested 状态可入队。
    """
    from routers.studio import _account_profile_full, _run_pipeline_chain

    plan = await db.get(DailyPlan, plan_id)
    if plan is None:
        raise HTTPException(404, "plan not found")
    if not body.item_ids:
        raise HTTPException(400, "item_ids 不能为空")

    items = (await db.execute(
        select(DailyPlanItem).where(DailyPlanItem.plan_id == plan_id,
                                    DailyPlanItem.id.in_(body.item_ids))
        .order_by(DailyPlanItem.id)
    )).scalars().all()
    todo = [it for it in items if it.status == "suggested"]
    if not todo:
        raise HTTPException(400, "所选条目中没有可入队的（仅 suggested 状态可入队）")

    groups: dict[str, list[DailyPlanItem]] = {}
    group_accounts: dict[str, set[str]] = {}
    for it in todo:
        key = it.group_key or f"__solo_{it.id}"
        if it.group_key:
            accounts = group_accounts.setdefault(it.group_key, set())
            if it.account_id in accounts:
                key = f"__solo_{it.id}"
            accounts.add(it.account_id)
        groups.setdefault(key, []).append(it)

    first_task_ids: list[str] = []
    chains = 0
    for members in groups.values():
        leader = next((m for m in members if m.is_primary), members[0])
        acc = await db.get(PublishAccount, leader.account_id)
        if acc is None:
            raise HTTPException(400, f"account '{leader.account_id}' not found")

        sources_md = "\n".join(
            f"- [{s.get('platform', '?')}] {s.get('title', '')} [{s.get('url', '')}]"
            for s in (leader.sources or [])
        ) or "（无参考来源）"

        ctx = {
            "title": leader.title,
            "account_id": leader.account_id,
            "account_profile": _account_profile_full(acc),
            "content_type": leader.content_type,
            "content_type_label": _TYPE_LABEL.get(leader.content_type, leader.content_type),
            "word_range": _WORD_RANGE.get(leader.content_type, ""),
            "angle": leader.angle,
            "source_posts_md": sources_md,
            "draft_id": 0,
        }
        out = await _run_pipeline_chain("draft", ctx, account_id=leader.account_id,
                                        title=leader.title)
        chains += 1
        first_task_ids.append(out.task_id)
        for m in members:
            m.status = "enqueued"
            m.pipeline_task_id = out.pipeline_task_id
    await db.commit()

    return EnqueueItemsOut(enqueued_items=len(todo), chains=chains,
                           task_ids=first_task_ids)
