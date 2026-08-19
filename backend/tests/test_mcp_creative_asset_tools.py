import asyncio
import sys

import pytest
from starlette.testclient import TestClient


@pytest.fixture
def env(monkeypatch, postgres_env):
    for module in list(sys.modules):
        if module.startswith(("database", "models", "config", "mcp_server")):
            sys.modules.pop(module, None)
    from database import Base, engine
    import models  # noqa: F401

    async def setup():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.new_event_loop().run_until_complete(setup())


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def seed_asset(**kwargs):
    from database import SessionLocal
    from models import CreativeAsset

    async def seed():
        async with SessionLocal() as db:
            asset = CreativeAsset(**kwargs)
            db.add(asset)
            await db.commit()
            await db.refresh(asset)
            return asset.id

    return run(seed())


def test_ai_can_search_and_read_creative_article_assets(env):
    target_id = seed_asset(
        asset_type="article",
        title="AI 自动化副业路径",
        content="用工作流帮助小商家处理客户咨询，并按月收费。",
        url="https://x.com/example/status/1",
        directory="搞钱副业",
        tags=["AI", "自动化"],
        source="x_topic",
    )
    seed_asset(
        asset_type="article",
        title="无关内容",
        content="一篇旅行随笔。",
        directory="旅行",
        source="manual",
    )

    import mcp_server

    results = run(mcp_server.search_creative_assets(query="自动化", directory="搞钱副业"))
    assert results == [{
        "id": target_id,
        "asset_type": "article",
        "media_kind": "",
        "title": "AI 自动化副业路径",
        "summary": "用工作流帮助小商家处理客户咨询，并按月收费。",
        "url": "https://x.com/example/status/1",
        "directory": "搞钱副业",
        "tags": ["AI", "自动化"],
        "source": "x_topic",
    }]
    assert run(mcp_server.get_creative_asset(target_id)) == {
        "id": target_id,
        "asset_type": "article",
        "media_kind": "",
        "title": "AI 自动化副业路径",
        "content": "用工作流帮助小商家处理客户咨询，并按月收费。",
        "url": "https://x.com/example/status/1",
        "media_type": "",
        "filename": "",
        "directory": "搞钱副业",
        "tags": ["AI", "自动化"],
        "source": "x_topic",
    }


def test_ai_can_search_space_separated_keywords_across_asset_metadata(env):
    target_id = seed_asset(
        asset_type="media",
        media_kind="image",
        title="女主一号",
        directory="女性街拍素材",
        tags=[],
        source="upload",
    )

    import mcp_server

    results = run(mcp_server.search_creative_assets(
        query="女主一号 街拍 人物",
        directory="女性街拍素材",
        asset_type="media",
    ))

    assert [item["id"] for item in results] == [target_id]


def test_mcp_accepts_the_docker_api_host_used_by_ai_chat(env):
    import mcp_server

    with TestClient(mcp_server.mcp.streamable_http_app()) as client:
        response = client.post("/mcp", headers={
            "Host": "api:8000",
            "Accept": "application/json, text/event-stream",
        }, json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "test", "version": "1"},
            },
        })

    assert response.status_code == 200
