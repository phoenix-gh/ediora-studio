import asyncio
import sys
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest


@pytest.fixture
def env(monkeypatch, postgres_env):
    for module_name in list(sys.modules):
        if module_name.startswith(("database", "models", "config", "mcp_server")):
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


def run_context(run_id=None, session_id=None):
    headers = {}
    if run_id is not None:
        headers["x-agent-mode"] = "scheduled"
        headers["x-daily-creation-run-id"] = str(run_id)
    if session_id is not None:
        headers["x-agent-mode"] = "chat"
        headers["x-agent-session-id"] = str(session_id)
    return SimpleNamespace(
        request_context=SimpleNamespace(
            request=SimpleNamespace(headers=headers),
        ),
    )


def seed_context():
    from database import SessionLocal
    from models import (
        CreativeAsset,
        DailyCreationRule,
        DailyCreationRun,
    )

    async def seed():
        async with SessionLocal() as session:
            asset = CreativeAsset(
                asset_type="article", directory="产品实验",
                title="低成本验证", content="先验证需求，再写完整产品。",
                tags=["产品"], url="https://example.com/validate",
            )
            second_asset = CreativeAsset(
                asset_type="article", directory="增长资料",
                title="增长复盘", content="从另一目录补充增长经验。",
                tags=["增长"], url="https://example.com/growth",
            )
            rule = DailyCreationRule(
                name="产品短帖", asset_type="article", directory="产品实验",
                output_type="x_short_post", target_count=2,
                execution_mode="recurring", scheduled_time="09:00",
                timezone="Asia/Shanghai", lookback_days=5,
                delivery_mode="drafts",
            )
            session.add_all([asset, second_asset, rule])
            await session.flush()
            creation_run = DailyCreationRun(
                rule_id=rule.id,
                scheduled_for=datetime.now(timezone.utc),
                trigger_kind="explicit", requested_count=2,
                rule_snapshot={
                    "name": rule.name, "asset_type": "article",
                    "directory": "产品实验", "output_type": "x_short_post",
                    "delivery_mode": "drafts", "lookback_days": 5,
                },
            )
            session.add(creation_run)
            await session.commit()
            return asset.id, second_asset.id, creation_run.id

    return run(seed())


def test_mcp_exposes_compact_candidates(env):
    asset_id, _, _ = seed_context()
    import mcp_server

    candidates = run(mcp_server.list_creative_asset_candidates(
        asset_type="article", directories=["产品实验"], query="验证", limit=10,
    ))

    assert candidates == [{
        "id": asset_id,
        "title": "低成本验证",
        "summary": "先验证需求，再写完整产品。",
        "tags": ["产品"],
        "source_url": "https://example.com/validate",
        "created_at": candidates[0]["created_at"],
        "content_length": 13,
    }]


def test_candidate_tool_requires_directories(env):
    import mcp_server

    tools = {tool.name: tool for tool in run(mcp_server.mcp.list_tools())}
    schema = tools["list_creative_asset_candidates"].inputSchema

    assert "directories" in schema["required"]
    assert "ctx" not in schema["properties"]
    search_schema = tools["search_creative_assets"].inputSchema
    assert "ctx" not in search_schema["properties"]
    window = search_schema["properties"]["exclude_adopted_within_days"]
    assert window["minimum"] == 0
    assert window["maximum"] == 90


def test_daily_batch_save_tool_is_not_registered(env):
    import mcp_server

    names = {tool.name for tool in run(mcp_server.mcp.list_tools())}

    assert "save_daily_creation_outputs" not in names
    assert "save_draft" in names
    assert "attach_creative_asset_to_draft" in names
    assert "record_content_usage" not in names
    assert "get_recent_content_usage" not in names
    save_schema = mcp_server.mcp._tool_manager._tools["save_draft"].parameters
    assert "asset_ids" in save_schema["properties"]
    assert "ctx" not in save_schema["properties"]


def test_real_save_draft_contract_accepts_x_drafts(env):
    import mcp_server

    schema = mcp_server.mcp._tool_manager._tools["save_draft"].parameters

    assert schema["properties"]["draft_type"]["enum"] == [
        "article", "script", "x", "x_article", "mp",
    ]


def test_content_novelty_tool_is_strict_read_only_and_returns_global_result(
    env, monkeypatch,
):
    import mcp_server
    from tool_contracts import EDIORA_TOOL_META_KEY

    monkeypatch.setenv("AGENT_TOPIC_NOVELTY_ENABLED", "1")

    tools = {tool.name: tool for tool in run(mcp_server.mcp.list_tools())}
    schema = tools["check_content_novelty"].inputSchema
    metadata = mcp_server.mcp._tool_manager._tools[
        "check_content_novelty"
    ].meta[EDIORA_TOOL_META_KEY]

    assert schema["properties"]["window_days"]["minimum"] == 1
    assert schema["properties"]["window_days"]["maximum"] == 90
    assert schema["properties"]["key_facts"]["anyOf"][0]["maxItems"] == 20
    assert schema["properties"]["source_item_ids"]["anyOf"][0]["maxItems"] == 100
    assert tools["check_content_novelty"].annotations.readOnlyHint is True
    assert metadata["approval"] == "never"
    result = run(mcp_server.check_content_novelty(
        topic="Agent 工具选择",
        core_claim="严格契约减少错误参数",
        window_days=14,
    ))
    assert result["decision"] == "novel"
    assert result["suggested_action"] == "continue"


