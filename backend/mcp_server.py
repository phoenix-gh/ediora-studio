"""
WeMedia Studio MCP Server
Exposes key data as tools for AI agents via Streamable HTTP transport.
Mount at /mcp in main.py: app.mount("/mcp", mcp.streamable_http_app())
"""

import base64
import mimetypes
import os
import uuid
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional
from mcp.server.fastmcp import FastMCP
from sqlalchemy import select, desc
from database import SessionLocal

_UPLOADS_DIR = Path(__file__).parent / "uploads"
_UPLOADS_DIR.mkdir(exist_ok=True)

# Base URL for constructing publicly accessible image URLs.
# Override with WMS_BASE_URL env var when running behind a reverse proxy.
_BASE_URL = os.getenv("WMS_BASE_URL", "http://localhost:8000")

mcp = FastMCP("WeMedia Studio")


# ── helpers ───────────────────────────────────────────────────────────────────

def _fmt_dt(dt: Optional[datetime]) -> str:
    if dt is None:
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


async def _register_draft_image(
    draft_id: int,
    filename: str,
    original_name: str,
    url: str,
    size_bytes: int,
    mime_type: str,
) -> int:
    """Attach an uploaded file to a draft's image library. Returns the DraftImage ID."""
    from models import ArticleDraft, DraftImage

    async with SessionLocal() as db:
        draft = await db.get(ArticleDraft, draft_id)
        if draft is None:
            raise ValueError(f"Draft {draft_id} not found")
        root_id = draft.linked_draft_id if draft.linked_draft_id else draft.id
        img = DraftImage(
            root_draft_id=root_id,
            filename=filename,
            original_name=original_name,
            url=url,
            size_bytes=size_bytes,
            mime_type=mime_type,
        )
        db.add(img)
        await db.commit()
        await db.refresh(img)
        return img.id


# ── tools ─────────────────────────────────────────────────────────────────────

@mcp.tool()
async def get_trending_posts(
    hours: int = 24,
    limit: int = 20,
    viral_only: bool = False,
    min_views: int = 0,
) -> list[dict]:
    """
    Return recent high-engagement X (Twitter) posts collected by WeMedia Studio.

    Args:
        hours: Time window in hours to look back (1–168, default 24).
        limit: Maximum number of posts to return (max 50).
        viral_only: If true, only return posts whose views exceed author_followers × 1.5.
        min_views: Minimum view count threshold.

    Returns a list of posts sorted by view count descending.
    Each post includes: tweet_id, username, display_name, content, url,
    published_at, author_followers, latest_views, latest_likes,
    latest_reposts, latest_replies, is_viral, category, source.
    """
    from models import XPost, XPostMetrics

    hours = max(1, min(hours, 168))
    limit = max(1, min(limit, 50))
    since = datetime.now(timezone.utc) - timedelta(hours=hours)

    async with SessionLocal() as db:
        rows = (await db.execute(
            select(XPost)
            .where(XPost.published_at >= since)
            .order_by(desc(XPost.published_at))
            .limit(200)
        )).scalars().all()

        results = []
        for post in rows:
            latest = (await db.execute(
                select(XPostMetrics)
                .where(XPostMetrics.tweet_id == post.tweet_id)
                .order_by(desc(XPostMetrics.collected_at))
                .limit(1)
            )).scalar_one_or_none()

            views = latest.views if latest else 0
            likes = latest.likes if latest else 0
            reposts = latest.reposts if latest else 0
            replies = latest.replies if latest else 0

            if views < min_views:
                continue

            is_viral = post.author_followers > 0 and views > post.author_followers * 1.5
            if viral_only and not is_viral:
                continue

            results.append({
                "tweet_id": post.tweet_id,
                "username": post.username,
                "display_name": post.display_name or "",
                "content": post.content,
                "url": post.url,
                "published_at": _fmt_dt(post.published_at),
                "author_followers": post.author_followers,
                "latest_views": views,
                "latest_likes": likes,
                "latest_reposts": reposts,
                "latest_replies": replies,
                "is_viral": is_viral,
                "category": post.category or "",
                "source": post.source or "",
            })

        results.sort(key=lambda x: x["latest_views"], reverse=True)
        return results[:limit]


