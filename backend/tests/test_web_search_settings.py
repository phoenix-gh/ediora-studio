import asyncio
import sys

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{tmp_path / 'settings.db'}")
    monkeypatch.setenv("WMS_DISABLE_SCHEDULER", "1")
    for module in list(sys.modules):
        if module.startswith(("database", "models", "main", "routers", "config")):
            sys.modules.pop(module, None)
    from database import Base, engine
    import models  # noqa: F401

    async def create_schema():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.new_event_loop().run_until_complete(create_schema())
    from main import app
    return TestClient(app)


def test_settings_persists_searxng_provider(client):
    response = client.put("/api/settings", json={"web_search_providers": [{
        "key": "searxng", "enabled": True, "base_url": "http://searxng:8080", "timeout_seconds": 12,
    }]})

    assert response.status_code == 200, response.text
    assert response.json()["web_search_providers"] == [{
        "key": "searxng", "enabled": True, "base_url": "http://searxng:8080", "timeout_seconds": 12,
    }]


def test_settings_rejects_non_http_search_url(client):
    response = client.put("/api/settings", json={"web_search_providers": [{
        "key": "searxng", "enabled": True, "base_url": "file:///tmp", "timeout_seconds": 12,
    }]})

    assert response.status_code == 422


def test_settings_persists_web_fetch_provider_order(client):
    providers = [
        {"key": "direct", "enabled": True, "base_url": "", "timeout_seconds": 12},
        {"key": "jina_reader", "enabled": True, "base_url": "https://r.jina.ai", "timeout_seconds": 20},
        {"key": "camofox", "enabled": False, "base_url": "", "timeout_seconds": 30},
    ]

    response = client.put("/api/settings", json={"web_fetch_providers": providers})

    assert response.status_code == 200, response.text
    assert response.json()["web_fetch_providers"] == providers


def test_telegram_token_is_write_only(client):
    response = client.put("/api/settings", json={
        "telegram_bot_token": "123456:secret-token",
        "telegram_chat_id": "-100123",
    })

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["telegram_bot_token_set"] is True
    assert body["telegram_bot_token_preview"] == "…oken"
    assert body["telegram_chat_id"] == "-100123"
    assert "telegram_bot_token" not in body
