import asyncio
import sys

import pytest


@pytest.fixture
def session_factory(monkeypatch, tmp_path):
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{tmp_path / 'jobs.db'}")
    for module in list(sys.modules):
        if module.startswith(("database", "models", "content_jobs")):
            sys.modules.pop(module, None)

    from database import Base, SessionLocal, engine
    import models  # noqa: F401

    async def setup():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.new_event_loop().run_until_complete(setup())
    return SessionLocal


def test_retrying_failed_step_preserves_completed_steps(session_factory):
    from content_jobs import create_job, fail_step, retry_step, start_step, succeed_step

    async def run():
        async with session_factory() as session:
            job = await create_job(session, flow="draft", title="T", input_data={})
            brief = await start_step(session, job.id, "brief")
            await succeed_step(session, brief.id, {"brief": "ok"})
            draft = await start_step(session, job.id, "draft")
            await fail_step(session, draft.id, "provider timeout", retryable=True)

            retry = await retry_step(session, job.id, "draft")

            assert retry.attempt == 2
            assert retry.status == "queued"
            assert brief.status == "succeeded"

    asyncio.new_event_loop().run_until_complete(run())


def test_cancelled_job_cannot_retry_its_previous_failed_step(session_factory):
    from content_jobs import (
        InvalidJobTransition,
        cancel_job,
        create_job,
        fail_step,
        retry_step,
        start_step,
    )
    from models import ContentJob, ContentJobStep
    from sqlalchemy import select

    async def run():
        async with session_factory() as session:
            job = await create_job(
                session,
                flow="draft",
                title="cancelled retry",
                input_data={},
            )
            step = await start_step(session, job.id, "draft")
            await fail_step(
                session,
                step.id,
                "temporary",
                retryable=True,
            )
            await cancel_job(session, job.id)

            with pytest.raises(
                InvalidJobTransition,
                match="failed job",
            ):
                await retry_step(session, job.id, "draft")

            current = await session.get(ContentJob, job.id)
            attempts = (
                await session.scalars(
                    select(ContentJobStep)
                    .where(
                        ContentJobStep.job_id == job.id,
                        ContentJobStep.step_key == "draft",
                    )
                    .order_by(ContentJobStep.attempt),
                )
            ).all()

            assert current.status == "cancelled"
            assert [(item.attempt, item.status) for item in attempts] == [
                (1, "failed"),
            ]

    asyncio.new_event_loop().run_until_complete(run())


def test_retrying_an_already_queued_attempt_is_idempotent(session_factory):
    from content_jobs import create_job, fail_step, retry_step, start_step
    from models import ContentJobEvent, ContentJobStep
    from sqlalchemy import select

    async def run():
        async with session_factory() as session:
            job = await create_job(
                session,
                flow="draft",
                title="retry replay",
                input_data={},
            )
            step = await start_step(session, job.id, "draft")
            await fail_step(
                session,
                step.id,
                "temporary",
                retryable=True,
            )

            first = await retry_step(session, job.id, "draft")
            replay = await retry_step(session, job.id, "draft")
            attempts = (
                await session.scalars(
                    select(ContentJobStep)
                    .where(
                        ContentJobStep.job_id == job.id,
                        ContentJobStep.step_key == "draft",
                    )
                    .order_by(ContentJobStep.attempt),
                )
            ).all()
            events = (
                await session.scalars(
                    select(ContentJobEvent).where(
                        ContentJobEvent.job_id == job.id,
                        ContentJobEvent.kind == "step_retried",
                    ),
                )
            ).all()

            assert replay.id == first.id
            assert replay.attempt == first.attempt == 2
            assert replay.status == "queued"
            assert [(item.attempt, item.status) for item in attempts] == [
                (1, "failed"),
                (2, "queued"),
            ]
            assert len(events) == 1
            assert events[0].step_id == first.id

    asyncio.new_event_loop().run_until_complete(run())


def test_analysis_job_failure_and_retry_update_response_state(session_factory):
    from content_jobs import create_job, fail_step, retry_step, start_step
    from models import ContentAnalysisRun, ContentResponseItem

    async def run():
        async with session_factory() as session:
            item = ContentResponseItem(
                source_type="youtube_video",
                source_id="video",
            )
            session.add(item)
            await session.flush()
            job = await create_job(
                session,
                flow="content_response_analysis",
                title="Analyze",
                input_data={"response_item_id": item.id},
                commit=False,
            )
            analysis = ContentAnalysisRun(
                response_item_id=item.id,
                version=1,
                job_id=job.id,
            )
            session.add(analysis)
            await session.commit()

            step = await start_step(session, job.id, "extract_content")
            await fail_step(
                session,
                step.id,
                "caption provider timed out",
                retryable=True,
            )
            await session.refresh(item)
            await session.refresh(analysis)

            assert item.workflow_status == "failed"
            assert analysis.status == "failed"
            assert analysis.error_code == "extract_content"
            assert analysis.error == "caption provider timed out"

            await retry_step(session, job.id, "extract_content")
            await session.refresh(item)
            await session.refresh(analysis)

            assert item.workflow_status == "queued"
            assert analysis.status == "queued"
            assert analysis.error_code == ""
            assert analysis.error == ""

    asyncio.new_event_loop().run_until_complete(run())


