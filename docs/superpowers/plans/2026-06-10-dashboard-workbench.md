# 工作台 Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 首页「今日工作台」加四个区块：提醒区、今日 GitHub 新发布（可写文章）、采集状态网格、今日产出小结。

**Architecture:** 后端一个只读聚合端点 `GET /api/dashboard/overview`（新 `routers/dashboard.py`），数据来自 `collect_logs` + 各内容表 + `.scheduler_state.json` + `wechat_credentials` + `publish_accounts`，无表结构变更。前端 server component 一次取数，三个新展示组件 + 一个 client 按钮。

**Tech Stack:** FastAPI + SQLAlchemy async（既有）、Next.js App Router + shadcn 风格 tailwind + sonner（既有）。测试跑法：`conda run -n wems python -m pytest backend/tests/test_dashboard.py -v`（Bash 先 `source ~/.zshrc`）。

**Spec:** `docs/superpowers/specs/2026-06-10-dashboard-workbench-design.md`

**对 spec 的两处已拍板偏差：**
1. 提醒规则 1（未登录公众平台）加了"存在未静音 WechatAccount"前置条件——没订阅任何公众号的全新安装不该被烦。
2. 手动源（producthunt/youtube）有历史数据时状态点显示绿色、message "手动采集"。

---

## Task 1: 后端测试先行 — 状态网格核心

**Files:**
- Test: `backend/tests/test_dashboard.py`（新建）

- [x] **Step 1.1: 写测试文件（fixture 抄 test_reddit_router.py 模式 + seed 工具 + 前 4 个测试）**

```python
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
```

- [x] **Step 1.2: 跑测试确认全部 import 失败（router 不存在）**

Run: `source ~/.zshrc && conda run -n wems python -m pytest backend/tests/test_dashboard.py -v 2>&1 | tail -5`
Expected: FAIL/ERROR — `ModuleNotFoundError: No module named 'routers.dashboard'`（在 `_today_start` 引用处）；`test_overview_empty_db` 404。

---

## Task 2: 后端实现 — routers/dashboard.py 状态网格 + 挂载

**Files:**
- Create: `backend/routers/dashboard.py`
- Modify: `backend/main.py:13`（import 行）、`backend/main.py:82` 后（挂载行）

- [x] **Step 2.1: 写 `backend/routers/dashboard.py`（本任务先到 sources / errors / 占位 alerts，releases/today_output 返回空）**

