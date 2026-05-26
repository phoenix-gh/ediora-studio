"""Adapter between WeMedia Studio and feedgrab for X/Twitter content.

This module is split into two layers:

  - ParsedPost / _tweet_dict_to_parsed_post  — pure data structure + parser (Task 4)
  - grab_timeline / search_x / auth_status   — feedgrab I/O glue (Task 5)

Real feedgrab tweet dict shape (from feedgrab.fetchers.twitter_graphql.extract_tweet_data):
  id           — tweet ID string
  text         — full tweet text (note_tweet long text preferred over legacy.full_text)
  author       — screen_name / handle (e.g. "elonmusk")
  author_name  — display name (e.g. "Elon Musk")
  created_at   — Twitter classic format "Wed May 20 14:30:00 +0000 2026"
  likes        — int
  retweets     — int
  replies      — int
  views        — str or int (from result.views.count)
  bookmarks    — int (not stored in ParsedPost but present in the dict)
  URL is not a field — constructed as https://x.com/{author}/status/{id}
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional


@dataclass
class ParsedPost:
    tweet_id: str
    username: str
    display_name: str
    content: str
    url: str
    published_at: datetime
    replies: int = 0
    reposts: int = 0
    likes: int = 0
    views: int = 0
    raw_markdown: str = ""


def _parse_created_at(raw) -> datetime:
    """Twitter timestamps come as either ISO 8601 or 'Wed May 20 10:00:00 +0000 2026'."""
    if isinstance(raw, datetime):
        return raw if raw.tzinfo else raw.replace(tzinfo=timezone.utc)
    s = str(raw or "").strip()
    if not s:
        return datetime.now(timezone.utc)
    # Twitter classic format
    try:
        return datetime.strptime(s, "%a %b %d %H:%M:%S %z %Y")
    except ValueError:
        pass
    # ISO 8601 fallback (with Z or offset)
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return datetime.now(timezone.utc)


def _render_markdown(d: dict) -> str:
    """Deterministic rendering of a feedgrab tweet dict to a small Markdown snippet.

    Used so raw_markdown is stable and human-readable in the DB.
    """
    handle = d.get("author", "") or ""
    display = d.get("author_name", "") or ""
    text = d.get("text", "") or ""
    created_at = _parse_created_at(d.get("created_at", ""))
    published_iso = created_at.strftime("%Y-%m-%dT%H:%M:%SZ")

    tweet_id = d.get("id", "") or ""
    url = f"https://x.com/{handle}/status/{tweet_id}" if handle and tweet_id else ""

    likes = int(d.get("likes", 0) or 0)
    retweets = int(d.get("retweets", 0) or 0)
    replies = int(d.get("replies", 0) or 0)
    views = int(d.get("views", 0) or 0)

    lines = [
        f"@{handle} ({display}) — {published_iso}",
        text,
        "",
        f"views {views} · likes {likes} · retweets {retweets} · replies {replies}",
    ]
    if url:
        lines.append(url)

    return "\n".join(lines)


def _tweet_dict_to_parsed_post(d: dict) -> Optional[ParsedPost]:
    """Convert a feedgrab tweet dict into ParsedPost. Returns None on missing id."""
    tweet_id = str(d.get("id", "") or "").strip()
    if not tweet_id:
        return None

    handle = str(d.get("author", "") or "").strip()
    display_name = str(d.get("author_name", "") or "").strip()
    content = str(d.get("text", "") or "").strip()
    url = f"https://x.com/{handle}/status/{tweet_id}" if handle else ""
    published_at = _parse_created_at(d.get("created_at", ""))

    replies = int(d.get("replies", 0) or 0)
    reposts = int(d.get("retweets", 0) or 0)
    likes = int(d.get("likes", 0) or 0)
    views = int(d.get("views", 0) or 0)

    raw_markdown = _render_markdown(d)

    return ParsedPost(
        tweet_id=tweet_id,
        username=handle,
        display_name=display_name,
        content=content,
        url=url,
        published_at=published_at,
        replies=replies,
        reposts=reposts,
        likes=likes,
        views=views,
        raw_markdown=raw_markdown,
    )


# ─── I/O layer ──────────────────────────────────────────────────────────────

import asyncio  # noqa: E402
import os  # noqa: E402
import re  # noqa: E402
from pathlib import Path  # noqa: E402


_PROFILE_RE = re.compile(r"(?:x\.com|twitter\.com)/([a-zA-Z0-9_]{1,15})(?:/|$)")
_LIST_RE = re.compile(r"(?:x\.com|twitter\.com)/i/lists/(\d+)")
_SYSTEM_HANDLES = {"i", "home", "explore", "search", "settings",
                   "notifications", "messages", "compose", "login",
                   "signup", "tos", "privacy", "hashtag"}

_MAX_TIMELINE_PAGES = 10  # safety cap; ~10 × 20–40 = 200–400 tweets per collect


def resolve_subscription_label(url: str) -> str:
    """Best-effort: fetch the real display name / list name for a URL.

    Falls back to `@<screen_name>` / `list-<id>` when cookies missing or
    feedgrab returns empty. Network call — wrap in asyncio.to_thread when
    invoked from async code.
    """
    try:
        kind, ident = _detect_timeline_kind(url)
    except ValueError:
        return ""

    fallback = ("list-" + ident) if kind == "list" else ("@" + ident)

    try:
        from feedgrab.fetchers.twitter_cookies import load_twitter_cookies
        cookies = load_twitter_cookies()
        if not (cookies.get("auth_token") and cookies.get("ct0")):
            return fallback

        if kind == "list":
            from feedgrab.fetchers.twitter_list_tweets import fetch_list_by_rest_id
            meta = fetch_list_by_rest_id(ident, cookies)
            return (meta.get("name") or "").strip() or fallback

        from feedgrab.fetchers.twitter_graphql import fetch_user_by_screen_name
        meta = fetch_user_by_screen_name(ident, cookies)
        name = (meta.get("name") or "").strip()
        handle = (meta.get("screen_name") or ident).strip()
        return name or f"@{handle}"
    except Exception:
        return fallback


def _detect_timeline_kind(url: str) -> tuple[str, str]:
    """Return (kind, identifier).

    kind == "list" → identifier is numeric list_id
    kind == "user" → identifier is screen_name (no @)
    """
    m = _LIST_RE.search(url)
    if m:
        return "list", m.group(1)
    m = _PROFILE_RE.search(url)
    if m and m.group(1).lower() not in _SYSTEM_HANDLES:
        return "user", m.group(1)
    raise ValueError(f"Unsupported timeline URL (need profile or list): {url}")


def _paginate(page_fetcher, resource_id: str, parse_entries, label: str,
              since: Optional[datetime], max_pages: int) -> list[dict]:
    """Shared pagination + cookie-rotation + early-stop loop.

    Mirrors the structure feedgrab uses inside fetch_user_tweets /
    fetch_list_tweets, minus disk writes / dedup index / thread expansion.
    """
    from feedgrab.fetchers.twitter_graphql import extract_tweet_data
    from feedgrab.fetchers.twitter_cookies import fetch_with_cookie_rotation

    tweets: list[dict] = []
    cursor: Optional[str] = None

    for _page in range(max_pages):
        response, _rotated = fetch_with_cookie_rotation(
            page_fetcher,
            resource_id,
            label=label,
            cursor=cursor,
        )
        if not response:
            break

        entries, cursors = parse_entries(response)
        if not entries:
            break

        reached_cutoff = False
        for entry in entries:
            td = extract_tweet_data(entry)
            if not td:
                continue
            if since is not None:
                pub = _parse_created_at(td.get("created_at", ""))
                if pub < since:
                    reached_cutoff = True
                    continue
            tweets.append(td)

        if reached_cutoff:
            break
        cursor = (cursors or {}).get("bottom") if isinstance(cursors, dict) else None
        if not cursor:
            break

    return tweets


def _fetch_timeline_raw(url: str, since: Optional[datetime] = None) -> list[dict]:
    """Sync helper: paginate either a user timeline or a list timeline,
    return flat tweet dicts.

    URL dispatch matches feedgrab's UniversalReader._detect_platform:
        x.com/i/lists/{id}    → twitter_list_tweets path
        x.com/<username>      → twitter_user_tweets path

    Mirrors feedgrab's pagination + cookie-rotation + early-stop loop but
    skips its disk side effects (no .md writes, no media download, no
    dedup index, no historical-gap supplementary search).

    Args:
        url: profile URL or list URL
        since: if provided, paginate until older tweets are encountered.
               If None, fetch only the first page.

    Wrapped by asyncio.to_thread in grab_timeline(); all feedgrab graphql
    functions are synchronous, so no nested event-loop risk here.
    """
    from feedgrab.fetchers.twitter_cookies import load_twitter_cookies

    cookies = load_twitter_cookies()
    if not (cookies.get("auth_token") and cookies.get("ct0")):
        raise RuntimeError("X 未登录 — 请在 backend 工作目录运行：feedgrab login twitter")

    kind, ident = _detect_timeline_kind(url)
    max_pages = 1 if since is None else _MAX_TIMELINE_PAGES

    if kind == "list":
        from feedgrab.fetchers.twitter_list_tweets import (
            fetch_list_tweets_page,
        )
        from feedgrab.fetchers.twitter_graphql import (
            parse_list_tweets_entries,
        )
        return _paginate(
            fetch_list_tweets_page, ident, parse_list_tweets_entries,
            label="ListTweets", since=since, max_pages=max_pages,
        )

    # kind == "user"
    from feedgrab.fetchers.twitter_graphql import (
        fetch_user_by_screen_name,
        fetch_user_tweets_page,
        parse_user_tweets_entries,
    )
    user_info = fetch_user_by_screen_name(ident, cookies)
    user_id = user_info.get("user_id", "")
    if not user_id:
        raise RuntimeError(f"无法解析 @{ident}（cookie 失效或账号不存在）")
    return _paginate(
        fetch_user_tweets_page, user_id, parse_user_tweets_entries,
        label="UserTweets", since=since, max_pages=max_pages,
    )


def _fetch_search_raw(query: str, limit: int = 20) -> list[dict]:
    """Sync helper: run feedgrab keyword search and return flat tweet dicts.

    search_twitter_keyword is an async coroutine; we run it on a fresh loop
    to avoid "event loop already running" errors when called from to_thread.
    """
    from feedgrab.fetchers.twitter_cookies import load_twitter_cookies
    from feedgrab.fetchers.twitter_keyword_search import search_twitter_keyword

    cookies = load_twitter_cookies()
    if not (cookies.get("auth_token") and cookies.get("ct0")):
        raise RuntimeError("X 未登录 — 请在 backend 工作目录运行：feedgrab login twitter")

    loop = asyncio.new_event_loop()
    try:
        result = loop.run_until_complete(
            search_twitter_keyword(
                keyword=query,
                max_results=limit,
                save_tweets=False,
                skip_summary=True,
            )
        )
    finally:
        loop.close()
    return list(result.get("tweets") or [])


async def grab_timeline(
    url: str, since: Optional[datetime] = None
) -> list[ParsedPost]:
    """Fetch a user's X/Twitter timeline as ParsedPost list.

    If `since` is given, paginate until reaching tweets older than it (using
    feedgrab's cursor pagination + cookie rotation). If None, only the first
    page is returned (used by callers that don't have a cutoff).
    """
    raw = await asyncio.to_thread(_fetch_timeline_raw, url, since)
    out: list[ParsedPost] = []
    for d in raw:
        if not isinstance(d, dict):
            continue
        p = _tweet_dict_to_parsed_post(d)
        if p:
            out.append(p)
    return out


async def search_x(query: str, limit: int = 20) -> list[ParsedPost]:
    """Search X/Twitter for `query` and return results as ParsedPost list."""
    raw = await asyncio.to_thread(_fetch_search_raw, query, limit)
    out: list[ParsedPost] = []
    for d in raw:
        if not isinstance(d, dict):
            continue
        p = _tweet_dict_to_parsed_post(d)
        if p:
            out.append(p)
    return out


def auth_status() -> dict:
    """Return {ready, hint}. ready=True iff feedgrab has X session credentials.

    Probes env vars first (fastest), then known session file locations.
    """
    if os.getenv("X_AUTH_TOKEN") and os.getenv("X_CT0"):
        return {"ready": True, "hint": "via env vars X_AUTH_TOKEN / X_CT0"}

    # Use feedgrab's own dir resolver so we look exactly where feedgrab will
    # look at call time (honors FEEDGRAB_DATA_DIR).
    try:
        from feedgrab.config import get_cookie_dir
        data_dir = get_cookie_dir()
    except Exception:
        data_dir = Path.cwd() / "sessions"

    candidates = [data_dir / "x.json", data_dir / "twitter.json"]
    for p in candidates:
        try:
            if p.exists():
                return {"ready": True, "hint": f"via {p}"}
        except OSError:
            continue

    return {
        "ready": False,
        "hint": f"未登录。请运行：feedgrab login twitter（cookies 应在 {data_dir}）",
    }
