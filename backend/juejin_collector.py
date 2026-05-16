"""Juejin (掘金 / 稀土掘金) collector.

Endpoints used (anonymous, no auth):
- POST /recommend_api/v1/article/recommend_all_feed   — homepage feed (sort 200=综合, 300=最热)
- POST /recommend_api/v1/article/recommend_cate_feed  — per-category feed

Category mapping (cate_id ↔ label) is hardcoded — these IDs have been stable for years.
The "hot" category is the homepage综合热榜 (no cate_id).
"""

import httpx
from bs4 import BeautifulSoup
from datetime import datetime, timezone
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from models import JuejinArticle, now_utc

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
_HEADERS = {
    "User-Agent": _UA,
    "Content-Type": "application/json",
    "Origin": "https://juejin.cn",
    "Referer": "https://juejin.cn/",
}

_ALL_FEED = "https://api.juejin.cn/recommend_api/v1/article/recommend_all_feed"
_CATE_FEED = "https://api.juejin.cn/recommend_api/v1/article/recommend_cate_feed"

# Category key → (cate_id, display label)
CATEGORIES: dict[str, tuple[str, str]] = {
    "hot":      ("",                    "综合热榜"),
    "backend":  ("6809637769959178254", "后端"),
    "frontend": ("6809637767543259144", "前端"),
    "android":  ("6809635626879549454", "Android"),
    "ios":      ("6809635626661445640", "iOS"),
    "ai":       ("6809637773935378440", "人工智能"),
    "tool":     ("6809637771511070734", "开发工具"),
    "life":     ("6809637776263217160", "代码人生"),
    "read":     ("6809637772874219534", "阅读"),
}

FEED_TYPES = list(CATEGORIES.keys())

# Juejin returns 200 items per cursor page; we cap at one page for hot list.
_PAGE_LIMIT = 50


def _parse_ctime(ts) -> datetime:
    try:
        return datetime.fromtimestamp(int(ts), tz=timezone.utc)
    except (TypeError, ValueError):
        return datetime.now(timezone.utc)


def _extract_item(node: dict) -> dict | None:
    """Normalize one item from either feed endpoint.

    recommend_all_feed wraps each item as {"item_type":2,"item_info":{...}}
    recommend_cate_feed returns flat objects with article_info/author_user_info at top level.
    """
    if "item_info" in node:
        info = node["item_info"]
    else:
        info = node
    ai = info.get("article_info") or {}
    au = info.get("author_user_info") or {}
    aid = ai.get("article_id") or info.get("article_id")
    if not aid:
        return None
    tags = info.get("tags") or []  # only present on all_feed
    tag_names = [t.get("tag_name", "") for t in tags if t.get("tag_name")]
    return {
        "id": str(aid),
        "title": (ai.get("title") or "").strip(),
        "url": f"https://juejin.cn/post/{aid}",
        "cover_url": ai.get("cover_image") or "",
        "brief": (ai.get("brief_content") or "").strip(),
        "author": (au.get("user_name") or "").strip(),
        "author_avatar": au.get("avatar_large") or "",
        "tags": ",".join(tag_names),
        "view_count": int(ai.get("view_count") or 0),
        "digg_count": int(ai.get("digg_count") or 0),
        "comment_count": int(ai.get("comment_count") or 0),
        "collect_count": int(ai.get("collect_count") or 0),
        "published_at": _parse_ctime(ai.get("ctime")),
    }


async def fetch_article_body(url: str, client: httpx.AsyncClient | None = None) -> str:
    """Fetch a Juejin post page and return the inner HTML of div.markdown-body."""
    owns = client is None
    if owns:
        client = httpx.AsyncClient(timeout=15, follow_redirects=True)
    try:
        resp = await client.get(url, headers={"User-Agent": _UA})
        if resp.status_code != 200:
            return ""
        soup = BeautifulSoup(resp.text, "html.parser")
        node = soup.select_one("div.markdown-body")
        return node.decode_contents().strip() if node else ""
    except Exception:
        return ""
    finally:
        if owns:
            await client.aclose()


async def _fetch(url: str, body: dict) -> list[dict]:
    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.post(url, headers=_HEADERS, json=body)
        resp.raise_for_status()
        data = resp.json()
    if data.get("err_no") != 0:
        raise RuntimeError(f"juejin API error: {data.get('err_msg')}")
    items = []
    for node in data.get("data") or []:
        norm = _extract_item(node)
        if norm:
            items.append(norm)
    return items


async def _fetch_hot() -> list[dict]:
    # sort_type=200 → 综合/推荐 (Juejin homepage default — curated, high-engagement).
    # sort_type=300 returns raw chronological output with no engagement filtering.
    # client_type 2608 is the web client id used by juejin.cn.
    return await _fetch(_ALL_FEED, {
        "id_type": 2,
        "client_type": 2608,
        "sort_type": 200,
        "cursor": "0",
        "limit": _PAGE_LIMIT,
    })


async def _fetch_category(cate_id: str) -> list[dict]:
    return await _fetch(_CATE_FEED, {
        "id_type": 2,
        "sort_type": 200,
        "cate_id": cate_id,
        "cursor": "0",
        "limit": _PAGE_LIMIT,
    })


async def _upsert(items: list[dict], category: str, db: AsyncSession) -> int:
    new_count = 0
    for rank, it in enumerate(items, start=1):
        existing = await db.get(JuejinArticle, it["id"])
        if existing:
            # Refresh mutable stats (counts only go up; take max in case API undercounts transiently)
            existing.view_count = max(existing.view_count, it["view_count"])
            existing.digg_count = max(existing.digg_count, it["digg_count"])
            existing.comment_count = max(existing.comment_count, it["comment_count"])
            existing.collect_count = max(existing.collect_count, it["collect_count"])
            if it["tags"] and not existing.tags:
                existing.tags = it["tags"]
            # Stamp current rank only when this fetch is for the same category;
            # cross-category collisions keep their original category and rank=0.
            if existing.category == category:
                existing.hot_rank = rank
            continue
        db.add(JuejinArticle(
            id=it["id"],
            category=category,
            title=it["title"][:500],
            url=it["url"],
            cover_url=it["cover_url"],
            brief=it["brief"][:1000],
            content="",
            author=it["author"][:100],
            author_avatar=it["author_avatar"],
            tags=it["tags"][:300],
            view_count=it["view_count"],
            digg_count=it["digg_count"],
            comment_count=it["comment_count"],
            collect_count=it["collect_count"],
            hot_rank=rank,
            published_at=it["published_at"],
        ))
        new_count += 1
    await db.commit()
    return new_count


async def collect_category(key: str, db: AsyncSession) -> int:
    if key not in CATEGORIES:
        raise ValueError(f"unknown juejin category: {key}")
    # Reset stale ranks for this category — items absent from this fetch fall to rank=0
    await db.execute(
        update(JuejinArticle).where(JuejinArticle.category == key).values(hot_rank=0)
    )
    cate_id, _label = CATEGORIES[key]
    items = await (_fetch_hot() if key == "hot" else _fetch_category(cate_id))
    return await _upsert(items, key, db)


async def collect_all(db: AsyncSession) -> dict:
    results: dict[str, int] = {}
    errors: list[str] = []
    for key in FEED_TYPES:
        try:
            results[key] = await collect_category(key, db)
        except Exception as e:
            results[key] = 0
            errors.append(f"{key}: {e}")
    return {"new_articles": sum(results.values()), "per_category": results, "errors": errors}
