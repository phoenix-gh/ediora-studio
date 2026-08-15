"""Persisted collection-proxy validation and collection-channel application.

The setting is never written to process-wide HTTP_PROXY / HTTPS_PROXY.
Feedgrab reads FEEDGRAB_PROXY; our own collectors pass proxy= explicitly.
"""

import logging
import os
from urllib.parse import urlsplit


logger = logging.getLogger(__name__)

SUPPORTED_PROXY_SCHEMES = {"http", "https", "socks5"}
_FEEDGRAB_PROXY_KEY = "FEEDGRAB_PROXY"
_HTTP_ENV_KEYS = ("HTTP_PROXY", "HTTPS_PROXY")
_INITIAL_FEEDGRAB_PROXY = os.environ.get(_FEEDGRAB_PROXY_KEY)
_INITIAL_HTTP_ENV = {key: os.environ.get(key) for key in _HTTP_ENV_KEYS}


def normalize_collection_proxy_url(value: str) -> str:
    """Return a trimmed supported proxy URL, or an empty disabled value."""
    normalized = value.strip()
    if not normalized:
        return ""

    try:
        parsed = urlsplit(normalized)
        _ = parsed.port
    except ValueError as error:
        raise ValueError("采集代理地址格式无效") from error

    if parsed.scheme not in SUPPORTED_PROXY_SCHEMES or not parsed.hostname:
        raise ValueError(
            "采集代理地址必须使用 http、https 或 socks5 协议并包含主机",
        )
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise ValueError("采集代理地址不能包含路径、查询参数或片段")
    return normalized


def collection_proxy_browser_state(value: str) -> tuple[str, bool, str]:
    """Return an editable value and credential-safe status for the browser."""
    normalized = normalize_collection_proxy_url(value)
    if not normalized:
        return "", False, ""

    parsed = urlsplit(normalized)
    if parsed.username is None and parsed.password is None:
        return normalized, True, normalized

    hostname = parsed.hostname or ""
    host = f"[{hostname}]" if ":" in hostname else hostname
    port = f":{parsed.port}" if parsed.port is not None else ""
    return "", True, f"{parsed.scheme}://***@{host}{port}"


def collection_httpx_kwargs(proxy_url: str, **kwargs) -> dict:
    """httpx kwargs for a collection client: explicit proxy, never trust env."""
    kwargs["trust_env"] = False
    normalized = normalize_collection_proxy_url(proxy_url) if proxy_url else ""
    if normalized:
        kwargs["proxy"] = normalized
    return kwargs


async def current_collection_proxy_url() -> str:
    try:
        from config import get_config

        cfg = await get_config()
        return normalize_collection_proxy_url(cfg.get("collection_proxy_url", "") or "")
    except Exception:
        return ""


async def collection_client_kwargs(**kwargs) -> dict:
    return collection_httpx_kwargs(await current_collection_proxy_url(), **kwargs)


def collection_ytdlp_proxy_args(proxy_url: str) -> tuple[str, ...]:
    normalized = normalize_collection_proxy_url(proxy_url) if proxy_url else ""
    return ("--proxy", normalized) if normalized else ()


def apply_collection_proxy(value: str) -> None:
    """Publish the collection proxy to feedgrab only.

    Never writes HTTP_PROXY or HTTPS_PROXY. Those leak into ComfyUI, LLM,
    and every other httpx client that trusts the process environment.
    """
    for key, original in _INITIAL_HTTP_ENV.items():
        if original is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = original

    normalized = normalize_collection_proxy_url(value)
    if normalized:
        os.environ[_FEEDGRAB_PROXY_KEY] = normalized
        logger.info(
            "Collection proxy enabled for scheme=%s",
            urlsplit(normalized).scheme,
        )
        return

    if _INITIAL_FEEDGRAB_PROXY is None:
        os.environ.pop(_FEEDGRAB_PROXY_KEY, None)
    else:
        os.environ[_FEEDGRAB_PROXY_KEY] = _INITIAL_FEEDGRAB_PROXY
    logger.info("Collection proxy disabled; startup feedgrab proxy restored")
