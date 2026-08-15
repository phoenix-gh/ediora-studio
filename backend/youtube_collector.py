import re
import feedparser
import httpx
from datetime import datetime, timezone
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from collection_proxy import collection_client_kwargs
from models import YoutubeChannel, YoutubeVideo


def _feed_url(channel_id: str) -> str:
    return f"https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}"


def _struct_to_dt(t) -> datetime | None:
    """Convert a feedparser time.struct_time (UTC) to datetime."""
    if t is None:
        return None
    try:
        import calendar
        return datetime.fromtimestamp(calendar.timegm(t), tz=timezone.utc)
    except Exception:
        return None


async def _fetch_channel_profile(channel_id: str, client: httpx.AsyncClient) -> dict:
    """Fetch channel avatar and description from the channel page og meta tags."""
    import html as html_lib
    url = f"https://www.youtube.com/channel/{channel_id}"
    try:
        resp = await client.get(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"})
        html_text = resp.text

        avatar_url = ""
        # Match both attribute orderings
        for pat in [
            'property="og:image" content="([^"]+)"',
            'content="([^"]+)" property="og:image"',
        ]:
            m = re.search(pat, html_text)
            if m:
                avatar_url = m.group(1)
                break

        description = ""
        for pat in [
            'name="description" content="([^"]+)"',
            'content="([^"]+)" name="description"',
            'property="og:description" content="([^"]+)"',
        ]:
            m = re.search(pat, html_text)
            if m:
                description = html_lib.unescape(m.group(1))
                break

        return {"avatar_url": avatar_url, "description": description}
    except Exception as e:
        print(f"[youtube] profile fetch failed for {channel_id}: {e}")
        return {"avatar_url": "", "description": ""}


async def _translate_description(text: str) -> str:
    """Translate channel description to Chinese using LLM."""
    if not text or not text.strip():
        return ""
    try:
        import llm
        result = await llm._call(
            f"将以下 YouTube 频道简介翻译成中文，保持原意，语言自然流畅，直接输出译文，不要添加任何说明：\n\n{text[:1000]}",
            max_tokens=800,
        )
        return result.strip()
    except Exception:
        return ""


async def fetch_channel_feed(channel_id: str) -> dict:
    """Fetch RSS feed + channel profile for a channel.

    Returns {"name", "avatar_url", "description", "description_cn", "videos"}.
    """
    async with httpx.AsyncClient(**await collection_client_kwargs(
        timeout=20,
        follow_redirects=True,
    )) as client:
        feed_resp = await client.get(_feed_url(channel_id))
        feed_resp.raise_for_status()
        profile = await _fetch_channel_profile(channel_id, client)

    feed = feedparser.parse(feed_resp.text)
    if feed.get("bozo") and not feed.entries:
        raise ValueError(f"Failed to parse feed for channel {channel_id}")

    raw_title: str = feed.feed.get("title", channel_id)
    name = raw_title.removesuffix(" - YouTube").strip() or channel_id

    description_cn = await _translate_description(profile["description"])

    videos = []
    for entry in feed.entries:
        eid = entry.get("id", "")
        video_id = eid.split(":")[-1] if ":" in eid else eid
        if not video_id:
            continue

        title = entry.get("title", "")
        url = entry.get("link", f"https://www.youtube.com/watch?v={video_id}")
        description = (
            entry.get("summary", "")
            or (entry.get("media_description") or "")
        )

        thumbnail_url = ""
        thumbnails = entry.get("media_thumbnail") or []
        if thumbnails:
            thumbnail_url = thumbnails[0].get("url", "")

        views = 0
        stats = entry.get("media_statistics") or {}
        try:
            views = int(stats.get("views", 0))
        except (ValueError, TypeError):
            pass

        published_at = (
            _struct_to_dt(entry.get("published_parsed"))
            or _struct_to_dt(entry.get("updated_parsed"))
            or datetime.now(timezone.utc)
        )
        updated_at = _struct_to_dt(entry.get("updated_parsed")) or published_at

        videos.append({
            "id": video_id,
            "title": title,
            "url": url,
            "thumbnail_url": thumbnail_url,
            "description": description[:2000],
            "views": views,
            "published_at": published_at,
            "updated_at": updated_at,
        })

    return {
        "name": name,
        "avatar_url": profile["avatar_url"],
        "description": profile["description"],
        "description_cn": description_cn,
        "videos": videos,
    }


async def collect_channel_by_id(channel_id: str) -> int:
    """Fetch RSS + write to DB with its own session. Returns count of new videos."""
    # 1. HTTP fetch — no DB session held
    data = await fetch_channel_feed(channel_id)
    now = datetime.now(timezone.utc)

    # 2. Tight DB write — session open only during writes
    from database import SessionLocal
    async with SessionLocal() as db:
        channel = await db.get(YoutubeChannel, channel_id)
        if not channel:
            return 0

        new_count = 0
        new_video_ids: list[str] = []
        for v in data["videos"]:
            existing = await db.get(YoutubeVideo, v["id"])
            if existing:
                existing.views = v["views"]
                existing.published_at = v["published_at"]
                existing.updated_at = v["updated_at"]
                existing.collected_at = now
            else:
                db.add(YoutubeVideo(
                    id=v["id"],
                    channel_id=channel_id,
                    channel_name=data["name"],
                    title=v["title"],
                    url=v["url"],
                    thumbnail_url=v["thumbnail_url"],
                    description=v["description"],
                    views=v["views"],
                    published_at=v["published_at"],
                    updated_at=v["updated_at"],
                    collected_at=now,
                ))
                new_count += 1
                new_video_ids.append(v["id"])

        channel.name = data["name"]
        channel.last_collected_at = now
        if data["avatar_url"]:
            channel.avatar_url = data["avatar_url"]
        if data["description"]:
            channel.description = data["description"]
        if data["description_cn"]:
            channel.description_cn = data["description_cn"]

        await db.commit()
        if (
            channel.auto_analyze_new_videos
            and channel.analysis_enabled_at is not None
            and now >= (
                channel.analysis_enabled_at
                if channel.analysis_enabled_at.tzinfo is not None
                else channel.analysis_enabled_at.replace(tzinfo=timezone.utc)
            )
        ):
            from content_response_service import create_analysis_run, ensure_response_item
            from job_queue import enqueue_job

            for video_id in new_video_ids:
                item, _ = await ensure_response_item(db, "youtube_video", video_id)
                await db.commit()
                _, job, created = await create_analysis_run(db, item)
                if created:
                    await enqueue_job(job.id)
    return new_count


async def collect_all_channels() -> dict:
    """Collect videos for all non-muted channels, one session per channel."""
    from database import SessionLocal
    async with SessionLocal() as db:
        rows = (await db.execute(
            select(YoutubeChannel).where(YoutubeChannel.muted == False)  # noqa: E712
        )).scalars().all()
        channel_ids = [ch.id for ch in rows]

    total_new = 0
    errors = []
    for cid in channel_ids:
        try:
            n = await collect_channel_by_id(cid)
            total_new += n
        except Exception as e:
            errors.append({"channel_id": cid, "error": str(e)})

    return {"new_videos": total_new, "errors": errors, "channels": len(channel_ids)}