def test_job_can_join_the_callers_transaction(session_factory):
    from content_jobs import create_job
    from models import ContentJob

    async def run():
        async with session_factory() as writer:
            job = await create_job(
                writer,
                flow="digital_human_render",
                title="atomic",
                input_data={"render_id": 1},
                commit=False,
            )
            async with session_factory() as reader:
                assert await reader.get(ContentJob, job.id) is None

            await writer.commit()

        async with session_factory() as reader:
            assert await reader.get(ContentJob, job.id) is not None

    asyncio.new_event_loop().run_until_complete(run())


def test_create_or_get_job_reuses_nonempty_key_but_not_empty_keys(
    session_factory,
):
    from content_jobs import create_or_get_job
    from models import ContentJob
    from sqlalchemy import select

    async def run():
        async with session_factory() as session:
            first = await create_or_get_job(
                session,
                flow="text_video_speech",
                title="one",
                input_data={"segment_id": "a"},
                idempotency_key="speech-key",
            )
            repeated = await create_or_get_job(
                session,
                flow="text_video_speech",
                title="duplicate",
                input_data={"segment_id": "a"},
                idempotency_key="speech-key",
            )
            empty_one = await create_or_get_job(
                session,
                flow="draft",
                title="empty one",
                input_data={},
            )
            empty_two = await create_or_get_job(
                session,
                flow="draft",
                title="empty two",
                input_data={},
            )
            await session.commit()
            jobs = (
                await session.execute(
                    select(ContentJob).order_by(ContentJob.id),
                )
            ).scalars().all()

            assert repeated.id == first.id
            assert empty_one.id != empty_two.id
            assert len(jobs) == 3

    asyncio.new_event_loop().run_until_complete(run())


def test_idempotency_migration_rewrites_historical_duplicates_and_keeps_empty(
    monkeypatch,
    tmp_path,
):
    monkeypatch.setenv(
        "WMS_DATABASE_URL",
        f"sqlite+aiosqlite:///{tmp_path / 'legacy-idempotency.db'}",
    )
    import sys
    sys.modules.pop("database", None)
    from database import migrate_content_job_idempotency_schema
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError
    from sqlalchemy.ext.asyncio import create_async_engine

    async def run():
        engine = create_async_engine(
            f"sqlite+aiosqlite:///{tmp_path / 'legacy-idempotency.db'}",
        )
        async with engine.begin() as connection:
            await connection.execute(text(
                "CREATE TABLE content_jobs ("
                "id INTEGER PRIMARY KEY, idempotency_key VARCHAR NOT NULL)"
            ))
            await connection.execute(text(
                "INSERT INTO content_jobs (id, idempotency_key) VALUES "
                "(1, 'same'), (2, 'same'), (3, ''), (4, ''), "
                "(5, 'same:legacy:2')"
            ))
            await migrate_content_job_idempotency_schema(connection)
            await migrate_content_job_idempotency_schema(connection)
            rows = (
                await connection.execute(text(
                    "SELECT id, idempotency_key FROM content_jobs ORDER BY id",
                ))
            ).all()
        assert rows == [
            (1, "same"),
            (2, "same:legacy:2:1"),
            (3, ""),
            (4, ""),
            (5, "same:legacy:2"),
        ]
        with pytest.raises(IntegrityError):
            async with engine.begin() as connection:
                await connection.execute(text(
                    "INSERT INTO content_jobs (id, idempotency_key) "
                    "VALUES (7, 'same')"
                ))
        async with engine.begin() as connection:
            await connection.execute(text(
                "INSERT INTO content_jobs (id, idempotency_key) "
                "VALUES (8, '')"
            ))
        await engine.dispose()

    asyncio.new_event_loop().run_until_complete(run())


def test_speech_retry_restores_only_its_current_segment(session_factory):
    from content_jobs import create_job, fail_step, retry_step, start_step
    from models import TextVideoProject
    from tests.text_video_factories import (
        make_speech_segment,
        make_text_video_project,
    )

    async def run():
        async with session_factory() as session:
            project = make_text_video_project(
                script="甲。乙。",
                paragraphs=[
                    make_speech_segment("a", "甲。"),
                    make_speech_segment("b", "乙。", status="confirmed"),
                ],
            )
            session.add(project)
            await session.flush()
            job = await create_job(
                session,
                flow="text_video_speech",
                title="speech",
                input_data={
                    "project_id": project.id,
                    "segment_id": "a",
                    "generation_revision": 0,
                    "source_hash": "a" * 64,
                },
                commit=False,
            )
            project.paragraphs = [
                {
                    **project.paragraphs[0],
                    "status": "generating",
                    "job_id": job.id,
                    "source_hash": "a" * 64,
                },
                project.paragraphs[1],
            ]
            await session.commit()
            step = await start_step(session, job.id, "generate_speech")
            await fail_step(
                session,
                step.id,
                "temporary",
                retryable=True,
            )
            await session.refresh(project)
            paragraphs = list(project.paragraphs)
            paragraphs[0] = {
                **paragraphs[0],
                "status": "failed",
                "job_id": None,
                "error": "temporary",
            }
            project.paragraphs = paragraphs
            await session.commit()

            await retry_step(session, job.id, "generate_speech")
            await session.refresh(project)
            current = await session.get(TextVideoProject, project.id)

            assert current.paragraphs[0]["status"] == "generating"
            assert current.paragraphs[0]["job_id"] == job.id
            assert current.paragraphs[0]["error"] == ""
            assert current.paragraphs[1]["status"] == "confirmed"

    asyncio.new_event_loop().run_until_complete(run())


