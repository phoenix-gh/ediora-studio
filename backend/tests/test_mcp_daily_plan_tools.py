import sys, asyncio, pytest
from datetime import datetime, timezone, timedelta


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


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _now():
    return datetime.now(timezone.utc)


def _seed(model, **kw):
    from database import SessionLocal
    async def _mk():
        async with SessionLocal() as db:
            db.add(model(**kw))
            await db.commit()
    _run(_mk())


def _seed_basics():
    from models import XPost, KrArticle, Topic, WritingPlan
    _seed(XPost, tweet_id="x1", subscription_id=1, username="alice", content="大模型价格战开打",
          url="https://x.com/1", published_at=_now(), likes=100, reposts=50, is_reply=False)
    _seed(KrArticle, id="k1", feed_type="hot", title="某 AI 公司融资",
          url="https://36kr.com/1", published_at=_now(), stat_read=999)
    _seed(Topic, id="t1", title="选题库里的待写选题", score=4.5)
    _seed(WritingPlan, title="长期写作方案A", strategy="持续追踪 agent 生态")


def test_candidates_unified_shape(env):
    _seed_basics()
    import mcp_server
    res = _run(mcp_server.get_topic_candidates())
    assert {c["source"] for c in res} >= {"x", "kr", "topic_library", "writing_plan"}
    for c in res:
        assert set(c) == {"source", "title", "summary", "url", "heat", "published_at"}
    x = [c for c in res if c["source"] == "x"][0]
    assert x["heat"] == 150  # likes + reposts


def test_candidates_sources_filter(env):
    _seed_basics()
    import mcp_server
    res = _run(mcp_server.get_topic_candidates(sources=["x"]))
    assert res and all(c["source"] == "x" for c in res)


def test_candidates_24h_window(env):
    from models import XPost
    _seed(XPost, tweet_id="old", subscription_id=1, username="bob", content="三天前的旧帖",
          url="https://x.com/old", published_at=_now() - timedelta(days=3),
          likes=9999, reposts=0, is_reply=False)
    import mcp_server
    res = _run(mcp_server.get_topic_candidates(sources=["x"]))
    assert res == []


def test_candidates_limit_per_source(env):
    from models import KrArticle
    for i in range(3):
        _seed(KrArticle, id=f"k{i}", feed_type="hot", title=f"快讯{i}",
              url=f"https://36kr.com/{i}", published_at=_now(), stat_read=i)
    import mcp_server
    res = _run(mcp_server.get_topic_candidates(sources=["kr"], limit_per_source=1))
    assert len(res) == 1
    assert res[0]["title"] == "快讯2"  # 按 stat_read 降序取 top