```python
"""Dashboard aggregation — read-only overview for the 今日工作台 home page.

数据源：collect_logs（每个 job 最新一条）、backend/.scheduler_state.json（静默成功
的任务靠它拿真实 last-run）、各内容表（今日新增 count）、wechat_credentials、
publish_accounts。无写操作。
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import (
    ArticleDraft, CollectLog, GithubIssue, GithubRelease, JuejinArticle,
    KrArticle, Paper, Post, ProductHuntPost, PublishAccount, RedditPost,
    RefMaterial, Topic, V2exTopic, WechatAccount, WechatArticle,
    WechatCredential, XPost, YoutubeVideo,
)

router = APIRouter(prefix="/dashboard", tags=["dashboard"])

CN_TZ = timezone(timedelta(hours=8))

# (key, 名称, scheduler-state key, 页面路径, (配置键, 默认值, 单位))；interval None ⇒ 手动源。
# key 必须等于该任务写 collect_logs 用的 job 名（见 scheduler.py / logger.log 调用）。
SOURCES: list[tuple] = [
    ("collect",     "订阅账号",     None,          "/settings",     ("collect_interval_minutes", 15, "min")),
    ("analyze",     "选题分析",     None,          "/trend-topics", ("collect_interval_minutes", 15, "min")),
    ("github",      "GitHub",      None,          "/github",       ("github_interval_minutes", 1, "min")),
    ("x",           "X",           "x_collect",   "/x",            ("x_collect_interval_minutes", 15, "min")),
    ("wechat",      "公众号",       "wechat",      "/wechat",       ("wechat_collect_interval_minutes", 60, "min")),
    ("reddit",      "Reddit",      "reddit",      "/reddit",       ("reddit_collect_interval_minutes", 60, "min")),
    ("juejin",      "掘金",         "juejin",      "/juejin",       ("juejin_collect_interval_minutes", 30, "min")),
    ("36kr",        "36 氪",        "kr",          "/kr",           ("kr_collect_interval_minutes", 30, "min")),
    ("v2ex",        "V2EX",        "v2ex",        "/v2ex",         ("v2ex_collect_interval_minutes", 30, "min")),
    ("papers",      "论文",         "papers",      "/papers",       ("arxiv_collect_interval_hours", 6, "hour")),
    ("materials",   "参考文案",     "ref_collect", "/materials",    ("ref_collect_interval_minutes", 15, "min")),
    ("producthunt", "Product Hunt", None,         "/producthunt",  None),
    ("youtube",     "YouTube",     None,          "/youtube",      None),
]

# 今日新增 count 用的 (模型, 时间列)；analyze/materials 没有 collected_at 用 created_at
_TODAY_TABLES = {
    "collect":     [(Post, Post.collected_at)],
    "analyze":     [(Topic, Topic.created_at)],
    "github":      [(GithubRelease, GithubRelease.collected_at), (GithubIssue, GithubIssue.collected_at)],
    "x":           [(XPost, XPost.collected_at)],
    "wechat":      [(WechatArticle, WechatArticle.collected_at)],
    "reddit":      [(RedditPost, RedditPost.collected_at)],
    "juejin":      [(JuejinArticle, JuejinArticle.collected_at)],
    "36kr":        [(KrArticle, KrArticle.collected_at)],
    "v2ex":        [(V2exTopic, V2exTopic.collected_at)],
    "papers":      [(Paper, Paper.collected_at)],
    "materials":   [(RefMaterial, RefMaterial.created_at)],
    "producthunt": [(ProductHuntPost, ProductHuntPost.collected_at)],
    "youtube":     [(YoutubeVideo, YoutubeVideo.collected_at)],
}


# ── Schemas ────────────────────────────────────────────────────────────────────

class Alert(BaseModel):
    severity: str          # error | warn | info
    text: str
    action_label: str = ""
    href: str = ""


class ReleaseToday(BaseModel):
    repo_id: str
    tag_name: str
    name: str
    published_at: datetime
    is_prerelease: bool
    html_url: str
    draft_ids: list[int]


class SourceStatus(BaseModel):
    key: str
    name: str
    href: str
    schedule: str                  # "15 分钟" / "6 小时" / "手动"
    last_status: str | None        # ok | warn | error | None(无记录)
    last_message: str
    last_run_at: datetime | None
    today_new: int


class TodayOutput(BaseModel):
    topics: int
    drafts: int


class Overview(BaseModel):
    alerts: list[Alert]
    releases_today: list[ReleaseToday]
    sources: list[SourceStatus]
    today_output: TodayOutput
    errors: list[str]
    generated_at: datetime


# ── Helpers ────────────────────────────────────────────────────────────────────

def _today_start_utc(now: datetime | None = None) -> datetime:
    """Asia/Shanghai 当天 0 点，转 UTC。"""
    now_cn = (now or datetime.now(timezone.utc)).astimezone(CN_TZ)
    return now_cn.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc)


def _as_utc(dt: datetime | None) -> datetime | None:
    """sqlite 取回的是 naive UTC；PG 是 aware。统一成 aware UTC。"""
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _scheduler_state() -> dict[str, float]:
    """优先读进程内 scheduler._last_ts（最准），为空再读持久化文件。"""
    import scheduler
    if scheduler._last_ts:
        return dict(scheduler._last_ts)
    try:
        with open(scheduler.STATE_FILE) as f:
            data = json.load(f)
        return {k: float(v) for k, v in data.items()} if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError, ValueError):
        return {}


async def _latest_logs(db: AsyncSession) -> dict[str, CollectLog]:
    """每个 job 的最新一条日志。表上限 500 行，全取内存分组。"""
    rows = (await db.execute(
        select(CollectLog).order_by(CollectLog.id.desc()).limit(500)
    )).scalars().all()
    latest: dict[str, CollectLog] = {}
    for r in rows:
        if r.job not in latest:
            latest[r.job] = r
    return latest


def _interval_seconds(cfg: dict, interval: tuple) -> int:
    cfg_key, default, unit = interval
    val = max(1, int(cfg.get(cfg_key, default)))
    return val * 3600 if unit == "hour" else val * 60


def _schedule_label(cfg: dict, interval: tuple) -> str:
    cfg_key, default, unit = interval
    val = max(1, int(cfg.get(cfg_key, default)))
    return f"{val} 小时" if unit == "hour" else f"{val} 分钟"


async def _build_sources(
    db: AsyncSession, cfg: dict, latest: dict[str, CollectLog],
    state: dict[str, float], today_start: datetime,
) -> list[SourceStatus]:
    out: list[SourceStatus] = []
    for key, name, state_key, href, interval in SOURCES:
        log = latest.get(key)
        log_at = _as_utc(log.created_at) if log else None
        state_at = (datetime.fromtimestamp(state[state_key], tz=timezone.utc)
                    if state_key and state_key in state else None)
        last_run = max((t for t in (log_at, state_at) if t is not None), default=None)
        status = log.status if log else None
        message = log.message if log else ""
        # 无新增且无错的运行不写日志 —— state 比日志新视为静默成功
        if state_at and (log_at is None or state_at > log_at + timedelta(seconds=60)):
            status, message = "ok", "运行正常（最近无新增）"

        today_new = 0
        for model, col in _TODAY_TABLES[key]:
            today_new += (await db.execute(
                select(func.count()).select_from(model).where(col >= today_start)
            )).scalar_one()

        if interval is None:
            model, col = _TODAY_TABLES[key][0]
            last_item = (await db.execute(select(func.max(col)))).scalar_one_or_none()
            last_run = _as_utc(last_item)
            schedule = "手动"
            if status is None and last_run is not None:
                status, message = "ok", "手动采集"
        else:
            schedule = _schedule_label(cfg, interval)

        out.append(SourceStatus(
            key=key, name=name, href=href, schedule=schedule,
            last_status=status, last_message=message,
            last_run_at=last_run, today_new=today_new,
        ))
    return out


# ── Endpoint ───────────────────────────────────────────────────────────────────

@router.get("/overview", response_model=Overview)
async def get_overview(db: AsyncSession = Depends(get_db)):
    from config import get_config

    now = datetime.now(timezone.utc)
    today_start = _today_start_utc(now)
    errors: list[str] = []

    try:
        cfg = await get_config()
    except Exception as e:
        cfg = {}
        errors.append(f"config: {e}")

    try:
        latest = await _latest_logs(db)
    except Exception as e:
        latest = {}
        errors.append(f"logs: {e}")

    try:
        sources = await _build_sources(db, cfg, latest, _scheduler_state(), today_start)
    except Exception as e:
        sources = []
        errors.append(f"sources: {e}")

    alerts: list[Alert] = []      # Task 4
    releases: list[ReleaseToday] = []   # Task 6
    today_output = TodayOutput(topics=0, drafts=0)  # Task 6

    return Overview(alerts=alerts, releases_today=releases, sources=sources,
                    today_output=today_output, errors=errors, generated_at=now)
```

