import feedparser
import hashlib
import html as htmllib
import re
from datetime import datetime, timezone

FEED_URL = "https://www.producthunt.com/feed"

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
}


def _post_id(url: str) -> str:
    return hashlib.md5(url.encode()).hexdigest()[:16]


def _extract_tagline(html_str: str) -> str:
    """Pull the first <p> text — that's the tagline in PH's Atom feed."""
    m = re.search(r'<p[^>]*>(.*?)</p>', html_str, re.DOTALL)
    if not m:
        return ""
    return re.sub(r'<[^>]+>', '', m.group(1)).strip()


def _extract_images(html_str: str) -> list[str]:
    """
    Extract up to 5 unique product images from a PH product page.
    Strategy:
      1. OG image  (h=512&w=1024 variant — the hero shot)
      2. Gallery screenshots  (w=391&h=220&…&dpr=1 variants)
    Deduplicate by base URL (strip query string).
    """
    text = htmllib.unescape(html_str)

    seen_bases: set[str] = set()
    result: list[str] = []

    def _add(url: str) -> None:
        base = url.split("?")[0]
        if base not in seen_bases and not base.endswith(".svg"):
            seen_bases.add(base)
            result.append(url)

    # 1. OG image
    for pat in (
        r'property=["\']og:image["\']\s+content=["\']([^"\']+ph-files\.imgix\.net[^"\']+)["\']',
        r'content=["\']([^"\']+ph-files\.imgix\.net[^"\']+)["\']\s+property=["\']og:image["\']',
    ):
        m = re.search(pat, text)
        if m:
            _add(m.group(1))
            break

    # 2. Gallery images — dpr=1 variants at standard thumbnail size
    for url in re.findall(r'https://ph-files\.imgix\.net/[a-z0-9\-]+\.[a-z]+\?[^\s"\'<>]+', text):
        if "dpr=1" in url and ("w=391" in url or "h=220" in url):
            _add(url)
        if len(result) >= 5:
            break

    # fallback: take the first OG-size image if nothing found
    if not result:
        m = re.search(r'https://ph-files\.imgix\.net/[a-z0-9\-]+\.[a-z]+', text)
        if m:
            _add(m.group(0))

    return result[:5]


async def _fetch_product_images(client, url: str) -> list[str]:
    try:
        r = await client.get(url, timeout=12)
        if r.status_code == 200:
            return _extract_images(r.text)
    except Exception:
        pass
    return []


async def collect_producthunt(db) -> int:
    import httpx
    from models import ProductHuntPost

    async with httpx.AsyncClient(timeout=30, follow_redirects=True, headers=_HEADERS) as client:
        resp = await client.get(FEED_URL)
        resp.raise_for_status()

        feed = feedparser.parse(resp.text)
        new_count = 0

        for entry in feed.entries:
            url = entry.get("link", "").strip()
            if not url:
                continue

            pid = _post_id(url)
            if await db.get(ProductHuntPost, pid):
                continue

            title = entry.get("title", "").strip()
            tagline = _extract_tagline(entry.get("summary", ""))

            images = await _fetch_product_images(client, url)
            thumbnail_url = images[0] if images else ""

            if entry.get("published_parsed"):
                published_at = datetime(*entry.published_parsed[:6], tzinfo=timezone.utc)
            else:
                published_at = datetime.now(timezone.utc)

            db.add(ProductHuntPost(
                id=pid,
                title=title,
                tagline=tagline,
                url=url,
                thumbnail_url=thumbnail_url,
                images=images,
                description="",
                topics=[],
                votes=0,
                published_at=published_at,
            ))
            new_count += 1

    if new_count:
        await db.commit()
    return new_count
