import asyncio

import pytest

from speech_upload_boundary import SpeechWorkerUploadBoundary


TARGET_PATH = (
    "/api/text-videos/7/speech-segments/segment-a/worker-result"
)
WORKER_TOKEN = "test-worker-token-at-least-32-chars"


def _scope(
    headers: list[tuple[bytes, bytes]],
    *,
    path: str = TARGET_PATH,
    root_path: str = "",
    method: str = "POST",
) -> dict:
    return {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "root_path": root_path,
        "query_string": b"",
        "headers": headers,
        "client": ("127.0.0.1", 1234),
        "server": ("testserver", 80),
    }


async def _exchange(
    app,
    *,
    headers: list[tuple[bytes, bytes]],
    messages: list[dict],
    path: str = TARGET_PATH,
    root_path: str = "",
    method: str = "POST",
) -> tuple[list[dict], int]:
    sent: list[dict] = []
    receive_calls = 0

    async def receive():
        nonlocal receive_calls
        receive_calls += 1
        if not messages:
            raise AssertionError("request body was consumed past the fixture")
        return messages.pop(0)

    async def send(message):
        sent.append(message)

    await app(
        _scope(
            headers,
            path=path,
            root_path=root_path,
            method=method,
        ),
        receive,
        send,
    )
    return sent, receive_calls


def _status(messages: list[dict]) -> int:
    return next(
        message["status"]
        for message in messages
        if message["type"] == "http.response.start"
    )


def test_missing_worker_token_is_rejected_without_consuming_request_body(
    monkeypatch,
):
    monkeypatch.setenv("WMS_WORKER_TOKEN", WORKER_TOKEN)
    route_called = False

    async def route(_scope, receive, send):
        nonlocal route_called
        await receive()
        route_called = True
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    app = SpeechWorkerUploadBoundary(
        route,
        max_audio_bytes=8,
        max_multipart_overhead_bytes=4,
    )
    sent, receive_calls = asyncio.run(_exchange(
        app,
        headers=[(
            b"content-type",
            b"multipart/form-data; boundary=upload-boundary",
        )],
        messages=[{
            "type": "http.request",
            "body": b"untrusted multipart",
            "more_body": False,
        }],
    ))

    assert _status(sent) == 403
    assert receive_calls == 0
    assert route_called is False


def test_main_app_installs_upload_boundary_before_body_parsing(monkeypatch):
    monkeypatch.setenv("WMS_WORKER_TOKEN", WORKER_TOKEN)
    from main import app

    sent, receive_calls = asyncio.run(_exchange(
        app,
        headers=[(
            b"content-type",
            b"multipart/form-data; boundary=upload-boundary",
        )],
        messages=[{
            "type": "http.request",
            "body": b"untrusted multipart",
            "more_body": False,
        }],
    ))

    assert _status(sent) == 403
    assert receive_calls == 0


@pytest.mark.parametrize(
    ("path", "root_path"),
    [
        (
            "/studio/api/text-videos/7/speech-segments/segment-a/"
            "worker-result",
            "/studio",
        ),
        (
            "/api/text-videos/not-an-int/speech-segments/segment-a/"
            "worker-result",
            "",
        ),
    ],
)
def test_main_app_authenticates_every_route_shape_before_body_parsing(
    monkeypatch,
    path,
    root_path,
):
    monkeypatch.setenv("WMS_WORKER_TOKEN", WORKER_TOKEN)
    from main import app

    sent, receive_calls = asyncio.run(_exchange(
        app,
        path=path,
        root_path=root_path,
        headers=[(
            b"content-type",
            b"multipart/form-data; boundary=upload-boundary",
        )],
        messages=[{
            "type": "http.request",
            "body": b"untrusted multipart",
            "more_body": False,
        }],
    ))

    assert _status(sent) == 403
    assert receive_calls == 0


def test_main_app_applies_body_limit_for_valid_worker_token(monkeypatch):
    monkeypatch.setenv("WMS_WORKER_TOKEN", WORKER_TOKEN)
    from main import app

    sent, receive_calls = asyncio.run(_exchange(
        app,
        headers=[
            (b"x-wms-worker-token", WORKER_TOKEN.encode()),
            (b"content-length", str(102 * 1024 * 1024).encode()),
        ],
        messages=[{
            "type": "http.request",
            "body": b"must not be read",
            "more_body": False,
        }],
    ))

    assert _status(sent) == 413
    assert receive_calls == 0


