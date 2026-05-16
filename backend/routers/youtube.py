from fastapi import APIRouter, HTTPException, Query, BackgroundTasks, Depends
from sqlalchemy import select, desc, delete
from sqlalchemy.ext.asyncio import AsyncSession
from datetime import datetime, timezone, timedelta
from pydantic import BaseModel
from typing import Optional

from database import get_db
from models import YoutubeChannel, YoutubeVideo

router = APIRouter(prefix="/youtube", tags=["youtube"])


# ── Schemas ────────────────────────────────────────────────────────────────────

class ChannelCreate(BaseModel):
    channel_id: str
    group: str = "未分组"


class ChannelUpdate(BaseModel):
    group: Optional[str] = None
    muted: Optional[bool] = None
    note: Optional[str] = None


class ChannelOut(BaseModel):
    id: str
    name: str
    avatar_url: str
    description: str
    description_cn: str
    note: str
    group: str
    muted: bool
    last_collected_at: Optional[datetime] = None
    created_at: datetime

    model_config = {"from_attributes": True}


class VideoOut(BaseModel):
    id: str
    channel_id: str
    channel_name: str
    title: str
    url: str
    thumbnail_url: str
    description: str
    views: int
    published_at: datetime
    updated_at: datetime
    collected_at: datetime

    model_config = {"from_attributes": True}


# ── Channels ───────────────────────────────────────────────────────────────────

@router.get("/channels", response_model=list[ChannelOut])
async def list_channels(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(
        select(YoutubeChannel).order_by(YoutubeChannel.created_at)
    )).scalars().all()
    return rows


@router.post("/channels", response_model=ChannelOut)
async def add_channel(
    body: ChannelCreate,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    existing = await db.get(YoutubeChannel, body.channel_id)
    if existing:
        raise HTTPException(400, f"Channel {body.channel_id} is already subscribed")

    from youtube_collector import fetch_channel_feed
    try:
        data = await fetch_channel_feed(body.channel_id)
        name = data["name"]
    except Exception as e:
        raise HTTPException(400, f"Failed to fetch channel feed: {e}")

    channel = YoutubeChannel(
        id=body.channel_id,
        name=name,
        group=body.group,
    )
    db.add(channel)
    await db.commit()
    await db.refresh(channel)

    async def _initial_collect(cid: str):
        from youtube_collector import collect_channel_by_id
        await collect_channel_by_id(cid)

    background_tasks.add_task(_initial_collect, body.channel_id)
    return channel


@router.patch("/channels/{channel_id}", response_model=ChannelOut)
async def update_channel(
    channel_id: str,
    body: ChannelUpdate,
    db: AsyncSession = Depends(get_db),
):
    channel = await db.get(YoutubeChannel, channel_id)
    if not channel:
        raise HTTPException(404, "Channel not found")
    if body.group is not None:
        channel.group = body.group
    if body.muted is not None:
        channel.muted = body.muted
    if body.note is not None:
        channel.note = body.note
    await db.commit()
    await db.refresh(channel)
    return channel


@router.delete("/channels/{channel_id}")
async def delete_channel(channel_id: str, db: AsyncSession = Depends(get_db)):
    channel = await db.get(YoutubeChannel, channel_id)
    if not channel:
        raise HTTPException(404, "Channel not found")
    await db.execute(delete(YoutubeVideo).where(YoutubeVideo.channel_id == channel_id))
    await db.delete(channel)
    await db.commit()
    return {"ok": True}


# ── Videos ─────────────────────────────────────────────────────────────────────

@router.get("/videos", response_model=list[VideoOut])
async def list_videos(
    channel_id: Optional[str] = Query(None),
    days: int = Query(30, ge=1, le=365),
    limit: int = Query(100, le=500),
    search: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
):
    since = datetime.now(timezone.utc) - timedelta(days=days)
    q = (
        select(YoutubeVideo)
        .where(YoutubeVideo.published_at >= since)
        .order_by(desc(YoutubeVideo.published_at))
        .limit(limit)
    )
    if channel_id:
        q = q.where(YoutubeVideo.channel_id == channel_id)
    if search:
        q = q.where(YoutubeVideo.title.contains(search))
    rows = (await db.execute(q)).scalars().all()
    return rows


# ── Collect ────────────────────────────────────────────────────────────────────

@router.post("/collect")
async def collect_all(background_tasks: BackgroundTasks):
    async def _run():
        from youtube_collector import collect_all_channels
        await collect_all_channels()

    background_tasks.add_task(_run)
    return {"ok": True, "message": "YouTube 采集任务已启动"}


@router.post("/channels/{channel_id}/collect")
async def collect_channel_now(channel_id: str, background_tasks: BackgroundTasks):
    async def _run(cid: str):
        from youtube_collector import collect_channel_by_id
        await collect_channel_by_id(cid)

    background_tasks.add_task(_run, channel_id)
    return {"ok": True}
