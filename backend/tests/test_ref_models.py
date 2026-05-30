import sys, asyncio, pytest


@pytest.fixture
def db_session(monkeypatch, tmp_path):
    db_file = tmp_path / "t.db"
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{db_file}")
    for mod in list(sys.modules):
        if mod.startswith(("database", "models", "config")):
            sys.modules.pop(mod, None)
    from database import engine, Base, SessionLocal
    import models  # noqa
    async def _setup():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    asyncio.new_event_loop().run_until_complete(_setup())
    return SessionLocal


def test_ref_material_roundtrip(db_session):
    from models import RefMaterial
    async def _run():
        async with db_session() as db:
            m = RefMaterial(platform="x", source_id="111", text="段子",
                            category="沙雕搞笑", scene_tags=["resonance"],
                            likes=9000, score=88)
            db.add(m)
            await db.commit()
            await db.refresh(m)
            assert m.id > 0 and m.status == "active" and m.scene_tags == ["resonance"]
    asyncio.new_event_loop().run_until_complete(_run())


def test_ref_material_unique_platform_source(db_session):
    from models import RefMaterial
    from sqlalchemy.exc import IntegrityError
    async def _run():
        async with db_session() as db:
            db.add(RefMaterial(platform="x", source_id="dup", text="a"))
            await db.commit()
        async with db_session() as db:
            db.add(RefMaterial(platform="x", source_id="dup", text="b"))
            with pytest.raises(IntegrityError):
                await db.commit()
    asyncio.new_event_loop().run_until_complete(_run())
