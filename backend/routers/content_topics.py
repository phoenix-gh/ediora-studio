from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, delete, update as sa_update

from database import get_db
from models import ContentTopic, TopicSource, TopicTag, ContentTopicTag, ArticleDraft
from schemas import (
    ContentTopicCreate, ContentTopicUpdate, ContentTopicOut,
    TopicTagCreate, TopicTagOut,
    TopicSourceCreate, TopicSourceOut,
    ArticleDraftSummary, DispatchResponse,
)

router = APIRouter(prefix="/content-topics", tags=["content-topics"])

_TAG_COLORS = [
    "#6366f1", "#8b5cf6", "#ec4899", "#f59e0b",
    "#10b981", "#3b82f6", "#ef4444", "#14b8a6",
]


def _color_for_name(name: str) -> str:
    return _TAG_COLORS[sum(ord(c) for c in name) % len(_TAG_COLORS)]


async def _get_or_create_tag(db: AsyncSession, name: str) -> TopicTag:
    normalized = name.strip().lower()
    existing = (await db.execute(
        select(TopicTag).where(func.lower(TopicTag.name) == normalized)
    )).scalar_one_or_none()
    if existing:
        return existing
    tag = TopicTag(name=name.strip(), color=_color_for_name(name))
    db.add(tag)
    await db.flush()
    return tag


async def _set_topic_tags(db: AsyncSession, topic_id: int, tag_names: list[str]) -> None:
    await db.execute(
        delete(ContentTopicTag).where(ContentTopicTag.topic_id == topic_id)
    )
    for name in tag_names:
        if name.strip():
            tag = await _get_or_create_tag(db, name)
            db.add(ContentTopicTag(topic_id=topic_id, tag_id=tag.id))


async def _enrich_topics(db: AsyncSession, topics: list[ContentTopic]) -> list[ContentTopicOut]:
    if not topics:
        return []

    ids = [t.id for t in topics]

    tag_rows = (await db.execute(
        select(ContentTopicTag.topic_id, TopicTag)
        .join(TopicTag, ContentTopicTag.tag_id == TopicTag.id)
        .where(ContentTopicTag.topic_id.in_(ids))
        .order_by(TopicTag.name)
    )).all()
    tags_by_topic: dict[int, list] = {i: [] for i in ids}
    for topic_id, tag in tag_rows:
        tags_by_topic[topic_id].append(tag)

    source_rows = (await db.execute(
        select(TopicSource)
        .where(TopicSource.topic_id.in_(ids))
        .order_by(TopicSource.created_at.desc())
    )).scalars().all()
    sources_by_topic: dict[int, list] = {i: [] for i in ids}
    for s in source_rows:
        sources_by_topic[s.topic_id].append(s)

    draft_counts = (await db.execute(
        select(ArticleDraft.content_topic_id, func.count())
        .where(ArticleDraft.content_topic_id.in_(ids))
        .group_by(ArticleDraft.content_topic_id)
    )).all()
    dc_map = {row[0]: row[1] for row in draft_counts}

    result = []
    for t in topics:
        out = ContentTopicOut.model_validate(t)
        out.tags = [TopicTagOut.model_validate(tag) for tag in tags_by_topic[t.id]]
        out.sources = [TopicSourceOut.model_validate(s) for s in sources_by_topic[t.id]]
        out.source_count = len(sources_by_topic[t.id])
        out.draft_count = dc_map.get(t.id, 0)
        result.append(out)
    return result


# ── Tag endpoints (registered before /{topic_id} to avoid routing conflict) ───

@router.get("/tags", response_model=list[TopicTagOut])
async def list_tags(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(
        select(TopicTag).order_by(TopicTag.name)
    )).scalars().all()
    return rows


@router.post("/tags", response_model=TopicTagOut, status_code=201)
async def create_tag(body: TopicTagCreate, db: AsyncSession = Depends(get_db)):
    tag = await _get_or_create_tag(db, body.name)
    await db.commit()
    await db.refresh(tag)
    return tag


@router.delete("/tags/{tag_id}", status_code=204)
async def delete_tag(tag_id: int, db: AsyncSession = Depends(get_db)):
    tag = await db.get(TopicTag, tag_id)
    if not tag:
        raise HTTPException(404, "Tag not found")
    await db.execute(delete(ContentTopicTag).where(ContentTopicTag.tag_id == tag_id))
    await db.delete(tag)
    await db.commit()


# ── Topic endpoints ────────────────────────────────────────────────────────────

@router.get("", response_model=list[ContentTopicOut])
async def list_topics(tags: str | None = None, db: AsyncSession = Depends(get_db)):
    q = select(ContentTopic).order_by(ContentTopic.priority, ContentTopic.created_at.desc())

    if tags:
        tag_names = [t.strip().lower() for t in tags.split(",") if t.strip()]
        if tag_names:
            # OR filter: return topics that have ANY of the given tags
            q = q.where(
                ContentTopic.id.in_(
                    select(ContentTopicTag.topic_id)
                    .join(TopicTag, ContentTopicTag.tag_id == TopicTag.id)
                    .where(func.lower(TopicTag.name).in_(tag_names))
                )
            )

    rows = (await db.execute(q)).scalars().all()
    return await _enrich_topics(db, list(rows))


