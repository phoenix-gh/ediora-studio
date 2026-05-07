from fastapi import APIRouter, Body, Query, Request
from pydantic import BaseModel
from typing import Optional
from datetime import datetime
import httpx

from config import get_config, set_config, PROVIDERS, effective_model, effective_base_url

router = APIRouter(prefix="/settings", tags=["settings"])


# ── Schemas ───────────────────────────────────────────────────────────────────

class ProviderInfo(BaseModel):
    key: str
    label: str
    base_url: str
    default_model: str


class SettingsOut(BaseModel):
    llm_provider: str
    llm_model: str
    llm_base_url: str
    llm_effective_base_url: str
    llm_api_key_set: bool
    llm_api_key_preview: str
    embedding_model: str
    embedding_base_url: str
    embedding_api_key_set: bool
    embedding_api_key_preview: str
    embedding_similarity_threshold: float
    rsshub_base: str
    github_token_set: bool
    github_token_preview: str
    collect_interval_minutes: int
    github_interval_minutes: int
    github_trending_interval_hours: int
    camofox_url: str
    camofox_api_key_set: bool
    camofox_user_id: str
    camofox_novnc_url: str
    x_collect_enabled: bool
    x_cookies_set: bool
    x_collect_interval_minutes: int
    x_follower_threshold: int
    x_post_window_hours: int
    x_post_lookback_hours: int
    x_timeline_scrolls: int
    twitterapi_io_key_set: bool
    twitterapi_io_collect_enabled: bool
    x_search_queries: str
    tl1_collect_enabled: bool
    tl1_collect_interval_seconds: int
    tl1_trending_hours: int
    x_post_classify_enabled: bool
    x_post_classify_prompt: str
    arxiv_categories: str
    arxiv_collect_interval_hours: int
    providers: list[ProviderInfo]


class SettingsUpdate(BaseModel):
    llm_provider: Optional[str] = None
    llm_model: Optional[str] = None
    llm_api_key: Optional[str] = None
    llm_base_url: Optional[str] = None
    embedding_model: Optional[str] = None
    embedding_base_url: Optional[str] = None
    embedding_api_key: Optional[str] = None
    embedding_similarity_threshold: Optional[float] = None
    rsshub_base: Optional[str] = None
    github_token: Optional[str] = None
    collect_interval_minutes: Optional[int] = None
    github_interval_minutes: Optional[int] = None
    github_trending_interval_hours: Optional[int] = None
    camofox_url: Optional[str] = None
    camofox_api_key: Optional[str] = None
    camofox_user_id: Optional[str] = None
    camofox_novnc_url: Optional[str] = None
    x_cookies: Optional[str] = None
    x_collect_enabled: Optional[bool] = None
    x_collect_interval_minutes: Optional[int] = None
    x_follower_threshold: Optional[int] = None
    x_post_window_hours: Optional[int] = None
    x_post_lookback_hours: Optional[int] = None
    x_timeline_scrolls: Optional[int] = None
    twitterapi_io_key: Optional[str] = None
    twitterapi_io_collect_enabled: Optional[bool] = None
    x_search_queries: Optional[str] = None
    tl1_collect_enabled: Optional[bool] = None
    tl1_collect_interval_seconds: Optional[int] = None
    tl1_trending_hours: Optional[int] = None
    x_post_classify_enabled: Optional[bool] = None
    x_post_classify_prompt: Optional[str] = None
    arxiv_categories: Optional[str] = None
    arxiv_collect_interval_hours: Optional[int] = None


class FetchModelsRequest(BaseModel):
    provider: Optional[str] = None   # if None, use stored config
    api_key: Optional[str] = None    # if None, use stored config
    base_url: Optional[str] = None   # if None, derive from provider/stored


# ── Helpers ───────────────────────────────────────────────────────────────────

