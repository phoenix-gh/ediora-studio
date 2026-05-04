from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from database import get_db, SessionLocal
from models import EconomicItem
from schemas import EconomicItemOut, GenerateResult

router = APIRouter(prefix="/economic", tags=["economic"])


@router.get("", response_model=list[EconomicItemOut])
async def list_economic(
    category: str | None = Query(None),
    impact: str | None = Query(None),
    limit: int = Query(30, le=100),
    db: AsyncSession = Depends(get_db),
):
    q = select(EconomicItem).order_by(EconomicItem.published_at.desc())
    if category:
        q = q.where(EconomicItem.category == category)
    if impact:
        q = q.where(EconomicItem.impact == impact)
    q = q.limit(limit)
    rows = (await db.execute(q)).scalars().all()
    return rows


@router.post("/generate", response_model=GenerateResult)
async def generate_economic():
    """Trigger LLM analysis to generate economic dynamics from recent posts."""
    from analyzer import analyze_economic
    async with SessionLocal() as db:
        count = await analyze_economic(db)
    return GenerateResult(new_economic=count, message=f"生成了 {count} 条经济动态")