def test_retrying_master_assembly_restores_current_master_to_building(
    session_factory,
):
    from content_jobs import (
        create_job,
        fail_step,
        retry_step,
        start_step,
    )
    from models import ContentJobStep, TextVideoProject
    from tests.text_video_factories import (
        make_master_audio,
        make_text_video_project,
    )

    async def run():
        async with session_factory() as session:
            project = make_text_video_project(script="甲。")
            session.add(project)
            await session.flush()
            job = await create_job(
                session,
                flow="text_video_master_audio",
                title="master",
                input_data={
                    "project_id": project.id,
                    "source_hash": "d" * 64,
                },
                commit=False,
            )
            project.master_audio = make_master_audio(
                status="building",
                timeline_status="missing",
                source_hash="d" * 64,
                job_id=job.id,
            )
            await session.commit()
            step = await start_step(
                session,
                job.id,
                "assemble_master_audio",
            )
            await fail_step(
                session,
                step.id,
                "temporary assembly failure",
                retryable=True,
            )
            project = await session.get(TextVideoProject, project.id)
            project.master_audio = {
                **project.master_audio,
                "status": "failed",
                "error": "temporary assembly failure",
            }
            await session.commit()

            retried = await retry_step(
                session,
                job.id,
                "assemble_master_audio",
            )
            current = await session.get(TextVideoProject, project.id)
            stored_retry = await session.get(ContentJobStep, retried.id)

            assert stored_retry.attempt == 2
            assert stored_retry.status == "queued"
            assert current.master_audio["status"] == "building"
            assert current.master_audio["timeline_status"] == "missing"
            assert current.master_audio["error"] == ""
            assert current.master_audio["timeline_error"] == ""
            assert current.master_audio["job_id"] == job.id
            assert current.render_input["audio"] == ""

    asyncio.new_event_loop().run_until_complete(run())


def test_retrying_master_assembly_preserves_a_durable_ready_result(
    session_factory,
):
    from copy import deepcopy

    from content_jobs import (
        create_job,
        fail_step,
        retry_step,
        start_step,
    )
    from models import TextVideoProject
    from tests.text_video_factories import (
        make_master_audio,
        make_text_video_project,
    )

    async def run():
        async with session_factory() as session:
            project = make_text_video_project(script="甲。")
            session.add(project)
            await session.flush()
            job = await create_job(
                session,
                flow="text_video_master_audio",
                title="master",
                input_data={
                    "project_id": project.id,
                    "source_hash": "5" * 64,
                },
                commit=False,
            )
            project.master_audio = make_master_audio(
                status="building",
                timeline_status="missing",
                source_hash="5" * 64,
                job_id=job.id,
            )
            await session.commit()
            step = await start_step(
                session,
                job.id,
                "assemble_master_audio",
            )
            project = await session.get(TextVideoProject, project.id)
            project.master_audio = make_master_audio(
                status="ready",
                timeline_status="missing",
                asset_id=71,
                audio_url="/api/uploads/durable-master.mp3",
                source_hash="5" * 64,
                sample_rate=44100,
                sample_count=44100,
                duration=1.0,
                segment_offsets=[{
                    "speech_segment_id": "segment-1",
                    "asset_id": 70,
                    "source_hash": "6" * 64,
                    "sample_offset": 0,
                    "sample_count": 44100,
                    "sample_rate": 44100,
                }],
                owns_asset=True,
                job_id=job.id,
            )
            await session.commit()
            durable_master = deepcopy(project.master_audio)
            await fail_step(
                session,
                step.id,
                "assemble response lost",
                retryable=True,
            )

            await retry_step(
                session,
                job.id,
                "assemble_master_audio",
            )
            current = await session.get(TextVideoProject, project.id)

            assert current.master_audio == durable_master
            assert current.render_input["audio"] == ""

    asyncio.new_event_loop().run_until_complete(run())


