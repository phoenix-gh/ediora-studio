import asyncio
import hashlib
import json
import re
import httpx
import feedparser
from datetime import datetime, timezone
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from models import Account, Post

_RSSHUB_BASE_DEFAULT = "http://127.0.0.1:1200"

# Preferred subtitle languages, in priority order
_SUB_LANGS = ("zh-Hans", "zh", "zh-Hant", "en")

# Max chars of transcript to store
_TRANSCRIPT_MAX = 8000


async def _rsshub_base() -> str:
    try:
        from config import get_config
        cfg = await get_config()
        return cfg.get("rsshub_base", _RSSHUB_BASE_DEFAULT) or _RSSHUB_BASE_DEFAULT
    except Exception:
        return _RSSHUB_BASE_DEFAULT


def _post_id(account_id: str, entry_id: str) -> str:
    return hashlib.md5(f"{account_id}:{entry_id}".encode()).hexdigest()[:16]


def _parse_date(entry) -> datetime:
    for attr in ("published_parsed", "updated_parsed"):
        t = getattr(entry, attr, None)
        if t:
            import calendar
            return datetime.fromtimestamp(calendar.timegm(t), tz=timezone.utc)
    return datetime.now(timezone.utc)


def _strip_html(text: str) -> str:
    return re.sub(r"<[^>]+>", "", text).strip()


# ── Transcript parsing ────────────────────────────────────────────────────────

def _parse_json3(raw: str) -> str:
    """Parse YouTube json3 subtitle format into clean plain text."""
    data = json.loads(raw)
    parts: list[str] = []
    prev = ""
    for event in data.get("events", []):
        segs = event.get("segs")
        if not segs:
            continue
        chunk = "".join(s.get("utf8", "") for s in segs)
        # json3 uses \n as a line-break token within a segment
        chunk = chunk.replace("\n", " ").strip()
        if chunk and chunk != prev:
            parts.append(chunk)
            prev = chunk
    return _clean_transcript(" ".join(parts))


def _parse_vtt(raw: str) -> str:
    """Parse WebVTT subtitle format into clean plain text."""
    parts: list[str] = []
    prev = ""
    for line in raw.splitlines():
        line = line.strip()
        # Skip header, timing lines, cue IDs, and blank lines
        if (not line
                or "-->" in line
                or line.startswith("WEBVTT")
                or line.startswith("NOTE")
                or line.startswith("Kind:")
                or line.startswith("Language:")
                or line.isdigit()):
            continue
        # Strip timing tags like <00:00:01.500> and <c> / </c>
        clean = re.sub(r"<[^>]+>", "", line).strip()
        if clean and clean != prev:
            parts.append(clean)
            prev = clean
    return _clean_transcript(" ".join(parts))


