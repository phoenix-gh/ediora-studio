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
from typing import Awaitable, Callable

from database import SessionLocal


STATE_FILE = os.path.join(os.path.dirname(__file__), ".scheduler_state.json")

# Wall-clock timestamps (time.time()) keyed by job_key, persisted across restarts.
_last_ts: dict[str, float] = {}


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
            errors: list[str] = []
            for acc in accounts:
                try:
                    res = await _sync_account(db, acc, token, cookie, pages=1, page_size=10)
                    new_total += res.new_articles
                except Exception as e:
                    # SessionExpired bubbles up as HTTPException(401) — stop and ask user to re-scan
                    if "登录已过期" in str(e):
                        await log("wechat", "warn", "公众平台登录已过期，需重新扫码")
                        return
                    errors.append("{0}: {1}".format(acc.name, e))
                # gentle pacing across accounts
                await asyncio.sleep(2)
            if errors:
                await log("wechat", "warn",
                          "公众号采集：{0} 个账号，新增 {1} 篇，{2} 个失败".format(
                              len(accounts), new_total, len(errors)),
                          "; ".join(errors))
            elif new_total:
                await log("wechat", "ok",
                          "公众号采集：{0} 个账号，新增 {1} 篇".format(len(accounts), new_total))
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
    """定时：采集所有启用 XSubscription；间隔由 x_collect_interval_minutes 控制。"""
    from logger import log
    from config import get_config
    from sqlalchemy import select
    from models import XSubscription
    from routers.x import _collect_one

    try:
        cfg = await get_config()
        minutes = max(1, int(cfg.get("x_collect_interval_minutes", 15)))
        if not _should_run("x_collect", minutes * 60):
            return
        async with SessionLocal() as db:
            rows = (await db.execute(
                select(XSubscription).where(XSubscription.enabled == True)
            )).scalars().all()
            ok = 0
            failed = 0
            new_total = 0
            for sub in rows:
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


async def scheduled_x_response_reconcile():
    """每五分钟补偿已入库但尚未创建即时响应任务的新帖。"""
    from logger import log
    from config import get_config

    try:
        cfg = await get_config()
        if str(cfg.get("x_notify_enabled", "1")).lower() not in ("1", "true", "yes", "on"):
            return
        from x_response_service import reconcile_response_jobs
        result = await reconcile_response_jobs()
        if result["errors"]:
            await log(
                "x_response",
                "warn",
                f"即时响应补偿：创建 {result['created']}，入队 {result['enqueued']}",
                "; ".join(result["errors"]),
            )
        elif result["created"]:
            await log(
                "x_response",
                "ok",
                f"即时响应补偿：创建并入队 {result['enqueued']} 个任务",
            )
    except Exception as e:
        await log("x_response", "error", "即时响应补偿异常", str(e))


async def scheduled_x_response_digest():
    """每天 18:00（Asia/Shanghai）创建并投递一次中等价值摘要任务。"""
    from datetime import datetime
    from zoneinfo import ZoneInfo
    from logger import log
    from config import get_config

    try:
        cfg = await get_config()
        if str(cfg.get("x_notify_enabled", "1")).lower() not in ("1", "true", "yes", "on"):
            return
        from job_queue import enqueue_job
        from x_response_service import (
            create_response_digest_job,
            enqueue_content_job_once,
        )
        date_key = datetime.now(ZoneInfo("Asia/Shanghai")).date().isoformat()
        async with SessionLocal() as db:
            job, _created = await create_response_digest_job(date_key, db=db)
            enqueued = await enqueue_content_job_once(
                db,
                job,
                enqueue=enqueue_job,
            )
        if enqueued:
            await log("x_response", "ok", f"即时响应摘要已入队：{date_key}")
    except Exception as e:
        await log("x_response", "error", "即时响应摘要入队异常", str(e))


async def scheduled_daily_plan():
    """每天 8 点：为每个 active 账号生成今日内容计划。
    create_today_plan 自带「当天已有计划则跳过」幂等守卫，重启重跑安全。"""
    from logger import log
    try:
        from daily_planner import create_today_plan
        await create_today_plan()
    except Exception as e:
        await log("daily_plan", "error", "今日计划生成异常", str(e))


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
        (scheduled_x_collect,           dict(trigger="interval", minutes=5,           id="x_collect_hourly",  next_run_time=_first_run(5,   "x_collect"))),
        (scheduled_reddit,              dict(trigger="interval", minutes=60,          id="reddit_collect",    next_run_time=_first_run(60,  "reddit"))),
        (scheduled_x_response_reconcile,dict(trigger="interval", minutes=5,           id="x_response_reconcile", next_run_time=datetime.now())),
        (scheduled_x_response_digest,   dict(trigger="cron", hour=18, minute=0, timezone="Asia/Shanghai", id="x_response_digest")),
        (scheduled_daily_plan,          dict(trigger="cron",     hour=8, minute=0,    id="daily_plan")),
    ]
    for func, kwargs in jobs:
        scheduler.add_job(func, **kwargs)