def test_retrying_master_alignment_keeps_audio_and_restores_aligning(
    session_factory,
):
    from content_jobs import (
        create_job,
        fail_step,
        retry_step,
        start_step,
        succeed_step,
    )
    from models import TextVideoProject
    from tests.text_video_factories import (
        make_master_audio,
        make_text_video_project,
    )

    async def run():
        async with session_factory() as session:
            project = make_text_video_project(script="甲。")
            session.add(project)
            await session.flush()
            job = await create_job(
                session,
                flow="text_video_master_audio",
                title="master",
                input_data={
                    "project_id": project.id,
                    "source_hash": "e" * 64,
                },
                commit=False,
            )
            project.master_audio = make_master_audio(
                status="building",
                timeline_status="missing",
                source_hash="e" * 64,
                job_id=job.id,
            )
            await session.commit()
            assemble = await start_step(
                session,
                job.id,
                "assemble_master_audio",
            )
            await succeed_step(session, assemble.id, {"asset_id": 31})
            project = await session.get(TextVideoProject, project.id)
            project.master_audio = make_master_audio(
                status="ready",
                timeline_status="aligning",
                asset_id=31,
                audio_url="/api/uploads/master-align.mp3",
                source_hash="e" * 64,
                sample_rate=44100,
                sample_count=88200,
                duration=2.0,
                segment_offsets=[{
                    "segment_id": "segment-1",
                    "asset_id": 7,
                    "start_sample": 0,
                    "end_sample": 88200,
                }],
                job_id=job.id,
            )
            await session.commit()
            align = await start_step(
                session,
                job.id,
                "align_master_timeline",
            )
            await fail_step(
                session,
                align.id,
                "temporary alignment failure",
                retryable=True,
            )
            project = await session.get(TextVideoProject, project.id)
            project.master_audio = {
                **project.master_audio,
                "timeline_status": "failed",
                "timeline_error": "temporary alignment failure",
            }
            await session.commit()

            retried = await retry_step(
                session,
                job.id,
                "align_master_timeline",
            )
            current = await session.get(TextVideoProject, project.id)
            master = current.master_audio

            assert retried.attempt == 2
            assert retried.status == "queued"
            assert master["status"] == "ready"
            assert master["timeline_status"] == "aligning"
            assert master["timeline_error"] == ""
            assert master["error"] == ""
            assert master["asset_id"] == 31
            assert master["audio_url"] == "/api/uploads/master-align.mp3"
            assert master["sample_rate"] == 44100
            assert master["sample_count"] == 88200
            assert master["segment_offsets"][0]["end_sample"] == 88200
            assert current.render_input["audio"] == ""

    asyncio.new_event_loop().run_until_complete(run())


def test_retrying_master_alignment_preserves_a_durable_ready_timeline(
    session_factory,
):
    from copy import deepcopy

    from content_jobs import (
        create_job,
        fail_step,
        retry_step,
        start_step,
        succeed_step,
    )
    from models import TextVideoProject
    from tests.text_video_factories import (
        make_master_audio,
        make_text_video_project,
    )

    async def run():
        async with session_factory() as session:
            project = make_text_video_project(script="甲。")
            session.add(project)
            await session.flush()
            job = await create_job(
                session,
                flow="text_video_master_audio",
                title="master",
                input_data={
                    "project_id": project.id,
                    "source_hash": "7" * 64,
                },
                commit=False,
            )
            project.master_audio = make_master_audio(
                status="building",
                timeline_status="missing",
                source_hash="7" * 64,
                job_id=job.id,
            )
            await session.commit()
            assemble = await start_step(
                session,
                job.id,
                "assemble_master_audio",
            )
            await succeed_step(session, assemble.id, {"asset_id": 81})
            align = await start_step(
                session,
                job.id,
                "align_master_timeline",
            )
            project = await session.get(TextVideoProject, project.id)
            project.master_audio = make_master_audio(
                status="ready",
                timeline_status="ready",
                asset_id=81,
                audio_url="/api/uploads/durable-timeline.mp3",
                source_hash="7" * 64,
                sample_rate=44100,
                sample_count=44100,
                duration=1.0,
                segment_offsets=[{
                    "speech_segment_id": "segment-1",
                    "asset_id": 80,
                    "source_hash": "8" * 64,
                    "sample_offset": 0,
                    "sample_count": 44100,
                    "sample_rate": 44100,
                }],
                word_timings=[{
                    "id": "word-1",
                    "text": "甲。",
                    "start": 0.0,
                    "end": 1.0,
                    "speech_segment_id": "segment-1",
                }],
                timeline_source="provider",
                job_id=job.id,
            )
            project.render_input = {
                **project.render_input,
                "audio": "/api/uploads/durable-timeline.mp3",
            }
            await session.commit()
            durable_master = deepcopy(project.master_audio)
            durable_render_input = deepcopy(project.render_input)
            await fail_step(
                session,
                align.id,
                "align response lost",
                retryable=True,
            )

            await retry_step(
                session,
                job.id,
                "align_master_timeline",
            )
            current = await session.get(TextVideoProject, project.id)

            assert current.master_audio == durable_master
            assert current.render_input == durable_render_input

    asyncio.new_event_loop().run_until_complete(run())


