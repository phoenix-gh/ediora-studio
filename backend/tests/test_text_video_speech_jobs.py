import asyncio
import sys
from pathlib import Path

import pytest
from sqlalchemy import func, select

from tests.text_video_factories import (
    fresh_session_factory,
    make_speech_segment,
    make_text_video_project,
    run_async,
)


def _fresh(monkeypatch, tmp_path, name):
    for module in ("text_video_jobs", "text_video_audio", "media_command"):
        sys.modules.pop(module, None)
    return fresh_session_factory(monkeypatch, tmp_path, name)


def test_generate_pending_creates_one_job_per_draft_or_failed_segment(
    monkeypatch,
    tmp_path,
):
    session_factory = _fresh(monkeypatch, tmp_path, "speech-jobs.db")
    import text_video_jobs
    from models import ContentJob

    queued: list[int] = []

    async def capture_enqueue(job_id: int):
        async with session_factory() as observer:
            assert await observer.get(ContentJob, job_id) is not None
        queued.append(job_id)

    monkeypatch.setattr(text_video_jobs, "enqueue_job", capture_enqueue)

    async def run():
        async with session_factory() as session:
            project = make_text_video_project(script="甲。乙。丙。丁。")
            project.paragraphs = [
                make_speech_segment("a", "甲。"),
                make_speech_segment("b", "乙。", status="confirmed"),
                make_speech_segment("c", "丙。", status="failed"),
                make_speech_segment("d", "丁。", status="generating"),
            ]
            session.add(project)
            await session.commit()
            result = await text_video_jobs.launch_pending_speech_jobs(
                session,
                project,
                expected_revision=project.revision,
                speech_model="mimo-v2.5-tts",
            )
            assert [
                (job.flow, job.input_data["segment_id"])
                for job in result.jobs
            ] == [
                ("text_video_speech", "a"),
                ("text_video_speech", "c"),
            ]
            assert result.reused_segment_ids == []
            assert queued == [job.id for job in result.jobs]
            assert result.jobs[1].input_data["generation_revision"] == 1

    run_async(run())


def test_stale_speech_result_cannot_replace_edited_segment():
    from text_video_jobs import (
        StaleTextVideoJob,
        assert_current_speech_job,
        freeze_speech_job_input,
    )

    project = make_text_video_project(
        script="原稿。",
        paragraphs=[make_speech_segment("a", "原稿。")],
    )
    snapshot = freeze_speech_job_input(
        project,
        "a",
        model="mimo-v2.5-tts",
    )
    project.paragraphs[0]["text"] = "已修改。"
    project.paragraphs[0]["generation_revision"] += 1
    with pytest.raises(StaleTextVideoJob, match="配音段落已更新"):
        assert_current_speech_job(project, snapshot)


def test_duplicate_launch_reuses_one_active_job_and_reenqueues(
    monkeypatch,
    tmp_path,
):
    session_factory = _fresh(monkeypatch, tmp_path, "speech-reuse.db")
    import text_video_jobs
    from models import ContentJob

    queued: list[int] = []

    async def capture_enqueue(job_id: int):
        queued.append(job_id)

    monkeypatch.setattr(text_video_jobs, "enqueue_job", capture_enqueue)

    async def run():
        async with session_factory() as setup:
            project = make_text_video_project(
                script="同一段。",
                paragraphs=[make_speech_segment("a", "同一段。")],
            )
            setup.add(project)
            await setup.commit()
            project_id = project.id
            revision = project.revision

        async with session_factory() as first:
            project = await first.get(type(project), project_id)
            result1 = await text_video_jobs.launch_speech_job(
                first,
                project,
                "a",
                expected_revision=revision,
                speech_model="mimo-v2.5-tts",
            )
        async with session_factory() as second:
            project = await second.get(type(project), project_id)
            result2 = await text_video_jobs.launch_speech_job(
                second,
                project,
                "a",
                expected_revision=revision,
                speech_model="mimo-v2.5-tts",
            )
            count = await second.scalar(
                select(func.count(ContentJob.id)).where(
                    ContentJob.flow == "text_video_speech",
                )
            )

        assert result1.jobs[0].id == result2.jobs[0].id
        assert count == 1
        assert queued == [result1.jobs[0].id, result1.jobs[0].id]

    run_async(run())


