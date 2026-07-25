import asyncio
import socket

import httpx


def _public_resolver(host, port, *args, **kwargs):
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port))]


def test_extracts_unique_non_x_links():
    from x_response_links import extract_external_urls

    assert extract_external_urls(
        "Docs https://docs.example.com/api and https://x.com/openai/status/1",
        "More https://docs.example.com/api",
        "https://x.com/openai/status/1",
    ) == ["https://docs.example.com/api"]


def test_private_target_is_rejected_without_request():
    from x_response_links import verify_urls

    result = asyncio.run(verify_urls(["http://127.0.0.1/admin"]))

    assert result["verification_status"] == "unverified"
    assert result["links"] == []
    assert "public" in result["errors"][0]


def test_redirect_to_private_target_is_rejected():
    from x_response_links import verify_urls

    def handler(request: httpx.Request):
        return httpx.Response(302, headers={"location": "http://169.254.169.254/latest"})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await verify_urls(
                ["https://official.example/announcement"],
                client=client,
                resolver=_public_resolver,
            )

    result = asyncio.run(run())
    assert result["verification_status"] == "unverified"
    assert any("public" in error for error in result["errors"])


def test_public_html_is_bounded_and_extracted():
    from x_response_links import verify_urls

    def handler(request: httpx.Request):
        return httpx.Response(
            200,
            headers={"content-type": "text/html; charset=utf-8"},
            text="<html><head><title>API launch</title></head>"
                 "<body><nav>menu</nav><main><h1>New API</h1><p>Details here.</p></main></body></html>",
        )

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await verify_urls(
                ["https://official.example/announcement"],
                client=client,
                resolver=_public_resolver,
            )

    result = asyncio.run(run())
    assert result["verification_status"] == "verified"
    assert result["links"][0]["title"] == "API launch"
    assert "New API" in result["links"][0]["text"]
    assert "menu" not in result["links"][0]["text"]


def test_unsupported_content_type_is_unverified():
    from x_response_links import verify_urls

    def handler(request: httpx.Request):
        return httpx.Response(200, headers={"content-type": "application/pdf"}, content=b"%PDF")

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await verify_urls(
                ["https://official.example/file.pdf"],
                client=client,
                resolver=_public_resolver,
            )

    result = asyncio.run(run())
    assert result["verification_status"] == "unverified"
    assert "content type" in result["errors"][0]
