from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc, or_

from database import get_db
from models import Quote
from schemas import QuoteCreate, QuoteUpdate, QuoteOut

router = APIRouter(prefix="/quotes", tags=["quotes"])


@router.get("", response_model=list[QuoteOut])
async def list_quotes(
    q: str = Query("", description="搜索原文/作者/出处"),
    tag: str = Query("", description="场景标签过滤"),
    topic_id: int = Query(0),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(Quote).order_by(desc(Quote.created_at))
    rows = (await db.execute(stmt)).scalars().all()

    result = list(rows)
    if q:
        q_lower = q.lower()
        result = [r for r in result if q_lower in r.text.lower() or q_lower in r.author.lower() or q_lower in r.source.lower()]
    if tag:
        result = [r for r in result if tag in (r.scene_tags or [])]
    if topic_id:
        result = [r for r in result if r.writing_plan_id == topic_id]
    return result


@router.post("", response_model=QuoteOut, status_code=201)
async def create_quote(body: QuoteCreate, db: AsyncSession = Depends(get_db)):
    obj = Quote(**body.model_dump())
    db.add(obj)
    await db.commit()
    await db.refresh(obj)
    return obj


@router.patch("/{quote_id}", response_model=QuoteOut)
async def update_quote(quote_id: int, body: QuoteUpdate, db: AsyncSession = Depends(get_db)):
    obj = await db.get(Quote, quote_id)
    if not obj:
        raise HTTPException(404, "Quote not found")
    for field, val in body.model_dump(exclude_none=True).items():
        setattr(obj, field, val)
    await db.commit()
    await db.refresh(obj)
    return obj


@router.delete("/{quote_id}", status_code=204)
async def delete_quote(quote_id: int, db: AsyncSession = Depends(get_db)):
    obj = await db.get(Quote, quote_id)
    if not obj:
        raise HTTPException(404, "Quote not found")
    await db.delete(obj)
    await db.commit()
