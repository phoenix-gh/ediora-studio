"""Server-side webpage fetching with ordered provider fallback."""

from __future__ import annotations

import html
import ipaddress
import json
import re
import uuid
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Any
from urllib.parse import quote, urlsplit

import httpx

from config import get_config

_MAX_RESPONSE_BYTES = 2_000_000
_DEFAULT_MAX_CHARS = 12_000


@dataclass(frozen=True)
class WebFetchResult:
    url: str
    title: str
    content: str
    content_type: str
    source: str


class WebFetchProviderError(RuntimeError):
    def __init__(self, provider: str, reason: str):
        super().__init__(f"{provider}: {reason}")
        self.provider = provider
        self.reason = reason


def parse_web_fetch_providers(raw: str | list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return []
    return [provider for provider in raw if isinstance(provider, dict)] if isinstance(raw, list) else []


def _validate_public_url(value: str) -> str:
    parsed = urlsplit(value.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.password:
        raise WebFetchProviderError("fetch_url", "unsafe URL")
    host = parsed.hostname
    if not host or host.lower() == "localhost" or host.lower().endswith(".local"):
        raise WebFetchProviderError("fetch_url", "unsafe URL")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return parsed.geturl()
    if address.is_private or address.is_loopback or address.is_link_local or address.is_reserved or address.is_multicast:
        raise WebFetchProviderError("fetch_url", "unsafe URL")
    return parsed.geturl()


async def _get_text(url: str, *, timeout_seconds: int) -> tuple[str, str]:
    headers = {"User-Agent": "WeMediaStudio/1.0 (+https://github.com)"}
    try:
        async with httpx.AsyncClient(timeout=timeout_seconds, follow_redirects=True, headers=headers) as client:
            response = await client.get(url)
            response.raise_for_status()
            if len(response.content) > _MAX_RESPONSE_BYTES:
                raise ValueError("response too large")
    except (httpx.HTTPError, ValueError) as exc:
        raise WebFetchProviderError("direct", "request failed") from exc
    return response.text, response.headers.get("content-type", "text/plain").split(";", 1)[0].lower()


class _ArticleTextParser(HTMLParser):
    _BLOCKS = {"p", "h1", "h2", "h3", "h4", "li", "blockquote", "pre"}
    _SKIP = {"script", "style", "noscript", "svg", "template"}

    def __init__(self):
        super().__init__()
        self.title = ""
        self._in_title = False
        self._skip_depth = 0
        self._block_depth = 0
        self._block_parts: list[str] = []
        self.blocks: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]):
        if tag in self._SKIP:
            self._skip_depth += 1
        if tag == "title":
            self._in_title = True
        if tag in self._BLOCKS:
            self._block_depth += 1

    def handle_endtag(self, tag: str):
        if tag in self._SKIP and self._skip_depth:
            self._skip_depth -= 1
        if tag == "title":
            self._in_title = False
        if tag in self._BLOCKS and self._block_depth:
            self._block_depth -= 1
            if self._block_depth == 0:
                text = _clean_text(" ".join(self._block_parts))
                if text:
                    self.blocks.append(text)
                self._block_parts = []

    def handle_data(self, data: str):
        if self._skip_depth:
            return
        if self._in_title:
            self.title += data
        if self._block_depth:
            self._block_parts.append(data)


def _clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(value)).strip()


def _extract_article(raw: str, content_type: str, url: str) -> tuple[str, str]:
    if content_type in {"text/markdown", "text/plain"}:
        return "", raw.strip()
    parser = _ArticleTextParser()
    try:
        parser.feed(raw)
    except Exception:
        pass
    return _clean_text(parser.title) or url, "\n\n".join(parser.blocks)


async def _fetch_direct(provider: dict[str, Any], url: str) -> WebFetchResult:
    raw, content_type = await _get_text(url, timeout_seconds=max(1, min(int(provider.get("timeout_seconds", 12)), 30)))
    title, content = _extract_article(raw, content_type, url)
    if not content:
        raise WebFetchProviderError("direct", "no readable content")
    return WebFetchResult(url, title, content, content_type, "direct")


