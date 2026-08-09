"""
WeMedia Studio MCP Server
Exposes key data as tools for AI agents via Streamable HTTP transport.
Mount at /mcp in main.py: app.mount("/mcp", mcp.streamable_http_app())
"""

import mimetypes
import os
import uuid
from dataclasses import asdict
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Literal, Optional
from mcp.server.fastmcp import Context, FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from sqlalchemy import select, desc, delete as sa_delete, func
from database import SessionLocal
from web_search import WebSearchProviderError, search_web as run_web_search
from web_fetch import WebFetchProviderError, fetch_web_url as run_web_fetch

_UPLOADS_DIR = Path(__file__).parent / "uploads"
_UPLOADS_DIR.mkdir(exist_ok=True)

# Base URL for constructing publicly accessible image URLs.
# Override with WMS_BASE_URL env var when running behind a reverse proxy.
_BASE_URL = os.getenv("WMS_BASE_URL", "http://localhost:8000")

mcp = FastMCP(
    "WeMedia Studio",
    transport_security=TransportSecuritySettings(
        # The Next.js AI route calls this service through Docker Compose's
        # internal DNS name. Keep DNS-rebinding protection on, but allow that
        # explicit backend-to-backend host alongside local development hosts.
        allowed_hosts=["api:8000", "localhost:8000", "127.0.0.1:8000"],
    ),
)

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
        img = DraftImage(
            draft_id=draft_id,
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
async def web_search(query: str, max_results: int = 5, language: str = "zh-CN") -> dict:
    """Search the public web. Cite returned URLs and do not claim results beyond this output."""
    try:
        results, provider = await run_web_search(
            query.strip(), max(1, min(max_results, 10)), language.strip() or "zh-CN",
        )
    except WebSearchProviderError as exc:
        return {
            "error": f"Web search is unavailable: {exc.reason}. Configure it in Settings → Web 搜索.",
            "results": [],
        }
    return {"provider": provider, "results": [asdict(result) for result in results]}


@mcp.tool()
async def fetch_url(url: str, max_chars: int = 12_000) -> dict:
    """Fetch a public webpage and return its readable text. Cite the returned URL when using its content."""
    try:
        result, provider = await run_web_fetch(url.strip(), max(1, min(max_chars, 12_000)))
    except WebFetchProviderError as exc:
        return {
            "error": f"URL fetch is unavailable: {exc.reason}. Configure it in Settings → 网页抓取.",
            "url": url,
            "content": "",
        }
    return {"provider": provider, "url": result.url, "title": result.title, "content": result.content, "content_type": result.content_type}

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
async def get_github_daily_trending() -> dict:
    """Return the latest GitHub daily Trending snapshot and rank changes.

    This tool is intentionally argument-free: the Agent must use the daily
    snapshot already collected by WeMedia Studio and cannot switch to weekly
    data or invent a different source.
    """
    from models import GithubTrendingRepo

    empty = {
        "period": "daily",
        "trending_date": "",
        "previous_trending_date": "",
        "source_url": "https://github.com/trending?since=daily",
        "items": [],
        "summary": {
            "count": 0,
            "new_count": None,
            "top_languages": [],
        },
    }

    async with SessionLocal() as db:
        latest = await db.scalar(
            select(func.max(GithubTrendingRepo.trending_date)).where(
                GithubTrendingRepo.period == "daily"
            )
        )
        if not latest:
            return empty

        previous = await db.scalar(
            select(func.max(GithubTrendingRepo.trending_date)).where(
                GithubTrendingRepo.period == "daily",
                GithubTrendingRepo.trending_date < latest,
            )
        )
        rows = (
            await db.execute(
                select(GithubTrendingRepo)
                .where(
                    GithubTrendingRepo.period == "daily",
                    GithubTrendingRepo.trending_date == latest,
                )
                .order_by(GithubTrendingRepo.position)
            )
        ).scalars().all()
        previous_rows = []
        if previous:
            previous_rows = (
                await db.execute(
                    select(GithubTrendingRepo).where(
                        GithubTrendingRepo.period == "daily",
                        GithubTrendingRepo.trending_date == previous,
                    )
                )
            ).scalars().all()

    previous_positions = {
        f"{row.owner}/{row.repo}": row.position for row in previous_rows
    }
    language_counts: dict[str, int] = {}
    items: list[dict] = []
    for row in rows:
        full_name = f"{row.owner}/{row.repo}"
        previous_rank = previous_positions.get(full_name)
        language = row.language or ""
        if language:
            language_counts[language] = language_counts.get(language, 0) + 1
        items.append({
            "rank": row.position,
            "full_name": full_name,
            "owner": row.owner,
            "repo": row.repo,
            "description": row.description or "",
            "language": language,
            "stars": row.stars,
            "stars_gained": row.stars_gained,
            "forks": row.forks,
            "url": row.url or f"https://github.com/{full_name}",
            "previous_rank": previous_rank,
            "rank_delta": (
                previous_rank - row.position
                if previous_rank is not None else None
            ),
            "is_new": (previous_rank is None if previous else None),
        })

    top_languages = sorted(
        language_counts.items(), key=lambda item: (-item[1], item[0])
    )[:5]
    return {
        "period": "daily",
        "trending_date": latest,
        "previous_trending_date": previous or "",
        "source_url": "https://github.com/trending?since=daily",
        "items": items,
        "summary": {
            "count": len(items),
            "new_count": sum(1 for item in items if item["is_new"] is True) if previous else None,
            "top_languages": [
                {"language": language, "count": count}
                for language, count in top_languages
            ],
        },
    }


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
async def search_creative_assets(
    query: str = "",
    directory: str = "",
    asset_type: str = "",
    limit: int = 10,
) -> list[dict]:
    """
    Search the user's Creative Assets / 素材库. This tool is read-only.

    Use it to find raw article material, images, video, or audio stored under
    创作资产. Query matches an asset's title, body text, and tags. Directory
    optionally narrows the result to one material folder, such as "搞钱副业".

    Args:
        query: Optional keywords to search for.
        directory: Optional exact material-folder name.
        asset_type: Optional "article" or "media" filter.
        limit: Maximum assets to return (default 10, max 30).

    Returns compact metadata and a content summary. Call get_creative_asset(id)
    to read the complete article material or inspect all asset fields.
    """
    from models import CreativeAsset

    normalized_type = asset_type.strip().lower()
    if normalized_type and normalized_type not in {"article", "media"}:
        raise ValueError("asset_type must be 'article', 'media', or empty")
    normalized_directory = directory.strip()
    keywords = [item.lower() for item in query.split() if item]
    take = max(1, min(int(limit), 30))

    async with SessionLocal() as db:
        statement = select(CreativeAsset).order_by(
            desc(CreativeAsset.updated_at), desc(CreativeAsset.id)
        )
        if normalized_type:
            statement = statement.where(CreativeAsset.asset_type == normalized_type)
        if normalized_directory:
            statement = statement.where(CreativeAsset.directory == normalized_directory)
        rows = (await db.execute(statement.limit(500))).scalars().all()

    def matches(asset) -> bool:
        searchable = " ".join([
            asset.title or "", asset.content or "", " ".join(asset.tags or []),
        ]).lower()
        return all(keyword in searchable for keyword in keywords)

    return [
        {
            "id": asset.id,
            "asset_type": asset.asset_type,
            "media_kind": asset.media_kind or "",
            "title": asset.title or "",
            "summary": " ".join((asset.content or "").split())[:500],
            "url": asset.url or "",
            "directory": asset.directory or "",
            "tags": asset.tags or [],
            "source": asset.source or "",
        }
        for asset in rows if matches(asset)
    ][:take]


@mcp.tool()
async def get_creative_asset(asset_id: int) -> dict:
    """
    Read one complete Creative Asset / 素材库 item by ID. This tool is read-only.

    Use search_creative_assets first to locate an ID, then call this tool to
    retrieve the full raw content before analyzing or repurposing it.
    """
    from models import CreativeAsset

    async with SessionLocal() as db:
        asset = await db.get(CreativeAsset, asset_id)
    if asset is None:
        raise ValueError(f"Creative asset {asset_id} not found")
    return {
        "id": asset.id,
        "asset_type": asset.asset_type,
        "media_kind": asset.media_kind or "",
        "title": asset.title or "",
        "content": asset.content or "",
        "url": asset.url or "",
        "media_type": asset.media_type or "",
        "filename": asset.filename or "",
        "directory": asset.directory or "",
        "tags": asset.tags or [],
        "source": asset.source or "",
    }


@mcp.tool()
async def list_creative_asset_candidates(
    asset_type: str,
    directories: list[str] | None = None,
    directory: str = "",
    query: str = "",
    limit: int = 50,
) -> list[dict]:
    """List compact, directory-scoped asset candidates for an AI creation run."""
    from daily_creation_service import (
        list_creative_asset_candidates as list_candidates,
    )

    async with SessionLocal() as db:
        return await list_candidates(
            db,
            asset_type=asset_type,
            directories=directories,
            directory=directory,
            query=query,
            limit=limit,
        )


@mcp.tool()
async def get_recent_content_usage(
    lookback_days: int,
    output_type: str,
    rule_id: int | None = None,
    account_id: str | None = None,
    limit: int = 100,
) -> list[dict]:
    """Read bounded global semantic-deduplication history for AI comparison."""
    from daily_creation_service import get_recent_content_usage as get_usage

    async with SessionLocal() as db:
        return await get_usage(
            db,
            lookback_days=lookback_days,
            output_type=output_type,
            rule_id=rule_id,
            account_id=account_id,
            limit=limit,
        )


@mcp.tool()
async def record_content_usage(
    asset_id: int,
    output_kind: Literal["draft"],
    output_id: int,
    topic: str,
    angle: str,
    excerpt: str,
    reuse_decision: Literal["fresh", "reuse_allowed"],
    ctx: Context,
    reuse_explanation: str = "",
    account_id: str | None = None,
) -> dict:
    """Record persisted draft usage.

    ``output_kind`` must be ``draft`` and ``reuse_decision`` must be either
    ``fresh`` or ``reuse_allowed``.
    """
    from daily_creation_service import record_content_usage as record_usage

    request = getattr(ctx.request_context, "request", None)
    headers = getattr(request, "headers", {})
    raw_run_id = headers.get("x-wms-daily-creation-run-id")
    try:
        run_id = int(raw_run_id)
    except (TypeError, ValueError) as error:
        raise ValueError("scheduled Agent run identity is missing") from error
    if run_id <= 0:
        raise ValueError("scheduled Agent run identity is invalid")

    async with SessionLocal() as db:
        async with db.begin():
            usage = await record_usage(
                db,
                run_id=run_id,
                asset_id=asset_id,
                output_kind=output_kind,
                output_id=output_id,
                topic=topic,
                angle=angle,
                excerpt=excerpt,
                reuse_decision=reuse_decision,
                reuse_explanation=reuse_explanation,
                account_id=account_id,
            )
        return {"id": usage.id, "created_at": _fmt_dt(usage.created_at)}


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
async def list_writing_plans(
    include_archived: bool = False,
) -> list[dict]:
    """
    List all user-managed writing plans (写作方案) as a flat list.

    Plans are sorted by priority then created_at.

    Args:
        include_archived: Include archived plans (default False).

    Returns a flat list. Each item includes: id, title, strategy,
    tags (list of {id, name, color}), priority (1=highest), status,
    source_count, draft_count, created_at.
    """
    from models import WritingPlan, PlanSource, ArticleDraft, PlanTag, WritingPlanTag
    from sqlalchemy import func

    async with SessionLocal() as db:
        q = select(WritingPlan).order_by(WritingPlan.priority, WritingPlan.created_at)
        if not include_archived:
            q = q.where(WritingPlan.status == "active")
        plans = (await db.execute(q)).scalars().all()

        ids = [p.id for p in plans]

        source_counts = dict((await db.execute(
            select(PlanSource.plan_id, func.count())
            .where(PlanSource.plan_id.in_(ids))
            .group_by(PlanSource.plan_id)
        )).all()) if ids else {}

        draft_counts = dict((await db.execute(
            select(ArticleDraft.writing_plan_id, func.count())
            .where(ArticleDraft.writing_plan_id.in_(ids))
            .group_by(ArticleDraft.writing_plan_id)
        )).all()) if ids else {}

        tag_rows = (await db.execute(
            select(WritingPlanTag.plan_id, PlanTag.id, PlanTag.name, PlanTag.color)
            .join(PlanTag, PlanTag.id == WritingPlanTag.tag_id)
            .where(WritingPlanTag.plan_id.in_(ids))
        )).all() if ids else []
        tags_by_plan: dict[int, list[dict]] = {}
        for row in tag_rows:
            tags_by_plan.setdefault(row.plan_id, []).append(
                {"id": row.id, "name": row.name, "color": row.color}
            )

    return [
        {
            "id": p.id,
            "title": p.title,
            "strategy": p.strategy or "",
            "tags": tags_by_plan.get(p.id, []),
            "priority": p.priority,
            "status": p.status,
            "source_count": source_counts.get(p.id, 0),
            "draft_count": draft_counts.get(p.id, 0),
            "created_at": _fmt_dt(p.created_at),
        }
        for p in plans
    ]


@mcp.tool()
async def get_writing_plan(plan_id: int) -> dict:
    """
    Get a specific writing plan (写作方案) with its sources, tags, and update history.

    Args:
        plan_id: Integer ID of the plan (from list_writing_plans or search_writing_plans).

    Returns: id, title, strategy, tags, priority, status, created_at,
             sources list, and updates list (most recent first).
    Raises an error if the plan is not found.
    """
    from models import WritingPlan, PlanSource, PlanTag, WritingPlanTag, PlanUpdate

    async with SessionLocal() as db:
        plan = await db.get(WritingPlan, plan_id)
        if plan is None:
            raise ValueError(f"Writing plan {plan_id} not found")

        sources = (await db.execute(
            select(PlanSource)
            .where(PlanSource.plan_id == plan_id)
            .order_by(desc(PlanSource.created_at))
        )).scalars().all()

        tag_rows = (await db.execute(
            select(PlanTag)
            .join(WritingPlanTag, WritingPlanTag.tag_id == PlanTag.id)
            .where(WritingPlanTag.plan_id == plan_id)
        )).scalars().all()

        updates = (await db.execute(
            select(PlanUpdate)
            .where(PlanUpdate.plan_id == plan_id)
            .order_by(desc(PlanUpdate.created_at))
            .limit(20)
        )).scalars().all()

    return {
        "id": plan.id,
        "title": plan.title,
        "strategy": plan.strategy or "",
        "tags": [{"id": t.id, "name": t.name, "color": t.color} for t in tag_rows],
        "priority": plan.priority,
        "status": plan.status,
        "created_at": _fmt_dt(plan.created_at),
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
        "updates": [
            {
                "id": u.id,
                "description": u.description,
                "source_url": u.source_url or "",
                "created_at": _fmt_dt(u.created_at),
            }
            for u in updates
        ],
    }


@mcp.tool()
async def create_writing_plan(
    title: str,
    strategy: str = "",
    tags: Optional[list[str]] = None,
    priority: int = 3,
) -> dict:
    """
    Create a new writing plan (写作方案) in the plan library.

    Args:
        title: Plan name — describes the *type* of content / repeatable writing
               pattern, NOT a specific article title.
               ✅ Good: "非程序员AI工具创业故事"、"普通人副业收入数字拆解"、"工具对比实测横评"
               ❌ Bad:  "AI压缩产品周期：非程序员用ChatGPT做付费APP案例拆解"（这是文章标题）
               Rule: remove all specific names/numbers — if the title still makes
               sense as a category name, it's correct.
        strategy: Markdown strategy describing the writing pattern, title formula,
               material sourcing method, and forbidden zones (optional).
        tags: List of tag names to attach (will be created if they don't exist).
        priority: 1 (highest) to 5 (lowest). Default 3.

    Returns: id, title, strategy, tags, priority, status, created_at.
    """
    from models import WritingPlan, PlanTag, WritingPlanTag
    from sqlalchemy import func

    _TAG_COLORS = ["#6366f1","#8b5cf6","#ec4899","#f59e0b","#10b981","#3b82f6","#ef4444","#14b8a6"]

    async def _get_or_create_tag(db, name: str) -> PlanTag:
        normalized = name.strip().lower()
        existing = (await db.execute(
            select(PlanTag).where(func.lower(PlanTag.name) == normalized)
        )).scalar_one_or_none()
        if existing:
            return existing
        color = _TAG_COLORS[sum(ord(c) for c in name) % len(_TAG_COLORS)]
        tag = PlanTag(name=name.strip(), color=color)
        db.add(tag)
        await db.flush()
        return tag

    async with SessionLocal() as db:
        obj = WritingPlan(
            title=title,
            strategy=strategy,
            priority=max(1, min(5, priority)),
        )
        db.add(obj)
        await db.flush()

        for name in (tags or []):
            if name.strip():
                tag = await _get_or_create_tag(db, name)
                db.add(WritingPlanTag(plan_id=obj.id, tag_id=tag.id))

        await db.commit()
        await db.refresh(obj)

        tag_rows = (await db.execute(
            select(PlanTag)
            .join(WritingPlanTag, WritingPlanTag.tag_id == PlanTag.id)
            .where(WritingPlanTag.plan_id == obj.id)
        )).scalars().all()

    return {
        "id": obj.id,
        "title": obj.title,
        "strategy": obj.strategy or "",
        "tags": [{"id": t.id, "name": t.name, "color": t.color} for t in tag_rows],
        "priority": obj.priority,
        "status": obj.status,
        "created_at": _fmt_dt(obj.created_at),
    }


@mcp.tool()
async def add_plan_source(
    plan_id: int,
    url: str = "",
    title: str = "",
    note: str = "",
    content: str = "",
    platform: str = "manual",
) -> dict:
    """
    Add a reference source (线索) to a writing plan (写作方案).

    Use this to attach a useful link, article, or X post to a plan
    as research material. At least one of url or note must be provided.

    Args:
        plan_id: ID of the target plan (from list_writing_plans).
        url: Source URL (optional).
        title: Source title or headline (optional).
        note: Your annotation — e.g. "方法有效，2026-05 验证" (optional).
        content: Full body text or key excerpts from the source (optional but
                 recommended — users can read it in the preview panel without
                 opening the URL).
        platform: Source platform: "x", "github", "wechat", "manual", "self".

    Returns: id, plan_id, url, title, note, content, platform, created_at.
    """
    from models import WritingPlan, PlanSource

    if not url and not note:
        raise ValueError("At least one of url or note must be provided")

    async with SessionLocal() as db:
        plan = await db.get(WritingPlan, plan_id)
        if plan is None:
            raise ValueError(f"Writing plan {plan_id} not found")

        obj = PlanSource(
            plan_id=plan_id,
            url=url,
            title=title,
            note=note,
            content=content,
            platform=platform,
        )
        db.add(obj)
        await db.commit()
        await db.refresh(obj)

    return {
        "id": obj.id,
        "plan_id": obj.plan_id,
        "url": obj.url or "",
        "title": obj.title or "",
        "note": obj.note or "",
        "content": obj.content or "",
        "platform": obj.platform,
        "created_at": _fmt_dt(obj.created_at),
    }


@mcp.tool()
async def search_writing_plans(keywords: list[str]) -> list[dict]:
    """
    Search existing writing plans (写作方案) by keywords (full-text match on title + strategy).

    Use this as the first step in content-to-writing-plan analysis to find candidate
    plans before asking the LLM to judge similarity.

    Args:
        keywords: List of keywords extracted from the source article,
                  e.g. ["AI", "创业", "一人公司"].

    Returns up to 10 matching plans, each with: id, title, strategy (first 200 chars), tags.
    Returns empty list if no matches or keywords is empty.
    """
    from models import WritingPlan, PlanTag, WritingPlanTag

    if not keywords:
        return []

    async with SessionLocal() as db:
        plans = (await db.execute(
            select(WritingPlan).where(WritingPlan.status == "active")
        )).scalars().all()

        matched = []
        for p in plans:
            haystack = (p.title + " " + (p.strategy or "")).lower()
            if any(kw.lower() in haystack for kw in keywords if kw.strip()):
                matched.append(p)
        matched = matched[:10]

        if not matched:
            return []

        ids = [p.id for p in matched]
        tag_rows = (await db.execute(
            select(WritingPlanTag.plan_id, PlanTag.id, PlanTag.name, PlanTag.color)
            .join(PlanTag, PlanTag.id == WritingPlanTag.tag_id)
            .where(WritingPlanTag.plan_id.in_(ids))
        )).all()
        tags_by_plan: dict[int, list[dict]] = {}
        for row in tag_rows:
            tags_by_plan.setdefault(row.plan_id, []).append(
                {"id": row.id, "name": row.name, "color": row.color}
            )

    return [
        {
            "id": p.id,
            "title": p.title,
            "strategy": (p.strategy or "")[:200],
            "tags": tags_by_plan.get(p.id, []),
        }
        for p in matched
    ]


@mcp.tool()
async def update_writing_plan(
    plan_id: int,
    title: Optional[str] = None,
    strategy: Optional[str] = None,
    tags: Optional[list[str]] = None,
    priority: Optional[int] = None,
) -> dict:
    """
    Update an existing writing plan (写作方案) — strategy / title / tags / priority.

    ⚠️  SCOUT-ONLY — Only call this during a content-to-writing-plan analysis task
    (task body contains "## 任务类型\\ncontent-to-writing-plan").  The editor, writer,
    and illustrator must NEVER call this tool.  The writing plan library stores
    *research guidance* (how to find material, what angle to write), not article
    content.  It may only be refined through the scout's extraction pipeline.

    Args:
        plan_id: ID of the plan to update (from list_writing_plans or search_writing_plans).
        title: New title — must describe the *type* of content, not a specific
               article.  Same naming rule as create_writing_plan (category name,
               no specific persons/numbers).  Omit to leave unchanged.
        strategy: New full markdown strategy, or omit to leave unchanged.
        tags: New tag list (full replacement), or omit to leave unchanged.
        priority: New priority 1-5, or omit to leave unchanged.

    Returns: updated plan with id, title, strategy, tags, priority, status, updated_at.
    Raises an error if the plan is not found.
    """
    from models import WritingPlan, PlanTag, WritingPlanTag
    from sqlalchemy import func, delete

    _TAG_COLORS = ["#6366f1","#8b5cf6","#ec4899","#f59e0b","#10b981","#3b82f6","#ef4444","#14b8a6"]

    async def _get_or_create_tag(db, name: str) -> PlanTag:
        normalized = name.strip().lower()
        existing = (await db.execute(
            select(PlanTag).where(func.lower(PlanTag.name) == normalized)
        )).scalar_one_or_none()
        if existing:
            return existing
        color = _TAG_COLORS[sum(ord(c) for c in name) % len(_TAG_COLORS)]
        tag = PlanTag(name=name.strip(), color=color)
        db.add(tag)
        await db.flush()
        return tag

    async with SessionLocal() as db:
        obj = await db.get(WritingPlan, plan_id)
        if obj is None:
            raise ValueError(f"Writing plan {plan_id} not found")

        if title is not None:
            obj.title = title
        if strategy is not None:
            obj.strategy = strategy
        if priority is not None:
            obj.priority = max(1, min(5, priority))

        if tags is not None:
            await db.execute(delete(WritingPlanTag).where(WritingPlanTag.plan_id == plan_id))
            for name in tags:
                if name.strip():
                    tag = await _get_or_create_tag(db, name)
                    db.add(WritingPlanTag(plan_id=plan_id, tag_id=tag.id))

        await db.commit()
        await db.refresh(obj)

        tag_rows = (await db.execute(
            select(PlanTag)
            .join(WritingPlanTag, WritingPlanTag.tag_id == PlanTag.id)
            .where(WritingPlanTag.plan_id == obj.id)
        )).scalars().all()

    return {
        "id": obj.id,
        "title": obj.title,
        "strategy": obj.strategy or "",
        "tags": [{"id": t.id, "name": t.name, "color": t.color} for t in tag_rows],
        "priority": obj.priority,
        "status": obj.status,
        "updated_at": _fmt_dt(obj.updated_at),
    }


@mcp.tool()
async def add_plan_update(
    plan_id: int,
    description: str,
    source_url: str = "",
) -> dict:
    """
    Record a changelog entry for a writing plan (写作方案).

    ⚠️  SCOUT-ONLY — Only call this during a content-to-writing-plan analysis task
    (task body contains "## 任务类型\\ncontent-to-writing-plan").  The editor, writer,
    and illustrator must NEVER call this tool.

    Call this after every content-to-writing-plan action — whether you updated,
    created, or skipped. The description should explain what changed or why
    you skipped, so the user can review the decision.

    Args:
        plan_id: ID of the affected writing plan.
        description: Human-readable summary of what happened, e.g.
                     "新增角度：产品化路径，补充了 2025 Q1 数据" or
                     "无新增角度，已有方案覆盖相同切入点，跳过".
        source_url: URL of the source article (optional).

    Returns: id, plan_id, description, source_url, created_at.
    """
    from models import WritingPlan, PlanUpdate

    async with SessionLocal() as db:
        plan = await db.get(WritingPlan, plan_id)
        if plan is None:
            raise ValueError(f"Writing plan {plan_id} not found")

        obj = PlanUpdate(
            plan_id=plan_id,
            description=description.strip(),
            source_url=source_url.strip(),
        )
        db.add(obj)
        await db.commit()
        await db.refresh(obj)

    return {
        "id": obj.id,
        "plan_id": obj.plan_id,
        "description": obj.description,
        "source_url": obj.source_url or "",
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
async def upload_image_from_path(
    path: str,
    filename_hint: str = "",
    draft_id: Optional[int] = None,
) -> dict:
    """
    Read a local image file from disk and host it on WeMedia Studio's server.

    Use this (NOT upload_image_from_base64) when you have a locally generated
    image file — for example after running the codex_imagegen skill. Reading
    from disk avoids base64 encoding, which is error-prone for large files.

    Args:
        path: Absolute path to the image file on the local filesystem.
        filename_hint: Optional filename to record as the original name
                       (e.g. "cover.png"). Defaults to the basename of path.
        draft_id: Optional draft ID. When provided, the image is registered in
                  that draft's image library and will appear in the editor's
                  image panel.

    Returns:
        hosted_url: Absolute URL to serve the image from WeMedia Studio.
        filename: The stored filename.
        size_bytes: Size of the stored file in bytes.
        content_type: Detected MIME type.
        draft_image_id: ID of the DraftImage record (only present when draft_id was given).
    """
    import shutil as _shutil

    _ALLOWED = {"image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml", "image/avif"}
    _MAX = 10 * 1024 * 1024

    src = Path(path)
    if not src.exists():
        raise ValueError(f"File not found: {path}")
    if not src.is_file():
        raise ValueError(f"Not a regular file: {path}")

    size = src.stat().st_size
    if size > _MAX:
        raise ValueError(f"Image too large ({size} bytes, max 10 MB)")
    if size < 64:
        raise ValueError(f"File too small to be a valid image ({size} bytes): {path}")

    ct, _ = mimetypes.guess_type(str(src))
    if not ct:
        ct = "image/png"
    ct = ct.split(";")[0].strip()
    if ct not in _ALLOWED:
        raise ValueError(f"Unsupported file type: {ct} — allowed: {', '.join(_ALLOWED)}")

    ext = src.suffix.lower() or mimetypes.guess_extension(ct) or ".png"
    if ext in (".jpe", ".jpeg"):
        ext = ".jpg"

    name = f"{uuid.uuid4().hex}{ext}"
    dest = _UPLOADS_DIR / name
    _shutil.copy2(src, dest)

    api_url = f"/api/uploads/{name}"
    original = filename_hint or src.name
    result: dict = {
        "hosted_url": f"{_BASE_URL}{api_url}",
        "filename": name,
        "size_bytes": size,
        "content_type": ct,
    }
    if draft_id is not None:
        img_id = await _register_draft_image(draft_id, name, original, api_url, size, ct)
        result["draft_image_id"] = img_id

    return result


@mcp.tool()
async def save_draft(
    title: str,
    content: str,
    topic_id: str = "agent",
    status: str = "drafting",
    pipeline_task_id: Optional[int] = None,
    draft_type: Literal["article", "script", "x"] = "article",
) -> dict:
    """
    Save a new article draft to WeMedia Studio's draft box.

    Args:
        title: Article title.
        content: Full article body in Markdown.
        topic_id: Source identifier. Use "agent" for AI-agent-generated articles,
                  or a tweet_id / topic UUID when derived from a specific source.
        status: Initial status — "drafting" (default) or "review".
        pipeline_task_id: Optional pipeline_task_id from the task body (links this
                          draft to its pipeline run record for timeline tracking).
        draft_type: "article"（默认）、"script" 或 "x"。

    Returns: id, title, status, created_at of the newly created draft.
    """
    from models import ArticleDraft, PipelineTask

    async with SessionLocal() as db:
        obj = ArticleDraft(
            topic_id=topic_id,
            title=title,
            content=content,
            status=status,
            draft_type=draft_type,
        )
        db.add(obj)
        await db.commit()
        await db.refresh(obj)

        if pipeline_task_id is not None:
            pt = await db.get(PipelineTask, pipeline_task_id)
            if pt is not None:
                pt.draft_id = obj.id
                # Link the draft back to its writing plan (so it shows in the plan's
                # drafts tab). The pipeline run carries the plan id from dispatch.
                if pt.writing_plan_id is not None and obj.writing_plan_id is None:
                    obj.writing_plan_id = pt.writing_plan_id
                await db.commit()

    return {
        "id": obj.id,
        "title": obj.title,
        "status": obj.status,
        "draft_type": obj.draft_type,
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

    Every agent in the scout → editor → writer → illustrator pipeline MUST
    call this as its first step, using the `account_id` carried in the kanban
    task body/metadata. All downstream output (angle, brief, draft, cover)
    must align with the returned profile — tone, audience, topic_focus,
    taboo, word_range, image_style.

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