- [x] **Step 2.2: 挂载到 main.py**

`backend/main.py:13` 的 import 行末尾追加 `, dashboard`：

```python
from routers import accounts, collect, settings, github, x, papers, personas, upload, drafts, writing_plans, synthesize, youtube, producthunt, wechat, v2ex, kr, juejin, studio, publish_accounts, profiles, reddit, topic_generator, retro, materials, skills, dashboard
```

`main.py:82`（`skills.router` 那行）后加：

```python
app.include_router(dashboard.router, prefix="/api")
```

- [x] **Step 2.3: 跑 Task 1 测试**

Run: `source ~/.zshrc && conda run -n wems python -m pytest backend/tests/test_dashboard.py -v 2>&1 | tail -10`
Expected: `test_overview_empty_db`、`test_today_boundary_counts`、`test_silent_success_from_scheduler_state`、`test_manual_source_last_run_from_table` PASS；`test_latest_log_wins_and_error_alert` FAIL（alerts 还是空——断言 error 提醒那两行失败）。

- [x] **Step 2.4: 提交**

```bash
git add backend/routers/dashboard.py backend/main.py backend/tests/test_dashboard.py
git commit -m "feat(dashboard): overview 端点——采集状态网格（日志+调度状态合并、今日口径 UTC+8）"
```

