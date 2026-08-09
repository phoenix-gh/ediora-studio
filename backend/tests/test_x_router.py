import sys
import asyncio
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from cryptography.fernet import Fernet


@pytest.fixture
def client(monkeypatch, tmp_path, postgres_env):
    monkeypatch.setenv("FEEDGRAB_DATA_DIR", str(tmp_path / "sessions"))
    monkeypatch.setenv("WMS_X_SESSION_KEY", Fernet.generate_key().decode())

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
    assert body["collect_interval_minutes"] == 15


def test_subscription_can_select_and_replace_multiple_ingestion_directories(client):
    folders = []
    for name in ("AI 工具", "副业搞钱"):
        created = client.post(
            "/api/assets/directories",
            json={"name": name, "asset_type": "article"},
        )
        assert created.status_code == 201, created.text
        directory_id = created.json()["id"]
        configured = client.put(
            f"/api/assets/directories/{directory_id}/ingestion-rule",
            json={"enabled": True, "keywords": [name], "prompt": f"只接受{name}内容"},
        )
        assert configured.status_code == 200, configured.text
        folders.append(directory_id)

    created = client.post(BASE, json={
        "url": "https://x.com/multi-folder",
        "ingestion_directory_ids": folders,
    })
    replaced = client.patch(
        f"{BASE}/{created.json()['id']}",
        json={"ingestion_directory_ids": [folders[1]]},
    )

    assert created.status_code == 200, created.text
    assert created.json()["ingestion_directory_ids"] == folders
    assert replaced.status_code == 200, replaced.text
    assert replaced.json()["ingestion_directory_ids"] == [folders[1]]


def test_subscription_rejects_unconfigured_ingestion_directory(client):
    directory = client.post(
        "/api/assets/directories",
        json={"name": "未配置目录", "asset_type": "article"},
    ).json()

    response = client.post(BASE, json={
        "url": "https://x.com/unconfigured-folder",
        "ingestion_directory_ids": [directory["id"]],
    })

    assert response.status_code == 422, response.text


def test_delete_subscription_cleans_ingestion_directory_associations(client):
    from database import SessionLocal
    from models import XSubscriptionIngestionDirectory

    directory = client.post(
        "/api/assets/directories",
        json={"name": "待清理目录", "asset_type": "article"},
    ).json()
    client.put(
        f"/api/assets/directories/{directory['id']}/ingestion-rule",
        json={"enabled": True, "keywords": [], "prompt": "只接受相关内容"},
    )
    subscription = client.post(BASE, json={
        "url": "https://x.com/association-cleanup",
        "ingestion_directory_ids": [directory["id"]],
    }).json()

    deleted = client.delete(f"{BASE}/{subscription['id']}")

    async def read_associations():
        async with SessionLocal() as session:
            return (await session.execute(
                XSubscriptionIngestionDirectory.__table__.select()
                .where(XSubscriptionIngestionDirectory.subscription_id == subscription["id"])
            )).mappings().all()

    associations = asyncio.new_event_loop().run_until_complete(read_associations())
    assert deleted.status_code == 200, deleted.text
    assert associations == []


def test_new_subscription_uses_saved_global_default(client):
    from database import SessionLocal
    from models import AppSetting

    async def save_default():
        async with SessionLocal() as db:
            db.add(AppSetting(key="x_collect_interval_minutes", value="60"))
            await db.commit()

    asyncio.new_event_loop().run_until_complete(save_default())

    response = client.post(BASE, json={"url": "https://x.com/global-default"})

    assert response.status_code == 200, response.text
    assert response.json()["collect_interval_minutes"] == 60


def test_subscription_collection_interval_can_be_updated(client):
    sub = client.post(BASE, json={"url": "https://x.com/interval"}).json()

    response = client.patch(
        f"{BASE}/{sub['id']}",
        json={"collect_interval_minutes": 60},
    )

    assert response.status_code == 200, response.text
    assert response.json()["collect_interval_minutes"] == 60