@mcp.tool()
async def get_content_directions() -> list[dict]:
    """
    Return all content directions configured in WeMedia Studio, along with
    their child strategies.

    A direction is a broad content domain (e.g. "AI 工具评测").
    A strategy defines how to mine topics within that direction (filters,
    LLM prompt, output count, etc.).

    Returns a list of directions, each with a nested "strategies" list.
    """
    from models import ContentDirection, TopicStrategy

    async with SessionLocal() as db:
        directions = (await db.execute(
            select(ContentDirection).order_by(ContentDirection.created_at)
        )).scalars().all()

        result = []
        for d in directions:
            strategies = (await db.execute(
                select(TopicStrategy)
                .where(TopicStrategy.direction_id == d.id)
                .order_by(TopicStrategy.created_at)
            )).scalars().all()

            result.append({
                "id": d.id,
                "name": d.name,
                "description": d.description or "",
                "is_active": d.is_active,
                "strategies": [
                    {
                        "id": s.id,
                        "name": s.name,
                        "filter_hours": s.filter_hours,
                        "filter_min_views": s.filter_min_views,
                        "filter_viral_only": s.filter_viral_only,
                        "filter_keywords": s.filter_keywords or [],
                        "filter_exclude_keywords": s.filter_exclude_keywords or [],
                        "output_count": s.output_count,
                        "llm_prompt": s.llm_prompt or "",
                    }
                    for s in strategies
                ],
            })

    return result


@mcp.tool()
async def list_drafts(
    limit: int = 20,
    status: Optional[str] = None,
) -> list[dict]:
    """
    List article drafts stored in WeMedia Studio.

    Args:
        limit: Maximum number of drafts to return (max 50).
        status: Filter by status: "drafting", "review", "published".
                Leave empty for all statuses.

    Returns drafts sorted by updated_at descending.
    Each item includes: id, title, status, topic_id, version, created_at, updated_at.
    Note: content/body is not included — use get_draft(id) to fetch the full text.
    """
    from models import ArticleDraft

    limit = max(1, min(limit, 50))

    async with SessionLocal() as db:
        q = (
            select(ArticleDraft)
            .order_by(desc(ArticleDraft.updated_at))
            .limit(limit)
        )
        if status:
            q = q.where(ArticleDraft.status == status)
        rows = (await db.execute(q)).scalars().all()

    return [
        {
            "id": d.id,
            "title": d.title or "",
            "status": d.status,
            "topic_id": d.topic_id,
            "version": d.version,
            "created_at": _fmt_dt(d.created_at),
            "updated_at": _fmt_dt(d.updated_at),
        }
        for d in rows
    ]


@mcp.tool()
async def get_draft(draft_id: int) -> dict:
    """
    Fetch the full content of a specific draft by its ID.

    Args:
        draft_id: The integer ID of the draft (obtained from list_drafts).

    Returns: id, title, content (full Markdown body), status, topic_id,
             version, created_at, updated_at.
    Raises an error if the draft is not found.
    """
    from models import ArticleDraft

    async with SessionLocal() as db:
        obj = await db.get(ArticleDraft, draft_id)

    if obj is None:
        raise ValueError(f"Draft {draft_id} not found")

    return {
        "id": obj.id,
        "title": obj.title or "",
        "content": obj.content or "",
        "status": obj.status,
        "topic_id": obj.topic_id,
        "version": obj.version,
        "created_at": _fmt_dt(obj.created_at),
        "updated_at": _fmt_dt(obj.updated_at),
    }


