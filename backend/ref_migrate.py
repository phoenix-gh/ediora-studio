"""一次性把 quotes 表迁移进 ref_materials（platform 沿用 manual/agent）。
幂等：用 AppSetting 'ref_quotes_migrated' 标志位，跑过就跳过。"""
from datetime import datetime, timezone
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

_FLAG = "ref_quotes_migrated"


async def migrate_quotes_to_materials(db: AsyncSession) -> int:
    from models import Quote, RefMaterial, AppSetting

    flag = await db.get(AppSetting, _FLAG)
    if flag and flag.value == "1":
        return 0

    quotes = (await db.execute(select(Quote))).scalars().all()
    n = 0
    for q in quotes:
        db.add(RefMaterial(
            platform=q.platform or "manual",
            source_id=None,
            text=q.text,
            author=q.author or "",
            source=q.source or "",
            source_url=q.source_url or "",
            category="",
            scene_tags=list(q.scene_tags or []),
            tags=[],
            writing_plan_id=q.writing_plan_id,
            status="active",
            created_at=q.created_at or datetime.now(timezone.utc),
            updated_at=q.updated_at or datetime.now(timezone.utc),
        ))
        n += 1

    if flag:
        flag.value = "1"
    else:
        db.add(AppSetting(key=_FLAG, value="1"))
    await db.commit()
    return n


async def migrate_rules_to_search_subs(db: AsyncSession) -> int:
    """把每条旧 RefCollectRule 的搜索参数迁成一个 kind=search 的 XSubscription，
    并回填 rule.source_subscription_id。幂等：已回填的规则跳过。"""
    from models import RefCollectRule, XSubscription

    rules = (await db.execute(select(RefCollectRule))).scalars().all()
    n = 0
    for r in rules:
        if r.source_subscription_id is not None:
            continue
        if not (r.raw_query or "").strip():
            continue
        sub = XSubscription(
            kind="search", url=None, label=r.label or f"搜索:{r.raw_query[:24]}",
            enabled=r.enabled, raw_query=r.raw_query, min_faves=r.min_faves,
            min_retweets=r.min_retweets, lang=r.lang, days=r.days,
            # sort="live" (Latest): the "Top" product returns 0 for many operator
            # queries (e.g. -filter:replies); Latest honors all operators.
            extra_terms=r.extra_terms, sort="live", max_results=r.max_results,
            added_at=datetime.now(timezone.utc),
        )
        db.add(sub)
        await db.flush()  # 拿到 sub.id
        r.source_subscription_id = sub.id
        n += 1
    await db.commit()
    return n
