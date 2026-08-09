"""Reconcile durable content jobs after worker interruption.

PostgreSQL job rows are authoritative. Redis only transports job IDs, and
the worker/reconciler shared lease prevents paid work from racing recovery.
"""

from __future__ import annotations

import asyncio
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone
import os
from typing import Any
from uuid import uuid4

from loguru import logger
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from content_jobs import (
    add_locked_job_event,
    fail_locked_step,
    lock_content_job_row,
    retry_locked_step,
    succeed_locked_step,
)
from database import SessionLocal
from job_queue import RedisJobQueue
from log_redaction import redact_secret_text
from models import (
    ContentJob,
    ContentJobStep,
    DigitalHuman,
    TalkingVideoRender,
    TextVideoProject,
)
from text_video_jobs import recoverable_speech_asset_result
from text_video_master import (
    recoverable_master_alignment_project,
    recoverable_master_assembly_result,
)
from topic_source_service import is_valid_topic_source_payload


INTERRUPTION_ERROR = (
    "后台 worker 在结果确认前停止；该步骤已中断。"
    "手动重试可能再次计费。"
)
DEFAULT_RECONCILIATION_INTERVAL_SECONDS = 30.0
DEFAULT_RECONCILIATION_LEASE_TTL_MS = 30_000
RECONCILABLE_STATUSES = {"queued", "running", "failed"}
TERMINAL_STATUSES = {"succeeded", "cancelled"}


@dataclass(frozen=True)
class _Decision:
    enqueue: bool = False
    reason: str = ""


class _LeaseLost(RuntimeError):
    pass


def _positive_interval(raw: str | None) -> float:
    try:
        interval = float(
            raw
            if raw is not None
            else DEFAULT_RECONCILIATION_INTERVAL_SECONDS,
        )
    except (TypeError, ValueError):
        return DEFAULT_RECONCILIATION_INTERVAL_SECONDS
    return (
        interval
        if interval > 0
        else DEFAULT_RECONCILIATION_INTERVAL_SECONDS
    )


async def _latest_step_locked(
    db: AsyncSession,
    job_id: int,
) -> ContentJobStep | None:
    return await db.scalar(
        select(ContentJobStep)
        .where(ContentJobStep.job_id == job_id)
        .order_by(
            ContentJobStep.created_at.desc(),
            ContentJobStep.id.desc(),
        )
        .limit(1)
        .with_for_update()
        .execution_options(populate_existing=True),
    )


async def _project_locked(
    db: AsyncSession,
    project_id: Any,
) -> TextVideoProject | None:
    if (
        isinstance(project_id, bool)
        or not isinstance(project_id, int)
        or project_id <= 0
    ):
        return None
    return await db.scalar(
        select(TextVideoProject)
        .where(TextVideoProject.id == project_id)
        .with_for_update()
        .execution_options(populate_existing=True),
    )


def _exact_applied_scene_result(
    project: TextVideoProject,
    job: ContentJob,
) -> bool:
    snapshot = job.input_data if isinstance(job.input_data, dict) else {}
    plan = project.scene_plan if isinstance(project.scene_plan, dict) else {}
    master = (
        project.master_audio
        if isinstance(project.master_audio, dict)
        else {}
    )
    generation = snapshot.get("scene_generation_revision")
    return bool(
        snapshot.get("project_id") == project.id
        and isinstance(generation, int)
        and not isinstance(generation, bool)
        and plan.get("status") == "ready"
        and plan.get("job_id") is None
        and plan.get("applied_job_id") == job.id
        and plan.get("generation_revision") == generation + 1
        and plan.get("master_source_hash")
        == snapshot.get("master_source_hash")
        and master.get("source_hash")
        == snapshot.get("master_source_hash")
    )


def _serialized_project(project: TextVideoProject) -> dict:
    # Import lazily so the job router can import this module without creating a
    # routers.jobs -> reconciliation -> routers.text_videos import cycle.
    from routers.text_videos import serialize_project

    return serialize_project(project)


