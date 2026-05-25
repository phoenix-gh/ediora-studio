import sys
import asyncio
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch, tmp_path):
    db_file = tmp_path / "test.db"
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{db_file}")
    monkeypatch.setenv("WMS_DISABLE_SCHEDULER", "1")

    for mod in list(sys.modules):
        if mod.startswith(("database", "models", "main", "routers", "config")):
            sys.modules.pop(mod, None)

    from database import engine, Base
    import models  # noqa: F401 — registers all ORM classes on Base.metadata

    async def _create():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    asyncio.new_event_loop().run_until_complete(_create())

    from main import app
    return TestClient(app)


BASE = "/api/x/subscriptions"


def test_list_empty(client):
    r = client.get(BASE)
    assert r.status_code == 200
    assert r.json() == []


def test_create_subscription(client):
    r = client.post(BASE, json={"url": "https://x.com/elonmusk"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["url"] == "https://x.com/elonmusk"
    assert body["label"] == "@elonmusk"
    assert body["enabled"] is True
    assert body["post_count"] == 0


def test_create_list_url_default_label(client):
    r = client.post(BASE, json={"url": "https://x.com/i/lists/12345"})
    assert r.status_code == 200
    assert r.json()["label"] == "list-12345"


def test_create_rejects_non_http_url(client):
    r = client.post(BASE, json={"url": "ftp://x.com/foo"})
    assert r.status_code == 400


def test_create_duplicate_url_rejected(client):
    client.post(BASE, json={"url": "https://x.com/a"})
    r = client.post(BASE, json={"url": "https://x.com/a"})
    assert r.status_code == 400


def test_patch_enabled_and_label(client):
    sub = client.post(BASE, json={"url": "https://x.com/a"}).json()
    r = client.patch(f"{BASE}/{sub['id']}", json={"enabled": False, "label": "A"})
    assert r.status_code == 200
    body = r.json()
    assert body["enabled"] is False
    assert body["label"] == "A"


def test_patch_missing_returns_404(client):
    r = client.patch(f"{BASE}/999", json={"label": "x"})
    assert r.status_code == 404


def test_delete_subscription(client):
    sub = client.post(BASE, json={"url": "https://x.com/a"}).json()
    r = client.delete(f"{BASE}/{sub['id']}")
    assert r.status_code == 200
    assert client.get(BASE).json() == []


def test_delete_missing_returns_404(client):
    r = client.delete(f"{BASE}/999")
    assert r.status_code == 404
