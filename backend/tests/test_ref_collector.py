import sys, asyncio, pytest
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


def _rule(db_session, **kw):
    from models import RefCollectRule
    async def _mk():
        async with db_session() as db:
            r = RefCollectRule(label="t", source_subscription_id=1,
                               min_faves=1, exclude_sensitive=True, days=7, max_results=20, **kw)
            db.add(r); await db.commit(); await db.refresh(r)
            db.expunge(r)
            return r
    return asyncio.new_event_loop().run_until_complete(_mk())


def _seed_xpost(db_session, tid, *, likes=9000, sensitive=False, sub_id=1,
                text="这是一个挺好笑的段子内容哈哈"):
    from models import XPost
    from datetime import datetime, timezone
    async def _mk():
        async with db_session() as db:
            db.add(XPost(tweet_id=tid, subscription_id=sub_id, username="u",
                         display_name="U", content=text,
                         url=f"https://x.com/u/status/{tid}",
                         published_at=datetime.now(timezone.utc),
                         replies=1, reposts=2, likes=likes, views=likes * 10,
                         possibly_sensitive=sensitive))
            await db.commit()
    asyncio.new_event_loop().run_until_complete(_mk())


def _collect(db_session, rule):
    from ref_collector import collect_rule
    async def _go():
        async with db_session() as db:
            merged = await db.merge(rule)
            return await collect_rule(db, merged)
    return asyncio.new_event_loop().run_until_complete(_go())


def _materials(db_session):
    from models import RefMaterial
    async def _q():
        async with db_session() as db:
            return list((await db.execute(select(RefMaterial))).scalars().all())
    return asyncio.new_event_loop().run_until_complete(_q())


def _seen_verdicts(db_session):
    from models import RefSeen
    async def _q():
        async with db_session() as db:
            rows = (await db.execute(select(RefSeen))).scalars().all()
            return {(r.platform, r.source_id): r.verdict for r in rows}
    return asyncio.new_event_loop().run_until_complete(_q())


def test_prefilter_drops_sensitive_short_link_mention():
    from ref_collector import _prefilter
    from feedgrab_client import ParsedPost
    from datetime import datetime, timezone
    def p(tid, text, sensitive=False):
        return ParsedPost(tweet_id=tid, username="u", display_name="U", content=text,
                          url="", published_at=datetime.now(timezone.utc),
                          possibly_sensitive=sensitive)
    posts = [
        p("1", "这是一条足够长的正常段子内容"),
        p("2", "太短"),
        p("3", "看这个链接 https://t.co/x 快点"),
        p("4", "@a @b @c 冲"),
        p("5", "这条其实还行但是敏感", sensitive=True),
    ]
    out = _prefilter(posts, exclude_sensitive=True)
    assert [x.tweet_id for x in out] == ["1"]


def test_collect_inserts_active_with_local_score(db_session):
    rule = _rule(db_session)
    _seed_xpost(db_session, "t1", likes=9000)
    created = _collect(db_session, rule)
    assert len(created) == 1
    mats = _materials(db_session)
    assert len(mats) == 1
    m = mats[0]
    assert m.status == "active"
    assert m.score > 0           # 本地信号分，非 LLM
    assert m.category == ""      # 待低频分类
    assert m.text_clean != ""    # 规则清洗文本
    assert _seen_verdicts(db_session)[("x", "t1")] == "active"


def test_collect_clean_text_strips_trailing_tags(db_session):
    rule = _rule(db_session)
    _seed_xpost(db_session, "t1", text="正经段子内容在这里！！！！ #搞笑 #日常")
    _collect(db_session, rule)
    m = _materials(db_session)[0]
    assert "#搞笑" not in m.text_clean
    assert "！！！！" not in m.text_clean   # 重复标点压缩
    assert m.text.startswith("正经段子内容")  # 原文保留


def test_collect_dedup_within_batch_keeps_higher_score(db_session):
    rule = _rule(db_session)
    _seed_xpost(db_session, "hi", likes=50000,
                text="打工人的尽头是带薪拉屎，一天不拉浑身难受")
    _seed_xpost(db_session, "lo", likes=1000,
                text="打工人的尽头就是带薪拉屎，一天不拉感觉浑身难受")
    created = _collect(db_session, rule)
    assert len(created) == 1 and created[0].source_id == "hi"
    assert _seen_verdicts(db_session)[("x", "lo")] == "duplicate"


def test_collect_dedup_against_db_replaces_lower(db_session):
    rule = _rule(db_session)
    _seed_xpost(db_session, "old", likes=1000,
                text="程序员的快乐就是下班前十分钟修好了 bug")
    _collect(db_session, rule)
    _seed_xpost(db_session, "new", likes=80000,
                text="程序员的快乐，就是下班前十分钟修好了bug！")
    created = _collect(db_session, rule)
    assert len(created) == 1 and created[0].source_id == "new"
    by_sid = {m.source_id: m for m in _materials(db_session)}
    assert by_sid["old"].status == "duplicate"
    assert by_sid["new"].status == "active"


def test_collect_dedup_against_db_drops_lower_newcomer(db_session):
    rule = _rule(db_session)
    _seed_xpost(db_session, "old", likes=80000,
                text="程序员的快乐就是下班前十分钟修好了 bug")
    _collect(db_session, rule)
    _seed_xpost(db_session, "new", likes=500,
                text="程序员的快乐，就是下班前十分钟修好了bug！")
    created = _collect(db_session, rule)
    assert created == []
    by_sid = {m.source_id: m for m in _materials(db_session)}
    assert "new" not in by_sid
    assert by_sid["old"].status == "active"
    assert _seen_verdicts(db_session)[("x", "new")] == "duplicate"


def test_collect_skips_already_seen(db_session):
    rule = _rule(db_session)
    _seed_xpost(db_session, "t1")
    _collect(db_session, rule)
    created2 = _collect(db_session, rule)   # 二次跑同一条
    assert created2 == []
    assert len(_materials(db_session)) == 1


def test_classify_batch_fills_category_for_high_score(db_session):
    from unittest.mock import patch
    import json as _json
    rule = _rule(db_session)
    _seed_xpost(db_session, "t1", likes=90000)   # 高分，进分类队列
    _collect(db_session, rule)
    mid = _materials(db_session)[0].id

    async def fake_call(prompt, max_tokens=2048):
        return _json.dumps([{"source_id": str(mid), "category": "沙雕搞笑", "scene_tags": ["resonance"]}])

    from ref_collector import classify_batch
    async def _go():
        async with db_session() as db:
            with patch("llm._call", new=fake_call):
                return await classify_batch(db, 10)
    r = asyncio.new_event_loop().run_until_complete(_go())
    assert r["processed"] == 1 and r["classified"] == 1 and r["remaining"] == 0
    m = _materials(db_session)[0]
    assert m.category == "沙雕搞笑"
    assert m.scene_tags == ["resonance"]
    assert m.status == "active"


def test_classify_batch_skips_low_score(db_session):
    rule = _rule(db_session)
    _seed_xpost(db_session, "t1", likes=2)   # 低分（< ref_classify_min_score 60）
    _collect(db_session, rule)
    from ref_collector import classify_batch
    async def _go():
        async with db_session() as db:
            return await classify_batch(db, 10)
    r = asyncio.new_event_loop().run_until_complete(_go())
    assert r == {"processed": 0, "classified": 0, "remaining": 0}