def test_retrying_old_master_job_does_not_bind_a_new_source(
    session_factory,
):
    from copy import deepcopy

    from content_jobs import (
        create_job,
        fail_step,
        retry_step,
        start_step,
    )
    from models import TextVideoProject
    from tests.text_video_factories import (
        make_master_audio,
        make_text_video_project,
    )

    async def run():
        async with session_factory() as session:
            project = make_text_video_project(script="甲。")
            session.add(project)
            await session.flush()
            old_job = await create_job(
                session,
                flow="text_video_master_audio",
                title="old master",
                input_data={
                    "project_id": project.id,
                    "source_hash": "f" * 64,
                },
                commit=False,
            )
            await session.commit()
            old_step = await start_step(
                session,
                old_job.id,
                "assemble_master_audio",
            )
            await fail_step(
                session,
                old_step.id,
                "old source failed",
                retryable=True,
            )
            new_job = await create_job(
                session,
                flow="text_video_master_audio",
                title="new master",
                input_data={
                    "project_id": project.id,
                    "source_hash": "1" * 64,
                },
                commit=False,
            )
            project = await session.get(TextVideoProject, project.id)
            project.master_audio = make_master_audio(
                status="ready",
                timeline_status="ready",
                asset_id=51,
                audio_url="/api/uploads/new-master.mp3",
                source_hash="1" * 64,
                sample_rate=44100,
                sample_count=44100,
                duration=1.0,
                job_id=new_job.id,
            )
            project.render_input = {
                **project.render_input,
                "audio": "/api/uploads/new-master.mp3",
            }
            await session.commit()
            expected_master = deepcopy(project.master_audio)
            expected_render_input = deepcopy(project.render_input)

            await retry_step(
                session,
                old_job.id,
                "assemble_master_audio",
            )
            current = await session.get(TextVideoProject, project.id)

            assert current.master_audio == expected_master
            assert current.render_input == expected_render_input

    asyncio.new_event_loop().run_until_complete(run())


def test_old_master_job_cannot_mutate_a_new_job_with_the_same_source(
    session_factory,
):
    from copy import deepcopy

    from content_jobs import (
        cancel_job,
        create_job,
        fail_step,
        retry_step,
        start_step,
    )
    from models import TextVideoProject
    from tests.text_video_factories import (
        make_master_audio,
        make_text_video_project,
    )

    async def run():
        async with session_factory() as session:
            source_hash = "8" * 64
            project = make_text_video_project(script="甲。")
            session.add(project)
            await session.flush()
            old_job = await create_job(
                session,
                flow="text_video_master_audio",
                title="old master",
                input_data={
                    "project_id": project.id,
                    "source_hash": source_hash,
                },
                commit=False,
            )
            await session.commit()
            old_step = await start_step(
                session,
                old_job.id,
                "assemble_master_audio",
            )
            await fail_step(
                session,
                old_step.id,
                "old job failed",
                retryable=True,
            )
            new_job = await create_job(
                session,
                flow="text_video_master_audio",
                title="replacement master",
                input_data={
                    "project_id": project.id,
                    "source_hash": source_hash,
                },
                commit=False,
            )
            project = await session.get(TextVideoProject, project.id)
            project.master_audio = make_master_audio(
                status="ready",
                timeline_status="ready",
                asset_id=81,
                audio_url="/api/uploads/replacement-master.mp3",
                source_hash=source_hash,
                sample_rate=44100,
                sample_count=44100,
                duration=1.0,
                job_id=new_job.id,
            )
            project.render_input = {
                **project.render_input,
                "audio": "/api/uploads/replacement-master.mp3",
            }
            await session.commit()
            expected_master = deepcopy(project.master_audio)
            expected_render_input = deepcopy(project.render_input)

            await retry_step(
                session,
                old_job.id,
                "assemble_master_audio",
            )
            after_retry = await session.get(TextVideoProject, project.id)
            assert after_retry.master_audio == expected_master
            assert after_retry.render_input == expected_render_input

            await cancel_job(session, old_job.id)
            after_cancel = await session.get(TextVideoProject, project.id)
            assert after_cancel.master_audio == expected_master
            assert after_cancel.render_input == expected_render_input

    asyncio.new_event_loop().run_until_complete(run())


def test_cancelling_old_master_job_does_not_downgrade_new_ready_source(
    session_factory,
):
    from copy import deepcopy

    from content_jobs import cancel_job, create_job
    from models import TextVideoProject
    from tests.text_video_factories import (
        make_master_audio,
        make_text_video_project,
    )

    async def run():
        async with session_factory() as session:
            project = make_text_video_project(script="甲。")
            session.add(project)
            await session.flush()
            old_job = await create_job(
                session,
                flow="text_video_master_audio",
                title="old master",
                input_data={
                    "project_id": project.id,
                    "source_hash": "3" * 64,
                },
                commit=False,
            )
            new_job = await create_job(
                session,
                flow="text_video_master_audio",
                title="new master",
                input_data={
                    "project_id": project.id,
                    "source_hash": "4" * 64,
                },
                commit=False,
            )
            project.master_audio = make_master_audio(
                status="ready",
                timeline_status="ready",
                asset_id=61,
                audio_url="/api/uploads/current-master.mp3",
                source_hash="4" * 64,
                sample_rate=44100,
                sample_count=44100,
                duration=1.0,
                job_id=new_job.id,
            )
            project.render_input = {
                **project.render_input,
                "audio": "/api/uploads/current-master.mp3",
            }
            await session.commit()
            expected_master = deepcopy(project.master_audio)
            expected_render_input = deepcopy(project.render_input)

            cancelled = await cancel_job(session, old_job.id)
            current = await session.get(TextVideoProject, project.id)

            assert cancelled.status == "cancelled"
            assert current.master_audio == expected_master
            assert current.render_input == expected_render_input

    asyncio.new_event_loop().run_until_complete(run())


