"""
X (Twitter) collector via twitterapi.io REST API.

Collection flow:
  1. Fetch recent tweets from accounts with status="following"
  2. Fetch tweets matching configured x_search_queries
  3. Auto-discover high-follower candidates from tweet authors
  4. Save posts + metrics snapshots

camofox functions (open_login_session, open_timeline_session, etc.) are
kept unchanged so VNC browsing still works from the settings page.
"""
import re
import json
import httpx
from datetime import datetime, timezone, timedelta
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.dialects.sqlite import insert as _sqlite_insert
from sqlalchemy import select as _select

from models import XBloggerCandidate, XPost, XPostMetrics
from sqlalchemy import update as _update

TWITTERAPI_BASE = "https://api.twitterapi.io"


# ── Config helper ─────────────────────────────────────────────────────────────

async def _cfg():
    from config import get_config
    return await get_config()


# ── twitterapi.io client ──────────────────────────────────────────────────────

async def _api_get(path: str, params: dict, api_key: str) -> dict:
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.get(
            f"{TWITTERAPI_BASE}{path}",
            params=params,
            headers={"X-API-Key": api_key},
        )
        r.raise_for_status()
        return r.json()


# ── Response parsers ──────────────────────────────────────────────────────────

def _parse_tweet(raw: dict) -> dict | None:
    """
    Normalise a twitterapi.io tweet object to our internal format.

    Actual API shape:
      {
        "id": "...", "text": "...",
        "createdAt": "Wed May 06 10:00:00 +0000 2026",
        "retweetCount": 0, "replyCount": 0, "likeCount": 0,
        "quoteCount": 0, "viewCount": 0,
        "author": {
          "userName": "...", "name": "...",
          "followers": 1234, "profilePicture": "...", "description": "..."
        }
      }
    """
    t = raw.get("tweet") or raw
    if not isinstance(t, dict):
        return None

    tid = str(t.get("id") or "").strip()
    if not tid:
        return None

    author = t.get("author") or {}
    username = (author.get("userName") or author.get("screen_name") or "").lower().strip()
    if not username:
        return None

    created_str = t.get("createdAt") or t.get("created_at") or ""
    try:
        pub_at = datetime.strptime(created_str, "%a %b %d %H:%M:%S %z %Y")
    except Exception:
        try:
            pub_at = datetime.fromisoformat(created_str.replace("Z", "+00:00"))
        except Exception:
            pub_at = datetime.now(timezone.utc)

    return {
        "tweet_id": tid,
        "username": username,
        "display_name": (author.get("name") or username).strip()[:100],
        "avatar_url": (author.get("profilePicture") or author.get("profile_image_url")
                       or f"https://unavatar.io/x/{username}"),
        "followers": int(author.get("followers") or 0),
        "bio": (author.get("description") or "")[:400],
        "content": (t.get("text") or "").strip(),
        "published_at": pub_at,
        "replies": int(t.get("replyCount") or 0),
        "reposts": int(t.get("retweetCount") or 0),
        "likes": int(t.get("likeCount") or 0),
        "views": int(t.get("viewCount") or 0),
        "url": t.get("url") or f"https://x.com/{username}/status/{tid}",
    }


def _extract_tweets_from_response(data: dict) -> list[dict]:
    """Pull the tweet list out of whatever shape twitterapi.io returns."""
    # Shape 1: {"tweets": [...]}
    if "tweets" in data and isinstance(data["tweets"], list):
        return data["tweets"]
    # Shape 2: {"data": {"tweets": [...]}}
    nested = data.get("data") or {}
    if isinstance(nested, dict):
        if "tweets" in nested:
            return nested["tweets"] if isinstance(nested["tweets"], list) else []
        # Shape 3: {"data": {"timeline": {"tweets": [...]}}}
        timeline = nested.get("timeline") or {}
        if isinstance(timeline, dict) and "tweets" in timeline:
            return timeline["tweets"]
    return []


async def _fetch_user_tweets(username: str, api_key: str, count: int = 20) -> list[dict]:
    """Fetch recent tweets for a given username. Returns list of raw tweet dicts."""
    try:
        data = await _api_get(
            "/twitter/user/tweets",
            {"userName": username, "count": count},
            api_key,
        )
        return _extract_tweets_from_response(data)
    except httpx.HTTPStatusError as e:
        print(f"[x] user tweets HTTP error for @{username}: {e.response.status_code}")
        return []
    except Exception as e:
        print(f"[x] user tweets error for @{username}: {e}")
        return []


