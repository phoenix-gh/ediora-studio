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

    try:
        alerts = await _build_alerts(db, cfg, latest, sources, now, today_start)
    except Exception as e:
        alerts = []
        errors.append(f"alerts: {e}")

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

    return Overview(alerts=alerts, releases_today=releases, sources=sources,
                    today_output=today_output, errors=errors, generated_at=now)
