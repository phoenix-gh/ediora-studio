from contextlib import asynccontextmanager
import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from database import init_db, SessionLocal
from collector import collect_all
from routers import accounts, hotspots, collect, settings, github, x, avatars, papers, personas, keywords, upload, drafts, content_topics, quotes, synthesize, youtube, producthunt, wechat, v2ex, kr, juejin

scheduler = AsyncIOScheduler()


async def scheduled_collect_and_analyze():
    from logger import log
    # ── RSS / YouTube collect ──────────────────────────────────────────────
    try:
        async with SessionLocal() as db:
            results = await collect_all(db)
        new_total = sum(r["new_posts"] for r in results)
        errors = [r for r in results if r["error"]]
        ok_count = len(results) - len(errors)
        detail = "; ".join(f'{r["account_id"]}: {r["error"]}' for r in errors) if errors else ""
        if errors:
            await log("collect", "warn",
                      f"完成 {ok_count}/{len(results)} 个账号，新增 {new_total} 条，{len(errors)} 个失败",
                      detail)
        else:
            await log("collect", "ok",
                      f"完成 {len(results)} 个账号，新增 {new_total} 条内容")
    except Exception as e:
        await log("collect", "error", "采集任务异常", str(e))
        return

    # ── LLM analysis ──────────────────────────────────────────────────────
    try:
        from analyzer import run_full_analysis
        async with SessionLocal() as db:
            result = await run_full_analysis(db)
        await log("analyze", "ok",
                  f"选题 +{result['new_topics']}  热点 +{result['new_hotspots']}")
    except Exception as e:
        await log("analyze", "error", "AI 分析异常", str(e))


_last_trending_ts: float = 0.0
_last_x_ts: float = 0.0
_last_papers_ts: float = 0.0
_last_v2ex_ts: float = 0.0
_last_kr_ts: float = 0.0
_last_juejin_ts: float = 0.0

async def scheduled_github():
    """Collect GitHub issues for all due repos + refresh trending."""
    import time
    global _last_trending_ts
    from logger import log
    try:
        from config import get_config
        from github_collector import collect_all_repos, collect_trending
        cfg = await get_config()
        trending_hours = max(1, int(cfg.get("github_trending_interval_hours", 6)))
        do_trending = (time.monotonic() - _last_trending_ts) >= trending_hours * 3600

        trending_new = 0
        trending_error = ""
        async with SessionLocal() as db:
            if do_trending:
                try:
                    trending_new = await collect_trending(db)
                    _last_trending_ts = time.monotonic()
                except Exception as te:
                    trending_error = str(te)
                    _last_trending_ts = time.monotonic()  # avoid tight retry loop
            repo_results = await collect_all_repos(db)

        issue_new = sum(r["new_issues"] for r in repo_results)
        release_new = sum(r.get("new_releases", 0) for r in repo_results)
        errors = [r for r in repo_results if r.get("error")]
        detail_parts = []
        if trending_error:
            detail_parts.append(f"trending: {trending_error}")
        if errors:
            detail_parts.extend(f'{r["repo_id"]}: {r["error"]}' for r in errors)
        detail = "; ".join(detail_parts)
        msg = f"趋势 +{trending_new}  Issues +{issue_new}  Releases +{release_new}"
        if trending_error or errors:
            if trending_error:
                msg += "  (趋势抓取失败)"
            if errors:
                msg += f"  ({len(errors)} 个仓库失败)"
            await log("github", "warn", msg, detail)
        else:
            await log("github", "ok", msg)
    except Exception as e:
        await log("github", "error", "GitHub 采集异常", str(e))


async def scheduled_papers():
    """Collect arXiv papers according to configured categories and interval."""
    import time
    global _last_papers_ts
    from logger import log
    try:
        from config import get_config
        cfg = await get_config()
        interval_hours = max(1, int(cfg.get("arxiv_collect_interval_hours", 6)))
        if (time.monotonic() - _last_papers_ts) < interval_hours * 3600:
            return

        from paper_collector import collect_papers
        async with SessionLocal() as db:
            result = await collect_papers(db)
        _last_papers_ts = time.monotonic()

        errors = result.get("errors", [])
        if errors:
            await log("papers", "warn",
                      f"论文采集完成，新增 {result['new_papers']} 篇",
                      "; ".join(errors))
        else:
            await log("papers", "ok", f"论文采集完成，新增 {result['new_papers']} 篇")
    except Exception as e:
        await log("papers", "error", "论文采集异常", str(e))



async def scheduled_v2ex():
    """Collect V2EX subscriptions at configured interval."""
    import time
    global _last_v2ex_ts
    from logger import log
    try:
        from config import get_config
        cfg = await get_config()
        interval_min = max(5, int(cfg.get("v2ex_collect_interval_minutes", 30)))
        if (time.monotonic() - _last_v2ex_ts) < interval_min * 60:
            return
        from v2ex_collector import collect_all as v2ex_collect_all
        async with SessionLocal() as db:
            result = await v2ex_collect_all(db)
        _last_v2ex_ts = time.monotonic()
        if result["errors"]:
            await log("v2ex", "warn", f"V2EX 采集完成，新增 {result['new_topics']} 条",
                      "; ".join(result["errors"]))
        elif result["new_topics"]:
            await log("v2ex", "ok", f"V2EX 采集完成，新增 {result['new_topics']} 条")
    except Exception as e:
        await log("v2ex", "error", "V2EX 采集异常", str(e))