@mcp.tool()
async def update_draft(
    draft_id: int,
    title: Optional[str] = None,
    content: Optional[str] = None,
    status: Optional[str] = None,
) -> dict:
    """
    Update an existing draft in WeMedia Studio's draft box.

    Args:
        draft_id: The integer ID of the draft to update (from list_drafts).
        title: New title, or omit to leave unchanged.
        content: New full Markdown body, or omit to leave unchanged.
        status: New status — "drafting", "editing", "ready", "published", "archived".
                Omit to leave unchanged.

    Returns: id, title, status, version, updated_at of the updated draft.
    Raises an error if the draft is not found.
    """
    from models import ArticleDraft

    async with SessionLocal() as db:
        obj = await db.get(ArticleDraft, draft_id)
        if obj is None:
            raise ValueError(f"Draft {draft_id} not found")
        if title is not None:
            obj.title = title
        if content is not None:
            obj.content = content
        if status is not None:
            obj.status = status
        await db.commit()
        await db.refresh(obj)

    return {
        "id": obj.id,
        "title": obj.title or "",
        "status": obj.status,
        "version": obj.version,
        "updated_at": _fmt_dt(obj.updated_at),
    }


@mcp.tool()
async def list_content_topics(
    include_archived: bool = False,
) -> list[dict]:
    """
    List all user-managed content topics (选题库) as a flat list.

    Each topic may have a parent_id — use it to reconstruct the tree
    (max 3 levels deep). Topics are sorted by priority then created_at.

    Args:
        include_archived: Include archived topics (default False).

    Returns a flat list. Each item includes: id, title, description,
    parent_id, priority (1=highest), status, source_count, draft_count,
    created_at.
    """
    from models import ContentTopic, TopicSource, ArticleDraft
    from sqlalchemy import func

    async with SessionLocal() as db:
        q = select(ContentTopic).order_by(ContentTopic.priority, ContentTopic.created_at)
        if not include_archived:
            q = q.where(ContentTopic.status == "active")
        topics = (await db.execute(q)).scalars().all()

        ids = [t.id for t in topics]

        source_counts = dict((await db.execute(
            select(TopicSource.topic_id, func.count())
            .where(TopicSource.topic_id.in_(ids))
            .group_by(TopicSource.topic_id)
        )).all()) if ids else {}

        draft_counts = dict((await db.execute(
            select(ArticleDraft.content_topic_id, func.count())
            .where(ArticleDraft.content_topic_id.in_(ids))
            .group_by(ArticleDraft.content_topic_id)
        )).all()) if ids else {}

    return [
        {
            "id": t.id,
            "title": t.title,
            "description": t.description or "",
            "parent_id": t.parent_id,
            "priority": t.priority,
            "status": t.status,
            "source_count": source_counts.get(t.id, 0),
            "draft_count": draft_counts.get(t.id, 0),
            "created_at": _fmt_dt(t.created_at),
        }
        for t in topics
    ]


@mcp.tool()
async def get_content_topic(topic_id: int) -> dict:
    """
    Get a specific content topic with all its reference sources (线索).

    Args:
        topic_id: Integer ID of the topic (from list_content_topics).

    Returns: id, title, description, parent_id, priority, status,
             created_at, and a "sources" list.
    Each source includes: id, url, title, note, platform, created_at.
    Raises an error if the topic is not found.
    """
    from models import ContentTopic, TopicSource

    async with SessionLocal() as db:
        topic = await db.get(ContentTopic, topic_id)
        if topic is None:
            raise ValueError(f"Topic {topic_id} not found")

        sources = (await db.execute(
            select(TopicSource)
            .where(TopicSource.topic_id == topic_id)
            .order_by(desc(TopicSource.created_at))
        )).scalars().all()

    return {
        "id": topic.id,
        "title": topic.title,
        "description": topic.description or "",
        "parent_id": topic.parent_id,
        "priority": topic.priority,
        "status": topic.status,
        "created_at": _fmt_dt(topic.created_at),
        "sources": [
            {
                "id": s.id,
                "url": s.url or "",
                "title": s.title or "",
                "note": s.note or "",
                "platform": s.platform,
                "created_at": _fmt_dt(s.created_at),
            }
            for s in sources
        ],
    }


