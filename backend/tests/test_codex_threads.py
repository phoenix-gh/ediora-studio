import os

import httpx
import pytest

from codex_threads import CodexThreadDeleteError, delete_codex_thread


@pytest.mark.asyncio
async def test_delete_codex_thread_calls_the_web_process(monkeypatch):
    monkeypatch.setenv("WORKER_TOKEN", "test-worker-token-at-least-32-characters")
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["token"] = request.headers["X-Worker-Token"]
        return httpx.Response(204)

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        await delete_codex_thread("thr_chat", client=client)

    assert seen == {
        "path": "/api/internal/codex-threads/thr_chat",
        "token": os.environ["WORKER_TOKEN"],
    }


@pytest.mark.asyncio
async def test_delete_codex_thread_skips_a_blank_id():
    await delete_codex_thread(None)
    await delete_codex_thread("")


@pytest.mark.asyncio
async def test_delete_codex_thread_reports_a_failed_response(monkeypatch):
    monkeypatch.setenv("WORKER_TOKEN", "test-worker-token-at-least-32-characters")
    transport = httpx.MockTransport(lambda _request: httpx.Response(502))
    async with httpx.AsyncClient(transport=transport) as client:
        with pytest.raises(CodexThreadDeleteError, match="failed"):
            await delete_codex_thread("thr_chat", client=client)
