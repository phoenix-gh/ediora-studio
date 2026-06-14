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
        if mod.startswith(("database", "models", "main", "routers", "config", "scheduler", "logger")):
            sys.modules.pop(mod, None)
    from database import engine, Base
    import models  # noqa: F401

    async def _create():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    asyncio.new_event_loop().run_until_complete(_create())
    from main import app
    return TestClient(app)


def _seed_account(client, acc_id="gzh", name="主号"):
    r = client.post("/api/publish-accounts", json={"id": acc_id, "name": name, "platform": "wechat"})
    assert r.status_code == 201, r.text


def _create_pub(client, **over):
    body = {"draft_id": 1, "account_id": "gzh", "title": "测试文章"}
    body.update(over)
    r = client.post("/api/published-articles", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def test_create_returns_account_name_and_defaults(client):
    _seed_account(client)
    pub = _create_pub(client)
    assert pub["account_name"] == "主号"
    assert pub["status"] == "draft_box"
    assert pub["read_count"] == 0
    assert pub["published_at"] is None


def test_patch_stats_sets_stats_as_of(client):
    _seed_account(client)
    pub = _create_pub(client)
    assert pub["stats_as_of"] is None
    r = client.patch(f"/api/published-articles/{pub['id']}", json={"read_count": 1234, "like_count": 56})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["read_count"] == 1234
    assert body["like_count"] == 56
    assert body["stats_as_of"] is not None


def test_mark_published_sets_published_at(client):
    _seed_account(client)
    pub = _create_pub(client)
    r = client.patch(f"/api/published-articles/{pub['id']}", json={"status": "published"})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "published"
    assert r.json()["published_at"] is not None


def test_negative_stat_rejected(client):
    _seed_account(client)
    pub = _create_pub(client)
    r = client.patch(f"/api/published-articles/{pub['id']}", json={"read_count": -5})
    assert r.status_code == 400


def test_list_sorted_by_read_desc(client):
    _seed_account(client)
    _create_pub(client, title="低")
    a = _create_pub(client, title="A")
    b = _create_pub(client, title="B")
    client.patch(f"/api/published-articles/{a['id']}", json={"read_count": 10})
    client.patch(f"/api/published-articles/{b['id']}", json={"read_count": 99})
    rows = client.get("/api/published-articles").json()
    assert [r["title"] for r in rows][:2] == ["B", "A"]


def test_delete(client):
    _seed_account(client)
    pub = _create_pub(client)
    assert client.delete(f"/api/published-articles/{pub['id']}").status_code == 204
    assert client.get("/api/published-articles").json() == []


def test_patch_explicit_null_stat_ignored_not_500(client):
    """显式传 null 的统计字段视为「不改」，不能把非空列写成 NULL 触发 500。"""
    _seed_account(client)
    pub = _create_pub(client)
    r = client.patch(f"/api/published-articles/{pub['id']}",
                     json={"read_count": None, "url": "https://mp.weixin.qq.com/s/x"})
    assert r.status_code == 200, r.text
    assert r.json()["read_count"] == 0            # 未被改成 null，保持默认 0
    assert r.json()["url"] == "https://mp.weixin.qq.com/s/x"  # 正常字段照常更新
