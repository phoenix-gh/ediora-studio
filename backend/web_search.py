"""Server-side public web search with ordered provider fallback."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import httpx

from config import get_config


@dataclass(frozen=True)
class WebSearchResult:
    title: str
    url: str
    snippet: str
    source: str


class WebSearchProviderError(RuntimeError):
    def __init__(self, provider: str, reason: str):
        super().__init__(f"{provider}: {reason}")
        self.provider = provider
        self.reason = reason


def parse_web_search_providers(raw: str | list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return []
    if not isinstance(raw, list):
        return []
    return [provider for provider in raw if isinstance(provider, dict)]


async def _get_json(url: str, *, params: dict[str, str], timeout_seconds: int) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=timeout_seconds) as client:
        response = await client.get(url, params=params)
        response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict):
        raise ValueError("invalid JSON response")
    return payload


def _http_url(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    parsed = urlsplit(value)
    return value if parsed.scheme in {"http", "https"} and parsed.netloc else None


async def _search_searxng(provider: dict[str, Any], query: str, max_results: int, language: str) -> list[WebSearchResult]:
    base_url = _http_url(provider.get("base_url"))
    if not base_url:
        raise WebSearchProviderError("searxng", "missing or invalid Base URL")
    timeout_seconds = max(1, min(int(provider.get("timeout_seconds", 12)), 30))
    try:
        payload = await _get_json(
            f"{base_url.rstrip('/')}/search",
            params={"q": query, "format": "json", "language": language},
            timeout_seconds=timeout_seconds,
        )
    except (httpx.HTTPError, ValueError) as exc:
        raise WebSearchProviderError("searxng", "request failed") from exc
    rows = payload.get("results", [])
    if not isinstance(rows, list):
        raise WebSearchProviderError("searxng", "invalid response")
    results: list[WebSearchResult] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        url = _http_url(row.get("url"))
        if not url:
            continue
        results.append(WebSearchResult(
            title=str(row.get("title") or url),
            url=url,
            snippet=str(row.get("content") or row.get("snippet") or ""),
            source="searxng",
        ))
        if len(results) >= max_results:
            break
    return results


async def _search_provider(provider: dict[str, Any], query: str, max_results: int, language: str) -> list[WebSearchResult]:
    if provider.get("key") == "searxng":
        return await _search_searxng(provider, query, max_results, language)
    raise WebSearchProviderError(str(provider.get("key") or "unknown"), "unsupported provider")


async def search_with_providers(query: str, max_results: int, language: str, providers: list[dict[str, Any]]) -> tuple[list[WebSearchResult], str]:
    failures: list[str] = []
    for provider in providers:
        if not provider.get("enabled"):
            continue
        try:
            return await _search_provider(provider, query, max_results, language), str(provider.get("key"))
        except WebSearchProviderError as exc:
            failures.append(str(exc))
    raise WebSearchProviderError("web_search", "; ".join(failures) or "not configured")


async def search_web(query: str, max_results: int = 5, language: str = "zh-CN") -> tuple[list[WebSearchResult], str]:
    config = await get_config()
    return await search_with_providers(
        query=query,
        max_results=max(1, min(max_results, 10)),
        language=language,
        providers=parse_web_search_providers(config.get("web_search_providers")),
    )