def test_content_novelty_tool_returns_disabled_without_feature_flag(
    env, monkeypatch,
):
    import mcp_server

    monkeypatch.setenv("AGENT_TOPIC_NOVELTY_ENABLED", "0")

    result = run(mcp_server.check_content_novelty(
        topic="暂时跳过",
        core_claim="关闭时不应调用新颖性模型",
        window_days=14,
    ))

    assert result == {
        "decision": "disabled",
        "conflicts": (),
        "reason": "Agent topic novelty checking is disabled",
        "novelty_basis": "",
        "suggested_action": "continue",
    }


def test_agent_save_draft_creates_topic_claim_without_changing_rest_drafts(
    env, monkeypatch,
):
    import llm
    import mcp_server
    from database import SessionLocal
    from models import AgentTopicClaim
    from sqlalchemy import select

    async def extract(prompt, max_tokens):
        return (
            '{"topic":"Agent 工具选择","core_claim":"严格契约减少错误参数",'
            '"key_facts":[],"event_time":null,"source_item_ids":[]}'
        )

    monkeypatch.setattr(llm, "_call", extract)
    result = run(mcp_server.save_draft(
        ctx=run_context(session_id=92),
        title="工具契约",
        content="严格契约减少错误参数。",
    ))

    async def read_claim():
        async with SessionLocal() as session:
            return await session.scalar(select(AgentTopicClaim).where(
                AgentTopicClaim.draft_id == result["id"]
            ))

    claim = run(read_claim())
    assert result["saved"] is True
    assert claim is not None
    assert claim.agent_mode == "chat"
    assert claim.agent_session_id == 92
    assert claim.window_days == 14


def test_save_draft_stamps_adopted_assets_and_rolls_back_a_missing_id(
    env, monkeypatch,
):
    asset_id, outside_id, run_id = seed_context()
    import mcp_server
    from database import SessionLocal
    from models import ArticleDraft, CreativeAsset
    from sqlalchemy import func, select

    monkeypatch.setenv("AGENT_TOPIC_NOVELTY_ENABLED", "0")

    saved = run(mcp_server.save_draft(
        ctx=run_context(run_id),
        title="增长复盘",
        content="从另一目录补充增长经验。",
        draft_type="x",
        asset_ids=[asset_id, outside_id, asset_id],
    ))

    async def adopted_at(target_id):
        async with SessionLocal() as session:
            asset = await session.get(CreativeAsset, target_id)
            return asset.last_adopted_at

    assert saved["saved"] is True
    assert run(adopted_at(asset_id)) is not None
    assert run(adopted_at(outside_id)) is not None

    with pytest.raises(ValueError, match="not found"):
        run(mcp_server.save_draft(
            ctx=run_context(run_id),
            title="缺失素材",
            content="这个草稿不应该留下。",
            draft_type="x",
            asset_ids=[999999],
        ))

    async def draft_count():
        async with SessionLocal() as session:
            return await session.scalar(select(func.count(ArticleDraft.id)))

    assert run(draft_count()) == 1


def test_scheduled_fetch_excludes_recently_adopted_assets(env):
    asset_id, second_id, run_id = seed_context()
    import mcp_server
    from database import SessionLocal
    from models import CreativeAsset
    from datetime import datetime, timezone

    async def adopt():
        async with SessionLocal() as session:
            asset = await session.get(CreativeAsset, asset_id)
            asset.last_adopted_at = datetime.now(timezone.utc)
            await session.commit()

    run(adopt())
    ctx = run_context(run_id)

    listed = run(mcp_server.list_creative_asset_candidates(
        asset_type="article", directories=["产品实验"], ctx=ctx,
    ))
    searched = run(mcp_server.search_creative_assets(
        query="验证", directory="产品实验", ctx=ctx,
    ))
    unfiltered = run(mcp_server.list_creative_asset_candidates(
        asset_type="article", directories=["产品实验", "增长资料"],
    ))

    assert asset_id not in {item["id"] for item in listed}
    assert asset_id not in {item["id"] for item in searched}
    assert {item["id"] for item in unfiltered} == {asset_id, second_id}
    assert run(mcp_server.get_creative_asset(asset_id))["id"] == asset_id


def test_mcp_combines_multiple_directories(env):
    first_id, second_id, _ = seed_context()
    import mcp_server

    combined = run(mcp_server.list_creative_asset_candidates(
        asset_type="article",
        directories=["产品实验", "增长资料"],
        limit=10,
    ))

    assert {item["id"] for item in combined} == {first_id, second_id}
