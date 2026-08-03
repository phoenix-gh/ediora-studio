import asyncio
import sys
from datetime import datetime, timezone

import pytest


@pytest.fixture
def env(monkeypatch, tmp_path):
    monkeypatch.setenv(
        "WMS_DATABASE_URL",
        f"sqlite+aiosqlite:///{tmp_path / 'mcp-daily-creation.db'}",
    )
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
                    "delivery_mode": "drafts",
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
        asset_type="article", directory="产品实验", query="验证", limit=10,
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


def test_record_usage_rejects_a_missing_persisted_output(env):
    asset_id, _, run_id = seed_context()
    import mcp_server

    with pytest.raises(ValueError, match="not found"):
        run(mcp_server.record_content_usage(
            run_id=run_id, asset_id=asset_id,
            output_kind="draft", output_id=999,
            topic="验证", angle="新角度", excerpt="不会写入",
            reuse_decision="fresh",
        ))


def test_mcp_combines_multiple_directories_and_keeps_legacy_argument(env):
    first_id, second_id, _ = seed_context()
    import mcp_server

    combined = run(mcp_server.list_creative_asset_candidates(
        asset_type="article",
        directories=["产品实验", "增长资料"],
        limit=10,
    ))
    legacy = run(mcp_server.list_creative_asset_candidates(
        asset_type="article", directory="产品实验", limit=10,
    ))

    assert {item["id"] for item in combined} == {first_id, second_id}
    assert [item["id"] for item in legacy] == [first_id]
