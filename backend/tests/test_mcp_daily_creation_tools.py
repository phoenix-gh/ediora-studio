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
        ContentUsageLedger,
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
            await session.flush()
            session.add(ContentUsageLedger(
                run_id=creation_run.id, rule_id=rule.id,
                creative_asset_id=asset.id, output_type="x_short_post",
                output_kind="draft", output_id=88, draft_id=88,
                rule_name=rule.name, topic="验证", angle="先卖再做",
                excerpt="旧内容", reuse_decision="fresh",
            ))
            await session.commit()
            return asset.id, second_asset.id, creation_run.id

    return run(seed())


def test_mcp_exposes_compact_candidates_and_global_history(env):
    asset_id, _, _ = seed_context()
    import mcp_server

    candidates = run(mcp_server.list_creative_asset_candidates(
        asset_type="article", directories=["产品实验"], query="验证", limit=10,
    ))
    history = run(mcp_server.get_recent_content_usage(
        lookback_days=5, output_type="x_short_post",
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
    assert history[0]["asset_id"] == asset_id
    assert history[0]["angle"] == "先卖再做"


def test_candidate_tool_requires_directories(env):
    import mcp_server

    tools = {tool.name: tool for tool in run(mcp_server.mcp.list_tools())}
    schema = tools["list_creative_asset_candidates"].inputSchema

    assert "directories" in schema["required"]


def test_daily_batch_save_tool_is_not_registered(env):
    import mcp_server

    names = {tool.name for tool in run(mcp_server.mcp.list_tools())}

    assert "save_daily_creation_outputs" not in names
    assert "save_draft" in names
    assert "attach_creative_asset_to_draft" in names
    assert "record_content_usage" in names
    usage_schema = mcp_server.mcp._tool_manager._tools[
        "record_content_usage"
    ].parameters
    assert "run_id" not in usage_schema["properties"]
    assert "ctx" not in usage_schema["properties"]


def test_real_save_draft_contract_accepts_x_drafts(env):
    import mcp_server

    schema = mcp_server.mcp._tool_manager._tools["save_draft"].parameters

    assert schema["properties"]["draft_type"]["enum"] == [
        "article", "script", "x", "x_article", "mp",
    ]


def test_content_novelty_tool_is_strict_read_only_and_returns_global_result(env):
    import mcp_server
    from tool_contracts import EDIORA_TOOL_META_KEY

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


def test_record_usage_schema_lists_only_agent_accepted_values(env):
    import mcp_server

    schema = mcp_server.mcp._tool_manager._tools["record_content_usage"].parameters

    assert schema["properties"]["output_kind"]["const"] == "draft"
    assert schema["properties"]["reuse_decision"]["enum"] == [
        "fresh", "reuse_allowed",
    ]


def test_record_usage_rejects_a_missing_persisted_output(env):
    asset_id, _, run_id = seed_context()
    import mcp_server

    with pytest.raises(ValueError, match="not found"):
        run(mcp_server.record_content_usage(
            ctx=run_context(run_id), asset_id=asset_id,
            output_kind="draft", output_id=999,
            topic="验证", angle="新角度", excerpt="不会写入",
            reuse_decision="fresh",
        ))


def test_record_usage_requires_transport_run_identity(env):
    asset_id, _, _ = seed_context()
    import mcp_server

    with pytest.raises(ValueError, match="run identity"):
        run(mcp_server.record_content_usage(
            ctx=run_context(), asset_id=asset_id,
            output_kind="draft", output_id=999,
            topic="验证", angle="新角度", excerpt="不会写入",
            reuse_decision="fresh",
        ))


def test_record_usage_is_idempotent_and_not_limited_by_legacy_rule_scope(
    env, monkeypatch,
):
    _, outside_legacy_directory_id, run_id = seed_context()
    import mcp_server
    from database import SessionLocal
    from models import ContentUsageLedger
    from sqlalchemy import select

    async def extract(prompt, max_tokens):
        return (
            '{"topic":"增长复盘","core_claim":"跨目录证据",'
            '"key_facts":[],"event_time":null,"source_item_ids":[]}'
        )

    monkeypatch.setattr("llm._call", extract)

    saved = run(mcp_server.save_draft(
        ctx=run_context(run_id),
        title="增长复盘", content="从另一目录补充增长经验。", draft_type="x",
    ))
    input_data = {
        "ctx": run_context(run_id),
        "asset_id": outside_legacy_directory_id,
        "output_kind": "draft",
        "output_id": saved["id"],
        "topic": "增长复盘",
        "angle": "跨目录证据",
        "excerpt": "从另一目录补充增长经验。",
        "reuse_decision": "fresh",
    }

    first = run(mcp_server.record_content_usage(**input_data))
    second = run(mcp_server.record_content_usage(**input_data))

    async def read_usage():
        async with SessionLocal() as session:
            rows = (await session.execute(
                select(ContentUsageLedger).where(
                    ContentUsageLedger.run_id == run_id,
                    ContentUsageLedger.output_id == saved["id"],
                )
            )).scalars().all()
            return rows

    rows = run(read_usage())
    assert first["id"] == second["id"]
    assert len(rows) == 1
    assert rows[0].creative_asset_id == outside_legacy_directory_id
    assert rows[0].output_type == "x_short_post"
    assert rows[0].topic == "增长复盘"


def test_mcp_combines_multiple_directories(env):
    first_id, second_id, _ = seed_context()
    import mcp_server

    combined = run(mcp_server.list_creative_asset_candidates(
        asset_type="article",
        directories=["产品实验", "增长资料"],
        limit=10,
    ))

    assert {item["id"] for item in combined} == {first_id, second_id}
