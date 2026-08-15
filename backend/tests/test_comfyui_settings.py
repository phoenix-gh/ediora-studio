import asyncio
import sys

import httpx
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch, postgres_env):
    monkeypatch.setenv(
        "WMS_WORKER_TOKEN", "test-worker-token-at-least-32-chars"
    )
    monkeypatch.delenv("COMFYUI_BASE_URL", raising=False)
    monkeypatch.delenv("COMFYUI_AUTH_TOKEN", raising=False)
    for module in list(sys.modules):
        if module.startswith(("database", "models", "main", "routers", "config")):
            sys.modules.pop(module, None)

    from database import Base, engine
    import models  # noqa: F401

    async def setup():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.new_event_loop().run_until_complete(setup())
    from main import app

    return TestClient(app)


def test_comfyui_token_roundtrip_is_redacted(client):
    saved = client.put(
        "/api/settings",
        json={
            "comfyui_base_url": "http://127.0.0.1:8188",
            "comfyui_auth_token": "cfy_secret_1234",
            "comfyui_min_shot_seconds": 4,
            "comfyui_max_shot_seconds": 5,
        },
    )

    assert saved.status_code == 200
    body = saved.json()
    assert body["comfyui_base_url"] == "http://127.0.0.1:8188"
    assert body["comfyui_auth_token_set"] is True
    assert body["comfyui_auth_token_preview"] == "…1234"
    assert body["comfyui_min_shot_seconds"] == 4
    assert body["comfyui_max_shot_seconds"] == 5
    assert "cfy_secret_1234" not in saved.text


def test_comfyui_runtime_uses_environment_fallback(client, monkeypatch):
    monkeypatch.setenv("COMFYUI_BASE_URL", "http://gpu.local:8188")
    monkeypatch.setenv("COMFYUI_AUTH_TOKEN", "env-token")

    response = client.get(
        "/api/settings/comfyui-runtime",
        headers={"X-WMS-Worker-Token": "test-worker-token-at-least-32-chars"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "base_url": "http://gpu.local:8188",
        "auth_token": "env-token",
        "min_shot_seconds": 4,
        "max_shot_seconds": 5,
    }


def test_comfyui_runtime_rejects_missing_or_wrong_worker_token(client):
    missing = client.get("/api/settings/comfyui-runtime")
    wrong = client.get(
        "/api/settings/comfyui-runtime",
        headers={"X-WMS-Worker-Token": "wrong-token"},
    )

    assert missing.status_code == 403
    assert wrong.status_code == 403


def test_comfyui_rejects_invalid_duration_bounds(client):
    response = client.put(
        "/api/settings",
        json={
            "comfyui_min_shot_seconds": 6,
            "comfyui_max_shot_seconds": 5,
        },
    )

    assert response.status_code == 422


def test_comfyui_connection_classifies_auth_failure(client, monkeypatch):
    client.put(
        "/api/settings",
        json={
            "comfyui_base_url": "http://127.0.0.1:8188",
            "comfyui_auth_token": "cfy_secret_1234",
        },
    )

    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/system_stats"
        assert request.headers["authorization"] == "Bearer cfy_secret_1234"
        return httpx.Response(401, request=request, text="unauthorized")

    transport = httpx.MockTransport(handler)
    original_client = httpx.AsyncClient

    def fake_client(*args, **kwargs):
        kwargs["transport"] = transport
        return original_client(*args, **kwargs)

    import routers.settings as settings_router

    monkeypatch.setattr(settings_router.httpx, "AsyncClient", fake_client)
    response = client.post("/api/settings/comfyui/test")

    assert response.status_code == 200
    assert response.json() == {"ok": False, "error": "ComfyUI 鉴权失败"}
    assert "cfy_secret_1234" not in response.text


def test_comfyui_connection_succeeds_without_exposing_token(client, monkeypatch):
    client.put(
        "/api/settings",
        json={
            "comfyui_base_url": "http://127.0.0.1:8188",
            "comfyui_auth_token": "cfy_secret_1234",
        },
    )

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, request=request, json={"system": {}})

    transport = httpx.MockTransport(handler)
    original_client = httpx.AsyncClient

    def fake_client(*args, **kwargs):
        kwargs["transport"] = transport
        return original_client(*args, **kwargs)

    import routers.settings as settings_router

    monkeypatch.setattr(settings_router.httpx, "AsyncClient", fake_client)
    response = client.post("/api/settings/comfyui/test")

    assert response.json() == {"ok": True, "error": ""}
    assert "cfy_secret_1234" not in response.text


def _serve_json(path: str, payload: dict) -> tuple[str, object]:
    import json
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path != path:
                self.send_error(404)
                return
            body = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address[:2]
    return f"http://{host}:{port}", server


def _serve_immediate_close() -> tuple[str, object]:
    import socket
    import threading

    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", 0))
    listener.listen(8)

    def run() -> None:
        while True:
            try:
                conn, _addr = listener.accept()
            except OSError:
                return
            conn.close()

    threading.Thread(target=run, daemon=True).start()
    host, port = listener.getsockname()[:2]
    return f"http://{host}:{port}", listener


def test_comfyui_connection_ignores_process_http_proxy(client, monkeypatch):
    base_url, comfy_server = _serve_json("/system_stats", {"system": {}})
    proxy_url, proxy_socket = _serve_immediate_close()
    try:
        client.put("/api/settings", json={"comfyui_base_url": base_url})
        monkeypatch.setenv("HTTP_PROXY", proxy_url)
        monkeypatch.setenv("HTTPS_PROXY", proxy_url)

        response = client.post("/api/settings/comfyui/test")

        assert response.status_code == 200
        assert response.json() == {"ok": True, "error": ""}
    finally:
        comfy_server.shutdown()
        comfy_server.server_close()
        proxy_socket.close()


def test_comfyui_connection_classifies_unreachable_server(client):
    client.put(
        "/api/settings",
        json={"comfyui_base_url": "http://127.0.0.1:9"},
    )

    response = client.post("/api/settings/comfyui/test")

    assert response.status_code == 200
    assert response.json() == {
        "ok": False,
        "error": "无法连接到 ComfyUI。请确认地址对本服务可达，且 ComfyUI 已启动。",
    }
