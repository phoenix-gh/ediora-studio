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
        if mod.startswith(("database", "models", "main", "routers", "config", "reddit")):
            sys.modules.pop(mod, None)

    from database import engine, Base
    import models  # noqa: F401

    async def _create():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    asyncio.new_event_loop().run_until_complete(_create())

    from main import app
    return TestClient(app)


BASE = "/api/reddit/subscriptions"


def test_list_empty(client):
    r = client.get(BASE)
    assert r.status_code == 200
    assert r.json() == []


def test_add_subscription(client):
    r = client.post(BASE, json={"subreddit": "programming"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["subreddit"] == "programming"
    assert body["label"] == "r/programming"
    assert body["muted"] is False
    assert body["post_count"] == 0


def test_add_subscription_strips_r_prefix(client):
    r = client.post(BASE, json={"subreddit": "r/rust"})
    assert r.status_code == 200
    assert r.json()["subreddit"] == "rust"


def test_add_subscription_custom_label(client):
    r = client.post(BASE, json={"subreddit": "Python", "label": "Python 社区"})
    assert r.status_code == 200
    body = r.json()
    assert body["subreddit"] == "python"   # stored lower-case
    assert body["label"] == "Python 社区"


def test_add_duplicate_rejected(client):
    client.post(BASE, json={"subreddit": "golang"})
    r = client.post(BASE, json={"subreddit": "golang"})
    assert r.status_code == 400


def test_add_empty_subreddit_rejected(client):
    r = client.post(BASE, json={"subreddit": "  "})
    assert r.status_code == 400


def test_patch_label(client):
    sub_id = client.post(BASE, json={"subreddit": "devops"}).json()["id"]
    r = client.patch(f"{BASE}/{sub_id}", json={"label": "DevOps 社区"})
    assert r.status_code == 200
    assert r.json()["label"] == "DevOps 社区"


def test_patch_muted(client):
    sub_id = client.post(BASE, json={"subreddit": "linux"}).json()["id"]
    r = client.patch(f"{BASE}/{sub_id}", json={"muted": True})
    assert r.status_code == 200
    assert r.json()["muted"] is True


def test_patch_nonexistent(client):
    r = client.patch(f"{BASE}/9999", json={"label": "x"})
    assert r.status_code == 404


def test_delete_subscription(client):
    sub_id = client.post(BASE, json={"subreddit": "netsec"}).json()["id"]
    r = client.delete(f"{BASE}/{sub_id}")
    assert r.status_code == 200
    assert r.json()["ok"] is True
    assert client.get(BASE).json() == []


def test_delete_nonexistent(client):
    r = client.delete(f"{BASE}/9999")
    assert r.status_code == 404


def test_list_posts_empty(client):
    r = client.get("/api/reddit/posts")
    assert r.status_code == 200
    assert r.json() == []


def test_list_posts_view_param_validation(client):
    r = client.get("/api/reddit/posts?view=invalid")
    assert r.status_code == 422


def test_collect_all_endpoint(client):
    r = client.post("/api/reddit/collect")
    assert r.status_code == 200
    assert r.json()["ok"] is True
