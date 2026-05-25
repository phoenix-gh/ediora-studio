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