def test_cancelling_master_job_before_assembly_commit_fails_only_master(
    session_factory,
):
    from content_jobs import cancel_job, create_job
    from models import TextVideoProject
    from tests.text_video_factories import (
        make_master_audio,
        make_speech_segment,
        make_text_video_project,
    )

    async def run():
        async with session_factory() as session:
            project = make_text_video_project(
                script="甲。",
                paragraphs=[
                    make_speech_segment("a", "甲。", status="confirmed"),
                ],
            )
            session.add(project)
            await session.flush()
            job = await create_job(
                session,
                flow="text_video_master_audio",
                title="master",
                input_data={
                    "project_id": project.id,
                    "source_hash": "a" * 64,
                },
                commit=False,
            )
            project.master_audio = make_master_audio(
                status="building",
                timeline_status="missing",
                source_hash="a" * 64,
                job_id=job.id,
            )
            confirmed = list(project.paragraphs)
            await session.commit()

            await cancel_job(session, job.id)
            current = await session.get(TextVideoProject, project.id)

            assert current.master_audio["status"] == "failed"
            assert current.master_audio["error"] == "任务已取消"
            assert current.master_audio["timeline_status"] == "missing"
            assert current.render_input["audio"] == ""
            assert current.paragraphs == confirmed

    asyncio.new_event_loop().run_until_complete(run())


def test_cancelling_master_job_after_assembly_keeps_playable_audio(
    session_factory,
):
    from content_jobs import cancel_job, create_job
    from models import TextVideoProject
    from tests.text_video_factories import (
        make_master_audio,
        make_speech_segment,
        make_text_video_project,
    )

    async def run():
        async with session_factory() as session:
            project = make_text_video_project(
                script="甲。",
                paragraphs=[
                    make_speech_segment("a", "甲。", status="confirmed"),
                ],
            )
            project.render_input = {
                **project.render_input,
                "audio": "/api/uploads/old-master.mp3",
            }
            session.add(project)
            await session.flush()
            job = await create_job(
                session,
                flow="text_video_master_audio",
                title="master",
                input_data={
                    "project_id": project.id,
                    "source_hash": "b" * 64,
                },
                commit=False,
            )
            project.master_audio = make_master_audio(
                status="ready",
                timeline_status="aligning",
                asset_id=17,
                audio_url="/api/uploads/master.mp3",
                source_hash="b" * 64,
                sample_rate=44100,
                sample_count=44100,
                duration=1.0,
                segment_offsets=[{
                    "segment_id": "a",
                    "asset_id": 9,
                    "start_sample": 0,
                    "end_sample": 44100,
                }],
                job_id=job.id,
            )
            confirmed = list(project.paragraphs)
            await session.commit()

            await cancel_job(session, job.id)
            current = await session.get(TextVideoProject, project.id)
            master = current.master_audio

            assert master["status"] == "ready"
            assert master["error"] == ""
            assert master["timeline_status"] == "failed"
            assert master["timeline_error"] == "任务已取消"
            assert master["asset_id"] == 17
            assert master["audio_url"] == "/api/uploads/master.mp3"
            assert master["sample_rate"] == 44100
            assert master["sample_count"] == 44100
            assert master["segment_offsets"][0]["end_sample"] == 44100
            assert current.render_input["audio"] == ""
            assert current.paragraphs == confirmed

    asyncio.new_event_loop().run_until_complete(run())


def test_repeated_master_cancel_is_idempotent(session_factory):
    from content_jobs import cancel_job, create_job
    from models import ContentJobEvent, TextVideoProject
    from sqlalchemy import select
    from tests.text_video_factories import (
        make_master_audio,
        make_text_video_project,
    )

    async def run():
        async with session_factory() as session:
            project = make_text_video_project(script="甲。")
            session.add(project)
            await session.flush()
            job = await create_job(
                session,
                flow="text_video_master_audio",
                title="master",
                input_data={
                    "project_id": project.id,
                    "source_hash": "2" * 64,
                },
                commit=False,
            )
            project.master_audio = make_master_audio(
                status="building",
                timeline_status="missing",
                source_hash="2" * 64,
                job_id=job.id,
            )
            await session.commit()

            first = await cancel_job(session, job.id)
            second = await cancel_job(session, job.id)
            current = await session.get(TextVideoProject, project.id)
            events = (
                await session.scalars(
                    select(ContentJobEvent).where(
                        ContentJobEvent.job_id == job.id,
                        ContentJobEvent.kind == "job_cancelled",
                    ),
                )
            ).all()

            assert first.id == second.id == job.id
            assert second.status == "cancelled"
            assert current.master_audio["status"] == "failed"
            assert current.master_audio["error"] == "任务已取消"
            assert len(events) == 1

    asyncio.new_event_loop().run_until_complete(run())