async def _recover_running_result(
    db: AsyncSession,
    job: ContentJob,
    step: ContentJobStep,
    ensure_fence,
) -> _Decision | None:
    project = await _project_locked(
        db,
        (job.input_data or {}).get("project_id"),
    )
    output: dict | None = None
    action = ""
    if (
        job.flow == "text_video_speech"
        and step.step_key == "generate_speech"
        and project is not None
    ):
        output = await recoverable_speech_asset_result(db, project, job)
        action = "speech_result_recovered"
    elif (
        job.flow == "text_video_scene_plan"
        and step.step_key == "generate_scene_plan"
        and project is not None
        and _exact_applied_scene_result(project, job)
    ):
        output = {"project": _serialized_project(project)}
        action = "scene_result_recovered"
    elif (
        job.flow == "text_video_master_audio"
        and step.step_key == "assemble_master_audio"
        and project is not None
    ):
        output = await recoverable_master_assembly_result(db, project, job)
        action = "master_assembly_result_recovered"
    elif (
        job.flow == "text_video_master_audio"
        and step.step_key == "align_master_timeline"
        and project is not None
    ):
        aligned = await recoverable_master_alignment_project(
            db,
            project,
            job,
            step,
        )
        if aligned is not None:
            output = _serialized_project(aligned)
        action = "master_alignment_result_recovered"
    if output is None:
        return None
    await ensure_fence()
    await succeed_locked_step(db, job, step, output)
    await add_locked_job_event(
        db,
        job.id,
        "job_reconciled",
        step_id=step.id,
        payload={
            "action": action,
            "step_key": step.step_key,
            "attempt": step.attempt,
        },
    )
    await db.commit()
    return _Decision(enqueue=True, reason=action)


def _is_unsafe_interrupted_step(
    job: ContentJob,
    step: ContentJobStep,
) -> bool:
    return bool(
        (
            job.flow == "text_video_split_preview"
            and step.step_key == "propose_boundaries"
        )
        or (
            job.flow == "text_video_speech"
            and step.step_key == "generate_speech"
        )
        or (
            job.flow == "text_video_scene_plan"
            and step.step_key == "generate_scene_plan"
        )
        or (
            job.flow == "text_video_master_audio"
            and step.step_key == "align_master_timeline"
        )
    )


def _fail_speech_domain(
    project: TextVideoProject,
    job: ContentJob,
) -> None:
    snapshot = job.input_data or {}
    paragraphs = deepcopy(project.paragraphs or [])
    for index, segment in enumerate(paragraphs):
        if (
            isinstance(segment, dict)
            and segment.get("id") == snapshot.get("segment_id")
            and segment.get("job_id") in {job.id, None}
            and segment.get("generation_revision")
            == snapshot.get("generation_revision")
            and segment.get("source_hash") == snapshot.get("source_hash")
        ):
            paragraphs[index] = {
                **segment,
                "status": "failed",
                "job_id": None,
                "error": INTERRUPTION_ERROR,
            }
            project.paragraphs = paragraphs
            return


def _fail_scene_domain(
    project: TextVideoProject,
    job: ContentJob,
) -> None:
    snapshot = job.input_data or {}
    plan = deepcopy(project.scene_plan or {})
    if (
        plan.get("status") == "generating"
        and plan.get("job_id") == job.id
        and plan.get("generation_revision")
        == snapshot.get("scene_generation_revision")
        and plan.get("scenes") == snapshot.get("existing_scenes")
    ):
        motion_mode = snapshot.get("generation_mode") == "motion"
        plan["status"] = "ready" if motion_mode else "failed"
        if motion_mode:
            plan["job_id"] = None
        plan["error"] = INTERRUPTION_ERROR
        project.scene_plan = plan


def _fail_alignment_domain(
    project: TextVideoProject,
    job: ContentJob,
) -> None:
    snapshot = job.input_data or {}
    master = deepcopy(project.master_audio or {})
    if (
        master.get("job_id") != job.id
        or master.get("source_hash") != snapshot.get("source_hash")
        or int(master.get("repair_generation") or 0)
        != int(snapshot.get("repair_generation") or 0)
    ):
        return
    if master.get("status") == "ready":
        master["timeline_status"] = "failed"
        master["timeline_error"] = INTERRUPTION_ERROR
        master["timeline_retryable"] = True
    else:
        master["status"] = "failed"
        master["error"] = INTERRUPTION_ERROR
    project.master_audio = master
    render_input = deepcopy(project.render_input or {})
    render_input["audio"] = ""
    project.render_input = render_input


async def _fail_unsafe_interruption(
    db: AsyncSession,
    job: ContentJob,
    step: ContentJobStep,
    ensure_fence,
) -> _Decision:
    await ensure_fence()
    await fail_locked_step(
        db,
        job,
        step,
        INTERRUPTION_ERROR,
        retryable=True,
    )
    project = await _project_locked(
        db,
        (job.input_data or {}).get("project_id"),
    )
    if project is not None:
        if job.flow == "text_video_speech":
            _fail_speech_domain(project, job)
        elif job.flow == "text_video_scene_plan":
            _fail_scene_domain(project, job)
        elif job.flow == "text_video_master_audio":
            _fail_alignment_domain(project, job)
    await add_locked_job_event(
        db,
        job.id,
        "job_reconciled",
        step_id=step.id,
        payload={
            "action": "interrupted_before_result_confirmation",
            "step_key": step.step_key,
            "attempt": step.attempt,
            "retryable": True,
        },
    )
    await db.commit()
    return _Decision()


