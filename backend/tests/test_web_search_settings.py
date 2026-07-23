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