def test_cancelling_master_job_rejects_durable_ready_timeline(
    session_factory,
):
    from content_jobs import (
        InvalidJobTransition,
        cancel_job,
        create_job,
        start_step,
        succeed_step,
    )
    from models import ContentJob, TextVideoProject
    from tests.text_video_factories import (
        make_master_audio,
        make_text_video_project,
    )

    async def run():
        async with session_factory() as session:
            project = make_text_video_project(script="甲。")
            session.add(project)
            await session.flush()
            job = await create_job(
                session,
                flow="text_video_master_audio",
                title="master",
                input_data={
                    "project_id": project.id,
                    "source_hash": "c" * 64,
                },
                commit=False,
            )
            project.master_audio = make_master_audio(
                status="building",
                timeline_status="missing",
                source_hash="c" * 64,
                job_id=job.id,
            )
            await session.commit()
            assemble = await start_step(
                session,
                job.id,
                "assemble_master_audio",
            )
            await succeed_step(session, assemble.id, {"asset_id": 23})
            await start_step(session, job.id, "align_master_timeline")
            project = await session.get(TextVideoProject, project.id)
            project.master_audio = make_master_audio(
                status="ready",
                timeline_status="ready",
                asset_id=23,
                audio_url="/api/uploads/master-ready.mp3",
                source_hash="c" * 64,
                sample_rate=44100,
                sample_count=44100,
                duration=1.0,
                word_timings=[{
                    "id": "word-1",
                    "text": "甲。",
                    "start": 0.0,
                    "end": 1.0,
                    "speech_segment_id": "segment-1",
                }],
                timeline_source="provider",
                job_id=job.id,
            )
            project.render_input = {
                **project.render_input,
                "audio": "/api/uploads/master-ready.mp3",
            }
            await session.commit()
            project_id = project.id
            job_id = job.id

            with pytest.raises(
                InvalidJobTransition,
                match="cannot cancel completed master",
            ):
                await cancel_job(session, job_id)
            await session.rollback()
            current = await session.get(TextVideoProject, project_id)
            current_job = await session.get(ContentJob, job_id)

            assert current_job.status == "running"
            assert current.master_audio["timeline_status"] == "ready"
            assert current.master_audio["timeline_error"] == ""
            assert current.render_input["audio"] == (
                "/api/uploads/master-ready.mp3"
            )

    asyncio.new_event_loop().run_until_complete(run())


def test_cancelling_queued_job_marks_job_cancelled(session_factory):
    from content_jobs import cancel_job, create_job

    async def run():
        async with session_factory() as session:
            job = await create_job(session, flow="draft", title="T", input_data={})
            await cancel_job(session, job.id)
            assert job.status == "cancelled"

    asyncio.new_event_loop().run_until_complete(run())


def test_cancelling_render_job_immediately_cancels_linked_render(
    session_factory,
):
    from content_jobs import cancel_job, create_job
    from models import TalkingVideoRender

    async def run():
        async with session_factory() as session:
            render = TalkingVideoRender(
                project_id=1,
                version=1,
                status="queued",
                script_snapshot="大家好",
                digital_human_snapshot={},
                environment_asset_id=1,
            )
            session.add(render)
            await session.flush()
            job = await create_job(
                session,
                flow="digital_human_render",
                title="render",
                input_data={"render_id": render.id},
                commit=False,
            )
            render.job_id = job.id
            await session.commit()

            await cancel_job(session, job.id)
            await session.refresh(render)

            assert render.status == "cancelled"
            assert render.error == "任务已取消"
            assert render.completed_at is not None

    asyncio.new_event_loop().run_until_complete(run())


def test_cancelling_setup_job_immediately_marks_linked_role_failed(
    session_factory,
):
    from content_jobs import cancel_job, create_job
    from models import DigitalHuman

    async def run():
        async with session_factory() as session:
            role = DigitalHuman(
                name="林晓",
                status="processing",
                portrait_asset_id=1,
                voice_sample_asset_id=2,
                default_environment_asset_id=3,
            )
            session.add(role)
            await session.flush()
            job = await create_job(
                session,
                flow="digital_human_setup",
                title="setup",
                input_data={"digital_human_id": role.id},
                commit=False,
            )
            role.setup_job_id = job.id
            await session.commit()

            await cancel_job(session, job.id)
            await session.refresh(role)

            assert role.status == "failed"
            assert role.error == "任务已取消"

    asyncio.new_event_loop().run_until_complete(run())


def test_completed_step_cannot_be_started_again(session_factory):
    from content_jobs import InvalidJobTransition, create_job, start_step, succeed_step

    async def run():
        async with session_factory() as session:
            job = await create_job(session, flow="draft", title="T", input_data={})
            step = await start_step(session, job.id, "brief")
            await succeed_step(session, step.id, {"brief": "ok"})
            with pytest.raises(InvalidJobTransition):
                await start_step(session, job.id, "brief")

    asyncio.new_event_loop().run_until_complete(run())


def test_succeed_job_is_idempotent_after_response_loss(session_factory):
    from content_jobs import create_job, start_step, succeed_job

    async def run():
        async with session_factory() as session:
            job = await create_job(
                session, flow="draft", title="T", input_data={}
            )
            await start_step(session, job.id, "brief")

            first = await succeed_job(session, job.id)
            repeated = await succeed_job(session, job.id)

            assert first.status == "succeeded"
            assert repeated.status == "succeeded"
            assert repeated.id == first.id

    asyncio.new_event_loop().run_until_complete(run())


