from fastapi import APIRouter, Query, BackgroundTasks, Depends, HTTPException
from sqlalchemy import select, asc
from sqlalchemy.ext.asyncio import AsyncSession
from datetime import datetime
from pydantic import BaseModel
from typing import Optional

from database import get_db
from models import JuejinArticle
from juejin_collector import CATEGORIES, FEED_TYPES

router = APIRouter(prefix="/juejin", tags=["juejin"])


class JuejinArticleOut(BaseModel):
    id: str
    category: str
    title: str
    url: str
    cover_url: str
    brief: str
    content: str = ""
    author: str
    author_avatar: str
    tags: str
    view_count: int
    digg_count: int
    comment_count: int
    collect_count: int
    hot_rank: int
    published_at: datetime
    collected_at: datetime

    model_config = {"from_attributes": True}


class JuejinCategoryOut(BaseModel):
    key: str
    label: str


@router.get("/categories", response_model=list[JuejinCategoryOut])
async def list_categories():
    return [{"key": k, "label": v[1]} for k, v in CATEGORIES.items()]


@router.get("/articles", response_model=list[JuejinArticleOut])
async def list_articles(
    category: str = Query("hot"),
    limit: int = Query(100, le=500),
    search: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
):
    if category not in CATEGORIES:
        raise HTTPException(400, f"unknown category: {category}")

    # Juejin's category feed is curated/editorial, not chronological — articles can be months old
    # and still be top recommendations. Show exactly what the latest fetch returned, by rank.
    q = (
        select(JuejinArticle)
        .where(JuejinArticle.category == category, JuejinArticle.hot_rank > 0)
        .order_by(asc(JuejinArticle.hot_rank))
    )

    if search:
        q = q.where(JuejinArticle.title.contains(search))

    rows = (await db.execute(q.limit(limit))).scalars().all()
    return rows


@router.get("/articles/{article_id}", response_model=JuejinArticleOut)
async def get_article(article_id: str, db: AsyncSession = Depends(get_db)):
    """Get a single article. If content is missing, fetch the post page and cache it."""
    art = await db.get(JuejinArticle, article_id)
    if not art:
        raise HTTPException(404, "Article not found")
    if not art.content and art.url:
        from juejin_collector import fetch_article_body
        body = await fetch_article_body(art.url)
        if body:
            art.content = body
            await db.commit()
            await db.refresh(art)
    return art


@router.post("/collect")
async def collect(background_tasks: BackgroundTasks, category: Optional[str] = Query(None)):
    if category and category not in CATEGORIES:
        raise HTTPException(400, f"unknown category: {category}")

    async def _run(cat: Optional[str]):
        from database import SessionLocal
        from juejin_collector import collect_category, collect_all as collect_all_juejin
        from logger import log
        async with SessionLocal() as db:
            try:
                if cat:
                    n = await collect_category(cat, db)
                    label = CATEGORIES[cat][1]
                    await log("juejin", "ok", f"掘金 · {label}：新增 {n} 条")
                else:
                    result = await collect_all_juejin(db)
                    if result["errors"]:
                        await log("juejin", "warn",
                                  f"掘金采集：新增 {result['new_articles']} 条",
                                  "; ".join(result["errors"]))
                    else:
                        per = result["per_category"]
                        summary = "  ".join(f"{CATEGORIES[k][1]} +{per.get(k, 0)}" for k in FEED_TYPES)
                        await log("juejin", "ok", f"掘金采集：{summary}")
            except Exception as e:
                await log("juejin", "error", "掘金采集异常", str(e))

    background_tasks.add_task(_run, category)
    return {"ok": True, "message": "掘金采集任务已启动"}
