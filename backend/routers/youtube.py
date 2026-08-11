from fastapi import APIRouter, HTTPException, Query, BackgroundTasks, Depends
from sqlalchemy import select, desc, delete
from sqlalchemy.ext.asyncio import AsyncSession
from datetime import datetime, timezone, timedelta
from pydantic import BaseModel
from typing import Optional

from database import get_db
from models import ContentResponseItem, YoutubeChannel, YoutubeVideo
from worker_auth import require_worker_token

router = APIRouter(prefix="/youtube", tags=["youtube"])


# ── Schemas ────────────────────────────────────────────────────────────────────

class ChannelCreate(BaseModel):
    channel_id: str
    group: str = "未分组"
    auto_analyze_new_videos: bool = True


class ChannelUpdate(BaseModel):
    group: Optional[str] = None
    muted: Optional[bool] = None
    note: Optional[str] = None
    auto_analyze_new_videos: Optional[bool] = None


class ChannelOut(BaseModel):
    id: str
    name: str
    avatar_url: str
    description: str
    description_cn: str
    note: str
    group: str
    muted: bool
    auto_analyze_new_videos: bool
    analysis_enabled_at: Optional[datetime] = None
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
    transcript_status: str
    transcript_source: str
    transcript_language: str
    transcript_error_code: str
    transcript_error: str
    response_item_id: Optional[int] = None
    analysis_status: Optional[str] = None

    model_config = {"from_attributes": True}


def video_list_payload(video: YoutubeVideo, item: ContentResponseItem | None) -> dict:
    return {
        **{
            field: getattr(video, field)
            for field in VideoOut.model_fields
            if field not in {"response_item_id", "analysis_status"}
        },
        "response_item_id": item.id if item else None,
        "analysis_status": item.workflow_status if item else None,
    }


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
        auto_analyze_new_videos=body.auto_analyze_new_videos,
        analysis_enabled_at=datetime.now(timezone.utc) if body.auto_analyze_new_videos else None,
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
    if body.auto_analyze_new_videos is not None:
        if body.auto_analyze_new_videos and not channel.auto_analyze_new_videos:
            channel.analysis_enabled_at = datetime.now(timezone.utc)
        channel.auto_analyze_new_videos = body.auto_analyze_new_videos
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
        select(YoutubeVideo, ContentResponseItem)
        .outerjoin(
            ContentResponseItem,
            (ContentResponseItem.source_type == "youtube_video")
            & (ContentResponseItem.source_id == YoutubeVideo.id),
        )
        .where(YoutubeVideo.published_at >= since)
        .order_by(desc(YoutubeVideo.published_at))
        .limit(limit)
    )
    if channel_id:
        q = q.where(YoutubeVideo.channel_id == channel_id)
    if search:
        q = q.where(YoutubeVideo.title.contains(search))
    rows = (await db.execute(q)).all()
    return [video_list_payload(video, item) for video, item in rows]


@router.post("/videos/{video_id}/analyze")
async def analyze_video(
    video_id: str,
    force: bool = False,
    db: AsyncSession = Depends(get_db),
):
    from content_response_service import create_analysis_run, ensure_response_item
    from job_queue import enqueue_job

    if await db.get(YoutubeVideo, video_id) is None:
        raise HTTPException(404, "Video not found")
    item, _ = await ensure_response_item(db, "youtube_video", video_id)
    await db.commit()
    run, job, created = await create_analysis_run(db, item, force=force)
    if created:
        await enqueue_job(job.id)
    return {
        "response_item_id": item.id,
        "analysis_run_id": run.id,
        "job_id": job.id,
        "created": created,
    }


def _transcript_version_payload(
    source: str,
    language: str,
    text: str,
    segments: list[dict],
    content_hash: str,
) -> dict:
    stored = {
        "source": source,
        "language": language,
        "text": text,
        "segments": segments,
        "content_hash": content_hash,
    }
    if not segments:
        return stored
    from youtube_transcript import build_transcript

    normalized = build_transcript(source, language, segments)
    if normalized["text"] == text and normalized["segments"] == segments:
        return stored
    return normalized


def transcript_payload(video: YoutubeVideo) -> dict:
    original = _transcript_version_payload(
        video.transcript_source,
        video.transcript_language,
        video.transcript_text,
        video.transcript_segments,
        video.transcript_content_hash,
    )
    chinese = None
    if video.transcript_zh_text or video.transcript_zh_segments:
        chinese = _transcript_version_payload(
            video.transcript_zh_source,
            video.transcript_zh_language,
            video.transcript_zh_text,
            video.transcript_zh_segments,
            video.transcript_zh_content_hash,
        )
    return {
        "status": video.transcript_status,
        **original,
        "fetched_at": video.transcript_fetched_at,
        "error_code": video.transcript_error_code,
        "error": video.transcript_error,
        "chinese": chinese,
    }


@router.get("/videos/{video_id}/transcript")
async def get_video_transcript(video_id: str, db: AsyncSession = Depends(get_db)):
    video = await db.get(YoutubeVideo, video_id)
    if video is None:
        raise HTTPException(404, "Video not found")
    return transcript_payload(video)


@router.post("/videos/{video_id}/transcript/retry")
async def retry_video_transcript(video_id: str, db: AsyncSession = Depends(get_db)):
    video = await db.get(YoutubeVideo, video_id)
    if video is None:
        raise HTTPException(404, "Video not found")
    video.transcript_status = "queued"
    video.transcript_error_code = ""
    video.transcript_error = ""
    await db.commit()
    return await analyze_video(video_id, force=True, db=db)


@router.post(
    "/videos/{video_id}/extract-transcript",
    dependencies=[Depends(require_worker_token)],
)
async def extract_video_transcript(video_id: str, db: AsyncSession = Depends(get_db)):
    from config import get_config
    from youtube_transcript import TranscriptError, extract_youtube_transcript

    video = await db.get(YoutubeVideo, video_id)
    if video is None:
        raise HTTPException(404, "Video not found")
    if video.transcript_status == "ready" and video.transcript_text:
        return await get_video_transcript(video_id, db)
    video.transcript_status = "extracting"
    await db.commit()
    try:
        result = await extract_youtube_transcript(video.url, await get_config())
    except TranscriptError as exc:
        video.transcript_status = "failed"
        video.transcript_error_code = exc.code
        video.transcript_error = str(exc)[:500]
        await db.commit()
        headers = {"X-WMS-Retryable": "true" if exc.retryable else "false"}
        raise HTTPException(422, str(exc), headers=headers) from exc
    video.transcript_status = "ready"
    video.transcript_source = result["source"]
    video.transcript_language = result["language"]
    video.transcript_text = result["text"]
    video.transcript_segments = result["segments"]
    video.transcript_content_hash = result["content_hash"]
    chinese = result.get("chinese") or {}
    video.transcript_zh_source = chinese.get("source", "")
    video.transcript_zh_language = chinese.get("language", "")
    video.transcript_zh_text = chinese.get("text", "")
    video.transcript_zh_segments = chinese.get("segments", [])
    video.transcript_zh_content_hash = chinese.get("content_hash", "")
    video.transcript_fetched_at = datetime.now(timezone.utc)
    video.transcript_error_code = ""
    video.transcript_error = ""
    await db.commit()
    return await get_video_transcript(video_id, db)


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