@pytest.mark.parametrize("interval", [4, 1441])
def test_subscription_collection_interval_rejects_out_of_range(client, interval):
    sub = client.post(BASE, json={"url": "https://x.com/interval-bound"}).json()

    response = client.patch(
        f"{BASE}/{sub['id']}",
        json={"collect_interval_minutes": interval},
    )

    assert response.status_code == 422


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
from unittest.mock import ANY, patch, AsyncMock


def _fake_post(tid="111", views=100, published_at=None, is_reply=False):
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
        is_reply=is_reply,
    )


def test_collect_stores_is_reply_flag(client):
    sub = client.post(BASE, json={"url": "https://x.com/foo"}).json()
    with patch("routers.x.grab_timeline",
               new=AsyncMock(return_value=[_fake_post("orig"),
                                           _fake_post("rep", is_reply=True)])):
        r = client.post(f"/api/x/subscriptions/{sub['id']}/collect-sync")
    assert r.status_code == 200, r.text
    posts = {p["tweet_id"]: p for p in client.get("/api/x/posts").json()}
    assert posts["orig"]["is_reply"] is False
    assert posts["rep"]["is_reply"] is True


def test_recollect_corrects_stale_is_reply_flag(client):
    # 修复前入库的回复贴 is_reply=False（ALTER 默认值）；重采时 upsert 必须
    # 用最新解析值纠正，否则 collected_at 被刷新而 is_reply 永远是错的。
    sub = client.post(BASE, json={"url": "https://x.com/foo"}).json()
    with patch("routers.x.grab_timeline",
               new=AsyncMock(return_value=[_fake_post("t1", is_reply=False)])):
        client.post(f"/api/x/subscriptions/{sub['id']}/collect-sync")
    with patch("routers.x.grab_timeline",
               new=AsyncMock(return_value=[_fake_post("t1", is_reply=True)])):
        r = client.post(f"/api/x/subscriptions/{sub['id']}/collect-sync")
    assert r.status_code == 200, r.text
    posts = {p["tweet_id"]: p for p in client.get("/api/x/posts").json()}
    assert posts["t1"]["is_reply"] is True


def test_auth_status_counts_managed_and_external_accounts(client, monkeypatch):
    monkeypatch.delenv("X_AUTH_TOKEN", raising=False)
    monkeypatch.delenv("X_CT0", raising=False)
    created = client.post("/api/x/accounts", json={
        "name": "采集账号 A",
        "auth_token": "managed-auth-token-value-auth",
        "ct0": "managed-csrf-token-value-csrf",
        "enabled": True,
    })
    assert created.status_code == 200, created.text
    data_dir = Path(os.environ["FEEDGRAB_DATA_DIR"])
    (data_dir / "x.json").write_text(
        '{"auth_token":"external-auth-token-value",'
        '"ct0":"external-csrf-token-value"}'
    )
    from feedgrab.fetchers import twitter_cookies

    twitter_cookies._rate_limited_accounts.clear()
    twitter_cookies._current_account_key = ""
    monkeypatch.setattr(twitter_cookies, "COOKIE_DIR", data_dir)
    monkeypatch.setattr(twitter_cookies, "SESSION_DIR", data_dir)
    monkeypatch.setattr(twitter_cookies, "_LEGACY_COOKIE_DIRS", [])
    monkeypatch.setattr(twitter_cookies, "_LEGACY_SESSION_DIRS", [])
    monkeypatch.setattr(twitter_cookies, "_load_from_chrome_cdp", lambda: {})

    r = client.get("/api/x/auth-status")

    assert r.status_code == 200
    body = r.json()
    assert set(body) == {
        "ready",
        "hint",
        "managed_accounts",
        "external_sessions",
        "total_accounts",
        "available_accounts",
    }
    assert body["ready"] is True
    assert isinstance(body["hint"], str)
    assert body["managed_accounts"] == 1
    assert body["external_sessions"] == 1
    assert body["total_accounts"] == 2
    assert body["available_accounts"] == 2


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


