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
