import sys, asyncio, pytest


@pytest.fixture
def env(monkeypatch, tmp_path):
    db_file = tmp_path / "t.db"
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{db_file}")
    for mod in list(sys.modules):
        if mod.startswith(("database", "models", "config", "ref_migrate")):
            sys.modules.pop(mod, None)
    from database import engine, Base
    import models  # noqa
    async def _setup():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    asyncio.new_event_loop().run_until_complete(_setup())


def test_migrate_quotes_idempotent(env):
    from database import SessionLocal
    from models import Quote, RefMaterial
    from ref_migrate import migrate_quotes_to_materials
    from sqlalchemy import select

    async def _run():
        async with SessionLocal() as db:
            db.add(Quote(text="金句A", author="鲁迅", scene_tags=["opener"], platform="manual"))
            db.add(Quote(text="金句B", scene_tags=[], platform="agent"))
            await db.commit()
        # 跑两次，应只迁移一次
        async with SessionLocal() as db:
            await migrate_quotes_to_materials(db)
        async with SessionLocal() as db:
            await migrate_quotes_to_materials(db)
        async with SessionLocal() as db:
            mats = (await db.execute(select(RefMaterial))).scalars().all()
        texts = sorted(m.text for m in mats)
        assert texts == ["金句A", "金句B"]
        a = next(m for m in mats if m.text == "金句A")
        assert a.platform == "manual" and a.scene_tags == ["opener"] and a.author == "鲁迅"
    asyncio.new_event_loop().run_until_complete(_run())
