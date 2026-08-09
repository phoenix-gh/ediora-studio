from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select, func, desc, delete
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import (
    AppSetting,
    CreativeAssetDirectory,
    XCredentialAccount,
    XPost,
    XSubscription,
    XSubscriptionIngestionDirectory,
)
from routers.x_accounts import ensure_x_credential_sessions

router = APIRouter(prefix="/x", tags=["x"])


# ─── Schemas ─────────────────────────────────────────────────────────────────

class SubscriptionOut(BaseModel):
    id: int
    url: Optional[str] = None
    label: str
    kind: str = "timeline"
    enabled: bool
    raw_query: str = ""
    min_faves: int = 0
    min_retweets: int = 0
    lang: str = ""
    days: int = 1
    extra_terms: str = ""
    sort: str = "top"
    max_results: int = 100
    collect_interval_minutes: int
    intelligence_enabled: bool = False
    intelligence_enabled_at: Optional[datetime] = None
    last_collected_at: Optional[datetime]
    last_error: str
    added_at: datetime
    post_count: int = 0
    ingestion_directory_ids: list[int] = Field(default_factory=list)
    model_config = {"from_attributes": True}


class SubscriptionCreate(BaseModel):
    kind: str = "timeline"
    url: Optional[str] = None
    label: Optional[str] = None
    raw_query: str = ""
    min_faves: int = 0
    min_retweets: int = 0
    lang: str = ""
    days: int = 1
    extra_terms: str = ""
    sort: str = "top"
    max_results: int = 100
    collect_interval_minutes: Optional[int] = Field(default=None, ge=5, le=1440)
    ingestion_directory_ids: list[int] = Field(default_factory=list)


class SubscriptionPatch(BaseModel):
    enabled: Optional[bool] = None
    label: Optional[str] = None
    raw_query: Optional[str] = None
    max_results: Optional[int] = None
    collect_interval_minutes: Optional[int] = Field(default=None, ge=5, le=1440)
    intelligence_enabled: Optional[bool] = None
    ingestion_directory_ids: Optional[list[int]] = None


class TimelineBackfillRequest(BaseModel):
    days: int = Field(default=7, ge=1, le=90)


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _default_label(url: str) -> str:
    url = url.strip().rstrip("/")
    if "/i/lists/" in url:
        return "list-" + url.rsplit("/", 1)[-1]
    return "@" + url.rsplit("/", 1)[-1]


async def _default_collect_interval(db: AsyncSession) -> int:
    value = await db.scalar(
        select(AppSetting.value).where(AppSetting.key == "x_collect_interval_minutes")
    )
    try:
        return max(5, min(1440, int(value))) if value is not None else 15
    except (TypeError, ValueError):
        return 15


async def _replace_ingestion_directories(
    db: AsyncSession,
    subscription_id: int,
    directory_ids: list[int],
) -> list[int]:
    unique_ids = list(dict.fromkeys(directory_ids))
    if unique_ids:
        directories = (await db.execute(
            select(CreativeAssetDirectory).where(
                CreativeAssetDirectory.id.in_(unique_ids),
            )
        )).scalars().all()
        by_id = {directory.id: directory for directory in directories}
        invalid = [
            directory_id for directory_id in unique_ids
            if directory_id not in by_id
            or by_id[directory_id].asset_type != "article"
            or not by_id[directory_id].ai_ingestion_enabled
            or not (by_id[directory_id].ai_ingestion_prompt or "").strip()
        ]
        if invalid:
            raise HTTPException(422, "只能选择已启用 AI 入库规则的文章目录")

    await db.execute(delete(XSubscriptionIngestionDirectory).where(
        XSubscriptionIngestionDirectory.subscription_id == subscription_id,
    ))
    db.add_all([
        XSubscriptionIngestionDirectory(
            subscription_id=subscription_id,
            directory_id=directory_id,
        )
        for directory_id in unique_ids
    ])
    return unique_ids


async def _to_out(db: AsyncSession, sub: XSubscription) -> SubscriptionOut:
    cnt = (await db.execute(
        select(func.count(XPost.tweet_id))
        .where(XPost.subscription_id == sub.id)
    )).scalar() or 0
    ingestion_directory_ids = list((await db.execute(
        select(XSubscriptionIngestionDirectory.directory_id)
        .where(XSubscriptionIngestionDirectory.subscription_id == sub.id)
        .order_by(XSubscriptionIngestionDirectory.id)
    )).scalars().all())
    return SubscriptionOut(
        id=sub.id, url=sub.url, label=sub.label, kind=sub.kind, enabled=sub.enabled,
        raw_query=sub.raw_query, min_faves=sub.min_faves, min_retweets=sub.min_retweets,
        lang=sub.lang, days=sub.days, extra_terms=sub.extra_terms, sort=sub.sort,
        max_results=sub.max_results,
        collect_interval_minutes=sub.collect_interval_minutes,
        intelligence_enabled=sub.intelligence_enabled,
        intelligence_enabled_at=sub.intelligence_enabled_at,
        last_collected_at=sub.last_collected_at, last_error=sub.last_error,
        added_at=sub.added_at, post_count=int(cnt),
        ingestion_directory_ids=ingestion_directory_ids,
    )


