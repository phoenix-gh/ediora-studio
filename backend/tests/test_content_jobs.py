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

            await retry_step(session, job.id, "generate_speech")
            await session.refresh(project)
            current = await session.get(TextVideoProject, project.id)

            assert current.paragraphs[0]["status"] == "generating"
            assert current.paragraphs[0]["job_id"] == job.id
            assert current.paragraphs[0]["error"] == ""
            assert current.paragraphs[1]["status"] == "confirmed"

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
