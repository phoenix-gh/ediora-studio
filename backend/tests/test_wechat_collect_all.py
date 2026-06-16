"""Tests for the one-click "collect all accounts" background job and endpoints."""

import sys
import asyncio

import pytest
from fastapi.testclient import TestClient


def _reload_modules():
    for mod in list(sys.modules):
        if mod.startswith(("database", "models", "main", "routers", "config", "scheduler", "logger")):
            sys.modules.pop(mod, None)


@pytest.fixture
def reload_env(monkeypatch, tmp_path):
    """Fresh sqlite DB + reloaded modules, without creating tables — unit tests
    drive the engine inside a single event loop themselves to avoid cross-loop
    binding of the aiosqlite connection."""
    db_file = tmp_path / "test.db"
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{db_file}")
    monkeypatch.setenv("WMS_DISABLE_SCHEDULER", "1")
    _reload_modules()
    yield


@pytest.fixture
def client(monkeypatch, tmp_path):
    """TestClient over a fresh DB with tables created (mirrors the project pattern)."""
    db_file = tmp_path / "test.db"
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{db_file}")
    monkeypatch.setenv("WMS_DISABLE_SCHEDULER", "1")
    _reload_modules()
    from database import engine, Base
    import models  # noqa: F401

    async def _create():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    asyncio.new_event_loop().run_until_complete(_create())
    from main import app
    return TestClient(app)


# ── Helpers ──────────────────────────────────────────────────────────────────

def _run_job(monkeypatch, *, n_accounts=3, with_cred=True, sync=None, delay=10.0):
    """Create tables, seed cred + accounts, then run _run_collect_all — all inside
    one event loop. `sync` overrides _sync_account. Returns (wx module, sleep_calls).

    The credential is seeded with expires_at=None (never-expiring): dev/prod run
    Postgres where DateTime(timezone=True) round-trips as tz-aware, but the sqlite
    used here returns naive datetimes, which would break the aware expiry compare.
    """
    import routers.wechat as wx
    from routers.wechat import SyncResult
    from database import engine, Base, SessionLocal
    from models import WechatCredential, WechatAccount

    sleep_calls: list[float] = []

    async def fake_sleep(s):
        sleep_calls.append(s)
    monkeypatch.setattr(wx.asyncio, "sleep", fake_sleep)

    if sync is None:
        async def sync(db, acc, token, cookie, pages=1, page_size=20):
            return SyncResult(biz=acc.biz, new_articles=2, total_seen=5)
    monkeypatch.setattr(wx, "_sync_account", sync)

    async def scenario():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        async with SessionLocal() as db:
            if with_cred:
                db.add(WechatCredential(id=1, token="t", cookie="c", expires_at=None))
            for i in range(n_accounts):
                db.add(WechatAccount(biz=f"biz{i}", name=f"号{i}", muted=False))
            await db.commit()
        await wx._run_collect_all(delay_seconds=delay)

    asyncio.new_event_loop().run_until_complete(scenario())
    return wx, sleep_calls


# ── _run_collect_all ───────────────────────────────────────────────────────────

def test_run_collect_all_progresses_and_paces(reload_env, monkeypatch):
    wx, sleep_calls = _run_job(monkeypatch, n_accounts=3)
    st = wx._collect_status
    assert st.running is False
    assert st.total == 3
    assert st.done == 3
    assert st.new_articles == 6          # 3 accounts × 2 new each
    assert st.errors == []
    assert st.finished_at is not None
    assert "新增 6 篇" in st.message
    # 10s gap between accounts, but not after the last one
    assert sleep_calls == [10.0, 10.0]


def test_run_collect_all_no_credential(reload_env, monkeypatch):
    called = []

    async def sync(db, acc, token, cookie, pages=1, page_size=20):
        called.append(acc.biz)
        raise AssertionError("should not sync without credential")

    wx, sleep_calls = _run_job(monkeypatch, with_cred=False, sync=sync)
    st = wx._collect_status
    assert st.running is False
    assert called == []
    assert sleep_calls == []
    assert "未登录" in st.message


def test_run_collect_all_account_error_continues(reload_env, monkeypatch):
    from routers.wechat import SyncResult

    async def sync(db, acc, token, cookie, pages=1, page_size=20):
        if acc.biz == "biz1":
            raise RuntimeError("boom")
        return SyncResult(biz=acc.biz, new_articles=1, total_seen=3)

    wx, _ = _run_job(monkeypatch, n_accounts=3, sync=sync)
    st = wx._collect_status
    assert st.done == 3                  # one failed, but the loop kept going
    assert st.new_articles == 2          # the two that succeeded
    assert len(st.errors) == 1
    assert "号1" in st.errors[0]
    assert "1 个失败" in st.message


def test_run_collect_all_stops_on_session_expired(reload_env, monkeypatch):
    from fastapi import HTTPException

    async def sync(db, acc, token, cookie, pages=1, page_size=20):
        raise HTTPException(401, "公众平台登录已过期，请重新扫码")

    wx, _ = _run_job(monkeypatch, n_accounts=3, sync=sync)
    st = wx._collect_status
    assert st.running is False
    assert "重新扫码" in st.message
    assert st.done == 0                  # bailed on the first account


# ── Endpoints ────────────────────────────────────────────────────────────────

def test_collect_endpoint_conflict_when_running(client):
    import routers.wechat as wx
    wx._collect_status.running = True
    try:
        r = client.post("/api/wechat/collect")
        assert r.status_code == 409
    finally:
        wx._collect_status.running = False


def test_collect_endpoint_requires_login(client):
    r = client.post("/api/wechat/collect")
    assert r.status_code == 401


def test_collect_status_endpoint_defaults_idle(client):
    r = client.get("/api/wechat/collect/status")
    assert r.status_code == 200
    body = r.json()
    assert body["running"] is False
    assert body["total"] == 0