@pytest.mark.parametrize(
    ("path", "method"),
    [
        (TARGET_PATH, "OPTIONS"),
        (
            "/api/text-videos/7/speech-segments/segment-a/worker-failure",
            "POST",
        ),
        (f"{TARGET_PATH}/extra", "POST"),
    ],
)
def test_boundary_does_not_intercept_adjacent_route_shapes(
    monkeypatch,
    path,
    method,
):
    monkeypatch.setenv("WMS_WORKER_TOKEN", WORKER_TOKEN)
    route_called = False

    async def route(_scope, receive, send):
        nonlocal route_called
        await receive()
        route_called = True
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    app = SpeechWorkerUploadBoundary(route)
    sent, receive_calls = asyncio.run(_exchange(
        app,
        path=path,
        method=method,
        headers=[],
        messages=[{
            "type": "http.request",
            "body": b"adjacent request",
            "more_body": False,
        }],
    ))

    assert _status(sent) == 204
    assert receive_calls == 1
    assert route_called is True


def test_conflicting_worker_token_headers_are_auth_failure(monkeypatch):
    monkeypatch.setenv("WMS_WORKER_TOKEN", WORKER_TOKEN)
    app = SpeechWorkerUploadBoundary(
        lambda _scope, _receive, _send: None,
    )

    sent, receive_calls = asyncio.run(_exchange(
        app,
        headers=[
            (b"x-wms-worker-token", WORKER_TOKEN.encode()),
            (b"x-wms-worker-token", b"different-worker-token-value"),
        ],
        messages=[{
            "type": "http.request",
            "body": b"must not be read",
            "more_body": False,
        }],
    ))

    assert _status(sent) == 403
    assert receive_calls == 0


def test_unconfigured_worker_token_precedes_conflicting_headers(monkeypatch):
    monkeypatch.delenv("WMS_WORKER_TOKEN", raising=False)
    app = SpeechWorkerUploadBoundary(
        lambda _scope, _receive, _send: None,
    )

    sent, receive_calls = asyncio.run(_exchange(
        app,
        headers=[
            (b"x-wms-worker-token", b"first-worker-token-value"),
            (b"x-wms-worker-token", b"second-worker-token-value"),
        ],
        messages=[{
            "type": "http.request",
            "body": b"must not be read",
            "more_body": False,
        }],
    ))

    assert _status(sent) == 503
    assert receive_calls == 0


def test_oversized_content_length_is_rejected_without_consuming_body(
    monkeypatch,
):
    monkeypatch.setenv("WMS_WORKER_TOKEN", WORKER_TOKEN)
    route_called = False

    async def route(_scope, receive, send):
        nonlocal route_called
        await receive()
        route_called = True
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    app = SpeechWorkerUploadBoundary(
        route,
        max_audio_bytes=8,
        max_multipart_overhead_bytes=4,
    )
    sent, receive_calls = asyncio.run(_exchange(
        app,
        headers=[
            (b"x-wms-worker-token", WORKER_TOKEN.encode()),
            (b"content-length", b"13"),
        ],
        messages=[{
            "type": "http.request",
            "body": b"never read",
            "more_body": False,
        }],
    ))

    assert _status(sent) == 413
    assert receive_calls == 0
    assert route_called is False


def test_chunked_body_is_stopped_at_bounded_receive_before_route(
    monkeypatch,
):
    monkeypatch.setenv("WMS_WORKER_TOKEN", WORKER_TOKEN)
    route_called = False

    async def route(_scope, receive, send):
        nonlocal route_called
        while True:
            message = await receive()
            if not message.get("more_body"):
                break
        route_called = True
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    app = SpeechWorkerUploadBoundary(
        route,
        max_audio_bytes=8,
        max_multipart_overhead_bytes=4,
    )
    sent, receive_calls = asyncio.run(_exchange(
        app,
        headers=[(b"x-wms-worker-token", WORKER_TOKEN.encode())],
        messages=[
            {
                "type": "http.request",
                "body": b"12345678",
                "more_body": True,
            },
            {
                "type": "http.request",
                "body": b"12345",
                "more_body": True,
            },
            {
                "type": "http.request",
                "body": b"must not be read",
                "more_body": False,
            },
        ],
    ))

    assert _status(sent) == 413
    assert receive_calls == 2
    assert route_called is False
