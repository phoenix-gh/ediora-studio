"""Dashboard overview endpoint tests."""
import sys
import time
import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch, tmp_path):
    db_file = tmp_path / "test.db"
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{db_file}")
    monkeypatch.setenv("WMS_DISABLE_SCHEDULER", "1")

    for mod in list(sys.modules):
        if mod.startswith(("database", "models", "main", "routers", "config", "scheduler", "logger")):
            sys.modules.pop(mod, None)

    from database import engine, Base
    import models  # noqa: F401

    async def _create():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    asyncio.new_event_loop().run_until_complete(_create())

    from main import app

    # 隔离调度器状态：不让测试读到开发机真实的 .scheduler_state.json
    import scheduler
    monkeypatch.setattr(scheduler, "STATE_FILE", str(tmp_path / "sched_state.json"))
    scheduler._last_ts.clear()

    return TestClient(app)


def _run_db(fn):
    """Seed helper — run an async fn(db) inside a fresh session and commit."""
    from database import SessionLocal

    async def go():
        async with SessionLocal() as db:
            await fn(db)
            await db.commit()
    asyncio.new_event_loop().run_until_complete(go())


def _now():
    return datetime.now(timezone.utc)


def _today_start():
    from routers.dashboard import _today_start_utc
    return _today_start_utc()


def _get(client):
    r = client.get("/api/dashboard/overview")
    assert r.status_code == 200, r.text
    return r.json()


def _source(body, key):
    return next(s for s in body["sources"] if s["key"] == key)


# ── 状态网格 ────────────────────────────────────────────────────────────────

def test_overview_empty_db(client):
    body = _get(client)
    assert body["errors"] == []
    assert len(body["sources"]) == 13
    for s in body["sources"]:
        assert s["today_new"] == 0
        assert s["last_status"] is None
        assert s["last_run_at"] is None
    assert body["alerts"] == []
    assert body["releases_today"] == []
    assert body["today_output"] == {"topics": 0, "drafts": 0}


def test_today_boundary_counts(client):
    """UTC+8 今天 0 点前 1 秒不算，后 1 秒算。"""
    from models import XPost
    start = _today_start()

    async def seed(db):
        db.add(XPost(tweet_id="t1", subscription_id=1, username="a",
                     published_at=start, collected_at=start - timedelta(seconds=1)))
        db.add(XPost(tweet_id="t2", subscription_id=1, username="a",
                     published_at=start, collected_at=start + timedelta(seconds=1)))
    _run_db(seed)

    body = _get(client)
    assert _source(body, "x")["today_new"] == 1


def test_latest_log_wins_and_error_alert(client):
    """同 job 取最新日志；最新是 error 时产出 error 提醒。"""
    from models import CollectLog

    async def seed(db):
        db.add(CollectLog(job="x", status="ok", message="老的", detail=""))
        db.add(CollectLog(job="x", status="error", message="feedgrab 超时", detail=""))
    _run_db(seed)

    body = _get(client)
    src = _source(body, "x")
    assert src["last_status"] == "error"
    assert "feedgrab 超时" in src["last_message"]
    errs = [a for a in body["alerts"] if a["severity"] == "error"]
    assert len(errs) == 1
    assert "X" in errs[0]["text"] and "feedgrab 超时" in errs[0]["text"]


def test_silent_success_from_scheduler_state(client):
    """scheduler state 比最新日志新 ⇒ 静默成功，状态 ok。"""
    from models import CollectLog

    async def seed(db):
        old = CollectLog(job="v2ex", status="warn", message="旧警告", detail="")
        old.created_at = _now() - timedelta(hours=2)
        db.add(old)
    _run_db(seed)

    import scheduler
    scheduler._last_ts["v2ex"] = time.time() - 60

    body = _get(client)
    src = _source(body, "v2ex")
    assert src["last_status"] == "ok"
    assert "运行正常" in src["last_message"]
    # 提醒区不应有 v2ex 的告警
    assert not any("V2EX" in a["text"] for a in body["alerts"])


def test_manual_source_last_run_from_table(client):
    """手动源（producthunt）：最近运行时间取内容表最新 collected_at。"""
    from models import ProductHuntPost
    ts = _now() - timedelta(hours=3)

    async def seed(db):
        db.add(ProductHuntPost(id="p1", title="X", published_at=ts, collected_at=ts))
    _run_db(seed)

    body = _get(client)
    src = _source(body, "producthunt")
    assert src["schedule"] == "手动"
    assert src["last_status"] == "ok"
    assert src["last_run_at"] is not None
    assert src["today_new"] in (0, 1)  # 取决于跑测试的时刻是否同一天，不强断言