def _build_out(cfg: dict) -> SettingsOut:
    api_key = cfg.get("llm_api_key", "")
    gh_token = cfg.get("github_token", "")
    embedding_api_key = cfg.get("embedding_api_key", "")
    return SettingsOut(
        llm_provider=cfg.get("llm_provider", "openai"),
        llm_model=cfg.get("llm_model", ""),
        llm_base_url=cfg.get("llm_base_url", ""),
        llm_effective_base_url=effective_base_url(cfg),
        llm_api_key_set=bool(api_key),
        llm_api_key_preview=f"…{api_key[-4:]}" if len(api_key) >= 4 else "",
        embedding_model=cfg.get("embedding_model", "text-embedding-3-small"),
        embedding_base_url=cfg.get("embedding_base_url", ""),
        embedding_api_key_set=bool(embedding_api_key),
        embedding_api_key_preview=f"…{embedding_api_key[-4:]}" if len(embedding_api_key) >= 4 else "",
        embedding_similarity_threshold=float(cfg.get("embedding_similarity_threshold", "0.82")),
        collect_interval_minutes=max(1, int(cfg.get("collect_interval_minutes", 15))),
        github_interval_minutes=max(1, int(cfg.get("github_interval_minutes", 1))),
        github_trending_interval_hours=max(1, int(cfg.get("github_trending_interval_hours", 6))),
        rsshub_base=cfg.get("rsshub_base", "http://127.0.0.1:1200"),
        github_token_set=bool(gh_token),
        github_token_preview=f"…{gh_token[-4:]}" if len(gh_token) >= 4 else "",
        camofox_url=cfg.get("camofox_url", "http://localhost:9377"),
        camofox_api_key_set=bool(cfg.get("camofox_api_key", "")),
        camofox_user_id=cfg.get("camofox_user_id", "wemedia_x"),
        camofox_novnc_url=cfg.get("camofox_novnc_url", "http://localhost:6080/vnc.html"),
        x_collect_enabled=cfg.get("x_collect_enabled", "1") == "1",
        x_cookies_set=bool(cfg.get("x_cookies", "")),
        x_collect_interval_minutes=max(1, int(cfg.get("x_collect_interval_minutes", 30))),
        x_follower_threshold=max(0, int(cfg.get("x_follower_threshold", 5000))),
        x_post_window_hours=max(1, int(cfg.get("x_post_window_hours", 4))),
        x_post_lookback_hours=max(1, int(cfg.get("x_post_lookback_hours", 24))),
        x_timeline_scrolls=max(1, int(cfg.get("x_timeline_scrolls", 5))),
        twitterapi_io_key_set=bool(cfg.get("twitterapi_io_key", "")),
        twitterapi_io_collect_enabled=cfg.get("twitterapi_io_collect_enabled", "1") == "1",
        x_search_queries=cfg.get("x_search_queries", ""),
        tl1_collect_enabled=cfg.get("tl1_collect_enabled", "1") == "1",
        tl1_collect_interval_seconds=max(10, int(cfg.get("tl1_collect_interval_seconds", 30))),
        tl1_trending_hours=max(1, min(24, int(cfg.get("tl1_trending_hours", 2)))),
        x_post_classify_enabled=cfg.get("x_post_classify_enabled", "1") == "1",
        x_post_classify_prompt=cfg.get("x_post_classify_prompt", ""),
        arxiv_categories=cfg.get("arxiv_categories", "cs.AI,cs.CL,cs.CV,cs.LG"),
        arxiv_collect_interval_hours=max(1, int(cfg.get("arxiv_collect_interval_hours", 6))),
        providers=[
            ProviderInfo(key=k, label=v["label"], base_url=v["base_url"], default_model=v["default_model"])
            for k, v in PROVIDERS.items()
        ],
    )


async def _fetch_models_openai_compat(base_url: str, api_key: str) -> list[str]:
    """GET {base_url}/models with Bearer auth, return sorted model id list."""
    url = base_url.rstrip("/") + "/models"
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(url, headers={"Authorization": f"Bearer {api_key}"})
        resp.raise_for_status()
    data = resp.json()
    models = [m["id"] for m in data.get("data", []) if isinstance(m, dict) and "id" in m]
    return sorted(models)


