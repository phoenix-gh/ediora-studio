"""
Post-collection analysis pipeline:
  collect_all → analyze_topics + analyze_hotspots + analyze_economic
"""
import hashlib
import random
from datetime import datetime, timezone, timedelta
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_, desc

from models import Post, Account, Topic, Hotspot, EconomicItem
from topic_clustering import cluster_items, upsert_topic_cluster
import llm


def _make_id(text: str) -> str:
    return hashlib.md5(text.encode()).hexdigest()[:16]


def _fake_trend(base: int, points: int = 24) -> list[int]:
    return [max(0, int(base * 0.6 + random.gauss(0, base * 0.2))) for _ in range(points)]


async def _recent_posts(db: AsyncSession, hours: int = 48, limit: int = 60) -> list[tuple]:
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    rows = (
        await db.execute(
            select(Post, Account)
            .join(Account, Post.account_id == Account.id)
            .where(Post.collected_at >= cutoff)
            .order_by((Post.likes + Post.reposts * 2 + Post.comments).desc())
            .limit(limit)
        )
    ).all()
    return rows


async def analyze_topics(db: AsyncSession) -> int:
    """Generate topic suggestions from recent posts via LLM."""
    rows = await _recent_posts(db, hours=48, limit=50)
    if not rows:
        return 0

    posts_info = [
        {
            "account": acc.name,
            "platform": acc.platform,
            "title": post.title,
            "content": f"{post.title}\n\n{post.content}".strip() if post.title else post.content,
            "url": post.url,
            "likes": post.likes,
            "reposts": post.reposts,
            "comments": post.comments,
            "published_at": post.published_at.isoformat(),
        }
        for post, acc in rows
    ]

    count = 0
    today = datetime.now(timezone.utc).date().isoformat()
    clusters = cluster_items(posts_info)[:12]

    for cluster in clusters:
        cluster_obj = await upsert_topic_cluster(db, cluster)
        existing_topic = (await db.execute(
            select(Topic)
            .where(Topic.cluster_id == cluster_obj.id, Topic.status.in_(["pending", "accepted", "snoozed"]))
            .order_by(desc(Topic.created_at))
            .limit(1)
        )).scalar_one_or_none()
        if existing_topic:
            continue

        suggestions = await llm.generate_topics_from_posts(cluster["items"])
        for s in suggestions[:1]:
            title = s.get("title", "").strip()
            if not title:
                continue
            topic_id = _make_id(title + today)
            if await db.get(Topic, topic_id):
                continue

            source_urls = set(s.get("source_urls") or [])
            sources = list(cluster_obj.sources or [])
            for url in source_urls:
                if url and not any(source.get("url") == url for source in sources):
                    sources.append({
                        "id": _make_id(url),
                        "platform": "来源",
                        "title": title,
                        "url": url,
                        "publishedAt": datetime.now(timezone.utc).isoformat(),
                        "type": "primary",
                    })

            db.add(
                Topic(
                    id=topic_id,
                    title=title,
                    summary=s.get("summary", ""),
                    score=float(s.get("score", 3.0)),
                    urgency=s.get("urgency", "this_week"),
                    tags=s.get("tags", []),
                    category=s.get("category", "人工智能"),
                    sources=sources,
                    competitor_count=int(s.get("competitor_count", 0)),
                    recommend_reason=s.get("recommend_reason", ""),
                    trend_data=_fake_trend(random.randint(40, 80)),
                    cluster_id=cluster_obj.id,
                    cluster_title=cluster_obj.canonical_title,
                    cluster_source_count=cluster_obj.source_count,
                )
            )
            count += 1

    await db.commit()
    return count


async def analyze_hotspots(db: AsyncSession) -> int:
    """Detect trending hotspots from recent posts via LLM."""
    rows = await _recent_posts(db, hours=24, limit=60)
    if not rows:
        return 0

    posts_info = [
        {
            "platform": acc.platform,
            "content": f"{post.title}\n\n{post.content}".strip() if post.title else post.content,
            "likes": post.likes,
            "reposts": post.reposts,
            "comments": post.comments,
        }
        for post, acc in rows
    ]

    hotspots = await llm.generate_hotspots_from_posts(posts_info)
    count = 0
    today = datetime.now(timezone.utc).date().isoformat()

    for h in hotspots:
        title = h.get("title", "").strip()
        if not title:
            continue
        hid = _make_id(title + today)
        heat = max(0, min(100, int(h.get("heat", 50))))
        existing = await db.get(Hotspot, hid)
        if existing:
            existing.heat = heat
            existing.trend = h.get("trend", "rising")
            existing.updated_at = datetime.now(timezone.utc)
        else:
            db.add(
                Hotspot(
                    id=hid,
                    title=title,
                    trend=h.get("trend", "rising"),
                    platforms=h.get("platforms", []),
                    heat=heat,
                    trend_data=_fake_trend(heat),
                    category=h.get("category", "人工智能"),
                )
            )
            count += 1

    await db.commit()
    return count


async def analyze_economic(db: AsyncSession) -> int:
    """Summarize economic news from financial-tagged accounts."""
    cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
    today = datetime.now(timezone.utc).date().isoformat()

    # Prefer accounts in economic groups; fall back to all accounts
    eco_groups = ["财经", "经济", "金融", "宏观", "财联社", "证券"]
    rows = (
        await db.execute(
            select(Post, Account)
            .join(Account, Post.account_id == Account.id)
            .where(
                and_(
                    Post.collected_at >= cutoff,
                    Account.group.in_(eco_groups),
                )
            )
            .order_by(Post.published_at.desc())
            .limit(40)
        )
    ).all()

    if not rows:
        rows = (
            await db.execute(
                select(Post, Account)
                .join(Account, Post.account_id == Account.id)
                .where(Post.collected_at >= cutoff)
                .order_by(Post.published_at.desc())
                .limit(40)
            )
        ).all()

    if not rows:
        return 0

    posts_info = [
        {
            "account": acc.name,
            "content": f"{post.title}\n\n{post.content}".strip() if post.title else post.content,
        }
        for post, acc in rows
    ]

    items = await llm.generate_economic_items(posts_info)
    count = 0

    for item in items:
        title = item.get("title", "").strip()
        if not title:
            continue
        item_id = _make_id(title + today)
        if await db.get(EconomicItem, item_id):
            continue

        db.add(
            EconomicItem(
                id=item_id,
                title=title,
                summary=item.get("summary", ""),
                category=item.get("category", "宏观经济"),
                impact=item.get("impact", "neutral"),
                impact_level=item.get("impact_level", "medium"),
                published_at=datetime.now(timezone.utc),
            )
        )
        count += 1

    await db.commit()
    return count


async def run_full_analysis(db: AsyncSession) -> dict:
    """Run all three analysis pipelines and return counts."""
    t = await analyze_topics(db)
    h = await analyze_hotspots(db)
    e = await analyze_economic(db)
    return {"new_topics": t, "new_hotspots": h, "new_economic": e}
