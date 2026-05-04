"""Local avatar cache — fetch-once, serve-from-disk."""

import asyncio
import mimetypes
from pathlib import Path

import httpx

AVATAR_DIR = Path(__file__).parent / "avatars"
AVATAR_DIR.mkdir(exist_ok=True)

_TIMEOUT = 15
_RETRY_DELAYS = [2, 5]


def cached_path(username: str) -> Path | None:
    for ext in (".jpg", ".png", ".webp", ".jpeg"):
        p = AVATAR_DIR / f"{username}{ext}"
        if p.exists() and p.stat().st_size > 0:
            return p
    return None


async def fetch_and_cache(username: str, source_url: str) -> Path | None:
    """Download avatar from source_url with retry on 429, save to disk."""
    async with httpx.AsyncClient(follow_redirects=True, timeout=_TIMEOUT) as client:
        delays = iter(_RETRY_DELAYS)
        while True:
            try:
                r = await client.get(source_url)
                if r.status_code == 200 and len(r.content) > 500:
                    ct = r.headers.get("content-type", "image/jpeg")
                    ext = mimetypes.guess_extension(ct.split(";")[0].strip()) or ".jpg"
                    if ext in (".jpe", ".jpeg"):
                        ext = ".jpg"
                    dest = AVATAR_DIR / f"{username}{ext}"
                    dest.write_bytes(r.content)
                    return dest
                if r.status_code == 429:
                    wait = next(delays, None)
                    if wait is None:
                        break
                    await asyncio.sleep(wait)
                    continue
            except Exception:
                pass
            break
    return None


async def fetch_via_browser(username: str) -> Path | None:
    """Use the camofox browser to open the X profile page and extract the real avatar URL."""
    try:
        from config import get_config
        cfg = await get_config()
    except Exception:
        return None

    base = (cfg.get("camofox_url") or "http://localhost:9377").rstrip("/")
    key = cfg.get("camofox_api_key") or ""
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    user_id = f"avatar_{username}"

    async with httpx.AsyncClient(timeout=30) as client:
        tab_id = None
        try:
            # Open profile page in a new tab
            r = await client.post(
                f"{base}/tabs",
                json={"userId": user_id, "sessionKey": cfg.get("camofox_user_id") or "wemedia_x",
                      "url": f"https://x.com/{username}"},
                headers=headers,
            )
            r.raise_for_status()
            data = r.json()
            tab_id = data.get("tabId") or data.get("id")

            # Wait for avatar image to appear (up to 15s)
            img_src = ""
            for _ in range(10):
                await asyncio.sleep(1.5)
                result = await client.post(
                    f"{base}/tabs/{tab_id}/evaluate",
                    json={
                        "userId": user_id,
                        "expression": (
                            f"document.querySelector('[data-testid=\"UserAvatar-Container-{username}\"] img,"
                            f" [data-testid^=\"UserAvatar-Container\"] img')?.src || ''"
                        ),
                    },
                )
                if result.status_code == 200:
                    src = str(result.json().get("result") or "")
                    if src.startswith("http"):
                        img_src = src
                        break

            if not img_src:
                return None

            # Use a higher-res version if available (replace _normal with _400x400)
            img_url = img_src.replace("_normal.", "_400x400.")

            return await fetch_and_cache(username, img_url) or await fetch_and_cache(username, img_src)

        except Exception:
            return None
        finally:
            if tab_id:
                try:
                    await client.delete(f"{base}/tabs/{tab_id}", headers=headers)
                except Exception:
                    pass
