"""参考文案采集漏斗：规则粗筛 → seen 去重 → 近重复去重 → 本地信号打分 → 入库 active。

LLM 不再守门（旧 raw→LLM 精筛→入库 模式已移除）：素材入库零 LLM 依赖，
低频 classify_batch 只给高分素材补 category/scene_tags。
"""
from __future__ import annotations
import re
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.dialects.postgresql import insert as _pg_insert
from sqlalchemy.dialects.sqlite import insert as _sl_insert

from models import RefMaterial, RefCollectRule, RefSeen, XPost
from feedgrab_client import ParsedPost
from llm import classify_ref_categories, RefClassifyError  # noqa: F401 (router 复用 RefClassifyError)
from config import get_config
from ref_signals import engagement_score, DEFAULT_SCALE
from text_dedupe import PreparedText, similarity, DEFAULT_THRESHOLD

_URL_RE = re.compile(r"https?://")
_TRAILING_TAG_RE = re.compile(r"(?:\s*#\S+)+\s*$")
_REPEAT_PUNCT_RE = re.compile(r"([!！?？。.~～，,])\1{2,}")

# 使用场景受控词表（与 routers/materials.SCENE_TAGS、前端保持一致）
SCENE_TAGS = ["opener", "closer", "argument", "twist", "resonance", "warning"]

# 近重复比对的库内回看窗口
_DEDUP_LOOKBACK_DAYS = 14


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


def _clean_text(text: str) -> str:
    """规则文本清洗：去尾部纯 #tag 串、压缩 3+ 连续重复标点为 2。"""
    t = _TRAILING_TAG_RE.sub("", (text or "").strip())
    t = _REPEAT_PUNCT_RE.sub(r"\1\1", t)
    return t.strip()


def _insert(table, dialect: str):
    return _sl_insert(table) if dialect == "sqlite" else _pg_insert(table)


async def _already_seen(db: AsyncSession, source_ids: list[str], platform: str = "x") -> set[str]:
    if not source_ids:
        return set()
    rows = (await db.execute(
        select(RefSeen.source_id).where(
            RefSeen.platform == platform, RefSeen.source_id.in_(source_ids))
    )).scalars().all()
    return set(rows)


async def _mark_seen(db: AsyncSession, source_id: str, verdict: str, platform: str = "x"):
    dialect = db.bind.dialect.name if db.bind else "postgresql"
    stmt = _insert(RefSeen, dialect).values(
        platform=platform, source_id=source_id, verdict=verdict,
        seen_at=datetime.now(timezone.utc),
    ).on_conflict_do_nothing(index_elements=["platform", "source_id"])
    await db.execute(stmt)


async def _upsert_active(
    db: AsyncSession, p: ParsedPost, *,
    score: int, text_clean: str,
    rule_id: int | None = None, parent_source_id: str | None = None,
):
    """统一入库：主线素材（rule_id）与神回复（parent_source_id）共用。"""
    dialect = db.bind.dialect.name if db.bind else "postgresql"
    stmt = _insert(RefMaterial, dialect).values(
        platform="x", source_id=p.tweet_id, text=p.content,
        text_clean=text_clean, author=p.display_name,
        handle=p.username, source_url=p.url, cover_image=p.cover_image,
        likes=p.likes, reposts=p.reposts, replies=p.replies, views=p.views,
        score=score, category="", scene_tags=[], tags=[],
        rule_id=rule_id, parent_source_id=parent_source_id,
        status="active", published_at=p.published_at,
        created_at=datetime.now(timezone.utc), updated_at=datetime.now(timezone.utc),
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=["platform", "source_id"],
        set_={"likes": stmt.excluded.likes, "reposts": stmt.excluded.reposts,
              "replies": stmt.excluded.replies, "views": stmt.excluded.views,
              "score": stmt.excluded.score, "updated_at": stmt.excluded.updated_at},
    )
    await db.execute(stmt)


async def _load_recent_prepared(db: AsyncSession) -> list[tuple[int, int, PreparedText]]:
    """库内近 _DEDUP_LOOKBACK_DAYS 天 active 素材的 (id, score, PreparedText)。"""
    since = datetime.now(timezone.utc) - timedelta(days=_DEDUP_LOOKBACK_DAYS)
    rows = (await db.execute(
        select(RefMaterial.id, RefMaterial.score, RefMaterial.text).where(
            RefMaterial.platform == "x",
            RefMaterial.status == "active",
            RefMaterial.created_at >= since,
        )
    )).all()
    return [(r.id, r.score, PreparedText(r.text)) for r in rows]