---

## Task 3: 后端测试 — 提醒规则

**Files:**
- Modify: `backend/tests/test_dashboard.py`（追加）

- [x] **Step 3.1: 追加提醒规则测试**

```python
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
```

- [x] **Step 3.2: 跑测试确认新增用例失败**

Run: `source ~/.zshrc && conda run -n wems python -m pytest backend/tests/test_dashboard.py -v 2>&1 | tail -12`
Expected: Task 1 的旧用例 PASS（除 error_alert）；新增的提醒用例 FAIL（alerts 恒为空）。`test_wechat_no_accounts_no_nag` 此时会"假绿"——没关系，实现后它防回归。

---

## Task 4: 后端实现 — 提醒规则

**Files:**
- Modify: `backend/routers/dashboard.py`

- [x] **Step 4.1: 在 `_build_sources` 之后加 `_build_alerts`**

```python
_SEVERITY_ORDER = {"error": 0, "warn": 1, "info": 2}


async def _build_alerts(
    db: AsyncSession, cfg: dict, latest: dict[str, CollectLog],
    sources: list[SourceStatus], now: datetime, today_start: datetime,
) -> list[Alert]:
    alerts: list[Alert] = []
    names = {s[0]: s[1] for s in SOURCES}

    # 1+2. 公众平台凭证 / 今日未刷新 —— 仅当订阅了公众号才提醒
    has_accounts = (await db.execute(
        select(func.count()).select_from(WechatAccount).where(WechatAccount.muted.is_(False))
    )).scalar_one() > 0
    if has_accounts:
        cred = await db.get(WechatCredential, 1)
        if not cred or not cred.token or not cred.cookie:
            alerts.append(Alert(severity="info", text="未登录公众平台，公众号内容不会自动采集",
                                action_label="去扫码", href="/wechat"))
        elif cred.expires_at and _as_utc(cred.expires_at) <= now:
            alerts.append(Alert(severity="warn",
                                text="公众平台登录已过期，公众号内容今天没有刷新——去重新扫码",
                                action_label="去扫码", href="/wechat"))
        else:
            last_art = (await db.execute(
                select(func.max(WechatArticle.collected_at))
            )).scalar_one_or_none()
            if last_art is None or _as_utc(last_art) < today_start:
                alerts.append(Alert(severity="info", text="今日公众号内容尚未刷新",
                                    action_label="去看看", href="/wechat"))

    # 3. 任一 job 最新日志是 error（含 x_reply 等非内容源 job）
    for job, log in latest.items():
        if log.status == "error":
            alerts.append(Alert(severity="error",
                                text=f"「{names.get(job, job)}」采集最近一次运行失败：{log.message}",
                                action_label="查看日志", href="/settings"))

    # 4. 调度停摆：超过 max(2×间隔, 30 分钟) 没动静（手动源/从未运行的不报）
    for src, spec in zip(sources, SOURCES):
        interval = spec[4]
        if interval is None or src.last_run_at is None:
            continue
        threshold = max(2 * _interval_seconds(cfg, interval), 1800)
        overdue = (now - _as_utc(src.last_run_at)).total_seconds()
        if overdue > threshold:
            alerts.append(Alert(severity="warn",
                                text=f"「{src.name}」已 {int(overdue // 60)} 分钟未运行，调度可能停了",
                                action_label="查看日志", href="/settings"))

    # 5. 公众号发布凭证缺失
    rows = (await db.execute(
        select(PublishAccount).where(PublishAccount.is_active.is_(True),
                                     PublishAccount.platform == "wechat")
    )).scalars().all()
    missing = [a.name for a in rows if not a.app_id or not a.app_secret]
    if missing:
        alerts.append(Alert(severity="info",
                            text="公众号发布凭证未配置，无法推送草稿箱：" + "、".join(missing),
                            action_label="去配置", href="/settings"))

    alerts.sort(key=lambda a: _SEVERITY_ORDER.get(a.severity, 9))
    return alerts
```

- [x] **Step 4.2: 端点里替换占位**

`get_overview` 中 `alerts: list[Alert] = []      # Task 4` 一行替换为：

