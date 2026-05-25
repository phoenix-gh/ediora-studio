"""WeChat image (mmbiz.qpic.cn) cache — fetch-once with proper UA/Referer,
serve from disk. Bypasses Tencent's hotlink protection that returns the
"未经允许不可引用" placeholder when browsers load mmbiz images cross-origin.
"""

import hashlib
import mimetypes
from pathlib import Path

import httpx

IMG_DIR = Path(__file__).parent / "wechat_imgs"
IMG_DIR.mkdir(exist_ok=True)

# Mobile WeChat UA — same family that mmbiz.qpic.cn happily serves to.
_UA = (
    "Mozilla/5.0 (Linux; U; Android 2.3.6; zh-cn; GT-S5660 Build/GINGERBREAD) "
    "AppleWebKit/533.1 (KHTML, like Gecko) Version/4.0 Mobile Safari/533.1 "
    "MicroMessenger/4.5.255"
)
_HEADERS = {
    "User-Agent": _UA,
    "Referer": "https://mp.weixin.qq.com/",
    "Accept": "image/avif,image/webp,image/*,*/*;q=0.8",
}

_TIMEOUT = 20


def _key(url: str) -> str:
    return hashlib.md5(url.encode("utf-8")).hexdigest()


def cached_path(url: str) -> Path | None:
    key = _key(url)
    for ext in (".jpg", ".png", ".webp", ".gif", ".jpeg"):
        p = IMG_DIR / f"{key}{ext}"
        if p.exists() and p.stat().st_size > 0:
            return p
    return None


async def fetch_and_cache(url: str) -> Path | None:
    """Download a mmbiz / weixin image with WeChat UA + Referer. Returns the
    on-disk path, or None on failure. Re-fetching the same URL is a no-op."""
    hit = cached_path(url)
    if hit:
        return hit
    key = _key(url)
    async with httpx.AsyncClient(follow_redirects=True, timeout=_TIMEOUT) as client:
        try:
            r = await client.get(url, headers=_HEADERS)
        except Exception:
            return None
    if r.status_code != 200 or len(r.content) < 200:
        return None
    ct = r.headers.get("content-type", "image/jpeg")
    ext = mimetypes.guess_extension(ct.split(";")[0].strip()) or ".jpg"
    if ext in (".jpe", ".jpeg"):
        ext = ".jpg"
    dest = IMG_DIR / f"{key}{ext}"
    dest.write_bytes(r.content)
    return dest
