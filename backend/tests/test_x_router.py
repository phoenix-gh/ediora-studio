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


def test_delete_subscription_also_deletes_its_posts(client):
    sub = client.post(BASE, json={"url": "https://x.com/a"}).json()
    with patch("routers.x.grab_timeline",
               new=AsyncMock(return_value=[_fake_post("p1"), _fake_post("p2")])):
        client.post(f"/api/x/subscriptions/{sub['id']}/collect-sync")
    assert len(client.get("/api/x/posts").json()) == 2

    r = client.delete(f"{BASE}/{sub['id']}")
    assert r.status_code == 200
    # associated posts are gone
    assert client.get("/api/x/posts").json() == []


def test_delete_only_removes_its_own_posts(client):
    a = client.post(BASE, json={"url": "https://x.com/a"}).json()
    b = client.post(BASE, json={"url": "https://x.com/b"}).json()
    with patch("routers.x.grab_timeline",
               new=AsyncMock(return_value=[_fake_post("a1")])):
        client.post(f"/api/x/subscriptions/{a['id']}/collect-sync")
    with patch("routers.x.grab_timeline",
               new=AsyncMock(return_value=[_fake_post("b1")])):
        client.post(f"/api/x/subscriptions/{b['id']}/collect-sync")

    client.delete(f"{BASE}/{a['id']}")
    posts = client.get("/api/x/posts").json()
    assert {p["tweet_id"] for p in posts} == {"b1"}


def test_delete_missing_returns_404(client):
    r = client.delete(f"{BASE}/999")
    assert r.status_code == 404


from datetime import datetime, timezone, timedelta
from unittest.mock import patch, AsyncMock


def _fake_post(tid="111", views=100, published_at=None):
    from feedgrab_client import ParsedPost
    # Default to "now" so the post falls inside the 24h cutoff window
    # used by _collect_one's first-time collect path.
    if published_at is None:
        published_at = datetime.now(timezone.utc) - timedelta(minutes=5)
    return ParsedPost(
        tweet_id=tid,
        username="foo",
        display_name="Foo",
        content=f"body {tid}",
        url=f"https://x.com/foo/status/{tid}",
        published_at=published_at,
        replies=1, reposts=2, likes=5, views=views,
        raw_markdown="raw",
    )


def test_auth_status_endpoint(client):
    r = client.get("/api/x/auth-status")
    assert r.status_code == 200
    body = r.json()
    assert "ready" in body and "hint" in body
    assert isinstance(body["ready"], bool)