async def _recover_failed_assembly(
    db: AsyncSession,
    job: ContentJob,
    step: ContentJobStep,
    ensure_fence,
) -> _Decision | None:
    if (
        job.flow != "text_video_master_audio"
        or step.step_key != "assemble_master_audio"
        or step.status != "failed"
        or not step.retryable
    ):
        return None
    project = await _project_locked(
        db,
        (job.input_data or {}).get("project_id"),
    )
    if project is None:
        return None
    output = await recoverable_master_assembly_result(db, project, job)
    if output is None:
        return None
    await ensure_fence()
    retried = await retry_locked_step(db, job, step)
    await add_locked_job_event(
        db,
        job.id,
        "job_reconciled",
        step_id=retried.id,
        payload={
            "action": "master_assembly_ack_loss_retried",
            "step_key": retried.step_key,
            "attempt": retried.attempt,
        },
    )
    await db.commit()
    return _Decision(
        enqueue=True,
        reason="master_assembly_ack_loss_retried",
    )


async def _superseded_digital_human_job(
    db: AsyncSession,
    job: ContentJob,
) -> bool:
    input_data = job.input_data if isinstance(job.input_data, dict) else {}
    if job.flow == "digital_human_setup":
        role_id = input_data.get("digital_human_id")
        if not isinstance(role_id, int):
            return False
        role = await db.get(DigitalHuman, role_id)
        return role is None or role.setup_job_id != job.id
    if job.flow == "digital_human_render":
        render_id = input_data.get("render_id")
        if not isinstance(render_id, int):
            return False
        render = await db.get(TalkingVideoRender, render_id)
        return render is None or render.job_id != job.id
    return False


def _valid_topic_source_payload(job: ContentJob) -> bool:
    return is_valid_topic_source_payload(job.input_data)


async def _cancel_invalid_topic_source_job(
    db: AsyncSession,
    job: ContentJob,
    ensure_fence,
) -> _Decision:
    await ensure_fence()
    job.status = "cancelled"
    job.completed_at = datetime.now(timezone.utc)
    await add_locked_job_event(
        db,
        job.id,
        "job_reconciled",
        payload={"action": "invalid_topic_source_payload_cancelled"},
    )
    await db.commit()
    return _Decision()


async def _cancel_superseded_job(
    db: AsyncSession,
    job: ContentJob,
    ensure_fence,
) -> _Decision:
    await ensure_fence()
    job.status = "cancelled"
    job.completed_at = datetime.now(timezone.utc)
    await add_locked_job_event(
        db,
        job.id,
        "job_reconciled",
        payload={"action": "superseded_cancelled"},
    )
    await db.commit()
    return _Decision()


async def _decide_locked(
    db: AsyncSession,
    job: ContentJob,
    ensure_fence,
) -> _Decision:
    if job.status in TERMINAL_STATUSES:
        return _Decision()
    if await _superseded_digital_human_job(db, job):
        return await _cancel_superseded_job(
            db,
            job,
            ensure_fence,
        )
    if (
        job.flow == "topic_source"
        and job.status == "queued"
        and not _valid_topic_source_payload(job)
    ):
        return await _cancel_invalid_topic_source_job(
            db,
            job,
            ensure_fence,
        )
    step = await _latest_step_locked(db, job.id)
    if (
        job.flow == "daily_creation"
        and job.status in {"queued", "running"}
    ):
        return _Decision(enqueue=True, reason="agent_runtime_resume")
    if (
        job.status == "queued"
        and (step is None or step.status == "queued")
    ):
        return _Decision(enqueue=True, reason="queued_without_started_step")
    if (
        job.status == "running"
        and step is not None
        and step.status == "succeeded"
    ):
        return _Decision(enqueue=True, reason="latest_step_succeeded")
    if job.status == "failed" and step is not None:
        recovered = await _recover_failed_assembly(
            db,
            job,
            step,
            ensure_fence,
        )
        return recovered or _Decision()
    if (
        job.status != "running"
        or step is None
        or step.status != "running"
    ):
        return _Decision()

    recovered = await _recover_running_result(
        db,
        job,
        step,
        ensure_fence,
    )
    if recovered is not None:
        return recovered
    if (
        job.flow == "text_video_master_audio"
        and step.step_key == "assemble_master_audio"
    ):
        return _Decision(
            enqueue=True,
            reason="safe_local_master_assembly",
        )
    if _is_unsafe_interrupted_step(job, step):
        return await _fail_unsafe_interruption(
            db,
            job,
            step,
            ensure_fence,
        )
    return _Decision()


