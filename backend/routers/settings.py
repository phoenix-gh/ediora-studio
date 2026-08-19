from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator, model_validator
from typing import Literal, Optional
from datetime import datetime, timezone
import json
import httpx
from pathlib import Path
import tempfile
from urllib.parse import urlsplit
import wave
import logging

from config import (
    PROVIDERS,
    effective_base_url,
    effective_comfyui_auth_token,
    effective_comfyui_base_url,
    effective_comfyui_runtime_provider,
    effective_comfyui_shot_seconds,
    effective_heygen_api_key,
    effective_model,
    effective_xiangongyun_api_token,
    effective_xiangongyun_base_url,
    effective_xiangongyun_default_instance_id,
    get_config,
    set_config,
)
from collection_proxy import (
    apply_collection_proxy,
    collection_proxy_browser_state,
    normalize_collection_proxy_url,
)
from log_redaction import redact_secret_text
from runtime_config import get_runtime_settings
import telegram_notifier
from transcription_service import (
    TranscriptionError,
    TranscriptionRequest,
    transcribe_audio,
)
from database import get_db
from llm_adapters import (
    AdapterResolutionError,
    LLMAdapterInput,
    LLMAdapterPublic,
    public_adapters,
    parse_stored_adapters,
    configured_default_adapter_id,
    resolve_adapter,
    resolve_test_adapter,
    save_adapter_payloads,
)
from models import XSubscription
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from worker_auth import require_worker_token
from text_video_templates import normalize_text_video_template_default_map
from xiangongyun_client import XiangongyunClient, XiangongyunError

router = APIRouter(prefix="/settings", tags=["settings"])
logger = logging.getLogger(__name__)


# ── Schemas ───────────────────────────────────────────────────────────────────

class ProviderInfo(BaseModel):
    key: str
    label: str
    base_url: str
    default_model: str


class WebSearchProviderConfig(BaseModel):
    key: Literal["searxng"]
    enabled: bool = True
    base_url: str = ""
    timeout_seconds: int = 12

    @field_validator("base_url")
    @classmethod
    def validate_base_url(cls, value: str) -> str:
        value = value.strip().rstrip("/")
        if not value:
            return ""
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("must be an HTTP(S) URL")
        return value

    @field_validator("timeout_seconds")
    @classmethod
    def validate_timeout(cls, value: int) -> int:
        if not 1 <= value <= 30:
            raise ValueError("must be between 1 and 30 seconds")
        return value

    @model_validator(mode="after")
    def require_url_when_enabled(self):
        if self.enabled and not self.base_url:
            raise ValueError("Base URL is required when provider is enabled")
        return self


class WebFetchProviderConfig(BaseModel):
    key: Literal["direct", "jina_reader", "camofox"]
    enabled: bool = True
    base_url: str = ""
    timeout_seconds: int = 12

    @field_validator("base_url")
    @classmethod
    def validate_base_url(cls, value: str) -> str:
        value = value.strip().rstrip("/")
        if not value:
            return ""
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("must be an HTTP(S) URL")
        return value

    @field_validator("timeout_seconds")
    @classmethod
    def validate_timeout(cls, value: int) -> int:
        if not 1 <= value <= 30:
            raise ValueError("must be between 1 and 30 seconds")
        return value

    @model_validator(mode="after")
    def require_jina_url_when_enabled(self):
        if self.enabled and self.key == "jina_reader" and not self.base_url:
            raise ValueError("Base URL is required when Jina Reader is enabled")
        return self


class SettingsOut(BaseModel):
    llm_provider: str
    llm_model: str
    llm_base_url: str
    llm_effective_base_url: str
    llm_api_key_set: bool
    llm_api_key_preview: str
    llm_adapters: list[LLMAdapterPublic]
    llm_text_default_adapter_id: str
    llm_image_default_adapter_id: str
    llm_information_filtering_adapter_id: str
    image_model: str
    image_base_url: str
    image_api_key_set: bool
    image_api_key_preview: str
    prompt_generation_history_limit: int
    heygen_api_key_set: bool
    heygen_api_key_preview: str
    comfyui_base_url: str
    comfyui_auth_token_set: bool
    comfyui_auth_token_preview: str
    comfyui_runtime_provider: Literal["direct", "xiangongyun"]
    xiangongyun_base_url: str
    xiangongyun_api_token_set: bool
    xiangongyun_api_token_preview: str
    xiangongyun_default_instance_id: str
    comfyui_min_shot_seconds: int
    comfyui_max_shot_seconds: int
    transcription_provider: str
    transcription_model: str
    transcription_base_url: str
    transcription_api_key_set: bool
    transcription_api_key_preview: str
    transcription_max_duration_seconds: int
    transcription_max_audio_bytes: int
    speech_provider: str
    speech_model: str
    speech_base_url: str
    speech_api_key_set: bool
    speech_api_key_preview: str
    speech_default_voice: str
    text_video_template_defaults: dict[str, dict]
    youtube_cookies_set: bool
    rsshub_base: str
    collection_proxy_url: str
    collection_proxy_url_set: bool
    collection_proxy_url_preview: str
    github_token_set: bool
    github_token_preview: str
    github_interval_minutes: int
    github_trending_interval_hours: int
    camofox_url: str
    camofox_api_key_set: bool
    camofox_user_id: str
    camofox_novnc_url: str
    arxiv_categories: str
    arxiv_collect_interval_hours: int
    x_collect_interval_minutes: int
    telegram_bot_token_set: bool
    telegram_bot_token_preview: str
    telegram_chat_id: str
    telegram_test_status: Literal["", "success", "failed"]
    telegram_last_tested_at: str
    telegram_last_test_error: str
    ref_collect_interval_minutes: int
    ref_classify_interval_minutes: int
    clean_batch_size: int
    wechat_tunnel_enabled: bool
    wechat_tunnel_ssh_host: str
    wechat_tunnel_ssh_port: int
    wechat_tunnel_ssh_user: str
    wechat_tunnel_ssh_key_path: str
    wechat_tunnel_local_host: str
    wechat_tunnel_local_port: int
    wechat_tunnel_remote_host: str
    wechat_tunnel_remote_port: int
    wechat_tunnel_extra_args: str
    blog_api_base: str
    blog_api_token_set: bool
    blog_api_token_preview: str
    web_search_providers: list[WebSearchProviderConfig]
    web_fetch_providers: list[WebFetchProviderConfig]
    providers: list[ProviderInfo]


class TranscriptionStatusOut(BaseModel):
    provider: Literal["local-whisper", "openai-compatible"]
    status: Literal["unavailable", "preparing", "ready", "busy", "error"]
    model: str
    device: str
    compute_type: str
    error: str


