"""Application config store with in-process cache."""
import asyncio
import time
from typing import Any

from sqlalchemy import select
from database import SessionLocal
from models import AppSetting

DEFAULTS: dict[str, str] = {
    "llm_provider": "openai",
    "llm_model": "",
    "llm_api_key": "",
    "llm_base_url": "",
    "embedding_api_key": "",
    "embedding_base_url": "",
    "embedding_model": "text-embedding-3-small",
    "embedding_similarity_threshold": "0.82",
    "rsshub_base": "http://127.0.0.1:1200",
    "collect_interval_minutes": "15",
    "github_interval_minutes": "1",
    "github_trending_interval_hours": "6",
    "camofox_url": "http://localhost:9377",
    "camofox_api_key": "",
    "camofox_user_id": "wemedia_x",         # userId for the X session
    "camofox_novnc_url": "http://localhost:6080/vnc.html",  # web VNC address
    "ref_categories": "吐槽锐评,沙雕搞笑,温情共鸣,反转梗,金句格言,冷知识科普,热点观点,生活观察,职场打工,情感两性,其他",
}

# Provider presets: label + default base_url + hint for default model
# Models are fetched live from the provider API, not hardcoded.
PROVIDERS: dict[str, dict[str, str]] = {
    "openai":    {"label": "OpenAI",            "base_url": "https://api.openai.com/v1",                         "default_model": "gpt-4o-mini"},
    "anthropic": {"label": "Anthropic",          "base_url": "https://api.anthropic.com",                         "default_model": "claude-3-5-haiku-20241022"},
    "deepseek":  {"label": "DeepSeek",           "base_url": "https://api.deepseek.com/v1",                       "default_model": "deepseek-chat"},
    "qwen":      {"label": "通义千问 (Qwen)",    "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "default_model": "qwen-turbo"},
    "moonshot":  {"label": "Moonshot (Kimi)",    "base_url": "https://api.moonshot.cn/v1",                        "default_model": "moonshot-v1-8k"},
    "zhipu":     {"label": "智谱 (GLM)",         "base_url": "https://open.bigmodel.cn/api/paas/v4",              "default_model": "glm-4-flash"},
    "minimax":   {"label": "MiniMax (海螺)",     "base_url": "https://api.minimax.chat/v1",                       "default_model": "MiniMax-Text-01"},
    "xiaomi":    {"label": "小米 (MiMo)",        "base_url": "",                                                  "default_model": "MiMo-7B-RL"},
    "custom":    {"label": "自定义",             "base_url": "",                                                  "default_model": ""},
}


def effective_model(cfg: dict[str, str]) -> str:
    model = cfg.get("llm_model", "").strip()
    if model:
        return model
    return PROVIDERS.get(cfg.get("llm_provider", ""), {}).get("default_model", "")


def effective_base_url(cfg: dict[str, str]) -> str:
    override = cfg.get("llm_base_url", "").strip()
    if override:
        return override
    return PROVIDERS.get(cfg.get("llm_provider", ""), {}).get("base_url", "")


# ── Cache ─────────────────────────────────────────────────────────────────────

_cache: dict[str, str] = {}
_cache_ts: float = 0.0
_CACHE_TTL = 60.0
_lock = asyncio.Lock()


async def get_config() -> dict[str, str]:
    global _cache, _cache_ts
    now = time.monotonic()
    async with _lock:
        if now - _cache_ts < _CACHE_TTL and _cache:
            return dict(_cache)
        async with SessionLocal() as db:
            rows = (await db.execute(select(AppSetting))).scalars().all()
        merged = dict(DEFAULTS)
        for row in rows:
            merged[row.key] = row.value
        _cache = merged
        _cache_ts = now
        return dict(merged)


async def set_config(updates: dict[str, Any]) -> None:
    global _cache, _cache_ts
    async with SessionLocal() as db:
        for key, value in updates.items():
            row = await db.get(AppSetting, key)
            if row:
                row.value = str(value)
            else:
                db.add(AppSetting(key=key, value=str(value)))
        await db.commit()
    async with _lock:
        _cache = {}
        _cache_ts = 0.0
