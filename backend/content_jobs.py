"""State transitions for durable content jobs."""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from log_redaction import redact_secret_text
from models import (
    ContentAnalysisRun,
    ContentJob,
    ContentJobEvent,
    ContentJobStep,
    ContentResponseEvent,
    ContentResponseItem,
    DailyPlan,
    DigitalHuman,
    TalkingVideoRender,
    TextVideoProject,
)
from text_video_domain import empty_scene_plan


class InvalidJobTransition(ValueError):
    pass


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def lock_content_job_row(
    session: AsyncSession,
    job_id: int,
) -> ContentJob | None:
    """Serialize job transitions on databases where FOR UPDATE is ignored."""
    await session.execute(
        update(ContentJob)
        .where(ContentJob.id == job_id)
        .values(status=ContentJob.status)
    )
    return await session.scalar(
        select(ContentJob)
        .where(ContentJob.id == job_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )


async def _event(session: AsyncSession, job_id: int, kind: str, *, step_id: int | None = None, payload: dict | None = None) -> None:
    session.add(ContentJobEvent(job_id=job_id, step_id=step_id, kind=kind, payload=payload or {}))


async def add_locked_job_event(
    session: AsyncSession,
    job_id: int,
    kind: str,
    *,
    step_id: int | None = None,
    payload: dict | None = None,
) -> None:
    """Append an event inside a caller-owned job-row transaction."""
    await _event(
        session,
        job_id,
        kind,
        step_id=step_id,
        payload=payload,
    )


async def record_event(session: AsyncSession, job_id: int, kind: str, payload: dict | None = None) -> ContentJobEvent:
    job = await session.get(ContentJob, job_id)
    if job is None:
        raise KeyError(f"job {job_id} not found")
    event = ContentJobEvent(job_id=job_id, kind=kind, payload=payload or {})
    session.add(event)
    await session.commit()
    await session.refresh(event)
    return event


async def create_job(
    session: AsyncSession,
    *,
    flow: str,
    title: str,
    input_data: dict,
    idempotency_key: str = "",
    commit: bool = True,
) -> ContentJob:
    job = ContentJob(flow=flow, title=title, input_data=input_data, idempotency_key=idempotency_key)
    session.add(job)
    await session.flush()
    await _event(session, job.id, "job_queued")
    if commit:
        await session.commit()
        await session.refresh(job)
    else:
        await session.flush()
    return job


async def create_or_get_job(
    session: AsyncSession,
    *,
    flow: str,
    title: str,
    input_data: dict,
    idempotency_key: str = "",
    commit: bool = True,
) -> ContentJob:
    """Create a durable job or return the winner of the same non-empty key."""
    if not idempotency_key:
        return await create_job(
            session,
            flow=flow,
            title=title,
            input_data=input_data,
            commit=commit,
        )
    existing = await session.scalar(
        select(ContentJob).where(
            ContentJob.idempotency_key == idempotency_key,
        )
    )
    if existing is not None:
        return existing
    try:
        async with session.begin_nested():
            job = await create_job(
                session,
                flow=flow,
                title=title,
                input_data=input_data,
                idempotency_key=idempotency_key,
                commit=False,
            )
    except IntegrityError:
        winner = await session.scalar(
            select(ContentJob).where(
                ContentJob.idempotency_key == idempotency_key,
            )
        )
        if winner is None:
            raise
        return winner
    if commit:
        await session.commit()
        await session.refresh(job)
    return job


async def _restore_current_speech_segment(
    session: AsyncSession,
    job: ContentJob,
) -> None:
    if job.flow != "text_video_speech":
        return
    project_id = job.input_data.get("project_id")
    segment_id = job.input_data.get("segment_id")
    if not isinstance(project_id, int) or not isinstance(segment_id, str):
        return
    project = await session.scalar(
        select(TextVideoProject)
        .where(TextVideoProject.id == project_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if project is None:
        return
    paragraphs = list(project.paragraphs or [])
    changed = False
    for index, segment in enumerate(paragraphs):
        if (
            segment.get("id") == segment_id
            and (
                segment.get("job_id") == job.id
                or (
                    segment.get("job_id") is None
                    and segment.get("status") == "failed"
                )
            )
            and segment.get("generation_revision")
            == job.input_data.get("generation_revision")
            and segment.get("source_hash")
            == job.input_data.get("source_hash")
        ):
            paragraphs[index] = {
                **segment,
                "status": "generating",
                "job_id": job.id,
                "error": "",
            }
            changed = True
            break
    if changed:
        project.paragraphs = paragraphs


async def _cancel_current_speech_segment(
    session: AsyncSession,
    job: ContentJob,
) -> None:
    if job.flow != "text_video_speech":
        return
    project_id = job.input_data.get("project_id")
    segment_id = job.input_data.get("segment_id")
    if not isinstance(project_id, int) or not isinstance(segment_id, str):
        return
    project = await session.scalar(
        select(TextVideoProject)
        .where(TextVideoProject.id == project_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if project is None:
        return
    paragraphs = list(project.paragraphs or [])
    for index, segment in enumerate(paragraphs):
        if (
            segment.get("id") == segment_id
            and segment.get("job_id") == job.id
            and segment.get("generation_revision")
            == job.input_data.get("generation_revision")
            and segment.get("source_hash")
            == job.input_data.get("source_hash")
        ):
            paragraphs[index] = {
                **segment,
                "status": "failed",
                "job_id": None,
                "error": "任务已取消",
            }
            project.paragraphs = paragraphs
            return


async def _cancel_current_master_audio(
    session: AsyncSession,
    job: ContentJob,
) -> None:
    if job.flow != "text_video_master_audio":
        return
    project_id = job.input_data.get("project_id")
    source_hash = job.input_data.get("source_hash")
    if not isinstance(project_id, int) or not isinstance(source_hash, str):
        return
    project = await session.scalar(
        select(TextVideoProject)
        .where(TextVideoProject.id == project_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if project is None:
        return
    master = dict(project.master_audio or {})
    if (
        master.get("job_id") != job.id
        or master.get("source_hash") != source_hash
    ):
        return
    if master.get("status") != "ready":
        master["status"] = "failed"
        master["error"] = "任务已取消"
    else:
        master["timeline_status"] = "failed"
        master["timeline_error"] = "任务已取消"
    project.master_audio = master
    render_input = dict(project.render_input or {})
    render_input["audio"] = ""
    project.render_input = render_input


async def _cancel_current_scene_plan(
    session: AsyncSession,
    job: ContentJob,
) -> None:
    if job.flow != "text_video_scene_plan":
        return
    project_id = job.input_data.get("project_id")
    generation_revision = job.input_data.get(
        "scene_generation_revision",
    )
    if (
        not isinstance(project_id, int)
        or not isinstance(generation_revision, int)
        or isinstance(generation_revision, bool)
    ):
        return
    project = await session.scalar(
        select(TextVideoProject)
        .where(TextVideoProject.id == project_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if project is None:
        return
    plan = empty_scene_plan() | dict(project.scene_plan or {})
    if (
        plan.get("job_id") != job.id
        or plan.get("status") not in {"generating", "failed"}
        or plan.get("generation_revision") != generation_revision
    ):
        return
    plan.update({
        "status": "failed",
        "generation_revision": generation_revision + 1,
        "job_id": None,
        "error": "任务已取消",
    })
    project.scene_plan = plan


async def _restore_current_master_audio(
    session: AsyncSession,
    job: ContentJob,
    step_key: str,
) -> None:
    if job.flow != "text_video_master_audio":
        return
    project_id = job.input_data.get("project_id")
    source_hash = job.input_data.get("source_hash")
    if not isinstance(project_id, int) or not isinstance(source_hash, str):
        return
    project = await session.scalar(
        select(TextVideoProject)
        .where(TextVideoProject.id == project_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if project is None:
        return
    master = dict(project.master_audio or {})
    if (
        master.get("job_id") != job.id
        or master.get("source_hash") != source_hash
    ):
        return
    if step_key == "assemble_master_audio":
        master["error"] = ""
        master["timeline_error"] = ""
        if master.get("status") != "ready":
            master["status"] = "building"
            master["timeline_status"] = "missing"
        project.master_audio = master
        if master.get("timeline_status") != "ready":
            render_input = dict(project.render_input or {})
            render_input["audio"] = ""
            project.render_input = render_input
    elif (
        step_key == "align_master_timeline"
        and master.get("status") == "ready"
        and master.get("timeline_status") != "ready"
    ):
        master["timeline_status"] = "aligning"
        master["error"] = ""
        master["timeline_error"] = ""
        project.master_audio = master
        render_input = dict(project.render_input or {})
        render_input["audio"] = ""
        project.render_input = render_input


async def _restore_current_scene_plan(
    session: AsyncSession,
    job: ContentJob,
    step_key: str,
) -> None:
    if (
        job.flow != "text_video_scene_plan"
        or step_key != "generate_scene_plan"
    ):
        return
    project_id = job.input_data.get("project_id")
    generation_revision = job.input_data.get(
        "scene_generation_revision",
    )
    existing_scenes = job.input_data.get("existing_scenes")
    if (
        not isinstance(project_id, int)
        or not isinstance(generation_revision, int)
        or isinstance(generation_revision, bool)
        or not isinstance(existing_scenes, list)
    ):
        return
    project = await session.scalar(
        select(TextVideoProject)
        .where(TextVideoProject.id == project_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if project is None:
        return
    plan = empty_scene_plan() | dict(project.scene_plan or {})
    if (
        plan.get("status") != "failed"
        or plan.get("job_id") != job.id
        or plan.get("generation_revision") != generation_revision
        or plan.get("scenes") != existing_scenes
    ):
        return
    plan.update({
        "status": "generating",
        "job_id": job.id,
        "error": "",
    })
    project.scene_plan = plan


async def _latest_step(session: AsyncSession, job_id: int, step_key: str) -> ContentJobStep | None:
    result = await session.execute(
        select(ContentJobStep)
        .where(ContentJobStep.job_id == job_id, ContentJobStep.step_key == step_key)
        .order_by(ContentJobStep.attempt.desc())
    )
    return result.scalars().first()


async def _analysis_for_job(
    session: AsyncSession,
    job: ContentJob,
) -> tuple[ContentAnalysisRun | None, ContentResponseItem | None]:
    if job.flow != "content_response_analysis":
        return None, None
    analysis = (await session.execute(
        select(ContentAnalysisRun).where(ContentAnalysisRun.job_id == job.id)
    )).scalar_one_or_none()
    if analysis is None:
        return None, None
    return analysis, await session.get(
        ContentResponseItem,
        analysis.response_item_id,
    )


async def start_step(session: AsyncSession, job_id: int, step_key: str) -> ContentJobStep:
    job = await lock_content_job_row(session, job_id)
    if job is None:
        raise KeyError(f"job {job_id} not found")
    if job.status in {"cancelled", "succeeded"}:
        raise InvalidJobTransition(f"cannot start a step for {job.status} job")
    step = await _latest_step(session, job_id, step_key)
    if step is None:
        step = ContentJobStep(job_id=job_id, step_key=step_key)
        session.add(step)
        await session.flush()
    if step.status != "queued":
        raise InvalidJobTransition(f"cannot start {step.status} step")
    now = _now()
    step.status = "running"
    step.started_at = now
    job.status = "running"
    job.started_at = job.started_at or now
    analysis, item = await _analysis_for_job(session, job)
    if analysis is not None:
        analysis.status = "running"
    if item is not None:
        item.workflow_status = "processing"
    await _event(session, job_id, "step_started", step_id=step.id, payload={"step_key": step_key, "attempt": step.attempt})
    await session.commit()
    await session.refresh(step)
    return step


async def succeed_step(session: AsyncSession, step_id: int, output_data: dict) -> ContentJobStep:
    job_id = await session.scalar(
        select(ContentJobStep.job_id).where(ContentJobStep.id == step_id)
    )
    if job_id is None:
        raise KeyError(f"step {step_id} not found")
    job = await lock_content_job_row(session, job_id)
    if job is None:
        raise KeyError(f"job {job_id} not found")
    step = await session.scalar(
        select(ContentJobStep)
        .where(ContentJobStep.id == step_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if step is None:
        raise KeyError(f"step {step_id} not found")
    await succeed_locked_step(session, job, step, output_data)
    await session.commit()
    await session.refresh(step)
    return step


async def succeed_locked_step(
    session: AsyncSession,
    job: ContentJob,
    step: ContentJobStep,
    output_data: dict,
) -> ContentJobStep:
    """Mark a locked running step succeeded without committing."""
    if step.status == "succeeded":
        return step
    if step.status != "running":
        raise InvalidJobTransition(f"cannot succeed {step.status} step")
    if job.status == "cancelled":
        raise InvalidJobTransition("cannot succeed a step for cancelled job")
    step.status = "succeeded"
    step.output_data = output_data
    step.completed_at = _now()
    await _event(session, step.job_id, "step_succeeded", step_id=step.id, payload={"step_key": step.step_key, "attempt": step.attempt})
    await session.flush()
    return step


async def fail_step(session: AsyncSession, step_id: int, error: str, *, retryable: bool) -> ContentJobStep:
    job_id = await session.scalar(
        select(ContentJobStep.job_id).where(ContentJobStep.id == step_id)
    )
    if job_id is None:
        raise KeyError(f"step {step_id} not found")
    job = await lock_content_job_row(session, job_id)
    if job is None:
        raise KeyError(f"job {job_id} not found")
    step = await session.scalar(
        select(ContentJobStep)
        .where(ContentJobStep.id == step_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if step is None:
        raise KeyError(f"step {step_id} not found")
    await fail_locked_step(
        session,
        job,
        step,
        error,
        retryable=retryable,
    )
    await session.commit()
    await session.refresh(step)
    return step


async def fail_locked_step(
    session: AsyncSession,
    job: ContentJob,
    step: ContentJobStep,
    error: str,
    *,
    retryable: bool,
) -> ContentJobStep:
    """Fail a locked running step and its job without committing."""
    if step.status != "running":
        raise InvalidJobTransition(f"cannot fail {step.status} step")
    if job.status == "cancelled":
        raise InvalidJobTransition("cannot fail a step for cancelled job")
    step.status = "failed"
    step.error = redact_secret_text(error)[:500]
    step.retryable = retryable
    step.completed_at = _now()
    job.status = "failed"
    job.completed_at = step.completed_at
    if job.flow == "daily_plan":
        plan_id = job.input_data.get("plan_id")
        if isinstance(plan_id, int):
            plan = await session.get(DailyPlan, plan_id)
            if plan is not None and plan.status == "planning":
                plan.status = "failed"
    analysis, item = await _analysis_for_job(session, job)
    if analysis is not None:
        analysis.status = "failed"
        analysis.error_code = step.step_key
        analysis.error = step.error
        analysis.completed_at = step.completed_at
    if item is not None:
        item.workflow_status = "failed"
        session.add(ContentResponseEvent(
            response_item_id=item.id,
            analysis_run_id=analysis.id if analysis is not None else None,
            event_type="analysis_failed",
            payload={
                "step_key": step.step_key,
                "retryable": retryable,
                "error": step.error,
            },
        ))
    await _event(session, step.job_id, "step_failed", step_id=step.id, payload={"step_key": step.step_key, "retryable": retryable})
    await session.flush()
    return step


async def retry_step(session: AsyncSession, job_id: int, step_key: str) -> ContentJobStep:
    job = await lock_content_job_row(session, job_id)
    if job is None:
        raise KeyError(f"job {job_id} not found")
    previous = await _latest_step(session, job_id, step_key)
    if (
        job.status == "queued"
        and previous is not None
        and previous.status == "queued"
    ):
        await session.commit()
        return previous
    if job.status != "failed":
        raise InvalidJobTransition("only a failed job can be retried")
    if previous is None or previous.status != "failed" or not previous.retryable:
        raise InvalidJobTransition("only a retryable failed step can be retried")
    step = await retry_locked_step(session, job, previous)
    await session.commit()
    await session.refresh(step)
    return step


async def retry_locked_step(
    session: AsyncSession,
    job: ContentJob,
    previous: ContentJobStep,
) -> ContentJobStep:
    """Queue a new attempt for a locked retryable failure without committing."""
    if job.status != "failed":
        raise InvalidJobTransition("only a failed job can be retried")
    if previous.status != "failed" or not previous.retryable:
        raise InvalidJobTransition("only a retryable failed step can be retried")
    step_key = previous.step_key
    step = ContentJobStep(
        job_id=job.id,
        step_key=step_key,
        attempt=previous.attempt + 1,
    )
    session.add(step)
    job.status = "queued"
    job.completed_at = None
    analysis, item = await _analysis_for_job(session, job)
    if analysis is not None:
        analysis.status = "queued"
        analysis.error_code = ""
        analysis.error = ""
        analysis.completed_at = None
    if item is not None:
        item.workflow_status = "queued"
        session.add(ContentResponseEvent(
            response_item_id=item.id,
            analysis_run_id=analysis.id if analysis is not None else None,
            event_type="analysis_retried",
            payload={"step_key": step_key, "attempt": step.attempt},
        ))
    await _restore_current_speech_segment(session, job)
    await _restore_current_master_audio(session, job, step_key)
    await _restore_current_scene_plan(session, job, step_key)
    await session.flush()
    await _event(session, job.id, "step_retried", step_id=step.id, payload={"step_key": step_key, "attempt": step.attempt})
    await session.flush()
    return step


async def cancel_job(session: AsyncSession, job_id: int) -> ContentJob:
    job = await lock_content_job_row(session, job_id)
    if job is None:
        raise KeyError(f"job {job_id} not found")
    if (
        job.status == "cancelled"
        and job.flow == "text_video_master_audio"
    ):
        await session.commit()
        return job
    if job.status in {"succeeded", "cancelled"}:
        raise InvalidJobTransition(f"cannot cancel {job.status} job")
    if job.flow == "digital_human_render":
        render_id = job.input_data.get("render_id")
        if isinstance(render_id, int):
            render = await session.scalar(
                select(TalkingVideoRender)
                .where(TalkingVideoRender.id == render_id)
                .with_for_update()
            )
            if (
                render is not None
                and render.job_id == job.id
                and render.status == "succeeded"
            ):
                raise InvalidJobTransition("cannot cancel completed render")
    elif job.flow == "digital_human_setup":
        role_id = job.input_data.get("digital_human_id")
        if isinstance(role_id, int):
            role = await session.scalar(
                select(DigitalHuman)
                .where(DigitalHuman.id == role_id)
                .with_for_update()
            )
            if (
                role is not None
                and role.setup_job_id == job.id
                and role.status == "ready"
            ):
                raise InvalidJobTransition("cannot cancel ready digital human")
    elif job.flow == "text_video_master_audio":
        project_id = job.input_data.get("project_id")
        source_hash = job.input_data.get("source_hash")
        if isinstance(project_id, int) and isinstance(source_hash, str):
            project = await session.scalar(
                select(TextVideoProject)
                .where(TextVideoProject.id == project_id)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
            master = dict(project.master_audio or {}) if project else {}
            if (
                master.get("job_id") == job.id
                and master.get("source_hash") == source_hash
                and master.get("status") == "ready"
                and master.get("timeline_status") == "ready"
            ):
                raise InvalidJobTransition(
                    "cannot cancel completed master",
                )
    elif job.flow == "text_video_scene_plan":
        project_id = job.input_data.get("project_id")
        if isinstance(project_id, int):
            project = await session.scalar(
                select(TextVideoProject)
                .where(TextVideoProject.id == project_id)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
            plan = (
                empty_scene_plan() | dict(project.scene_plan or {})
                if project is not None
                else empty_scene_plan()
            )
            if (
                plan.get("status") == "ready"
                and plan.get("applied_job_id") == job.id
            ):
                raise InvalidJobTransition(
                    "cannot cancel completed scene plan",
                )
    job.status = "cancelled"
    job.completed_at = _now()
    if job.flow == "digital_human_render":
        render_id = job.input_data.get("render_id")
        if isinstance(render_id, int):
            render = await session.scalar(
                select(TalkingVideoRender)
                .where(TalkingVideoRender.id == render_id)
                .with_for_update()
            )
            if (
                render is not None
                and render.job_id == job.id
                and render.status in {"queued", "running"}
            ):
                render.status = "cancelled"
                render.error = "任务已取消"
                render.completed_at = job.completed_at
    elif job.flow == "digital_human_setup":
        role_id = job.input_data.get("digital_human_id")
        if isinstance(role_id, int):
            role = await session.scalar(
                select(DigitalHuman)
                .where(DigitalHuman.id == role_id)
                .with_for_update()
            )
            if (
                role is not None
                and role.setup_job_id == job.id
                and role.status == "processing"
            ):
                role.status = "failed"
                role.error = "任务已取消"
    elif job.flow == "text_video_speech":
        await _cancel_current_speech_segment(session, job)
    elif job.flow == "text_video_master_audio":
        await _cancel_current_master_audio(session, job)
    elif job.flow == "text_video_scene_plan":
        await _cancel_current_scene_plan(session, job)
    await _event(session, job_id, "job_cancelled")
    await session.commit()
    await session.refresh(job)
    return job


async def succeed_job(session: AsyncSession, job_id: int) -> ContentJob:
    job = await lock_content_job_row(session, job_id)
    if job is None:
        raise KeyError(f"job {job_id} not found")
    if job.status == "succeeded":
        await session.commit()
        return job
    if job.status != "running":
        raise InvalidJobTransition(f"cannot succeed {job.status} job")
    job.status = "succeeded"
    job.completed_at = _now()
    await _event(session, job_id, "job_succeeded")
    await session.commit()
    await session.refresh(job)
    return job
