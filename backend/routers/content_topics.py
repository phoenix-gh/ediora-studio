from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func

from database import get_db
from models import ContentTopic, TopicSource, ArticleDraft
from schemas import (
    ContentTopicCreate, ContentTopicUpdate, ContentTopicOut,
    TopicSourceCreate, TopicSourceOut,
)

router = APIRouter(prefix="/api/content-topics", tags=["content-topics"])


async def _build_tree(db: AsyncSession, roots: list[ContentTopic]) -> list[ContentTopicOut]:
    """Recursively attach children + sources + draft_count (max 3 levels)."""
    if not roots:
        return []

    ids = [t.id for t in roots]

    sources_rows = (await db.execute(
        select(TopicSource).where(TopicSource.topic_id.in_(ids))
    )).scalars().all()
    sources_by_topic: dict[int, list] = {i: [] for i in ids}
    for s in sources_rows:
        sources_by_topic[s.topic_id].append(s)

    draft_counts = (await db.execute(
        select(ArticleDraft.content_topic_id, func.count())
        .where(ArticleDraft.content_topic_id.in_(ids))
        .group_by(ArticleDraft.content_topic_id)
    )).all()
    dc_map = {row[0]: row[1] for row in draft_counts}

    children_rows = (await db.execute(
        select(ContentTopic).where(ContentTopic.parent_id.in_(ids))
        .order_by(ContentTopic.priority, ContentTopic.created_at)
    )).scalars().all()
    children_by_parent: dict[int, list] = {i: [] for i in ids}
    for c in children_rows:
        children_by_parent[c.parent_id].append(c)

    result = []
    for t in roots:
        children_out = await _build_tree(db, children_by_parent[t.id])
        out = ContentTopicOut.model_validate(t)
        out.sources = [TopicSourceOut.model_validate(s) for s in sources_by_topic[t.id]]
        out.children = children_out
        out.draft_count = dc_map.get(t.id, 0)
        result.append(out)
    return result


# ── Topics ────────────────────────────────────────────────────────────────────

@router.get("", response_model=list[ContentTopicOut])
async def list_topics(db: AsyncSession = Depends(get_db)):
    roots = (await db.execute(
        select(ContentTopic)
        .where(ContentTopic.parent_id.is_(None))
        .order_by(ContentTopic.priority, ContentTopic.created_at)
    )).scalars().all()
    return await _build_tree(db, list(roots))


@router.post("", response_model=ContentTopicOut, status_code=201)
async def create_topic(body: ContentTopicCreate, db: AsyncSession = Depends(get_db)):
    if body.parent_id:
        parent = await db.get(ContentTopic, body.parent_id)
        if not parent:
            raise HTTPException(400, "Parent topic not found")
        # enforce max 3 levels
        if parent.parent_id:
            grandparent = await db.get(ContentTopic, parent.parent_id)
            if grandparent and grandparent.parent_id:
                raise HTTPException(400, "Topics can only be nested 3 levels deep")
    obj = ContentTopic(**body.model_dump())
    db.add(obj)
    await db.commit()
    await db.refresh(obj)
    return (await _build_tree(db, [obj]))[0]


@router.get("/{topic_id}", response_model=ContentTopicOut)
async def get_topic(topic_id: int, db: AsyncSession = Depends(get_db)):
    obj = await db.get(ContentTopic, topic_id)
    if not obj:
        raise HTTPException(404, "Topic not found")
    return (await _build_tree(db, [obj]))[0]


@router.patch("/{topic_id}", response_model=ContentTopicOut)
async def update_topic(topic_id: int, body: ContentTopicUpdate, db: AsyncSession = Depends(get_db)):
    obj = await db.get(ContentTopic, topic_id)
    if not obj:
        raise HTTPException(404, "Topic not found")
    for field, val in body.model_dump(exclude_none=True).items():
        setattr(obj, field, val)
    await db.commit()
    await db.refresh(obj)
    return (await _build_tree(db, [obj]))[0]


@router.delete("/{topic_id}", status_code=204)
async def delete_topic(topic_id: int, db: AsyncSession = Depends(get_db)):
    obj = await db.get(ContentTopic, topic_id)
    if not obj:
        raise HTTPException(404, "Topic not found")
    await db.delete(obj)
    await db.commit()


# ── Sources ───────────────────────────────────────────────────────────────────

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


# ── Quick save from Chrome plugin (no topic_id in path) ───────────────────────

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