class SettingsUpdate(BaseModel):
    llm_provider: Optional[str] = None
    llm_model: Optional[str] = None
    llm_api_key: Optional[str] = None
    llm_base_url: Optional[str] = None
    llm_adapters: Optional[list[LLMAdapterInput]] = None
    llm_text_default_adapter_id: Optional[str] = None
    llm_image_default_adapter_id: Optional[str] = None
    llm_information_filtering_adapter_id: Optional[str] = None
    image_model: Optional[str] = None
    image_api_key: Optional[str] = None
    image_base_url: Optional[str] = None
    prompt_generation_history_limit: Optional[int] = Field(
        default=None,
        ge=1,
        le=20,
    )
    heygen_api_key: Optional[str] = None
    comfyui_base_url: Optional[str] = None
    comfyui_auth_token: Optional[str] = None
    comfyui_runtime_provider: Optional[Literal["direct", "xiangongyun"]] = None
    xiangongyun_base_url: Optional[str] = None
    xiangongyun_api_token: Optional[str] = None
    xiangongyun_default_instance_id: Optional[str] = None
    comfyui_min_shot_seconds: Optional[int] = Field(default=None, ge=1, le=15)
    comfyui_max_shot_seconds: Optional[int] = Field(default=None, ge=1, le=15)
    transcription_provider: Optional[str] = None
    transcription_model: Optional[str] = None
    transcription_base_url: Optional[str] = None
    transcription_api_key: Optional[str] = None
    transcription_clear_api_key: Optional[bool] = None
    transcription_max_duration_seconds: Optional[int] = None
    transcription_max_audio_bytes: Optional[int] = None
    speech_provider: Optional[str] = None
    speech_model: Optional[str] = None
    speech_base_url: Optional[str] = None
    speech_api_key: Optional[str] = None
    speech_clear_api_key: Optional[bool] = None
    speech_default_voice: Optional[str] = None
    text_video_template_defaults: dict[str, dict] | None = None
    youtube_cookies: Optional[str] = None
    rsshub_base: Optional[str] = None
    collection_proxy_url: Optional[str] = None
    github_token: Optional[str] = None
    github_interval_minutes: Optional[int] = None
    github_trending_interval_hours: Optional[int] = None
    camofox_url: Optional[str] = None
    camofox_api_key: Optional[str] = None
    camofox_user_id: Optional[str] = None
    camofox_novnc_url: Optional[str] = None
    arxiv_categories: Optional[str] = None
    arxiv_collect_interval_hours: Optional[int] = None
    x_collect_interval_minutes: Optional[int] = None
    telegram_bot_token: Optional[str] = None
    telegram_chat_id: Optional[str] = None
    ref_collect_interval_minutes: Optional[int] = None
    ref_classify_interval_minutes: Optional[int] = None
    clean_batch_size: Optional[int] = None
    wechat_tunnel_enabled: Optional[bool] = None
    wechat_tunnel_ssh_host: Optional[str] = None
    wechat_tunnel_ssh_port: Optional[int] = None
    wechat_tunnel_ssh_user: Optional[str] = None
    wechat_tunnel_ssh_key_path: Optional[str] = None
    wechat_tunnel_local_host: Optional[str] = None
    wechat_tunnel_local_port: Optional[int] = None
    wechat_tunnel_remote_host: Optional[str] = None
    wechat_tunnel_remote_port: Optional[int] = None
    wechat_tunnel_extra_args: Optional[str] = None
    blog_api_base: Optional[str] = None
    blog_api_token: Optional[str] = None
    web_search_providers: Optional[list[WebSearchProviderConfig]] = None
    web_fetch_providers: Optional[list[WebFetchProviderConfig]] = None

    @field_validator("collection_proxy_url")
    @classmethod
    def validate_collection_proxy_url(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        return normalize_collection_proxy_url(value)


class FetchModelsRequest(BaseModel):
    provider: Optional[str] = None   # if None, use stored config
    api_key: Optional[str] = None    # if None, use stored config
    base_url: Optional[str] = None   # if None, derive from provider/stored


class TestLLMAdapterRequest(BaseModel):
    adapter: LLMAdapterInput


class ImageRuntimeConfig(BaseModel):
    adapter_id: str
    protocol: str
    api_key: str
    model: str
    base_url: str
    image_response_format: Literal["url", "base64"]


class AiRuntimeConfig(BaseModel):
    """Server-to-server model credentials for the local AI worker."""
    adapter_id: str
    protocol: str
    api_key: str
    model: str
    base_url: str
    image_response_format: Literal["url", "base64"]
    image: ImageRuntimeConfig


class SpeechRuntimeConfig(BaseModel):
    provider: str
    model: str
    base_url: str
    api_key: str
    default_voice: str


def _prompt_generation_history_limit(cfg: dict) -> int:
    try:
        value = int(cfg.get("prompt_generation_history_limit", "3"))
    except (TypeError, ValueError):
        return 3
    return value if 1 <= value <= 20 else 3


def _build_out(cfg: dict) -> SettingsOut:
    import blog_client
    api_key = cfg.get("llm_api_key", "")
    image_api_key = cfg.get("image_api_key", "")
    heygen_api_key = effective_heygen_api_key(cfg)
    comfyui_auth_token = effective_comfyui_auth_token(cfg)
    comfyui_runtime_provider = effective_comfyui_runtime_provider(cfg)
    xiangongyun_base_url = effective_xiangongyun_base_url(cfg)
    xiangongyun_api_token = effective_xiangongyun_api_token(cfg)
    comfyui_min_seconds, comfyui_max_seconds = effective_comfyui_shot_seconds(cfg)
    transcription_api_key = cfg.get("transcription_api_key", "")
    speech_api_key = cfg.get("speech_api_key", "")
    gh_token = cfg.get("github_token", "")
    telegram_token = cfg.get("telegram_bot_token", "")
    blog_base, blog_token = blog_client.effective_blog_config(cfg)
    try:
        proxy_url, proxy_set, proxy_preview = collection_proxy_browser_state(
            cfg.get("collection_proxy_url", ""),
        )
    except ValueError:
        logger.warning("Ignoring malformed collection proxy configuration")
        proxy_url, proxy_set, proxy_preview = "", False, ""
    try:
        raw_search_providers = json.loads(cfg.get("web_search_providers", "[]"))
    except json.JSONDecodeError:
        raw_search_providers = []
    web_search_providers = [
        WebSearchProviderConfig.model_validate(provider)
        for provider in raw_search_providers if isinstance(provider, dict)
    ] if isinstance(raw_search_providers, list) else []
    try:
        raw_fetch_providers = json.loads(cfg.get("web_fetch_providers", "[]"))
    except json.JSONDecodeError:
        raw_fetch_providers = []
    web_fetch_providers = [
        WebFetchProviderConfig.model_validate(provider)
        for provider in raw_fetch_providers if isinstance(provider, dict)
    ] if isinstance(raw_fetch_providers, list) else []
    try:
        raw_text_video_template_defaults = json.loads(
            cfg.get("text_video_template_defaults", "{}"),
        )
        text_video_template_defaults = (
            normalize_text_video_template_default_map(
                raw_text_video_template_defaults,
            )
        )
    except (json.JSONDecodeError, TypeError, ValueError) as error:
        logger.warning(
            "Ignoring malformed text video template defaults: %s",
            error,
        )
        text_video_template_defaults = (
            normalize_text_video_template_default_map(None)
        )
    transcription_provider = cfg.get(
        "transcription_provider",
        "local-whisper",
    )
    runtime = get_runtime_settings()
    transcription_model = (
        runtime.local_asr_model
        if transcription_provider == "local-whisper"
        else cfg.get("transcription_model", "whisper-1")
    )
    return SettingsOut(
        llm_provider=cfg.get("llm_provider", "openai"),
        llm_model=cfg.get("llm_model", ""),
        llm_base_url=cfg.get("llm_base_url", ""),
        llm_effective_base_url=effective_base_url(cfg),
        llm_api_key_set=bool(api_key),
        llm_api_key_preview=f"…{api_key[-4:]}" if len(api_key) >= 4 else "",
        llm_adapters=public_adapters(cfg.get("llm_adapters", "[]")),
        llm_text_default_adapter_id=configured_default_adapter_id(cfg, "text"),
        llm_image_default_adapter_id=configured_default_adapter_id(cfg, "image"),
        llm_information_filtering_adapter_id=cfg.get(
            "llm_information_filtering_adapter_id", ""
        ).strip(),
        image_model=cfg.get("image_model", "gpt-image-1"),
        image_base_url=cfg.get("image_base_url", ""),
        image_api_key_set=bool(image_api_key),
        image_api_key_preview=f"…{image_api_key[-4:]}" if len(image_api_key) >= 4 else "",
        prompt_generation_history_limit=_prompt_generation_history_limit(cfg),
        heygen_api_key_set=bool(heygen_api_key),
        heygen_api_key_preview=f"…{heygen_api_key[-4:]}" if len(heygen_api_key) >= 4 else "",
        comfyui_base_url=effective_comfyui_base_url(cfg),
        comfyui_auth_token_set=bool(comfyui_auth_token),
        comfyui_auth_token_preview=(
            f"…{comfyui_auth_token[-4:]}" if len(comfyui_auth_token) >= 4 else ""
        ),
        comfyui_runtime_provider=comfyui_runtime_provider,
        xiangongyun_base_url=xiangongyun_base_url,
        xiangongyun_api_token_set=bool(xiangongyun_api_token),
        xiangongyun_api_token_preview=(
            f"…{xiangongyun_api_token[-4:]}"
            if len(xiangongyun_api_token) >= 4
            else ""
        ),
        xiangongyun_default_instance_id=(
            effective_xiangongyun_default_instance_id(cfg)
        ),
        comfyui_min_shot_seconds=comfyui_min_seconds,
        comfyui_max_shot_seconds=comfyui_max_seconds,
        transcription_provider=transcription_provider,
        transcription_model=transcription_model,
        transcription_base_url=cfg.get("transcription_base_url", "https://api.openai.com/v1"),
        transcription_api_key_set=bool(transcription_api_key),
        transcription_api_key_preview=f"…{transcription_api_key[-4:]}" if len(transcription_api_key) >= 4 else "",
        transcription_max_duration_seconds=max(60, int(cfg.get("transcription_max_duration_seconds", 7200))),
        transcription_max_audio_bytes=max(1024 * 1024, int(cfg.get("transcription_max_audio_bytes", 26214400))),
        speech_provider=cfg.get("speech_provider", "mimo"),
        speech_model=cfg.get("speech_model", "mimo-v2.5-tts"),
        speech_base_url=cfg.get(
            "speech_base_url",
            "https://api.xiaomimimo.com/v1",
        ).rstrip("/"),
        speech_api_key_set=bool(speech_api_key),
        speech_api_key_preview=(
            f"…{speech_api_key[-4:]}"
            if len(speech_api_key) >= 4
            else ""
        ),
        speech_default_voice=cfg.get(
            "speech_default_voice",
            "mimo_default",
        ),
        text_video_template_defaults=text_video_template_defaults,
        youtube_cookies_set=bool(cfg.get("youtube_cookies", "")),
        github_interval_minutes=max(1, int(cfg.get("github_interval_minutes", 1))),
        github_trending_interval_hours=max(1, int(cfg.get("github_trending_interval_hours", 6))),
        rsshub_base=cfg.get("rsshub_base", "http://127.0.0.1:1200"),
        collection_proxy_url=proxy_url,
        collection_proxy_url_set=proxy_set,
        collection_proxy_url_preview=proxy_preview,
        github_token_set=bool(gh_token),
        github_token_preview=f"…{gh_token[-4:]}" if len(gh_token) >= 4 else "",
        camofox_url=cfg.get("camofox_url", "http://localhost:9377"),
        camofox_api_key_set=bool(cfg.get("camofox_api_key", "")),
        camofox_user_id=cfg.get("camofox_user_id", "wemedia_x"),
        camofox_novnc_url=cfg.get("camofox_novnc_url", "http://localhost:6080/vnc.html"),
        arxiv_categories=cfg.get("arxiv_categories", "cs.AI,cs.CL,cs.CV,cs.LG"),
        arxiv_collect_interval_hours=max(1, int(cfg.get("arxiv_collect_interval_hours", 6))),
        x_collect_interval_minutes=max(5, min(1440, int(cfg.get("x_collect_interval_minutes", 15)))),
        telegram_bot_token_set=bool(telegram_token),
        telegram_bot_token_preview=f"…{telegram_token[-4:]}" if len(telegram_token) >= 4 else "",
        telegram_chat_id=cfg.get("telegram_chat_id", ""),
        telegram_test_status=cfg.get("telegram_test_status", ""),
        telegram_last_tested_at=cfg.get("telegram_last_tested_at", ""),
        telegram_last_test_error=cfg.get("telegram_last_test_error", ""),
        ref_collect_interval_minutes=max(1, int(cfg.get("ref_collect_interval_minutes", 15))),
        ref_classify_interval_minutes=max(1, int(cfg.get("ref_classify_interval_minutes", 60))),
        clean_batch_size=max(1, int(cfg.get("clean_batch_size", 20))),
        wechat_tunnel_enabled=str(cfg.get("wechat_tunnel_enabled", "0")).lower() in ("1", "true", "yes", "on"),
        wechat_tunnel_ssh_host=cfg.get("wechat_tunnel_ssh_host", ""),
        wechat_tunnel_ssh_port=max(1, int(cfg.get("wechat_tunnel_ssh_port", 22))),
        wechat_tunnel_ssh_user=cfg.get("wechat_tunnel_ssh_user", ""),
        wechat_tunnel_ssh_key_path=cfg.get("wechat_tunnel_ssh_key_path", ""),
        wechat_tunnel_local_host=cfg.get("wechat_tunnel_local_host", "127.0.0.1"),
        wechat_tunnel_local_port=max(1, int(cfg.get("wechat_tunnel_local_port", 18443))),
        wechat_tunnel_remote_host=cfg.get("wechat_tunnel_remote_host", "api.weixin.qq.com"),
        wechat_tunnel_remote_port=max(1, int(cfg.get("wechat_tunnel_remote_port", 443))),
        wechat_tunnel_extra_args=cfg.get("wechat_tunnel_extra_args", ""),
        blog_api_base=blog_base,
        blog_api_token_set=bool(blog_token),
        blog_api_token_preview=f"…{blog_token[-4:]}" if len(blog_token) >= 4 else "",
        web_search_providers=web_search_providers,
        web_fetch_providers=web_fetch_providers,
        providers=[
            ProviderInfo(key=k, label=v["label"], base_url=v["base_url"], default_model=v["default_model"])
            for k, v in PROVIDERS.items()
        ],
    )


def _validate_youtube_cookies(value: str) -> str:
    normalized = value.replace("\r\n", "\n").strip()
    if not normalized:
        return ""
    has_header = any(
        line.strip() == "# Netscape HTTP Cookie File"
        for line in normalized.splitlines()
    )
    has_cookie_row = any(
        len(line.split("\t")) == 7
        for line in normalized.splitlines()
        if line and (not line.startswith("#") or line.startswith("#HttpOnly_"))
    )
    if not (has_header and has_cookie_row):
        raise HTTPException(
            status_code=422,
            detail="YouTube Cookie 必须是 Netscape cookies.txt 格式",
        )
    return normalized


def _normalize_speech_base_url(value: str) -> str:
    normalized = value.strip().rstrip("/")
    if not normalized:
        return "https://api.xiaomimimo.com/v1"
    try:
        parsed = urlsplit(normalized)
        port = parsed.port
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail="MiMo Base URL 必须使用官方 HTTPS /v1 地址",
        ) from exc
    if (
        parsed.scheme != "https"
        or parsed.hostname != "api.xiaomimimo.com"
        or parsed.path != "/v1"
        or parsed.username is not None
        or parsed.password is not None
        or port not in {None, 443}
        or parsed.query
        or parsed.fragment
    ):
        raise HTTPException(
            status_code=422,
            detail="MiMo Base URL 必须使用官方 HTTPS /v1 地址",
        )
    return normalized


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