async def _fetch_jina_reader(provider: dict[str, Any], url: str) -> WebFetchResult:
    base_url = str(provider.get("base_url") or "https://r.jina.ai").rstrip("/")
    if urlsplit(base_url).scheme not in {"http", "https"}:
        raise WebFetchProviderError("jina_reader", "missing or invalid Base URL")
    timeout_seconds = max(1, min(int(provider.get("timeout_seconds", 20)), 30))
    try:
        raw, content_type = await _get_text(f"{base_url}/{quote(url, safe=':/?&=%#')}", timeout_seconds=timeout_seconds)
    except WebFetchProviderError as exc:
        raise WebFetchProviderError("jina_reader", exc.reason) from exc
    title, content = _extract_article(raw, content_type, url)
    if not content:
        raise WebFetchProviderError("jina_reader", "no readable content")
    return WebFetchResult(url, title or url, content, content_type or "text/markdown", "jina_reader")


async def _fetch_camofox(provider: dict[str, Any], url: str) -> WebFetchResult:
    cfg = await get_config()
    base_url = str(provider.get("base_url") or cfg.get("camofox_url") or "").rstrip("/")
    if urlsplit(base_url).scheme not in {"http", "https"}:
        raise WebFetchProviderError("camofox", "missing or invalid Base URL")
    headers = {"Authorization": f"Bearer {cfg.get('camofox_api_key')}"} if cfg.get("camofox_api_key") else {}
    timeout_seconds = max(1, min(int(provider.get("timeout_seconds", 30)), 30))
    user_id = f"web_fetch_{uuid.uuid4().hex[:12]}"
    try:
        async with httpx.AsyncClient(timeout=timeout_seconds, headers=headers) as client:
            opened = await client.post(f"{base_url}/tabs", json={"userId": user_id, "sessionKey": cfg.get("camofox_user_id") or "wemedia_x", "url": url})
            opened.raise_for_status()
            tab_id = opened.json().get("tabId") or opened.json().get("id")
            if not tab_id:
                raise ValueError("missing tab id")
            evaluated = await client.post(f"{base_url}/tabs/{tab_id}/evaluate", json={"userId": user_id, "expression": "JSON.stringify({title:document.title||'',content:document.body?.innerText||''})"})
            evaluated.raise_for_status()
            value = evaluated.json().get("result")
    except (httpx.HTTPError, ValueError, TypeError, json.JSONDecodeError) as exc:
        raise WebFetchProviderError("camofox", "request failed") from exc
    payload = json.loads(value) if isinstance(value, str) else {}
    content = _clean_text(str(payload.get("content") or ""))
    if not content:
        raise WebFetchProviderError("camofox", "no readable content")
    return WebFetchResult(url, _clean_text(str(payload.get("title") or "")) or url, content, "text/plain", "camofox")


async def _fetch_provider(provider: dict[str, Any], url: str) -> WebFetchResult:
    key = provider.get("key")
    if key == "direct":
        return await _fetch_direct(provider, url)
    if key == "jina_reader":
        return await _fetch_jina_reader(provider, url)
    if key == "camofox":
        return await _fetch_camofox(provider, url)
    raise WebFetchProviderError(str(key or "unknown"), "unsupported provider")


async def fetch_with_providers(url: str, providers: list[dict[str, Any]], max_chars: int = _DEFAULT_MAX_CHARS) -> tuple[WebFetchResult, str]:
    safe_url = _validate_public_url(url)
    failures: list[str] = []
    for provider in providers:
        if not provider.get("enabled"):
            continue
        try:
            result = await _fetch_provider(provider, safe_url)
            return WebFetchResult(result.url, result.title, result.content[:max(1, min(max_chars, _DEFAULT_MAX_CHARS))], result.content_type, result.source), str(provider.get("key"))
        except WebFetchProviderError as exc:
            failures.append(str(exc))
    raise WebFetchProviderError("fetch_url", "; ".join(failures) or "not configured")


async def fetch_web_url(url: str, max_chars: int = _DEFAULT_MAX_CHARS) -> tuple[WebFetchResult, str]:
    cfg = await get_config()
    return await fetch_with_providers(url, parse_web_fetch_providers(cfg.get("web_fetch_providers")), max_chars)
