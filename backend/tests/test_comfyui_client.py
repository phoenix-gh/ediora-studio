import asyncio
import json

import httpx
import pytest


def _png() -> bytes:
    return b"\x89PNG\r\n\x1a\nimage"


def _run(coroutine):
    return asyncio.new_event_loop().run_until_complete(coroutine)


async def _download(handler, **kwargs):
    from comfyui_client import download_comfyui_image

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        return await download_comfyui_image(client=client, **kwargs)


def test_download_posts_the_graph_and_returns_the_output_image():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == "/prompt":
            body = json.loads(request.content)
            assert body["prompt"]["6"]["inputs"]["text"] == "窗边"
            assert body["prompt"]["6"]["inputs"]["width"] == 1024
            assert request.headers["authorization"] == "Bearer secret-token"
            assert "secret-token" not in str(request.url)
            return httpx.Response(200, json={"prompt_id": "p-1"})
        if request.url.path == "/history/p-1":
            return httpx.Response(200, json={
                "p-1": {
                    "status": {"completed": True, "status_str": "success"},
                    "outputs": {
                        "8": {"images": [{"filename": "preview.png", "type": "temp"}]},
                        "9": {"images": [{
                            "filename": "final.png",
                            "subfolder": "ediora",
                            "type": "output",
                        }]},
                    },
                },
            })
        assert request.url.path == "/view"
        assert request.url.params["filename"] == "final.png"
        assert request.url.params["subfolder"] == "ediora"
        assert request.url.params["type"] == "output"
        return httpx.Response(200, content=_png())

    image = _run(_download(
        handler,
        base_url="http://comfy.example:8188/",
        auth_token="secret-token",
        graph={"6": {"inputs": {"text": "窗边", "width": 1024}}},
    ))

    assert image == _png()
    assert [request.url.path for request in seen] == ["/prompt", "/history/p-1", "/view"]


def test_download_waits_until_history_completes():
    calls = {"history": 0}
    clock = {"now": 0.0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/prompt":
            return httpx.Response(200, json={"prompt_id": "p-2"})
        if request.url.path.startswith("/history/"):
            calls["history"] += 1
            if calls["history"] == 1:
                return httpx.Response(200, json={})
            return httpx.Response(200, json={
                "status": {"status_str": "success", "completed": True},
                "outputs": {"9": {"images": [{"filename": "a.png", "type": "output"}]}},
            })
        return httpx.Response(200, content=_png())

    async def sleep(seconds: float) -> None:
        clock["now"] += seconds

    image = _run(_download(
        handler,
        base_url="http://comfy.example:8188",
        auth_token="",
        graph={"6": {}},
        sleep=sleep,
        now=lambda: clock["now"],
        poll_interval_seconds=2,
    ))

    assert image == _png()
    assert calls["history"] == 2
    assert clock["now"] == 2


def test_download_reports_comfyui_failures_without_the_token():
    def rejected(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/prompt":
            return httpx.Response(500, text="token secret-token leaked")
        return httpx.Response(200, json={})

    with pytest.raises(ValueError, match="ComfyUI HTTP 500") as error:
        _run(_download(
            rejected,
            base_url="http://comfy.example:8188",
            auth_token="secret-token",
            graph={"6": {}},
        ))
    assert "secret-token" not in str(error.value)
    assert "***" in str(error.value)

    def failed(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/prompt":
            return httpx.Response(200, json={"prompt_id": "p-3"})
        return httpx.Response(200, json={
            "p-3": {
                "status": {
                    "status_str": "error",
                    "messages": [["execution_error", {"exception_message": "model missing"}]],
                },
                "outputs": {},
            },
        })

    with pytest.raises(ValueError, match="model missing"):
        _run(_download(
            failed,
            base_url="http://comfy.example:8188",
            auth_token="",
            graph={"6": {}},
        ))

    def denied(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="no")

    with pytest.raises(ValueError, match="鉴权失败"):
        _run(_download(
            denied,
            base_url="http://comfy.example:8188",
            auth_token="secret-token",
            graph={"6": {}},
        ))
