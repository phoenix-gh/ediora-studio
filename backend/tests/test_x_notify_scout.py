"""scheduled_x_reply_scout（动态通知）：只推送勾选订阅在开启之后采集的新帖，
每帖带 LLM 回复价值评分与建议，经 hermes send 推 Telegram。"""
import sys
import asyncio
import pytest
from datetime import datetime, timezone, timedelta


@pytest.fixture
def scheduler_env(monkeypatch, tmp_path):
    db_file = tmp_path / "test.db"
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{db_file}")
    monkeypatch.setenv("WMS_DISABLE_SCHEDULER", "1")

    for mod in list(sys.modules):
        if mod.startswith(("database", "models", "main", "routers", "config",
                           "scheduler", "logger", "llm")):
            sys.modules.pop(mod, None)

    # 隔离调度器状态：不让测试读写开发机真实的 .scheduler_state.json
    import scheduler
    monkeypatch.setattr(scheduler, "STATE_FILE", str(tmp_path / "sched_state.json"))
    scheduler._last_ts.clear()
    return scheduler


def test_notify_scout_pushes_only_opted_in_new_posts(scheduler_env, monkeypatch):
    scheduler = scheduler_env
    from database import engine, Base, SessionLocal
    from models import XSubscription, XPost
    import llm

    async def fake_assess(post):
        return {"score": 8, "reason": "有观点", "draft": "建议回复内容"}
    monkeypatch.setattr(llm, "assess_x_reply", fake_assess)

    sent: list[tuple] = []

    class FakeProc:
        returncode = 0

        async def communicate(self):
            return b"", b""

    async def fake_exec(*args, **kwargs):
        sent.append(args)
        return FakeProc()
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    now = datetime.now(timezone.utc)
    enabled_at = now - timedelta(hours=1)

    def _post(tid, sub_id, collected, published=None):
        return XPost(
            tweet_id=tid, subscription_id=sub_id, username="u", display_name="U",
            content=f"内容 {tid}", url=f"https://x.com/u/status/{tid}",
            published_at=published or now, collected_at=collected,
        )

    async def run():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        async with SessionLocal() as db:
            sub_on = XSubscription(
                label="通知源", kind="timeline", url="https://x.com/on",
                enabled=True, notify_new_posts=True, notify_enabled_at=enabled_at,
                added_at=now,
            )
            sub_off = XSubscription(
                label="静默源", kind="timeline", url="https://x.com/off",
                enabled=True, notify_new_posts=False, added_at=now,
            )
            db.add_all([sub_on, sub_off])
            await db.commit()
            await db.refresh(sub_on)
            await db.refresh(sub_off)
            db.add_all([
                # ✓ 勾选订阅、开启后采集 → 推送
                _post("new_on", sub_on.id, collected=now),
                # ✗ 开启前采集的积压帖
                _post("old_on", sub_on.id, collected=enabled_at - timedelta(hours=1)),
                # ✗ 未勾选订阅
                _post("any_off", sub_off.id, collected=now),
                # ✗ 发布超过 48h 窗口
                _post("stale_on", sub_on.id, collected=now,
                      published=now - timedelta(hours=72)),
            ])
            await db.commit()

        await scheduler.scheduled_x_reply_scout()

        async with SessionLocal() as db:
            return {tid: await db.get(XPost, tid)
                    for tid in ("new_on", "old_on", "any_off", "stale_on")}

    posts = asyncio.new_event_loop().run_until_complete(run())

    assert len(sent) == 1
    args = sent[0]
    assert args[1:4] == ("send", "--to", "telegram")
    msg = args[-1]
    assert "new_on" in msg            # 帖子链接
    assert "8/10" in msg              # 是否值得回复的评分
    assert "建议回复内容" in msg       # LLM 回复建议
    assert "通知源" in msg            # 订阅名

    assert posts["new_on"].x_reply_score == 8.0
    assert posts["new_on"].x_reply_draft == "建议回复内容"
    assert posts["new_on"].x_reply_notified_at is not None
    for tid in ("old_on", "any_off", "stale_on"):
        assert posts[tid].x_reply_score is None, tid
        assert posts[tid].x_reply_notified_at is None, tid


def test_notify_scout_noop_when_nothing_opted_in(scheduler_env, monkeypatch):
    """没有勾选动态通知的订阅时，不调 LLM、不发推送。"""
    scheduler = scheduler_env
    from database import engine, Base, SessionLocal
    from models import XSubscription, XPost
    import llm

    calls = {"assess": 0, "send": 0}

    async def fake_assess(post):
        calls["assess"] += 1
        return {"score": 8, "reason": "", "draft": "x"}
    monkeypatch.setattr(llm, "assess_x_reply", fake_assess)

    async def fake_exec(*args, **kwargs):
        calls["send"] += 1
        raise AssertionError("should not spawn hermes")
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    now = datetime.now(timezone.utc)

    async def run():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        async with SessionLocal() as db:
            sub = XSubscription(
                label="普通源", kind="timeline", url="https://x.com/plain",
                enabled=True, notify_new_posts=False, added_at=now,
            )
            db.add(sub)
            await db.commit()
            await db.refresh(sub)
            db.add(XPost(
                tweet_id="t1", subscription_id=sub.id, username="u",
                display_name="U", content="c", url="https://x.com/u/status/t1",
                published_at=now, collected_at=now,
            ))
            await db.commit()
        await scheduler.scheduled_x_reply_scout()

    asyncio.new_event_loop().run_until_complete(run())
    assert calls == {"assess": 0, "send": 0}
