import os
from pathlib import Path
from fastapi.testclient import TestClient
import pytest

@pytest.fixture
def client(tmp_path, monkeypatch):
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
    from main import app
    return TestClient(app)

def test_list(client):
    r = client.get("/api/profiles")
    assert r.status_code == 200
    names = [p["name"] for p in r.json()["profiles"]]
    assert "wms_writer" in names

def test_get_detail(client):
    r = client.get("/api/profiles/wms_writer")
    assert r.status_code == 200
    assert r.json()["soul"] == "hi\n"

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