async def _search_tweets(query: str, api_key: str, count: int = 20) -> list[dict]:
    """Search tweets using twitterapi.io advanced_search (GET)."""
    try:
        data = await _api_get(
            "/twitter/tweet/advanced_search",
            {"query": query, "queryType": "Latest", "count": count},
            api_key,
        )
        return _extract_tweets_from_response(data)
    except httpx.HTTPStatusError as e:
        print(f"[x] search HTTP error for query={query!r}: {e.response.status_code}")
        return []
    except Exception as e:
        print(f"[x] search error for query={query!r}: {e}")
        return []


async def _get_user_info(username: str, api_key: str) -> dict | None:
    """Fetch profile info for a username. Returns normalised dict or None.

    Response: {"status": "success", "data": {"userName": ..., "description": ..., ...}}
    Retries once on 429 after a short back-off.
    """
    for attempt in range(2):
        try:
            data = await _api_get("/twitter/user/info", {"userName": username}, api_key)
            user = data.get("data") or {}
            if not isinstance(user, dict) or not user.get("userName"):
                return None
            return {
                "username": user["userName"].lower(),
                "display_name": (user.get("name") or username)[:100],
                "avatar_url": (user.get("profilePicture") or f"https://unavatar.io/x/{username}"),
                "followers": int(user.get("followers") or 0),
                "bio": (user.get("description") or "")[:400],
            }
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 429 and attempt == 0:
                print(f"[x] user info 429 for @{username}, retrying in 3s")
                await _asyncio.sleep(3)
            else:
                print(f"[x] user info HTTP error for @{username}: {e.response.status_code}")
                return None
        except Exception as e:
            print(f"[x] user info error for @{username}: {e}")
            return None
    return None


# ── Main collection function ──────────────────────────────────────────────────

import asyncio as _asyncio

_collect_lock = _asyncio.Lock()


async def collect_x_timeline(db: AsyncSession) -> dict:
    if _collect_lock.locked():
        return {"new_candidates": 0, "checked": 0, "new_posts": 0,
                "error": "采集任务已在运行中，跳过本次"}
    async with _collect_lock:
        return await _collect_inner(db)


async def _collect_inner(db: AsyncSession) -> dict:
    cfg = await _cfg()
    api_key = cfg.get("twitterapi_io_key", "").strip()
    if not api_key:
        return {"new_candidates": 0, "checked": 0, "new_posts": 0,
                "error": "twitterapi.io API Key 未配置，请在设置 → X 中填写"}

    threshold = max(0, int(cfg.get("x_follower_threshold", 5000)))
    post_window_hours = max(1, int(cfg.get("x_post_window_hours", 4)))
    search_queries = [
        q.strip() for q in cfg.get("x_search_queries", "").split(",") if q.strip()
    ]

    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=post_window_hours)

    # ── Load following accounts ───────────────────────────────────────────────
    following_rows = (await db.execute(
        _select(XBloggerCandidate).where(XBloggerCandidate.status == "following")
    )).scalars().all()
    following_names = [r.username for r in following_rows]

    # ── Collect raw tweets ────────────────────────────────────────────────────
    raw_tweets: list[dict] = []

    for uname in following_names:
        tweets = await _fetch_user_tweets(uname, api_key, count=20)
        print(f"[x] @{uname}: got {len(tweets)} tweets")
        raw_tweets.extend(tweets)

    for q in search_queries:
        tweets = await _search_tweets(q, api_key, count=20)
        print(f"[x] search {q!r}: got {len(tweets)} tweets")
        raw_tweets.extend(tweets)

    # ── Parse & deduplicate ───────────────────────────────────────────────────
    seen: dict[str, dict] = {}
    for raw in raw_tweets:
        parsed = _parse_tweet(raw)
        if parsed and parsed["tweet_id"] not in seen:
            seen[parsed["tweet_id"]] = parsed

    print(f"[x] total unique tweets: {len(seen)}")

    # ── Pre-load known candidates ─────────────────────────────────────────────
    all_usernames = {t["username"] for t in seen.values()}
    known_candidates: dict[str, XBloggerCandidate] = {}
    for uname in all_usernames:
        row = await db.get(XBloggerCandidate, uname)
        if row:
            known_candidates[uname] = row

    new_candidates = 0
    new_posts = 0
    skipped_old = 0

    for tid, t in seen.items():
        pub_at = t["published_at"]

        # Filter by post window
        if pub_at < cutoff:
            skipped_old += 1
            continue

        uname = t["username"]
        followers = t["followers"]

        # ── Upsert candidate ──────────────────────────────────────────────────
        if uname not in known_candidates:
            if followers >= threshold:
                # Fetch accurate profile (bio / avatar) from user info endpoint
                await _asyncio.sleep(0.5)
                info = await _get_user_info(uname, api_key)
                display_name = (info and info["display_name"]) or t["display_name"]
                avatar_url   = (info and info["avatar_url"])   or t["avatar_url"]
                bio          = (info and info["bio"])          or t["bio"]
                actual_followers = (info and info["followers"]) or followers

                await db.execute(
                    _sqlite_insert(XBloggerCandidate).values(
                        username=uname,
                        display_name=display_name,
                        avatar_url=avatar_url,
                        followers=actual_followers,
                        bio=bio,
                        profile_url=f"https://x.com/{uname}",
                        status="candidate",
                        added_at=now,
                        last_seen_at=now,
                    ).on_conflict_do_update(
                        index_elements=["username"],
                        set_={
                            "last_seen_at": now,
                            "display_name": display_name,
                            "avatar_url": avatar_url,
                            "followers": actual_followers,
                            "bio": bio,
                        },
                    )
                )
                new_candidates += 1
                known_candidates[uname] = None  # type: ignore[assignment]
        else:
            # Update last_seen and followers
            row = known_candidates[uname]
            if row and followers > 0:
                await db.execute(
                    _update(XBloggerCandidate)
                    .where(XBloggerCandidate.username == uname)
                    .values(last_seen_at=now, followers=followers)
                )

        # ── Upsert post ───────────────────────────────────────────────────────
        stmt = _sqlite_insert(XPost).values(
            tweet_id=tid,
            username=uname,
            content=t["content"],
            url=t["url"],
            published_at=pub_at,
            collected_at=now,
            author_followers=followers,
        ).on_conflict_do_update(
            index_elements=["tweet_id"],
            set_={"author_followers": followers},
        )
        res = await db.execute(stmt)
        if res.rowcount:
            new_posts += 1

        # ── Append metrics snapshot ───────────────────────────────────────────
        await db.execute(
            _sqlite_insert(XPostMetrics).values(
                tweet_id=tid,
                replies=t["replies"],
                reposts=t["reposts"],
                likes=t["likes"],
                views=t["views"],
                collected_at=now,
            )
        )

    await db.commit()
    print(f"[x] done: {new_posts} new posts, {new_candidates} new candidates, {skipped_old} skipped (old)")

    return {
        "new_candidates": new_candidates,
        "checked": len(following_names),
        "new_posts": new_posts,
        "error": None,
    }


