import asyncio
import sys
from datetime import datetime, timedelta, timezone

import pytest


@pytest.fixture
def env(monkeypatch, postgres_env):
    for module_name in list(sys.modules):
        if module_name.startswith(("database", "models", "config", "mcp_server", "source_tools")):
            sys.modules.pop(module_name, None)
    from database import Base, engine
    import models  # noqa: F401

    async def setup():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.run(setup())
    yield
    asyncio.run(engine.dispose())


def run(coroutine):
    return asyncio.run(coroutine)


def seed_sources():
    from database import SessionLocal
    from models import WechatAccount, WechatArticle, XPost, XSubscription

    async def seed():
        async with SessionLocal() as db:
            now = datetime.now(timezone.utc)
            x_subscription = XSubscription(
                url="https://x.com/ai-watch",
                label="AI 观察",
                enabled=True,
            )
            db.add(x_subscription)
            await db.flush()
            db.add(XPost(
                tweet_id="tweet-source-1",
                subscription_id=x_subscription.id,
                username="ai_watch",
                display_name="AI Watch",
                content="自动化工作流正在改变小团队的研发方式。",
                url="https://x.com/ai_watch/status/1",
                published_at=now - timedelta(hours=2),
                collected_at=now - timedelta(hours=1),
            ))

            account = WechatAccount(
                biz="biz-source-1",
                name="机器之心",
                description="人工智能产业信息源",
                group="AI",
            )
            db.add(account)
            db.add(WechatArticle(
                id="wechat-article-1",
                biz=account.biz,
                account_name=account.name,
                title="AI Agent 的新工作流",
                url="https://mp.weixin.qq.com/s/article-1",
                digest="介绍 Agent 如何读取内部信息源。",
                content="这是公众号文章正文。",
                published_at=now - timedelta(days=1),
                collected_at=now - timedelta(hours=3),
            ))
            await db.commit()
            return x_subscription.id

    return run(seed())


def test_agent_can_list_subscriptions_and_search_x_and_wechat_items(env):
    x_subscription_id = seed_sources()
    import mcp_server

    subscriptions = run(mcp_server.list_source_subscriptions())
    assert {item["source_type"] for item in subscriptions} == {"x", "wechat"}
    x_subscription = next(item for item in subscriptions if item["source_type"] == "x")
    assert x_subscription == {
        "source_type": "x",
        "id": x_subscription_id,
        "label": "AI 观察",
        "key": "https://x.com/ai-watch",
        "url": "https://x.com/ai-watch",
        "group": "",
        "enabled": True,
        "muted": False,
        "last_collected_at": "",
        "item_count": 1,
    }

    x_items = run(mcp_server.search_source_items(
        source_type="x", query="自动化", subscription_id=str(x_subscription_id), limit=10,
    ))
    assert x_items == [{
        "source_type": "x",
        "id": "tweet-source-1",
        "subscription_id": x_subscription_id,
        "subscription_label": "AI 观察",
        "title": "",
        "content": "自动化工作流正在改变小团队的研发方式。",
        "excerpt": "自动化工作流正在改变小团队的研发方式。",
        "url": "https://x.com/ai_watch/status/1",
        "author": "@ai_watch",
        "published_at": x_items[0]["published_at"],
        "collected_at": x_items[0]["collected_at"],
        "metadata": {
            "display_name": "AI Watch",
            "replies": 0,
            "reposts": 0,
            "likes": 0,
            "views": 0,
        },
    }]

    wechat_items = run(mcp_server.search_source_items(
        source_type="wechat", query="Agent", limit=10,
    ))
    assert len(wechat_items) == 1
    assert wechat_items[0]["title"] == "AI Agent 的新工作流"
    assert wechat_items[0]["subscription_label"] == "机器之心"


def test_agent_can_read_a_full_source_item_without_writing(env):
    seed_sources()
    import mcp_server

    article = run(mcp_server.get_source_item("wechat", "wechat-article-1"))
    assert article["source_type"] == "wechat"
    assert article["content"] == "这是公众号文章正文。"
    assert article["metadata"] == {
        "biz": "biz-source-1",
        "digest": "介绍 Agent 如何读取内部信息源。",
        "cover_url": "",
    }

    with pytest.raises(ValueError, match="Unsupported source_type"):
        run(mcp_server.search_source_items(source_type="unknown"))
    with pytest.raises(ValueError, match="source_type is required"):
        run(mcp_server.search_source_items(subscription_id="1"))


def test_mcp_registers_only_read_only_source_queries(env):
    import mcp_server

    tools = {tool.name for tool in run(mcp_server.mcp.list_tools())}
    assert {
        "list_source_subscriptions",
        "search_source_items",
        "get_source_item",
    }.issubset(tools)


def test_source_tool_schemas_constrain_types_and_search_window(env):
    import mcp_server

    tools = {tool.name: tool for tool in run(mcp_server.mcp.list_tools())}
    supported = ["x", "wechat", "reddit", "youtube", "v2ex"]

    get_source_type = tools["get_source_item"].inputSchema["properties"]["source_type"]
    assert get_source_type["enum"] == supported

    search_properties = tools["search_source_items"].inputSchema["properties"]
    assert search_properties["source_type"]["enum"] == ["", *supported]
    assert search_properties["days"]["minimum"] == 1
    assert search_properties["days"]["maximum"] == 365

    list_source_type = tools["list_source_subscriptions"].inputSchema["properties"]["source_type"]
    assert list_source_type["enum"] == ["", *supported]


def test_cross_source_search_uses_the_same_normalized_contract(env):
    seed_sources()
    import mcp_server

    items = run(mcp_server.search_source_items(query="Agent", days=365, limit=10))
    assert [(item["source_type"], item["title"]) for item in items] == [
        ("wechat", "AI Agent 的新工作流"),
    ]
