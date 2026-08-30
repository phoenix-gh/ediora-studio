from datetime import datetime, timezone

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


def creation_rule_payload(**overrides):
    payload = {
        "name": "增长短帖",
        "prompt": "从素材中提炼一个可发布的增长观点。",
        "asset_type": "article",
        "directory": "增长实验",
        "output_type": "x_short_post",
        "target_count": 3,
        "execution_mode": "recurring",
        "scheduled_time": "09:00",
        "timezone": "Asia/Shanghai",
        "lookback_days": 7,
        "delivery_mode": "drafts",
    }
    payload.update(overrides)
    return payload


def test_legacy_creation_rule_builds_self_contained_agent_prompt():
    from daily_creation_prompt import build_legacy_creation_prompt

    prompt = build_legacy_creation_prompt({
        "name": "每日搞钱帖",
        "asset_type": "article",
        "directories": ["搞钱副业"],
        "target_count": 12,
        "lookback_days": 14,
        "account_id": None,
        "instructions": "每句话单独成段",
    })

    assert "创作 12 条中文 X 短帖" in prompt
    assert "搞钱副业" in prompt
    assert "最近 14 天" in prompt
    assert "save_draft" in prompt
    assert "文章素材" in prompt
    assert "record_content_usage" in prompt
    assert "check_content_novelty" in prompt
    assert "主题和核心观点" in prompt
    assert "duplicate 或 uncertain" in prompt
    assert "novelty_override_token" in prompt
    assert 'draft_type="x"' in prompt
    assert "每句话单独成段" in prompt
    assert "save_daily_creation_outputs" not in prompt


def test_legacy_creation_prompt_preserves_media_account_and_manual_skill():
    from daily_creation_prompt import build_legacy_creation_prompt

    prompt = build_legacy_creation_prompt({
        "asset_type": "media",
        "directories": ["播客片段"],
        "target_count": 1,
        "lookback_days": 0,
        "account_id": "x-account-42",
        "skill_mode": "manual",
        "skill_name": "x-article-writing",
        "instructions": "",
    })

    assert "媒体素材" in prompt
    assert "x-account-42" in prompt
    assert "x-article-writing" in prompt
    assert "自行判断" in prompt
    assert "record_content_usage" in prompt


def test_manual_skill_requires_a_name_and_auto_clears_it():
    from pydantic import ValidationError
    from routers.creation_rules import CreationRuleIn

    with pytest.raises(ValidationError, match="skill_name is required"):
        CreationRuleIn(**creation_rule_payload(
            skill_mode="manual", skill_name=None,
        ))
    automatic = CreationRuleIn(**creation_rule_payload(
        skill_mode="auto", skill_name="stale-skill",
    ))
    assert automatic.skill_name is None


def test_creation_rule_rejects_removed_plan_item_delivery():
    from pydantic import ValidationError
    from routers.creation_rules import CreationRuleIn

    with pytest.raises(ValidationError):
        CreationRuleIn(**creation_rule_payload(delivery_mode="plan_items"))


def test_rule_schemas_accept_only_canonical_explicit_empty_directory():
    from pydantic import ValidationError
    from routers.creation_rules import CreationRuleIn, CreationRulePatch

    rule = CreationRuleIn(**creation_rule_payload(
        directory="",
        directories=[],
    ))
    patch = CreationRulePatch(directory="", directories=[])

    assert rule.directory == ""
    assert rule.directories == []
    assert patch.directory == ""
    assert patch.directories == []
    with pytest.raises(ValidationError, match="at least one directory is required"):
        CreationRuleIn(**creation_rule_payload(
            directory="   ",
            directories=[],
        ))


def test_snapshot_keeps_manual_skill_selection():
    from daily_creation_service import snapshot_creation_rule
    from models import DailyCreationRule

    rule = DailyCreationRule(
        **creation_rule_payload(),
        skill_mode="manual",
        skill_name="human-social-copy",
    )

    snapshot = snapshot_creation_rule(rule)

    assert snapshot["skill_mode"] == "manual"
    assert snapshot["skill_name"] == "human-social-copy"
    assert snapshot["prompt"] == creation_rule_payload()["prompt"]


@pytest.fixture
async def session_factory(postgres_database_url):
    test_engine = create_async_engine(postgres_database_url)
    test_sessions = async_sessionmaker(test_engine, expire_on_commit=False)
    from database import Base

    import models  # noqa: F401

    async with test_engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    yield test_sessions
    await test_engine.dispose()