# ─── Endpoints ──────────────────────────────────────────────────────────────

@router.get("/subscriptions", response_model=list[SubscriptionOut])
async def list_subscriptions(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(
        select(XSubscription).order_by(desc(XSubscription.added_at))
    )).scalars().all()
    return [await _to_out(db, r) for r in rows]


@router.post("/subscriptions", response_model=SubscriptionOut)
async def create_subscription(
    body: SubscriptionCreate, db: AsyncSession = Depends(get_db),
):
    collect_interval_minutes = (
        body.collect_interval_minutes
        if body.collect_interval_minutes is not None
        else await _default_collect_interval(db)
    )
    if body.kind == "search":
        if not body.raw_query.strip():
            raise HTTPException(400, "搜索订阅需要 raw_query")
        label = body.label or f"搜索:{body.raw_query[:24]}"
        # Use X "Latest" product (sort=live): the "Top" product returns 0 for
        # many operator queries (e.g. with -filter:replies). Latest honors all
        # advanced operators and suits a subscription (recent matching posts).
        sub = XSubscription(
            kind="search", url=None, label=label, enabled=True,
            raw_query=body.raw_query.strip(), min_faves=body.min_faves,
            min_retweets=body.min_retweets, lang=body.lang, days=body.days,
            extra_terms=body.extra_terms, sort="live", max_results=body.max_results,
            collect_interval_minutes=collect_interval_minutes,
            added_at=datetime.now(timezone.utc),
        )
        db.add(sub)
        await db.flush()
        await _replace_ingestion_directories(
            db, sub.id, body.ingestion_directory_ids,
        )
        await db.commit()
        await db.refresh(sub)
        return await _to_out(db, sub)

    url = (body.url or "").strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "URL 必须以 http(s):// 开头")
    existing = (await db.execute(
        select(XSubscription).where(XSubscription.url == url)
    )).scalars().first()
    if existing:
        raise HTTPException(400, "该 URL 已订阅")

    if body.label:
        label = body.label
    else:
        # Best-effort live fetch of the real display name / list name.
        from feedgrab_client import resolve_subscription_label
        import asyncio
        label = await asyncio.to_thread(resolve_subscription_label, url)
        if not label:
            label = _default_label(url)

    sub = XSubscription(
        kind="timeline", url=url, label=label,
        enabled=True, collect_interval_minutes=collect_interval_minutes,
        added_at=datetime.now(timezone.utc),
    )
    db.add(sub)
    await db.flush()
    await _replace_ingestion_directories(
        db, sub.id, body.ingestion_directory_ids,
    )
    await db.commit()
    await db.refresh(sub)
    return await _to_out(db, sub)


@router.patch("/subscriptions/{sub_id}", response_model=SubscriptionOut)
async def patch_subscription(
    sub_id: int, body: SubscriptionPatch,
    db: AsyncSession = Depends(get_db),
):
    sub = await db.get(XSubscription, sub_id)
    if not sub:
        raise HTTPException(404, "订阅不存在")
    if body.enabled is not None:
        sub.enabled = body.enabled
    if body.label is not None:
        sub.label = body.label
    if body.raw_query is not None:
        if sub.kind != "search":
            raise HTTPException(400, "时间线订阅没有搜索规则可改")
        rq = body.raw_query.strip()
        if not rq:
            raise HTTPException(400, "搜索订阅需要 raw_query")
        sub.raw_query = rq
    if body.max_results is not None:
        sub.max_results = max(1, min(500, body.max_results))
    if body.collect_interval_minutes is not None:
        sub.collect_interval_minutes = body.collect_interval_minutes
    if body.intelligence_enabled is not None and body.intelligence_enabled != sub.intelligence_enabled:
        sub.intelligence_enabled = body.intelligence_enabled
        # 只在开启时刻起算，避免把开启前积压的旧帖送入情报站。
        sub.intelligence_enabled_at = (
            datetime.now(timezone.utc) if body.intelligence_enabled else None
        )
    if body.ingestion_directory_ids is not None:
        await _replace_ingestion_directories(
            db, sub.id, body.ingestion_directory_ids,
        )
    await db.commit()
    await db.refresh(sub)
    return await _to_out(db, sub)