def _clean_transcript(text: str) -> str:
    """Normalise whitespace and remove common auto-caption noise."""
    # Collapse multiple spaces / newlines
    text = re.sub(r"\s+", " ", text).strip()
    # Remove music / sound effect tokens like [Music] [Applause]
    text = re.sub(r"\[.*?\]", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _pick_subtitle_url(info: dict) -> tuple[str, str] | tuple[None, None]:
    """
    Return (url, ext) for the best available subtitle track.
    Prefers manual subs over auto-captions; prefers json3 > vtt.
    """
    for source_key in ("subtitles", "automatic_captions"):
        source: dict = info.get(source_key, {}) or {}
        for lang in _SUB_LANGS:
            if lang not in source:
                continue
            formats: list[dict] = source[lang]
            # Prefer json3 first, then vtt
            for preferred_ext in ("json3", "vtt"):
                for fmt in formats:
                    if fmt.get("ext") == preferred_ext:
                        url = fmt.get("url", "")
                        if url:
                            return url, preferred_ext
    return None, None


# ── YouTube via yt-dlp ────────────────────────────────────────────────────────

def _ytdlp_list_channel(channel_url: str) -> list[dict]:
    """Fetch the latest 20 video entries from a YouTube channel (flat, fast)."""
    import yt_dlp
    target = channel_url.rstrip("/") + "/videos"
    opts = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": "in_playlist",
        "playlist_items": "1-20",
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(target, download=False)
    entries = info.get("entries", []) if info else []
    return [e for e in entries if e and e.get("ie_key") != "YoutubeTab"]


def _ytdlp_get_subtitles(vid_id: str) -> dict:
    """
    Fetch full video info (no download) to retrieve subtitle URLs.
    Returns the yt-dlp info dict.
    """
    import yt_dlp
    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        return ydl.extract_info(
            f"https://www.youtube.com/watch?v={vid_id}",
            download=False,
        ) or {}


async def _fetch_transcript(vid_id: str, loop: asyncio.AbstractEventLoop) -> str:
    """
    Try to fetch and parse the transcript for a YouTube video.
    Returns cleaned text, or empty string if unavailable.
    """
    try:
        info = await asyncio.wait_for(
            loop.run_in_executor(None, _ytdlp_get_subtitles, vid_id),
            timeout=30,
        )
    except Exception as e:
        print(f"[yt] subtitle info failed for {vid_id}: {e}")
        return ""

    sub_url, sub_ext = _pick_subtitle_url(info)
    if not sub_url:
        return ""

    try:
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.get(sub_url)
            resp.raise_for_status()
        raw = resp.text
        if sub_ext == "json3":
            return _parse_json3(raw)[:_TRANSCRIPT_MAX]
        else:
            return _parse_vtt(raw)[:_TRANSCRIPT_MAX]
    except Exception as e:
        print(f"[yt] subtitle fetch failed for {vid_id}: {e}")
        return ""


async def _collect_youtube(account: Account, db: AsyncSession) -> int:
    channel_url = account.rsshub_path
    loop = asyncio.get_event_loop()

    entries = await loop.run_in_executor(None, _ytdlp_list_channel, channel_url)

    new_count = 0
    for entry in entries:
        if not entry:
            continue
        vid_id = entry.get("id", "")
        pid = _post_id(account.id, vid_id)
        if await db.get(Post, pid):
            continue

        title = entry.get("title", "")
        vid_url = (
            entry.get("url")
            or entry.get("webpage_url")
            or f"https://www.youtube.com/watch?v={vid_id}"
        )

        upload_date = entry.get("upload_date")
        pub = (
            datetime.strptime(upload_date, "%Y%m%d").replace(tzinfo=timezone.utc)
            if upload_date
            else datetime.now(timezone.utc)
        )

        # Fetch transcript; store as content separate from title
        transcript = await _fetch_transcript(vid_id, loop)

        db.add(Post(
            id=pid,
            account_id=account.id,
            title=title[:400],
            content=transcript[:_TRANSCRIPT_MAX],
            url=vid_url,
            published_at=pub,
            likes=entry.get("like_count") or 0,
            reposts=0,
            comments=entry.get("comment_count") or 0,
            is_abnormally_popular=False,
        ))
        new_count += 1

    await db.commit()
    return new_count


# ── RSS / RSSHub ──────────────────────────────────────────────────────────────

def _rss_title(entry: dict) -> str:
    """Extract and clean the title from an RSS entry."""
    return (entry.get("title") or "").strip()


def _rss_body(entry: dict) -> str:
    """
    Extract body content from an RSS entry summary/description.
    Returns empty string if the summary is boilerplate navigation text.
    """
    summary_raw = entry.get("summary") or entry.get("description") or ""
    summary = _strip_html(summary_raw).strip()

    _BOILERPLATE = ("Comments on ", "Source", "Read more", "Continue reading")
    is_boilerplate = (
        len(summary) < 80
        or any(summary.startswith(p) for p in _BOILERPLATE)
    )

    title = (entry.get("title") or "").strip()
    if is_boilerplate or summary == title:
        return ""

    return summary

async def _collect_rss(account: Account, db: AsyncSession) -> int:
    path = account.rsshub_path
    base = await _rsshub_base()
    url = path if path.startswith("http") else f"{base}{path}"

    # Reddit blocks generic UAs; use their required format
    headers = {}
    if "reddit.com" in url:
        headers["User-Agent"] = "WeMediaStudio/1.0 (by /u/wemedia_bot)"

    try:
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.get(url, headers=headers)
            resp.raise_for_status()
    except Exception as e:
        raise RuntimeError(f"fetch failed: {e}")

    feed = feedparser.parse(resp.text)
    if feed.bozo and not feed.entries:
        raise RuntimeError(f"invalid feed: {feed.bozo_exception}")

    new_count = 0
    for entry in feed.entries[:20]:
        pid = _post_id(account.id, entry.get("id", entry.get("link", "")))
        if await db.get(Post, pid):
            continue

        title = _rss_title(entry)
        body = _rss_body(entry)

        db.add(Post(
            id=pid,
            account_id=account.id,
            title=title[:400],
            content=body[:2000],
            url=entry.get("link", ""),
            published_at=_parse_date(entry),
            likes=0,
            reposts=0,
            comments=0,
            is_abnormally_popular=False,
        ))
        new_count += 1

    await db.commit()
    return new_count


# ── arXiv via API (Atom format, works 7 days a week) ─────────────────────────

def _arxiv_category_from_path(path: str) -> str:
    """Extract category like 'cs.AI' from an arXiv RSS URL."""
    m = re.search(r"/(?:rss|abs)/([a-z]+\.[A-Z]+)", path)
    return m.group(1) if m else ""


async def _collect_arxiv(account: Account, db: AsyncSession) -> int:
    category = _arxiv_category_from_path(account.rsshub_path)
    if not category:
        # Fall back to account name extraction e.g. "arXiv cs.AI"
        m = re.search(r"([a-z]+\.[A-Z]+)", account.name)
        category = m.group(1) if m else "cs.AI"

    params = {
        "search_query": f"cat:{category}",
        "start": 0,
        "max_results": 30,
        "sortBy": "submittedDate",
        "sortOrder": "descending",
    }
    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            resp = await client.get(
                "https://export.arxiv.org/api/query",
                params=params,
                headers={"User-Agent": "WeMediaStudio/1.0"},
            )
            resp.raise_for_status()
    except Exception as e:
        raise RuntimeError(f"arXiv API fetch failed: {e}")

    feed = feedparser.parse(resp.text)
    if feed.bozo and not feed.entries:
        raise RuntimeError(f"arXiv API parse error: {feed.bozo_exception}")

    new_count = 0
    for entry in feed.entries:
        link = getattr(entry, "id", "") or getattr(entry, "link", "") or ""
        pid = _post_id(account.id, link)
        if await db.get(Post, pid):
            continue

        title = (getattr(entry, "title", "") or "").strip()
        abstract = _strip_html((getattr(entry, "summary", "") or "")).strip()
        abstract = re.sub(r"\s+", " ", abstract)

        authors = []
        if hasattr(entry, "authors") and entry.authors:
            authors = [a.get("name", "") for a in entry.authors if a.get("name")]
        author_str = ", ".join(authors[:5]) + (" et al." if len(authors) > 5 else "")

        arxiv_url = re.sub(r"v\d+$", "", link)

        db.add(Post(
            id=pid,
            account_id=account.id,
            title=title[:400],
            content=(f"[{author_str}]\n\n{abstract}" if author_str else abstract)[:2000],
            url=arxiv_url,
            published_at=_parse_date(entry),
        ))
        new_count += 1

    await db.commit()
    return new_count


# ── Entry points ──────────────────────────────────────────────────────────────

async def collect_account(account: Account, db: AsyncSession) -> int:
    path = account.rsshub_path
    if account.platform == "arXiv" or "arxiv.org" in path:
        return await _collect_arxiv(account, db)
    is_youtube = "youtube.com" in path or "youtu.be" in path
    if is_youtube:
        return await _collect_youtube(account, db)
    return await _collect_rss(account, db)


async def collect_all(db: AsyncSession) -> list[dict]:
    accounts = (await db.execute(
        select(Account).where(Account.muted == False)
    )).scalars().all()

    results = []
    for acc in accounts:
        try:
            n = await collect_account(acc, db)
            results.append({"account_id": acc.id, "new_posts": n, "error": None})
        except Exception as e:
            results.append({"account_id": acc.id, "new_posts": 0, "error": str(e)})
    return results
