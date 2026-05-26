"""Scheduler job registry — extracted from main.py.

Each scheduled_* coroutine is a self-contained APScheduler job. The throttle
helper unifies the repeated time.monotonic() interval pattern that previously
lived as a global _last_X_ts per job.
"""
from __future__ import annotations
import asyncio
import time
from typing import Awaitable, Callable

from database import SessionLocal


_last_ts: dict[str, float] = {}


def _should_run(job_key: str, interval_seconds: float) -> bool:
    now = time.monotonic()
    last = _last_ts.get(job_key, 0.0)
    if now - last < interval_seconds:
        return False
    _last_ts[job_key] = now
    return True


async def scheduled_collect_and_analyze():
    from logger import log
    from collector import collect_all
    try:
        async with SessionLocal() as db:
            results = await collect_all(db)
        new_total = sum(r["new_posts"] for r in results)
        errors = [r for r in results if r["error"]]
        ok_count = len(results) - len(errors)
        if errors:
            detail = "; ".join("{0}: {1}".format(r["account_id"], r["error"]) for r in errors)
        else:
            detail = ""
        if errors:
            await log("collect", "warn",
                      "完成 {0}/{1} 个账号，新增 {2} 条，{3} 个失败".format(ok_count, len(results), new_total, len(errors)),
                      detail)
        else:
            await log("collect", "ok", "完成 {0} 个账号，新增 {1} 条内容".format(len(results), new_total))
    except Exception as e:
        await log("collect", "error", "采集任务异常", str(e))
        return

    try:
        from analyzer import run_full_analysis
        async with SessionLocal() as db:
            result = await run_full_analysis(db)
        await log("analyze", "ok",
                  "选题 +{0}".format(result["new_topics"]))
    except Exception as e:
        await log("analyze", "error", "AI 分析异常", str(e))


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
        async with SessionLocal() as db:
            if do_trending:
                try:
                    trending_new = await collect_trending(db)
                except Exception as te:
                    trending_error = str(te)
            repo_results = await collect_all_repos(db)
        issue_new = sum(r["new_issues"] for r in repo_results)
        release_new = sum(r.get("new_releases", 0) for r in repo_results)
        errors = [r for r in repo_results if r.get("error")]
        detail_parts = []
        if trending_error:
            detail_parts.append("trending: " + trending_error)
        if errors:
            for r in errors:
                detail_parts.append("{0}: {1}".format(r["repo_id"], r["error"]))
        detail = "; ".join(detail_parts)
        msg = "趋势 +{0}  Issues +{1}  Releases +{2}".format(trending_new, issue_new, release_new)
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
    """Hourly: iterate all enabled XSubscription rows; per-source error isolation."""
    from logger import log
    from sqlalchemy import select
    from models import XSubscription
    from routers.x import _collect_one

    try:
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


def register_jobs(scheduler, cfg):
    collect_min = max(1, int(cfg.get("collect_interval_minutes", 15)))
    github_min  = max(1, int(cfg.get("github_interval_minutes", 1)))
    jobs = [
        (scheduled_collect_and_analyze, dict(trigger="interval", minutes=collect_min, id="collect_analyze")),
        (scheduled_github,              dict(trigger="interval", minutes=github_min,  id="github_collect")),
        (scheduled_papers,              dict(trigger="interval", minutes=30,          id="papers_collect")),
        (scheduled_v2ex,                dict(trigger="interval", minutes=10,          id="v2ex_collect")),
        (scheduled_kr,                  dict(trigger="interval", minutes=10,          id="kr_collect")),
        (scheduled_juejin,              dict(trigger="interval", minutes=10,          id="juejin_collect")),
        (scheduled_wechat,              dict(trigger="interval", minutes=15,          id="wechat_collect")),
        (scheduled_x_collect,           dict(trigger="interval", hours=1,             id="x_collect_hourly")),
        (scheduled_reddit,              dict(trigger="interval", minutes=60,          id="reddit_collect")),
    ]
    for func, kwargs in jobs:
        scheduler.add_job(func, **kwargs)
