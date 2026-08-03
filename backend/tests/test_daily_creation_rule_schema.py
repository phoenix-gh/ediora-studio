from datetime import datetime, timezone

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker


@pytest.fixture
def session_factory(tmp_path):
    database_path = tmp_path / "daily-creation-schema.db"
    test_engine = create_engine(f"sqlite:///{database_path}")
    test_sessions = sessionmaker(test_engine, expire_on_commit=False)
    from database import Base

    import models  # noqa: F401

    Base.metadata.create_all(test_engine)
    yield test_sessions
    test_engine.dispose()


def test_rule_run_ledger_roundtrip_and_planner_origin_defaults(session_factory):
    from models import (
        ContentUsageLedger,
        DailyCreationRule,
        DailyCreationRun,
        DailyPlan,
        DailyPlanItem,
    )

    def run():
        with session_factory() as session:
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
            session.flush()

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
            session.flush()

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

            plan = DailyPlan(plan_date="2026-08-04")
            session.add(plan)
            session.flush()
            item = DailyPlanItem(
                plan_id=plan.id,
                account_id="x-main",
                title="普通计划项",
            )
            session.add(item)
            session.commit()

            assert rule.enabled is True
            assert rule.directories == []
            assert rule.deleted_at is None
            assert creation_run.created_count == 0
            assert creation_run.detail == {}
            assert ledger.reuse_explanation == ""
            assert item.origin == "planner"
            assert item.creation_run_id is None

            rule.enabled = False
            rule.deleted_at = datetime.now(timezone.utc)
            session.commit()

        with session_factory() as verification:
            persisted_run = verification.execute(
                select(DailyCreationRun)
            ).scalars().one()
            persisted_ledger = verification.execute(
                select(ContentUsageLedger)
            ).scalars().one()
            assert persisted_run.rule_id == rule.id
            assert persisted_ledger.rule_id == rule.id

    run()


def test_directory_normalization_preserves_order_and_legacy_fallback():
    from daily_creation_service import normalize_creation_directories

    assert normalize_creation_directories([" A ", "B", "A"], "legacy") == [
        "A",
        "B",
    ]
    assert normalize_creation_directories(None, " legacy ") == ["legacy"]
    with pytest.raises(ValueError, match="at least one directory"):
        normalize_creation_directories([], "")


def test_scheduled_run_identity_is_unique(session_factory):
    from models import DailyCreationRule, DailyCreationRun

    def run():
        with session_factory() as session:
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
                delivery_mode="plan_items",
            )
            session.add(rule)
            session.flush()
            identity = {
                "rule_id": rule.id,
                "scheduled_for": datetime(2026, 8, 5, 1, tzinfo=timezone.utc),
                "trigger_kind": "scheduled",
                "requested_count": 1,
                "rule_snapshot": {"name": "一次规则"},
            }
            session.add(DailyCreationRun(**identity))
            session.commit()
            session.add(DailyCreationRun(**identity))
            with pytest.raises(IntegrityError):
                session.commit()

    run()


def test_run_output_identity_is_unique(session_factory):
    from models import ContentUsageLedger, DailyCreationRule, DailyCreationRun

    def run():
        with session_factory() as session:
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
            session.flush()
            creation_run = DailyCreationRun(
                rule_id=rule.id,
                scheduled_for=datetime(2026, 8, 5, 2, tzinfo=timezone.utc),
                trigger_kind="explicit",
                requested_count=1,
                rule_snapshot={"name": rule.name},
            )
            session.add(creation_run)
            session.flush()
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
            session.commit()
            session.add(ContentUsageLedger(**identity))
            with pytest.raises(IntegrityError):
                session.commit()

    run()