@router.post("", response_model=ContentTopicOut, status_code=201)
async def create_topic(body: ContentTopicCreate, db: AsyncSession = Depends(get_db)):
    obj = ContentTopic(
        title=body.title,
        brief=body.brief,
        priority=body.priority,
    )
    db.add(obj)
    await db.flush()
    await _set_topic_tags(db, obj.id, body.tags)
    await db.commit()
    await db.refresh(obj)
    return (await _enrich_topics(db, [obj]))[0]


@router.get("/{topic_id}", response_model=ContentTopicOut)
async def get_topic(topic_id: int, db: AsyncSession = Depends(get_db)):
    obj = await db.get(ContentTopic, topic_id)
    if not obj:
        raise HTTPException(404, "Topic not found")
    return (await _enrich_topics(db, [obj]))[0]


@router.patch("/{topic_id}", response_model=ContentTopicOut)
async def update_topic(topic_id: int, body: ContentTopicUpdate, db: AsyncSession = Depends(get_db)):
    obj = await db.get(ContentTopic, topic_id)
    if not obj:
        raise HTTPException(404, "Topic not found")
    for field, val in body.model_dump(exclude_none=True, exclude={"tags"}).items():
        setattr(obj, field, val)
    if body.tags is not None:
        await _set_topic_tags(db, obj.id, body.tags)
    await db.commit()
    await db.refresh(obj)
    return (await _enrich_topics(db, [obj]))[0]


@router.delete("/{topic_id}", status_code=204)
async def delete_topic(topic_id: int, db: AsyncSession = Depends(get_db)):
    obj = await db.get(ContentTopic, topic_id)
    if not obj:
        raise HTTPException(404, "Topic not found")
    # Detach drafts instead of deleting them
    await db.execute(
        sa_update(ArticleDraft)
        .where(ArticleDraft.content_topic_id == topic_id)
        .values(content_topic_id=None)
    )
    await db.execute(delete(ContentTopicTag).where(ContentTopicTag.topic_id == topic_id))
    await db.execute(delete(TopicSource).where(TopicSource.topic_id == topic_id))
    await db.delete(obj)
    await db.commit()


# ── Drafts list ───────────────────────────────────────────────────────────────

@router.get("/{topic_id}/drafts", response_model=list[ArticleDraftSummary])
async def list_topic_drafts(topic_id: int, db: AsyncSession = Depends(get_db)):
    obj = await db.get(ContentTopic, topic_id)
    if not obj:
        raise HTTPException(404, "Topic not found")
    rows = (await db.execute(
        select(ArticleDraft)
        .where(ArticleDraft.content_topic_id == topic_id)
        .order_by(ArticleDraft.created_at.desc())
    )).scalars().all()
    return rows


# ── Dispatch ──────────────────────────────────────────────────────────────────

@router.post("/{topic_id}/dispatch", response_model=DispatchResponse)
async def dispatch_topic(topic_id: int, db: AsyncSession = Depends(get_db)):
    obj = await db.get(ContentTopic, topic_id)
    if not obj:
        raise HTTPException(404, "Topic not found")
    if not obj.brief.strip():
        raise HTTPException(400, "Brief is empty — add a research brief before dispatching")

    from hermes_kanban_client import HermesKanbanClient, HermesKanbanError
    try:
        kanban = HermesKanbanClient()
        task_id = await kanban.create_task(
            title=f"[调研] {obj.title}",
            body=obj.brief,
            assignee="scout",
        )
    except HermesKanbanError as e:
        raise HTTPException(502, f"Hermes 不可用: {e}")

    return DispatchResponse(task_id=task_id, kanban_url="/studio")


# ── Sources (unchanged) ───────────────────────────────────────────────────────

@router.get("/{topic_id}/sources", response_model=list[TopicSourceOut])
async def list_sources(topic_id: int, db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(
        select(TopicSource).where(TopicSource.topic_id == topic_id)
        .order_by(TopicSource.created_at.desc())
    )).scalars().all()
    return rows


@router.post("/{topic_id}/sources", response_model=TopicSourceOut, status_code=201)
async def add_source(topic_id: int, body: TopicSourceCreate, db: AsyncSession = Depends(get_db)):
    obj = await db.get(ContentTopic, topic_id)
    if not obj:
        raise HTTPException(404, "Topic not found")
    source = TopicSource(**{**body.model_dump(), "topic_id": topic_id})
    db.add(source)

    if body.draft_id is not None:
        draft = await db.get(ArticleDraft, body.draft_id)
        if not draft:
            raise HTTPException(404, "Draft not found")
        existing = list(draft.sources or [])
        existing.append({"url": body.url, "title": body.title, "note": body.note})
        draft.sources = existing

    await db.commit()
    await db.refresh(source)
    return source


@router.delete("/{topic_id}/sources/{source_id}", status_code=204)
async def delete_source(topic_id: int, source_id: int, db: AsyncSession = Depends(get_db)):
    obj = await db.get(TopicSource, source_id)
    if not obj or obj.topic_id != topic_id:
        raise HTTPException(404, "Source not found")
    await db.delete(obj)
    await db.commit()


@router.post("/sources/quick-save", response_model=TopicSourceOut, status_code=201)
async def quick_save_source(body: TopicSourceCreate, db: AsyncSession = Depends(get_db)):
    obj = await db.get(ContentTopic, body.topic_id)
    if not obj:
        raise HTTPException(404, "Topic not found")
    source = TopicSource(**body.model_dump())
    db.add(source)
    await db.commit()
    await db.refresh(source)
    return source
