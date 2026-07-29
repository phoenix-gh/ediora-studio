import asyncio

from speech_upload_boundary import SpeechWorkerUploadBoundary


TARGET_PATH = (
    "/api/text-videos/7/speech-segments/segment-a/worker-result"
)
WORKER_TOKEN = "test-worker-token-at-least-32-chars"


def _scope(headers: list[tuple[bytes, bytes]]) -> dict:
    return {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": TARGET_PATH,
        "raw_path": TARGET_PATH.encode(),
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

    await app(_scope(headers), receive, send)
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