def test_succeed_step_is_idempotent_after_response_loss(session_factory):
    from content_jobs import create_job, start_step, succeed_step

    async def run():
        async with session_factory() as session:
            job = await create_job(
                session, flow="draft", title="T", input_data={}
            )
            step = await start_step(session, job.id, "brief")

            first = await succeed_step(session, step.id, {"ok": True})
            repeated = await succeed_step(session, step.id, {"ok": True})

            assert first.status == "succeeded"
            assert repeated.status == "succeeded"
            assert repeated.id == first.id

    asyncio.new_event_loop().run_until_complete(run())


def test_succeed_step_rejects_a_cancelled_job(session_factory):
    from content_jobs import (
        InvalidJobTransition,
        cancel_job,
        create_job,
        start_step,
        succeed_step,
    )

    async def run():
        async with session_factory() as session:
            job = await create_job(
                session, flow="draft", title="T", input_data={}
            )
            step = await start_step(session, job.id, "brief")
            await cancel_job(session, job.id)

            with pytest.raises(InvalidJobTransition):
                await succeed_step(session, step.id, {"ok": True})

    asyncio.new_event_loop().run_until_complete(run())


def test_cancel_rejects_terminal_digital_human_domain_state(session_factory):
    from content_jobs import InvalidJobTransition, cancel_job, create_job
    from models import DigitalHuman, TalkingVideoRender

    async def run():
        async with session_factory() as session:
            role = DigitalHuman(
                name="林晓",
                status="ready",
                portrait_asset_id=1,
                voice_sample_asset_id=2,
                default_environment_asset_id=3,
            )
            render = TalkingVideoRender(
                project_id=1,
                version=1,
                status="succeeded",
                script_snapshot="大家好",
                digital_human_snapshot={},
                environment_asset_id=1,
            )
            session.add_all([role, render])
            await session.flush()
            role_job = await create_job(
                session,
                flow="digital_human_setup",
                title="setup",
                input_data={"digital_human_id": role.id},
                commit=False,
            )
            render_job = await create_job(
                session,
                flow="digital_human_render",
                title="render",
                input_data={"render_id": render.id},
                commit=False,
            )
            role.setup_job_id = role_job.id
            render.job_id = render_job.id
            await session.commit()
            role_job_id = role_job.id
            render_job_id = render_job.id

            with pytest.raises(InvalidJobTransition):
                await cancel_job(session, role_job_id)
            await session.rollback()
            with pytest.raises(InvalidJobTransition):
                await cancel_job(session, render_job_id)

    asyncio.new_event_loop().run_until_complete(run())


def test_daily_plan_job_failure_marks_plan_failed(session_factory):
    from content_jobs import create_job, fail_step, start_step
    from models import DailyPlan

    async def run():
        async with session_factory() as session:
            plan = DailyPlan(plan_date="2099-01-01", status="planning")
            session.add(plan)
            await session.commit()
            await session.refresh(plan)
            job = await create_job(session, flow="daily_plan", title="Plan", input_data={"plan_id": plan.id})
            step = await start_step(session, job.id, "daily_plan")
            await fail_step(session, step.id, "invalid key", retryable=True)
            await session.refresh(plan)
            assert plan.status == "failed"

    asyncio.new_event_loop().run_until_complete(run())


def test_daily_creation_job_failure_marks_linked_run_failed(session_factory):
    from datetime import datetime, timezone
    from content_jobs import create_job, fail_step, start_step
    from models import DailyCreationRule, DailyCreationRun

    async def run():
        async with session_factory() as session:
            rule = DailyCreationRule(
                name="任意规则", asset_type="article", directory="任意目录",
                output_type="x_short_post", target_count=2,
                execution_mode="recurring", scheduled_time="08:00",
                timezone="Asia/Shanghai", lookback_days=3,
                delivery_mode="drafts",
            )
            session.add(rule)
            await session.flush()
            creation_run = DailyCreationRun(
                rule_id=rule.id, scheduled_for=datetime.now(timezone.utc),
                trigger_kind="explicit", requested_count=2,
                rule_snapshot={"name": rule.name},
            )
            session.add(creation_run)
            await session.flush()
            job = await create_job(
                session, flow="daily_creation", title="batch",
                input_data={"run_id": creation_run.id}, commit=False,
            )
            creation_run.content_job_id = job.id
            await session.commit()
            step = await start_step(session, job.id, "select")
            await fail_step(session, step.id, "invalid evidence", retryable=True)
            await session.refresh(creation_run)
            assert creation_run.status == "failed"
            assert creation_run.completed_at is not None

    asyncio.new_event_loop().run_until_complete(run())


def test_fail_step_redacts_secrets_before_database_persistence(session_factory):
    from content_jobs import create_job, fail_step, start_step

    async def run():
        token = "123456:secret-token"
        async with session_factory() as session:
            job = await create_job(
                session,
                flow="x_response",
                title="secret boundary",
                input_data={},
            )
            step = await start_step(session, job.id, "notify")
            failed = await fail_step(
                session,
                step.id,
                f"POST https://api.telegram.org/bot{token}/sendMessage auth_token=x-secret",
                retryable=True,
            )

            assert token not in failed.error
            assert "x-secret" not in failed.error
            assert "bot***/sendMessage" in failed.error

    asyncio.new_event_loop().run_until_complete(run())