@router.delete("/subscriptions/{sub_id}")
async def delete_subscription(
    sub_id: int, db: AsyncSession = Depends(get_db),
):
    sub = await db.get(XSubscription, sub_id)
    if not sub:
        raise HTTPException(404, "订阅不存在")
    await db.execute(delete(XSubscriptionIngestionDirectory).where(
        XSubscriptionIngestionDirectory.subscription_id == sub_id,
    ))
    await db.execute(delete(XPost).where(XPost.subscription_id == sub_id))
    await db.delete(sub)
    await db.commit()
    return {"ok": True}


# ─── Posts ───────────────────────────────────────────────────────────────────

from datetime import timedelta

from sqlalchemy.dialects.postgresql import insert as _pg_insert


class PostOut(BaseModel):
    tweet_id: str
    subscription_id: int
    username: str
    display_name: str
    content: str
    url: str
    published_at: datetime
    collected_at: datetime
    replies: int
    reposts: int
    likes: int
    views: int
    author_avatar: str = ""
    cover_image: str = ""
    is_reply: bool = False
    model_config = {"from_attributes": True}


@router.get("/posts", response_model=list[PostOut])
async def list_posts(
    subscription_id: Optional[int] = None,
    hours: int = 168,
    limit: int = 200,
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
):
    hours = max(1, min(hours, 720))
    limit = max(1, min(limit, 500))
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    q = (
        select(XPost)
        .where(XPost.published_at >= since)
        .order_by(desc(XPost.published_at))
        .limit(limit).offset(offset)
    )
    if subscription_id is not None:
        q = q.where(XPost.subscription_id == subscription_id)
    rows = (await db.execute(q)).scalars().all()
    return rows


# ─── Upsert helper ──────────────────────────────────────────────────────────

def _upsert_post_stmt(db: AsyncSession, sub_id: int, p):
    stmt = _pg_insert(XPost).values(
        tweet_id=p.tweet_id, subscription_id=sub_id,
        username=p.username, display_name=p.display_name,
        content=p.content, url=p.url,
        published_at=p.published_at,
        collected_at=datetime.now(timezone.utc),
        replies=p.replies, reposts=p.reposts,
        likes=p.likes, views=p.views,
        author_avatar=p.author_avatar, cover_image=p.cover_image,
        possibly_sensitive=getattr(p, "possibly_sensitive", False),
        is_reply=getattr(p, "is_reply", False),
        raw_markdown=p.raw_markdown,
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=["tweet_id"],
        set_={
            "replies": stmt.excluded.replies,
            "reposts": stmt.excluded.reposts,
            "likes": stmt.excluded.likes,
            "views": stmt.excluded.views,
            "author_avatar": stmt.excluded.author_avatar,
            "cover_image": stmt.excluded.cover_image,
            "collected_at": stmt.excluded.collected_at,
            "is_reply": stmt.excluded.is_reply,
        },
    )
    return stmt


# ─── Collect ────────────────────────────────────────────────────────────────

from feedgrab_client import grab_timeline, search_x, search_top, auth_status


async def _compute_collect_cutoff(db: AsyncSession, sub_id: int) -> datetime:
    """First-time collect → last 24h. Subsequent collects → hour-aligned
    timestamp of latest stored post (re-includes the partial hour so newer
    tweets posted in the same hour as the previous run are not missed).
    """
    latest = (await db.execute(
        select(func.max(XPost.published_at))
        .where(XPost.subscription_id == sub_id)
    )).scalar()
    if latest is None:
        return datetime.now(timezone.utc) - timedelta(hours=24)
    if latest.tzinfo is None:
        latest = latest.replace(tzinfo=timezone.utc)
    return latest.replace(minute=0, second=0, microsecond=0)


