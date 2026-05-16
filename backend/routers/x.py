from fastapi import APIRouter, Query, BackgroundTasks, HTTPException
from pydantic import BaseModel
from typing import Optional
from datetime import datetime, timezone, timedelta
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession
from fastapi import Depends

from database import get_db, SessionLocal
from models import XBloggerCandidate, XPost, XPostMetrics

router = APIRouter(prefix="/x", tags=["x"])


class CandidateOut(BaseModel):
    username: str
    display_name: str
    avatar_url: str
    followers: int
    following_count: int
    tweet_count: int
    favourites_count: int
    location: str
    join_date: str
    hot_post_count: int = 0
    bio: str
    profile_url: str
    status: str
    added_at: datetime
    last_seen_at: datetime

    model_config = {"from_attributes": True}


class CandidateUpdate(BaseModel):
    status: Optional[str] = None   # candidate / following / rejected


class CandidateListOut(BaseModel):
    candidates: list[CandidateOut]
    total: int
    status_counts: dict[str, int] = {}


@router.get("/candidates", response_model=CandidateListOut)
async def list_candidates(
    status: Optional[str] = Query(None),
    limit: int = Query(50, le=200),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    from sqlalchemy import func

    # Status counts (always all statuses, unfiltered by query param)
    count_rows = (await db.execute(
        select(XBloggerCandidate.status, func.count(XBloggerCandidate.username))
        .group_by(XBloggerCandidate.status)
    )).all()
    status_counts: dict[str, int] = {r.status: r[1] for r in count_rows}  # type: ignore[index]

    # Base query for total count
    base_q = select(XBloggerCandidate)
    if status:
        base_q = base_q.where(XBloggerCandidate.status == status)
    total = (await db.execute(select(func.count()).select_from(base_q.subquery()))).scalar() or 0

    # Paginated query
    q = (
        select(XBloggerCandidate)
        .order_by(desc(XBloggerCandidate.followers))
        .limit(limit).offset(offset)
    )
    if status:
        q = q.where(XBloggerCandidate.status == status)
    rows = (await db.execute(q)).scalars().all()

    # Batch hot-post counts
    usernames = [r.username for r in rows]
    count_rows = (await db.execute(
        select(XPost.username, func.count(XPost.tweet_id).label("cnt"))
        .where(XPost.username.in_(usernames))
        .group_by(XPost.username)
    )).all()
    hot_counts = {r.username: r.cnt for r in count_rows}

    return CandidateListOut(
        candidates=[
            CandidateOut(
                **{c: getattr(r, c) for c in [
                    "username", "display_name", "avatar_url", "followers",
                    "following_count", "tweet_count", "favourites_count",
                    "location", "join_date", "bio", "profile_url", "status",
                    "added_at", "last_seen_at",
                ]},
                hot_post_count=hot_counts.get(r.username, 0),
            )
            for r in rows
        ],
        total=total,
        status_counts=status_counts,
    )


@router.patch("/candidates/{username}", response_model=CandidateOut)
async def update_candidate(
    username: str,
    body: CandidateUpdate,
    db: AsyncSession = Depends(get_db),
):
    row = await db.get(XBloggerCandidate, username)
    if not row:
        raise HTTPException(404, "Not found")
    if body.status:
        row.status = body.status
    await db.commit()
    await db.refresh(row)
    from sqlalchemy import func
    cnt = (await db.execute(
        select(func.count(XPost.tweet_id)).where(XPost.username == username)
    )).scalar() or 0
    return CandidateOut(
        **{c: getattr(row, c) for c in [
            "username", "display_name", "avatar_url", "followers",
            "following_count", "tweet_count", "favourites_count",
            "location", "join_date", "bio", "profile_url", "status",
            "added_at", "last_seen_at",
        ]},
        hot_post_count=cnt,
    )


@router.delete("/candidates/{username}")
async def delete_candidate(username: str, db: AsyncSession = Depends(get_db)):
    row = await db.get(XBloggerCandidate, username)
    if not row:
        raise HTTPException(404, "Not found")
    await db.delete(row)
    await db.commit()
    return {"ok": True}


@router.post("/open-login")
async def open_login():
    """Open x.com/login in camofox — user completes login via VNC."""
    from x_collector import open_login_session
    return await open_login_session()


@router.post("/open-timeline")
async def open_timeline():
    """Inject stored cookies and open x.com/home in camofox."""
    from x_collector import open_timeline_session
    return await open_timeline_session()


@router.post("/import-session")
async def import_session():
    """
    After VNC login, pull storage_state from camofox and save cookies to config.
    """
    from x_collector import import_session_from_camofox
    return await import_session_from_camofox()


@router.post("/collect-tl1-users")
async def trigger_collect_tl1_users(
    max_pages: int = Query(100, ge=1, le=100),
    background_tasks: BackgroundTasks = None,
):
    """Crawl tl1.com /api/users up to max_pages, save to blogger candidates."""
    async def _run():
        from x_collector import fetch_tl1_users
        from logger import log
        result = await fetch_tl1_users(max_pages=max_pages)
        if result.get("error"):
            await log("tl1-users", "error", "tl1 用户采集异常", result["error"])
        else:
            await log("tl1-users", "ok",
                      f"tl1 用户采集完成：抓取 {result['pages_fetched']} 页 / "
                      f"{result['total_fetched']} 人，新增候选 {result['total_upserted']} 个")
    background_tasks.add_task(_run)
    return {"ok": True, "message": f"tl1 用户采集已启动（最多 {max_pages} 页）"}


@router.post("/collect-tl1")
async def trigger_collect_tl1(
    hours: int = Query(1, ge=1, le=24),
    background_tasks: BackgroundTasks = None,
):
    """Fetch trending posts from tl1.com and save to DB."""
    async def _run():
        from x_collector import fetch_tl1_trending
        from logger import log
        async with SessionLocal() as db:
            result = await fetch_tl1_trending(db, hours=hours)
        if result.get("error"):
            await log("tl1", "error", "tl1.com 采集异常", result["error"])
        else:
            await log("tl1", "ok",
                      f"tl1 热门采集完成：{result['total']} 条，新增 {result['new_posts']} 篇，"
                      f"新候选 {result['new_candidates']} 个")
    background_tasks.add_task(_run)
    return {"ok": True, "message": f"tl1.com {hours}h 热门采集任务已启动"}


@router.post("/collect")
async def trigger_collect(background_tasks: BackgroundTasks):
    """Manually trigger X timeline collection."""
    async def _run():
        from x_collector import collect_x_timeline
        from logger import log
        async with SessionLocal() as db:
            result = await collect_x_timeline(db)
        if result["error"]:
            await log("x", "error", "X 采集异常", result["error"])
        else:
            await log("x", "ok",
                      f"检查 {result['checked']} 个账号，新增候选 {result['new_candidates']} 个，"
                      f"新帖 {result.get('new_posts', 0)} 条")
    background_tasks.add_task(_run)
    return {"ok": True, "message": "X 采集任务已启动"}


@router.post("/import-cookies")
async def import_cookies(body: dict):
    """Import X cookies into camofox session (pass raw cookie JSON array)."""
    import json
    from x_collector import import_x_cookies
    cookies_str = json.dumps(body.get("cookies", []))
    result = await import_x_cookies(cookies_str)
    return result


# ── Posts & metrics ────────────────────────────────────────────────────────────

class PostOut(BaseModel):
    tweet_id: str
    username: str
    content: str
    url: str
    published_at: datetime
    collected_at: datetime
    model_config = {"from_attributes": True}


class MetricsPoint(BaseModel):
    collected_at: datetime
    replies: int
    reposts: int = 0
    likes: int
    views: int
    model_config = {"from_attributes": True}


VIRAL_RATIO = 1.5  # views / author_followers threshold

class PostWithMetrics(BaseModel):
    tweet_id: str
    username: str
    display_name: str
    content: str
    url: str
    published_at: datetime
    collected_at: datetime
    author_followers: int
    source: str
    category: str
    latest_replies: int
    latest_reposts: int
    latest_likes: int
    latest_views: int
    is_viral: bool
    metrics_history: list[MetricsPoint]


@router.get("/posts", response_model=list[PostWithMetrics])
async def list_posts(
    hours: int = Query(24, le=168),
    username: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
):
    """Return recent posts with full metrics history."""
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    q = select(XPost).where(XPost.published_at >= since).order_by(desc(XPost.published_at))
    if username:
        q = q.where(XPost.username == username.lstrip("@").lower())
    posts = (await db.execute(q)).scalars().all()

    # Batch-fetch display names from candidates table
    usernames = list({p.username for p in posts})
    name_rows = (await db.execute(
        select(XBloggerCandidate.username, XBloggerCandidate.display_name)
        .where(XBloggerCandidate.username.in_(usernames))
    )).all()
    display_names = {r.username: r.display_name for r in name_rows}

    result = []
    for post in posts:
        metrics_rows = (await db.execute(
            select(XPostMetrics)
            .where(XPostMetrics.tweet_id == post.tweet_id)
            .order_by(XPostMetrics.collected_at)
        )).scalars().all()

        latest = metrics_rows[-1] if metrics_rows else None
        lv = latest.views if latest else 0
        af = post.author_followers
        result.append(PostWithMetrics(
            tweet_id=post.tweet_id,
            username=post.username,
            display_name=display_names.get(post.username, ""),
            content=post.content,
            url=post.url,
            published_at=post.published_at,
            collected_at=post.collected_at,
            author_followers=af,
            source=post.source or "twitterapi",
            category=post.category or "",
            latest_replies=latest.replies if latest else 0,
            latest_reposts=latest.reposts if latest else 0,
            latest_likes=latest.likes if latest else 0,
            latest_views=lv,
            is_viral=bool(af > 0 and lv > af * VIRAL_RATIO),
            metrics_history=[MetricsPoint.model_validate(m) for m in metrics_rows],
        ))
    return result


@router.post("/classify-posts")
async def trigger_classify_posts(
    batch_size: int = Query(20, ge=1, le=100),
    background_tasks: BackgroundTasks = None,
):
    """Classify unclassified posts using LLM."""
    async def _run():
        from post_classifier import classify_unclassified_posts
        from config import get_config
        from logger import log
        cfg = await get_config()
        if cfg.get("x_post_classify_enabled", "1") != "1":
            return
        prompt = cfg.get("x_post_classify_prompt", "")
        async with SessionLocal() as db:
            result = await classify_unclassified_posts(db, prompt_template=prompt, batch_size=batch_size)
        await log("x-classify", "ok", f"帖子分类完成：{result['classified']}/{result['total']} 条")
    background_tasks.add_task(_run)
    return {"ok": True, "message": f"帖子分类任务已启动（批次 {batch_size} 条）"}


class CreateArticleRequest(BaseModel):
    mode: str = "secondary"   # secondary | rewrite
    extra_prompt: str = ""


class CreateArticleOut(BaseModel):
    ok: bool
    title: str
    content: str


@router.post("/posts/{tweet_id}/create-article", response_model=CreateArticleOut)
async def create_article_from_post(
    tweet_id: str,
    body: CreateArticleRequest,
    db: AsyncSession = Depends(get_db),
):
    """Generate an article (二创 or 改写) from an X post using LLM."""
    post = await db.get(XPost, tweet_id)
    if not post:
        raise HTTPException(404, "Not found")

    metrics_rows = (await db.execute(
        select(XPostMetrics)
        .where(XPostMetrics.tweet_id == tweet_id)
        .order_by(desc(XPostMetrics.collected_at))
        .limit(1)
    )).scalars().all()
    latest = metrics_rows[0] if metrics_rows else None
    views   = latest.views   if latest else 0
    reposts = latest.reposts if latest else 0
    likes   = latest.likes   if latest else 0

    extra = f"\n\n补充要求：{body.extra_prompt.strip()}" if body.extra_prompt.strip() else ""

    if body.mode == "rewrite":
        prompt = f"""你是一位专业的中文内容创作者。请将以下 X（Twitter）推文改写为一篇完整的微信公众号风格文章，保留核心观点但大幅扩展细节、背景和论据，语言流畅自然，适合普通读者。

原始推文：
{post.content}

数据参考：浏览 {views:,} · 转发 {reposts:,} · 点赞 {likes:,}{extra}

要求：
- 用 Markdown 格式输出
- 第一行是文章标题（## 标题）
- 正文 500-800 字，分 2-4 个小节
- 结尾可加一句行动号召或总结"""
    else:
        prompt = f"""你是一位专业的中文内容创作者。以下是一条高传播 X（Twitter）推文，请以此为灵感进行二次创作，写一篇独立的原创文章。不要直接翻译或改写，而是提炼核心洞见，结合更广泛的背景和你的分析，生成新的内容。

原始推文（灵感来源）：
{post.content}

数据参考：浏览 {views:,} · 转发 {reposts:,} · 点赞 {likes:,}{extra}

要求：
- 用 Markdown 格式输出
- 第一行是文章标题（## 标题）
- 正文 600-1000 字，分 2-4 个小节，有自己的观点和延伸
- 语言符合微信公众号风格，可读性强"""

    try:
        from llm import _call
        raw = await _call(prompt)
        lines = [l for l in raw.strip().splitlines() if l.strip()]
        title = lines[0].lstrip("#").strip() if lines else "未命名"
        content = raw.strip()
        return CreateArticleOut(ok=True, title=title, content=content)
    except Exception as e:
        raise HTTPException(500, str(e))


class SaveDraftRequest(BaseModel):
    title: str
    content: str
    source_tweet_id: str = ""


@router.post("/save-draft")
async def save_x_draft(body: SaveDraftRequest, db: AsyncSession = Depends(get_db)):
    """Save an X-post-derived article to ArticleDraft (topic_id='x')."""
    from datetime import datetime, timezone
    from models import ArticleDraft
    now = datetime.now(timezone.utc)
    obj = ArticleDraft(
        topic_id="x",
        title=body.title[:200],
        content=body.content,
        status="drafting",
        created_at=now,
        updated_at=now,
    )
    db.add(obj)
    await db.commit()
    await db.refresh(obj)
    return {"ok": True, "draft_id": obj.id, "title": obj.title}


@router.post("/posts/{tweet_id}/inspire")
async def inspire_from_post(tweet_id: str, db: AsyncSession = Depends(get_db)):
    """Analyse a post with LLM and return content inspiration."""
    post = await db.get(XPost, tweet_id)
    if not post:
        raise HTTPException(404, "Not found")

    metrics_rows = (await db.execute(
        select(XPostMetrics)
        .where(XPostMetrics.tweet_id == tweet_id)
        .order_by(desc(XPostMetrics.collected_at))
        .limit(1)
    )).scalars().all()
    latest = metrics_rows[0] if metrics_rows else None

    views   = latest.views   if latest else 0
    reposts = latest.reposts if latest else 0
    likes   = latest.likes   if latest else 0
    followers = post.author_followers or 0
    ratio_str = f"{views / followers:.1f}x" if followers > 0 else "—"

    prompt = f"""你是一个内容创作策略分析师。以下是一条在 X（Twitter）上获得高传播的中文推文：

帖子内容：
{post.content}

数据指标：
- 浏览量：{views:,}
- 转发数：{reposts:,}
- 点赞数：{likes:,}
- 作者粉丝数：{followers:,}
- 超粉丝浏览倍数：{ratio_str}

请完成以下分析（用中文，结构清晰）：

## 内容亮点
这条帖子的核心吸引力是什么？哪些表达方式、信息密度或情绪点让它脱颖而出？

## 传播原因
从用户心理和社会动机角度分析，为什么它能获得高浏览和高转发？

## 灵感延伸
基于这条帖子的成功要素，给出 3 个具体的新内容选题或创作角度，每个包含：标题建议 + 一句核心切入点。
"""

    try:
        from llm import _call
        analysis = await _call(prompt)
        return {"ok": True, "analysis": analysis}
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/posts/{tweet_id}/metrics", response_model=list[MetricsPoint])
async def get_post_metrics(tweet_id: str, db: AsyncSession = Depends(get_db)):
    """Return full metrics history for a single post."""
    rows = (await db.execute(
        select(XPostMetrics)
        .where(XPostMetrics.tweet_id == tweet_id)
        .order_by(XPostMetrics.collected_at)
    )).scalars().all()
    return rows

