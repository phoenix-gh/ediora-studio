from contextlib import asynccontextmanager
import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from database import init_db, SessionLocal
from routers import accounts, collect, settings, github, x, papers, personas, upload, drafts, content_topics, quotes, synthesize, youtube, producthunt, wechat, v2ex, kr, juejin, studio, publish_accounts, profiles
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

app.include_router(accounts.router, prefix="/api")
app.include_router(collect.router, prefix="/api")
app.include_router(settings.router, prefix="/api")
app.include_router(github.router, prefix="/api")
app.include_router(x.router, prefix="/api")
app.include_router(papers.router, prefix="/api")
app.include_router(personas.router, prefix="/api")
app.include_router(upload.router, prefix="/api")
app.include_router(drafts.router, prefix="/api")
app.include_router(content_topics.router, prefix="/api")
app.include_router(quotes.router, prefix="/api")
app.include_router(synthesize.router, prefix="/api")
app.include_router(youtube.router, prefix="/api")
app.include_router(producthunt.router, prefix="/api")
app.include_router(wechat.router, prefix="/api")
app.include_router(v2ex.router, prefix="/api")
app.include_router(kr.router, prefix="/api")
app.include_router(studio.router, prefix="/api")
app.include_router(juejin.router, prefix="/api")
app.include_router(publish_accounts.router, prefix="/api")
app.include_router(profiles.router, prefix="/api")

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


@app.post("/api/analyze/all")
async def trigger_full_analysis():
    from analyzer import run_full_analysis
    async with SessionLocal() as db:
        result = await run_full_analysis(db)
    return result
