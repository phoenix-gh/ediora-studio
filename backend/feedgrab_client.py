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


def _parse_screen_name(url: str) -> str:
    """Extract screen_name from a profile URL like https://x.com/<username>."""
    match = re.search(r"(?:x\.com|twitter\.com)/([a-zA-Z0-9_]{1,15})(?:/|$)", url)
    if match:
        return match.group(1)
    raise ValueError(f"Cannot extract screen_name from URL: {url}")


def _fetch_timeline_raw(url: str) -> list[dict]:
    """Sync helper: fetch first page of a user's timeline as flat tweet dicts.

    Approach: Option 4 — lower-level GraphQL paginator.
    Uses feedgrab.fetchers.twitter_graphql directly:
      fetch_user_by_screen_name → fetch_user_tweets_page →
      parse_user_tweets_entries → extract_tweet_data
    This returns the full extract_tweet_data dicts (id, text, author, likes, …)
    without writing any Markdown files, unlike fetch_user_tweets() which only
    returns a summary dict and the list_path JSON lacks text/metrics fields.

    Wrapped by asyncio.to_thread in grab_timeline(); all feedgrab graphql
    functions are synchronous, so no nested event-loop risk here.
    """
    from feedgrab.fetchers.twitter_graphql import (
        fetch_user_by_screen_name,
        fetch_user_tweets_page,
        parse_user_tweets_entries,
        extract_tweet_data,
    )
    from feedgrab.fetchers.twitter_cookies import load_twitter_cookies

    cookies = load_twitter_cookies()
    screen_name = _parse_screen_name(url)

    user_info = fetch_user_by_screen_name(screen_name, cookies)
    user_id = user_info.get("user_id", "")
    if not user_id:
        return []

    response = fetch_user_tweets_page(user_id, cookies)
    if not response:
        return []

    entries, _cursors = parse_user_tweets_entries(response)
    tweets: list[dict] = []
    for entry in entries:
        td = extract_tweet_data(entry)
        if td:
            tweets.append(td)
    return tweets


def _fetch_search_raw(query: str, limit: int = 20) -> list[dict]:
    """Sync helper: run feedgrab keyword search and return flat tweet dicts.

    search_twitter_keyword is an async coroutine; we run it on a fresh loop
    to avoid "event loop already running" errors when called from to_thread.
    """
    from feedgrab.fetchers.twitter_keyword_search import search_twitter_keyword

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


async def grab_timeline(url: str) -> list[ParsedPost]:
    """Fetch the first page of a user's X/Twitter timeline as ParsedPost list."""
    raw = await asyncio.to_thread(_fetch_timeline_raw, url)
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

    candidates = [
        Path.cwd() / "sessions" / "x.json",
        Path.cwd() / "sessions" / "twitter.json",
        Path.home() / ".feedgrab" / "sessions" / "x.json",
        Path.home() / ".feedgrab" / "sessions" / "twitter.json",
    ]
    for p in candidates:
        try:
            if p.exists():
                return {"ready": True, "hint": f"via {p}"}
        except OSError:
            continue

    return {
        "ready": False,
        "hint": "未登录。请在 backend 工作目录运行：feedgrab login twitter",
    }
