"""36Kr data collector.

Three feed types:
- hot       : POST gateway hot-list API (50 trending articles with stats)
- article   : RSS feed of latest articles
- newsflash : RSS feed of newsflash (快讯)
"""

import re
import html
import json
import asyncio
import hashlib
import httpx
import feedparser
from datetime import datetime, timezone
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from collection_proxy import collection_client_kwargs
from models import KrArticle, now_utc

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

_HOT_API = "https://gateway.36kr.com/api/mis/nav/home/nav/rank/hot"
_ARTICLE_RSS = "https://36kr.com/feed"
_NEWSFLASH_RSS = "https://36kr.com/feed-newsflash"

FEED_TYPES = ["hot", "article", "newsflash"]


def _md5(s: str) -> str:
    return hashlib.md5(s.encode()).hexdigest()


def _strip_html(s: str) -> str:
    return re.sub(r"<[^>]+>", "", s or "").strip()


def _parse_rss_dt(entry) -> datetime:
    for attr in ("published_parsed", "updated_parsed"):
        ts = getattr(entry, attr, None)
        if ts:
            return datetime(*ts[:6], tzinfo=timezone.utc)
    return datetime.now(timezone.utc)


# ── Article body extraction ────────────────────────────────────────────────────

_BODY_RE = re.compile(r'window\.initialState\s*=\s*(\{.+?\});?\s*</script>', re.DOTALL)


async def fetch_article_body(url: str, client: httpx.AsyncClient | None = None) -> str:
    """Fetch a 36Kr article page and return its full HTML body."""
    owns_client = client is None
    if owns_client:
        client = httpx.AsyncClient(**await collection_client_kwargs(
            timeout=15,
            follow_redirects=True,
        ))
    try:
        resp = await client.get(url, headers={"User-Agent": _UA})
        if resp.status_code != 200:
            return ""
        m = _BODY_RE.search(resp.text)
        if not m:
            return ""
        try:
            data = json.loads(m.group(1))
        except json.JSONDecodeError:
            return ""
        detail = (
            data.get("articleDetail", {})
                .get("articleDetailData", {})
                .get("data", {})
        )
        return (detail.get("widgetContent") or "").strip()
    except Exception:
        return ""
    finally:
        if owns_client:
            await client.aclose()


async def _enrich_with_bodies(items: list[dict], concurrency: int = 5) -> None:
    """Fill in `content` for items that point to 36Kr articles. Mutates in place."""
    article_items = [it for it in items if "/p/" in it.get("url", "")]
    if not article_items:
        return
    sem = asyncio.Semaphore(concurrency)
    async with httpx.AsyncClient(**await collection_client_kwargs(
        timeout=15,
        follow_redirects=True,
    )) as client:
        async def one(item):
            async with sem:
                item["content"] = await fetch_article_body(item["url"], client)
        await asyncio.gather(*(one(it) for it in article_items))


# ── Hot list (POST API) ────────────────────────────────────────────────────────

async def _fetch_hot() -> list[dict]:
    headers = {
        "User-Agent": _UA,
        "Content-Type": "application/json",
        "Origin": "https://www.36kr.com",
        "Referer": "https://www.36kr.com/",
    }
    body = {
        "partner_id": "wap",
        "param": {"siteId": 1, "platformId": 2, "hotlistName": "web_top_hot"},
        "timestamp": 0,
    }
    async with httpx.AsyncClient(**await collection_client_kwargs(timeout=20)) as client:
        resp = await client.post(_HOT_API, headers=headers, json=body)
        resp.raise_for_status()
        data = resp.json()
    if data.get("code") != 0:
        raise RuntimeError(f"36kr API error: {data.get('msg')}")

    items = []
    for rank, item in enumerate(data.get("data", {}).get("hotRankList", []), start=1):
        m = item.get("templateMaterial", {}) or {}
        item_id = str(item.get("itemId") or m.get("itemId") or "")
        if not item_id:
            continue
        ts = m.get("publishTime", 0) or 0
        # 36Kr uses millisecond timestamps
        if ts > 10**12:
            ts = ts / 1000
        published_at = datetime.fromtimestamp(ts, tz=timezone.utc) if ts else datetime.now(timezone.utc)
        items.append({
            "id": item_id,
            "title": m.get("widgetTitle", "") or "",
            "url": f"https://36kr.com/p/{item_id}",
            "image_url": m.get("widgetImage", "") or "",
            "summary": "",
            "content": "",
            "author": m.get("authorName", "") or "",
            "stat_text": m.get("statFormat", "") or "",
            "stat_read": int(m.get("statRead", 0) or 0),
            "stat_like": int(m.get("statPraise", 0) or 0),
            "stat_comment": int(m.get("statComment", 0) or 0),
            "rank": rank,
            "published_at": published_at,
        })
    return items


