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
