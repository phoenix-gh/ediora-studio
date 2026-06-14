from contextlib import asynccontextmanager
import os
from dotenv import load_dotenv

# Load backend/.env before any other import so feedgrab + downstream modules
# see X_BOOKMARKS_ENABLED, WMS_DATABASE_URL, X_AUTH_TOKEN, etc.
load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from database import init_db
from routers import settings, github, x, papers, personas, upload, drafts, writing_plans, youtube, producthunt, wechat, v2ex, kr, juejin, studio, publish_accounts, profiles, reddit, topic_generator, retro, materials, skills, dashboard, daily_plan, published
import scheduler as job_registry

scheduler = AsyncIOScheduler()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
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

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(settings.router, prefix="/api")
app.include_router(github.router, prefix="/api")
app.include_router(x.router, prefix="/api")
app.include_router(papers.router, prefix="/api")
app.include_router(personas.router, prefix="/api")
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
app.include_router(profiles.router, prefix="/api")
app.include_router(reddit.router, prefix="/api")
app.include_router(topic_generator.router, prefix="/api")
app.include_router(retro.router, prefix="/api")
app.include_router(materials.router, prefix="/api")
app.include_router(skills.router, prefix="/api")
app.include_router(dashboard.router, prefix="/api")
app.include_router(daily_plan.router, prefix="/api")
app.include_router(published.router, prefix="/api")

_mcp_handler = _mcp_http_app.routes[0].endpoint
app.add_route("/mcp", _mcp_handler, methods=["GET", "POST", "DELETE"])

from fastapi.staticfiles import StaticFiles
import os as _os
_uploads_dir = _os.path.join(_os.path.dirname(__file__), "uploads")
_os.makedirs(_uploads_dir, exist_ok=True)
app.mount("/api/uploads", StaticFiles(directory=_uploads_dir), name="uploads")


@app.get("/health")
async def health():
    return {"status": "ok"}