# ── RSS feeds ──────────────────────────────────────────────────────────────────

def _parse_rss_items(body: str, feed_type: str) -> list[dict]:
    feed = feedparser.parse(body)
    items = []
    for e in feed.entries:
        link = (e.get("link", "") or "").split("?")[0]
        if not link:
            continue
        # 36Kr's article feed mixes in newsflash items — keep feeds disjoint by URL path.
        is_newsflash_url = "/newsflashes/" in link
        if feed_type == "article" and is_newsflash_url:
            continue
        if feed_type == "newsflash" and not is_newsflash_url:
            continue
        title = (e.get("title", "") or "").strip()
        if not title:
            continue
        desc = e.get("summary", "") or e.get("description", "") or ""
        # Try to extract first image from description HTML
        img_m = re.search(r'<img[^>]+src="([^"]+)"', desc)
        image_url = img_m.group(1) if img_m else ""
        summary = _strip_html(desc)[:600]
        # For newsflash items the RSS description is the full body — keep it.
        content = "" if feed_type == "article" else desc
        items.append({
            "id": _md5(link),
            "title": title,
            "url": link,
            "image_url": image_url,
            "summary": summary,
            "content": content,
            "author": (e.get("author", "") or "").strip(),
            "stat_text": "",
            "stat_read": 0,
            "stat_like": 0,
            "stat_comment": 0,
            "rank": 0,
            "published_at": _parse_rss_dt(e),
        })
    return items


async def _fetch_rss(url: str, feed_type: str) -> list[dict]:
    async with httpx.AsyncClient(**await collection_client_kwargs(
        timeout=20,
        follow_redirects=True,
    )) as client:
        resp = await client.get(url, headers={"User-Agent": _UA})
        resp.raise_for_status()
    return _parse_rss_items(resp.text, feed_type)


# ── Persistence ────────────────────────────────────────────────────────────────

async def _upsert(items: list[dict], feed_type: str, db: AsyncSession) -> int:
    new_count = 0
    for it in items:
        existing = await db.get(KrArticle, it["id"])
        if existing:
            # Update mutable stats / rank
            existing.stat_text = it["stat_text"] or existing.stat_text
            existing.stat_read = max(existing.stat_read, it["stat_read"])
            existing.stat_like = max(existing.stat_like, it["stat_like"])
            existing.stat_comment = max(existing.stat_comment, it["stat_comment"])
            if feed_type == "hot":
                existing.rank = it["rank"]
            # Backfill missing content if we now have it
            if not existing.content and it.get("content"):
                existing.content = it["content"]
            continue
        db.add(KrArticle(
            id=it["id"],
            feed_type=feed_type,
            title=it["title"][:500],
            url=it["url"],
            image_url=it["image_url"],
            summary=it["summary"][:1000],
            content=it.get("content", ""),
            author=it["author"][:100],
            stat_text=it["stat_text"],
            stat_read=it["stat_read"],
            stat_like=it["stat_like"],
            stat_comment=it["stat_comment"],
            rank=it["rank"],
            published_at=it["published_at"],
        ))
        new_count += 1
    await db.commit()
    return new_count


async def collect_hot(db: AsyncSession) -> int:
    # Clear ranks of all current hot items first; only the items returned by API will keep a non-zero rank.
    await db.execute(update(KrArticle).where(KrArticle.feed_type == "hot").values(rank=0))
    items = await _fetch_hot()
    await _enrich_with_bodies(items)
    return await _upsert(items, "hot", db)


async def collect_article(db: AsyncSession) -> int:
    items = await _fetch_rss(_ARTICLE_RSS, "article")
    await _enrich_with_bodies(items)
    return await _upsert(items, "article", db)


async def collect_newsflash(db: AsyncSession) -> int:
    items = await _fetch_rss(_NEWSFLASH_RSS, "newsflash")
    return await _upsert(items, "newsflash", db)


async def collect_all(db: AsyncSession) -> dict:
    results = {}
    errors: list[str] = []
    for fn, key in [(collect_hot, "hot"), (collect_article, "article"), (collect_newsflash, "newsflash")]:
        try:
            results[key] = await fn(db)
        except Exception as e:
            results[key] = 0
            errors.append(f"{key}: {e}")
    return {"new_articles": sum(results.values()), "per_feed": results, "errors": errors}