@mcp.tool()
async def create_content_topic(
    title: str,
    description: str = "",
    parent_id: Optional[int] = None,
    priority: int = 3,
) -> dict:
    """
    Create a new content topic in the 选题库.

    Topics support up to 3 levels of nesting via parent_id.
    Use list_content_topics to find a suitable parent.

    Args:
        title: Topic name, e.g. "Claude 国内使用教程".
        description: What problem this topic addresses (optional).
        parent_id: ID of the parent topic for sub-topics (optional).
        priority: 1 (highest) to 5 (lowest). Default 3.

    Returns: id, title, parent_id, priority, status, created_at.
    """
    from models import ContentTopic

    async with SessionLocal() as db:
        if parent_id is not None:
            parent = await db.get(ContentTopic, parent_id)
            if parent is None:
                raise ValueError(f"Parent topic {parent_id} not found")
            if parent.parent_id is not None:
                grandparent = await db.get(ContentTopic, parent.parent_id)
                if grandparent and grandparent.parent_id is not None:
                    raise ValueError("Topics can only be nested 3 levels deep")

        obj = ContentTopic(
            title=title,
            description=description,
            parent_id=parent_id,
            priority=max(1, min(5, priority)),
        )
        db.add(obj)
        await db.commit()
        await db.refresh(obj)

    return {
        "id": obj.id,
        "title": obj.title,
        "parent_id": obj.parent_id,
        "priority": obj.priority,
        "status": obj.status,
        "created_at": _fmt_dt(obj.created_at),
    }


@mcp.tool()
async def add_topic_source(
    topic_id: int,
    url: str = "",
    title: str = "",
    note: str = "",
    platform: str = "manual",
) -> dict:
    """
    Add a reference source (线索) to a content topic.

    Use this to attach a useful link, article, or X post to a topic
    as research material. At least one of url or note must be provided.

    Args:
        topic_id: ID of the target topic (from list_content_topics).
        url: Source URL (optional).
        title: Source title or headline (optional).
        note: Your annotation — e.g. "方法有效，2026-05 验证" (optional).
        platform: Source platform: "x", "github", "wechat", "manual", "self".

    Returns: id, topic_id, url, title, note, platform, created_at.
    """
    from models import ContentTopic, TopicSource

    if not url and not note:
        raise ValueError("At least one of url or note must be provided")

    async with SessionLocal() as db:
        topic = await db.get(ContentTopic, topic_id)
        if topic is None:
            raise ValueError(f"Topic {topic_id} not found")

        obj = TopicSource(
            topic_id=topic_id,
            url=url,
            title=title,
            note=note,
            platform=platform,
        )
        db.add(obj)
        await db.commit()
        await db.refresh(obj)

    return {
        "id": obj.id,
        "topic_id": obj.topic_id,
        "url": obj.url or "",
        "title": obj.title or "",
        "note": obj.note or "",
        "platform": obj.platform,
        "created_at": _fmt_dt(obj.created_at),
    }


@mcp.tool()
async def list_quotes(
    scene_tag: Optional[str] = None,
    search: str = "",
    limit: int = 30,
) -> list[dict]:
    """
    List quotes from the 金句库 (quote library).

    Quotes are categorized by scene_tag so they can be retrieved
    by intended use: opener (开头), closer (收尾), argument (论据),
    twist (反转), resonance (共鸣), warning (警示).

    Args:
        scene_tag: Filter by scene — one of: opener, closer, argument,
                   twist, resonance, warning. Leave empty for all.
        search: Keyword to search in text, author, or source.
        limit: Maximum results (max 100, default 30).

    Returns a list sorted by created_at descending.
    Each item includes: id, text, author, source, source_url,
    scene_tags, platform, created_at.
    """
    from models import Quote

    limit = max(1, min(limit, 100))

    async with SessionLocal() as db:
        rows = (await db.execute(
            select(Quote).order_by(desc(Quote.created_at)).limit(500)
        )).scalars().all()

    result = list(rows)
    if search:
        s = search.lower()
        result = [r for r in result if s in r.text.lower() or s in r.author.lower() or s in r.source.lower()]
    if scene_tag:
        result = [r for r in result if scene_tag in (r.scene_tags or [])]

    return [
        {
            "id": q.id,
            "text": q.text,
            "author": q.author or "",
            "source": q.source or "",
            "source_url": q.source_url or "",
            "scene_tags": q.scene_tags or [],
            "platform": q.platform,
            "created_at": _fmt_dt(q.created_at),
        }
        for q in result[:limit]
    ]


