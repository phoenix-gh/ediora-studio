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


# ── 提醒规则 ────────────────────────────────────────────────────────────────

def test_wechat_cred_expired_alert(client):
    from models import WechatCredential, WechatAccount

    async def seed(db):
        db.add(WechatAccount(biz="b1", name="测试号"))
        db.add(WechatCredential(id=1, token="t", cookie="c",
                                expires_at=_now() - timedelta(hours=1)))
    _run_db(seed)

    body = _get(client)
    hits = [a for a in body["alerts"] if "已过期" in a["text"]]
    assert len(hits) == 1
    assert hits[0]["severity"] == "warn"
    assert hits[0]["href"] == "/wechat"


def test_wechat_not_refreshed_today_alert(client):
    """凭证有效但今天没采到公众号文章 ⇒ info 提醒。"""
    from models import WechatCredential, WechatAccount, WechatArticle
    start = _today_start()

    async def seed(db):
        db.add(WechatAccount(biz="b1", name="测试号"))
        db.add(WechatCredential(id=1, token="t", cookie="c",
                                expires_at=_now() + timedelta(days=1)))
        db.add(WechatArticle(id="w1", biz="b1", published_at=start,
                             collected_at=start - timedelta(hours=2)))  # 昨天采的
    _run_db(seed)

    body = _get(client)
    assert any("尚未刷新" in a["text"] for a in body["alerts"])


def test_wechat_refreshed_today_no_alert(client):
    from models import WechatCredential, WechatAccount, WechatArticle

    async def seed(db):
        db.add(WechatAccount(biz="b1", name="测试号"))
        db.add(WechatCredential(id=1, token="t", cookie="c",
                                expires_at=_now() + timedelta(days=1)))
        db.add(WechatArticle(id="w1", biz="b1", published_at=_now(), collected_at=_now()))
    _run_db(seed)

    body = _get(client)
    assert not any("尚未刷新" in a["text"] or "已过期" in a["text"] for a in body["alerts"])


def test_wechat_no_accounts_no_nag(client):
    """没订阅任何公众号 ⇒ 即使没凭证也不提醒（全新安装不烦人）。"""
    body = _get(client)
    assert not any("公众" in a["text"] for a in body["alerts"])


def test_stale_scheduler_alert_and_floor(client):
    """reddit 超过 2× 间隔 ⇒ 告警；github 间隔 1 分钟但有 30 分钟保底 ⇒ 不告警。"""
    from models import CollectLog

    async def seed(db):
        a = CollectLog(job="reddit", status="ok", message="x", detail="")
        a.created_at = _now() - timedelta(hours=10)   # 间隔 60min，阈值 2h
        db.add(a)
        b = CollectLog(job="github", status="ok", message="x", detail="")
        b.created_at = _now() - timedelta(minutes=20)  # 阈值 max(2min, 30min)=30min
        db.add(b)
    _run_db(seed)

    body = _get(client)
    stale = [a for a in body["alerts"] if "未运行" in a["text"]]
    assert len(stale) == 1
    assert "Reddit" in stale[0]["text"]


def test_publish_account_missing_creds_alert(client):
    from models import PublishAccount

    async def seed(db):
        db.add(PublishAccount(id="a", name="缺密钥号", platform="wechat",
                              app_id="", app_secret=""))
        db.add(PublishAccount(id="b", name="完整号", platform="wechat",
                              app_id="wx1", app_secret="s1"))
    _run_db(seed)

    body = _get(client)
    hits = [a for a in body["alerts"] if "发布凭证" in a["text"]]
    assert len(hits) == 1
    assert "缺密钥号" in hits[0]["text"]
    assert "完整号" not in hits[0]["text"]


def test_alerts_sorted_by_severity(client):
    """error 排最前。"""
    from models import CollectLog, PublishAccount

    async def seed(db):
        db.add(PublishAccount(id="a", name="缺密钥号", platform="wechat"))
        db.add(CollectLog(job="reddit", status="error", message="boom", detail=""))
    _run_db(seed)

    body = _get(client)
    sevs = [a["severity"] for a in body["alerts"]]
    assert sevs == sorted(sevs, key={"error": 0, "warn": 1, "info": 2}.get)
    assert sevs[0] == "error"


# ── 今日 Release / 今日产出 / 异常隔离 ──────────────────────────────────────

def test_releases_today_with_draft_link(client):
    from models import GithubRelease, ArticleDraft
    start = _today_start()

    async def seed(db):
        db.add(GithubRelease(id="o/r:v1.0.0", repo_id="o/r", tag_name="v1.0.0",
                             name="Release v1", published_at=start + timedelta(hours=1)))
        db.add(GithubRelease(id="o/r:v0.9.0", repo_id="o/r", tag_name="v0.9.0",
                             name="老版本", published_at=start - timedelta(hours=1)))
        db.add(ArticleDraft(topic_id="release:o/r:v1.0.0", title="[tech] o/r v1.0.0"))
    _run_db(seed)

    body = _get(client)
    rels = body["releases_today"]
    assert len(rels) == 1
    assert rels[0]["tag_name"] == "v1.0.0"
    assert len(rels[0]["draft_ids"]) == 1


def test_release_today_without_draft(client):
    from models import GithubRelease
    start = _today_start()

    async def seed(db):
        db.add(GithubRelease(id="o/r:v2.0.0", repo_id="o/r", tag_name="v2.0.0",
                             name="", is_prerelease=True,
                             published_at=start + timedelta(minutes=5)))
    _run_db(seed)

    body = _get(client)
    rels = body["releases_today"]
    assert rels[0]["draft_ids"] == []
    assert rels[0]["is_prerelease"] is True
    assert rels[0]["name"] == "v2.0.0"  # name 空时回退 tag


def test_today_output_counts(client):
    from models import Topic, ArticleDraft

    async def seed(db):
        db.add(Topic(id="t1", title="今天的选题"))
        db.add(ArticleDraft(topic_id="t1", title="今天的草稿"))
    _run_db(seed)

    body = _get(client)
    assert body["today_output"] == {"topics": 1, "drafts": 1}


def test_partial_failure_isolation(client, monkeypatch):
    """某区块炸了：端点仍 200，errors 记录，其余区块照常。"""
    import routers.dashboard as dash

    async def boom(*args, **kwargs):
        raise RuntimeError("固定炸点")
    monkeypatch.setattr(dash, "_build_releases", boom)

    body = _get(client)
    assert any(e.startswith("releases:") for e in body["errors"])
    assert len(body["sources"]) == 13
