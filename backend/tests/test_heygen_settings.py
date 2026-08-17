import asyncio
import sys

import httpx
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch, postgres_env):
    monkeypatch.setenv(
        "WORKER_TOKEN", "test-worker-token-at-least-32-chars"
    )
    monkeypatch.delenv("HEYGEN_API_KEY", raising=False)
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


def test_heygen_key_roundtrip_is_redacted(client):
    saved = client.put(
        "/api/settings", json={"heygen_api_key": "hg_secret_1234"}
    )

    assert saved.status_code == 200
    assert saved.json()["heygen_api_key_set"] is True
    assert saved.json()["heygen_api_key_preview"] == "…1234"
    assert "hg_secret_1234" not in saved.text


def test_heygen_runtime_does_not_use_environment_fallback(client, monkeypatch):
    monkeypatch.setenv("HEYGEN_API_KEY", "env-key")

    response = client.get(
        "/api/settings/heygen-runtime",
        headers={"X-Worker-Token": "test-worker-token-at-least-32-chars"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "api_key": "",
        "base_url": "https://api.heygen.com",
    }


def test_heygen_runtime_rejects_missing_or_wrong_worker_token(client):
    missing = client.get("/api/settings/heygen-runtime")
    wrong = client.get(
        "/api/settings/heygen-runtime",
        headers={"X-Worker-Token": "wrong-token"},
    )

    assert missing.status_code == 403
    assert wrong.status_code == 403


def test_heygen_runtime_fails_closed_without_server_worker_token(
    client, monkeypatch
):
    monkeypatch.delenv("WORKER_TOKEN")

    response = client.get(
        "/api/settings/heygen-runtime",
        headers={"X-Worker-Token": "test-worker-token-at-least-32-chars"},
    )

    assert response.status_code == 503


@pytest.mark.parametrize(
    ("status_code", "expected"),
    [
        (401, "HeyGen API Key 无效"),
        (403, "当前 HeyGen 套餐不可用"),
        (429, "HeyGen 请求过于频繁，请稍后重试"),
    ],
)
def test_heygen_connection_classifies_provider_errors(
    client, monkeypatch, status_code, expected
):
    client.put("/api/settings", json={"heygen_api_key": "hg_secret_1234"})

    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["x-api-key"] == "hg_secret_1234"
        return httpx.Response(
            status_code,
            request=request,
            json={"error": {"message": f"provider rejected hg_secret_1234"}},
        )

    transport = httpx.MockTransport(handler)
    original_client = httpx.AsyncClient

    def fake_client(*args, **kwargs):
        kwargs["transport"] = transport
        return original_client(*args, **kwargs)

    import routers.settings as settings_router

    monkeypatch.setattr(settings_router.httpx, "AsyncClient", fake_client)
    response = client.post("/api/settings/heygen/test")

    assert response.status_code == 200
    assert response.json() == {"ok": False, "error": expected}
    assert "hg_secret_1234" not in response.text


def test_heygen_connection_succeeds_without_exposing_key(client, monkeypatch):
    client.put("/api/settings", json={"heygen_api_key": "hg_secret_1234"})

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, request=request, json={"data": {"avatars": []}})

    transport = httpx.MockTransport(handler)
    original_client = httpx.AsyncClient

    def fake_client(*args, **kwargs):
        kwargs["transport"] = transport
        return original_client(*args, **kwargs)

    import routers.settings as settings_router

    monkeypatch.setattr(settings_router.httpx, "AsyncClient", fake_client)
    response = client.post("/api/settings/heygen/test")

    assert response.json() == {"ok": True, "error": ""}
    assert "hg_secret_1234" not in response.text