async def test_rule_run_ledger_roundtrip_and_planner_origin_defaults(
    session_factory,
):
    from models import (
        ContentUsageLedger,
        DailyCreationRule,
        DailyCreationRun,
    )

    async with session_factory() as session:
        rule = DailyCreationRule(
            name="增长素材短帖",
            asset_type="article",
            directory="增长实验",
            output_type="x_short_post",
            target_count=3,
            execution_mode="recurring",
            scheduled_time="08:30",
            timezone="Asia/Shanghai",
            lookback_days=9,
            delivery_mode="drafts",
        )
        session.add(rule)
        await session.flush()

        scheduled_for = datetime(2026, 8, 4, 0, 30, tzinfo=timezone.utc)
        creation_run = DailyCreationRun(
            rule_id=rule.id,
            scheduled_for=scheduled_for,
            trigger_kind="scheduled",
            status="queued",
            requested_count=3,
            rule_snapshot={"directory": "增长实验", "target_count": 3},
        )
        session.add(creation_run)
        await session.flush()

        ledger = ContentUsageLedger(
            run_id=creation_run.id,
            rule_id=rule.id,
            creative_asset_id=42,
            output_type="x_short_post",
            output_kind="draft",
            output_id=101,
            draft_id=101,
            rule_name=rule.name,
            topic="用户增长",
            angle="从失败实验切入",
            excerpt="不要只看成功案例",
            reuse_decision="fresh",
        )
        session.add(ledger)

        await session.commit()

        assert rule.enabled is True
        assert rule.directories == []
        assert rule.deleted_at is None
        assert creation_run.created_count == 0
        assert creation_run.detail == {}
        assert ledger.reuse_explanation == ""

        rule.enabled = False
        rule.deleted_at = datetime.now(timezone.utc)
        await session.commit()

    async with session_factory() as verification:
        persisted_run = (
            await verification.execute(select(DailyCreationRun))
        ).scalars().one()
        persisted_ledger = (
            await verification.execute(select(ContentUsageLedger))
        ).scalars().one()
        assert persisted_run.rule_id == rule.id
        assert persisted_ledger.rule_id == rule.id


def test_directory_normalization_preserves_order_and_legacy_fallback():
    from daily_creation_service import normalize_creation_directories

    assert normalize_creation_directories([" A ", "B", "A"], "legacy") == [
        "A",
        "B",
    ]
    assert normalize_creation_directories(None, " legacy ") == ["legacy"]
    with pytest.raises(ValueError, match="at least one directory"):
        normalize_creation_directories([], "")


async def test_scheduled_run_identity_is_unique(session_factory):
    from models import DailyCreationRule, DailyCreationRun

    async with session_factory() as session:
        rule = DailyCreationRule(
            name="一次规则",
            asset_type="article",
            directory="实验目录",
            output_type="x_short_post",
            target_count=1,
            execution_mode="once",
            scheduled_date="2026-08-05",
            scheduled_time="09:00",
            timezone="Asia/Shanghai",
            lookback_days=1,
            delivery_mode="drafts",
        )
        session.add(rule)
        await session.flush()
        identity = {
            "rule_id": rule.id,
            "scheduled_for": datetime(2026, 8, 5, 1, tzinfo=timezone.utc),
            "trigger_kind": "scheduled",
            "requested_count": 1,
            "rule_snapshot": {"name": "一次规则"},
        }
        session.add(DailyCreationRun(**identity))
        await session.commit()
        session.add(DailyCreationRun(**identity))
        with pytest.raises(IntegrityError):
            await session.commit()


async def test_run_output_identity_is_unique(session_factory):
    from models import ContentUsageLedger, DailyCreationRule, DailyCreationRun

    async with session_factory() as session:
        rule = DailyCreationRule(
            name="台账规则",
            asset_type="article",
            directory="实验目录",
            output_type="x_short_post",
            target_count=1,
            execution_mode="recurring",
            scheduled_time="10:00",
            timezone="Asia/Shanghai",
            lookback_days=3,
            delivery_mode="drafts",
        )
        session.add(rule)
        await session.flush()
        creation_run = DailyCreationRun(
            rule_id=rule.id,
            scheduled_for=datetime(2026, 8, 5, 2, tzinfo=timezone.utc),
            trigger_kind="explicit",
            requested_count=1,
            rule_snapshot={"name": rule.name},
        )
        session.add(creation_run)
        await session.flush()
        identity = {
            "run_id": creation_run.id,
            "rule_id": rule.id,
            "creative_asset_id": 9,
            "output_type": "x_short_post",
            "output_kind": "draft",
            "output_id": 55,
            "draft_id": 55,
            "rule_name": rule.name,
            "topic": "主题",
            "angle": "角度",
            "excerpt": "正文",
            "reuse_decision": "fresh",
        }
        session.add(ContentUsageLedger(**identity))
        await session.commit()
        session.add(ContentUsageLedger(**identity))
        with pytest.raises(IntegrityError):
            await session.commit()