async def _collect_one(
    db: AsyncSession,
    sub: XSubscription,
    cutoff: datetime | None = None,
) -> int:
    try:
        if sub.kind == "search":
            posts = await search_top(
                raw_query=sub.raw_query, min_faves=sub.min_faves,
                min_retweets=sub.min_retweets, lang=sub.lang, days=sub.days,
                extra_terms=sub.extra_terms, sort=sub.sort, limit=sub.max_results,
            )
        else:
            # Cutoff is pushed into feedgrab's paginator so it stops fetching
            # once it crosses the boundary — no after-the-fact filtering needed.
            effective_cutoff = cutoff or await _compute_collect_cutoff(db, sub.id)
            posts = await grab_timeline(sub.url, since=effective_cutoff)
    except Exception as e:
        sub.last_error = str(e)[:500]
        await db.commit()
        raise
    fetched_ids = [p.tweet_id for p in posts]
    existing_ids: set[str] = set()
    if fetched_ids:
        existing_ids = set((await db.execute(
            select(XPost.tweet_id).where(XPost.tweet_id.in_(fetched_ids))
        )).scalars().all())
    fresh_ids = [tweet_id for tweet_id in fetched_ids if tweet_id not in existing_ids]
    for p in posts:
        await db.execute(_upsert_post_stmt(db, sub.id, p))
    sub.last_collected_at = datetime.now(timezone.utc)
    sub.last_error = ""
    await db.commit()
    if fresh_ids:
        from content_response_service import dispatch_intelligence_posts
        dispatch = await dispatch_intelligence_posts(db, sub, fresh_ids)
        if dispatch["errors"]:
            from logger import log
            await log(
                "content_response_analysis",
                "warn",
                f"{sub.label} 新帖已入库，但情报站分析任务入队失败",
                "; ".join(dispatch["errors"]),
            )
        from topic_source_service import dispatch_topic_source_posts
        topic_dispatch = await dispatch_topic_source_posts(db, sub.id, fresh_ids)
        if topic_dispatch["errors"]:
            from logger import log
            await log(
                "topic_source",
                "warn",
                f"{sub.label} 新帖已入库，但主题素材甄选任务入队失败",
                "; ".join(topic_dispatch["errors"]),
            )
    return len(fresh_ids)


@router.post("/subscriptions/{sub_id}/collect-sync")
async def collect_one_sync(sub_id: int, db: AsyncSession = Depends(get_db)):
    sub = await db.get(XSubscription, sub_id)
    if not sub:
        raise HTTPException(404, "订阅不存在")
    try:
        await ensure_x_credential_sessions(db)
        n = await _collect_one(db, sub)
    except Exception as e:
        raise HTTPException(502, str(e))
    return {"ok": True, "new_posts": n}


@router.post("/subscriptions/{sub_id}/collect")
async def collect_one(sub_id: int, db: AsyncSession = Depends(get_db)):
    """Reserved for future BG variant; currently same as collect-sync."""
    return await collect_one_sync(sub_id, db)


@router.post("/subscriptions/{sub_id}/backfill")
async def backfill_timeline_subscription(
    sub_id: int,
    body: TimelineBackfillRequest,
    db: AsyncSession = Depends(get_db),
):
    sub = await db.get(XSubscription, sub_id)
    if not sub:
        raise HTTPException(404, "订阅不存在")
    if sub.kind != "timeline":
        raise HTTPException(422, "仅个人账号订阅支持回溯采集")
    cutoff = datetime.now(timezone.utc) - timedelta(days=body.days)
    try:
        await ensure_x_credential_sessions(db)
        new_posts = await _collect_one(db, sub, cutoff=cutoff)
    except Exception as e:
        raise HTTPException(502, str(e))
    return {"ok": True, "new_posts": new_posts}


@router.post("/collect-all")
async def collect_all(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(
        select(XSubscription).where(XSubscription.enabled == True)
    )).scalars().all()
    try:
        await ensure_x_credential_sessions(db)
    except Exception as e:
        raise HTTPException(502, str(e))
    new_total = 0
    failed: list[str] = []
    for sub in rows:
        try:
            new_total += await _collect_one(db, sub)
        except Exception as e:
            failed.append(f"{sub.label}: {e}")
    return {"ok": True, "checked": len(rows),
            "new_posts": new_total, "failed": failed}


# ─── Search & auth ───────────────────────────────────────────────────────────

class SearchPostOut(BaseModel):
    tweet_id: str
    username: str
    display_name: str
    content: str
    url: str
    published_at: datetime
    replies: int
    reposts: int
    likes: int
    views: int
    author_avatar: str = ""
    cover_image: str = ""


@router.get("/search", response_model=list[SearchPostOut])
async def search(q: str, limit: int = 20):
    limit = max(1, min(limit, 50))
    try:
        posts = await search_x(q, limit=limit)
    except Exception as e:
        raise HTTPException(502, str(e))
    return [
        SearchPostOut(
            tweet_id=p.tweet_id, username=p.username, display_name=p.display_name,
            content=p.content, url=p.url, published_at=p.published_at,
            replies=p.replies, reposts=p.reposts, likes=p.likes, views=p.views,
            author_avatar=p.author_avatar, cover_image=p.cover_image,
        ) for p in posts
    ]


@router.get("/auth-status")
async def get_auth_status(db: AsyncSession = Depends(get_db)):
    managed_slots = set((await db.execute(
        select(XCredentialAccount.credential_slot)
    )).scalars())
    return auth_status(managed_slots)
