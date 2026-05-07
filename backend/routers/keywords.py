from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel
from typing import Optional
from datetime import datetime
from database import get_db, SessionLocal
from models import Keyword

router = APIRouter(prefix="/keywords", tags=["keywords"])


class KeywordOut(BaseModel):
    id: int
    term: str
    category: str
    source: str
    is_active: bool
    blocked: bool
    heat: int
    mention_count_24h: int
    platforms: list
    trend: str
    last_computed_at: Optional[datetime]
    created_at: datetime

    model_config = {"from_attributes": True}


class KeywordCreate(BaseModel):
    term: str
    category: str = ""


class RefreshResult(BaseModel):
    extracted: int
    updated: int
    message: str


@router.get("", response_model=list[KeywordOut])
async def list_keywords(
    limit: int = Query(200, le=500),
    db: AsyncSession = Depends(get_db),
):
    rows = (await db.execute(
        select(Keyword)
        .where(Keyword.blocked == False, Keyword.is_active == True)
        .order_by(Keyword.heat.desc())
        .limit(limit)
    )).scalars().all()
    return rows


@router.post("", response_model=KeywordOut, status_code=201)
async def create_keyword(body: KeywordCreate, db: AsyncSession = Depends(get_db)):
    existing = (await db.execute(
        select(Keyword).where(Keyword.term == body.term)
    )).scalar_one_or_none()

    if existing:
        if existing.blocked:
            # Un-block if user explicitly re-adds it
            existing.blocked = False
            existing.is_active = True
            existing.source = "manual"
            existing.category = body.category or existing.category
            await db.commit()
            await db.refresh(existing)
            return existing
        raise HTTPException(status_code=409, detail="关键词已存在")

    kw = Keyword(term=body.term, category=body.category, source="manual")
    db.add(kw)
    await db.commit()
    await db.refresh(kw)
    return kw


@router.delete("/{keyword_id}", status_code=204)
async def block_keyword(keyword_id: int, db: AsyncSession = Depends(get_db)):
    """Mark keyword as blocked so it won't re-appear in auto-extraction."""
    kw = await db.get(Keyword, keyword_id)
    if not kw:
        raise HTTPException(status_code=404, detail="Not found")
    kw.blocked = True
    kw.is_active = False
    await db.commit()


@router.post("/refresh", response_model=RefreshResult)
async def refresh_keywords():
    """Run full pipeline: extract terms from recent posts, compute heat."""
    from keyword_tracker import compute_keyword_heat
    async with SessionLocal() as db:
        result = await compute_keyword_heat(db)
    return RefreshResult(
        extracted=result["extracted"],
        updated=result["updated"],
        message=f"新增 {result['extracted']} 个词，已更新 {result['updated']} 个关键词热度",
    )


@router.post("/extract", response_model=list[KeywordOut])
async def extract_keywords_llm():
    """
    Use LLM to suggest additional keywords from recent hot posts that jieba
    might miss (e.g. proper nouns, brand names, acronyms).
    Only verbatim terms from content are accepted.
    """
    import json
    from llm import _call
    from models import XPost, XPostMetrics
    from sqlalchemy import func
    from datetime import timedelta, timezone

    cutoff = datetime.now(timezone.utc) - timedelta(hours=24)

    async with SessionLocal() as db:
        sub = (
            select(XPostMetrics.tweet_id, func.max(XPostMetrics.views).label("v"))
            .group_by(XPostMetrics.tweet_id)
            .subquery()
        )
        x_rows = (await db.execute(
            select(XPost.content)
            .join(sub, XPost.tweet_id == sub.c.tweet_id)
            .where(XPost.published_at >= cutoff)
            .order_by(sub.c.v.desc())
            .limit(30)
        )).scalars().all()

        from models import Post
        gen_rows = (await db.execute(
            select(Post.content)
            .where(Post.published_at >= cutoff)
            .order_by(Post.likes.desc())
            .limit(20)
        )).scalars().all()

        all_content = list(x_rows) + list(gen_rows)
        if not all_content:
            return []

        snippets = "\n".join(f"- {c[:300]}" for c in all_content[:30])

        prompt = f"""以下是过去24小时的热门帖子内容：

{snippets}

任务：从上述内容中提取15-20个**可在微博、知乎、抖音等平台直接搜索的关键词**。

要求：
1. 必须是原文中出现的词，不要改写或总结
2. 优先选：品牌名、产品名、人名、技术术语、事件名称
3. 长度2-8字，可以直接粘贴进搜索框
4. 不要宽泛大类词（如"人工智能"、"科技"）
5. 不要句子或事件描述

以JSON数组返回，每项含 term（词）和 category（领域，如：大模型/航天/加密货币）。
只返回JSON，不要其他文字。"""

        try:
            resp = await _call(prompt, max_tokens=600)
            import re
            m = re.search(r'\[.*\]', resp, re.DOTALL)
            if not m:
                raise ValueError(f"no JSON array: {resp[:200]}")
            items = json.loads(m.group())
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"LLM 提炼失败: {e}")

        added = []
        for item in items:
            term = (item.get("term") or "").strip()
            cat  = (item.get("category") or "").strip()
            if not term or len(term) < 2:
                continue
            existing = (await db.execute(
                select(Keyword).where(Keyword.term == term)
            )).scalar_one_or_none()
            if existing:
                if not existing.blocked:
                    added.append(existing)
                continue
            kw = Keyword(term=term, category=cat, source="llm")
            db.add(kw)
            await db.flush()
            added.append(kw)

        await db.commit()
        for kw in added:
            await db.refresh(kw)
        return added


@router.get("/wordcloud")
async def get_wordcloud(
    top_n: int = Query(80, ge=10, le=200),
    db: AsyncSession = Depends(get_db),
):
    """Return word cloud weights directly from the keywords table."""
    from keyword_tracker import get_wordcloud_data
    return await get_wordcloud_data(db, top_n=top_n)
