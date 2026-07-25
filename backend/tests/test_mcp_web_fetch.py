import pytest


@pytest.mark.asyncio
async def test_fetch_url_tool_returns_normalized_content(monkeypatch):
    import mcp_server
    from web_fetch import WebFetchResult

    async def fake_fetch(url, max_chars):
        assert (url, max_chars) == ("https://example.com", 12_000)
        return WebFetchResult(url, "Example", "Article body", "text/html", "direct"), "direct"

    monkeypatch.setattr(mcp_server, "run_web_fetch", fake_fetch)

    assert await mcp_server.fetch_url("https://example.com") == {
        "provider": "direct",
        "url": "https://example.com",
        "title": "Example",
        "content": "Article body",
        "content_type": "text/html",
    }
