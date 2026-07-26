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
    from models import XPost, KrArticle, WritingPlan
    _seed(XPost, tweet_id="x1", subscription_id=1, username="alice", content="大模型价格战开打",
          url="https://x.com/1", published_at=_now(), likes=100, reposts=50, is_reply=False)
    _seed(KrArticle, id="k1", feed_type="hot", title="某 AI 公司融资",
          url="https://36kr.com/1", published_at=_now(), stat_read=999)
    _seed(WritingPlan, title="长期写作方案A", strategy="持续追踪 agent 生态")


def test_candidates_unified_shape(env):
    _seed_basics()
    import mcp_server
    res = _run(mcp_server.get_topic_candidates())
    assert {c["source"] for c in res} >= {"x", "kr", "writing_plan"}
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


def _seed_plan_and_account():
    from models import DailyPlan, PublishAccount
    from database import SessionLocal
    async def _mk():
        async with SessionLocal() as db:
            db.add(PublishAccount(id="acc1", name="号一"))
            db.add(PublishAccount(id="acc2", name="号二"))
            plan = DailyPlan(plan_date="2026-06-12")
            db.add(plan)
            await db.commit()
            await db.refresh(plan)
            return plan.id
    return _run(_mk())


def _item(**kw):
    base = dict(account_id="acc1", title="选题A", angle="角度", reason="理由",
                content_type="long", sources=[{"platform": "x", "title": "src", "url": "u"}],
                group_key="", is_primary=False)
    base.update(kw)
    return base


def test_save_daily_plan_replaces_and_marks_ready(env):
    plan_id = _seed_plan_and_account()
    import mcp_server
    r1 = _run(mcp_server.save_daily_plan(plan_id, [_item()], note="第一版"))
    assert r1 == {"ok": True, "plan_id": plan_id, "item_count": 1}
    r2 = _run(mcp_server.save_daily_plan(
        plan_id, [_item(title="选题B"), _item(title="选题C", account_id="acc2")], note="第二版"))
    assert r2["item_count"] == 2

    from database import SessionLocal
    from models import DailyPlan, DailyPlanItem
    from sqlalchemy import select
    async def _check():
        async with SessionLocal() as db:
            items = (await db.execute(select(DailyPlanItem))).scalars().all()
            plan = await db.get(DailyPlan, plan_id)
            return [i.title for i in items], plan.status, plan.planner_note, items
    titles, status, note, items = _run(_check())
    assert sorted(titles) == ["选题B", "选题C"]   # 整体替换，没有残留「选题A」
    assert status == "ready"
    assert note == "第二版"
    assert all(i.is_primary for i in items)        # 无组 item 强制主笔


def test_save_daily_plan_validates_account_and_type(env):
    plan_id = _seed_plan_and_account()
    import mcp_server
    assert "error" in _run(mcp_server.save_daily_plan(plan_id, [_item(account_id="ghost")]))
    assert "error" in _run(mcp_server.save_daily_plan(plan_id, [_item(content_type="poem")]))
    assert "error" in _run(mcp_server.save_daily_plan(plan_id, [_item(title="  ")]))
    assert "error" in _run(mcp_server.save_daily_plan(99999, [_item()]))


def test_save_daily_plan_group_constraints(env):
    plan_id = _seed_plan_and_account()
    import mcp_server
    # 同组异体裁 → 拒绝
    r = _run(mcp_server.save_daily_plan(plan_id, [
        _item(group_key="g1", is_primary=True, content_type="long"),
        _item(group_key="g1", account_id="acc2", content_type="short"),
    ]))
    assert "error" in r
    # 同组无主笔 → 拒绝
    r = _run(mcp_server.save_daily_plan(plan_id, [
        _item(group_key="g1"), _item(group_key="g1", account_id="acc2"),
    ]))
    assert "error" in r
    # 合法组 → 通过
    r = _run(mcp_server.save_daily_plan(plan_id, [
        _item(group_key="g1", is_primary=True),
        _item(group_key="g1", account_id="acc2"),
    ]))
    assert r.get("ok") is True


def test_get_recent_outputs(env):
    plan_id = _seed_plan_and_account()
    import mcp_server
    _run(mcp_server.save_daily_plan(plan_id, [_item(title="计划里的标题")]))
    from database import SessionLocal
    from models import ArticleDraft
    async def _draft():
        async with SessionLocal() as db:
            db.add(ArticleDraft(topic_id="t1", title="草稿标题"))
            await db.commit()
    _run(_draft())
    res = _run(mcp_server.get_recent_outputs())
    titles = {r["title"] for r in res}
    assert {"计划里的标题", "草稿标题"} <= titles
    assert all(set(r) == {"type", "title"} for r in res)


def test_candidates_includes_wechat(env):
    from models import WechatArticle
    _seed(WechatArticle, id="w1", biz="b1", account_name="竞品号",
          title="竞品今日文章", digest="摘要", url="https://mp.weixin.qq.com/s/x",
          published_at=_now())
    import mcp_server
    res = _run(mcp_server.get_topic_candidates(sources=["wechat"]))
    assert len(res) == 1
    c = res[0]
    assert c["source"] == "wechat"
    assert c["title"].startswith("[竞品号]")
    assert c["heat"] == 0
    assert set(c) == {"source", "title", "summary", "url", "heat", "published_at"}


def test_candidates_wechat_24h_window(env):
    from models import WechatArticle
    _seed(WechatArticle, id="w_old", biz="b1", account_name="竞品号",
          title="两天前", digest="", url="https://mp.weixin.qq.com/s/old",
          published_at=_now() - timedelta(days=2))
    import mcp_server
    assert _run(mcp_server.get_topic_candidates(sources=["wechat"])) == []