# ── camofox helpers (kept for VNC browsing) ───────────────────────────────────

async def _camofox(cfg: dict) -> tuple[str, dict, str]:
    base = (cfg.get("camofox_url") or "http://localhost:9377").rstrip("/")
    headers: dict = {}
    key = cfg.get("camofox_api_key") or ""
    if key:
        headers["Authorization"] = f"Bearer {key}"
    user_id = cfg.get("camofox_user_id") or "wemedia_x"
    return base, headers, user_id


async def _create_tab(client: httpx.AsyncClient, base: str, headers: dict, user_id: str, url: str) -> str:
    body: dict = {"userId": user_id, "sessionKey": user_id, "url": url}
    r = await client.post(f"{base}/tabs", json=body, headers=headers)
    r.raise_for_status()
    data = r.json()
    return data.get("tabId") or data.get("id") or data["tabId"]


async def _close_session(client: httpx.AsyncClient, base: str, headers: dict, user_id: str):
    try:
        await client.delete(f"{base}/sessions/{user_id}", headers=headers)
    except Exception:
        pass


def _parse_cookies(raw: str) -> list[dict]:
    """Accept JSON array, Netscape, or raw header string; return camofox-ready list."""
    raw = raw.strip()
    if raw.startswith("["):
        try:
            cookies = json.loads(raw)
            if isinstance(cookies, list):
                out = []
                for c in cookies:
                    if not isinstance(c, dict) or not c.get("name"):
                        continue
                    out.append({
                        "name": c["name"], "value": c.get("value", ""),
                        "domain": c.get("domain", ".x.com"), "path": c.get("path", "/"),
                        "secure": c.get("secure", True),
                        "httpOnly": c.get("httpOnly", c.get("http_only", False)),
                        "sameSite": c.get("sameSite", c.get("same_site", "None")),
                    })
                return out
        except json.JSONDecodeError:
            pass

    if "Netscape HTTP Cookie" in raw or (raw.startswith("#") and "\t" in raw):
        out = []
        for line in raw.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) >= 7:
                domain, _, path, secure, _exp, name, value = parts[:7]
                out.append({"name": name, "value": value, "domain": domain, "path": path,
                             "secure": secure.upper() == "TRUE", "httpOnly": False, "sameSite": "None"})
        if out:
            return out

    out = []
    for part in raw.split(";"):
        part = part.strip()
        if not part:
            continue
        name, _, value = part.partition("=")
        name = name.strip()
        if not name:
            continue
        out.append({
            "name": name, "value": value.strip(),
            "domain": ".x.com", "path": "/", "secure": True,
            "httpOnly": name in ("auth_token", "ct0", "twid", "_twitter_sess"),
            "sameSite": "None",
        })
    return out


