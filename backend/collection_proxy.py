"""Persisted collection proxy validation and process environment ownership."""

import logging
import os
from urllib.parse import urlsplit


logger = logging.getLogger(__name__)

SUPPORTED_PROXY_SCHEMES = {"http", "https", "socks5"}
_PROXY_ENV_KEYS = ("HTTP_PROXY", "HTTPS_PROXY")
_INITIAL_PROXY_ENV = {key: os.environ.get(key) for key in _PROXY_ENV_KEYS}


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


def apply_collection_proxy(value: str) -> None:
    """Apply one proxy URL to both standard variables, or restore startup state."""
    normalized = normalize_collection_proxy_url(value)
    if normalized:
        for key in _PROXY_ENV_KEYS:
            os.environ[key] = normalized
        logger.info(
            "Collection proxy enabled for scheme=%s",
            urlsplit(normalized).scheme,
        )
        return

    for key, original in _INITIAL_PROXY_ENV.items():
        if original is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = original
    logger.info("Collection proxy disabled; startup environment restored")
