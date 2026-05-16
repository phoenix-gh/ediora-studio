from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc
from pydantic import BaseModel
from datetime import datetime, timezone, timedelta

from database import get_db
from models import ProductHuntPost

router = APIRouter(prefix="/producthunt", tags=["producthunt"])


class ProductHuntPostOut(BaseModel):
    id: str
    title: str
    tagline: str
    url: str
    thumbnail_url: str
    images: list
    description: str
    topics: list
    votes: int
    published_at: datetime
    collected_at: datetime

    model_config = {"from_attributes": True}


@router.get("/posts", response_model=list[ProductHuntPostOut])
async def list_posts(
    days: int = 7,
    limit: int = 100,
    search: str = "",
    db: AsyncSession = Depends(get_db),
):
    since = datetime.now(timezone.utc) - timedelta(days=days)
    rows = (await db.execute(
        select(ProductHuntPost)
        .where(ProductHuntPost.published_at >= since)
        .order_by(desc(ProductHuntPost.published_at))
        .limit(limit)
    )).scalars().all()
    if search:
        q = search.lower()
        rows = [r for r in rows if q in r.title.lower() or q in r.tagline.lower() or q in r.description.lower()]
    return rows


@router.post("/collect")
async def trigger_collect(db: AsyncSession = Depends(get_db)):
    from producthunt_collector import collect_producthunt
    new_count = await collect_producthunt(db)
    return {"ok": True, "new_posts": new_count}
