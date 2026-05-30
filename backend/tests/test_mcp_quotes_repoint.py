import sys, asyncio, pytest


@pytest.fixture
def env(monkeypatch, tmp_path):
    db_file = tmp_path / "t.db"
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{db_file}")
    for mod in list(sys.modules):
        if mod.startswith(("database", "models", "config", "mcp_server")):
            sys.modules.pop(mod, None)
    from database import engine, Base
    import models  # noqa
    async def _setup():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    asyncio.new_event_loop().run_until_complete(_setup())


def test_save_quote_writes_ref_materials(env):
    import mcp_server
    from database import SessionLocal
    from models import RefMaterial
    from sqlalchemy import select

    async def _run():
        out = await mcp_server.save_quote(text="测试金句", author="A",
                                          scene_tags=["opener", "bogus"])
        assert out["id"] > 0
        async with SessionLocal() as db:
            rows = (await db.execute(select(RefMaterial))).scalars().all()
        assert len(rows) == 1
        assert rows[0].platform == "agent" and rows[0].scene_tags == ["opener"]
    asyncio.new_event_loop().run_until_complete(_run())


def test_list_quotes_excludes_x_platform(env):
    import mcp_server
    from database import SessionLocal
    from models import RefMaterial

    async def _run():
        async with SessionLocal() as db:
            db.add(RefMaterial(platform="manual", text="金句", scene_tags=["opener"]))
            db.add(RefMaterial(platform="x", source_id="1", text="段子", scene_tags=["opener"]))
            await db.commit()
        res = await mcp_server.list_quotes()
        texts = {r["text"] for r in res}
        assert texts == {"金句"}  # 段子(platform=x)被排除
    asyncio.new_event_loop().run_until_complete(_run())