def test_search_returns_results(client):
    with patch("routers.x.search_x",
               new=AsyncMock(return_value=[_fake_post("111")])):
        r = client.get("/api/x/search", params={"q": "hello"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body) == 1
    assert body[0]["tweet_id"] == "111"


def test_search_requires_query(client):
    r = client.get("/api/x/search")
    # FastAPI returns 422 for missing required query param
    assert r.status_code == 422


def test_search_propagates_upstream_failure(client):
    with patch("routers.x.search_x",
               new=AsyncMock(side_effect=RuntimeError("no auth"))):
        r = client.get("/api/x/search", params={"q": "hello"})
    assert r.status_code == 502
    assert "no auth" in r.json()["detail"]


def test_collect_one_subscription(client):
    sub = client.post(
        "/api/x/subscriptions", json={"url": "https://x.com/foo"}).json()

    with patch("routers.x.grab_timeline",
               new=AsyncMock(return_value=[_fake_post("aaa"), _fake_post("bbb")])):
        r = client.post(f"/api/x/subscriptions/{sub['id']}/collect-sync")

    assert r.status_code == 200
    assert r.json()["new_posts"] == 2

    posts = client.get("/api/x/posts").json()
    assert len(posts) == 2
    assert {p["tweet_id"] for p in posts} == {"aaa", "bbb"}
    assert all(p["subscription_id"] == sub["id"] for p in posts)


def test_collect_one_records_error_on_failure(client):
    sub = client.post(
        "/api/x/subscriptions", json={"url": "https://x.com/foo"}).json()

    with patch("routers.x.grab_timeline",
               new=AsyncMock(side_effect=RuntimeError("boom"))):
        r = client.post(f"/api/x/subscriptions/{sub['id']}/collect-sync")

    assert r.status_code == 502

    after = client.get("/api/x/subscriptions").json()[0]
    assert after["last_error"] == "boom"


def test_collect_all_iterates_enabled_only(client):
    s1 = client.post(
        "/api/x/subscriptions", json={"url": "https://x.com/a"}).json()
    s2 = client.post(
        "/api/x/subscriptions", json={"url": "https://x.com/b"}).json()
    # disable s2
    client.patch(f"/api/x/subscriptions/{s2['id']}",
                 json={"enabled": False})

    with patch("routers.x.grab_timeline",
               new=AsyncMock(return_value=[_fake_post("111")])):
        r = client.post("/api/x/collect-all")

    assert r.status_code == 200
    body = r.json()
    assert body["checked"] == 1
    assert body["new_posts"] == 1
    assert body["failed"] == []


def test_collect_all_isolates_per_source_failure(client):
    s1 = client.post(
        "/api/x/subscriptions", json={"url": "https://x.com/a"}).json()
    s2 = client.post(
        "/api/x/subscriptions", json={"url": "https://x.com/b"}).json()

    call_count = {"n": 0}

    async def flaky(url, **kwargs):
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise RuntimeError("boom")
        return [_fake_post("ok")]

    with patch("routers.x.grab_timeline", side_effect=flaky):
        r = client.post("/api/x/collect-all")

    assert r.status_code == 200
    body = r.json()
    assert body["checked"] == 2
    assert body["new_posts"] == 1
    assert len(body["failed"]) == 1


def test_posts_filter_by_subscription(client):
    s1 = client.post(
        "/api/x/subscriptions", json={"url": "https://x.com/a"}).json()
    s2 = client.post(
        "/api/x/subscriptions", json={"url": "https://x.com/b"}).json()

    with patch("routers.x.grab_timeline",
               new=AsyncMock(return_value=[_fake_post("111")])):
        client.post(f"/api/x/subscriptions/{s1['id']}/collect-sync")
    with patch("routers.x.grab_timeline",
               new=AsyncMock(return_value=[_fake_post("222")])):
        client.post(f"/api/x/subscriptions/{s2['id']}/collect-sync")

    r = client.get(f"/api/x/posts?subscription_id={s1['id']}")
    assert r.status_code == 200
    posts = r.json()
    assert {p["tweet_id"] for p in posts} == {"111"}


# ── Incremental collect cutoff ────────────────────────────────────────────────


def test_collect_first_time_passes_24h_cutoff_to_grab(client):
    """No posts yet → grab_timeline called with since ≈ now − 24h."""
    sub = client.post(
        "/api/x/subscriptions", json={"url": "https://x.com/foo"}).json()

    mock = AsyncMock(return_value=[_fake_post("111")])
    with patch("routers.x.grab_timeline", new=mock):
        r = client.post(f"/api/x/subscriptions/{sub['id']}/collect-sync")
    assert r.status_code == 200

    # Inspect the since= kwarg passed to grab_timeline
    _, kwargs = mock.await_args
    since = kwargs["since"]
    now = datetime.now(timezone.utc)
    delta = (now - since).total_seconds()
    # Should be ~24h ± a few seconds
    assert 23 * 3600 < delta < 25 * 3600, f"unexpected cutoff: {since} (delta={delta})"


def test_collect_incremental_passes_hour_aligned_cutoff(client):
    """After a prior collect, grab_timeline gets since = hour-aligned latest
    stored published_at."""
    sub = client.post(
        "/api/x/subscriptions", json={"url": "https://x.com/foo"}).json()

    now = datetime.now(timezone.utc)
    seed_at = now - timedelta(hours=3, minutes=34)  # e.g. 13:26 if now=16:60
    seed = _fake_post("seed", published_at=seed_at)

    with patch("routers.x.grab_timeline",
               new=AsyncMock(return_value=[seed])):
        client.post(f"/api/x/subscriptions/{sub['id']}/collect-sync")

    # Second call — verify since= is seed_at hour-aligned
    mock = AsyncMock(return_value=[])
    with patch("routers.x.grab_timeline", new=mock):
        client.post(f"/api/x/subscriptions/{sub['id']}/collect-sync")

    _, kwargs = mock.await_args
    assert kwargs["since"] == seed_at.replace(minute=0, second=0, microsecond=0)


# ── Search subscriptions ──────────────────────────────────────────────────────


def test_create_search_subscription(client):
    r = client.post(BASE, json={
        "kind": "search", "label": "泛流量",
        "raw_query": "min_faves:1500 lang:zh", "max_results": 50,
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["kind"] == "search"
    assert body["label"] == "泛流量"
    assert body["url"] in (None, "")


def test_search_subscription_collect_calls_search_top(client):
    sub = client.post(BASE, json={
        "kind": "search", "raw_query": "min_faves:1500 lang:zh",
        "min_faves": 1500, "lang": "zh", "days": 2, "max_results": 30,
    }).json()

    mock = AsyncMock(return_value=[_fake_post("s1"), _fake_post("s2")])
    with patch("routers.x.search_top", new=mock):
        r = client.post(f"/api/x/subscriptions/{sub['id']}/collect-sync")
    assert r.status_code == 200, r.text
    assert r.json()["new_posts"] == 2

    _, kwargs = mock.await_args
    assert kwargs["raw_query"] == "min_faves:1500 lang:zh"
    assert kwargs["limit"] == 30

    posts = client.get(f"/api/x/posts?subscription_id={sub['id']}").json()
    assert {p["tweet_id"] for p in posts} == {"s1", "s2"}


def test_search_subscription_create_requires_query(client):
    r = client.post(BASE, json={"kind": "search", "raw_query": ""})
    assert r.status_code == 400


def test_patch_search_raw_query_and_max_results(client):
    sub = client.post(BASE, json={
        "kind": "search", "raw_query": "AI lang:zh", "max_results": 50,
    }).json()
    r = client.patch(f"{BASE}/{sub['id']}", json={
        "raw_query": "  (AI OR 大模型) lang:zh  ", "max_results": 80,
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["raw_query"] == "(AI OR 大模型) lang:zh"  # trimmed
    assert body["max_results"] == 80


def test_patch_max_results_clamped(client):
    sub = client.post(BASE, json={
        "kind": "search", "raw_query": "AI", "max_results": 50,
    }).json()
    r = client.patch(f"{BASE}/{sub['id']}", json={"max_results": 9999})
    assert r.status_code == 200, r.text
    assert r.json()["max_results"] == 500  # clamped to upper bound


def test_patch_raw_query_on_timeline_rejected(client):
    sub = client.post(BASE, json={"url": "https://x.com/a"}).json()
    r = client.patch(f"{BASE}/{sub['id']}", json={"raw_query": "AI"})
    assert r.status_code == 400


def test_patch_search_raw_query_empty_rejected(client):
    sub = client.post(BASE, json={
        "kind": "search", "raw_query": "AI", "max_results": 50,
    }).json()
    r = client.patch(f"{BASE}/{sub['id']}", json={"raw_query": "   "})
    assert r.status_code == 400


def test_create_timeline_with_explicit_label(client):
    r = client.post(BASE, json={
        "url": "https://x.com/elonmusk", "label": "马斯克",
    })
    assert r.status_code == 200, r.text
    assert r.json()["label"] == "马斯克"  # not auto "@elonmusk"


# ── 动态通知 ──────────────────────────────────────────────────────────────────


def test_subscription_notify_defaults_off(client):
    sub = client.post(BASE, json={"url": "https://x.com/a"}).json()
    assert sub["notify_new_posts"] is False


def test_patch_notify_on_then_off(client):
    sub = client.post(BASE, json={"url": "https://x.com/a"}).json()
    r = client.patch(f"{BASE}/{sub['id']}", json={"notify_new_posts": True})
    assert r.status_code == 200, r.text
    assert r.json()["notify_new_posts"] is True
    r = client.patch(f"{BASE}/{sub['id']}", json={"notify_new_posts": False})
    assert r.status_code == 200
    assert r.json()["notify_new_posts"] is False


def test_patch_notify_on_stamps_enabled_at(client):
    """开启动态通知须记录 notify_enabled_at（只推送之后采集的帖子）。"""
    sub = client.post(BASE, json={"url": "https://x.com/a"}).json()
    client.patch(f"{BASE}/{sub['id']}", json={"notify_new_posts": True})

    import asyncio as _asyncio
    from database import SessionLocal
    from models import XSubscription

    async def _fetch():
        async with SessionLocal() as db:
            return await db.get(XSubscription, sub["id"])

    row = _asyncio.new_event_loop().run_until_complete(_fetch())
    assert row.notify_new_posts is True
    assert row.notify_enabled_at is not None

    client.patch(f"{BASE}/{sub['id']}", json={"notify_new_posts": False})
    row = _asyncio.new_event_loop().run_until_complete(_fetch())
    assert row.notify_new_posts is False
    assert row.notify_enabled_at is None
