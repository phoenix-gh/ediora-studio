from fastapi import APIRouter, HTTPException, Query, BackgroundTasks, Depends
from sqlalchemy import select, desc, delete
from sqlalchemy.ext.asyncio import AsyncSession
from datetime import datetime, timezone, timedelta
from pydantic import BaseModel
from typing import Optional, Literal

from database import get_db
from models import V2exSubscription, V2exTopic

router = APIRouter(prefix="/v2ex", tags=["v2ex"])

KIND_LABELS = {"node": "节点", "user": "用户", "tab": "Tab", "all": "全站"}


# ── Schemas ────────────────────────────────────────────────────────────────────

class SubscriptionCreate(BaseModel):
    kind: Literal["node", "user", "tab", "all"]
    key: str = ""
    label: Optional[str] = None
    group: str = "未分组"


class SubscriptionUpdate(BaseModel):
    label: Optional[str] = None
    group: Optional[str] = None
    muted: Optional[bool] = None


class SubscriptionOut(BaseModel):
    id: int
    kind: str
    key: str
    label: str
    group: str
    muted: bool
    last_collected_at: Optional[datetime] = None
    created_at: datetime
    topic_count: int = 0

    model_config = {"from_attributes": True}


class TopicOut(BaseModel):
    id: str
    subscription_id: int
    topic_id: int
    title: str
    content: str
    url: str
    author: str
    author_url: str
    replies: int
    published_at: datetime
    collected_at: datetime

    model_config = {"from_attributes": True}


class PresetsOut(BaseModel):
    tabs: list[dict]
    nodes: list[dict]


# ── Presets ────────────────────────────────────────────────────────────────────

@router.get("/presets", response_model=PresetsOut)
async def get_presets():
    from v2ex_collector import PRESET_TABS, POPULAR_NODES
    return PresetsOut(
        tabs=[{"key": k, "label": v} for k, v in PRESET_TABS],
        nodes=[{"key": k, "label": v} for k, v in POPULAR_NODES],
    )


# ── Subscriptions ──────────────────────────────────────────────────────────────

@router.get("/subscriptions", response_model=list[SubscriptionOut])
async def list_subscriptions(db: AsyncSession = Depends(get_db)):
    from sqlalchemy import func
    rows = (await db.execute(
        select(V2exSubscription).order_by(V2exSubscription.created_at)
    )).scalars().all()
    if not rows:
        return []
    sub_ids = [r.id for r in rows]
    count_rows = (await db.execute(
        select(V2exTopic.subscription_id, func.count(V2exTopic.id))
        .where(V2exTopic.subscription_id.in_(sub_ids))
        .group_by(V2exTopic.subscription_id)
    )).all()
    counts = {sid: cnt for sid, cnt in count_rows}
    return [SubscriptionOut(
        id=r.id, kind=r.kind, key=r.key, label=r.label, group=r.group, muted=r.muted,
        last_collected_at=r.last_collected_at, created_at=r.created_at,
        topic_count=counts.get(r.id, 0),
    ) for r in rows]