def test_collection_restores_missing_managed_session_before_feedgrab(client):
    account = client.post("/api/x/accounts", json={
        "name": "采集账号 A",
        "auth_token": "managed-auth-token",
        "ct0": "managed-csrf-token",
        "enabled": True,
    }).json()["accounts"][0]
    data_dir = Path(os.environ["FEEDGRAB_DATA_DIR"])
    managed_file = data_dir / "x_1.json"
    managed_file.unlink()
    sub = client.post(BASE, json={"url": "https://x.com/restored"}).json()
    observed = []

    async def fetch(url, **kwargs):
        observed.append((url, managed_file.read_text()))
        return []

    with patch("routers.x.grab_timeline", new=AsyncMock(side_effect=fetch)):
        response = client.post(f"{BASE}/{sub['id']}/collect-sync")

    assert response.status_code == 200, response.text
    assert observed == [
        ("https://x.com/restored", '{"auth_token":"managed-auth-token","ct0":"managed-csrf-token"}')
    ]
    assert account["id"] == 1


def test_collection_does_not_start_when_database_session_cannot_restore(client):
    client.post("/api/x/accounts", json={
        "name": "缺失凭据账号",
        "auth_token": "managed-auth-token",
        "ct0": "managed-csrf-token",
        "enabled": True,
    })
    from database import SessionLocal
    from models import XCredentialAccount
    from sqlalchemy import select

    async def remove_database_session():
        async with SessionLocal() as db:
            account = await db.scalar(select(XCredentialAccount))
            account.session_ciphertext = ""
            await db.commit()

    asyncio.run(remove_database_session())
    data_dir = Path(os.environ["FEEDGRAB_DATA_DIR"])
    (data_dir / "x_1.json").unlink()
    sub = client.post(BASE, json={"url": "https://x.com/no-session"}).json()
    grab = AsyncMock(return_value=[])

    with patch("routers.x.grab_timeline", new=grab):
        response = client.post(f"{BASE}/{sub['id']}/collect-sync")

    assert response.status_code == 502
    assert "凭据文件" in response.json()["detail"]
    grab.assert_not_awaited()


def test_collect_dispatches_new_posts_to_enabled_topic_source_rules(client):
    sub = client.post(
        "/api/x/subscriptions", json={"url": "https://x.com/topic-source"}).json()
    rule = client.post("/api/assets/topic-rules", json={
        "subscription_id": sub["id"], "directory": "副业搞钱", "keywords": ["副业"],
    })
    assert rule.status_code == 201, rule.text

    with patch("routers.x.grab_timeline", new=AsyncMock(return_value=[_fake_post("topic-1")])), \
         patch("topic_source_service.dispatch_topic_source_posts", new=AsyncMock(return_value={"created": 1, "enqueued": 1, "errors": []})) as dispatch:
        response = client.post(f"/api/x/subscriptions/{sub['id']}/collect-sync")

    assert response.status_code == 200, response.text
    dispatch.assert_awaited_once_with(ANY, sub["id"], ["topic-1"])


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


def test_backfill_passes_requested_day_cutoff_to_grab(client):
    sub = client.post(BASE, json={"url": "https://x.com/foo"}).json()
    mock = AsyncMock(return_value=[_fake_post("backfill-1")])

    with patch("routers.x.grab_timeline", new=mock):
        response = client.post(f"{BASE}/{sub['id']}/backfill", json={"days": 7})

    assert response.status_code == 200, response.text
    assert response.json()["new_posts"] == 1
    _, kwargs = mock.await_args
    delta = (datetime.now(timezone.utc) - kwargs["since"]).total_seconds()
    assert 6 * 86400 < delta < 8 * 86400


def test_backfill_rejects_search_subscription(client):
    sub = client.post(BASE, json={
        "kind": "search", "raw_query": "AI", "max_results": 30,
    }).json()

    response = client.post(f"{BASE}/{sub['id']}/backfill", json={"days": 7})

    assert response.status_code == 422
    assert response.json()["detail"] == "仅个人账号订阅支持回溯采集"


