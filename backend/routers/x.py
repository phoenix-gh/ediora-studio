from fastapi import APIRouter, Query, BackgroundTasks, HTTPException
from pydantic import BaseModel
from typing import Optional
from datetime import datetime, timezone, timedelta
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession
from fastapi import Depends

from database import get_db, SessionLocal
from models import XBloggerCandidate, XPost, XPostMetrics

router = APIRouter(prefix="/x", tags=["x"])


class CandidateOut(BaseModel):
    username: str
    display_name: str
    avatar_url: str
    followers: int
    bio: str
    profile_url: str
    status: str
    added_at: datetime
    last_seen_at: datetime

    model_config = {"from_attributes": True}


class CandidateUpdate(BaseModel):
    status: Optional[str] = None   # candidate / following / rejected


@router.get("/candidates", response_model=list[CandidateOut])
async def list_candidates(
    status: Optional[str] = Query(None),
    limit: int = Query(100, le=500),
    db: AsyncSession = Depends(get_db),
):
    q = (
        select(XBloggerCandidate)
        .order_by(desc(XBloggerCandidate.followers))
        .limit(limit)
    )
    if status:
        q = q.where(XBloggerCandidate.status == status)
    rows = (await db.execute(q)).scalars().all()
    return rows


@router.patch("/candidates/{username}", response_model=CandidateOut)
async def update_candidate(
    username: str,
    body: CandidateUpdate,
    db: AsyncSession = Depends(get_db),
):
    row = await db.get(XBloggerCandidate, username)
    if not row:
        raise HTTPException(404, "Not found")
    if body.status:
        row.status = body.status
    await db.commit()
    await db.refresh(row)
    return row


@router.delete("/candidates/{username}")
async def delete_candidate(username: str, db: AsyncSession = Depends(get_db)):
    row = await db.get(XBloggerCandidate, username)
    if not row:
        raise HTTPException(404, "Not found")
    await db.delete(row)
    await db.commit()
    return {"ok": True}


@router.post("/open-login")
async def open_login():
    """Open x.com/login in camofox — user completes login via VNC."""
    from x_collector import open_login_session
    return await open_login_session()


@router.post("/open-timeline")
async def open_timeline():
    """Inject stored cookies and open x.com/home in camofox."""
    from x_collector import open_timeline_session
    return await open_timeline_session()


@router.post("/import-session")
async def import_session():
    """
    After VNC login, pull storage_state from camofox and save cookies to config.
    """
    from x_collector import import_session_from_camofox
    return await import_session_from_camofox()


@router.post("/collect")
async def trigger_collect(background_tasks: BackgroundTasks):
    """Manually trigger X timeline collection."""
    async def _run():
        from x_collector import collect_x_timeline
        from logger import log
        async with SessionLocal() as db:
            result = await collect_x_timeline(db)
        if result["error"]:
            await log("x", "error", "X 采集异常", result["error"])
        else:
            await log("x", "ok",
                      f"检查 {result['checked']} 个账号，新增候选 {result['new_candidates']} 个，"
                      f"新帖 {result.get('new_posts', 0)} 条")
    background_tasks.add_task(_run)
    return {"ok": True, "message": "X 采集任务已启动"}


@router.post("/import-cookies")
async def import_cookies(body: dict):
    """Import X cookies into camofox session (pass raw cookie JSON array)."""
    import json
    from x_collector import import_x_cookies
    cookies_str = json.dumps(body.get("cookies", []))
    result = await import_x_cookies(cookies_str)
    return result


# ── Posts & metrics ────────────────────────────────────────────────────────────

class PostOut(BaseModel):
    tweet_id: str
    username: str
    content: str
    url: str
    published_at: datetime
    collected_at: datetime
    model_config = {"from_attributes": True}


class MetricsPoint(BaseModel):
    collected_at: datetime
    replies: int
    reposts: int = 0
    likes: int
    views: int
    model_config = {"from_attributes": True}


VIRAL_RATIO = 1.5  # views / author_followers threshold

class PostWithMetrics(BaseModel):
    tweet_id: str
    username: str
    display_name: str
    content: str
    url: str
    published_at: datetime
    author_followers: int
    latest_replies: int
    latest_reposts: int
    latest_likes: int
    latest_views: int
    is_viral: bool
    metrics_history: list[MetricsPoint]


@router.get("/posts", response_model=list[PostWithMetrics])
async def list_posts(
    hours: int = Query(24, le=168),
    username: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
):
    """Return recent posts with full metrics history."""
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    q = select(XPost).where(XPost.published_at >= since).order_by(desc(XPost.published_at))
    if username:
        q = q.where(XPost.username == username.lstrip("@").lower())
    posts = (await db.execute(q)).scalars().all()

    # Batch-fetch display names from candidates table
    usernames = list({p.username for p in posts})
    name_rows = (await db.execute(
        select(XBloggerCandidate.username, XBloggerCandidate.display_name)
        .where(XBloggerCandidate.username.in_(usernames))
    )).all()
    display_names = {r.username: r.display_name for r in name_rows}

    result = []
    for post in posts:
        metrics_rows = (await db.execute(
            select(XPostMetrics)
            .where(XPostMetrics.tweet_id == post.tweet_id)
            .order_by(XPostMetrics.collected_at)
        )).scalars().all()

        latest = metrics_rows[-1] if metrics_rows else None
        lv = latest.views if latest else 0
        af = post.author_followers
        result.append(PostWithMetrics(
            tweet_id=post.tweet_id,
            username=post.username,
            display_name=display_names.get(post.username, ""),
            content=post.content,
            url=post.url,
            published_at=post.published_at,
            author_followers=af,
            latest_replies=latest.replies if latest else 0,
            latest_reposts=latest.reposts if latest else 0,
            latest_likes=latest.likes if latest else 0,
            latest_views=lv,
            is_viral=bool(af > 0 and lv > af * VIRAL_RATIO),
            metrics_history=[MetricsPoint.model_validate(m) for m in metrics_rows],
        ))
    return result


@router.get("/posts/{tweet_id}/metrics", response_model=list[MetricsPoint])
async def get_post_metrics(tweet_id: str, db: AsyncSession = Depends(get_db)):
    """Return full metrics history for a single post."""
    rows = (await db.execute(
        select(XPostMetrics)
        .where(XPostMetrics.tweet_id == tweet_id)
        .order_by(XPostMetrics.collected_at)
    )).scalars().all()
    return rows

