"""V2EX subscription collector.

Subscription kinds:
- node : https://www.v2ex.com/feed/{key}.xml
- user : https://www.v2ex.com/feed/member/{key}.xml
- tab  : https://www.v2ex.com/feed/tab/{key}.xml
- all  : https://www.v2ex.com/index.xml      (key ignored)
"""

import re
import httpx
import feedparser
from datetime import datetime, timezone
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from collection_proxy import collection_client_kwargs
from models import V2exSubscription, V2exTopic, now_utc

_BASE = "https://www.v2ex.com"
_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/atom+xml, application/xml;q=0.9, */*;q=0.5",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}

# Preset tab/node lists for UI dropdowns
PRESET_TABS = [
    ("tech", "技术"), ("creative", "创意"), ("play", "好玩"),
    ("apple", "Apple"), ("jobs", "酷工作"), ("deals", "交易"),
    ("city", "城市"), ("qna", "问与答"), ("hot", "最热"),
    ("all", "全部"), ("r2", "R2"),
]

POPULAR_NODES = [
    ("programmer", "程序员"), ("share", "分享发现"), ("idea", "奇思妙想"),
    ("python", "Python"), ("javascript", "JavaScript"), ("nodejs", "Node.js"),
    ("linux", "Linux"), ("macos", "macOS"), ("iphone", "iPhone"),
    ("android", "Android"), ("qna", "问与答"), ("jobs", "酷工作"),
    ("create", "分享创造"), ("blockchain", "区块链"), ("openai", "OpenAI"),
    ("ai", "AI"),
]


def build_feed_url(kind: str, key: str) -> str:
    key = (key or "").strip()
    if kind == "all":
        return f"{_BASE}/index.xml"
    if kind == "node":
        return f"{_BASE}/feed/{key}.xml"
    if kind == "user":
        return f"{_BASE}/feed/member/{key}.xml"
    if kind == "tab":
        return f"{_BASE}/feed/tab/{key}.xml"
    raise ValueError(f"unknown subscription kind: {kind}")


def _topic_id_from_url(url: str) -> int | None:
    """V2EX URLs look like /t/1213167#reply3 ; extract the numeric id."""
    m = re.search(r"/t/(\d+)", url)
    return int(m.group(1)) if m else None


def _replies_from_url(url: str) -> int:
    m = re.search(r"#reply(\d+)", url)
    return int(m.group(1)) if m else 0


def _parse_dt(entry) -> datetime:
    for attr in ("published_parsed", "updated_parsed"):
        ts = getattr(entry, attr, None)
        if ts:
            return datetime(*ts[:6], tzinfo=timezone.utc)
    return datetime.now(timezone.utc)


async def fetch_feed(kind: str, key: str) -> dict:
    """Fetch and parse a V2EX feed. Returns {title, entries: list[dict]}."""
    url = build_feed_url(kind, key)
    async with httpx.AsyncClient(**await collection_client_kwargs(
        timeout=20,
        follow_redirects=True,
    )) as client:
        resp = await client.get(url, headers=_HEADERS)
        resp.raise_for_status()
        body = resp.text

    feed = feedparser.parse(body)
    if feed.bozo and not feed.entries:
        raise RuntimeError(f"invalid feed: {feed.bozo_exception}")

    entries = []
    for e in feed.entries:
        link = e.get("link", "")
        tid = _topic_id_from_url(link)
        if not tid:
            continue
        author = ""
        author_url = ""
        if hasattr(e, "author_detail"):
            author = e.author_detail.get("name", "") or ""
            author_url = e.author_detail.get("href", "") or ""
        elif hasattr(e, "author"):
            author = e.author
        content = ""
        if hasattr(e, "content") and e.content:
            content = e.content[0].get("value", "")
        elif hasattr(e, "summary"):
            content = e.summary
        entries.append({
            "topic_id": tid,
            "title": (e.get("title", "") or "").strip(),
            "content": content,
            "url": f"{_BASE}/t/{tid}",   # canonical URL without #reply suffix
            "author": author,
            "author_url": author_url,
            "replies": _replies_from_url(link),
            "published_at": _parse_dt(e),
        })

    title = (feed.feed.get("title", "") or "").strip()
    return {"title": title, "entries": entries}


async def collect_subscription(sub: V2exSubscription, db: AsyncSession) -> int:
    """Fetch the sub's feed and upsert new topics. Returns count of newly inserted."""
    feed = await fetch_feed(sub.kind, sub.key)
    new_count = 0
    for entry in feed["entries"]:
        tid = entry["topic_id"]
        composite_id = f"{sub.id}:{tid}"
        existing = await db.get(V2exTopic, composite_id)
        if existing:
            # Update reply count for stale topics
            if entry["replies"] > existing.replies:
                existing.replies = entry["replies"]
            continue
        db.add(V2exTopic(
            id=composite_id,
            subscription_id=sub.id,
            topic_id=tid,
            title=entry["title"][:500],
            content=entry["content"][:10000],
            url=entry["url"],
            author=entry["author"][:100],
            author_url=entry["author_url"][:300],
            replies=entry["replies"],
            published_at=entry["published_at"],
        ))
        new_count += 1
    sub.last_collected_at = now_utc()
    await db.commit()
    return new_count


async def collect_all(db: AsyncSession) -> dict:
    subs = (await db.execute(
        select(V2exSubscription).where(V2exSubscription.muted == False)  # noqa: E712
    )).scalars().all()
    total_new = 0
    errors: list[str] = []
    for s in subs:
        try:
            n = await collect_subscription(s, db)
            total_new += n
        except Exception as e:
            errors.append(f"{s.label}: {e}")
    return {"new_topics": total_new, "errors": errors}
