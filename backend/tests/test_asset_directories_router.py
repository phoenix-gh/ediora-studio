import asyncio
import sys

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture
def api(monkeypatch, postgres_env):
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


def test_article_directory_round_trips_ai_ingestion_rule_and_survives_rename(api):
    client, _ = api
    created = client.post(
        "/api/assets/directories",
        json={"name": "AI 工具", "asset_type": "article"},
    )
    directory_id = created.json()["id"]

    saved = client.put(
        f"/api/assets/directories/{directory_id}/ingestion-rule",
        json={
            "enabled": True,
            "keywords": [" AI ", "工具"],
            "prompt": "  只接受有实际用法的内容。  ",
        },
    )
    renamed = client.patch(
        f"/api/assets/directories/{directory_id}",
        json={"name": "AI 工具新名称", "asset_type": "article"},
    )
    listed = client.get("/api/assets/directories?asset_type=article")

    assert saved.status_code == 200, saved.text
    assert saved.json() == {
        "directory_id": directory_id,
        "enabled": True,
        "keywords": ["AI", "工具"],
        "prompt": "只接受有实际用法的内容。",
    }
    assert renamed.status_code == 200, renamed.text
    item = next(item for item in listed.json() if item["id"] == directory_id)
    assert item["name"] == "AI 工具新名称"
    assert item["ai_ingestion_enabled"] is True
    assert item["ai_ingestion_keywords"] == ["AI", "工具"]
    assert item["ai_ingestion_prompt"] == "只接受有实际用法的内容。"


def test_media_directory_cannot_configure_ai_article_ingestion(api):
    client, _ = api
    created = client.post(
        "/api/assets/directories",
        json={"name": "图片目录", "asset_type": "media"},
    )

    response = client.put(
        f"/api/assets/directories/{created.json()['id']}/ingestion-rule",
        json={"enabled": True, "keywords": [], "prompt": "图片规则"},
    )

    assert response.status_code == 422


def test_prompt_directory_round_trips_ai_ingestion_rule(api):
    client, _ = api
    created = client.post(
        "/api/assets/directories",
        json={"name": "图片提示词", "asset_type": "prompt"},
    )

    response = client.put(
        f"/api/assets/directories/{created.json()['id']}/ingestion-rule",
        json={"enabled": True, "keywords": ["提示词"], "prompt": "只接受可直接复用的图片提示词"},
    )

    assert response.status_code == 200, response.text
    assert response.json()["enabled"] is True
    assert response.json()["keywords"] == ["提示词"]


def test_directory_with_enabled_ai_ingestion_cannot_be_deleted(api):
    client, _ = api
    created = client.post(
        "/api/assets/directories",
        json={"name": "受保护目录", "asset_type": "article"},
    )
    directory_id = created.json()["id"]
    configured = client.put(
        f"/api/assets/directories/{directory_id}/ingestion-rule",
        json={"enabled": True, "keywords": [], "prompt": "只接受相关内容"},
    )
    deleted = client.delete(f"/api/assets/directories/{directory_id}")

    assert configured.status_code == 200, configured.text
    assert deleted.status_code == 409, deleted.text


def test_media_upload_can_be_assigned_to_an_existing_directory(api):
    client, _ = api
    _seed_directories(_)

    uploaded = client.post(
        "/api/assets/upload?media_kind=image&directory=%E6%99%AE%E9%80%9A%E7%9B%AE%E5%BD%95",
        files={"file": ("rank.png", b"fake-png", "image/png")},
    )
    rejected = client.post(
        "/api/assets/upload?media_kind=image&directory=%E4%B8%8D%E5%AD%98%E5%9C%A8",
        files={"file": ("rank.png", b"fake-png", "image/png")},
    )

    assert uploaded.status_code == 201, uploaded.text
    assert uploaded.json()["directory"] == "普通目录"
    assert rejected.status_code == 422


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
        "screening_prompt": "只接受有具体方法的内容。",
    })
    candidates = client.get(f"/api/assets/topic-rules/{created.json()['id']}/candidates")

    assert created.status_code == 201, created.text
    assert candidates.status_code == 200, candidates.text
    assert candidates.json()["rule"]["screening_prompt"] == "只接受有具体方法的内容。"
    assert candidates.json()["posts"] == [{
        "tweet_id": "matched",
        "content": "副业收入的实操方法",
        "url": "https://x.com/example/status/1",
    }]


