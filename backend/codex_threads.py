"""Delete a persisted Codex thread through the web process.

The Node client owns the app-server connection, including the short-lived
stdio process used when ws://127.0.0.1:4500 is not listening.
"""

from __future__ import annotations

import os
import re

import httpx

_THREAD_ID = re.compile(r"^[A-Za-z0-9_-]{1,200}$")
_WEB_ORIGIN = "http://127.0.0.1:3000"
_TIMEOUT = httpx.Timeout(30.0, connect=2.0)


class CodexThreadDeleteError(RuntimeError):
    """The app-server did not delete the thread."""


def codex_thread_delete_url(thread_id: str) -> str:
    return f"{_WEB_ORIGIN}/api/internal/codex-threads/{thread_id}"


async def delete_codex_thread(
    thread_id: str | None,
    *,
    client: httpx.AsyncClient | None = None,
) -> None:
    if thread_id is None or _THREAD_ID.fullmatch(thread_id) is None:
        return
    token = os.environ.get("WORKER_TOKEN", "")
    if len(token) < 32:
        raise CodexThreadDeleteError("WORKER_TOKEN is not configured")

    async def send(http: httpx.AsyncClient) -> httpx.Response:
        return await http.delete(
            codex_thread_delete_url(thread_id),
            headers={"X-Worker-Token": token},
        )

    try:
        if client is None:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as http:
                response = await send(http)
        else:
            response = await send(client)
    except httpx.HTTPError as exc:
        raise CodexThreadDeleteError("Codex app-server is unavailable") from exc
    if response.status_code != 204:
        raise CodexThreadDeleteError("Codex thread delete failed")
