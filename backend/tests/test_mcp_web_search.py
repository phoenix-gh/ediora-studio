import pytest


@pytest.mark.asyncio
async def test_web_search_tool_returns_normalized_results(monkeypatch):
    import mcp_server
    from web_search import WebSearchResult

    async def fake_search(query, max_results, language):
        assert (query, max_results, language) == ("AI coding", 5, "zh-CN")
        return [WebSearchResult("Result", "https://example.com", "summary", "searxng")], "searxng"

    monkeypatch.setattr(mcp_server, "run_web_search", fake_search)

    result = await mcp_server.web_search("AI coding")

    assert result == {
        "provider": "searxng",
        "results": [{"title": "Result", "url": "https://example.com", "snippet": "summary", "source": "searxng"}],
    }


@pytest.mark.asyncio
async def test_web_search_tool_returns_safe_error_when_unconfigured(monkeypatch):
    import mcp_server
    from web_search import WebSearchProviderError

    async def fail_search(*_args, **_kwargs):
        raise WebSearchProviderError("web_search", "not configured")

    monkeypatch.setattr(mcp_server, "run_web_search", fail_search)

    assert await mcp_server.web_search("AI") == {
        "error": "Web search is unavailable: not configured. Configure it in Settings → Web 搜索.",
        "results": [],
    }
