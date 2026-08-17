import asyncio
import sys

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture
def worker_token():
    return "speech-worker-token-" + "x" * 32


@pytest.fixture
def worker_headers(worker_token):
    return {"X-Worker-Token": worker_token}


@pytest.fixture
def client(monkeypatch, worker_token, postgres_env):
    monkeypatch.setenv("WORKER_TOKEN", worker_token)
    for name in (
        "SPEECH_PROVIDER",
        "SPEECH_MODEL",
        "SPEECH_BASE_URL",
        "SPEECH_API_KEY",
        "SPEECH_DEFAULT_VOICE",
        "MIMO_API_KEY",
    ):
        monkeypatch.delenv(name, raising=False)
    for module in list(sys.modules):
        if module.startswith((
            "database",
            "models",
            "config",
            "routers.settings",
            "worker_auth",
        )):
            sys.modules.pop(module, None)

    from database import Base, engine
    import models  # noqa: F401

    async def create_schema():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.new_event_loop().run_until_complete(create_schema())

    from database import get_db
    import routers.settings as settings_router

    app = FastAPI()
    app.include_router(settings_router.router, prefix="/api")

    async def override_db():
        from database import SessionLocal

        async with SessionLocal() as session:
            yield session

    app.dependency_overrides[get_db] = override_db
    return TestClient(app)


def test_speech_defaults_are_public_without_exposing_a_secret(client):
    response = client.get("/api/settings")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["speech_provider"] == "mimo"
    assert body["speech_model"] == "mimo-v2.5-tts"
    assert body["speech_base_url"] == "https://api.xiaomimimo.com/v1"
    assert body["speech_default_voice"] == "mimo_default"
    assert body["speech_api_key_set"] is False
    assert body["speech_api_key_preview"] == ""
    assert "speech_api_key" not in body


def test_speech_runtime_is_worker_only_and_returns_effective_values(
    client,
    worker_headers,
):
    saved = client.put("/api/settings", json={
        "speech_provider": "mimo",
        "speech_model": "mimo-v2.5-tts",
        "speech_base_url": "https://api.xiaomimimo.com/v1/",
        "speech_api_key": "secret-key",
        "speech_default_voice": "mimo_default",
    })
    assert saved.status_code == 200, saved.text
    assert saved.json()["speech_api_key_set"] is True
    assert saved.json()["speech_api_key_preview"] == "…-key"
    assert "secret-key" not in saved.text

    assert client.get("/api/settings/speech-runtime").status_code == 403
    response = client.get(
        "/api/settings/speech-runtime",
        headers=worker_headers,
    )
    assert response.status_code == 200, response.text
    assert response.json() == {
        "provider": "mimo",
        "model": "mimo-v2.5-tts",
        "base_url": "https://api.xiaomimimo.com/v1",
        "api_key": "secret-key",
        "default_voice": "mimo_default",
    }


def test_blank_speech_key_preserves_it_and_clear_is_explicit(
    client,
    worker_headers,
):
    client.put("/api/settings", json={"speech_api_key": "preserved-key"})

    preserved = client.put("/api/settings", json={"speech_api_key": " "})
    assert preserved.status_code == 200, preserved.text
    assert preserved.json()["speech_api_key_set"] is True
    runtime = client.get(
        "/api/settings/speech-runtime",
        headers=worker_headers,
    ).json()
    assert runtime["api_key"] == "preserved-key"

    cleared = client.put("/api/settings", json={
        "speech_clear_api_key": True,
    })
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["speech_api_key_set"] is False
    runtime = client.get(
        "/api/settings/speech-runtime",
        headers=worker_headers,
    ).json()
    assert runtime["api_key"] == ""


@pytest.mark.parametrize(
    "payload",
    [
        {"speech_provider": "custom"},
        {"speech_base_url": "https://attacker.invalid/v1"},
        {"speech_base_url": "http://api.xiaomimimo.com/v1"},
        {"speech_base_url": "https://api.xiaomimimo.com/not-v1"},
        {
            "speech_base_url": (
                "https://api.xiaomimimo.com@attacker.invalid/v1"
            ),
        },
    ],
)
def test_public_settings_reject_unsupported_or_unsafe_speech_destinations(
    client,
    payload,
):
    response = client.put("/api/settings", json=payload)

    assert response.status_code == 422, response.text
    assert isinstance(response.json()["detail"], str)
    assert "MiMo" in response.json()["detail"]


def test_empty_speech_key_does_not_fall_back_to_environment(
    monkeypatch,
):
    monkeypatch.setenv("SPEECH_API_KEY", "environment-key")
    monkeypatch.setenv("MIMO_API_KEY", "alias-key")
    sys.modules.pop("config", None)

    try:
        import config

        assert config.DEFAULTS["speech_api_key"] == ""
    finally:
        sys.modules.pop("config", None)