def test_merged_ingestion_candidates_and_acceptance_choose_one_folder(api, monkeypatch):
    client, session_factory = api
    monkeypatch.setenv("WMS_WORKER_TOKEN", "merged-ingestion-worker-token-long")

    async def seed():
        from datetime import datetime, timezone
        from models import (
            CreativeAssetDirectory,
            XPost,
            XSubscription,
            XSubscriptionIngestionDirectory,
        )

        async with session_factory() as session:
            subscription = XSubscription(
                url="https://x.com/merged-ingestion",
                label="Merged ingestion",
            )
            folders = [
                CreativeAssetDirectory(
                    name="AI 工具",
                    asset_type="article",
                    ai_ingestion_enabled=True,
                    ai_ingestion_keywords=["AI"],
                    ai_ingestion_prompt="只接受 AI 工具实操。",
                ),
                CreativeAssetDirectory(
                    name="副业搞钱",
                    asset_type="article",
                    ai_ingestion_enabled=True,
                    ai_ingestion_keywords=["副业"],
                    ai_ingestion_prompt="只接受副业方法。",
                ),
            ]
            session.add_all([subscription, *folders])
            await session.flush()
            session.add_all([
                XSubscriptionIngestionDirectory(
                    subscription_id=subscription.id,
                    directory_id=folder.id,
                )
                for folder in folders
            ])
            session.add_all([
                XPost(
                    tweet_id="ai-post",
                    subscription_id=subscription.id,
                    username="example",
                    content="AI 工具的实操方法",
                    url="https://x.com/example/status/ai-post",
                    published_at=datetime.now(timezone.utc),
                ),
                XPost(
                    tweet_id="side-post",
                    subscription_id=subscription.id,
                    username="example",
                    content="副业收入的实操方法",
                    url="https://x.com/example/status/side-post",
                    published_at=datetime.now(timezone.utc),
                ),
                XPost(
                    tweet_id="noise-post",
                    subscription_id=subscription.id,
                    username="example",
                    content="今天的随手记录",
                    url="https://x.com/example/status/noise-post",
                    published_at=datetime.now(timezone.utc),
                ),
            ])
            await session.commit()
            return subscription.id, [folder.id for folder in folders]

    subscription_id, directory_ids = asyncio.new_event_loop().run_until_complete(seed())
    candidates = client.get(
        "/api/assets/ingestion/candidates",
        params=[
            ("subscription_id", subscription_id),
            ("directory_ids", directory_ids[0]),
            ("directory_ids", directory_ids[1]),
        ],
    )
    accepted = client.post(
        "/api/assets/ingestion/accepted",
        headers={"X-WMS-Worker-Token": "merged-ingestion-worker-token-long"},
        json={
            "subscription_id": subscription_id,
            "decisions": [
                {"tweet_id": "ai-post", "directory_id": directory_ids[0]},
                {"tweet_id": "side-post", "directory_id": None},
            ],
        },
    )
    assert candidates.status_code == 200, candidates.text
    assert {post["tweet_id"] for post in candidates.json()["posts"]} == {
        "ai-post",
        "side-post",
    }
    assert [folder["id"] for folder in candidates.json()["directories"]] == directory_ids
    assert accepted.status_code == 200, accepted.text
    assert accepted.json() == {"saved": 1, "skipped": 0, "decided": 2}
    assert client.get("/api/assets?asset_type=article").json()[0]["directory"] == "AI 工具"


