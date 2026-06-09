import asyncio
import sys
from pathlib import Path
import pytest
from fastapi.testclient import TestClient


def _make_skill(root: Path, name: str, description=""):
    d = root / name
    d.mkdir(parents=True)
    (d / "SKILL.md").write_text(
        f'---\nname: {name}\ndescription: "{description}"\nversion: 1.0.0\n---\n# {name}\n',
        encoding="utf-8",
    )


@pytest.fixture
def client(tmp_path, monkeypatch):
    db_file = tmp_path / "test.db"
    skills_root = tmp_path / "skills"
    _make_skill(skills_root, "x-post", "推文")
    _make_skill(skills_root, "content-ideation", "选题")
    home = tmp_path / "hermes"
    (home / "profiles" / "wms_writer").mkdir(parents=True)
    (home / "profiles" / "wms_writer" / "SOUL.md").write_text("hi\n")
    (home / "profiles" / "wms_writer" / "config.yaml").write_text(
        "model:\n  default: x\ntoolsets: []\nagent:\n  disabled_toolsets: []\n"
        "skills:\n  disabled: []\nmcp_servers: {}\n"
    )
    (home / "SOUL.md").write_text("\n")
    (home / "config.yaml").write_text("model:\n  default: y\n")

    monkeypatch.setenv("WEMS_SKILLS_ROOT", str(skills_root))
    monkeypatch.setenv("HERMES_HOME_ROOT", str(home))
    monkeypatch.setenv("WMS_DISABLE_SCHEDULER", "1")
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{db_file}")

    # Reset module cache so the new DB URL + routers are picked up.
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


def test_list_all_skills(client):
    r = client.get("/api/skills")
    assert r.status_code == 200
    names = [s["name"] for s in r.json()["skills"]]
    assert names == ["content-ideation", "x-post"]


def test_list_profile_skills_default_uninstalled(client):
    r = client.get("/api/profiles/wms_writer/project-skills")
    assert r.status_code == 200
    rows = {s["name"]: s for s in r.json()["skills"]}
    assert rows["x-post"]["installed"] is False


def test_install_then_uninstall_roundtrip(client):
    r = client.post("/api/profiles/wms_writer/project-skills/x-post")
    assert r.status_code == 200
    r = client.get("/api/profiles/wms_writer/project-skills")
    rows = {s["name"]: s for s in r.json()["skills"]}
    assert rows["x-post"]["installed"] is True
    r = client.delete("/api/profiles/wms_writer/project-skills/x-post")
    assert r.status_code == 204
    r = client.get("/api/profiles/wms_writer/project-skills")
    rows = {s["name"]: s for s in r.json()["skills"]}
    assert rows["x-post"]["installed"] is False


def test_install_missing_skill_404(client):
    r = client.post("/api/profiles/wms_writer/project-skills/nope")
    assert r.status_code == 404


def test_install_default_profile_403(client):
    r = client.post("/api/profiles/default/project-skills/x-post")
    assert r.status_code == 403