```python
    try:
        alerts = await _build_alerts(db, cfg, latest, sources, now, today_start)
    except Exception as e:
        alerts = []
        errors.append(f"alerts: {e}")
```

- [x] **Step 4.3: 跑测试**

Run: `source ~/.zshrc && conda run -n wems python -m pytest backend/tests/test_dashboard.py -v 2>&1 | tail -15`
Expected: 全部 PASS（含 Task 1 的 `test_latest_log_wins_and_error_alert`）。
注意 `test_stale_scheduler_alert_and_floor`：reddit 的 error/stale 都基于同一条日志——该用例日志 status 是 ok，只该出 stale 一条。

- [x] **Step 4.4: 提交**

```bash
git add backend/routers/dashboard.py backend/tests/test_dashboard.py
git commit -m "feat(dashboard): 提醒规则——公众号凭证/今日未刷新/采集失败/调度停摆/发布凭证"
```

---

## Task 5: 后端测试 — 今日 Release + 今日产出 + 异常隔离

**Files:**
- Modify: `backend/tests/test_dashboard.py`（追加）

- [x] **Step 5.1: 追加测试**

```python
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
```

- [x] **Step 5.2: 跑测试确认失败**

Run: `source ~/.zshrc && conda run -n wems python -m pytest backend/tests/test_dashboard.py -v 2>&1 | tail -8`
Expected: 新增 4 个用例 FAIL（releases/today_output 恒空、`_build_releases` 不存在 → monkeypatch AttributeError）。

---

## Task 6: 后端实现 — 今日 Release + 今日产出

**Files:**
- Modify: `backend/routers/dashboard.py`

- [x] **Step 6.1: 加 `_build_releases`（放 `_build_alerts` 后）**

```python
async def _build_releases(db: AsyncSession, today_start: datetime) -> list[ReleaseToday]:
    rels = (await db.execute(
        select(GithubRelease)
        .where(GithubRelease.published_at >= today_start)
        .order_by(GithubRelease.published_at.desc())
        .limit(20)
    )).scalars().all()
    if not rels:
        return []
    topic_ids = [f"release:{r.repo_id}:{r.tag_name}" for r in rels]
    drafts = (await db.execute(
        select(ArticleDraft.id, ArticleDraft.topic_id)
        .where(ArticleDraft.topic_id.in_(topic_ids))
    )).all()
    by_topic: dict[str, list[int]] = {}
    for did, tid in drafts:
        by_topic.setdefault(tid, []).append(did)
    return [ReleaseToday(
        repo_id=r.repo_id, tag_name=r.tag_name, name=r.name or r.tag_name,
        published_at=_as_utc(r.published_at), is_prerelease=r.is_prerelease,
        html_url=r.html_url,
        draft_ids=sorted(by_topic.get(f"release:{r.repo_id}:{r.tag_name}", [])),
    ) for r in rels]
```

- [x] **Step 6.2: 端点里替换两处占位**

```python
    try:
        releases = await _build_releases(db, today_start)
    except Exception as e:
        releases = []
        errors.append(f"releases: {e}")

    try:
        today_output = TodayOutput(
            topics=(await db.execute(
                select(func.count()).select_from(Topic).where(Topic.created_at >= today_start)
            )).scalar_one(),
            drafts=(await db.execute(
                select(func.count()).select_from(ArticleDraft).where(ArticleDraft.created_at >= today_start)
            )).scalar_one(),
        )
    except Exception as e:
        today_output = TodayOutput(topics=0, drafts=0)
        errors.append(f"output: {e}")
```

- [x] **Step 6.3: 跑全文件测试**

Run: `source ~/.zshrc && conda run -n wems python -m pytest backend/tests/test_dashboard.py -v 2>&1 | tail -6`
Expected: 全部 PASS（约 16 个用例）。

- [x] **Step 6.4: 后端回归（注意 main HEAD 有 9 个 writing_plans 既存失败，与本功能无关）**

Run: `source ~/.zshrc && conda run -n wems python -m pytest backend/tests/ -q 2>&1 | tail -5`
Expected: 除既存 9 个 writing_plans 失败外全绿。

- [x] **Step 6.5: 提交**

