import sys, asyncio, pytest
from unittest.mock import patch, AsyncMock
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
    import models  # noqa
    async def _create():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    asyncio.new_event_loop().run_until_complete(_create())
    from main import app
    return TestClient(app)


def test_manual_create_and_list(client):
    r = client.post("/api/materials", json={"text": "一句金句", "scene_tags": ["opener"]})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["platform"] == "manual" and body["text"] == "一句金句"
    items = client.get("/api/materials").json()
    assert len(items) == 1 and items[0]["scene_tags"] == ["opener"]


def test_categories_endpoint(client):
    cats = client.get("/api/materials/categories").json()
    assert "沙雕搞笑" in cats and "其他" in cats


def test_rules_crud_and_collect(client):
    r = client.post("/api/materials/rules", json={"label": "泛流量", "min_faves": 1500})
    assert r.status_code == 201, r.text
    rid = r.json()["id"]
    assert client.get("/api/materials/rules").json()[0]["label"] == "泛流量"

    with patch("routers.materials.collect_rule", new=AsyncMock(return_value=3)):
        c = client.post(f"/api/materials/rules/{rid}/collect")
    assert c.status_code == 200 and c.json()["new_raw"] == 3


def test_browse_filters_by_category(client):
    client.post("/api/materials", json={"text": "高分沙雕", "category": "沙雕搞笑"})
    client.post("/api/materials", json={"text": "吐槽", "category": "吐槽锐评"})
    only = client.get("/api/materials?category=沙雕搞笑").json()
    assert [m["text"] for m in only] == ["高分沙雕"]
