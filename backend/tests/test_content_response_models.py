from sqlalchemy import create_engine, inspect, select
from sqlalchemy.orm import Session


def test_unified_response_schema_and_defaults(tmp_path):
    import models
    from database import Base

    engine = create_engine(f"sqlite:///{tmp_path / 'responses.db'}")
    Base.metadata.create_all(engine)
    tables = set(inspect(engine).get_table_names())
    expected = {
        "content_response_items",
        "content_analysis_runs",
        "content_account_scores",
        "content_response_outputs",
        "content_response_notifications",
        "content_response_events",
    }
    assert expected <= tables

    with Session(engine, expire_on_commit=False) as db:
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
        db.commit()
        db.refresh(channel)
        db.refresh(video)
        db.refresh(item)

        assert channel.auto_analyze_new_videos is False
        assert channel.analysis_enabled_at is None
        assert video.transcript_status == "not_requested"
        assert video.transcript_segments == []
        assert item.workflow_status == "queued"
        assert item.decision_status == "pending"
        assert item.selected_output_types == []

        run = models.ContentAnalysisRun(response_item_id=item.id, version=1)
        db.add(run)
        db.commit()
        db.refresh(run)
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
        db.commit()

        assert db.execute(select(models.ContentAccountScore)).scalar_one()
        assert db.execute(select(models.ContentResponseOutput)).scalar_one()
        assert db.execute(select(models.ContentResponseNotification)).scalar_one()
        assert db.execute(select(models.ContentResponseEvent)).scalar_one()
    engine.dispose()


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
