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


def _seed(**kw):
    """Insert one RefMaterial row with sensible defaults."""
    from database import SessionLocal
    from models import RefMaterial
    defaults = dict(platform="x", status="active", score=80, category="观点争论",
                    scene_tags=["argument"], text="默认素材文本内容", text_clean="")
    defaults.update(kw)
    async def _mk():
        async with SessionLocal() as db:
            m = RefMaterial(**defaults)
            db.add(m)
            await db.commit()
    asyncio.new_event_loop().run_until_complete(_mk())


def _search(**kw):
    import mcp_server
    return asyncio.new_event_loop().run_until_complete(
        mcp_server.search_ref_materials(**kw))


def test_filter_by_category(env):
    _seed(source_id="1", category="产品动态", text="Claude 降价了")
    _seed(source_id="2", category="观点争论", text="有人吵起来了")
    res = _search(category="产品动态")
    assert [r["text"] for r in res] == ["Claude 降价了"]


def test_filter_by_scene_tag(env):
    _seed(source_id="1", scene_tags=["opener"], text="开头钩子素材")
    _seed(source_id="2", scene_tags=["argument"], text="论据素材")
    res = _search(scene_tag="opener")
    assert [r["text"] for r in res] == ["开头钩子素材"]


def test_q_matches_text(env):
    _seed(source_id="1", text="DeepSeek 又发新模型了")
    _seed(source_id="2", text="完全无关的内容")
    res = _search(q="deepseek")   # 大小写不敏感
    assert len(res) == 1 and "DeepSeek" in res[0]["text"]


def test_min_score_default_60(env):
    _seed(source_id="1", score=90, text="高分")
    _seed(source_id="2", score=30, text="低分")
    res = _search()
    assert [r["text"] for r in res] == ["高分"]


def test_excludes_non_active(env):
    _seed(source_id="1", status="rejected", text="被否的")
    _seed(source_id="2", status="duplicate", text="重复的")
    _seed(source_id="3", status="active", text="正常的")
    res = _search()
    assert [r["text"] for r in res] == ["正常的"]


def test_sorted_by_score_desc_with_limit(env):
    _seed(source_id="1", score=70, text="七十")
    _seed(source_id="2", score=95, text="九五")
    _seed(source_id="3", score=80, text="八十")
    res = _search(limit=2)
    assert [r["text"] for r in res] == ["九五", "八十"]


def test_is_reply_flag_and_clean_preferred(env):
    _seed(source_id="1", parent_source_id="p9", text="原文", text_clean="干净版")
    res = _search()
    assert res[0]["is_reply"] is True
    assert res[0]["text"] == "干净版"
