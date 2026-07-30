from contextlib import asynccontextmanager
import os
from dotenv import load_dotenv

# Load backend/.env before any other import so feedgrab + downstream modules
# see X_BOOKMARKS_ENABLED, WMS_DATABASE_URL, X_AUTH_TOKEN, etc.
load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

from log_redaction import install_log_redaction

install_log_redaction(secure_default_handler=True)

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from loguru import logger
from database import SessionLocal, init_db
from digital_human_assets import backfill_digital_human_assets
from speech_upload_boundary import SpeechWorkerUploadBoundary
from storage_paths import UPLOADS_DIR
from routers import settings, github, x, x_accounts, x_responses, responses, papers, upload, drafts, writing_plans, youtube, producthunt, wechat, v2ex, kr, juejin, studio, publish_accounts, reddit, assets, dashboard, daily_plan, jobs, chat, digital_humans, talking_videos, text_videos
from x_credential_store import CredentialFileStore
from routers.x_accounts import reconcile_x_credential_accounts
import scheduler as job_registry

scheduler = AsyncIOScheduler(
    # 默认 misfire_grace_time 只有 1 秒：WSL2 墙上时钟漂移几秒就会让每个任务
    # 被判成 misfire 而被静默跳过（曾导致全部定时任务从某刻起集体停摆）。
    # 放宽容忍窗口 + coalesce，让时钟/事件循环的几秒抖动不再废掉整轮执行。
    job_defaults={
        "misfire_grace_time": 3600,
        "coalesce": True,
        "max_instances": 1,
    }
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    async with SessionLocal() as db:
        await backfill_digital_human_assets(db)
        await db.commit()
    try:
        async with SessionLocal() as db:
            errors = await reconcile_x_credential_accounts(db, CredentialFileStore())
            for error in errors:
                logger.warning("X 凭据对账：{}", error)
    except Exception:
        logger.error("X 凭据启动对账失败；账号接口仍可用于修复")
    from config import get_config
    cfg = await get_config()
    if os.getenv("WMS_DISABLE_SCHEDULER") == "1":
        yield
        return
    job_registry.register_jobs(scheduler, cfg)
    scheduler.start()
    app.state.scheduler = scheduler
    yield
    scheduler.shutdown()


from mcp_server import mcp

_mcp_http_app = mcp.streamable_http_app()
_mcp_session_manager = mcp._session_manager

_original_lifespan = lifespan


@asynccontextmanager
async def lifespan_with_mcp(app: FastAPI):
    async with _mcp_session_manager.run():
        async with _original_lifespan(app):
            yield


app = FastAPI(title="WeMedia Studio API", lifespan=lifespan_with_mcp)

cors_origins = [
    origin.strip()
    for origin in os.getenv(
        "WMS_CORS_ORIGINS",
        "http://localhost:3000,http://127.0.0.1:3000",
    ).split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(SpeechWorkerUploadBoundary)

app.include_router(settings.router, prefix="/api")
app.include_router(github.router, prefix="/api")
app.include_router(x.router, prefix="/api")
app.include_router(x_accounts.router, prefix="/api")
app.include_router(x_responses.router, prefix="/api")
app.include_router(responses.router, prefix="/api")
app.include_router(papers.router, prefix="/api")
app.include_router(upload.router, prefix="/api")
app.include_router(drafts.router, prefix="/api")
app.include_router(writing_plans.router, prefix="/api")
app.include_router(youtube.router, prefix="/api")
app.include_router(producthunt.router, prefix="/api")
app.include_router(wechat.router, prefix="/api")
app.include_router(v2ex.router, prefix="/api")
app.include_router(kr.router, prefix="/api")
app.include_router(studio.router, prefix="/api")
app.include_router(juejin.router, prefix="/api")
app.include_router(publish_accounts.router, prefix="/api")
app.include_router(reddit.router, prefix="/api")
app.include_router(assets.router, prefix="/api")
app.include_router(dashboard.router, prefix="/api")
app.include_router(daily_plan.router, prefix="/api")
app.include_router(jobs.router, prefix="/api")
app.include_router(chat.router, prefix="/api")
app.include_router(digital_humans.router, prefix="/api")
app.include_router(talking_videos.router, prefix="/api")
app.include_router(text_videos.router, prefix="/api")

_mcp_handler = _mcp_http_app.routes[0].endpoint
app.add_route("/mcp", _mcp_handler, methods=["GET", "POST", "DELETE"])

UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
app.mount(
    "/api/uploads",
    StaticFiles(directory=UPLOADS_DIR),
    name="uploads",
)


@app.get("/health")
async def health():
    return {"status": "ok"}