@mcp.tool()
async def save_quote(
    text: str,
    author: str = "",
    source: str = "",
    source_url: str = "",
    scene_tags: Optional[list[str]] = None,
    content_topic_id: Optional[int] = None,
) -> dict:
    """
    Save a new quote to the 金句库.

    Use this when you encounter a powerful sentence worth reusing in articles.
    Tag it by scene so it can be retrieved contextually when writing.

    Args:
        text: The quote text (required).
        author: Who said or wrote it (optional).
        source: Book, article, or post title (optional).
        source_url: Link to the original (optional).
        scene_tags: List of intended uses. Valid values:
                    "opener"    — powerful opening line
                    "closer"    — strong closing line
                    "argument"  — supporting evidence
                    "twist"     — counter-intuitive or surprising
                    "resonance" — emotionally resonant
                    "warning"   — cautionary or sobering
        content_topic_id: Associate with a topic from 选题库 (optional).

    Returns: id, text, author, scene_tags, created_at.
    """
    from models import Quote

    valid_tags = {"opener", "closer", "argument", "twist", "resonance", "warning"}
    tags = [t for t in (scene_tags or []) if t in valid_tags]

    async with SessionLocal() as db:
        obj = Quote(
            text=text.strip(),
            author=author.strip(),
            source=source.strip(),
            source_url=source_url.strip(),
            scene_tags=tags,
            content_topic_id=content_topic_id,
            platform="agent",
        )
        db.add(obj)
        await db.commit()
        await db.refresh(obj)

    return {
        "id": obj.id,
        "text": obj.text,
        "author": obj.author or "",
        "scene_tags": obj.scene_tags or [],
        "created_at": _fmt_dt(obj.created_at),
    }


