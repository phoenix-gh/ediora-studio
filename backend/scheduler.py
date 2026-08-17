"""Scheduler job registry — extracted from main.py.

Each scheduled_* coroutine is a self-contained APScheduler job. The throttle
helper unifies the repeated interval pattern across jobs.

_last_ts is persisted to STATE_FILE so service restarts respect elapsed time:
- if the job ran 2 min ago and interval is 30 min, restart won't re-run it
- if the job ran 8 h ago (overnight) and interval is 6 h, it fires immediately
"""
from __future__ import annotations
import asyncio
import json
import os
import time
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable

from database import SessionLocal


STATE_FILE = os.getenv(
    "SCHEDULER_STATE_FILE",
    os.path.join(os.path.dirname(__file__), ".scheduler_state.json"),
)

# Wall-clock timestamps (time.time()) keyed by job_key, persisted across restarts.
_last_ts: dict[str, float] = {}

X_COLLECTION_MIN_INTERVAL_MINUTES = 5
X_COLLECTION_MAX_INTERVAL_MINUTES = 1440


def _load_state() -> None:
    try:
        with open(STATE_FILE) as f:
            data = json.load(f)
        if isinstance(data, dict):
            _last_ts.update({k: float(v) for k, v in data.items()})
    except (FileNotFoundError, json.JSONDecodeError, ValueError):
        pass


def _save_state() -> None:
    try:
        with open(STATE_FILE, "w") as f:
            json.dump(_last_ts, f)
    except OSError:
        pass


def _should_run(job_key: str, interval_seconds: float) -> bool:
    now = time.time()
    last = _last_ts.get(job_key, 0.0)  # 0.0 = epoch → always runs on first ever start
    if now - last < interval_seconds:
        return False
    _last_ts[job_key] = now
    _save_state()
    return True


def _is_x_subscription_due(sub, now: datetime | None = None) -> bool:
    """Return whether an enabled X subscription is ready for auto-collection."""
    last_collected_at = sub.last_collected_at
    if last_collected_at is None:
        return True
    if last_collected_at.tzinfo is None:
        last_collected_at = last_collected_at.replace(tzinfo=timezone.utc)
    now = now or datetime.now(timezone.utc)
    try:
        interval = int(sub.collect_interval_minutes)
    except (TypeError, ValueError):
        interval = 15
    interval = max(
        X_COLLECTION_MIN_INTERVAL_MINUTES,
        min(X_COLLECTION_MAX_INTERVAL_MINUTES, interval),
    )
    return now - last_collected_at >= timedelta(minutes=interval)


async def scheduled_github():
    from logger import log
    from config import get_config
    from github_collector import collect_all_repos, collect_trending
    try:
        cfg = await get_config()
        trending_hours = max(1, int(cfg.get("github_trending_interval_hours", 6)))
        do_trending = _should_run("github_trending", trending_hours * 3600)
        trending_new = 0
        trending_error = ""
        draft_new = 0
        detail_parts = []
        async with SessionLocal() as db:
            if do_trending:
                try:
                    trending_new = await collect_trending(db)
                except Exception as te:
                    trending_error = str(te)
            repo_results = await collect_all_repos(db)
        release_new = sum(r.get("new_releases", 0) for r in repo_results)
        if release_new > 0:
            try:
                from release_drafter import generate_pending_drafts
                async with SessionLocal() as db:
                    draft_new = await generate_pending_drafts(db)
            except Exception as de:
                detail_parts.append("draft: " + str(de))
        errors = [r for r in repo_results if r.get("error")]
        if trending_error:
            detail_parts.append("trending: " + trending_error)
        if errors:
            for r in errors:
                detail_parts.append("{0}: {1}".format(r["repo_id"], r["error"]))
        detail = "; ".join(detail_parts)
        msg = "趋势 +{0}  Releases +{1}  草稿 +{2}".format(trending_new, release_new, draft_new)
        if trending_error or errors:
            if trending_error:
                msg += "  (趋势抓取失败)"
            if errors:
                msg += "  ({0} 个仓库失败)".format(len(errors))
            await log("github", "warn", msg, detail)
        else:
            await log("github", "ok", msg)
    except Exception as e:
        await log("github", "error", "GitHub 采集异常", str(e))


