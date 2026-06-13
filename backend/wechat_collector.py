"""WeChat article collector — fetch single article pages.

Used for two paths:
  - User pastes a URL → POST /wechat/articles (save metadata + body)
  - Scheduled mp.weixin.qq.com sync stores stub records → lazy GET /wechat/articles/{id}
    triggers fetch_article_body() on demand.
"""

import re
import html
import hashlib
from datetime import datetime, timezone
from urllib.parse import quote

import httpx
from bs4 import BeautifulSoup
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

# image src attributes seen on mp.weixin.qq.com — Tencent lazy-loads images via
# `data-src` and only fills `src` after JS execution, so we have to look at both.
_IMG_SRC_ATTRS = ("data-src", "src")
_PROXY_PATH = "/api/wechat/img?url="


def _article_id(url: str) -> str:
    return hashlib.md5(url.encode()).hexdigest()


def _re_str(pattern: str, text: str, group: int = 1) -> str:
    m = re.search(pattern, text)
    return m.group(group).strip() if m else ""


# JS string escapes seen in the embedded data blob (\x0a newlines, ️ etc.)
_JS_ESCAPE = re.compile(r"\\(?:x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|u\{[0-9A-Fa-f]+\}|.)", re.S)
_JS_SIMPLE = {
    "n": "\n", "r": "\r", "t": "\t", "b": "\b", "f": "\f", "v": "\v", "0": "\0",
    "'": "'", '"': '"', "\\": "\\", "/": "/", "`": "`", "\n": "", "\r": "",
}


def _js_unescape(s: str) -> str:
    """Decode the escape sequences of a JavaScript string literal."""
    def repl(m: "re.Match[str]") -> str:
        tok = m.group(0)
        c = tok[1]
        if c == "x":
            return chr(int(tok[2:], 16))
        if c == "u":
            return chr(int(tok[3:-1] if tok[2] == "{" else tok[2:], 16))
        return _JS_SIMPLE.get(c, c)
    return _JS_ESCAPE.sub(repl, s)


def _js_string(key: str, text: str) -> str:
    """Return the decoded value of a single-quoted JS field `key: '...'`."""
    m = re.search(key + r"\s*:\s*'((?:[^'\\]|\\.)*)'", text)
    return _js_unescape(m.group(1)) if m else ""


def _extract_picture_message(page: str) -> str:
    """Body HTML for the newer 图片消息 / 文案 layout.

    These posts render client-side: #js_content is absent and the DOM container
    (#js_article) is empty. The body lives in a JS data blob as `content_noencode`,
    with \\x0a hex escapes for newlines. The value is already HTML (WeChat embeds
    topic links as <a> anchors), so — like the legacy #js_content path — we keep it
    as markup and only wrap each line in <p> to restore the paragraph breaks that
    the bare newlines would otherwise collapse.

    (Album posts also carry body images in a `picture_info` region; we only have a
    text sample to verify against, so image harvesting is intentionally left out
    until we can confirm that structure.)
    """
    content = _js_string("content_noencode", page)
    if not content:
        return ""
    paras = [line.strip() for line in content.split("\n") if line.strip()]
    return _rewrite_mmbiz_images("".join(f"<p>{p}</p>" for p in paras))


def _extract_body(page: str) -> str:
    """Extract and rewrite the article body, across legacy and new layouts."""
    soup = BeautifulSoup(page, "html.parser")
    node = soup.find(id="js_content") or soup.select_one("div.rich_media_content")
    if node:
        return _rewrite_mmbiz_images(node.decode_contents().strip())
    return _extract_picture_message(page)