```bash
git add backend/routers/dashboard.py backend/tests/test_dashboard.py
git commit -m "feat(dashboard): 今日 Release（关联草稿）+ 今日产出统计"
```

---

## Task 7: 前端 — API 封装 + 三个组件

**Files:**
- Create: `web/lib/api/dashboard.ts`
- Create: `web/components/features/dashboard/AlertsBar.tsx`
- Create: `web/components/features/dashboard/SourceStatusGrid.tsx`
- Create: `web/components/features/dashboard/ReleasesToday.tsx`
- Create: `web/components/features/dashboard/GenerateDraftButton.tsx`

- [x] **Step 7.0: 按 AGENTS.md 要求先读本仓库 Next.js 文档**

`ls web/node_modules/next/dist/docs/`，读 server/client components 与 app router 相关篇目（重点确认：server component 取数写法、`'use client'` 边界、`useRouter`/`router.refresh()` 是否仍来自 `next/navigation`）。与下面代码冲突时**以文档为准**改代码。

- [x] **Step 7.1: `lib/api/dashboard.ts`**

```ts
import { apiFetch } from './client'

export interface DashboardAlert {
  severity: 'error' | 'warn' | 'info'
  text: string
  action_label: string
  href: string
}

export interface ReleaseToday {
  repo_id: string
  tag_name: string
  name: string
  published_at: string
  is_prerelease: boolean
  html_url: string
  draft_ids: number[]
}

export interface SourceStatus {
  key: string
  name: string
  href: string
  schedule: string
  last_status: 'ok' | 'warn' | 'error' | null
  last_message: string
  last_run_at: string | null
  today_new: number
}

export interface DashboardOverview {
  alerts: DashboardAlert[]
  releases_today: ReleaseToday[]
  sources: SourceStatus[]
  today_output: { topics: number; drafts: number }
  errors: string[]
  generated_at: string
}

export const EMPTY_OVERVIEW: DashboardOverview = {
  alerts: [],
  releases_today: [],
  sources: [],
  today_output: { topics: 0, drafts: 0 },
  errors: [],
  generated_at: '',
}

export function getDashboardOverview(): Promise<DashboardOverview> {
  return apiFetch<DashboardOverview>('/dashboard/overview')
}
```

- [x] **Step 7.2: `AlertsBar.tsx`（server component，无 'use client'）**

```tsx
import Link from 'next/link'
import { AlertTriangle, Info, XCircle, ArrowRight } from 'lucide-react'
import type { DashboardAlert } from '@/lib/api/dashboard'

const STYLES = {
  error: { box: 'border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40', icon: XCircle, iconCls: 'text-red-500' },
  warn:  { box: 'border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40', icon: AlertTriangle, iconCls: 'text-amber-500' },
  info:  { box: 'border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/40', icon: Info, iconCls: 'text-blue-500' },
} as const

export function AlertsBar({ alerts }: { alerts: DashboardAlert[] }) {
  if (alerts.length === 0) return null
  return (
    <div className="mb-6 space-y-2">
      {alerts.map((a, i) => {
        const s = STYLES[a.severity] ?? STYLES.info
        const Icon = s.icon
        return (
          <div key={i} className={`flex items-center gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm ${s.box}`}>
            <Icon className={`w-4 h-4 shrink-0 ${s.iconCls}`} />
            <span className="flex-1 text-zinc-700 dark:text-zinc-200">{a.text}</span>
            {a.href && (
              <Link href={a.href} className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700 shrink-0">
                {a.action_label || '查看'} <ArrowRight className="w-3 h-3" />
              </Link>
            )}
          </div>
        )
      })}
    </div>
  )
}
```

- [x] **Step 7.3: `SourceStatusGrid.tsx`（server component）**

