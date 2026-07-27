import asyncio
import sys

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture
def api(monkeypatch, tmp_path):
    monkeypatch.setenv(
        "WMS_DATABASE_URL",
        f"sqlite+aiosqlite:///{tmp_path / 'asset-directories.db'}",
    )
    for module in list(sys.modules):
        if module.startswith(
            ("database", "models", "routers.assets")
        ):
            sys.modules.pop(module, None)

    from database import Base, SessionLocal, engine, get_db
    import models  # noqa: F401
    import routers.assets as router_module

    async def setup():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.new_event_loop().run_until_complete(setup())
    app = FastAPI()
    app.include_router(router_module.router, prefix="/api")

    async def override_db():
        async with SessionLocal() as session:
            yield session

    app.dependency_overrides[get_db] = override_db
    return TestClient(app), SessionLocal


def _seed_directories(session_factory):
    async def run():
        from models import CreativeAssetDirectory

        async with session_factory() as session:
            system = CreativeAssetDirectory(
                name="数字人资产",
                asset_type="media",
                parent_id=None,
                system_key="digital_human_assets",
            )
            ordinary = CreativeAssetDirectory(
                name="普通目录",
                asset_type="media",
                parent_id=None,
            )
            session.add_all([system, ordinary])
            await session.commit()
            return system.id, ordinary.id

    return asyncio.new_event_loop().run_until_complete(run())


def test_directory_listing_marks_system_directory(api):
    client, session_factory = api
    system_id, ordinary_id = _seed_directories(session_factory)

    response = client.get(
        "/api/assets/directories?asset_type=media"
    )

    assert response.status_code == 200, response.text
    directories = {
        item["id"]: item for item in response.json()
    }
    assert directories[system_id]["is_system"] is True
    assert directories[ordinary_id]["is_system"] is False


def test_system_directory_cannot_be_renamed(api):
    client, session_factory = api
    system_id, _ = _seed_directories(session_factory)

    response = client.patch(
        f"/api/assets/directories/{system_id}",
        json={"name": "改名", "asset_type": "media"},
    )

    assert response.status_code == 409
    assert response.json()["detail"] == "系统目录不能重命名"


def test_system_directory_cannot_be_deleted(api):
    client, session_factory = api
    system_id, _ = _seed_directories(session_factory)

    response = client.delete(
        f"/api/assets/directories/{system_id}"
    )

    assert response.status_code == 409
    assert response.json()["detail"] == "系统目录不能删除"


def test_ordinary_directory_can_still_be_renamed_and_deleted(api):
    client, session_factory = api
    _, ordinary_id = _seed_directories(session_factory)

    renamed = client.patch(
        f"/api/assets/directories/{ordinary_id}",
        json={"name": "普通目录新名称", "asset_type": "media"},
    )
    deleted = client.delete(
        f"/api/assets/directories/{ordinary_id}"
    )

    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["name"] == "普通目录新名称"
    assert deleted.status_code == 204, deleted.text


def test_article_content_hash_normalizes_whitespace():
    import routers.assets as router_module

    assert (
        router_module._article_content_hash("  同一条\n  原始内容  ")
        == router_module._article_content_hash("同一条 原始内容")
    )


def test_article_assets_deduplicate_canonical_url_within_theme(api):
    client, _ = api
    first = client.post("/api/assets", json={
        "asset_type": "article", "content": "第一份原始内容", "url": "https://x.com/a/status/1?utm_source=x#reply", "directory": "副业搞钱",
    })
    repeated = client.post("/api/assets", json={
        "asset_type": "article", "content": "另一份内容", "url": "https://X.COM/a/status/1/", "directory": "副业搞钱",
    })
    another_theme = client.post("/api/assets", json={
        "asset_type": "article", "content": "另一份内容", "url": "https://x.com/a/status/1", "directory": "AI",
    })

    assert first.status_code == 201, first.text
    assert repeated.status_code == 409
    assert another_theme.status_code == 201, another_theme.text


def test_article_assets_without_url_deduplicate_by_normalized_content_and_validate_edit(api):
    client, _ = api
    first = client.post("/api/assets", json={
        "asset_type": "article", "content": "一条\n 原始 素材", "directory": "副业搞钱",
    })
    second = client.post("/api/assets", json={
        "asset_type": "article", "content": "另一条素材", "directory": "副业搞钱",
    })
    duplicate = client.post("/api/assets", json={
        "asset_type": "article", "content": " 一条 原始  素材 ", "directory": "副业搞钱",
    })
    edit = client.patch(f"/api/assets/{second.json()['id']}", json={"content": "一条 原始 素材"})

    assert first.status_code == 201, first.text
    assert second.status_code == 201, second.text
    assert duplicate.status_code == 409
    assert edit.status_code == 409


