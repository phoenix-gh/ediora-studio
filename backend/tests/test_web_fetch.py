import pytest


@pytest.mark.asyncio
async def test_direct_fetch_returns_normalized_article(monkeypatch):
    import web_fetch

    async def fake_get_text(url, *, timeout_seconds):
        assert url == "https://example.com/article"
        assert timeout_seconds == 12
        return "<html><head><title>Example title</title></head><body><main><p>First paragraph.</p><p>Second paragraph.</p></main></body></html>", "text/html"

    monkeypatch.setattr(web_fetch, "_validate_public_url", lambda url: url)
    monkeypatch.setattr(web_fetch, "_get_text", fake_get_text)

    result, provider = await web_fetch.fetch_with_providers(
        "https://example.com/article",
        [{"key": "direct", "enabled": True, "timeout_seconds": 12}],
    )

    assert provider == "direct"
    assert result.title == "Example title"
    assert result.content == "First paragraph.\n\nSecond paragraph."
    assert result.content_type == "text/html"


@pytest.mark.asyncio
async def test_fetch_tries_next_enabled_provider_after_failure(monkeypatch):
    import web_fetch

    calls = []

    async def fake_fetch(provider, url):
        calls.append(provider["key"])
        if provider["key"] == "direct":
            raise web_fetch.WebFetchProviderError("direct", "request failed")
        return web_fetch.WebFetchResult(url, "Fallback", "Body", "text/markdown", "jina_reader")

    monkeypatch.setattr(web_fetch, "_fetch_provider", fake_fetch)
    result, provider = await web_fetch.fetch_with_providers(
        "https://example.com/article",
        [{"key": "direct", "enabled": True}, {"key": "jina_reader", "enabled": True, "timeout_seconds": 12}],
    )

    assert calls == ["direct", "jina_reader"]
    assert provider == "jina_reader"
    assert result.content == "Body"


@pytest.mark.asyncio
async def test_fetch_rejects_private_network_urls():
    import web_fetch

    with pytest.raises(web_fetch.WebFetchProviderError, match="unsafe URL"):
        await web_fetch.fetch_with_providers(
            "http://127.0.0.1/admin",
            [{"key": "direct", "enabled": True, "timeout_seconds": 12}],
        )