def test_merged_ingestion_extracts_prompt_and_attaches_post_media(api, monkeypatch):
    client, session_factory = api
    monkeypatch.setenv("WMS_WORKER_TOKEN", "prompt-ingestion-worker-token-long")

    async def seed():
        from datetime import datetime, timezone
        from models import (
            CreativeAssetDirectory,
            XPost,
            XSubscription,
            XSubscriptionIngestionDirectory,
        )

        async with session_factory() as session:
            subscription = XSubscription(
                url="https://x.com/prompt-ingestion",
                label="Prompt ingestion",
            )
            article_directory = CreativeAssetDirectory(
                name="AI 文章",
                asset_type="article",
                ai_ingestion_enabled=True,
                ai_ingestion_prompt="只接受有方法的文章",
            )
            prompt_directory = CreativeAssetDirectory(
                name="图片提示词",
                asset_type="prompt",
                ai_ingestion_enabled=True,
                ai_ingestion_keywords=["提示词"],
                ai_ingestion_prompt="只接受可复用的图片提示词",
            )
            session.add_all([subscription, article_directory, prompt_directory])
            await session.flush()
            session.add_all([
                XSubscriptionIngestionDirectory(
                    subscription_id=subscription.id,
                    directory_id=article_directory.id,
                ),
                XSubscriptionIngestionDirectory(
                    subscription_id=subscription.id,
                    directory_id=prompt_directory.id,
                ),
                XPost(
                    tweet_id="prompt-post",
                    subscription_id=subscription.id,
                    username="example",
                    content="一个可复用的图片提示词",
                    url="https://x.com/example/status/prompt-post",
                    media=[
                        {"kind": "image", "url": "https://pbs.twimg.com/media/prompt.jpg"},
                        {"kind": "video", "url": "https://video.twimg.com/prompt.mp4"},
                    ],
                    published_at=datetime.now(timezone.utc),
                ),
            ])
            await session.commit()
            return subscription.id, article_directory.id, prompt_directory.id

    subscription_id, article_id, prompt_id = asyncio.new_event_loop().run_until_complete(seed())
    candidates = client.get(
        "/api/assets/ingestion/candidates",
        params={"subscription_id": subscription_id},
    )
    accepted = client.post(
        "/api/assets/ingestion/accepted",
        headers={"X-WMS-Worker-Token": "prompt-ingestion-worker-token-long"},
        json={
            "subscription_id": subscription_id,
            "decisions": [{"tweet_id": "prompt-post", "directory_id": None}],
            "prompt_assets": [{
                "tweet_id": "prompt-post",
                "directory_id": prompt_id,
                "prompt_kind": "image",
                "title": "图片提示词",
                "content": "一张电影感的未来城市海报",
                "media_indexes": [0],
            }],
        },
    )
    repeated = client.post(
        "/api/assets/ingestion/accepted",
        headers={"X-WMS-Worker-Token": "prompt-ingestion-worker-token-long"},
        json={
            "subscription_id": subscription_id,
            "decisions": [{"tweet_id": "prompt-post", "directory_id": None}],
            "prompt_assets": [{
                "tweet_id": "prompt-post",
                "directory_id": prompt_id,
                "prompt_kind": "image",
                "content": "一张电影感的未来城市海报",
                "media_indexes": [0],
            }],
        },
    )

    assert candidates.status_code == 200, candidates.text
    assert {item["asset_type"] for item in candidates.json()["directories"]} == {"article", "prompt"}
    assert candidates.json()["posts"][0]["media"] == [
        {"index": 0, "kind": "image", "url": "https://pbs.twimg.com/media/prompt.jpg"},
        {"index": 1, "kind": "video", "url": "https://video.twimg.com/prompt.mp4"},
    ]
    assert accepted.status_code == 200, accepted.text
    assert accepted.json() == {
        "saved": 0,
        "skipped": 0,
        "decided": 1,
        "prompt_saved": 1,
        "media_saved": 1,
        "prompt_skipped": 0,
    }
    assert repeated.status_code == 200, repeated.text
    assert repeated.json() == {
        "saved": 0,
        "skipped": 1,
        "decided": 0,
        "prompt_saved": 0,
        "media_saved": 0,
        "prompt_skipped": 1,
    }
    prompt_assets = client.get("/api/assets?asset_type=prompt").json()
    assert prompt_assets[0]["directory"] == "图片提示词"
    assert prompt_assets[0]["url"] == "https://x.com/example/status/prompt-post"
    generations = client.get(f"/api/assets/{prompt_assets[0]['id']}/generations").json()
    assert generations[0]["media"]["url"] == "https://pbs.twimg.com/media/prompt.jpg"
    assert generations[0]["media"]["directory"] == ""