async def scheduled_papers():
    from logger import log
    from config import get_config
    try:
        cfg = await get_config()
        hours = max(1, int(cfg.get("arxiv_collect_interval_hours", 6)))
        if not _should_run("papers", hours * 3600):
            return
        from paper_collector import collect_papers
        async with SessionLocal() as db:
            result = await collect_papers(db)
        errors = result.get("errors", [])
        if errors:
            await log("papers", "warn",
                      "论文采集完成，新增 {0} 篇".format(result["new_papers"]),
                      "; ".join(errors))
        else:
            await log("papers", "ok", "论文采集完成，新增 {0} 篇".format(result["new_papers"]))
    except Exception as e:
        await log("papers", "error", "论文采集异常", str(e))


async def scheduled_v2ex():
    from logger import log
    from config import get_config
    try:
        cfg = await get_config()
        minutes = max(5, int(cfg.get("v2ex_collect_interval_minutes", 30)))
        if not _should_run("v2ex", minutes * 60):
            return
        from v2ex_collector import collect_all as v2ex_collect_all
        async with SessionLocal() as db:
            result = await v2ex_collect_all(db)
        if result["errors"]:
            await log("v2ex", "warn", "V2EX 采集完成，新增 {0} 条".format(result["new_topics"]),
                      "; ".join(result["errors"]))
        elif result["new_topics"]:
            await log("v2ex", "ok", "V2EX 采集完成，新增 {0} 条".format(result["new_topics"]))
    except Exception as e:
        await log("v2ex", "error", "V2EX 采集异常", str(e))


async def scheduled_kr():
    from logger import log
    from config import get_config
    try:
        cfg = await get_config()
        minutes = max(5, int(cfg.get("kr_collect_interval_minutes", 30)))
        if not _should_run("kr", minutes * 60):
            return
        from kr_collector import collect_all as kr_collect_all
        async with SessionLocal() as db:
            result = await kr_collect_all(db)
        per = result.get("per_feed", {})
        if result["errors"]:
            await log("36kr", "warn",
                      "36 氪采集完成：新增 {0} 条".format(result["new_articles"]),
                      "; ".join(result["errors"]))
        elif result["new_articles"]:
            await log("36kr", "ok",
                      "36 氪采集：热榜 +{0}  最新 +{1}  快讯 +{2}".format(
                          per.get("hot", 0), per.get("article", 0), per.get("newsflash", 0)))
    except Exception as e:
        await log("36kr", "error", "36 氪采集异常", str(e))