async def _fetch_models_anthropic(api_key: str) -> list[str]:
    """GET https://api.anthropic.com/v1/models with x-api-key header."""
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(
            "https://api.anthropic.com/v1/models",
            headers={"x-api-key": api_key, "anthropic-version": "2023-06-01"},
        )
        resp.raise_for_status()
    data = resp.json()
    models = [m["id"] for m in data.get("data", []) if isinstance(m, dict) and "id" in m]
    return sorted(models)


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("", response_model=SettingsOut)
async def get_settings():
    return _build_out(await get_config())


@router.put("", response_model=SettingsOut)
async def update_settings(body: SettingsUpdate, request: Request):
    updates: dict = {}
    if body.llm_provider is not None:
        updates["llm_provider"] = body.llm_provider
        updates.setdefault("llm_model", "")
        updates.setdefault("llm_base_url", "")
    if body.llm_model is not None:
        updates["llm_model"] = body.llm_model
    if body.llm_api_key is not None:
        updates["llm_api_key"] = body.llm_api_key
    if body.llm_base_url is not None:
        updates["llm_base_url"] = body.llm_base_url
    if body.embedding_model is not None:
        updates["embedding_model"] = body.embedding_model
    if body.embedding_base_url is not None:
        updates["embedding_base_url"] = body.embedding_base_url
    if body.embedding_api_key is not None:
        updates["embedding_api_key"] = body.embedding_api_key
    if body.embedding_similarity_threshold is not None:
        updates["embedding_similarity_threshold"] = str(max(0.5, min(0.98, body.embedding_similarity_threshold)))
    if body.rsshub_base is not None:
        updates["rsshub_base"] = body.rsshub_base
    if body.github_token is not None:
        updates["github_token"] = body.github_token
    if body.collect_interval_minutes is not None:
        updates["collect_interval_minutes"] = str(max(1, body.collect_interval_minutes))
    if body.github_interval_minutes is not None:
        updates["github_interval_minutes"] = str(max(1, body.github_interval_minutes))
    if body.github_trending_interval_hours is not None:
        updates["github_trending_interval_hours"] = str(max(1, body.github_trending_interval_hours))
    if body.camofox_url is not None:
        updates["camofox_url"] = body.camofox_url
    if body.camofox_api_key is not None:
        updates["camofox_api_key"] = body.camofox_api_key
    if body.camofox_user_id is not None:
        updates["camofox_user_id"] = body.camofox_user_id
    if body.camofox_novnc_url is not None:
        updates["camofox_novnc_url"] = body.camofox_novnc_url
    if body.x_collect_enabled is not None:
        updates["x_collect_enabled"] = "1" if body.x_collect_enabled else "0"
    if body.x_cookies is not None:
        updates["x_cookies"] = body.x_cookies
    if body.x_collect_interval_minutes is not None:
        updates["x_collect_interval_minutes"] = str(max(1, body.x_collect_interval_minutes))
    if body.x_follower_threshold is not None:
        updates["x_follower_threshold"] = str(max(0, body.x_follower_threshold))
    if body.x_post_window_hours is not None:
        updates["x_post_window_hours"] = str(max(1, body.x_post_window_hours))
    if body.x_post_lookback_hours is not None:
        updates["x_post_lookback_hours"] = str(max(1, body.x_post_lookback_hours))
    if body.x_timeline_scrolls is not None:
        updates["x_timeline_scrolls"] = str(max(1, min(20, body.x_timeline_scrolls)))
    if body.twitterapi_io_key is not None:
        updates["twitterapi_io_key"] = body.twitterapi_io_key
    if body.twitterapi_io_collect_enabled is not None:
        updates["twitterapi_io_collect_enabled"] = "1" if body.twitterapi_io_collect_enabled else "0"
    if body.x_search_queries is not None:
        updates["x_search_queries"] = body.x_search_queries
    if body.tl1_collect_enabled is not None:
        updates["tl1_collect_enabled"] = "1" if body.tl1_collect_enabled else "0"
    if body.tl1_collect_interval_seconds is not None:
        updates["tl1_collect_interval_seconds"] = str(max(10, body.tl1_collect_interval_seconds))
    if body.tl1_trending_hours is not None:
        updates["tl1_trending_hours"] = str(max(1, min(24, body.tl1_trending_hours)))
    if body.x_post_classify_enabled is not None:
        updates["x_post_classify_enabled"] = "1" if body.x_post_classify_enabled else "0"
    if body.x_post_classify_prompt is not None:
        updates["x_post_classify_prompt"] = body.x_post_classify_prompt
    if body.arxiv_categories is not None:
        updates["arxiv_categories"] = body.arxiv_categories
    if body.arxiv_collect_interval_hours is not None:
        updates["arxiv_collect_interval_hours"] = str(max(1, body.arxiv_collect_interval_hours))
    if updates:
        await set_config(updates)

    # Reschedule jobs if intervals changed
    interval_keys = {"collect_interval_minutes", "github_interval_minutes", "tl1_collect_interval_seconds"}
    if interval_keys & set(updates):
        cfg = await get_config()
        try:
            sched = request.app.state.scheduler
            sched.reschedule_job(
                "collect_analyze", trigger="interval",
                minutes=max(1, int(cfg.get("collect_interval_minutes", 15))),
            )
            sched.reschedule_job(
                "github_collect", trigger="interval",
                minutes=max(1, int(cfg.get("github_interval_minutes", 1))),
            )
            sched.reschedule_job(
                "tl1_collect", trigger="interval",
                seconds=max(10, int(cfg.get("tl1_collect_interval_seconds", 30))),
            )
        except Exception as e:
            print(f"[settings] reschedule failed: {e}")

    return _build_out(await get_config())


