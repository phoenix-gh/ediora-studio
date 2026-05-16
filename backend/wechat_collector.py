"""WeChat article collector — manual add by URL.

Fetches a single WeChat article page and extracts metadata.
No account subscription or scheduled collection needed.
"""

import re
import html
import hashlib
import httpx
from datetime import datetime, timezone
from sqlalchemy.ext.asyncio import AsyncSession

from models import WechatArticle

_UA = (
    "Mozilla/5.0 (Linux; U; Android 2.3.6; zh-cn; GT-S5660 Build/GINGERBREAD) "
    "AppleWebKit/533.1 (KHTML, like Gecko) Version/4.0 Mobile Safari/533.1 "
    "MicroMessenger/4.5.255"
)

_HEADERS = {
    "User-Agent": _UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": "https://mp.weixin.qq.com/",
}


def _article_id(url: str) -> str:
    return hashlib.md5(url.encode()).hexdigest()


def _re_str(pattern: str, text: str, group: int = 1) -> str:
    m = re.search(pattern, text)
    return m.group(group).strip() if m else ""


async def fetch_article(url: str) -> dict:
    """Fetch a WeChat article URL and return its metadata."""
    async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
        resp = await client.get(url, headers=_HEADERS)
        resp.raise_for_status()
        page = resp.text
        final_url = str(resp.url)

    title = html.unescape(_re_str(r'<meta\s+property="og:title"\s+content="([^"]+)"', page))
    cover = html.unescape(_re_str(r'<meta\s+property="og:image"\s+content="([^"]+)"', page))
    digest = html.unescape(_re_str(r'<meta\s+property="og:description"\s+content="([^"]+)"', page))

    if not title:
        raise ValueError("无法解析文章标题，请确认这是一篇微信公众号文章链接")

    # Account name: var nickname = htmlDecode("xxx") or var nickname = "xxx"
    account_name = html.unescape(
        _re_str(r'var\s+nickname\s*=\s*(?:htmlDecode\()?["\']([^"\']+)["\']', page)
    )

    # biz
    biz = _re_str(r'biz\s*:\s*["\']([A-Za-z0-9+/=]+)["\']', page)
    if not biz:
        biz = _re_str(r'var\s+biz\s*=\s*["\']([A-Za-z0-9+/=]+)["\']', page)

    # Publish time: var ct = "1234567890"
    ts_str = _re_str(r'var\s+ct\s*=\s*["\']?(\d{10})["\']?', page)
    published_at = (
        datetime.fromtimestamp(int(ts_str), tz=timezone.utc)
        if ts_str else datetime.now(timezone.utc)
    )

    return {
        "id": _article_id(final_url),
        "biz": biz,
        "account_name": account_name,
        "title": title,
        "url": final_url,
        "cover_url": cover,
        "digest": digest,
        "published_at": published_at,
    }


async def save_article(url: str, db: AsyncSession) -> WechatArticle:
    """Fetch and persist a WeChat article. Returns the saved model."""
    data = await fetch_article(url)
    existing = await db.get(WechatArticle, data["id"])
    if existing:
        return existing
    article = WechatArticle(
        id=data["id"],
        biz=data["biz"],
        account_name=data["account_name"],
        title=data["title"][:500],
        url=data["url"],
        cover_url=data["cover_url"],
        digest=data["digest"][:1000],
        published_at=data["published_at"],
    )
    db.add(article)
    await db.commit()
    await db.refresh(article)
    return article