@router.get(
    "/ai-runtime",
    response_model=AiRuntimeConfig,
    include_in_schema=False,
    dependencies=[Depends(require_worker_token)],
)
async def get_ai_runtime_config(
    adapter_id: Optional[str] = Query(default=None),
    capability: Optional[Literal["text", "image"]] = Query(default=None),
    purpose: Optional[Literal["information_filtering"]] = Query(default=None),
):
    """Expose the configured provider only to the trusted local job worker.

    The open-source edition has no login/tenant boundary; this endpoint keeps
    credentials out of browser bundles while allowing the separately deployed
    Node worker to use the same Settings-page configuration.
    """
    cfg = await get_config()
    stored_adapters = parse_stored_adapters(cfg.get("llm_adapters", "[]"))

    def legacy_text_runtime() -> dict[str, str]:
        return {
            "adapter_id": "legacy-text",
            "protocol": "openai",
            "api_key": cfg.get("llm_api_key", ""),
            "model": effective_model(cfg),
            "base_url": effective_base_url(cfg),
            "image_response_format": "base64",
        }

    def legacy_image_runtime() -> dict[str, str]:
        return {
            "adapter_id": "legacy-image",
            "protocol": "openai",
            "api_key": cfg.get("image_api_key", ""),
            "model": cfg.get("image_model", "gpt-image-1"),
            "base_url": cfg.get("image_base_url", ""),
            "image_response_format": "base64",
        }

    if not stored_adapters:
        selected = legacy_image_runtime() if capability == "image" else legacy_text_runtime()
        image_runtime = legacy_image_runtime()
    else:
        try:
            selected_adapter = resolve_adapter(
                cfg,
                adapter_id=adapter_id,
                capability=capability or "text",
                purpose=purpose,
            )
        except AdapterResolutionError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        selected = selected_adapter.model_dump()
        selected["image_response_format"] = selected_adapter.image_response_format
        try:
            image_adapter = resolve_adapter(cfg, capability="image")
            image_runtime = image_adapter.model_dump()
            image_runtime["image_response_format"] = image_adapter.image_response_format
        except AdapterResolutionError:
            image_runtime = legacy_image_runtime()

    return AiRuntimeConfig(
        **selected,
        image=ImageRuntimeConfig(**image_runtime),
    )