@mcp.tool()
async def upload_image_from_url(
    url: str,
    filename_hint: str = "",
    draft_id: Optional[int] = None,
) -> dict:
    """
    Fetch an image from a remote URL and host it on WeMedia Studio's server.

    Use this when you want to embed an externally hosted image in an article
    but need a stable, locally served URL (e.g. the original host may block
    hotlinking, or you want to ensure the image persists long-term).

    Args:
        url: The full URL of the image to fetch (http/https).
        filename_hint: Optional original filename or slug used as the extension
                       source when the Content-Type header is ambiguous.
        draft_id: Optional draft ID. When provided, the image is registered in
                  that draft's image library and will appear in the editor's
                  image panel. All variants in the same group (X, 公众号, etc.)
                  share the library — any member ID works.

    Returns:
        hosted_url: Absolute URL to serve the image from WeMedia Studio,
                    e.g. "http://localhost:8000/api/uploads/abc123.jpg".
                    Embed this directly in Markdown: ![alt](hosted_url)
        filename: The stored filename (e.g. "abc123.jpg").
        size_bytes: Size of the stored file in bytes.
        content_type: Detected MIME type.
        draft_image_id: ID of the DraftImage record (only present when draft_id was given).
    """
    import httpx

    _ALLOWED = {"image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml", "image/avif"}
    _MAX = 10 * 1024 * 1024

    async with httpx.AsyncClient(follow_redirects=True, timeout=20) as client:
        try:
            r = await client.get(url, headers={"User-Agent": "WeMediaStudio/1.0"})
        except Exception as exc:
            raise ValueError(f"Failed to fetch image: {exc}")

    if r.status_code != 200:
        raise ValueError(f"Remote server returned HTTP {r.status_code}")

    ct = r.headers.get("content-type", "").split(";")[0].strip() or "image/jpeg"
    if ct not in _ALLOWED:
        raise ValueError(f"Unsupported content type: {ct} — allowed: {', '.join(_ALLOWED)}")

    data = r.content
    if len(data) > _MAX:
        raise ValueError(f"Image too large ({len(data)} bytes, max 10 MB)")
    if len(data) < 64:
        raise ValueError("Response too small to be a valid image")

    ext = mimetypes.guess_extension(ct) or ".jpg"
    if ext in (".jpe", ".jpeg"):
        ext = ".jpg"
    # Prefer extension from hint if available
    if filename_hint and "." in filename_hint:
        hint_ext = "." + filename_hint.rsplit(".", 1)[-1].lower()
        if hint_ext in (".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".avif"):
            ext = ".jpg" if hint_ext == ".jpeg" else hint_ext

    name = f"{uuid.uuid4().hex}{ext}"
    dest = _UPLOADS_DIR / name
    dest.write_bytes(data)

    api_url = f"/api/uploads/{name}"
    result: dict = {
        "hosted_url": f"{_BASE_URL}{api_url}",
        "filename": name,
        "size_bytes": len(data),
        "content_type": ct,
    }
    if draft_id is not None:
        original = filename_hint or url.rsplit("/", 1)[-1] or name
        img_id = await _register_draft_image(draft_id, name, original, api_url, len(data), ct)
        result["draft_image_id"] = img_id

    return result


@mcp.tool()
async def upload_image_from_base64(
    data: str,
    mime_type: str = "image/png",
    filename_hint: str = "",
    draft_id: Optional[int] = None,
) -> dict:
    """
    Decode a base64-encoded image and host it on WeMedia Studio's server.

    Use this when you have raw image bytes (e.g. generated images, screenshots,
    or data-URI images) that you want to embed in an article.

    Args:
        data: Base64-encoded image bytes. May include a data-URI prefix
              (e.g. "data:image/png;base64,iVBOR...") — the prefix is stripped
              automatically.
        mime_type: MIME type of the image, e.g. "image/png", "image/jpeg",
                   "image/webp". Defaults to "image/png".
        filename_hint: Optional filename/slug used only for the file extension.
        draft_id: Optional draft ID. When provided, the image is registered in
                  that draft's image library and will appear in the editor's
                  image panel. All variants in the same group share the library.

    Returns:
        hosted_url: Absolute URL to serve the image, e.g.
                    "http://localhost:8000/api/uploads/abc123.png".
                    Embed this directly in Markdown: ![alt](hosted_url)
        filename: The stored filename.
        size_bytes: Size of the decoded image in bytes.
        content_type: MIME type used.
        draft_image_id: ID of the DraftImage record (only present when draft_id was given).
    """
    _ALLOWED = {"image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml", "image/avif"}
    _MAX = 10 * 1024 * 1024

    # Strip data-URI prefix if present
    if data.startswith("data:"):
        if "," in data:
            header, data = data.split(",", 1)
            # Extract MIME from prefix if not explicitly overridden
            if "image/" in header and mime_type == "image/png":
                try:
                    mime_type = header.split(":")[1].split(";")[0].strip()
                except Exception:
                    pass

    ct = mime_type.split(";")[0].strip()
    if ct not in _ALLOWED:
        raise ValueError(f"Unsupported MIME type: {ct} — allowed: {', '.join(_ALLOWED)}")

    try:
        raw = base64.b64decode(data)
    except Exception:
        raise ValueError("Invalid base64 data")

    if len(raw) > _MAX:
        raise ValueError(f"Decoded image too large ({len(raw)} bytes, max 10 MB)")
    if len(raw) < 64:
        raise ValueError("Decoded data too small to be a valid image")

    ext = mimetypes.guess_extension(ct) or ".png"
    if ext in (".jpe", ".jpeg"):
        ext = ".jpg"
    if filename_hint and "." in filename_hint:
        hint_ext = "." + filename_hint.rsplit(".", 1)[-1].lower()
        if hint_ext in (".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".avif"):
            ext = ".jpg" if hint_ext == ".jpeg" else hint_ext

    name = f"{uuid.uuid4().hex}{ext}"
    dest = _UPLOADS_DIR / name
    dest.write_bytes(raw)

    api_url = f"/api/uploads/{name}"
    result: dict = {
        "hosted_url": f"{_BASE_URL}{api_url}",
        "filename": name,
        "size_bytes": len(raw),
        "content_type": ct,
    }
    if draft_id is not None:
        original = filename_hint or name
        img_id = await _register_draft_image(draft_id, name, original, api_url, len(raw), ct)
        result["draft_image_id"] = img_id

    return result


@mcp.tool()
async def save_draft(
    title: str,
    content: str,
    topic_id: str = "agent",
    status: str = "drafting",
) -> dict:
    """
    Save a new article draft to WeMedia Studio's draft box.

    Args:
        title: Article title.
        content: Full article body in Markdown.
        topic_id: Source identifier. Use "agent" for AI-agent-generated articles,
                  or a tweet_id / topic UUID when derived from a specific source.
        status: Initial status — "drafting" (default) or "review".

    Returns: id, title, status, created_at of the newly created draft.
    """
    from models import ArticleDraft

    async with SessionLocal() as db:
        obj = ArticleDraft(
            topic_id=topic_id,
            title=title,
            content=content,
            status=status,
        )
        db.add(obj)
        await db.commit()
        await db.refresh(obj)

    return {
        "id": obj.id,
        "title": obj.title,
        "status": obj.status,
        "created_at": _fmt_dt(obj.created_at),
    }


# ── publish account profile ───────────────────────────────────────────────────

@mcp.tool()
async def list_publish_accounts() -> list[dict]:
    """
    Return all publish accounts (the user-operated outlets: 公众号 / X / 视频号 等).

    Use this to discover which account_id values are available. To inspect a
    specific account's full positioning profile, call get_account_profile(pub_id).
    """
    from models import PublishAccount

    async with SessionLocal() as db:
        rows = (await db.execute(
            select(PublishAccount).order_by(
                PublishAccount.is_active.desc(), PublishAccount.name
            )
        )).scalars().all()

        return [
            {
                "id": acc.id,
                "name": acc.name,
                "platform": acc.platform,
                "positioning": acc.positioning,
                "is_active": acc.is_active,
            }
            for acc in rows
        ]


@mcp.tool()
async def get_account_profile(pub_id: str) -> dict:
    """
    Return the full positioning profile of a publish account.

    Every agent in the scout → editor → writer → critic pipeline MUST call
    this as its first step, using the `account_id` carried in the kanban task
    body/metadata. All downstream output (angle, brief, draft, scoring) must
    align with the returned profile — tone, audience, topic_focus, taboo,
    word_range, image_style.

    Returns an empty dict with `error: "..."` if pub_id is unknown.
    """
    from models import PublishAccount

    async with SessionLocal() as db:
        acc = await db.get(PublishAccount, pub_id)
        if acc is None:
            return {"error": f"publish account '{pub_id}' not found"}

        return {
            "id": acc.id,
            "name": acc.name,
            "platform": acc.platform,
            "positioning": acc.positioning,
            "audience": acc.audience,
            "tone": acc.tone,
            "topic_focus": acc.topic_focus or [],
            "taboo": acc.taboo or [],
            "word_range": acc.word_range or {},
            "image_style": acc.image_style,
            "cover_style": acc.cover_style or {},
            "voice_samples": acc.voice_samples or [],
            "style_rules": acc.style_rules or [],
            "is_active": acc.is_active,
        }
