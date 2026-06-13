"""今日内容计划：查询 / 重新生成 / 跳过 / 入队。"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import DailyPlan, DailyPlanItem, PipelineTask, PublishAccount

router = APIRouter(prefix="/daily-plan", tags=["daily-plan"])


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
