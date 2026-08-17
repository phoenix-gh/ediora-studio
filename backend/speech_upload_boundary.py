"""Pre-parse authentication and body limits for speech worker uploads."""

from __future__ import annotations

import json
import re
from typing import Any, Awaitable, Callable

from fastapi import HTTPException

from worker_auth import validate_worker_token


MAX_SPEECH_AUDIO_BYTES = 100 * 1024 * 1024
MAX_SPEECH_MULTIPART_OVERHEAD_BYTES = 1024 * 1024
_WORKER_RESULT_PATH = re.compile(
    r"^/api/text-videos/[^/]+/speech-segments/[^/]+/worker-result$",
)

ASGIApp = Callable[[dict, Callable, Callable], Awaitable[None]]


class _SpeechUploadTooLarge(BaseException):
    """Bypass framework body-parser Exception wrapping back to this boundary."""


async def _send_error(send: Callable, status: int, detail: str) -> None:
    body = json.dumps(
        {"detail": detail},
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    await send({
        "type": "http.response.start",
        "status": status,
        "headers": [
            (b"content-type", b"application/json"),
            (b"content-length", str(len(body)).encode()),
        ],
    })
    await send({"type": "http.response.body", "body": body})


def _header(scope: dict[str, Any], name: bytes) -> bytes | None:
    values = [
        value
        for key, value in scope.get("headers", [])
        if key.lower() == name
    ]
    if not values:
        return None
    if len(set(values)) != 1:
        raise ValueError(f"conflicting {name.decode()} headers")
    return values[0]


def _worker_token(scope: dict[str, Any]) -> bytes | None:
    try:
        return _header(scope, b"x-worker-token")
    except ValueError:
        # Preserve the authentication contract: missing server configuration
        # is 503; once configured, conflicting credentials are a 403.
        validate_worker_token(None)
        raise AssertionError("worker-token validation must raise")


def _route_path(scope: dict[str, Any]) -> str:
    path = str(scope.get("path") or "")
    root_path = str(scope.get("root_path") or "")
    if not root_path or not path.startswith(root_path):
        return path
    if path == root_path:
        return ""
    if path[len(root_path)] == "/":
        return path[len(root_path):]
    return path


class SpeechWorkerUploadBoundary:
    """Reject untrusted or unbounded multipart bodies before FastAPI parses."""

    def __init__(
        self,
        app: ASGIApp,
        *,
        max_audio_bytes: int = MAX_SPEECH_AUDIO_BYTES,
        max_multipart_overhead_bytes: int = (
            MAX_SPEECH_MULTIPART_OVERHEAD_BYTES
        ),
    ):
        self.app = app
        self.max_request_bytes = (
            int(max_audio_bytes) + int(max_multipart_overhead_bytes)
        )
        if max_audio_bytes <= 0 or max_multipart_overhead_bytes < 0:
            raise ValueError("speech upload limits must be non-negative")

    async def __call__(self, scope, receive, send) -> None:
        if (
            scope.get("type") != "http"
            or scope.get("method") != "POST"
            or not _WORKER_RESULT_PATH.fullmatch(_route_path(scope))
        ):
            await self.app(scope, receive, send)
            return

        try:
            raw_token = _worker_token(scope)
            validate_worker_token(
                raw_token.decode("utf-8", errors="replace")
                if raw_token is not None
                else None,
            )
        except HTTPException as error:
            await _send_error(send, error.status_code, str(error.detail))
            return

        try:
            raw_length = _header(scope, b"content-length")
            content_length = (
                int(raw_length)
                if raw_length is not None
                else None
            )
            if content_length is not None and content_length < 0:
                raise ValueError
        except (TypeError, ValueError):
            await _send_error(send, 400, "Content-Length 无效")
            return
        if (
            content_length is not None
            and content_length > self.max_request_bytes
        ):
            await _send_error(send, 413, "配音上传请求过大")
            return

        consumed = 0
        response_started = False

        async def bounded_receive():
            nonlocal consumed
            message = await receive()
            if message.get("type") == "http.request":
                consumed += len(message.get("body", b""))
                if consumed > self.max_request_bytes:
                    raise _SpeechUploadTooLarge
            return message

        async def tracked_send(message):
            nonlocal response_started
            if message.get("type") == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, bounded_receive, tracked_send)
        except _SpeechUploadTooLarge:
            if response_started:
                raise
            await _send_error(send, 413, "配音上传请求过大")
