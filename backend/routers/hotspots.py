from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from database import get_db, SessionLocal
from models import Hotspot
from schemas import HotspotOut, HotspotCreate, GenerateResult

router = APIRouter(prefix="/hotspots", tags=["hotspots"])

@router.get("", response_model=list[HotspotOut])
async def list_hotspots(
    category: str | None = Query(None),
    trend: str | None = Query(None),
    limit: int = Query(20, le=100),
    db: AsyncSession = Depends(get_db),
):
    q = select(Hotspot).order_by(Hotspot.heat.desc())
    if category:
        q = q.where(Hotspot.category == category)
    if trend:
        q = q.where(Hotspot.trend == trend)
    q = q.limit(limit)
    rows = (await db.execute(q)).scalars().all()
    return rows

@router.post("", response_model=HotspotOut, status_code=201)
async def create_hotspot(body: HotspotCreate, db: AsyncSession = Depends(get_db)):
    from models import now_utc
    existing = await db.get(Hotspot, body.id)
    if existing:
        for k, v in body.model_dump(exclude={"id"}).items():
            setattr(existing, k, v)
        existing.updated_at = now_utc()
        await db.commit()
        await db.refresh(existing)
        return existing
    h = Hotspot(**body.model_dump())
    db.add(h)
    await db.commit()
    await db.refresh(h)
    return h


@router.post("/generate", response_model=GenerateResult)
async def generate_hotspots():
    """Trigger LLM analysis to detect trending hotspots from recent posts."""
    from analyzer import analyze_hotspots
    async with SessionLocal() as db:
        count = await analyze_hotspots(db)
    return GenerateResult(new_hotspots=count, message=f"检测到 {count} 个新热点")