@router.get(
    "/heygen-runtime",
    include_in_schema=False,
    dependencies=[Depends(require_worker_token)],
)
async def get_heygen_runtime_config():
    return {
        "api_key": effective_heygen_api_key(await get_config()),
        "base_url": "https://api.heygen.com",
    }


@router.get(
    "/comfyui-runtime",
    include_in_schema=False,
    dependencies=[Depends(require_worker_token)],
)
async def get_comfyui_runtime_config():
    cfg = await get_config()
    min_seconds, max_seconds = effective_comfyui_shot_seconds(cfg)
    return {
        "base_url": effective_comfyui_base_url(cfg),
        "auth_token": effective_comfyui_auth_token(cfg),
        "min_shot_seconds": min_seconds,
        "max_shot_seconds": max_seconds,
        "runtime_provider": effective_comfyui_runtime_provider(cfg),
    }


@router.get(
    "/xiangongyun-runtime",
    include_in_schema=False,
    dependencies=[Depends(require_worker_token)],
)
async def get_xiangongyun_runtime_config():
    cfg = await get_config()
    provider = effective_comfyui_runtime_provider(cfg)
    return {
        "provider": provider,
        "base_url": effective_xiangongyun_base_url(cfg),
        "api_token": (
            effective_xiangongyun_api_token(cfg)
            if provider == "xiangongyun"
            else ""
        ),
        "default_instance_id": (
            effective_xiangongyun_default_instance_id(cfg)
            if provider == "xiangongyun"
            else ""
        ),
    }


