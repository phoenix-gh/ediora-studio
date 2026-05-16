from fastapi import APIRouter, HTTPException, Query, Depends
from sqlalchemy import select, desc, delete
from sqlalchemy.ext.asyncio import AsyncSession
from datetime import datetime, timezone, timedelta
from pydantic import BaseModel
from typing import Optional

from database import get_db
from models import WechatArticle

router = APIRouter(prefix="/wechat", tags=["wechat"])


# ── Schemas ────────────────────────────────────────────────────────────────────

class ArticleCreate(BaseModel):
    url: str


class ArticleOut(BaseModel):
    id: str
    biz: str
    account_name: str
    title: str
    url: str
    cover_url: str
    digest: str
    published_at: datetime
    collected_at: datetime

    model_config = {"from_attributes": True}


# ── Articles ───────────────────────────────────────────────────────────────────

@router.get("/articles", response_model=list[ArticleOut])
async def list_articles(
    biz: Optional[str] = Query(None),
    account: Optional[str] = Query(None),
    days: int = Query(365, ge=1, le=3650),
    limit: int = Query(200, le=1000),
    search: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
):
    since = datetime.now(timezone.utc) - timedelta(days=days)
    q = (
        select(WechatArticle)
        .where(WechatArticle.published_at >= since)
        .order_by(desc(WechatArticle.published_at))
        .limit(limit)
    )
    if biz:
        q = q.where(WechatArticle.biz == biz)
    if account:
        q = q.where(WechatArticle.account_name == account)
    if search:
        q = q.where(WechatArticle.title.contains(search))
    rows = (await db.execute(q)).scalars().all()
    return rows


@router.post("/articles", response_model=ArticleOut, status_code=201)
async def add_article(body: ArticleCreate, db: AsyncSession = Depends(get_db)):
    from wechat_collector import save_article
    try:
        article = await save_article(body.url, db)
    except Exception as e:
        raise HTTPException(400, f"无法抓取文章：{e}")
    return article


@router.delete("/articles/{article_id}", status_code=204)
async def delete_article(article_id: str, db: AsyncSession = Depends(get_db)):
    article = await db.get(WechatArticle, article_id)
    if not article:
        raise HTTPException(404, "Article not found")
    await db.delete(article)
    await db.commit()