def _rewrite_mmbiz_images(html_text: str) -> str:
    """Rewrite <img> tags inside an article body so that every mmbiz image
    flows through the local cache proxy, and lazy-loaded data-src becomes src.
    """
    if not html_text:
        return html_text
    soup = BeautifulSoup(html_text, "html.parser")
    for img in soup.find_all("img"):
        src = ""
        for attr in _IMG_SRC_ATTRS:
            v = img.get(attr)
            if v and isinstance(v, str) and v.strip():
                src = v.strip()
                break
        if not src:
            continue
        if src.startswith("//"):
            src = "https:" + src
        # only proxy mmbiz / weixin images — leave third-party CDNs alone
        if "qpic.cn" in src or "weixin" in src:
            img["src"] = _PROXY_PATH + quote(src, safe="")
        else:
            img["src"] = src
        # clean up lazy-load remnants so the browser doesn't try the original URL
        for attr in ("data-src", "data-w", "data-ratio", "data-type"):
            if attr in img.attrs:
                del img.attrs[attr]
        img["referrerpolicy"] = "no-referrer"
    return str(soup)


async def fetch_article_body(url: str, client: httpx.AsyncClient | None = None) -> str:
    """Fetch the article page and return the rewritten HTML of #js_content."""
    own = client is None
    if own:
        client = httpx.AsyncClient(timeout=20, follow_redirects=True)
    try:
        resp = await client.get(url, headers=_HEADERS)
        resp.raise_for_status()
        page = resp.text
    finally:
        if own:
            await client.aclose()
    return _extract_body(page)


def parse_article(page: str, final_url: str) -> dict:
    """Parse a WeChat article page into metadata + body.

    Handles both the legacy text layout (var nickname / var biz / var ct) and the
    newer 图片消息 / 文案 layout, which drops those globals and instead exposes the
    same facts as nick_name / __biz= / create_time inside the embedded data blob.
    """
    title = html.unescape(_re_str(r'<meta\s+property="og:title"\s+content="([^"]+)"', page))
    if not title:
        raise ValueError("无法解析文章标题，请确认这是一篇微信公众号文章链接")

    cover = html.unescape(_re_str(r'<meta\s+property="og:image"\s+content="([^"]+)"', page))
    digest = html.unescape(_re_str(r'<meta\s+property="og:description"\s+content="([^"]+)"', page))

    account_name = html.unescape(
        _re_str(r'var\s+nickname\s*=\s*(?:htmlDecode\()?["\']([^"\']+)["\']', page)
        or _re_str(r'nick_name\s*:\s*["\']([^"\']+)["\']', page)
        or _re_str(r'<meta\s+property="og:article:author"\s+content="([^"]+)"', page)
    )

    biz = (
        _re_str(r'biz\s*:\s*["\']([A-Za-z0-9+/=]+)["\']', page)
        or _re_str(r'var\s+biz\s*=\s*["\']([A-Za-z0-9+/=]+)["\']', page)
        or _re_str(r'__biz=([A-Za-z0-9+/=]+)', page)
    )

    ts_str = (
        _re_str(r'var\s+ct\s*=\s*["\']?(\d{10})["\']?', page)
        or _re_str(r'create_time\s*:\s*["\']?(\d{10})\b', page)
    )
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
        "content": _extract_body(page),
        "published_at": published_at,
    }


async def fetch_article(url: str) -> dict:
    """Fetch a WeChat article URL and return its metadata + body."""
    async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
        resp = await client.get(url, headers=_HEADERS)
        resp.raise_for_status()
        page = resp.text
        final_url = str(resp.url)
    return parse_article(page, final_url)


async def save_article(url: str, db: AsyncSession) -> WechatArticle:
    """Fetch and persist a WeChat article. Returns the saved model."""
    data = await fetch_article(url)
    existing = await db.get(WechatArticle, data["id"])
    if existing:
        # If we already have the row but no body, backfill it.
        if not existing.content and data["content"]:
            existing.content = data["content"]
            await db.commit()
            await db.refresh(existing)
        return existing
    article = WechatArticle(
        id=data["id"],
        biz=data["biz"],
        account_name=data["account_name"],
        title=data["title"][:500],
        url=data["url"],
        cover_url=data["cover_url"],
        digest=data["digest"][:1000],
        content=data["content"],
        published_at=data["published_at"],
    )
    db.add(article)
    await db.commit()
    await db.refresh(article)
    return article
