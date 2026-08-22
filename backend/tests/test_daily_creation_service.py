from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


@pytest.fixture
async def db(postgres_database_url):
    from database import Base
    import models  # noqa: F401

    engine = create_async_engine(postgres_database_url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    async with sessions() as session:
        yield session
    await engine.dispose()


@pytest.mark.asyncio
async def test_candidates_are_directory_scoped_compact_and_bounded(db):
    from daily_creation_service import list_creative_asset_candidates
    from models import CreativeAsset

    now = datetime.now(timezone.utc)
    db.add_all([
        CreativeAsset(
            asset_type="article",
            directory="增长实验",
            title="自动化获客",
            content="自动化获客正文 " * 100,
            url="https://example.com/growth",
            tags=["AI", "获客"],
            created_at=now,
        ),
        CreativeAsset(
            asset_type="article",
            directory="旅行笔记",
            title="自动化行程",
            content="不应返回",
            tags=["AI"],
            created_at=now,
        ),
        CreativeAsset(
            asset_type="article",
            directory="增长复盘",
            title="AI 自动化复盘",
            content="第二个目录中的增长素材",
            tags=["AI"],
            created_at=now + timedelta(seconds=1),
        ),
    ])
    await db.commit()

    result = await list_creative_asset_candidates(
        db,
        asset_type="article",
        directory=" 增长实验 ",
        query="自动化 AI",
        limit=1,
    )

    assert len(result) == 1
    assert result[0]["title"] == "自动化获客"
    assert result[0]["source_url"] == "https://example.com/growth"
    assert result[0]["content_length"] > len(result[0]["summary"])
    assert "content" not in result[0]
    with pytest.raises(ValueError, match="limit"):
        await list_creative_asset_candidates(
            db,
            asset_type="article",
            directory="增长实验",
            limit=51,
        )

    merged = await list_creative_asset_candidates(
        db,
        asset_type="article",
        directories=["增长实验", "增长复盘", "增长实验"],
        limit=2,
    )
    assert [item["title"] for item in merged] == [
        "AI 自动化复盘",
        "自动化获客",
    ]


@pytest.mark.asyncio
async def test_candidate_search_accepts_space_separated_keywords_in_directory(db):
    from daily_creation_service import list_creative_asset_candidates
    from models import CreativeAsset

    asset = CreativeAsset(
        asset_type="media",
        directory="女性街拍素材",
        title="女主一号",
        content="",
        tags=[],
        url="/api/uploads/person.png",
    )
    db.add(asset)
    await db.commit()

    result = await list_creative_asset_candidates(
        db,
        asset_type="media",
        directories=["女性街拍素材"],
        query="女主一号 街拍 人物",
        limit=10,
    )

    assert [item["id"] for item in result] == [asset.id]


@pytest.mark.asyncio
async def test_recent_usage_is_global_by_default_with_optional_filters(db):
    from daily_creation_service import get_recent_content_usage
    from models import ContentUsageLedger

    now = datetime.now(timezone.utc)
    db.add_all([
        ContentUsageLedger(
            run_id=1, rule_id=11, creative_asset_id=1,
            output_type="x_short_post", output_kind="draft", output_id=1,
            draft_id=1, account_id="x-a", rule_name="规则甲", topic="增长",
            angle="成本", excerpt="近期内容", reuse_decision="fresh",
            created_at=now - timedelta(hours=23),
        ),
        ContentUsageLedger(
            run_id=2, rule_id=22, creative_asset_id=2,
            output_type="x_short_post", output_kind="draft", output_id=2,
            draft_id=2, account_id="x-b", rule_name="规则乙", topic="增长",
            angle="效率", excerpt="另一规则", reuse_decision="fresh",
            created_at=now - timedelta(hours=12),
        ),
        ContentUsageLedger(
            run_id=3, rule_id=11, creative_asset_id=3,
            output_type="x_short_post", output_kind="draft", output_id=3,
            draft_id=3, account_id="x-a", rule_name="规则甲", topic="过期",
            angle="旧角度", excerpt="旧内容", reuse_decision="fresh",
            created_at=now - timedelta(days=2),
        ),
    ])
    await db.commit()

    global_rows = await get_recent_content_usage(
        db, lookback_days=1, output_type="x_short_post", now=now,
    )
    assert [row["rule_name"] for row in global_rows] == ["规则乙", "规则甲"]
    filtered = await get_recent_content_usage(
        db, lookback_days=1, output_type="x_short_post",
        rule_id=11, account_id="x-a", now=now,
    )
    assert [row["rule_name"] for row in filtered] == ["规则甲"]
    with pytest.raises(ValueError, match="lookback_days"):
        await get_recent_content_usage(
            db, lookback_days=0, output_type="x_short_post", now=now,
        )


def test_current_daily_creation_service_has_no_batch_writer():
    import daily_creation_service

    assert not hasattr(
        daily_creation_service,
        "persist_daily_creation_output_batch",
    )


async def _seed_run(db, *, delivery_mode="drafts"):
    from models import CreativeAsset, DailyCreationRule, DailyCreationRun

    asset = CreativeAsset(
        asset_type="article", directory="增长实验", title="素材",
        content="完整素材正文", tags=["增长"],
    )
    other = CreativeAsset(
        asset_type="article", directory="其他目录", title="越界素材",
        content="不允许使用",
    )
    rule = DailyCreationRule(
        name="增长短帖", asset_type="article", directory="增长实验",
        output_type="x_short_post", target_count=2,
        execution_mode="recurring", scheduled_time="08:00",
        timezone="Asia/Shanghai", lookback_days=7,
        delivery_mode=delivery_mode,
    )
    db.add_all([asset, other, rule])
    await db.flush()
    creation_run = DailyCreationRun(
        rule_id=rule.id,
        scheduled_for=datetime(2026, 8, 3, 0, tzinfo=timezone.utc),
        trigger_kind="explicit", requested_count=2,
        rule_snapshot={
            "name": rule.name,
            "asset_type": rule.asset_type,
            "directory": rule.directory,
            "output_type": rule.output_type,
            "delivery_mode": delivery_mode,
        },
    )
    db.add(creation_run)
    await db.commit()
    return creation_run, asset, other


@pytest.mark.asyncio
async def test_x_draft_and_usage_are_persisted_atomically(db):
    from daily_creation_service import persist_x_draft_with_usage
    from models import ArticleDraft, ContentUsageLedger

    creation_run, asset, _ = await _seed_run(db)
    draft, usage = await persist_x_draft_with_usage(
        db, run_id=creation_run.id, asset_id=asset.id,
        title="自动化不是省人", text="真正省下的是等待时间。",
        topic="自动化", angle="等待成本", reuse_decision="fresh",
        reuse_explanation="", account_id="x-a",
    )

    assert draft.draft_type == "x"
    assert draft.content == "真正省下的是等待时间。"
    assert usage.draft_id == draft.id
    assert usage.output_id == draft.id
    assert await db.scalar(select(func.count(ArticleDraft.id))) == 1
    assert await db.scalar(select(func.count(ContentUsageLedger.id))) == 1


@pytest.mark.asyncio
async def test_persistence_rejects_out_of_scope_asset_without_partial_draft(db):
    from daily_creation_service import persist_x_draft_with_usage
    from models import ArticleDraft, ContentUsageLedger

    creation_run, _, other = await _seed_run(db)
    with pytest.raises(ValueError, match="configured directory"):
        await persist_x_draft_with_usage(
            db, run_id=creation_run.id, asset_id=other.id,
            title="越界", text="不应保存", topic="越界", angle="越界",
            reuse_decision="fresh", reuse_explanation="",
        )
    assert await db.scalar(select(func.count(ArticleDraft.id))) == 0
    assert await db.scalar(select(func.count(ContentUsageLedger.id))) == 0


@pytest.mark.asyncio
async def test_persistence_accepts_an_asset_from_any_snapshot_directory(db):
    from daily_creation_service import persist_x_draft_with_usage

    creation_run, _, second_directory_asset = await _seed_run(db)
    creation_run.rule_snapshot = {
        **creation_run.rule_snapshot,
        "directories": ["增长实验", "其他目录"],
    }
    await db.commit()

    draft, usage = await persist_x_draft_with_usage(
        db, run_id=creation_run.id, asset_id=second_directory_asset.id,
        title="第二目录", text="允许保存。", topic="范围", angle="多目录",
        reuse_decision="fresh", reuse_explanation="",
    )
    assert draft.id == usage.draft_id


@pytest.mark.asyncio
async def test_duplicate_usage_rolls_back_the_second_draft(db):
    from daily_creation_service import persist_x_draft_with_usage
    from models import ArticleDraft, ContentUsageLedger

    creation_run, asset, _ = await _seed_run(db)
    db.add(ContentUsageLedger(run_id=creation_run.id, rule_id=creation_run.rule_id, creative_asset_id=asset.id, output_type="x_short_post", output_kind="draft", output_id=1, draft_id=999, rule_name="增长短帖", topic="占位", angle="占位", excerpt="占位", reuse_decision="fresh"))
    await db.commit()
    with pytest.raises(IntegrityError):
        await persist_x_draft_with_usage(db, run_id=creation_run.id, asset_id=asset.id, title="待回滚", text="不应留下", topic="增长", angle="效率", reuse_decision="fresh", reuse_explanation="")
    assert await db.scalar(select(func.count(ArticleDraft.id))) == 0


@pytest.mark.asyncio
async def test_new_daily_creation_jobs_use_the_agent_runtime_without_a_version(db):
    from daily_creation_service import create_daily_creation_run
    from models import ContentJob, DailyCreationRule

    rule = DailyCreationRule(name="Agent 新任务", asset_type="article", directory="增长实验", output_type="x_short_post", target_count=3, execution_mode="recurring", scheduled_time="08:00", timezone="Asia/Shanghai", lookback_days=7, delivery_mode="drafts", enabled=True)
    db.add(rule)
    await db.flush()
    creation_run, created = await create_daily_creation_run(db, rule=rule, scheduled_for=datetime(2026, 8, 5, 0, tzinfo=timezone.utc), trigger_kind="schedule")
    job = await db.get(ContentJob, creation_run.content_job_id)
    assert created is True
    assert job.input_data == {"run_id": creation_run.id}


@pytest.mark.asyncio
async def test_explicit_run_can_start_when_rule_is_paused(db):
    from daily_creation_service import create_daily_creation_run
    from models import ContentJob, DailyCreationRule

    rule = DailyCreationRule(
        name="暂停后手动执行",
        asset_type="article",
        directory="增长实验",
        output_type="x_short_post",
        target_count=1,
        execution_mode="recurring",
        scheduled_time="08:00",
        timezone="Asia/Shanghai",
        lookback_days=7,
        delivery_mode="drafts",
        enabled=False,
    )
    db.add(rule)
    await db.flush()

    creation_run, created = await create_daily_creation_run(
        db,
        rule=rule,
        scheduled_for=datetime(2026, 8, 22, 0, tzinfo=timezone.utc),
        trigger_kind="explicit",
    )
    job = await db.get(ContentJob, creation_run.content_job_id)

    assert created is True
    assert job is not None
    assert job.input_data == {"run_id": creation_run.id}
