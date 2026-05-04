from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc
import hashlib

from database import get_db
from models import ContentDirection, TopicStrategy, Topic, XPost, XPostMetrics
from topic_clustering import cluster_items, upsert_topic_cluster
from schemas import (
    DirectionCreate, DirectionUpdate, DirectionOut,
    StrategyCreate, StrategyUpdate, StrategyOut,
    TopicOut,
)

router = APIRouter(prefix="/directions", tags=["directions"])


def _source_id(url: str) -> str:
    return hashlib.md5(url.encode()).hexdigest()[:16]


# ── Directions ────────────────────────────────────────────────────────────────

@router.get("", response_model=list[DirectionOut])
async def list_directions(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(
        select(ContentDirection).order_by(ContentDirection.created_at)
    )).scalars().all()
    return rows


@router.post("", response_model=DirectionOut, status_code=201)
async def create_direction(body: DirectionCreate, db: AsyncSession = Depends(get_db)):
    obj = ContentDirection(
        name=body.name,
        description=body.description,
        created_at=datetime.now(timezone.utc),
    )
    db.add(obj)
    await db.commit()
    await db.refresh(obj)
    return obj


@router.patch("/{direction_id}", response_model=DirectionOut)
async def update_direction(direction_id: int, body: DirectionUpdate, db: AsyncSession = Depends(get_db)):
    obj = await db.get(ContentDirection, direction_id)
    if not obj:
        raise HTTPException(404, "Direction not found")
    for field, val in body.model_dump(exclude_none=True).items():
        setattr(obj, field, val)
    await db.commit()
    await db.refresh(obj)
    return obj


@router.delete("/{direction_id}", status_code=204)
async def delete_direction(direction_id: int, db: AsyncSession = Depends(get_db)):
    obj = await db.get(ContentDirection, direction_id)
    if not obj:
        raise HTTPException(404, "Direction not found")
    # also remove child strategies
    strategies = (await db.execute(
        select(TopicStrategy).where(TopicStrategy.direction_id == direction_id)
    )).scalars().all()
    for s in strategies:
        await db.delete(s)
    await db.delete(obj)
    await db.commit()


# ── Strategies ────────────────────────────────────────────────────────────────

@router.get("/{direction_id}/strategies", response_model=list[StrategyOut])
async def list_strategies(direction_id: int, db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(
        select(TopicStrategy)
        .where(TopicStrategy.direction_id == direction_id)
        .order_by(TopicStrategy.created_at)
    )).scalars().all()
    return rows


@router.post("/{direction_id}/strategies", response_model=StrategyOut, status_code=201)
async def create_strategy(direction_id: int, body: StrategyCreate, db: AsyncSession = Depends(get_db)):
    direction = await db.get(ContentDirection, direction_id)
    if not direction:
        raise HTTPException(404, "Direction not found")
    obj = TopicStrategy(
        direction_id=direction_id,
        created_at=datetime.now(timezone.utc),
        **body.model_dump(),
    )
    db.add(obj)
    await db.commit()
    await db.refresh(obj)
    return obj


@router.patch("/{direction_id}/strategies/{strategy_id}", response_model=StrategyOut)
async def update_strategy(
    direction_id: int, strategy_id: int, body: StrategyUpdate, db: AsyncSession = Depends(get_db)
):
    obj = await db.get(TopicStrategy, strategy_id)
    if not obj or obj.direction_id != direction_id:
        raise HTTPException(404, "Strategy not found")
    for field, val in body.model_dump(exclude_none=True).items():
        setattr(obj, field, val)
    await db.commit()
    await db.refresh(obj)
    return obj


@router.delete("/{direction_id}/strategies/{strategy_id}", status_code=204)
async def delete_strategy(direction_id: int, strategy_id: int, db: AsyncSession = Depends(get_db)):
    obj = await db.get(TopicStrategy, strategy_id)
    if not obj or obj.direction_id != direction_id:
        raise HTTPException(404, "Strategy not found")
    await db.delete(obj)
    await db.commit()


# ── Generate topics from X posts ──────────────────────────────────────────────

