"""Reddit subreddit collector.

Each subscription collects both 'hot' and 'new' listings concurrently.
Posts are upserted by composite key '{subscription_id}:{post_id}'.
Uses feedgrab.fetchers.reddit — no OAuth required (Tier 0: old.reddit.com .json).
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models import RedditSubscription, RedditPost, now_utc


def _parse_created_at(ts_iso: str) -> datetime:
    """Parse feedgrab's ISO 8601 timestamp string into UTC datetime."""
    if not ts_iso:
        return datetime.now(timezone.utc)
    try:
        return datetime.fromisoformat(ts_iso.replace("Z", "+00:00"))
    except ValueError:
        return datetime.now(timezone.utc)


async def _fetch_sort(subreddit: str, sort: str, limit: int) -> list[dict[str, Any]]:
    """Fetch one sort listing; returns [] on any error."""
    from feedgrab.fetchers.reddit import fetch_reddit_subreddit
    try:
        return await fetch_reddit_subreddit(subreddit, sort=sort, limit=limit)
    except Exception:
        return []


async def collect_subscription(sub: RedditSubscription, db: AsyncSession) -> int:
    """Fetch hot + new for one subscription, upsert posts. Returns count of newly inserted."""
    hot, new_ = await asyncio.gather(
        _fetch_sort(sub.subreddit, "hot", 25),
        _fetch_sort(sub.subreddit, "new", 25),
    )

    # Deduplicate by post_id within this batch (post can appear in both hot and new)
    seen: dict[str, dict[str, Any]] = {}
    for item in hot + new_:
        pid = item.get("id", "")
        if pid and pid not in seen:
            seen[pid] = item

    new_count = 0
    for pid, item in seen.items():
        composite_id = f"{sub.id}:{pid}"
        existing = await db.get(RedditPost, composite_id)
        if existing:
            # Update mutable fields
            existing.score = item.get("score", existing.score)
            existing.comment_count = item.get("comment_count", existing.comment_count)
            existing.upvote_ratio = item.get("upvote_ratio", existing.upvote_ratio)
        else:
            db.add(RedditPost(
                id=composite_id,
                post_id=pid,
                subscription_id=sub.id,
                title=(item.get("title") or "")[:500],
                content=item.get("content") or "",
                url=item.get("url") or "",
                linked_url=item.get("linked_url") or "",
                author=item.get("author") or "",
                subreddit=item.get("subreddit") or sub.subreddit,
                flair=item.get("flair") or "",
                score=item.get("score", 0),
                upvote_ratio=float(item.get("upvote_ratio", 0.0)),
                comment_count=item.get("comment_count", 0),
                is_self=bool(item.get("is_self", True)),
                published_at=_parse_created_at(item.get("created_at") or ""),
            ))
            new_count += 1

    sub.last_collected_at = now_utc()
    await db.commit()
    return new_count


async def collect_all(db: AsyncSession) -> dict:
    """Collect all non-muted subscriptions. Returns {new_posts, errors}."""
    subs = (await db.execute(
        select(RedditSubscription).where(RedditSubscription.muted == False)  # noqa: E712
    )).scalars().all()
    total_new = 0
    errors: list[str] = []
    for sub in subs:
        try:
            n = await collect_subscription(sub, db)
            total_new += n
        except Exception as e:
            errors.append(f"r/{sub.subreddit}: {e}")
    return {"new_posts": total_new, "errors": errors}
