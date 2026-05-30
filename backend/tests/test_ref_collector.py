import sys, asyncio, pytest
from unittest.mock import patch
from sqlalchemy import select


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


def _post(tid, text="这是一个挺好笑的段子内容哈哈", sensitive=False, likes=9000):
    from feedgrab_client import ParsedPost
    from datetime import datetime, timezone
    return ParsedPost(tweet_id=tid, username="u", display_name="U", content=text,
                      url=f"https://x.com/u/status/{tid}",
                      published_at=datetime.now(timezone.utc),
                      replies=1, reposts=2, likes=likes, views=likes * 10,
                      possibly_sensitive=sensitive)


def _rule(db_session):
    from models import RefCollectRule
    async def _mk():
        async with db_session() as db:
            r = RefCollectRule(label="t", raw_query="min_faves:1 lang:zh",
                               exclude_sensitive=True, max_results=20)
            db.add(r); await db.commit(); await db.refresh(r)
            return r.id
    return asyncio.new_event_loop().run_until_complete(_mk())


def test_prefilter_drops_sensitive_short_link_mention():
    from ref_collector import _prefilter
    posts = [
        _post("ok"),                                   # keep
        _post("sens", sensitive=True),                 # drop: sensitive
        _post("short", text="哈"),                      # drop: too short
        _post("link", text="好物推荐 http://t.co/x"),    # drop: link
        _post("at", text="@a @b @c @d"),                # drop: mention-heavy
    ]
    kept = _prefilter(posts, exclude_sensitive=True)
    assert [p.tweet_id for p in kept] == ["ok"]


def test_collect_rule_only_keeps_kept_and_writes_seen(db_session):
    import ref_collector as rc
    from models import RefMaterial, RefSeen, RefCollectRule
    rid = _rule(db_session)

    async def fake_search(**kw):
        return [_post("k1"), _post("d1")]
    async def fake_classify(posts, categories, scene_tags):
        return [{"source_id": "k1", "keep": True, "score": 80, "category": "沙雕搞笑",
                 "scene_tags": ["resonance"], "tags": ["a"], "text_clean": "净"},
                {"source_id": "d1", "keep": False, "score": 5, "category": "其他",
                 "scene_tags": [], "tags": [], "text_clean": ""}]
    async def fake_cfg():
        return {"ref_categories": "沙雕搞笑,其他"}

    async def _run():
        async with db_session() as db:
            rule = await db.get(RefCollectRule, rid)
            with patch.object(rc, "search_top", new=fake_search), \
                 patch.object(rc, "classify_ref_posts", new=fake_classify), \
                 patch.object(rc, "get_config", new=fake_cfg):
                kept = await rc.collect_rule(db, rule)
            assert kept == 1
            mats = (await db.execute(select(RefMaterial))).scalars().all()
            assert {m.source_id for m in mats} == {"k1"}
            assert mats[0].category == "沙雕搞笑" and mats[0].text_clean == "净"
            seen = (await db.execute(select(RefSeen))).scalars().all()
            assert {s.source_id: s.verdict for s in seen} == {"k1": "kept", "d1": "rejected"}
    asyncio.new_event_loop().run_until_complete(_run())


def test_collect_rule_skips_seen_ids(db_session):
    import ref_collector as rc
    from models import RefCollectRule, RefSeen
    rid = _rule(db_session)

    async def fake_search(**kw):
        return [_post("already")]
    async def boom_classify(*a, **k):
        raise AssertionError("should not classify a seen id")
    async def fake_cfg():
        return {"ref_categories": "其他"}

    async def _run():
        async with db_session() as db:
            db.add(RefSeen(platform="x", source_id="already", verdict="rejected"))
            await db.commit()
            rule = await db.get(RefCollectRule, rid)
            with patch.object(rc, "search_top", new=fake_search), \
                 patch.object(rc, "classify_ref_posts", new=boom_classify), \
                 patch.object(rc, "get_config", new=fake_cfg):
                kept = await rc.collect_rule(db, rule)
            assert kept == 0
    asyncio.new_event_loop().run_until_complete(_run())
