from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from database import get_db, SessionLocal
from models import Topic, TopicCluster
from schemas import TopicOut, TopicCreate, TopicStatusUpdate, GenerateResult
from embeddings import embed_text
from topic_clustering import cluster_embedding_text, event_key, similarity

router = APIRouter(prefix="/topics", tags=["topics"])

@router.get("", response_model=list[TopicOut])
async def list_topics(
    status: str | None = Query(None),
    category: str | None = Query(None),
    urgency: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
):
    q = select(Topic).order_by(Topic.score.desc())
    if status:
        q = q.where(Topic.status == status)
    if category:
        q = q.where(Topic.category == category)
    if urgency:
        q = q.where(Topic.urgency == urgency)
    rows = (await db.execute(q)).scalars().all()
    collapsed = {}
    result = []
    for row in rows:
        text = f"{row.cluster_title or row.title}\n{row.summary}"
        semantic_key = row.cluster_id or event_key(text)
        if not semantic_key:
            matched_key = None
            for key, existing_row in collapsed.items():
                existing_text = f"{existing_row.cluster_title or existing_row.title}\n{existing_row.summary}"
                if similarity(text, existing_text) >= 0.72:
                    matched_key = key
                    break
            semantic_key = matched_key or row.id

        existing = collapsed.get(semantic_key)
        if existing is None:
            collapsed[semantic_key] = row
            result.append(row)
            continue
        if row.status == "accepted" and existing.status != "accepted":
            idx = result.index(existing)
            result[idx] = row
            collapsed[semantic_key] = row
        elif row.score > existing.score and existing.status != "accepted":
            idx = result.index(existing)
            result[idx] = row
            collapsed[semantic_key] = row
    return result

@router.post("", response_model=TopicOut, status_code=201)
async def create_topic(body: TopicCreate, db: AsyncSession = Depends(get_db)):
    topic = Topic(**body.model_dump())
    db.add(topic)
    await db.commit()
    await db.refresh(topic)
    return topic

@router.patch("/{topic_id}/status", response_model=TopicOut)
async def update_status(topic_id: str, body: TopicStatusUpdate, db: AsyncSession = Depends(get_db)):
    topic = await db.get(Topic, topic_id)
    if not topic:
        raise HTTPException(404, "not found")
    valid = {"pending", "accepted", "rejected", "snoozed", "transferred"}
    if body.status not in valid:
        raise HTTPException(400, f"status must be one of {valid}")
    topic.status = body.status
    await db.commit()
    await db.refresh(topic)
    return topic


@router.post("/generate", response_model=GenerateResult)
async def generate_topics():
    """Trigger LLM analysis to generate topic suggestions from recent posts."""
    from analyzer import analyze_topics
    async with SessionLocal() as db:
        count = await analyze_topics(db)
    return GenerateResult(new_topics=count, message=f"生成了 {count} 个新选题")


@router.post("/clusters/backfill-embeddings")
async def backfill_cluster_embeddings(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(TopicCluster))).scalars().all()
    updated = 0
    skipped = 0
    for row in rows:
        if row.embedding:
            skipped += 1
            continue
        try:
            embedding, model = await embed_text(cluster_embedding_text({
                "canonical_title": row.canonical_title,
                "summary": row.summary,
                "sources": row.sources or [],
                "items": [],
            }))
        except Exception as e:
            return {"updated": updated, "skipped": skipped, "error": str(e)}
        if not embedding:
            skipped += 1
            continue
        row.embedding = embedding
        row.embedding_model = model
        updated += 1
    await db.commit()
    return {"updated": updated, "skipped": skipped}