async def _record_enqueue_event(
    session_factory: async_sessionmaker,
    job_id: int,
    reason: str,
) -> None:
    async with session_factory() as db:
        job = await lock_content_job_row(db, job_id)
        if job is None:
            await db.rollback()
            return
        await add_locked_job_event(
            db,
            job_id,
            "job_reconciled",
            payload={"action": "enqueued", "reason": reason},
        )
        await db.commit()


async def _reconcile_one(
    queue: Any,
    session_factory: async_sessionmaker,
    job_id: int,
    *,
    lease_ttl_ms: int,
) -> bool:
    owner = f"reconciler:{uuid4().hex}"
    if not await queue.try_acquire_lease(
        job_id,
        owner,
        ttl_ms=lease_ttl_ms,
    ):
        return False
    decision = _Decision()
    released = False
    async def ensure_fence() -> None:
        if not await queue.refresh_lease(
            job_id,
            owner,
            ttl_ms=lease_ttl_ms,
        ):
            raise _LeaseLost(
                f"content job {job_id} reconciliation lease was lost",
            )
    try:
        async with session_factory() as db:
            job = await lock_content_job_row(db, job_id)
            if job is None:
                await db.rollback()
                return False
            decision = await _decide_locked(
                db,
                job,
                ensure_fence,
            )
            if db.in_transaction():
                await db.rollback()
    except _LeaseLost:
        pass
    except Exception as error:
        logger.error(
            "Content job {} reconciliation failed: {}",
            job_id,
            redact_secret_text(str(error))[:500],
        )
    finally:
        try:
            released = await queue.release_lease(job_id, owner)
        except Exception as error:
            logger.error(
                "Content job {} reconciliation lease release failed: {}",
                job_id,
                redact_secret_text(str(error))[:500],
            )
    if not decision.enqueue or not released:
        return False
    try:
        inserted = await queue.enqueue_once(job_id)
    except Exception as error:
        logger.error(
            "Content job {} reconciliation enqueue failed: {}",
            job_id,
            redact_secret_text(str(error))[:500],
        )
        return False
    if not inserted:
        return False
    try:
        await _record_enqueue_event(
            session_factory,
            job_id,
            decision.reason,
        )
    except Exception as error:
        logger.error(
            "Content job {} enqueue audit failed: {}",
            job_id,
            redact_secret_text(str(error))[:500],
        )
    return True


async def reconcile_content_jobs(
    queue: Any,
    *,
    session_factory: async_sessionmaker = SessionLocal,
    lease_ttl_ms: int = DEFAULT_RECONCILIATION_LEASE_TTL_MS,
) -> dict:
    """Run one independent reconciliation pass for the configured queue."""
    async with session_factory() as db:
        job_ids = list(
            await db.scalars(
                select(ContentJob.id)
                .where(ContentJob.status.in_(RECONCILABLE_STATUSES))
                .order_by(ContentJob.id),
            ),
        )
        await db.rollback()
    enqueued: list[int] = []
    for job_id in job_ids:
        if await _reconcile_one(
            queue,
            session_factory,
            job_id,
            lease_ttl_ms=lease_ttl_ms,
        ):
            enqueued.append(job_id)
    return {"enqueued": len(enqueued), "job_ids": enqueued}


class JobReconciler:
    """Own the Redis client and periodic pass for one API process."""

    def __init__(
        self,
        *,
        queue: RedisJobQueue | None = None,
        session_factory: async_sessionmaker = SessionLocal,
        interval_seconds: float | None = None,
        lease_ttl_ms: int = DEFAULT_RECONCILIATION_LEASE_TTL_MS,
    ) -> None:
        self._queue = queue or RedisJobQueue()
        self._session_factory = session_factory
        self._interval_seconds = (
            interval_seconds
            if interval_seconds is not None
            else _positive_interval(
                os.getenv("WMS_JOB_RECONCILE_INTERVAL_SECONDS"),
            )
        )
        self._lease_ttl_ms = lease_ttl_ms
        self._closed = False

    async def run_once(self) -> dict:
        return await reconcile_content_jobs(
            self._queue,
            session_factory=self._session_factory,
            lease_ttl_ms=self._lease_ttl_ms,
        )

    async def run_forever(self) -> None:
        while True:
            try:
                await self.run_once()
            except asyncio.CancelledError:
                raise
            except Exception as error:
                logger.error(
                    "Content job periodic reconciliation failed: {}",
                    redact_secret_text(str(error))[:500],
                )
            await asyncio.sleep(self._interval_seconds)

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        await self._queue.close()