async def scheduled_kr():
    """Collect 36Kr hot list + RSS feeds at configured interval."""
    import time
    global _last_kr_ts
    from logger import log
    try:
        from config import get_config
        cfg = await get_config()
        interval_min = max(5, int(cfg.get("kr_collect_interval_minutes", 30)))
        if (time.monotonic() - _last_kr_ts) < interval_min * 60:
            return
        from kr_collector import collect_all as kr_collect_all
        async with SessionLocal() as db:
            result = await kr_collect_all(db)
        _last_kr_ts = time.monotonic()
        per = result.get("per_feed", {})
        if result["errors"]:
            await log("36kr", "warn",
                      f"36 氪采集完成：新增 {result['new_articles']} 条",
                      "; ".join(result["errors"]))
        elif result["new_articles"]:
            await log("36kr", "ok",
                      f"36 氪采集：热榜 +{per.get('hot', 0)}  "
                      f"最新 +{per.get('article', 0)}  快讯 +{per.get('newsflash', 0)}")
    except Exception as e:
        await log("36kr", "error", "36 氪采集异常", str(e))


async def scheduled_juejin():
    """Collect Juejin hot list + per-category feeds at configured interval."""
    import time
    global _last_juejin_ts
    from logger import log
    try:
        from config import get_config
        cfg = await get_config()
        interval_min = max(5, int(cfg.get("juejin_collect_interval_minutes", 30)))
        if (time.monotonic() - _last_juejin_ts) < interval_min * 60:
            return
        from juejin_collector import collect_all as juejin_collect_all, CATEGORIES, FEED_TYPES
        async with SessionLocal() as db:
            result = await juejin_collect_all(db)
        _last_juejin_ts = time.monotonic()
        per = result.get("per_category", {})
        if result["errors"]:
            await log("juejin", "warn",
                      f"掘金采集完成：新增 {result['new_articles']} 条",
                      "; ".join(result["errors"]))
        elif result["new_articles"]:
            summary = "  ".join(f"{CATEGORIES[k][1]} +{per.get(k, 0)}" for k in FEED_TYPES)
            await log("juejin", "ok", f"掘金采集：{summary}")
    except Exception as e:
        await log("juejin", "error", "掘金采集异常", str(e))


async def scheduled_tl1_users():
    """Daily 00:00 — crawl tl1.com /api/users (100 pages) into blogger candidates."""
    from logger import log
    try:
        from x_collector import fetch_tl1_users
        await log("tl1-users", "ok", "tl1 用户采集开始（最多 100 页）")
        result = await fetch_tl1_users(max_pages=100)
        if result.get("error"):
            await log("tl1-users", "error", "tl1 用户采集异常", result["error"])
        else:
            await log("tl1-users", "ok",
                      f"tl1 用户采集完成：抓取 {result['pages_fetched']} 页 / "
                      f"{result['total_fetched']} 人，新增候选 {result['total_upserted']} 个")
    except Exception as e:
        await log("tl1-users", "error", "tl1 用户采集异常", str(e))


async def scheduled_tl1():
    """Fetch trending posts from tl1.com at configured interval."""
    from logger import log
    try:
        from config import get_config
        cfg = await get_config()
        if cfg.get("tl1_collect_enabled", "1") == "0":
            return
        hours = max(1, min(24, int(cfg.get("tl1_trending_hours", 1))))
        from x_collector import fetch_tl1_trending
        async with SessionLocal() as db:
            result = await fetch_tl1_trending(db, hours=hours)
        if result.get("error"):
            await log("tl1", "error", "tl1.com 采集异常", result["error"])
        else:
            await log("tl1", "ok",
                      f"tl1 热门采集：{result['total']} 条，新增 {result['new_posts']} 篇，"
                      f"新候选 {result['new_candidates']} 个")
    except Exception as e:
        await log("tl1", "error", "tl1.com 采集异常", str(e))


async def scheduled_classify_posts():
    """Classify unclassified X posts using LLM."""
    from logger import log
    try:
        from config import get_config
        cfg = await get_config()
        if cfg.get("x_post_classify_enabled", "1") == "0":
            return
        prompt = cfg.get("x_post_classify_prompt", "")
        from post_classifier import classify_unclassified_posts
        async with SessionLocal() as db:
            result = await classify_unclassified_posts(db, prompt_template=prompt, batch_size=20)
        if result["total"] > 0:
            await log("x-classify", "ok", f"帖子分类：{result['classified']}/{result['total']} 条已分类")
    except Exception as e:
        await log("x-classify", "error", "帖子分类异常", str(e))