@pytest.mark.parametrize("days", [0, 91])
def test_backfill_rejects_out_of_range_days(client, days):
    sub = client.post(BASE, json={"url": "https://x.com/foo"}).json()

    response = client.post(f"{BASE}/{sub['id']}/backfill", json={"days": days})

    assert response.status_code == 422


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


# ── 情报分析 ──────────────────────────────────────────────────────────────────


def test_subscription_intelligence_defaults_off(client):
    sub = client.post(BASE, json={"url": "https://x.com/a"}).json()
    assert sub["intelligence_enabled"] is False
    assert sub["intelligence_enabled_at"] is None


def test_patch_intelligence_on_then_off(client):
    sub = client.post(BASE, json={"url": "https://x.com/a"}).json()
    r = client.patch(f"{BASE}/{sub['id']}", json={"intelligence_enabled": True})
    assert r.status_code == 200, r.text
    assert r.json()["intelligence_enabled"] is True
    assert r.json()["intelligence_enabled_at"] is not None
    r = client.patch(f"{BASE}/{sub['id']}", json={"intelligence_enabled": False})
    assert r.status_code == 200
    assert r.json()["intelligence_enabled"] is False
    assert r.json()["intelligence_enabled_at"] is None


def test_search_subscription_can_enable_intelligence_analysis(client):
    sub = client.post(BASE, json={
        "kind": "search", "raw_query": "AI lang:zh",
    }).json()

    response = client.patch(
        f"{BASE}/{sub['id']}",
        json={"intelligence_enabled": True},
    )

    assert response.status_code == 200, response.text
    assert response.json()["intelligence_enabled"] is True


def test_repeated_collect_reports_only_genuinely_new_posts(client):
    sub = client.post(BASE, json={"url": "https://x.com/a"}).json()
    post = _fake_post("same")

    with patch("routers.x.grab_timeline", new=AsyncMock(return_value=[post])):
        first = client.post(f"{BASE}/{sub['id']}/collect-sync")
    with patch("routers.x.grab_timeline", new=AsyncMock(return_value=[post])):
        second = client.post(f"{BASE}/{sub['id']}/collect-sync")

    assert first.json()["new_posts"] == 1
    assert second.json()["new_posts"] == 0


def test_collect_dispatches_only_fresh_posts(client):
    sub = client.post(BASE, json={"url": "https://x.com/a"}).json()
    client.patch(f"{BASE}/{sub['id']}", json={"intelligence_enabled": True})

    dispatched: list[list[str]] = []

    async def fake_dispatch(db, subscription, tweet_ids):
        dispatched.append(list(tweet_ids))
        return {"created": len(tweet_ids), "enqueued": len(tweet_ids), "errors": []}

    with (
        patch("routers.x.grab_timeline", new=AsyncMock(return_value=[
            _fake_post("original"),
            _fake_post("reply", is_reply=True),
        ])),
        patch("content_response_service.dispatch_intelligence_posts", new=fake_dispatch),
    ):
        response = client.post(f"{BASE}/{sub['id']}/collect-sync")

    assert response.status_code == 200
    assert response.json()["new_posts"] == 2
    assert dispatched == [["original", "reply"]]


def test_patch_intelligence_on_stamps_enabled_at(client):
    """开启情报分析须记录生效时间（只分析之后采集的帖子）。"""
    sub = client.post(BASE, json={"url": "https://x.com/a"}).json()
    client.patch(f"{BASE}/{sub['id']}", json={"intelligence_enabled": True})

    import asyncio as _asyncio
    from database import SessionLocal
    from models import XSubscription

    async def _fetch():
        async with SessionLocal() as db:
            return await db.get(XSubscription, sub["id"])

    row = _asyncio.new_event_loop().run_until_complete(_fetch())
    assert row.intelligence_enabled is True
    assert row.intelligence_enabled_at is not None

    client.patch(f"{BASE}/{sub['id']}", json={"intelligence_enabled": False})
    row = _asyncio.new_event_loop().run_until_complete(_fetch())
    assert row.intelligence_enabled is False
    assert row.intelligence_enabled_at is None