async def _dedup_survivors(
    db: AsyncSession, survivors: list[ParsedPost], scale: float,
) -> list[tuple[ParsedPost, int]]:
    """近重复去重。返回 (post, score) 接受列表；重复者写 seen=duplicate。

    高分先处理：批内撞重时后来的低分者被丢；撞库内条目时分高者替换
    （旧条目 status='duplicate'），分低者丢弃。
    """
    existing = await _load_recent_prepared(db)
    scored = sorted(
        ((p, engagement_score(p.likes, p.reposts, p.replies, p.views, scale=scale)) for p in survivors),
        key=lambda x: x[1], reverse=True,
    )
    accepted: list[tuple[ParsedPost, int]] = []
    accepted_preps: list[PreparedText] = []
    for p, score in scored:
        prep = PreparedText(p.content)
        if any(similarity(prep, ap) >= DEFAULT_THRESHOLD for ap in accepted_preps):
            await _mark_seen(db, p.tweet_id, "duplicate")
            continue
        db_dup = next(
            ((mid, mscore) for mid, mscore, ep in existing if similarity(prep, ep) >= DEFAULT_THRESHOLD),
            None,
        )
        if db_dup is not None:
            mid, mscore = db_dup
            if score > mscore:
                old = await db.get(RefMaterial, mid)
                if old is not None:
                    old.status = "duplicate"
                    old.updated_at = datetime.now(timezone.utc)
            else:
                await _mark_seen(db, p.tweet_id, "duplicate")
                continue
        accepted.append((p, score))
        accepted_preps.append(prep)
    return accepted


def _xpost_to_parsed(x: XPost) -> ParsedPost:
    return ParsedPost(
        tweet_id=x.tweet_id, username=x.username, display_name=x.display_name,
        content=x.content, url=x.url, published_at=x.published_at,
        replies=x.replies, reposts=x.reposts, likes=x.likes, views=x.views,
        author_avatar=x.author_avatar, cover_image=x.cover_image,
        raw_markdown=x.raw_markdown, possibly_sensitive=x.possibly_sensitive,
    )


async def collect_rule(db: AsyncSession, rule: RefCollectRule) -> list[RefMaterial]:
    """从 x_posts 取候选 → 漏斗（粗筛/seen/近重复/打分）→ 入库 active。
    返回本轮新入库的 RefMaterial 列表。异常写 rule.last_error 后抛出。"""
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

    cfg = await get_config()
    scale = float(cfg.get("ref_score_scale", DEFAULT_SCALE))
    accepted = await _dedup_survivors(db, survivors, scale)

    for p, score in accepted:
        await _upsert_active(db, p, score=score, text_clean=_clean_text(p.content), rule_id=rule.id)
        await _mark_seen(db, p.tweet_id, "active")

    rule.last_collected_at = datetime.now(timezone.utc)
    rule.last_error = ""
    await db.commit()

    if not accepted:
        return []
    ids = [p.tweet_id for p, _ in accepted]
    created = (await db.execute(
        select(RefMaterial).where(RefMaterial.platform == "x", RefMaterial.source_id.in_(ids))
    )).scalars().all()
    return list(created)


async def classify_batch(db: AsyncSession, size: int) -> dict:
    """给高分未分类素材批量补 category/scene_tags。
    LLM 全批失败抛 RefClassifyError；失败素材 category 留空下轮自然重试。"""
    cfg = await get_config()
    min_score = int(cfg.get("ref_classify_min_score", 60))
    items = list((await db.execute(
        select(RefMaterial).where(
            RefMaterial.status == "active",
            RefMaterial.category == "",
            RefMaterial.score >= min_score,
        ).order_by(RefMaterial.score.desc()).limit(size)
    )).scalars().all())

    if not items:
        return {"processed": 0, "classified": 0, "remaining": 0}

    categories = [c for c in cfg.get("ref_categories", "").split(",") if c]
    payload = [{"source_id": str(m.id), "text": m.text_clean or m.text} for m in items]

    verdicts = await classify_ref_categories(payload, categories, SCENE_TAGS)
    vmap = {str(v.get("source_id")): v for v in verdicts}

    classified = 0
    now = datetime.now(timezone.utc)
    for m in items:
        v = vmap.get(str(m.id))
        if v is None:
            continue  # LLM 漏回 → 下轮重试
        m.category = (v.get("category") or "其他")
        m.scene_tags = list(v.get("scene_tags") or [])
        m.updated_at = now
        classified += 1

    await db.commit()
    remaining = await db.scalar(
        select(func.count()).where(
            RefMaterial.status == "active",
            RefMaterial.category == "",
            RefMaterial.score >= min_score,
        )
    )
    return {"processed": len(items), "classified": classified, "remaining": remaining or 0}


async def collect_all(db: AsyncSession) -> dict:
    rules = (await db.execute(
        select(RefCollectRule).where(RefCollectRule.enabled == True)  # noqa: E712
    )).scalars().all()
    total, failed = 0, []
    for rule in rules:
        try:
            total += len(await collect_rule(db, rule))
        except Exception as e:
            failed.append(f"{rule.label}: {e}")
    return {"checked": len(rules), "new": total, "failed": failed}
