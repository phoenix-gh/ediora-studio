import pytest


@pytest.mark.asyncio
async def test_searxng_normalizes_valid_http_results(monkeypatch):
    import web_search

    request = {}

    async def fake_get_json(url, *, params, timeout_seconds):
        request.update(url=url, params=params, timeout_seconds=timeout_seconds)
        return {
            "results": [
                {"title": "A", "url": "https://example.com/a", "content": "summary"},
                {"title": "Invalid", "url": "javascript:alert(1)", "content": "ignore"},
            ]
        }

    monkeypatch.setattr(web_search, "_get_json", fake_get_json)
    results, provider = await web_search.search_with_providers(
        "AI", 5, "zh-CN",
        [{"key": "searxng", "enabled": True, "base_url": "http://searxng:8080", "timeout_seconds": 12}],
    )

    assert provider == "searxng"
    assert results == [web_search.WebSearchResult("A", "https://example.com/a", "summary", "searxng")]
    assert request == {
        "url": "http://searxng:8080/search",
        "params": {"q": "AI", "format": "json", "language": "zh-CN"},
        "timeout_seconds": 12,
    }


@pytest.mark.asyncio
async def test_dispatcher_tries_next_enabled_provider_after_failure(monkeypatch):
    import web_search

    calls = []

    async def fake_search(provider, query, max_results, language):
        calls.append(provider["key"])
        if provider["key"] == "searxng":
            raise web_search.WebSearchProviderError("searxng", "timeout")
        return [web_search.WebSearchResult("B", "https://example.org", "", "future")]

    monkeypatch.setattr(web_search, "_search_provider", fake_search)
    results, provider = await web_search.search_with_providers(
        "AI", 5, "zh-CN",
        [
            {"key": "searxng", "enabled": True, "base_url": "http://searxng:8080", "timeout_seconds": 12},
            {"key": "future", "enabled": True, "base_url": "https://future.example", "timeout_seconds": 12},
        ],
    )

    assert calls == ["searxng", "future"]
    assert provider == "future"
    assert results[0].url == "https://example.org"


@pytest.mark.asyncio
async def test_search_reports_unconfigured_when_no_provider_is_enabled():
    import web_search

    with pytest.raises(web_search.WebSearchProviderError, match="not configured"):
        await web_search.search_with_providers("AI", 5, "zh-CN", [])
