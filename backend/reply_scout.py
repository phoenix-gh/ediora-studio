"""神回复子管道：高分爆款帖抓评论串，高赞回复经规则清洗后作为独立素材入库。

依赖单向：reply_scout → ref_collector（复用 seen/入库/打分 helpers）。
触发点在 scheduler 与 materials collect-all 端点（不在 collect_all 内，避免环）。
"""
from __future__ import annotations
import asyncio
import re
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models import RefMaterial, RefSeen
from feedgrab_client import ParsedPost
from config import get_config
from ref_signals import engagement_score, DEFAULT_SCALE
from ref_collector import _already_seen, _mark_seen, _upsert_active, _clean_text

_URL_RE = re.compile(r"https?://")
_LEADING_MENTIONS_RE = re.compile(r"^(?:@\S+\s+)+")
_TW_DATE_FMT = "%a %b %d %H:%M:%S %z %Y"

# 每轮最多侦察的父帖数（限流第一道闸）
_PARENT_BUDGET = 5
# 每父帖最多入库的神回复数
_TOP_REPLIES = 3
# 父帖候选回看窗口（只侦察最近入库的）
_PARENT_LOOKBACK_HOURS = 24


def clean_reply_text(text: str) -> str | None:
    """回复清洗：剥开头 @链 → 长度/URL 校验。通过返回干净文本，否则 None。"""
    t = _LEADING_MENTIONS_RE.sub("", (text or "").strip()).strip()
    if len(t) < 10:
        return None
    if _URL_RE.search(t):
        return None
    return t


def filter_replies(tweets: list[dict], parent_id: str) -> list[dict]:
    """从 TweetDetail 解析结果中筛出对 parent_id 的直接回复（排除父帖自身）。"""
    return [
        t for t in tweets
        if t.get("id") != parent_id and str(t.get("in_reply_to_status_id") or "") == str(parent_id)
    ]


def _load_cookies() -> dict:
    try:
        from feedgrab.fetchers.twitter_cookies import load_twitter_cookies
        return load_twitter_cookies() or {}
    except Exception:
        return {}


def _fetch_thread_tweets(tweet_id: str, cookies: dict) -> list[dict] | None:
    """同步：TweetDetail 一次抓取 → tweet dicts。失败返回 None（调用方决定重试）。"""
    try:
        from feedgrab.fetchers.twitter_thread import (
            fetch_tweet_detail, parse_tweet_entries, _parse_entries_to_tweets,
        )
        resp = fetch_tweet_detail(tweet_id, cookies)
        if not resp:
            return None
        return _parse_entries_to_tweets(parse_tweet_entries(resp))
    except Exception:
        return None


def _parse_tw_date(raw: str) -> datetime:
    try:
        return datetime.strptime(raw, _TW_DATE_FMT)
    except (ValueError, TypeError):
        return datetime.now(timezone.utc)


def _reply_to_parsed(r: dict, text: str) -> ParsedPost:
    rid = str(r.get("id") or "")
    author = str(r.get("author") or "")
    try:
        views = int(str(r.get("views") or "0").replace(",", ""))
    except ValueError:
        views = 0
    images = r.get("images") or []
    return ParsedPost(
        tweet_id=rid, username=author, display_name=str(r.get("author_name") or author),
        content=text, url=f"https://x.com/{author}/status/{rid}" if author and rid else "",
        published_at=_parse_tw_date(str(r.get("created_at") or "")),
        replies=int(r.get("replies") or 0), reposts=int(r.get("retweets") or 0),
        likes=int(r.get("likes") or 0), views=views,
        cover_image=str(images[0]) if images else "",
        possibly_sensitive=bool(r.get("possibly_sensitive")),
    )


async def _pick_parents(db: AsyncSession, threshold: int) -> list[RefMaterial]:
    """近 24h 入库、score 达标、非神回复自身、未侦察过的父帖，按分取 top。"""
    since = datetime.now(timezone.utc) - timedelta(hours=_PARENT_LOOKBACK_HOURS)
    rows = (await db.execute(
        select(RefMaterial).where(
            RefMaterial.platform == "x",
            RefMaterial.status == "active",
            RefMaterial.score >= threshold,
            RefMaterial.parent_source_id.is_(None),
            RefMaterial.created_at >= since,
        ).order_by(RefMaterial.score.desc()).limit(_PARENT_BUDGET * 4)
    )).scalars().all()
    if not rows:
        return []
    scouted = (await db.execute(
        select(RefSeen.source_id).where(
            RefSeen.platform == "x_replies",
            RefSeen.source_id.in_([m.source_id for m in rows]),
        )
    )).scalars().all()
    scouted_set = set(scouted)
    return [m for m in rows if m.source_id not in scouted_set][:_PARENT_BUDGET]


async def scout_replies(db: AsyncSession) -> dict:
    """对近期高分父帖抓神回复并入库。任何失败只降级，不抛出。"""
    cookies = _load_cookies()
    if not (cookies.get("auth_token") and cookies.get("ct0")):
        return {"scouted": 0, "new_replies": 0}

    cfg = await get_config()
    threshold = int(cfg.get("ref_reply_scout_threshold", 70))
    min_likes = int(cfg.get("ref_reply_min_likes", 100))
    scale = float(cfg.get("ref_score_scale", DEFAULT_SCALE))

    parents = await _pick_parents(db, threshold)
    scouted = new_count = 0
    for parent in parents:
        tweets = await asyncio.to_thread(_fetch_thread_tweets, parent.source_id, cookies)
        if tweets is None:
            continue  # fetch 失败：不标 scouted，下轮重试
        await _mark_seen(db, parent.source_id, "scouted", platform="x_replies")
        scouted += 1

        candidates: list[tuple[dict, str, int]] = []
        for r in filter_replies(tweets, parent.source_id):
            if r.get("possibly_sensitive"):
                continue
            text = clean_reply_text(str(r.get("text") or ""))
            if text is None:
                continue
            likes = int(r.get("likes") or 0)
            if likes < min_likes:
                continue
            candidates.append((r, text, likes))
        candidates.sort(key=lambda x: x[2], reverse=True)

        for r, text, _likes in candidates[:_TOP_REPLIES]:
            rid = str(r.get("id") or "")
            if not rid:
                continue
            if await _already_seen(db, [rid]):
                continue
            p = _reply_to_parsed(r, text)
            score = engagement_score(p.likes, p.reposts, p.replies, p.views, scale=scale)
            await _upsert_active(
                db, p, score=score, text_clean=_clean_text(text),
                parent_source_id=parent.source_id,
            )
            await _mark_seen(db, rid, "active")
            new_count += 1

    await db.commit()
    return {"scouted": scouted, "new_replies": new_count}
