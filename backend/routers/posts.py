from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from database import get_db
from models import Post
from schemas import PostOut

router = APIRouter(prefix="/posts", tags=["posts"])

@router.get("", response_model=list[PostOut])
async def list_posts(
    account_id: str | None = Query(None),
    hot_only: bool = Query(False),
    limit: int = Query(50, le=200),
    db: AsyncSession = Depends(get_db),
):
    q = select(Post).order_by(Post.published_at.desc())
    if account_id:
        q = q.where(Post.account_id == account_id)
    if hot_only:
        q = q.where(Post.is_abnormally_popular == True)
    q = q.limit(limit)
    rows = (await db.execute(q)).scalars().all()
    return [PostOut.from_orm_with_metrics(r) for r in rows]
