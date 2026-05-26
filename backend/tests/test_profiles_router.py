import asyncio
import sys
from fastapi.testclient import TestClient
import pytest


@pytest.fixture
def client(monkeypatch, tmp_path):
    db_file = tmp_path / "test.db"
    home = tmp_path / "hermes"
    (home / "profiles" / "wms_writer").mkdir(parents=True)
    (home / "profiles" / "wms_writer" / "SOUL.md").write_text("hi\n")
    (home / "profiles" / "wms_writer" / "config.yaml").write_text(
        "model:\n  default: x\ntoolsets: []\nagent:\n  disabled_toolsets: [web]\n"
        "skills:\n  disabled: []\nmcp_servers: {}\n"
    )
    (home / "SOUL.md").write_text("\n")
    (home / "config.yaml").write_text("model:\n  default: y\n")

    monkeypatch.setenv("HERMES_HOME_ROOT", str(home))
    monkeypatch.setenv("WMS_DISABLE_SCHEDULER", "1")
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{db_file}")

    # Reset module cache so the new DB URL is picked up.
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


def test_list(client):
    r = client.get("/api/profiles")
    assert r.status_code == 200
    names = [p["name"] for p in r.json()["profiles"]]
    assert "wms_writer" in names


def test_list_includes_meta(client):
    r = client.get("/api/profiles")
    p = next(x for x in r.json()["profiles"] if x["name"] == "wms_writer")
    assert "display_name" in p
    assert "avatar_url" in p


def test_get_detail(client):
    r = client.get("/api/profiles/wms_writer")
    assert r.status_code == 200
    data = r.json()
    assert data["soul"] == "hi\n"
    assert "display_name" in data
    assert "avatar_url" in data


def test_default_soul_is_readonly(client):
    r = client.put("/api/profiles/default/soul", json={"content": "x"})
    assert r.status_code == 403


def test_invalid_name_404(client):
    r = client.get("/api/profiles/..%2Fetc")
    assert r.status_code in (400, 404)


def test_write_soul_roundtrip(client):
    r = client.put("/api/profiles/wms_writer/soul", json={"content": "new\n"})
    assert r.status_code == 200
    r2 = client.get("/api/profiles/wms_writer")
    assert r2.json()["soul"] == "new\n"


def test_toolset_invalid_name_400(client):
    r = client.post("/api/profiles/wms_writer/toolsets", json={"name": "bad/name", "enabled": True})
    assert r.status_code == 400


def test_mcp_invalid_name_400(client):
    r = client.post("/api/profiles/wms_writer/mcp", json={"name": "bad/name", "enabled": False})
    assert r.status_code == 400


def test_toolset_default_readonly(client):
    r = client.post("/api/profiles/default/toolsets", json={"name": "web", "enabled": True})
    assert r.status_code == 403


def test_update_meta(client):
    r = client.patch("/api/profiles/wms_writer", json={"display_name": "Writer Bot"})
    assert r.status_code == 200
    assert r.json()["display_name"] == "Writer Bot"


def test_update_meta_default_readonly(client):
    r = client.patch("/api/profiles/default", json={"display_name": "x"})
    assert r.status_code == 403


def test_delete_default_forbidden(client):
    r = client.delete("/api/profiles/default")
    assert r.status_code == 403
