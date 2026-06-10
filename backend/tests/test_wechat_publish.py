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
    import models  # noqa: F401

    async def _create():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    asyncio.new_event_loop().run_until_complete(_create())

    from main import app
    return TestClient(app)


def test_publish_account_credentials_roundtrip(client):
    r = client.post("/api/publish-accounts", json={
        "id": "gzh_main", "name": "主号", "platform": "wechat",
        "app_id": "wx123", "app_secret": "sec456",
    })
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["app_id"] == "wx123"
    assert body["app_secret"] == "sec456"

    r2 = client.patch("/api/publish-accounts/gzh_main", json={"app_secret": "sec789"})
    assert r2.status_code == 200
    assert r2.json()["app_secret"] == "sec789"
