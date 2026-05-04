from fastapi import APIRouter, Query
from sqlalchemy import select, desc
from datetime import datetime, timezone, timedelta
from pydantic import BaseModel

from database import SessionLocal
from models import Paper

router = APIRouter(prefix="/papers", tags=["papers"])


class PaperOut(BaseModel):
    arxiv_id: str
    title: str
    abstract: str
    authors: list[str]
    categories: list[str]
    primary_category: str
    arxiv_url: str
    pdf_url: str
    submitted_at: datetime
    collected_at: datetime

    model_config = {"from_attributes": True}


@router.get("", response_model=list[PaperOut])
async def list_papers(
    limit: int = Query(50, le=200),
    category: str | None = Query(None),
    days: int = Query(7, ge=1, le=30),
    search: str | None = Query(None),
):
    since = datetime.now(timezone.utc) - timedelta(days=days)
    async with SessionLocal() as db:
        q = (
            select(Paper)
            .where(Paper.submitted_at >= since)
            .order_by(desc(Paper.submitted_at))
            .limit(limit)
        )
        if category:
            q = q.where(Paper.primary_category == category)
        if search:
            q = q.where(Paper.title.contains(search) | Paper.abstract.contains(search))
        rows = (await db.execute(q)).scalars().all()
    return rows


@router.post("/collect")
async def collect_papers_manual():
    from paper_collector import collect_papers
    async with SessionLocal() as db:
        result = await collect_papers(db)
    return result