async def import_x_cookies(cookies_raw: str) -> dict:
    cfg = await _cfg()
    base, headers, user_id = await _camofox(cfg)
    api_key = cfg.get("camofox_api_key") or ""
    if not api_key:
        return {"ok": False, "error": "camofox_api_key 未配置，cookie 导入被禁用", "count": 0}
    try:
        cookies = _parse_cookies(cookies_raw)
    except Exception as e:
        return {"ok": False, "error": f"Cookie 解析失败: {e}", "count": 0}
    if not cookies:
        return {"ok": False, "error": "未解析到任何 cookie，请检查格式", "count": 0}
    import_headers = {**headers, "Authorization": f"Bearer {api_key}"}
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.post(
                f"{base}/sessions/{user_id}/cookies",
                json={"cookies": cookies},
                headers=import_headers,
            )
            r.raise_for_status()
        return {"ok": True, "error": None, "count": len(cookies)}
    except Exception as e:
        return {"ok": False, "error": str(e), "count": 0}


async def open_login_session() -> dict:
    cfg = await _cfg()
    base, headers, user_id = await _camofox(cfg)
    novnc_url = cfg.get("camofox_novnc_url") or "http://localhost:6080/vnc.html"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            tab_id = await _create_tab(client, base, headers, user_id, "https://x.com/i/flow/login")
        return {"ok": True, "tab_id": tab_id, "novnc_url": novnc_url, "error": None}
    except Exception as e:
        return {"ok": False, "tab_id": "", "novnc_url": novnc_url, "error": str(e)}


async def open_timeline_session() -> dict:
    cfg = await _cfg()
    base, headers, user_id = await _camofox(cfg)
    novnc_url = cfg.get("camofox_novnc_url") or "http://localhost:6080/vnc.html"
    api_key = cfg.get("camofox_api_key") or ""
    cookies_raw = cfg.get("x_cookies") or ""

    if not cookies_raw:
        return {"ok": False, "tab_id": "", "novnc_url": novnc_url, "cookie_count": 0,
                "error": "未配置 X Cookie，请先在设置中填写或通过 VNC 登录"}

    cookies = _parse_cookies(cookies_raw)
    if not cookies:
        return {"ok": False, "tab_id": "", "novnc_url": novnc_url, "cookie_count": 0,
                "error": "Cookie 解析失败，请检查格式"}

    import_headers = {**headers}
    if api_key:
        import_headers["Authorization"] = f"Bearer {api_key}"

    try:
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.post(
                f"{base}/sessions/{user_id}/cookies",
                json={"cookies": cookies},
                headers=import_headers,
            )
            r.raise_for_status()
            tab_id = await _create_tab(client, base, headers, user_id, "https://x.com/home")
        return {"ok": True, "tab_id": tab_id, "novnc_url": novnc_url,
                "cookie_count": len(cookies), "error": None}
    except Exception as e:
        return {"ok": False, "tab_id": "", "novnc_url": novnc_url, "cookie_count": 0, "error": str(e)}


async def import_session_from_camofox() -> dict:
    from config import set_config
    cfg = await _cfg()
    base, headers, user_id = await _camofox(cfg)
    api_key = cfg.get("camofox_api_key") or ""
    if not api_key:
        return {"ok": False, "cookie_count": 0, "error": "camofox_api_key 未配置"}
    auth_headers = {**headers, "Authorization": f"Bearer {api_key}"}
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.get(
                f"{base}/sessions/{user_id}/storage_state",
                headers=auth_headers,
            )
            r.raise_for_status()
            state = r.json()
    except Exception as e:
        return {"ok": False, "cookie_count": 0, "error": f"获取 storage_state 失败: {e}"}

    cookies: list[dict] = state.get("cookies", [])
    if not cookies:
        for origin in state.get("origins", []):
            if "x.com" in origin.get("origin", ""):
                cookies.extend(origin.get("localStorage", {}).get("cookies", []))

    if not cookies:
        return {"ok": False, "cookie_count": 0, "error": "storage_state 中未找到 cookie"}

    normalised = []
    for c in cookies:
        if not c.get("name"):
            continue
        normalised.append({
            "name": c["name"], "value": c.get("value", ""),
            "domain": c.get("domain", ".x.com"), "path": c.get("path", "/"),
            "secure": c.get("secure", True), "httpOnly": c.get("httpOnly", False),
            "sameSite": c.get("sameSite", "None"),
        })

    await set_config({"x_cookies": json.dumps(normalised)})
    return {"ok": True, "cookie_count": len(normalised), "error": None}
