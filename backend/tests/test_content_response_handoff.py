import asyncio
from datetime import datetime, timezone

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


def _analysis_payload():
    return {
        "content_value_score": 82,
        "value_dimensions": {
            key: {"score": 75, "reason": "有具体价值"}
            for key in (
                "novelty",
                "practicality",
                "credibility",
                "writing_space",
                "evergreen_value",
            )
        },
        "summary_cn": "摘要",
        "core_thesis": "核心判断",
        "value_points": ["价值点一", "价值点二"],
        "evidence": [{"text": "证据", "type": "source_claim"}],
        "risks": ["需要核实时间"],
        "verification_items": ["核验原始来源"],
        "recommended_content_types": ["research", "tutorial"],
        "recommended_disposition": "worth_writing",
        "recommendation_reason": "有写作空间",
        "suggested_title": "值得写的标题",
        "suggested_angle": "从实践切入",
        "target_reader": "内容创作者",
        "suggested_structure": ["开篇", "论证", "结论"],
    }


async def _schema(engine):
    from database import Base

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)


def test_draft_handoff_requires_the_writing_job(postgres_database_url):
    from content_response_handoff import create_or_get_destination
    from content_response_handoff import HandoffError
    from models import ContentAnalysisRun, ContentResponseItem, XPost

    engine = create_async_engine(postgres_database_url)
    SessionLocal = async_sessionmaker(engine, expire_on_commit=False)

    async def run():
        await _schema(engine)
        async with SessionLocal() as db:
            post = XPost(
                tweet_id="tweet-1",
                subscription_id=1,
                username="author",
                content="完整的原文内容",
                raw_markdown="**完整的原文内容**",
                url="https://x.com/author/status/tweet-1",
                published_at=datetime.now(timezone.utc),
            )
            item = ContentResponseItem(
                source_type="x_post",
                source_id=post.tweet_id,
                source_url=post.url,
                source_title=post.content,
                current_analysis_run_id=1,
            )
            db.add_all([post, item])
            await db.flush()
            run = ContentAnalysisRun(
                response_item_id=item.id,
                version=1,
                status="succeeded",
                **_analysis_payload(),
            )
            db.add(run)
            await db.flush()
            item.current_analysis_run_id = run.id
            await db.commit()

            with pytest.raises(HandoffError, match="expanded_article"):
                await create_or_get_destination(
                    db,
                    item=item,
                    run=run,
                    destination="draft",
                    directory=None,
                )

    asyncio.run(run())


def test_creative_asset_keeps_source_and_evaluation_snapshots(
    postgres_database_url,
):
    from content_response_handoff import create_or_get_destination
    from models import ContentAnalysisRun, ContentResponseItem, CreativeAsset, CreativeAssetDirectory, YoutubeVideo

    engine = create_async_engine(postgres_database_url)
    SessionLocal = async_sessionmaker(engine, expire_on_commit=False)

    async def run():
        await _schema(engine)
        async with SessionLocal() as db:
            video = YoutubeVideo(
                id="video-1",
                channel_id="channel-1",
                title="视频标题",
                url="https://youtube.com/watch?v=video-1",
                published_at=datetime.now(timezone.utc),
                description="视频说明",
                transcript_status="ready",
                transcript_language="zh",
                transcript_text="完整字幕内容",
                transcript_segments=[{"start": 0, "end": 1, "text": "完整字幕内容"}],
            )
            item = ContentResponseItem(
                source_type="youtube_video",
                source_id=video.id,
                source_title=video.title,
            )
            directory = CreativeAssetDirectory(name="研究", asset_type="article")
            db.add_all([video, item, directory])
            await db.flush()
            analysis_run = ContentAnalysisRun(
                response_item_id=item.id,
                version=1,
                status="succeeded",
                **_analysis_payload(),
            )
            db.add(analysis_run)
            await db.flush()
            item.current_analysis_run_id = analysis_run.id
            await db.commit()

            result = await create_or_get_destination(
                db,
                item=item,
                run=analysis_run,
                destination="creative_asset",
                directory="研究",
            )
            asset = await db.get(CreativeAsset, result["id"])
            return result, asset

    result, asset = asyncio.run(run())
    assert result["type"] == "creative_asset"
    assert asset.asset_type == "article"
    assert asset.directory == "研究"
    assert asset.source == "response"
    assert "research" in asset.tags
    assert "原文快照" in asset.content
    assert "完整字幕内容" in asset.content
    assert "AI评价快照" in asset.content


def test_handoff_rejects_stale_analysis_and_unavailable_source(
    postgres_database_url,
):
    from content_response_handoff import StaleAnalysisError, SourceUnavailableError, create_or_get_destination
    from models import ContentAnalysisRun, ContentResponseItem

    engine = create_async_engine(postgres_database_url)
    SessionLocal = async_sessionmaker(engine, expire_on_commit=False)

    async def run():
        await _schema(engine)
        async with SessionLocal() as db:
            item = ContentResponseItem(
                source_type="x_post",
                source_id="missing",
                current_analysis_run_id=2,
            )
            db.add(item)
            await db.flush()
            stale = ContentAnalysisRun(
                response_item_id=item.id,
                version=1,
                status="succeeded",
                **_analysis_payload(),
            )
            current = ContentAnalysisRun(
                response_item_id=item.id,
                version=2,
                status="succeeded",
                **_analysis_payload(),
            )
            db.add_all([stale, current])
            await db.flush()
            item.current_analysis_run_id = current.id
            await db.commit()
            with pytest.raises(StaleAnalysisError):
                await create_or_get_destination(
                    db, item=item, run=stale, destination="creative_asset", directory=None,
                )
            with pytest.raises(SourceUnavailableError):
                await create_or_get_destination(
                    db, item=item, run=current, destination="creative_asset", directory=None,
                )

    asyncio.run(run())
