"""
WeMedia Studio MCP Server
Exposes key data as tools for AI agents via Streamable HTTP transport.
Mount at /mcp in main.py: app.mount("/mcp", mcp.streamable_http_app())
"""

import mimetypes
import os
import uuid
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional
from mcp.server.fastmcp import FastMCP
from sqlalchemy import select, desc, delete as sa_delete
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
    from models import RefMaterial

    limit = max(1, min(limit, 100))

    async with SessionLocal() as db:
        rows = (await db.execute(
            select(RefMaterial)
            .where(RefMaterial.platform != "x")
            .order_by(desc(RefMaterial.created_at)).limit(500)
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
async def search_ref_materials(
    q: str = "",
    category: str = "",
    scene_tag: str = "",
    min_score: int = 60,
    limit: int = 10,
) -> list[dict]:
    """
    Search the AI 信息素材库 (collected high-engagement X posts + viral replies).

    Use this when writing articles or X posts to find evidence, hooks, data
    points, hot takes, or controversy — real content people actually engaged
    with, scored 0-100 by engagement (likes/reposts/replies/views).

    Args:
        q: Keyword to search in material text (case-insensitive).
        category: Filter by category — one of: 产品动态, 观点争论, 工具实战,
                  翻车吐槽, 数据事实, 行业八卦, 其他. Leave empty for all.
        scene_tag: Filter by intended position in your writing — one of:
                   opener (开头钩子), argument (论据), closer (收尾),
                   twist (反转), resonance (共鸣), warning (警示).
        min_score: Minimum engagement score 0-100 (default 60).
        limit: Maximum results (max 50, default 10).

    Returns a list sorted by score descending. Each item includes:
    id, text (cleaned), score, category, scene_tags, likes, source_url,
    is_reply (True = viral reply under a hot post, often the wittiest take).
    """
    from models import RefMaterial

    limit = max(1, min(limit, 50))

    async with SessionLocal() as db:
        stmt = (
            select(RefMaterial)
            .where(RefMaterial.status == "active", RefMaterial.score >= min_score)
            .order_by(desc(RefMaterial.score))
            .limit(500)
        )
        if category:
            stmt = stmt.where(RefMaterial.category == category)
        rows = (await db.execute(stmt)).scalars().all()

    result = list(rows)
    # scene_tags 是 JSON 列，跨 SQLite/PG 的 contains 查询不可移植 → 内存过滤
    if scene_tag:
        result = [r for r in result if scene_tag in (r.scene_tags or [])]
    if q:
        s = q.lower()
        result = [r for r in result if s in (r.text_clean or r.text).lower()]

    return [
        {
            "id": m.id,
            "text": m.text_clean or m.text,
            "score": m.score,
            "category": m.category or "",
            "scene_tags": m.scene_tags or [],
            "likes": m.likes,
            "source_url": m.source_url or "",
            "is_reply": m.parent_source_id is not None,
        }
        for m in result[:limit]
    ]


@mcp.tool()
async def save_quote(
    text: str,
    author: str = "",
    source: str = "",
    source_url: str = "",
    scene_tags: Optional[list[str]] = None,
    writing_plan_id: Optional[int] = None,
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
        writing_plan_id: Associate with a writing plan from 写作方案 (optional).

    Returns: id, text, author, scene_tags, created_at.
    """
    from models import RefMaterial

    valid_tags = {"opener", "closer", "argument", "twist", "resonance", "warning"}
    tags = [t for t in (scene_tags or []) if t in valid_tags]

    async with SessionLocal() as db:
        obj = RefMaterial(
            text=text.strip(),
            author=author.strip(),
            source=source.strip(),
            source_url=source_url.strip(),
            scene_tags=tags,
            writing_plan_id=writing_plan_id,
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
    draft_type: str = "article",
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
        draft_type: "article"（默认）或 "script"。

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


# ── 每日内容计划（daily_plan 总编任务专用） ────────────────────────────────────

@mcp.tool()
async def get_topic_candidates(
    sources: Optional[list[str]] = None,
    limit_per_source: int = 10,
) -> list[dict]:
    """
    统一选题候选池：近 24h 各信息源高热内容 + 写作方案。

    供每日计划总编（daily_plan 任务）调用。统一结构：
    {source, title, summary, url, heat, published_at}
    source ∈ x / github_release / paper / kr / juejin / v2ex / reddit /
             producthunt / youtube / writing_plan
    sources 传子集可只拉部分源；limit_per_source 每源上限（X 固定 50，写作方案固定 20）。
    """
    from models import (XPost, GithubRelease, Paper, KrArticle, JuejinArticle,
                        V2exTopic, RedditPost, ProductHuntPost, YoutubeVideo,
                        WritingPlan)

    since = datetime.now(timezone.utc) - timedelta(hours=24)
    lim = max(1, min(int(limit_per_source), 50))
    want = set(sources) if sources else None

    def _on(key: str) -> bool:
        return want is None or key in want

    def _c(source, title, summary, url, heat, published_at) -> dict:
        return {"source": source, "title": (title or "")[:120],
                "summary": (summary or "")[:300], "url": url or "",
                "heat": int(heat or 0), "published_at": _fmt_dt(published_at)}

    out: list[dict] = []
    async with SessionLocal() as db:
        if _on("x"):
            rows = (await db.execute(
                select(XPost)
                .where(XPost.published_at >= since, XPost.is_reply == False)  # noqa: E712
                .order_by(desc(XPost.likes + XPost.reposts)).limit(50)
            )).scalars().all()
            out += [_c("x", f"@{p.username}: {p.content[:80]}", p.content, p.url,
                       p.likes + p.reposts, p.published_at) for p in rows]

        if _on("github_release"):
            rows = (await db.execute(
                select(GithubRelease).where(GithubRelease.published_at >= since)
                .order_by(desc(GithubRelease.published_at)).limit(lim)
            )).scalars().all()
            out += [_c("github_release", f"{r.repo_id} {r.tag_name}", r.body,
                       r.html_url, 0, r.published_at) for r in rows]

        if _on("paper"):
            rows = (await db.execute(
                select(Paper).where(Paper.collected_at >= since)
                .order_by(desc(Paper.collected_at)).limit(lim)
            )).scalars().all()
            out += [_c("paper", p.title_cn or p.title, p.abstract_cn or p.abstract,
                       p.arxiv_url, 0, p.submitted_at) for p in rows]

        if _on("kr"):
            rows = (await db.execute(
                select(KrArticle).where(KrArticle.published_at >= since)
                .order_by(desc(KrArticle.stat_read)).limit(lim)
            )).scalars().all()
            out += [_c("kr", a.title, a.summary, a.url, a.stat_read, a.published_at)
                    for a in rows]

        if _on("juejin"):
            rows = (await db.execute(
                select(JuejinArticle).where(JuejinArticle.published_at >= since)
                .order_by(desc(JuejinArticle.view_count)).limit(lim)
            )).scalars().all()
            out += [_c("juejin", a.title, a.brief, a.url, a.view_count, a.published_at)
                    for a in rows]

        if _on("v2ex"):
            rows = (await db.execute(
                select(V2exTopic).where(V2exTopic.published_at >= since)
                .order_by(desc(V2exTopic.replies)).limit(lim)
            )).scalars().all()
            out += [_c("v2ex", t.title, t.content, t.url, t.replies, t.published_at)
                    for t in rows]

        if _on("reddit"):
            rows = (await db.execute(
                select(RedditPost).where(RedditPost.published_at >= since)
                .order_by(desc(RedditPost.score)).limit(lim)
            )).scalars().all()
            out += [_c("reddit", p.title, p.body, p.url, p.score, p.published_at)
                    for p in rows]

        if _on("producthunt"):
            rows = (await db.execute(
                select(ProductHuntPost).where(ProductHuntPost.published_at >= since)
                .order_by(desc(ProductHuntPost.votes)).limit(lim)
            )).scalars().all()
            out += [_c("producthunt", f"{p.title} — {p.tagline}", p.description,
                       p.url, p.votes, p.published_at) for p in rows]

        if _on("youtube"):
            rows = (await db.execute(
                select(YoutubeVideo).where(YoutubeVideo.published_at >= since)
                .order_by(desc(YoutubeVideo.views)).limit(lim)
            )).scalars().all()
            out += [_c("youtube", f"[{v.channel_name}] {v.title}", v.description,
                       v.url, v.views, v.published_at) for v in rows]

        if _on("writing_plan"):
            rows = (await db.execute(
                select(WritingPlan).where(WritingPlan.status == "active")
                .order_by(WritingPlan.priority).limit(20)
            )).scalars().all()
            out += [_c("writing_plan", w.title, w.strategy, "", 0, w.updated_at)
                    for w in rows]

    return out


_PLAN_CONTENT_TYPES = {"long", "short", "story", "share"}


@mcp.tool()
async def save_daily_plan(plan_id: int, items: list[dict], note: str = "") -> dict:
    """
    写回今日计划（daily_plan 总编任务的产出）。重复调用整体替换（幂等），成功后计划置 ready。

    items 每条：{account_id, title, angle, reason, content_type, sources, group_key, is_primary}
    - content_type ∈ long|short|story|share
    - 撞题公用：同 group_key 的 items 共享一稿，必须同 content_type，且恰好一条 is_primary=true
    - 无 group_key 的 item 各自独立（is_primary 自动置 true）
    校验失败返回 {"error": "..."}，不落任何数据。
    """
    from models import DailyPlan, DailyPlanItem, PublishAccount

    async with SessionLocal() as db:
        plan = await db.get(DailyPlan, plan_id)
        if plan is None:
            return {"error": f"daily plan {plan_id} not found"}

        acc_ids = set((await db.execute(select(PublishAccount.id))).scalars().all())

        groups: dict[str, list[dict]] = {}
        for i, it in enumerate(items):
            if not (it.get("title") or "").strip():
                return {"error": f"items[{i}]: title 不能为空"}
            if it.get("account_id") not in acc_ids:
                return {"error": f"items[{i}]: account_id '{it.get('account_id')}' 不存在"}
            ct = it.get("content_type", "long")
            if ct not in _PLAN_CONTENT_TYPES:
                return {"error": f"items[{i}]: content_type '{ct}' 非法（long|short|story|share）"}
            gk = (it.get("group_key") or "").strip()
            if gk:
                groups.setdefault(gk, []).append(it)

        for gk, members in groups.items():
            if len({m.get("content_type", "long") for m in members}) > 1:
                return {"error": f"group '{gk}' 内 content_type 不一致（同组必须同体裁）"}
            primaries = [m for m in members if m.get("is_primary")]
            if len(primaries) != 1:
                return {"error": f"group '{gk}' 必须恰好一条 is_primary=true（当前 {len(primaries)} 条）"}

        await db.execute(sa_delete(DailyPlanItem).where(DailyPlanItem.plan_id == plan_id))
        for it in items:
            gk = (it.get("group_key") or "").strip()
            db.add(DailyPlanItem(
                plan_id=plan_id,
                account_id=it["account_id"],
                title=it["title"].strip(),
                angle=(it.get("angle") or "").strip(),
                reason=(it.get("reason") or "").strip(),
                content_type=it.get("content_type", "long"),
                sources=it.get("sources") or [],
                group_key=gk,
                is_primary=bool(it.get("is_primary")) if gk else True,
            ))
        plan.status = "ready"
        plan.planner_note = note or ""
        await db.commit()
        return {"ok": True, "plan_id": plan_id, "item_count": len(items)}


@mcp.tool()
async def get_recent_outputs(days: int = 7) -> list[dict]:
    """
    近 N 天已计划/已产出的标题清单（查重用）。daily_plan 任务书里通常已附，此工具备查。
    返回 [{type: "plan_item"|"draft", title}]。
    """
    from models import ArticleDraft, DailyPlanItem

    cutoff = datetime.now(timezone.utc) - timedelta(days=max(1, min(int(days), 30)))
    out: list[dict] = []
    async with SessionLocal() as db:
        for t in (await db.execute(
            select(DailyPlanItem.title).where(DailyPlanItem.created_at >= cutoff)
        )).scalars().all():
            if t and t.strip():
                out.append({"type": "plan_item", "title": t})
        for t in (await db.execute(
            select(ArticleDraft.title).where(ArticleDraft.created_at >= cutoff)
        )).scalars().all():
            if t and t.strip():
                out.append({"type": "draft", "title": t})
    return out