@router.post("/subscriptions", response_model=SubscriptionOut)
async def add_subscription(
    body: SubscriptionCreate,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    from v2ex_collector import build_feed_url, fetch_feed

    key = body.key.strip()
    if body.kind != "all" and not key:
        raise HTTPException(400, "必须填写节点 / 用户 / Tab 标识")

    # Dedup: same kind+key already exists?
    dup = (await db.execute(
        select(V2exSubscription).where(
            V2exSubscription.kind == body.kind,
            V2exSubscription.key == key,
        )
    )).scalar_one_or_none()
    if dup:
        raise HTTPException(400, f"已订阅：{dup.label}")

    # Probe feed once to validate + grab the real title for label
    try:
        feed = await fetch_feed(body.kind, key)
    except Exception as e:
        raise HTTPException(400, f"无法获取 V2EX feed：{e}")

    label = (body.label or "").strip() or feed.get("title") or f"{KIND_LABELS.get(body.kind, body.kind)}/{key}"

    sub = V2exSubscription(kind=body.kind, key=key, label=label, group=body.group)
    db.add(sub)
    await db.commit()
    await db.refresh(sub)

    async def _initial_collect(sid: int):
        from database import SessionLocal
        from v2ex_collector import collect_subscription
        async with SessionLocal() as s:
            row = await s.get(V2exSubscription, sid)
            if row:
                await collect_subscription(row, s)

    background_tasks.add_task(_initial_collect, sub.id)
    return SubscriptionOut(
        id=sub.id, kind=sub.kind, key=sub.key, label=sub.label, group=sub.group,
        muted=sub.muted, last_collected_at=sub.last_collected_at, created_at=sub.created_at,
        topic_count=0,
    )


@router.patch("/subscriptions/{sub_id}", response_model=SubscriptionOut)
async def update_subscription(sub_id: int, body: SubscriptionUpdate, db: AsyncSession = Depends(get_db)):
    sub = await db.get(V2exSubscription, sub_id)
    if not sub:
        raise HTTPException(404, "Subscription not found")
    if body.label is not None: sub.label = body.label
    if body.group is not None: sub.group = body.group
    if body.muted is not None: sub.muted = body.muted
    await db.commit()
    await db.refresh(sub)
    return SubscriptionOut(
        id=sub.id, kind=sub.kind, key=sub.key, label=sub.label, group=sub.group,
        muted=sub.muted, last_collected_at=sub.last_collected_at, created_at=sub.created_at,
        topic_count=0,
    )


@router.delete("/subscriptions/{sub_id}")
async def delete_subscription(sub_id: int, db: AsyncSession = Depends(get_db)):
    sub = await db.get(V2exSubscription, sub_id)
    if not sub:
        raise HTTPException(404, "Subscription not found")
    await db.execute(delete(V2exTopic).where(V2exTopic.subscription_id == sub_id))
    await db.delete(sub)
    await db.commit()
    return {"ok": True}


@router.post("/subscriptions/{sub_id}/collect")
async def collect_subscription_now(sub_id: int, background_tasks: BackgroundTasks, db: AsyncSession = Depends(get_db)):
    sub = await db.get(V2exSubscription, sub_id)
    if not sub:
        raise HTTPException(404, "Subscription not found")

    async def _run(sid: int):
        from database import SessionLocal
        from v2ex_collector import collect_subscription
        async with SessionLocal() as s:
            row = await s.get(V2exSubscription, sid)
            if row:
                await collect_subscription(row, s)

    background_tasks.add_task(_run, sub_id)
    return {"ok": True}


# ── Topics ─────────────────────────────────────────────────────────────────────

@router.get("/topics", response_model=list[TopicOut])
async def list_topics(
    subscription_id: Optional[int] = Query(None),
    days: int = Query(14, ge=1, le=365),
    limit: int = Query(100, le=500),
    search: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
):
    since = datetime.now(timezone.utc) - timedelta(days=days)
    q = (
        select(V2exTopic)
        .where(V2exTopic.published_at >= since)
        .order_by(desc(V2exTopic.published_at))
        .limit(limit)
    )
    if subscription_id is not None:
        q = q.where(V2exTopic.subscription_id == subscription_id)
    if search:
        q = q.where(V2exTopic.title.contains(search))
    rows = (await db.execute(q)).scalars().all()
    return rows


# ── Collect-all ────────────────────────────────────────────────────────────────

@router.post("/collect")
async def collect_all_endpoint(background_tasks: BackgroundTasks):
    async def _run():
        from database import SessionLocal
        from v2ex_collector import collect_all
        from logger import log
        async with SessionLocal() as db:
            result = await collect_all(db)
        if result["errors"]:
            await log("v2ex", "warn", f"V2EX 采集完成，新增 {result['new_topics']} 条",
                      "; ".join(result["errors"]))
        else:
            await log("v2ex", "ok", f"V2EX 采集完成，新增 {result['new_topics']} 条")

    background_tasks.add_task(_run)
    return {"ok": True, "message": "V2EX 采集任务已启动"}