def test_topic_rule_exposes_only_keyword_matched_x_post_snapshots(api):
    client, session_factory = api

    async def seed():
        from datetime import datetime, timezone
        from models import XPost, XSubscription

        async with session_factory() as session:
            subscription = XSubscription(url="https://x.com/example", label="Example")
            session.add(subscription)
            await session.flush()
            session.add_all([
                XPost(tweet_id="matched", subscription_id=subscription.id, username="example", content="副业收入的实操方法", url="https://x.com/example/status/1", published_at=datetime.now(timezone.utc)),
                XPost(tweet_id="skipped", subscription_id=subscription.id, username="example", content="今天的随手记录", url="https://x.com/example/status/2", published_at=datetime.now(timezone.utc)),
            ])
            await session.commit()
            return subscription.id

    subscription_id = asyncio.new_event_loop().run_until_complete(seed())
    created = client.post("/api/assets/topic-rules", json={
        "subscription_id": subscription_id,
        "directory": "副业搞钱",
        "keywords": ["副业", "收入"],
    })
    candidates = client.get(f"/api/assets/topic-rules/{created.json()['id']}/candidates")

    assert created.status_code == 201, created.text
    assert candidates.status_code == 200, candidates.text
    assert candidates.json()["posts"] == [{
        "tweet_id": "matched",
        "content": "副业收入的实操方法",
        "url": "https://x.com/example/status/1",
    }]


def test_daily_candidates_returns_at_most_ten_articles_from_selected_theme(api):
    client, _ = api
    for index in range(12):
        response = client.post("/api/assets", json={
            "asset_type": "article", "content": f"副业素材 {index}", "directory": "副业搞钱",
        })
        assert response.status_code == 201, response.text
    client.post("/api/assets", json={
        "asset_type": "article", "content": "不应出现", "directory": "AI",
    })

    response = client.get("/api/assets/daily-candidates?directory=副业搞钱")

    assert response.status_code == 200, response.text
    assert len(response.json()["assets"]) == 10
    assert {item["directory"] for item in response.json()["assets"]} == {"副业搞钱"}


def test_daily_candidate_selection_marks_materials_so_they_do_not_repeat(api):
    client, _ = api
    for index in range(12):
        response = client.post("/api/assets", json={
            "asset_type": "article", "content": f"每日素材 {index}", "directory": "副业搞钱",
        })
        assert response.status_code == 201, response.text

    first = client.post("/api/assets/daily-candidates", json={"directory": "副业搞钱"})
    second = client.post("/api/assets/daily-candidates", json={"directory": "副业搞钱"})

    first_ids = {item["id"] for item in first.json()["assets"]}
    second_ids = {item["id"] for item in second.json()["assets"]}
    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert len(first_ids) == 10
    assert len(second_ids) == 2
    assert first_ids.isdisjoint(second_ids)


def test_topic_source_persists_accept_and_reject_decisions(api, monkeypatch):
    client, session_factory = api
    monkeypatch.setenv("WMS_WORKER_TOKEN", "topic-source-worker-token-which-is-long-enough")

    async def seed():
        from datetime import datetime, timezone
        from models import XPost, XSubscription

        async with session_factory() as session:
            subscription = XSubscription(url="https://x.com/decisions", label="Decisions")
            session.add(subscription)
            await session.flush()
            session.add_all([
                XPost(tweet_id="keep", subscription_id=subscription.id, username="x", content="副业的实操经验", url="https://x.com/x/status/keep", published_at=datetime.now(timezone.utc)),
                XPost(tweet_id="reject", subscription_id=subscription.id, username="x", content="副业的无关闲聊", url="https://x.com/x/status/reject", published_at=datetime.now(timezone.utc)),
            ])
            await session.commit()
            return subscription.id

    subscription_id = asyncio.new_event_loop().run_until_complete(seed())
    rule = client.post("/api/assets/topic-rules", json={
        "subscription_id": subscription_id, "directory": "副业搞钱", "keywords": ["副业"],
    }).json()
    result = client.post(
        f"/api/assets/topic-rules/{rule['id']}/accepted",
        json={"decisions": [
            {"tweet_id": "keep", "accepted": True},
            {"tweet_id": "reject", "accepted": False},
        ]},
        headers={"X-WMS-Worker-Token": "topic-source-worker-token-which-is-long-enough"},
    )
    remaining = client.get(f"/api/assets/topic-rules/{rule['id']}/candidates")

    assert result.status_code == 200, result.text
    assert result.json() == {"saved": 1, "skipped": 0, "decided": 2}
    assert remaining.json()["posts"] == []