async def scheduled_wechat():
    """Sync subscribed mp.weixin.qq.com accounts via stored credential.

    Skips silently when credential missing/expired — user must re-scan from UI.
    """
    from logger import log
    from config import get_config
    from datetime import datetime, timezone
    from sqlalchemy import select
    try:
        cfg = await get_config()
        minutes = max(15, int(cfg.get("wechat_collect_interval_minutes", 60)))
        if not _should_run("wechat", minutes * 60):
            return
        from models import WechatCredential, WechatAccount
        from routers.wechat import _sync_account
        import wechat_mp_client as mp

        async with SessionLocal() as db:
            cred = await db.get(WechatCredential, 1)
            if not cred or not cred.token or not cred.cookie:
                return
            if cred.expires_at and cred.expires_at <= datetime.now(timezone.utc):
                return
            accounts = (await db.execute(
                select(WechatAccount).where(WechatAccount.muted.is_(False))
            )).scalars().all()
            if not accounts:
                return
            token, cookie = cred.token, cred.cookie
            new_total = 0
            body_fetched = 0
            body_failed = 0
            errors: list[str] = []
            for acc in accounts:
                try:
                    res = await _sync_account(db, acc, token, cookie, pages=1, page_size=10)
                    new_total += res.new_articles
                    body_fetched += res.body_fetched
                    body_failed += res.body_failed
                    errors.extend(res.body_errors)
                    if res.list_error:
                        errors.append(f"{acc.name}: {res.list_error}")
                except Exception as e:
                    # SessionExpired bubbles up as HTTPException(401) — stop and ask user to re-scan
                    if "登录已过期" in str(e):
                        await log("wechat", "warn", "公众平台登录已过期，需重新扫码")
                        return
                    errors.append("{0}: {1}".format(acc.name, e))
                # gentle pacing across accounts
                await asyncio.sleep(2)
            if errors or body_failed:
                await log("wechat", "warn",
                          "公众号采集：{0} 个账号，新增 {1} 篇，正文成功 {2} 篇，正文失败 {3} 篇".format(
                              len(accounts), new_total, body_fetched, body_failed),
                          "; ".join(errors))
            elif new_total:
                await log("wechat", "ok",
                          "公众号采集：{0} 个账号，新增 {1} 篇，正文成功 {2} 篇".format(
                              len(accounts), new_total, body_fetched))
    except Exception as e:
        await log("wechat", "error", "公众号采集异常", str(e))


async def scheduled_juejin():
    from logger import log
    from config import get_config
    try:
        cfg = await get_config()
        minutes = max(5, int(cfg.get("juejin_collect_interval_minutes", 30)))
        if not _should_run("juejin", minutes * 60):
            return
        from juejin_collector import collect_all as juejin_collect_all, CATEGORIES, FEED_TYPES
        async with SessionLocal() as db:
            result = await juejin_collect_all(db)
        per = result.get("per_category", {})
        if result["errors"]:
            await log("juejin", "warn",
                      "掘金采集完成：新增 {0} 条".format(result["new_articles"]),
                      "; ".join(result["errors"]))
        elif result["new_articles"]:
            summary = "  ".join("{0} +{1}".format(CATEGORIES[k][1], per.get(k, 0)) for k in FEED_TYPES)
            await log("juejin", "ok", "掘金采集：" + summary)
    except Exception as e:
        await log("juejin", "error", "掘金采集异常", str(e))


async def scheduled_x_collect():
    """定时：只采集已到达各自间隔的启用 XSubscription。"""
    from logger import log
    from sqlalchemy import select
    from models import XSubscription
    from routers.x import _collect_one, ensure_x_credential_sessions

    try:
        if not _should_run("x_collect", 60):
            return
        now = datetime.now(timezone.utc)
        async with SessionLocal() as db:
            rows = (await db.execute(
                select(XSubscription).where(XSubscription.enabled == True)
            )).scalars().all()
            due_rows = [row for row in rows if _is_x_subscription_due(row, now)]
            if not due_rows:
                return
            await ensure_x_credential_sessions(db)
            ok = 0
            failed = 0
            new_total = 0
            for sub in due_rows:
                try:
                    new_total += await _collect_one(db, sub)
                    ok += 1
                except Exception as e:
                    failed += 1
                    await log("x", "error",
                              f"订阅 {sub.label} 采集失败", str(e))
                await asyncio.sleep(2)
        await log("x", "ok",
                  f"X 全量采集：{ok} 源成功 / {failed} 源失败，新增 {new_total} 帖")
    except Exception as e:
        await log("x", "error", "X 采集异常", str(e))


async def scheduled_reddit():
    from logger import log
    from config import get_config
    try:
        cfg = await get_config()
        minutes = max(30, int(cfg.get("reddit_collect_interval_minutes", 60)))
        if not _should_run("reddit", minutes * 60):
            return
        from reddit_collector import collect_all as reddit_collect_all
        async with SessionLocal() as db:
            result = await reddit_collect_all(db)
        if result["errors"]:
            await log("reddit", "warn",
                      f"Reddit 采集完成，新增 {result['new_posts']} 条",
                      "; ".join(result["errors"]))
        else:
            await log("reddit", "ok", f"Reddit 采集完成，新增 {result['new_posts']} 条")
    except Exception as e:
        await log("reddit", "error", "Reddit 采集异常", str(e))


