from fastapi import APIRouter, Query, BackgroundTasks, Depends, HTTPException
from sqlalchemy import select, desc, asc
from sqlalchemy.ext.asyncio import AsyncSession
from datetime import datetime, timezone, timedelta
from pydantic import BaseModel
from typing import Optional, Literal

from database import get_db
from models import KrArticle

router = APIRouter(prefix="/kr", tags=["36kr"])

FeedType = Literal["hot", "article", "newsflash"]


class KrArticleOut(BaseModel):
    id: str
    feed_type: str
    title: str
    url: str
    image_url: str
    summary: str
    content: str = ""
    author: str
    stat_text: str
    stat_read: int
    stat_like: int
    stat_comment: int
    rank: int
    published_at: datetime
    collected_at: datetime

    model_config = {"from_attributes": True}


@router.get("/articles", response_model=list[KrArticleOut])
async def list_articles(
    feed_type: FeedType = Query("hot"),
    days: int = Query(7, ge=1, le=365),
    limit: int = Query(100, le=500),
    search: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
):
    since = datetime.now(timezone.utc) - timedelta(days=days)
    q = select(KrArticle).where(KrArticle.feed_type == feed_type)

    if feed_type == "hot":
        # Hot list: prioritise current ranked items, ordered by rank ascending; rank=0 fall to bottom by date
        q = q.where(KrArticle.rank > 0)
        q = q.order_by(asc(KrArticle.rank)).limit(limit)
    else:
        q = q.where(KrArticle.published_at >= since)
        q = q.order_by(desc(KrArticle.published_at)).limit(limit)

    if search:
        q = q.where(KrArticle.title.contains(search))

    rows = (await db.execute(q)).scalars().all()
    return rows


@router.get("/articles/{article_id}", response_model=KrArticleOut)
async def get_article(article_id: str, db: AsyncSession = Depends(get_db)):
    """Get a single article. If content is missing, fetch and cache it."""
    art = await db.get(KrArticle, article_id)
    if not art:
        raise HTTPException(404, "Article not found")
    if not art.content and "/p/" in art.url:
        from kr_collector import fetch_article_body
        body = await fetch_article_body(art.url)
        if body:
            art.content = body
            await db.commit()
            await db.refresh(art)
    return art


@router.post("/collect")
async def collect_all(background_tasks: BackgroundTasks, feed_type: Optional[FeedType] = Query(None)):
    async def _run(ft: Optional[str]):
        from database import SessionLocal
        from kr_collector import collect_hot, collect_article, collect_newsflash, collect_all as collect_all_kr
        from logger import log
        async with SessionLocal() as db:
            try:
                if ft == "hot":
                    n = await collect_hot(db)
                    await log("36kr", "ok", f"36 氪热榜：新增 {n} 条")
                elif ft == "article":
                    n = await collect_article(db)
                    await log("36kr", "ok", f"36 氪最新：新增 {n} 条")
                elif ft == "newsflash":
                    n = await collect_newsflash(db)
                    await log("36kr", "ok", f"36 氪快讯：新增 {n} 条")
                else:
                    result = await collect_all_kr(db)
                    if result["errors"]:
                        await log("36kr", "warn",
                                  f"36 氪采集：新增 {result['new_articles']} 条",
                                  "; ".join(result["errors"]))
                    else:
                        per = result["per_feed"]
                        await log("36kr", "ok",
                                  f"36 氪采集：热榜 +{per.get('hot', 0)}  "
                                  f"最新 +{per.get('article', 0)}  快讯 +{per.get('newsflash', 0)}")
            except Exception as e:
                await log("36kr", "error", "36 氪采集异常", str(e))

    background_tasks.add_task(_run, feed_type)
    return {"ok": True, "message": "36 氪采集任务已启动"}
