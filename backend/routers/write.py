from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc
from database import get_db
from models import ArticleDraft, Topic, WriterPersona
from schemas import (
    ArticleDraftCreate,
    ArticleDraftRecordOut,
    ArticleDraftRequest,
    ArticleDraftOut,
    ArticleDraftUpdate,
)

router = APIRouter(prefix="/write", tags=["write"])


VALID_DRAFT_STATUSES = {"drafting", "editing", "ready", "published", "archived"}


def _title_from_content(content: str, fallback: str) -> str:
    for line in content.splitlines():
        cleaned = line.strip().lstrip("#").strip()
        if cleaned:
            return cleaned[:120]
    return fallback[:120]


@router.post("/generate", response_model=ArticleDraftOut)
async def generate_draft(body: ArticleDraftRequest, db: AsyncSession = Depends(get_db)):
    topic = await db.get(Topic, body.topic_id)
    if not topic:
        raise HTTPException(404, "topic not found")

    persona_prompt = ""
    if body.persona_id is not None:
        persona = await db.get(WriterPersona, body.persona_id)
        if persona:
            persona_prompt = persona.prompt

    from llm import generate_article_draft
    draft = await generate_article_draft(
        topic_title=topic.title,
        topic_summary=topic.summary,
        recommend_reason=topic.recommend_reason,
        sources=topic.sources or [],
        tags=topic.tags or [],
        persona_prompt=persona_prompt,
    )
    if not draft:
        raise HTTPException(502, "LLM 未返回有效草稿")

    obj = ArticleDraft(
        topic_id=topic.id,
        title=_title_from_content(draft, topic.title),
        content=draft,
        status="drafting",
        persona_id=body.persona_id,
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )
    db.add(obj)
    await db.commit()
    await db.refresh(obj)
    return ArticleDraftOut(
        id=obj.id,
        topic_id=topic.id,
        title=obj.title,
        draft=obj.content,
        content=obj.content,
        status=obj.status,
        persona_id=obj.persona_id,
        version=obj.version,
        created_at=obj.created_at,
        updated_at=obj.updated_at,
    )


@router.get("/drafts", response_model=list[ArticleDraftRecordOut])
async def list_drafts(topic_id: str | None = Query(None), db: AsyncSession = Depends(get_db)):
    q = select(ArticleDraft).order_by(desc(ArticleDraft.updated_at))
    if topic_id:
        q = q.where(ArticleDraft.topic_id == topic_id)
    rows = (await db.execute(q)).scalars().all()
    return rows


@router.post("/drafts", response_model=ArticleDraftRecordOut, status_code=201)
async def create_draft(body: ArticleDraftCreate, db: AsyncSession = Depends(get_db)):
    topic = await db.get(Topic, body.topic_id)
    if not topic:
        raise HTTPException(404, "topic not found")
    if body.status not in VALID_DRAFT_STATUSES:
        raise HTTPException(400, f"status must be one of {VALID_DRAFT_STATUSES}")

    now = datetime.now(timezone.utc)
    obj = ArticleDraft(
        topic_id=body.topic_id,
        title=body.title or _title_from_content(body.content, topic.title),
        content=body.content,
        status=body.status,
        persona_id=body.persona_id,
        created_at=now,
        updated_at=now,
    )
    db.add(obj)
    await db.commit()
    await db.refresh(obj)
    return obj


@router.delete("/drafts/{draft_id}", status_code=204)
async def delete_draft(draft_id: int, db: AsyncSession = Depends(get_db)):
    obj = await db.get(ArticleDraft, draft_id)
    if not obj:
        raise HTTPException(404, "draft not found")
    await db.delete(obj)
    await db.commit()


@router.patch("/drafts/{draft_id}", response_model=ArticleDraftRecordOut)
async def update_draft(draft_id: int, body: ArticleDraftUpdate, db: AsyncSession = Depends(get_db)):
    obj = await db.get(ArticleDraft, draft_id)
    if not obj:
        raise HTTPException(404, "draft not found")

    data = body.model_dump(exclude_none=True)
    if "status" in data and data["status"] not in VALID_DRAFT_STATUSES:
        raise HTTPException(400, f"status must be one of {VALID_DRAFT_STATUSES}")

    for key, value in data.items():
        setattr(obj, key, value)
    obj.version += 1
    obj.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(obj)
    return obj