def test_merged_ingestion_rejects_unassociated_directory(api):
    client, session_factory = api

    async def seed():
        from models import CreativeAssetDirectory, XSubscription, XSubscriptionIngestionDirectory

        async with session_factory() as session:
            subscription = XSubscription(
                url="https://x.com/merged-invalid-directory",
                label="Invalid directory",
            )
            selected = CreativeAssetDirectory(
                name="已选目录",
                asset_type="article",
                ai_ingestion_enabled=True,
                ai_ingestion_prompt="相关内容",
            )
            other = CreativeAssetDirectory(
                name="未选目录",
                asset_type="article",
                ai_ingestion_enabled=True,
                ai_ingestion_prompt="其他内容",
            )
            session.add_all([subscription, selected, other])
            await session.flush()
            session.add(XSubscriptionIngestionDirectory(
                subscription_id=subscription.id,
                directory_id=selected.id,
            ))
            await session.commit()
            return subscription.id, other.id

    subscription_id, directory_id = asyncio.new_event_loop().run_until_complete(seed())
    response = client.get(
        "/api/assets/ingestion/candidates",
        params={"subscription_id": subscription_id, "directory_ids": [directory_id]},
    )

    assert response.status_code == 422, response.text


def test_topic_rule_round_trips_ai_screening_prompt(api):
    client, session_factory = api

    async def seed_subscription():
        from models import XSubscription

        async with session_factory() as session:
            subscription = XSubscription(
                url="https://x.com/screening-prompt",
                label="Screening prompt",
            )
            session.add(subscription)
            await session.commit()
            return subscription.id

    subscription_id = asyncio.new_event_loop().run_until_complete(seed_subscription())
    created = client.post("/api/assets/topic-rules", json={
        "subscription_id": subscription_id,
        "directory": "AI 工具",
        "keywords": ["AI"],
        "screening_prompt": "  只接受有具体案例的内容。  ",
    })

    assert created.status_code == 201, created.text
    assert created.json()["screening_prompt"] == "只接受有具体案例的内容。"

    updated = client.patch(
        f"/api/assets/topic-rules/{created.json()['id']}",
        json={"screening_prompt": "只接受可执行的方法。"},
    )
    listed = client.get("/api/assets/topic-rules")

    assert updated.status_code == 200, updated.text
    assert updated.json()["screening_prompt"] == "只接受可执行的方法。"
    assert listed.json()[0]["screening_prompt"] == "只接受可执行的方法。"


def test_updating_topic_rule_keeps_only_selected_directory_enabled(api):
    client, session_factory = api

    async def seed_subscription():
        from models import XSubscription

        async with session_factory() as session:
            subscription = XSubscription(
                url="https://x.com/directory-switch",
                label="Directory switch",
            )
            session.add(subscription)
            await session.commit()
            return subscription.id

    subscription_id = asyncio.new_event_loop().run_until_complete(seed_subscription())
    old_rule = client.post("/api/assets/topic-rules", json={
        "subscription_id": subscription_id,
        "directory": "实用工具",
        "keywords": [],
    })
    selected_rule = client.post("/api/assets/topic-rules", json={
        "subscription_id": subscription_id,
        "directory": "搞钱副业",
        "keywords": ["副业"],
    })

    response = client.patch(
        f"/api/assets/topic-rules/{selected_rule.json()['id']}",
        json={"directory": "搞钱副业", "keywords": ["副业", "变现"]},
    )

    assert old_rule.status_code == 201, old_rule.text
    assert selected_rule.status_code == 201, selected_rule.text
    assert response.status_code == 200, response.text
    assert response.json()["directory"] == "搞钱副业"
    rules = client.get("/api/assets/topic-rules").json()
    enabled = [rule for rule in rules if rule["subscription_id"] == subscription_id and rule["enabled"]]
    assert enabled == [{
        **response.json(),
        "enabled": True,
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