@router.post("/{direction_id}/strategies/{strategy_id}/generate", response_model=list[TopicOut])
async def generate_topics(direction_id: int, strategy_id: int, db: AsyncSession = Depends(get_db)):
    direction = await db.get(ContentDirection, direction_id)
    if not direction:
        raise HTTPException(404, "Direction not found")
    strategy = await db.get(TopicStrategy, strategy_id)
    if not strategy or strategy.direction_id != direction_id:
        raise HTTPException(404, "Strategy not found")

    from llm import generate_topics_from_x_posts
    import uuid
    from datetime import timedelta

    # Fetch X posts according to strategy filters
    since = datetime.now(timezone.utc) - timedelta(hours=strategy.filter_hours)

    q = (
        select(XPost)
        .where(XPost.published_at >= since)
        .order_by(desc(XPost.published_at))
        .limit(200)
    )
    posts_orm = (await db.execute(q)).scalars().all()

    # Fetch latest metrics for each post
    post_dicts = []
    for p in posts_orm:
        metrics = (await db.execute(
            select(XPostMetrics)
            .where(XPostMetrics.tweet_id == p.tweet_id)
            .order_by(desc(XPostMetrics.collected_at))
            .limit(1)
        )).scalar_one_or_none()

        views = metrics.views if metrics else 0
        reposts = metrics.reposts if metrics else 0
        likes = metrics.likes if metrics else 0
        replies = metrics.replies if metrics else 0

        if views < strategy.filter_min_views:
            continue
        if strategy.filter_viral_only and not (p.author_followers > 0 and views > p.author_followers * 1.5):
            continue

        content = p.content.lower()
        if strategy.filter_keywords:
            if not any(kw.lower() in content for kw in strategy.filter_keywords):
                continue
        if strategy.filter_exclude_keywords:
            if any(kw.lower() in content for kw in strategy.filter_exclude_keywords):
                continue

        post_dicts.append({
            "title": p.content[:60],
            "username": p.username,
            "display_name": "",
            "content": p.content,
            "url": p.url,
            "views": views,
            "reposts": reposts,
            "likes": likes,
            "comments": replies,
            "published_at": p.published_at.isoformat(),
            "platform": "X",
            "author_followers": p.author_followers,
        })

    # Sort by engagement score and cap at 40
    post_dicts.sort(key=lambda x: x["views"] + x["reposts"] * 5 + x["likes"] * 2, reverse=True)
    post_dicts = post_dicts[:40]

    if not post_dicts:
        raise HTTPException(422, "No posts match the strategy filters in the given time window")

    strategy_dict = {
        "output_count": strategy.output_count,
        "llm_prompt": strategy.llm_prompt,
    }

    try:
        raw_topics = await generate_topics_from_x_posts(post_dicts, strategy_dict, direction.name)
    except Exception as e:
        raise HTTPException(502, f"LLM 调用失败：{e}")

    if not raw_topics:
        raise HTTPException(502, "LLM 未返回有效选题，请检查 Settings 中的 API Key 配置")

    # Persist to topics table
    now = datetime.now(timezone.utc)
    saved = []
    clusters = cluster_items(post_dicts)
    source_to_cluster = {}
    for cluster in clusters:
        cluster_obj = await upsert_topic_cluster(db, cluster)
        for source in cluster.get("sources", []):
            source_to_cluster[source.get("url")] = cluster_obj

    for t in raw_topics:
        title = t.get("title", "未命名选题")
        source_urls = t.get("source_urls", [])
        cluster_obj = next((source_to_cluster.get(url) for url in source_urls if source_to_cluster.get(url)), None)
        if cluster_obj is not None:
            existing_topic = (await db.execute(
                select(Topic)
                .where(Topic.cluster_id == cluster_obj.id, Topic.status.in_(["pending", "accepted", "snoozed"]))
                .limit(1)
            )).scalar_one_or_none()
            if existing_topic:
                continue

        topic = Topic(
            id=str(uuid.uuid4()),
            title=title,
            summary=t.get("summary", ""),
            score=float(t.get("score", 3.0)),
            urgency=t.get("urgency", "this_week"),
            tags=t.get("tags", []),
            category=t.get("category", "人工智能"),
            sources=[
                {
                    "id": _source_id(u),
                    "platform": "X",
                    "title": title,
                    "url": u,
                    "publishedAt": now.isoformat(),
                    "type": "primary",
                }
                for u in source_urls
            ],
            competitor_count=int(t.get("competitor_count", 0)),
            recommend_reason=t.get("recommend_reason", ""),
            direction_id=direction.id,
            direction_name=direction.name,
            strategy_id=strategy.id,
            strategy_name=strategy.name,
            cluster_id=cluster_obj.id if cluster_obj else "",
            cluster_title=cluster_obj.canonical_title if cluster_obj else "",
            cluster_source_count=cluster_obj.source_count if cluster_obj else len(source_urls),
            created_at=now,
        )
        db.add(topic)
        saved.append(topic)
    await db.commit()
    for s in saved:
        await db.refresh(s)

    return saved
