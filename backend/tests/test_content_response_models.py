from sqlalchemy import inspect, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


async def test_unified_response_schema_and_defaults(postgres_database_url):
    import models
    from database import Base

    engine = create_async_engine(postgres_database_url)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
        tables = set(await connection.run_sync(
            lambda sync_connection: inspect(sync_connection).get_table_names()
        ))
    expected = {
        "content_response_items",
        "content_analysis_runs",
        "content_account_scores",
        "content_response_outputs",
        "content_response_notifications",
        "content_response_events",
    }
    assert expected <= tables

    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as db:
        channel = models.YoutubeChannel(id="channel", name="Channel")
        video = models.YoutubeVideo(
            id="video",
            channel_id=channel.id,
            channel_name=channel.name,
            published_at=models.now_utc(),
        )
        item = models.ContentResponseItem(
            source_type="youtube_video",
            source_id=video.id,
        )
        db.add_all([channel, video, item])
        await db.commit()
        await db.refresh(channel)
        await db.refresh(video)
        await db.refresh(item)

        assert channel.auto_analyze_new_videos is False
        assert channel.analysis_enabled_at is None
        assert video.transcript_status == "not_requested"
        assert video.transcript_segments == []
        assert item.workflow_status == "queued"
        assert item.decision_status == "pending"
        assert item.selected_output_types == []

        run = models.ContentAnalysisRun(response_item_id=item.id, version=1)
        db.add(run)
        await db.commit()
        await db.refresh(run)
        score = models.ContentAccountScore(
            analysis_run_id=run.id,
            publish_account_id="account",
        )
        output = models.ContentResponseOutput(
            response_item_id=item.id,
            analysis_run_id=run.id,
            output_type="x_share",
        )
        notification = models.ContentResponseNotification(
            response_item_id=item.id,
            analysis_run_id=run.id,
        )
        event = models.ContentResponseEvent(
            response_item_id=item.id,
            event_type="created",
        )
        db.add_all([score, output, notification, event])
        await db.commit()

        assert (await db.execute(select(models.ContentAccountScore))).scalar_one()
        assert (await db.execute(select(models.ContentResponseOutput))).scalar_one()
        assert (
            await db.execute(select(models.ContentResponseNotification))
        ).scalar_one()
        assert (await db.execute(select(models.ContentResponseEvent))).scalar_one()
    await engine.dispose()


def test_response_source_and_analysis_version_are_unique():
    import models

    item_constraints = {
        tuple(constraint.columns.keys())
        for constraint in models.ContentResponseItem.__table__.constraints
        if constraint.__class__.__name__ == "UniqueConstraint"
    }
    run_constraints = {
        tuple(constraint.columns.keys())
        for constraint in models.ContentAnalysisRun.__table__.constraints
        if constraint.__class__.__name__ == "UniqueConstraint"
    }

    assert ("source_type", "source_id") in item_constraints
    assert ("response_item_id", "version") in run_constraints


async def test_intelligence_station_defaults_are_empty_and_pending(
    postgres_database_url,
):
    import models
    from database import Base

    engine = create_async_engine(postgres_database_url)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine)
    async with sessions() as db:
        item = models.ContentResponseItem(source_type="x_post", source_id="post-1")
        db.add(item)
        await db.flush()
        run = models.ContentAnalysisRun(response_item_id=item.id, version=1)
        db.add(run)
        await db.flush()

        assert item.decision_status == "pending"
        assert item.content_types == []
        assert item.destination_type is None
        assert item.destination_id is None
        assert run.recommended_content_types == []
        assert run.recommended_disposition == "pending"
    await engine.dispose()
