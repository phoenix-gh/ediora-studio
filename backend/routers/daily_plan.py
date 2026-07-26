"""今日内容计划：查询 / 重新生成 / 跳过 / 入队。"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete as sa_delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import DailyPlan, DailyPlanItem, PipelineTask, PublishAccount

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
    await db.execute(sa_delete(DailyPlanItem).where(DailyPlanItem.plan_id == plan_id))
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