def test_failed_generation_gets_a_new_deterministic_key(
    monkeypatch,
    tmp_path,
):
    session_factory = _fresh(monkeypatch, tmp_path, "speech-failed.db")
    import text_video_jobs
    from models import ContentJob

    async def ignore_enqueue(_job_id: int):
        return None

    monkeypatch.setattr(text_video_jobs, "enqueue_job", ignore_enqueue)

    async def run():
        async with session_factory() as session:
            project = make_text_video_project(
                script="再试。",
                paragraphs=[make_speech_segment("a", "再试。")],
            )
            session.add(project)
            await session.commit()
            first = await text_video_jobs.launch_speech_job(
                session,
                project,
                "a",
                expected_revision=project.revision,
                speech_model="mimo-v2.5-tts",
            )
            first.jobs[0].status = "failed"
            paragraphs = list(project.paragraphs)
            paragraphs[0] = {
                **paragraphs[0],
                "status": "failed",
                "error": "provider failed",
            }
            project.paragraphs = paragraphs
            await session.commit()

            second = await text_video_jobs.launch_speech_job(
                session,
                project,
                "a",
                expected_revision=project.revision,
                speech_model="mimo-v2.5-tts",
            )
            jobs = (
                await session.execute(
                    select(ContentJob).order_by(ContentJob.id),
                )
            ).scalars().all()

            assert len(jobs) == 2
            assert jobs[0].idempotency_key != jobs[1].idempotency_key
            assert second.jobs[0].input_data["generation_revision"] == 1

    run_async(run())


def test_pending_reuses_only_an_existing_uploaded_asset(
    monkeypatch,
    tmp_path,
):
    session_factory = _fresh(monkeypatch, tmp_path, "speech-asset-reuse.db")
    import text_video_jobs
    from models import CreativeAsset, TextVideoSpeechAsset
    from text_video_domain import speech_source_hash

    uploads = tmp_path / "uploads"
    uploads.mkdir()
    monkeypatch.setattr(text_video_jobs, "UPLOADS_DIR", uploads)
    async def ignore_enqueue(_job_id: int):
        return None
    monkeypatch.setattr(text_video_jobs, "enqueue_job", ignore_enqueue)
    source_hash = speech_source_hash(
        "已有。",
        {
            "voice_id": "mimo_default",
            "model": "mimo-v2.5-tts",
            "speed": 1,
            "volume": 1,
            "pitch": 0,
        },
        "mimo-v2.5-tts",
    )

    async def run():
        async with session_factory() as session:
            path = uploads / "existing.mp3"
            path.write_bytes(b"existing")
            asset = CreativeAsset(
                asset_type="media",
                media_kind="audio",
                title="existing",
                url="/api/uploads/existing.mp3",
                media_type="audio/mpeg",
                filename="user-label.mp3",
                source="generated",
            )
            session.add(asset)
            await session.flush()
            session.add(TextVideoSpeechAsset(
                creative_asset_id=asset.id,
                source_hash=source_hash,
                duration=1,
                sample_count=44100,
                sample_rate=44100,
            ))
            project = make_text_video_project(
                script="已有。",
                paragraphs=[make_speech_segment("a", "已有。")],
            )
            session.add(project)
            await session.commit()

            result = await text_video_jobs.launch_pending_speech_jobs(
                session,
                project,
                expected_revision=project.revision,
                speech_model="mimo-v2.5-tts",
            )

            assert result.jobs == []
            assert result.reused_segment_ids == ["a"]
            assert result.project.paragraphs[0]["status"] == "ready"
            assert result.project.paragraphs[0]["audio_url"] == asset.url

            path.unlink()
            result.project.paragraphs = [
                make_speech_segment("a", "已有。", status="draft"),
            ]
            await session.commit()
            regenerated = await text_video_jobs.launch_pending_speech_jobs(
                session,
                result.project,
                expected_revision=result.project.revision,
                speech_model="mimo-v2.5-tts",
            )
            assert len(regenerated.jobs) == 1

    run_async(run())