```tsx
import Link from 'next/link'
import { fmtRelTime } from '@/lib/format'
import type { SourceStatus } from '@/lib/api/dashboard'

const DOT: Record<string, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  error: 'bg-red-500',
}

export function SourceStatusGrid({ sources }: { sources: SourceStatus[] }) {
  if (sources.length === 0) return null
  return (
    <section className="mt-8">
      <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-3">数据采集</h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2.5">
        {sources.map(s => (
          <Link
            key={s.key}
            href={s.href}
            title={s.last_message}
            className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl px-3.5 py-3 hover:border-indigo-300 hover:shadow-sm transition-all"
          >
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className={`w-2 h-2 rounded-full shrink-0 ${DOT[s.last_status ?? ''] ?? 'bg-zinc-300 dark:bg-zinc-600'}`} />
                <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 truncate">{s.name}</span>
              </div>
              <span className="text-[10px] text-zinc-400 shrink-0">{s.schedule}</span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className={`text-sm font-semibold ${s.today_new > 0 ? 'text-zinc-900 dark:text-zinc-100' : 'text-zinc-300 dark:text-zinc-600'}`}>
                +{s.today_new}
              </span>
              <span className="text-[10px] text-zinc-400">
                {s.last_run_at ? fmtRelTime(s.last_run_at) : '未运行'}
              </span>
            </div>
          </Link>
        ))}
      </div>
    </section>
  )
}
```

- [x] **Step 7.4: `GenerateDraftButton.tsx`（client，仿 GenerateButton.tsx）**

```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { PenLine, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch } from '@/lib/api/client'

export function GenerateDraftButton({ repoId, tag }: { repoId: string; tag: string }) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)

  async function handle() {
    setLoading(true)
    try {
      // repoId 形如 "owner/repo"，正好占 path 两段
      const res = await apiFetch<{ drafts_created: number }>(
        `/github/releases/${repoId}/${encodeURIComponent(tag)}/generate-draft`,
        { method: 'POST' },
      )
      toast.success(`已生成 ${res.drafts_created} 篇草稿`)
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '生成失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <button
      onClick={handle}
      disabled={loading}
      className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700 disabled:opacity-50 shrink-0"
    >
      {loading ? <RefreshCw className="w-3 h-3 animate-spin" /> : <PenLine className="w-3 h-3" />}
      {loading ? '生成中…' : '生成草稿'}
    </button>
  )
}
```

- [x] **Step 7.5: `ReleasesToday.tsx`（server component）**

```tsx
import Link from 'next/link'
import { GitFork, ArrowRight, ExternalLink } from 'lucide-react'
import { fmtRelTime } from '@/lib/format'
import type { ReleaseToday } from '@/lib/api/dashboard'
import { GenerateDraftButton } from './GenerateDraftButton'

export function ReleasesToday({ releases }: { releases: ReleaseToday[] }) {
  return (
    <section className="mb-8">
      <div className="flex items-center gap-2 mb-3">
        <GitFork className="w-4 h-4 text-emerald-600" />
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">今日可写 · GitHub 新发布</h2>
        <Link href="/github" className="ml-auto flex items-center gap-1 text-xs text-indigo-500 hover:text-indigo-600">
          全部仓库 <ArrowRight className="w-3 h-3" />
        </Link>
      </div>
      {releases.length === 0 ? (
        <div className="bg-zinc-50 dark:bg-zinc-900/50 border border-dashed border-zinc-200 dark:border-zinc-800 rounded-xl p-4 text-center text-zinc-400 text-xs">
          今天暂无新 Release
        </div>
      ) : (
        <div className="space-y-2">
          {releases.map(r => (
            <div
              key={`${r.repo_id}:${r.tag_name}`}
              className="flex items-center gap-3 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <a
                    href={r.html_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm font-medium text-zinc-900 dark:text-zinc-100 hover:text-indigo-600 truncate"
                  >
                    {r.repo_id} <span className="text-zinc-400 font-normal">{r.tag_name}</span>
                  </a>
                  {r.is_prerelease && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-400 shrink-0">pre</span>
                  )}
                  <ExternalLink className="w-3 h-3 text-zinc-300 shrink-0" />
                </div>
                <p className="text-xs text-zinc-400 truncate mt-0.5">{r.name} · {fmtRelTime(r.published_at)}</p>
              </div>
              {r.draft_ids.length > 0 ? (
                <Link
                  href={`/drafts?draft=${r.draft_ids[0]}`}
                  className="text-xs font-medium text-emerald-600 hover:text-emerald-700 shrink-0"
                >
                  查看草稿（{r.draft_ids.length}）
                </Link>
              ) : (
                <GenerateDraftButton repoId={r.repo_id} tag={r.tag_name} />
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
```