async def scheduled_x():
    """Collect X timeline, find high-follower accounts."""
    import time
    global _last_x_ts
    from logger import log
    try:
        from config import get_config
        cfg = await get_config()
        interval_min = max(1, int(cfg.get("x_collect_interval_minutes", 30)))
        if (time.monotonic() - _last_x_ts) < interval_min * 60:
            return  # not yet due
        if cfg.get("x_collect_enabled", "1") == "0":
            return  # disabled by user
        if cfg.get("twitterapi_io_collect_enabled", "1") == "0":
            return  # twitterapi.io disabled by user
        if not cfg.get("x_cookies"):
            return  # not configured, skip silently

        from x_collector import collect_x_timeline
        async with SessionLocal() as db:
            result = await collect_x_timeline(db)
        _last_x_ts = time.monotonic()

        if result["error"]:
            await log("x", "error", "X 采集异常", result["error"])
        else:
            await log("x", "ok",
                      f"检查 {result['checked']} 个账号，新增候选 {result['new_candidates']} 个，"
                      f"新帖 {result.get('new_posts', 0)} 条")
    except Exception as e:
        await log("x", "error", "X 采集异常", str(e))


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    from config import get_config
    cfg = await get_config()
    if os.getenv("WMS_DISABLE_SCHEDULER") == "1":
        yield
        return
    collect_min = max(1, int(cfg.get("collect_interval_minutes", 15)))
    github_min  = max(1, int(cfg.get("github_interval_minutes", 1)))
    scheduler.add_job(scheduled_collect_and_analyze, "interval", minutes=collect_min, id="collect_analyze")
    scheduler.add_job(scheduled_github, "interval", minutes=github_min, id="github_collect")
    scheduler.add_job(scheduled_x, "interval", minutes=1, id="x_collect")
    scheduler.add_job(scheduled_papers, "interval", minutes=30, id="papers_collect")
    tl1_sec = max(10, int(cfg.get("tl1_collect_interval_seconds", 30)))
    scheduler.add_job(scheduled_tl1, "interval", seconds=tl1_sec, id="tl1_collect")
    scheduler.add_job(scheduled_tl1_users, "cron", hour=0, minute=0, id="tl1_users_collect")
    scheduler.add_job(scheduled_classify_posts, "interval", minutes=5, id="x_classify")
    scheduler.add_job(scheduled_v2ex, "interval", minutes=10, id="v2ex_collect")
    scheduler.add_job(scheduled_kr, "interval", minutes=10, id="kr_collect")
    scheduler.add_job(scheduled_juejin, "interval", minutes=10, id="juejin_collect")
    scheduler.start()
    app.state.scheduler = scheduler
    yield
    scheduler.shutdown()


from mcp_server import mcp

# Initialize the MCP streamable HTTP app (creates _session_manager internally)
_mcp_http_app = mcp.streamable_http_app()
_mcp_session_manager = mcp._session_manager

_original_lifespan = lifespan

@asynccontextmanager
async def lifespan_with_mcp(app: FastAPI):
    async with _mcp_session_manager.run():
        async with _original_lifespan(app):
            yield

app = FastAPI(title="WeMedia Studio API", lifespan=lifespan_with_mcp)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(accounts.router, prefix="/api")
app.include_router(hotspots.router, prefix="/api")
app.include_router(collect.router, prefix="/api")
app.include_router(settings.router, prefix="/api")
app.include_router(github.router, prefix="/api")
app.include_router(x.router, prefix="/api")
app.include_router(avatars.router, prefix="/api")
app.include_router(papers.router, prefix="/api")
app.include_router(personas.router, prefix="/api")
app.include_router(keywords.router, prefix="/api")
app.include_router(upload.router, prefix="/api")
app.include_router(drafts.router, prefix="/api")
app.include_router(content_topics.router)
app.include_router(quotes.router)
app.include_router(synthesize.router)
app.include_router(youtube.router, prefix="/api")
app.include_router(producthunt.router, prefix="/api")
app.include_router(wechat.router, prefix="/api")
app.include_router(v2ex.router, prefix="/api")
app.include_router(kr.router, prefix="/api")
app.include_router(juejin.router, prefix="/api")

# MCP server — Streamable HTTP transport for AI agents.
# Register the ASGI handler directly at /mcp so it doesn't shadow other routes.
# _mcp_session_manager.run() is started in lifespan_with_mcp above.
_mcp_handler = _mcp_http_app.routes[0].endpoint
app.add_route("/mcp", _mcp_handler, methods=["GET", "POST", "DELETE"])

# Serve uploaded files at /api/uploads/{filename}
from fastapi.staticfiles import StaticFiles
import os as _os
_uploads_dir = _os.path.join(_os.path.dirname(__file__), "uploads")
_os.makedirs(_uploads_dir, exist_ok=True)
app.mount("/api/uploads", StaticFiles(directory=_uploads_dir), name="uploads")


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/api/analyze/all")
async def trigger_full_analysis():
    """Manually trigger full LLM analysis pipeline."""
    from analyzer import run_full_analysis
    async with SessionLocal() as db:
        result = await run_full_analysis(db)
    return result