@router.post("/fetch-models")
async def fetch_models(body: FetchModelsRequest):
    """
    Call the provider's model list API and return available model IDs.
    Accepts optional overrides so the frontend can preview before saving.
    """
    cfg = await get_config()

    provider = body.provider or cfg.get("llm_provider", "openai")
    api_key  = body.api_key  or cfg.get("llm_api_key", "")

    # Resolve base_url: request override → stored user override → provider preset
    if body.base_url:
        base_url = body.base_url
    else:
        test_cfg = dict(cfg)
        if body.provider:
            test_cfg["llm_provider"] = body.provider
        base_url = effective_base_url(test_cfg)

    if not api_key:
        return {"ok": False, "error": "API key not set", "models": []}

    try:
        if provider == "anthropic" and "anthropic.com" in base_url:
            models = await _fetch_models_anthropic(api_key)
        else:
            if not base_url:
                return {"ok": False, "error": "No endpoint configured", "models": []}
            models = await _fetch_models_openai_compat(base_url, api_key)
        return {"ok": True, "models": models}
    except httpx.HTTPStatusError as e:
        return {"ok": False, "error": f"HTTP {e.response.status_code}: {e.response.text[:200]}", "models": []}
    except Exception as e:
        return {"ok": False, "error": str(e), "models": []}


@router.post("/test")
async def test_llm():
    """Send a minimal LLM request to verify current config."""
    try:
        from llm import _call
        text = await _call('Reply with just "OK".', max_tokens=10)
        return {"ok": True, "response": text.strip()}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ── Collect Logs ──────────────────────────────────────────────────────────────

class LogEntry(BaseModel):
    id: int
    job: str
    status: str
    message: str
    detail: str
    created_at: datetime

    model_config = {"from_attributes": True}


@router.get("/logs", response_model=list[LogEntry])
async def get_logs(
    limit: int = Query(100, le=500),
    job: Optional[str] = Query(None),
):
    from database import get_db
    from models import CollectLog
    from sqlalchemy import select, desc
    from database import SessionLocal
    async with SessionLocal() as db:
        q = select(CollectLog).order_by(desc(CollectLog.id)).limit(limit)
        if job:
            q = q.where(CollectLog.job == job)
        rows = (await db.execute(q)).scalars().all()
    return rows