- [x] **Step 7.6: 提交**

```bash
git add web/lib/api/dashboard.ts web/components/features/dashboard/
git commit -m "feat(dashboard): 前端 API 封装 + 提醒条/Release/采集网格组件"
```

---

## Task 8: 前端 — 首页接入

**Files:**
- Modify: `web/app/page.tsx`

- [x] **Step 8.1: 改造 page.tsx（推荐选题区块整段保留不动，只调整外层）**

```tsx
import Link from 'next/link'
import { ArrowRight, Sparkles } from 'lucide-react'
import { getRecommendedTopics } from '@/lib/api/topics'
import { getDashboardOverview, EMPTY_OVERVIEW } from '@/lib/api/dashboard'
import { UrgencyBadge } from '@/components/features/UrgencyBadge'
import { ScoreStars } from '@/components/features/ScoreStars'
import { MiniSparkline } from '@/components/features/MiniSparkline'
import { GenerateButton } from '@/components/features/GenerateButton'
import { AlertsBar } from '@/components/features/dashboard/AlertsBar'
import { ReleasesToday } from '@/components/features/dashboard/ReleasesToday'
import { SourceStatusGrid } from '@/components/features/dashboard/SourceStatusGrid'

export const dynamic = 'force-dynamic'

export default async function Dashboard() {
  const [recommended, overview] = await Promise.all([
    getRecommendedTopics(5).catch(() => [] as Awaited<ReturnType<typeof getRecommendedTopics>>),
    getDashboardOverview().catch(() => EMPTY_OVERVIEW),
  ])

  const today = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })

  return (
    <div className="px-8 py-8">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <p className="text-xs text-zinc-400 mb-1">{today}</p>
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">今日工作台</h1>
          <p className="text-sm text-zinc-500 mt-1">
            共 <span className="text-zinc-900 dark:text-zinc-100 font-medium">{recommended.length}</span> 条推荐选题，
            <span className="text-red-500 font-medium">{recommended.filter(t => t.urgency === 'urgent').length}</span> 条紧急
            <span className="text-zinc-300 dark:text-zinc-600 mx-2">·</span>
            今日 +{overview.today_output.topics} 选题 / +{overview.today_output.drafts} 草稿
          </p>
        </div>
        <GenerateButton />
      </div>

      <AlertsBar alerts={overview.alerts} />

      <ReleasesToday releases={overview.releases_today} />

      <section>
        {/* …… 原推荐选题整段（含标题行/空态/卡片 grid）原样保留 …… */}
      </section>

      <SourceStatusGrid sources={overview.sources} />
    </div>
  )
}
```

注意：`<section>` 里的推荐选题代码是现文件 32-75 行原文，不重写；唯一改动是它前后插入新组件、头部副标题加今日产出、`mb-8` 改 `mb-6`。

- [x] **Step 8.2: 类型检查 / 构建**

Run: `source ~/.zshrc && cd web && npx tsc --noEmit 2>&1 | tail -5`（若项目无独立 tsc 配置则 `npm run build`）
Expected: 无类型错误。

- [x] **Step 8.3: 后端起服务冒烟**

```bash
source ~/.zshrc && curl -s http://localhost:8000/api/dashboard/overview | head -c 400
```
（开发后端常驻 8000 端口；若没起，`conda run -n wems uvicorn main:app` 起一个或跳过此步用测试覆盖。）
Expected: JSON 含 `"sources":[...13 项...]`。

- [x] **Step 8.4: 提交**

```bash
git add web/app/page.tsx
git commit -m "feat(dashboard): 首页工作台接入提醒区/今日 Release/采集状态网格"
```

---

## Task 9: 收尾

- [x] **Step 9.1: 全量后端测试最终回归**

Run: `source ~/.zshrc && conda run -n wems python -m pytest backend/tests/ -q 2>&1 | tail -3`
Expected: 仅既存 9 个 writing_plans 失败。

- [x] **Step 9.2: 浏览器/截图自查首页**（dev server 在跑的话）确认四区块渲染、空态正常。

- [x] **Step 9.3: 勾掉本计划 checkbox，更新记忆索引（新增 dashboard 功能记忆条目）。**
