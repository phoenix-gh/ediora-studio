"""把 X Top 搜索结果提炼成参考文案：规则粗筛 → 存 raw → 按需批量 LLM 精筛 → 入库 + seen。"""
from __future__ import annotations
import re
from datetime import datetime, timezone

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.dialects.postgresql import insert as _pg_insert
from sqlalchemy.dialects.sqlite import insert as _sl_insert

from models import RefMaterial, RefCollectRule, RefSeen, XPost
from feedgrab_client import ParsedPost
from llm import classify_ref_posts, RefClassifyError
from config import get_config

_URL_RE = re.compile(r"https?://")

# 使用场景受控词表（与 routers/materials.SCENE_TAGS、前端保持一致）
SCENE_TAGS = ["opener", "closer", "argument", "twist", "resonance", "warning"]


def _prefilter(posts: list[ParsedPost], *, exclude_sensitive: bool) -> list[ParsedPost]:
    out: list[ParsedPost] = []
    for p in posts:
        t = (p.content or "").strip()
        if exclude_sensitive and p.possibly_sensitive:
            continue
        if len(t) < 10:
            continue
        if _URL_RE.search(t):
            continue
        tokens = t.split()
        mentions = sum(1 for tok in tokens if tok.startswith("@"))
        if tokens and mentions / len(tokens) > 0.5:
            continue
        out.append(p)
    return out


def _insert(table, dialect: str):
    return _sl_insert(table) if dialect == "sqlite" else _pg_insert(table)


async def _already_seen(db: AsyncSession, source_ids: list[str]) -> set[str]:
    if not source_ids:
        return set()
    rows = (await db.execute(
        select(RefSeen.source_id).where(
            RefSeen.platform == "x", RefSeen.source_id.in_(source_ids))
    )).scalars().all()
    return set(rows)


async def _mark_seen(db: AsyncSession, source_id: str, verdict: str):
    dialect = db.bind.dialect.name if db.bind else "postgresql"
    stmt = _insert(RefSeen, dialect).values(
        platform="x", source_id=source_id, verdict=verdict,
        seen_at=datetime.now(timezone.utc),
    ).on_conflict_do_nothing(index_elements=["platform", "source_id"])
    await db.execute(stmt)


async def _upsert_raw(db: AsyncSession, rule_id: int, p: ParsedPost):
    dialect = db.bind.dialect.name if db.bind else "postgresql"
    stmt = _insert(RefMaterial, dialect).values(
        platform="x", source_id=p.tweet_id, text=p.content,
        text_clean="", author=p.display_name,
        handle=p.username, source_url=p.url, cover_image=p.cover_image,
        likes=p.likes, reposts=p.reposts, replies=p.replies, views=p.views,
        score=0, category="", scene_tags=[], tags=[],
        rule_id=rule_id, status="raw", published_at=p.published_at,
        created_at=datetime.now(timezone.utc), updated_at=datetime.now(timezone.utc),
    ).on_conflict_do_nothing(index_elements=["platform", "source_id"])
    await db.execute(stmt)


async def _upsert_material(db: AsyncSession, rule_id: int, p: ParsedPost, v: dict):
    dialect = db.bind.dialect.name if db.bind else "postgresql"
    stmt = _insert(RefMaterial, dialect).values(
        platform="x", source_id=p.tweet_id, text=p.content,
        text_clean=(v.get("text_clean") or ""), author=p.display_name,
        handle=p.username, source_url=p.url, cover_image=p.cover_image,
        likes=p.likes, reposts=p.reposts, replies=p.replies, views=p.views,
        score=int(v.get("score") or 0), category=(v.get("category") or ""),
        scene_tags=list(v.get("scene_tags") or []), tags=list(v.get("tags") or []),
        rule_id=rule_id, status="active", published_at=p.published_at,
        created_at=datetime.now(timezone.utc), updated_at=datetime.now(timezone.utc),
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=["platform", "source_id"],
        set_={"likes": stmt.excluded.likes, "reposts": stmt.excluded.reposts,
              "replies": stmt.excluded.replies, "views": stmt.excluded.views,
              "score": stmt.excluded.score, "category": stmt.excluded.category,
              "scene_tags": stmt.excluded.scene_tags, "updated_at": stmt.excluded.updated_at},
    )
    await db.execute(stmt)


def _xpost_to_parsed(x: XPost) -> ParsedPost:
    return ParsedPost(
        tweet_id=x.tweet_id, username=x.username, display_name=x.display_name,
        content=x.content, url=x.url, published_at=x.published_at,
        replies=x.replies, reposts=x.reposts, likes=x.likes, views=x.views,
        author_avatar=x.author_avatar, cover_image=x.cover_image,
        raw_markdown=x.raw_markdown, possibly_sensitive=x.possibly_sensitive,
    )


async def collect_rule(db: AsyncSession, rule: RefCollectRule) -> int:
    """从 x_posts 取候选 → 粗筛 → 存为 raw。返回新存入 raw 条目数。
    异常写 rule.last_error 后抛出。"""
    from datetime import timedelta
    since = datetime.now(timezone.utc) - timedelta(days=max(1, rule.days))
    stmt = (
        select(XPost)
        .where(XPost.published_at >= since, XPost.likes >= rule.min_faves)
        .order_by(XPost.published_at.desc())
        .limit(max(1, rule.max_results))
    )
    if rule.source_subscription_id is not None:
        stmt = stmt.where(XPost.subscription_id == rule.source_subscription_id)
    try:
        rows = (await db.execute(stmt)).scalars().all()
    except Exception as e:
        rule.last_error = str(e)[:500]
        await db.commit()
        raise
    posts = [_xpost_to_parsed(x) for x in rows]

    seen = await _already_seen(db, [p.tweet_id for p in posts])
    fresh = [p for p in posts if p.tweet_id not in seen]
    survivors = _prefilter(fresh, exclude_sensitive=rule.exclude_sensitive)

    # 被粗筛掉的 fresh 也记 seen（rejected），避免下次重复处理
    survivor_ids = {p.tweet_id for p in survivors}
    for p in fresh:
        if p.tweet_id not in survivor_ids:
            await _mark_seen(db, p.tweet_id, "rejected")

    for p in survivors:
        await _upsert_raw(db, rule.id, p)
        await _mark_seen(db, p.tweet_id, "raw")

    rule.last_collected_at = datetime.now(timezone.utc)
    rule.last_error = ""
    await db.commit()
    return len(survivors)


async def collect_all(db: AsyncSession) -> dict:
    rules = (await db.execute(
        select(RefCollectRule).where(RefCollectRule.enabled == True)  # noqa: E712
    )).scalars().all()
    total, failed = 0, []
    for rule in rules:
        try:
            total += await collect_rule(db, rule)
        except Exception as e:
            failed.append(f"{rule.label}: {e}")
    return {"checked": len(rules), "new_materials": total, "failed": failed}
