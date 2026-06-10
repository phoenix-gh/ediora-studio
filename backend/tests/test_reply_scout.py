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


def _seed_parent(db_session, sid="p1", score=90):
    from models import RefMaterial
    from datetime import datetime, timezone
    async def _mk():
        async with db_session() as db:
            m = RefMaterial(platform="x", source_id=sid, text="父帖段子内容好笑极了",
                            text_clean="父帖段子内容好笑极了", score=score, status="active",
                            published_at=datetime.now(timezone.utc))
            db.add(m); await db.commit(); await db.refresh(m)
            db.expunge(m)
            return m
    return asyncio.new_event_loop().run_until_complete(_mk())


def _reply(rid, parent_id, *, text="这条神回复实在太有梗了哈哈", likes=500, author="rep"):
    return {
        "id": rid, "text": text, "author": author, "author_name": "Rep",
        "in_reply_to_status_id": parent_id, "likes": likes, "retweets": 3,
        "replies": 1, "views": "12000", "created_at": "Wed Oct 10 20:19:24 +0000 2018",
        "possibly_sensitive": False, "images": [],
    }


def test_clean_reply_text_strips_leading_mentions():
    from reply_scout import clean_reply_text
    assert clean_reply_text("@a @b 这条回复剥掉前缀后还很长很有梗") == "这条回复剥掉前缀后还很长很有梗"
    assert clean_reply_text("@a @b 短") is None          # 剥后过短
    assert clean_reply_text("看链接 https://t.co/x 哈哈哈哈") is None   # 含 URL
    assert clean_reply_text("") is None


def test_filter_replies_excludes_parent_and_nonreplies():
    from reply_scout import filter_replies
    tweets = [
        {"id": "p1", "text": "父帖自己", "in_reply_to_status_id": ""},
        _reply("r1", "p1"),
        _reply("r2", "other"),          # 回复别的帖
        {"id": "r3", "text": "无关推文", "in_reply_to_status_id": ""},
    ]
    out = filter_replies(tweets, "p1")
    assert [t["id"] for t in out] == ["r1"]


def _run_scout(db_session, tweets_by_parent, cookies=None):
    import reply_scout
    async def _go():
        async with db_session() as db:
            with patch.object(reply_scout, "_load_cookies",
                              return_value=cookies if cookies is not None else {"auth_token": "a", "ct0": "c"}), \
                 patch.object(reply_scout, "_fetch_thread_tweets",
                              side_effect=lambda tid, ck: tweets_by_parent.get(tid)):
                return await reply_scout.scout_replies(db)
    return asyncio.new_event_loop().run_until_complete(_go())


def _materials(db_session):
    from models import RefMaterial
    async def _q():
        async with db_session() as db:
            return list((await db.execute(select(RefMaterial))).scalars().all())
    return asyncio.new_event_loop().run_until_complete(_q())


def test_scout_inserts_top_replies_with_parent_mark(db_session):
    _seed_parent(db_session, "p1", score=90)
    replies = [
        _reply("r1", "p1", likes=900, text="最高赞神回复必须有足够长度"),
        _reply("r2", "p1", likes=500, text="第二高赞神回复也挺好笑的呀"),
        _reply("r3", "p1", likes=300, text="第三条神回复勉强够格入库了"),
        _reply("r4", "p1", likes=200, text="第四条不该入库因为只取前三"),
        _reply("r5", "p1", likes=50, text="低于点赞门槛的回复不该入库"),
    ]
    r = _run_scout(db_session, {"p1": [{"id": "p1", "text": "父帖", "in_reply_to_status_id": ""}] + replies})
    assert r["scouted"] == 1 and r["new_replies"] == 3
    mats = _materials(db_session)
    reply_mats = [m for m in mats if m.parent_source_id == "p1"]
    assert sorted(m.source_id for m in reply_mats) == ["r1", "r2", "r3"]
    assert all(m.status == "active" and m.score > 0 for m in reply_mats)


def test_scout_skips_when_no_cookies(db_session):
    _seed_parent(db_session, "p1", score=90)
    r = _run_scout(db_session, {}, cookies={})
    assert r == {"scouted": 0, "new_replies": 0}


def test_scout_respects_seen_ledger(db_session):
    _seed_parent(db_session, "p1", score=90)
    payload = {"p1": [_reply("r1", "p1", likes=900, text="最高赞神回复必须有足够长度")]}
    r1 = _run_scout(db_session, payload)
    r2 = _run_scout(db_session, payload)   # 第二轮：父帖已 scouted
    assert r1["scouted"] == 1
    assert r2["scouted"] == 0 and r2["new_replies"] == 0


def test_scout_ignores_low_score_parents(db_session):
    _seed_parent(db_session, "p1", score=30)   # 低于 ref_reply_scout_threshold 70
    r = _run_scout(db_session, {"p1": [_reply("r1", "p1", likes=900)]})
    assert r["scouted"] == 0


def test_scout_fetch_failure_not_marked_scouted(db_session):
    _seed_parent(db_session, "p1", score=90)
    r1 = _run_scout(db_session, {"p1": None})   # fetch 失败
    assert r1["scouted"] == 0
    # 下一轮成功 → 仍可抓
    r2 = _run_scout(db_session, {"p1": [_reply("r1", "p1", likes=900, text="最高赞神回复必须有足够长度")]})
    assert r2["scouted"] == 1 and r2["new_replies"] == 1