async def scheduled_topic_source_reconcile():
    """每五分钟补偿已落库但未成功投递到 AI worker 的主题素材任务。"""
    from logger import log

    try:
        from topic_source_service import reconcile_topic_source_jobs
        result = await reconcile_topic_source_jobs()
        detail = (
            f"入队 {result['enqueued']} 个任务，"
            f"取消 {result['cancelled']} 个非法任务"
        )
        if result["errors"]:
            await log(
                "topic_source",
                "warn",
                f"主题素材甄选补偿：{detail}",
                "; ".join(result["errors"]),
            )
        elif result["enqueued"] or result["cancelled"]:
            await log(
                "topic_source",
                "ok",
                f"主题素材甄选补偿：{detail}",
            )
    except Exception as e:
        await log("topic_source", "error", "主题素材甄选补偿异常", str(e))


async def scheduled_daily_creation_rules():
    """Every minute, dispatch configurable rules whose local schedule is due."""
    from logger import log
    try:
        from daily_creation_scheduler import dispatch_due_creation_rules
        result = await dispatch_due_creation_rules()
        if result["created"]:
            await log(
                "daily_creation",
                "ok",
                f"已创建并入队 {result['created']} 个创作规则任务",
            )
    except Exception as e:
        await log("daily_creation", "error", "创作规则调度异常", str(e))


def register_jobs(scheduler, cfg):
    from datetime import datetime, timedelta
    _load_state()
    github_min  = max(1, int(cfg.get("github_interval_minutes", 1)))

    def _first_run(interval_minutes: int, state_key: str | None = None) -> datetime:
        """Return datetime.now() if the job is overdue, otherwise schedule normally."""
        if state_key is None:
            return datetime.now()
        last = _last_ts.get(state_key, 0.0)
        elapsed = time.time() - last
        if elapsed >= interval_minutes * 60:
            return datetime.now()
        remaining = interval_minutes * 60 - elapsed
        return datetime.now() + timedelta(seconds=remaining)

    # state_key must match the key used inside the job's _should_run() call.
    # Jobs without _should_run (github_collect) always fire on startup.
    jobs = [
        (scheduled_github,              dict(trigger="interval", minutes=github_min,  id="github_collect",    next_run_time=datetime.now())),
        (scheduled_papers,              dict(trigger="interval", minutes=30,          id="papers_collect",    next_run_time=_first_run(30,  "papers"))),
        (scheduled_v2ex,                dict(trigger="interval", minutes=10,          id="v2ex_collect",      next_run_time=_first_run(10,  "v2ex"))),
        (scheduled_kr,                  dict(trigger="interval", minutes=10,          id="kr_collect",        next_run_time=_first_run(10,  "kr"))),
        (scheduled_juejin,              dict(trigger="interval", minutes=10,          id="juejin_collect",    next_run_time=_first_run(10,  "juejin"))),
        (scheduled_wechat,              dict(trigger="interval", minutes=15,          id="wechat_collect",    next_run_time=_first_run(15,  "wechat"))),
        (scheduled_x_collect,           dict(trigger="interval", minutes=1,           id="x_collect_hourly",  next_run_time=_first_run(1,   "x_collect"))),
        (scheduled_reddit,              dict(trigger="interval", minutes=60,          id="reddit_collect",    next_run_time=_first_run(60,  "reddit"))),
        (scheduled_topic_source_reconcile,dict(trigger="interval", minutes=5,         id="topic_source_reconcile", next_run_time=datetime.now())),
        (scheduled_daily_creation_rules,dict(trigger="interval", minutes=1, id="daily_creation_rules", next_run_time=datetime.now())),
    ]
    for func, kwargs in jobs:
        scheduler.add_job(func, **kwargs)