@router.get(
    "/transcription-runtime",
    include_in_schema=False,
    dependencies=[Depends(require_worker_token)],
)
async def get_transcription_runtime_config():
    cfg = await get_config()
    return {
        key: cfg.get(key, "")
        for key in (
            "transcription_provider",
            "transcription_model",
            "transcription_base_url",
            "transcription_api_key",
            "transcription_max_duration_seconds",
            "transcription_max_audio_bytes",
        )
    }


@router.get(
    "/speech-runtime",
    response_model=SpeechRuntimeConfig,
    include_in_schema=False,
    dependencies=[Depends(require_worker_token)],
)
async def get_speech_runtime_config():
    cfg = await get_config()
    return SpeechRuntimeConfig(
        provider=cfg.get("speech_provider", "mimo"),
        model=cfg.get("speech_model", "mimo-v2.5-tts"),
        base_url=cfg.get(
            "speech_base_url",
            "https://api.xiaomimimo.com/v1",
        ).strip().rstrip("/"),
        api_key=cfg.get("speech_api_key", "").strip(),
        default_voice=cfg.get(
            "speech_default_voice",
            "mimo_default",
        ).strip(),
    )


@router.put("", response_model=SettingsOut)
async def update_settings(
    body: SettingsUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    saved_cfg = await get_config()
    updates: dict = {}
    stored_adapters = parse_stored_adapters(saved_cfg.get("llm_adapters", "[]"))
    next_adapters = stored_adapters
    if body.llm_adapters is not None:
        try:
            next_adapters = save_adapter_payloads(body.llm_adapters, stored_adapters)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        old_ids = {item["id"] for item in stored_adapters}
        next_ids = {item["id"] for item in next_adapters}
        removed_ids = old_ids - next_ids
        subscription_adapter_column = getattr(XSubscription, "llm_adapter_id", None)
        if removed_ids and subscription_adapter_column is not None:
            referenced = await db.scalar(
                select(XSubscription.id)
                .where(subscription_adapter_column.in_(removed_ids))
                .limit(1)
            )
            if referenced is not None:
                raise HTTPException(
                    status_code=409,
                    detail="Adapter 仍被 X 订阅引用，请先解除订阅配置",
                )
        updates["llm_adapters"] = json.dumps(
            next_adapters,
            ensure_ascii=False,
            separators=(",", ":"),
        )

    valid_adapter_ids = {item["id"] for item in next_adapters}
    next_text_default_id = (
        body.llm_text_default_adapter_id.strip()
        if body.llm_text_default_adapter_id is not None
        else configured_default_adapter_id(saved_cfg, "text")
    )
    next_image_default_id = (
        body.llm_image_default_adapter_id.strip()
        if body.llm_image_default_adapter_id is not None
        else configured_default_adapter_id(saved_cfg, "image")
    )
    next_filter_id = (
        body.llm_information_filtering_adapter_id.strip()
        if body.llm_information_filtering_adapter_id is not None
        else saved_cfg.get("llm_information_filtering_adapter_id", "").strip()
    )
    selected_adapters = {item["id"]: item for item in next_adapters}
    for field_name, value, capability in (
        ("llm_text_default_adapter_id", next_text_default_id, "text"),
        ("llm_image_default_adapter_id", next_image_default_id, "image"),
        ("llm_information_filtering_adapter_id", next_filter_id, "text"),
    ):
        if value and value not in valid_adapter_ids:
            raise HTTPException(status_code=422, detail=f"{field_name} 引用的 Adapter 不存在")
        if value:
            adapter = selected_adapters[value]
            capability_field = f"supports_{capability}"
            if not adapter.get(capability_field):
                capability_label = "图片" if capability == "image" else "文本"
                raise HTTPException(
                    status_code=422,
                    detail=f"{field_name} 引用的 Adapter 不支持{capability_label}",
                )
    if (
        body.llm_text_default_adapter_id is not None
        or body.llm_adapters is not None
    ):
        updates["llm_text_default_adapter_id"] = next_text_default_id
    if (
        body.llm_image_default_adapter_id is not None
        or body.llm_adapters is not None
    ):
        updates["llm_image_default_adapter_id"] = next_image_default_id
    if (
        body.llm_information_filtering_adapter_id is not None
        or body.llm_adapters is not None
    ):
        updates["llm_information_filtering_adapter_id"] = next_filter_id
    if (
        body.llm_text_default_adapter_id is not None
        or body.llm_image_default_adapter_id is not None
        or body.llm_information_filtering_adapter_id is not None
        or body.llm_adapters is not None
    ):
        # Retire the old single-default setting after the new selectors have
        # been materialized. Older installations are still read as a
        # migration fallback by configured_default_adapter_id().
        updates["llm_default_adapter_id"] = ""

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
    if body.image_model is not None:
        updates["image_model"] = body.image_model.strip() or "gpt-image-1"
    if body.image_api_key is not None:
        updates["image_api_key"] = body.image_api_key.strip()
    if body.image_base_url is not None:
        updates["image_base_url"] = body.image_base_url.strip()
    if body.prompt_generation_history_limit is not None:
        updates["prompt_generation_history_limit"] = str(
            body.prompt_generation_history_limit
        )
    if body.heygen_api_key is not None:
        updates["heygen_api_key"] = body.heygen_api_key.strip()
    if body.comfyui_base_url is not None:
        comfyui_base_url = body.comfyui_base_url.strip().rstrip("/")
        if comfyui_base_url:
            parsed = urlsplit(comfyui_base_url)
            if parsed.scheme not in {"http", "https"} or not parsed.netloc:
                raise HTTPException(422, "ComfyUI 地址必须是 HTTP(S) URL")
        updates["comfyui_base_url"] = comfyui_base_url
    if body.comfyui_auth_token is not None:
        updates["comfyui_auth_token"] = body.comfyui_auth_token.strip()
    if body.comfyui_runtime_provider is not None:
        updates["comfyui_runtime_provider"] = body.comfyui_runtime_provider
    if body.xiangongyun_base_url is not None:
        xiangongyun_base_url = body.xiangongyun_base_url.strip().rstrip("/")
        if not xiangongyun_base_url:
            xiangongyun_base_url = "https://api.xiangongyun.com"
        parsed = urlsplit(xiangongyun_base_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise HTTPException(422, "仙宫云地址必须是 HTTP(S) URL")
        updates["xiangongyun_base_url"] = xiangongyun_base_url
    if body.xiangongyun_api_token is not None:
        # The settings page does not receive the stored token back. An empty
        # masked input therefore means "keep the existing secret".
        token = body.xiangongyun_api_token.strip()
        if token:
            updates["xiangongyun_api_token"] = token
    if body.xiangongyun_default_instance_id is not None:
        updates["xiangongyun_default_instance_id"] = (
            body.xiangongyun_default_instance_id.strip()
        )
    if (
        body.comfyui_min_shot_seconds is not None
        or body.comfyui_max_shot_seconds is not None
    ):
        current_min, current_max = effective_comfyui_shot_seconds(saved_cfg)
        next_min = (
            body.comfyui_min_shot_seconds
            if body.comfyui_min_shot_seconds is not None
            else current_min
        )
        next_max = (
            body.comfyui_max_shot_seconds
            if body.comfyui_max_shot_seconds is not None
            else current_max
        )
        if next_min > next_max:
            raise HTTPException(422, "单镜下限不能大于上限")
        if body.comfyui_min_shot_seconds is not None:
            updates["comfyui_min_shot_seconds"] = str(next_min)
        if body.comfyui_max_shot_seconds is not None:
            updates["comfyui_max_shot_seconds"] = str(next_max)
    if body.transcription_provider is not None:
        transcription_provider = body.transcription_provider.strip()
        if transcription_provider not in {
            "local-whisper",
            "openai-compatible",
        }:
            raise HTTPException(
                status_code=422,
                detail="不支持的语音转写服务商",
            )
        updates["transcription_provider"] = transcription_provider
    if body.transcription_model is not None:
        updates["transcription_model"] = body.transcription_model.strip() or "whisper-1"
    if body.transcription_base_url is not None:
        updates["transcription_base_url"] = body.transcription_base_url.strip().rstrip("/")
    if body.transcription_clear_api_key:
        updates["transcription_api_key"] = ""
    elif body.transcription_api_key is not None and body.transcription_api_key.strip():
        updates["transcription_api_key"] = body.transcription_api_key.strip()
    if body.transcription_max_duration_seconds is not None:
        updates["transcription_max_duration_seconds"] = str(max(60, body.transcription_max_duration_seconds))
    if body.transcription_max_audio_bytes is not None:
        updates["transcription_max_audio_bytes"] = str(max(1024 * 1024, body.transcription_max_audio_bytes))
    if body.speech_provider is not None:
        speech_provider = body.speech_provider.strip() or "mimo"
        if speech_provider != "mimo":
            raise HTTPException(
                status_code=422,
                detail="语音合成服务商目前仅支持 MiMo",
            )
        updates["speech_provider"] = speech_provider
    if body.speech_model is not None:
        updates["speech_model"] = (
            body.speech_model.strip()
            or "mimo-v2.5-tts"
        )
    if body.speech_base_url is not None:
        updates["speech_base_url"] = _normalize_speech_base_url(
            body.speech_base_url,
        )
    if body.speech_clear_api_key:
        updates["speech_api_key"] = ""
    elif body.speech_api_key is not None and body.speech_api_key.strip():
        updates["speech_api_key"] = body.speech_api_key.strip()
    if body.speech_default_voice is not None:
        updates["speech_default_voice"] = (
            body.speech_default_voice.strip()
            or "mimo_default"
        )
    if body.youtube_cookies is not None:
        updates["youtube_cookies"] = _validate_youtube_cookies(body.youtube_cookies)
    if body.rsshub_base is not None:
        updates["rsshub_base"] = body.rsshub_base
    if body.collection_proxy_url is not None:
        updates["collection_proxy_url"] = body.collection_proxy_url
    if body.github_token is not None:
        updates["github_token"] = body.github_token
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
    if body.arxiv_categories is not None:
        updates["arxiv_categories"] = body.arxiv_categories
    if body.arxiv_collect_interval_hours is not None:
        updates["arxiv_collect_interval_hours"] = str(max(1, body.arxiv_collect_interval_hours))
    if body.x_collect_interval_minutes is not None:
        updates["x_collect_interval_minutes"] = str(max(5, min(1440, body.x_collect_interval_minutes)))
    telegram_configuration_changed = False
    if body.telegram_bot_token is not None:
        telegram_token = body.telegram_bot_token.strip()
        if telegram_token:
            updates["telegram_bot_token"] = telegram_token
            telegram_configuration_changed = (
                telegram_configuration_changed
                or telegram_token != saved_cfg.get("telegram_bot_token", "")
            )
    if body.telegram_chat_id is not None:
        telegram_chat_id = body.telegram_chat_id.strip()
        updates["telegram_chat_id"] = telegram_chat_id
        telegram_configuration_changed = (
            telegram_configuration_changed
            or telegram_chat_id != saved_cfg.get("telegram_chat_id", "")
        )
    if telegram_configuration_changed:
        updates.update({
            "telegram_test_status": "",
            "telegram_last_tested_at": "",
            "telegram_last_test_error": "",
        })
    if body.ref_collect_interval_minutes is not None:
        updates["ref_collect_interval_minutes"] = str(max(1, body.ref_collect_interval_minutes))
    if body.ref_classify_interval_minutes is not None:
        updates["ref_classify_interval_minutes"] = str(max(1, body.ref_classify_interval_minutes))
    if body.clean_batch_size is not None:
        updates["clean_batch_size"] = str(max(1, body.clean_batch_size))
    if body.wechat_tunnel_enabled is not None:
        updates["wechat_tunnel_enabled"] = "1" if body.wechat_tunnel_enabled else "0"
    if body.wechat_tunnel_ssh_host is not None:
        updates["wechat_tunnel_ssh_host"] = body.wechat_tunnel_ssh_host.strip()
    if body.wechat_tunnel_ssh_port is not None:
        updates["wechat_tunnel_ssh_port"] = str(max(1, body.wechat_tunnel_ssh_port))
    if body.wechat_tunnel_ssh_user is not None:
        updates["wechat_tunnel_ssh_user"] = body.wechat_tunnel_ssh_user.strip()
    if body.wechat_tunnel_ssh_key_path is not None:
        updates["wechat_tunnel_ssh_key_path"] = body.wechat_tunnel_ssh_key_path.strip()
    if body.wechat_tunnel_local_host is not None:
        updates["wechat_tunnel_local_host"] = body.wechat_tunnel_local_host.strip() or "127.0.0.1"
    if body.wechat_tunnel_local_port is not None:
        updates["wechat_tunnel_local_port"] = str(max(1, body.wechat_tunnel_local_port))
    if body.wechat_tunnel_remote_host is not None:
        updates["wechat_tunnel_remote_host"] = body.wechat_tunnel_remote_host.strip() or "api.weixin.qq.com"
    if body.wechat_tunnel_remote_port is not None:
        updates["wechat_tunnel_remote_port"] = str(max(1, body.wechat_tunnel_remote_port))
    if body.wechat_tunnel_extra_args is not None:
        updates["wechat_tunnel_extra_args"] = body.wechat_tunnel_extra_args.strip()
    if body.blog_api_base is not None:
        updates["blog_api_base"] = body.blog_api_base.strip().rstrip("/")
    if body.blog_api_token is not None:
        updates["blog_api_token"] = body.blog_api_token.strip()
    if body.web_search_providers is not None:
        updates["web_search_providers"] = json.dumps(
            [provider.model_dump() for provider in body.web_search_providers], ensure_ascii=False,
        )
    if body.web_fetch_providers is not None:
        updates["web_fetch_providers"] = json.dumps(
            [provider.model_dump() for provider in body.web_fetch_providers], ensure_ascii=False,
        )
    if body.text_video_template_defaults is not None:
        try:
            normalized_template_defaults = (
                normalize_text_video_template_default_map(
                    body.text_video_template_defaults,
                )
            )
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        updates["text_video_template_defaults"] = json.dumps(
            normalized_template_defaults,
            ensure_ascii=False,
        )
    if updates:
        await set_config(updates)
    if "collection_proxy_url" in updates:
        apply_collection_proxy(updates["collection_proxy_url"])

    # Reschedule jobs if intervals changed
    interval_keys = {"github_interval_minutes"}
    if interval_keys & set(updates):
        cfg = await get_config()
        try:
            sched = request.app.state.scheduler
            sched.reschedule_job(
                "github_collect", trigger="interval",
                minutes=max(1, int(cfg.get("github_interval_minutes", 1))),
            )
        except Exception as e:
            print(f"[settings] reschedule failed: {e}")

    return _build_out(await get_config())


def _xiangongyun_client_from_config(cfg: dict[str, str]) -> XiangongyunClient:
    api_token = effective_xiangongyun_api_token(cfg)
    if not api_token:
        raise HTTPException(422, "请先填写仙宫云 API Token")
    return XiangongyunClient(
        effective_xiangongyun_base_url(cfg),
        api_token,
    )


def _raise_xiangongyun_http_error(error: XiangongyunError) -> None:
    status_code = 502 if error.retryable else 400
    raise HTTPException(status_code=status_code, detail=error.message) from error


@router.get("/xiangongyun/instances")
async def list_xiangongyun_instances():
    try:
        client = _xiangongyun_client_from_config(await get_config())
        return await client.list_instances()
    except XiangongyunError as error:
        _raise_xiangongyun_http_error(error)


@router.get("/xiangongyun/instances/{instance_id}")
async def get_xiangongyun_instance(instance_id: str):
    if not instance_id.strip():
        raise HTTPException(422, "实例 ID 不能为空")
    try:
        client = _xiangongyun_client_from_config(await get_config())
        return await client.get_instance(instance_id)
    except XiangongyunError as error:
        _raise_xiangongyun_http_error(error)


@router.post("/xiangongyun/instances/{instance_id}/boot")
async def boot_xiangongyun_instance(instance_id: str):
    if not instance_id.strip():
        raise HTTPException(422, "实例 ID 不能为空")
    try:
        client = _xiangongyun_client_from_config(await get_config())
        return await client.boot_instance(instance_id)
    except XiangongyunError as error:
        _raise_xiangongyun_http_error(error)


@router.post("/xiangongyun/instances/{instance_id}/shutdown")
async def shutdown_xiangongyun_instance(instance_id: str):
    if not instance_id.strip():
        raise HTTPException(422, "实例 ID 不能为空")
    try:
        client = _xiangongyun_client_from_config(await get_config())
        return await client.shutdown_instance(instance_id)
    except XiangongyunError as error:
        _raise_xiangongyun_http_error(error)


@router.post("/heygen/test")
async def test_heygen():
    cfg = await get_config()
    api_key = effective_heygen_api_key(cfg)
    if not api_key:
        return {"ok": False, "error": "请先填写 HeyGen API Key"}
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.get(
                "https://api.heygen.com/v3/avatars",
                params={"ownership": "private", "limit": 1},
                headers={"x-api-key": api_key},
            )
        if response.status_code == 401:
            return {"ok": False, "error": "HeyGen API Key 无效"}
        if response.status_code == 403:
            return {"ok": False, "error": "当前 HeyGen 套餐不可用"}
        if response.status_code == 429:
            return {"ok": False, "error": "HeyGen 请求过于频繁，请稍后重试"}
        response.raise_for_status()
        return {"ok": True, "error": ""}
    except httpx.HTTPStatusError as exc:
        error = f"HeyGen HTTP {exc.response.status_code}: {exc.response.text[:200]}"
    except Exception as exc:
        error = str(exc)
    safe_error = redact_secret_text(error).replace(api_key, "***")[:500]
    return {"ok": False, "error": safe_error}


@router.post("/comfyui/test")
async def test_comfyui():
    cfg = await get_config()
    base_url = effective_comfyui_base_url(cfg)
    auth_token = effective_comfyui_auth_token(cfg)
    if not base_url:
        return {"ok": False, "error": "请先填写 ComfyUI 地址"}
    headers = {}
    if auth_token:
        headers["Authorization"] = f"Bearer {auth_token}"
    try:
        async with httpx.AsyncClient(timeout=15, trust_env=False) as client:
            response = await client.get(
                f"{base_url}/system_stats",
                headers=headers,
            )
        if response.status_code in {401, 403}:
            return {"ok": False, "error": "ComfyUI 鉴权失败"}
        response.raise_for_status()
        try:
            response.json()
        except ValueError:
            return {"ok": False, "error": "ComfyUI 响应异常"}
        return {"ok": True, "error": ""}
    except httpx.HTTPStatusError as exc:
        error = f"ComfyUI HTTP {exc.response.status_code}: {exc.response.text[:200]}"
    except httpx.TimeoutException:
        error = "连接 ComfyUI 超时"
    except httpx.ConnectError:
        error = "无法连接到 ComfyUI。请确认地址对本服务可达，且 ComfyUI 已启动。"
    except httpx.RemoteProtocolError:
        error = "ComfyUI 在响应前断开了连接"
    except Exception as exc:
        error = str(exc)
    safe_error = redact_secret_text(error)
    if auth_token:
        safe_error = safe_error.replace(auth_token, "***")
    return {"ok": False, "error": safe_error[:500]}


@router.get(
    "/transcription/status",
    response_model=TranscriptionStatusOut,
)
async def get_transcription_status():
    cfg = await get_config()
    provider = cfg.get(
        "transcription_provider",
        "local-whisper",
    )
    if provider != "local-whisper":
        configured = bool(
            cfg.get("transcription_api_key", "").strip()
            and cfg.get("transcription_base_url", "").strip()
            and cfg.get("transcription_model", "").strip()
        )
        return TranscriptionStatusOut(
            provider="openai-compatible",
            status="ready" if configured else "error",
            model=cfg.get("transcription_model", "whisper-1"),
            device="remote",
            compute_type="",
            error="" if configured else "云端转写服务尚未完整配置",
        )

    runtime = get_runtime_settings()
    try:
        async with httpx.AsyncClient(
            timeout=3,
            follow_redirects=False,
            trust_env=False,
        ) as client:
            response = await client.get(
                f"{runtime.local_asr_url.rstrip('/')}/models",
            )
        if not response.is_success:
            return TranscriptionStatusOut(
                provider="local-whisper",
                status="error",
                model=runtime.local_asr_model,
                device=runtime.local_asr_device,
                compute_type=runtime.local_asr_compute_type,
                error=f"本地转写服务返回 HTTP {response.status_code}",
            )
        payload = response.json()
        models = payload.get("data", []) if isinstance(payload, dict) else []
        available = {
            str(item.get("id") or "")
            for item in models
            if isinstance(item, dict)
        }
        return TranscriptionStatusOut(
            provider="local-whisper",
            status=(
                "ready"
                if runtime.local_asr_model in available
                else "preparing"
            ),
            model=runtime.local_asr_model,
            device=runtime.local_asr_device,
            compute_type=runtime.local_asr_compute_type,
            error="",
        )
    except Exception as exc:
        logger.warning(
            "Local transcription status check failed for %s: %s",
            runtime.local_asr_url,
            exc,
        )
        return TranscriptionStatusOut(
            provider="local-whisper",
            status="unavailable",
            model=runtime.local_asr_model,
            device=runtime.local_asr_device,
            compute_type=runtime.local_asr_compute_type,
            error=f"本地转写服务无法访问：{redact_secret_text(str(exc))[:200]}",
        )


@router.post("/transcription/test")
async def test_transcription():
    cfg = await get_config()
    provider = cfg.get(
        "transcription_provider",
        "local-whisper",
    )
    if provider == "local-whisper":
        try:
            with tempfile.TemporaryDirectory(
                prefix="wms-local-asr-test-",
            ) as directory:
                audio_path = Path(directory) / "connection-test.wav"
                with wave.open(str(audio_path), "wb") as handle:
                    handle.setnchannels(1)
                    handle.setsampwidth(2)
                    handle.setframerate(16_000)
                    handle.writeframes(b"\x00\x00" * 4_000)
                await transcribe_audio(
                    TranscriptionRequest(
                        audio_path=audio_path,
                        duration=0.25,
                        require_word_timestamps=False,
                    ),
                    cfg,
                )
            return {"ok": True, "error": ""}
        except TranscriptionError as exc:
            return {
                "ok": False,
                "error": redact_secret_text(str(exc))[:500],
            }
        except Exception as exc:
            return {
                "ok": False,
                "error": redact_secret_text(str(exc))[:500],
            }

    api_key = cfg.get("transcription_api_key", "").strip()
    base_url = cfg.get("transcription_base_url", "").strip().rstrip("/")
    if not api_key or not base_url:
        return {"ok": False, "error": "请先填写并保存语音转写 API Key 和 Base URL"}
    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=False) as client:
            response = await client.get(
                f"{base_url}/models",
                headers={"Authorization": f"Bearer {api_key}"},
            )
        if response.status_code in {401, 403}:
            return {"ok": False, "error": "语音转写 API Key 无效或无权限"}
        response.raise_for_status()
        return {"ok": True, "error": ""}
    except Exception as exc:
        error = redact_secret_text(str(exc)).replace(api_key, "***")[:500]
        return {"ok": False, "error": error}


def _clean_telegram_test_error(exc: Exception, cfg: dict[str, str]) -> str:
    cleaned = redact_secret_text(str(exc))
    token = cfg.get("telegram_bot_token", "")
    if token:
        cleaned = cleaned.replace(token, "***")
    return cleaned[:500]


@router.post("/telegram/test", response_model=SettingsOut)
async def test_telegram():
    cfg = await get_config()
    tested_at = datetime.now(timezone.utc)
    safe_error: str | None = None
    try:
        await telegram_notifier.send_html_messages(
            cfg.get("telegram_bot_token", ""),
            cfg.get("telegram_chat_id", ""),
            [telegram_notifier.render_test_message(tested_at)],
        )
    except Exception as exc:
        safe_error = _clean_telegram_test_error(exc, cfg)

    if safe_error is not None:
        metadata_persist_failed = False
        try:
            await set_config({
                "telegram_test_status": "failed",
                "telegram_last_tested_at": tested_at.isoformat(),
                "telegram_last_test_error": safe_error,
            })
        except Exception:
            metadata_persist_failed = True
        if metadata_persist_failed:
            raise HTTPException(
                status_code=503,
                detail="Telegram 测试状态保存失败",
            ) from None
        raise HTTPException(status_code=503, detail=safe_error) from None

    await set_config({
        "telegram_test_status": "success",
        "telegram_last_tested_at": tested_at.isoformat(),
        "telegram_last_test_error": "",
    })
    return _build_out(await get_config())


@router.delete("/telegram", response_model=SettingsOut)
async def clear_telegram():
    await set_config({
        "telegram_bot_token": "",
        "telegram_chat_id": "",
        "telegram_test_status": "",
        "telegram_last_tested_at": "",
        "telegram_last_test_error": "",
    })
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


async def _test_openai_adapter(adapter):
    """Run a low-cost connectivity check without persisting the draft."""
    if not adapter.supports_text:
        await _fetch_models_openai_compat(adapter.base_url, adapter.api_key)
        return "图片接口连接成功"

    from openai import AsyncOpenAI

    client = AsyncOpenAI(api_key=adapter.api_key, base_url=adapter.base_url)
    response = await client.chat.completions.create(
        model=adapter.model,
        max_tokens=10,
        messages=[{"role": "user", "content": 'Reply with just "OK".'}],
    )
    content = response.choices[0].message.content if response.choices else ""
    return (content or "连接成功").strip()


@router.post("/test-adapter")
async def test_llm_adapter(body: TestLLMAdapterRequest):
    """Test one Adapter draft, using its stored key when the draft omits it."""
    adapter = None
    try:
        adapter = resolve_test_adapter(await get_config(), body.adapter)
        response = await _test_openai_adapter(adapter)
        return {"ok": True, "response": response}
    except Exception as exc:
        error = redact_secret_text(str(exc))
        if adapter is not None and adapter.api_key:
            error = error.replace(adapter.api_key, "***")
        return {"ok": False, "error": error[:500]}


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
