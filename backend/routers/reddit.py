from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, BackgroundTasks, Depends
from pydantic import BaseModel
from sqlalchemy import select, desc, delete, func
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import RedditSubscription, RedditPost

router = APIRouter(prefix="/reddit", tags=["reddit"])


# ── Schemas ────────────────────────────────────────────────────────────────────

class SubscriptionCreate(BaseModel):
    subreddit: str
    label: Optional[str] = None
    group: str = "未分组"


class SubscriptionUpdate(BaseModel):
    label: Optional[str] = None
    group: Optional[str] = None
    muted: Optional[bool] = None


class SubscriptionOut(BaseModel):
    id: int
    subreddit: str
    label: str
    group: str
    muted: bool
    last_collected_at: Optional[datetime] = None
    created_at: datetime
    post_count: int = 0

    model_config = {"from_attributes": True}


class PostOut(BaseModel):
    id: str
    post_id: str
    subscription_id: int
    title: str
    content: str
    url: str
    linked_url: str
    author: str
    subreddit: str
    flair: str
    score: int
    upvote_ratio: float
    comment_count: int
    is_self: bool
    published_at: datetime
    collected_at: datetime

    model_config = {"from_attributes": True}


# ── Helpers ────────────────────────────────────────────────────────────────────

async def _sub_out(db: AsyncSession, sub: RedditSubscription) -> SubscriptionOut:
    cnt = (await db.execute(
        select(func.count(RedditPost.id))
        .where(RedditPost.subscription_id == sub.id)
    )).scalar() or 0
    return SubscriptionOut(
        id=sub.id, subreddit=sub.subreddit, label=sub.label, group=sub.group,
        muted=sub.muted, last_collected_at=sub.last_collected_at,
        created_at=sub.created_at, post_count=int(cnt),
    )


# ── Subscriptions ──────────────────────────────────────────────────────────────

@router.get("/subscriptions", response_model=list[SubscriptionOut])
async def list_subscriptions(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(
        select(RedditSubscription).order_by(RedditSubscription.created_at)
    )).scalars().all()
    return [await _sub_out(db, r) for r in rows]


@router.post("/subscriptions", response_model=SubscriptionOut)
async def add_subscription(
    body: SubscriptionCreate,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    subreddit = body.subreddit.strip().lower().lstrip("r/")
    if not subreddit:
        raise HTTPException(400, "版块名不能为空")

    dup = (await db.execute(
        select(RedditSubscription).where(RedditSubscription.subreddit == subreddit)
    )).scalar_one_or_none()
    if dup:
        raise HTTPException(400, f"已订阅：r/{subreddit}")

    label = (body.label or "").strip() or f"r/{subreddit}"
    sub = RedditSubscription(subreddit=subreddit, label=label, group=body.group)
    db.add(sub)
    await db.commit()
    await db.refresh(sub)

    async def _initial_collect(sid: int):
        from database import SessionLocal
        from reddit_collector import collect_subscription
        async with SessionLocal() as s:
            row = await s.get(RedditSubscription, sid)
            if row:
                await collect_subscription(row, s)

    background_tasks.add_task(_initial_collect, sub.id)
    return await _sub_out(db, sub)


@router.patch("/subscriptions/{sub_id}", response_model=SubscriptionOut)
async def update_subscription(
    sub_id: int, body: SubscriptionUpdate,
    db: AsyncSession = Depends(get_db),
):
    sub = await db.get(RedditSubscription, sub_id)
    if not sub:
        raise HTTPException(404, "订阅不存在")
    if body.label is not None:
        sub.label = body.label
    if body.group is not None:
        sub.group = body.group
    if body.muted is not None:
        sub.muted = body.muted
    await db.commit()
    await db.refresh(sub)
    return await _sub_out(db, sub)


@router.delete("/subscriptions/{sub_id}")
async def delete_subscription(sub_id: int, db: AsyncSession = Depends(get_db)):
    sub = await db.get(RedditSubscription, sub_id)
    if not sub:
        raise HTTPException(404, "订阅不存在")
    await db.execute(delete(RedditPost).where(RedditPost.subscription_id == sub_id))
    await db.delete(sub)
    await db.commit()
    return {"ok": True}


@router.post("/subscriptions/{sub_id}/collect")
async def collect_one(
    sub_id: int,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    sub = await db.get(RedditSubscription, sub_id)
    if not sub:
        raise HTTPException(404, "订阅不存在")

    async def _run(sid: int):
        from database import SessionLocal
        from reddit_collector import collect_subscription
        async with SessionLocal() as s:
            row = await s.get(RedditSubscription, sid)
            if row:
                await collect_subscription(row, s)

    background_tasks.add_task(_run, sub_id)
    return {"ok": True}


# ── Posts ──────────────────────────────────────────────────────────────────────

@router.get("/posts", response_model=list[PostOut])
async def list_posts(
    subscription_id: Optional[int] = Query(None),
    view: str = Query("hot", pattern="^(hot|new|all)$"),
    days: int = Query(14, ge=1, le=365),
    limit: int = Query(100, le=500),
    search: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
):
    since = datetime.now(timezone.utc) - timedelta(days=days)
    order = desc(RedditPost.score) if view == "hot" else desc(RedditPost.published_at)
    q = (
        select(RedditPost)
        .where(RedditPost.published_at >= since)
        .order_by(order)
        .limit(limit)
    )
    if subscription_id is not None:
        q = q.where(RedditPost.subscription_id == subscription_id)
    if search:
        q = q.where(RedditPost.title.contains(search))
    return (await db.execute(q)).scalars().all()


# ── Collect all ────────────────────────────────────────────────────────────────

@router.post("/collect")
async def collect_all_endpoint(background_tasks: BackgroundTasks):
    async def _run():
        from database import SessionLocal
        from reddit_collector import collect_all
        from logger import log
        async with SessionLocal() as db:
            result = await collect_all(db)
        if result["errors"]:
            await log("reddit", "warn",
                      f"Reddit 采集完成，新增 {result['new_posts']} 条",
                      "; ".join(result["errors"]))
        else:
            await log("reddit", "ok", f"Reddit 采集完成，新增 {result['new_posts']} 条")

    background_tasks.add_task(_run)
    return {"ok": True, "message": "Reddit 采集任务已启动"}
