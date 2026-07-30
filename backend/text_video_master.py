"""Durable master-audio state and sample-accurate assembly."""

from __future__ import annotations

import asyncio
from copy import deepcopy
from dataclasses import dataclass
import hashlib
import json
import math
import os
from pathlib import Path
import time
from typing import Any, Literal, Sequence
from uuid import uuid4

from loguru import logger
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
)
from sqlalchemy.pool import StaticPool

from content_jobs import create_or_get_job
from database import (
    DATABASE_COMMAND_TIMEOUT_SECONDS,
    defer_session_close_until_task_terminal,
)
from job_queue import enqueue_job
from log_redaction import redact_secret_text
from media_command import MediaCommandError, MediaToolUnavailable, probe_audio
from models import (
    ContentJob,
    ContentJobStep,
    CreativeAsset,
    TextVideoProject,
    TextVideoSpeechAsset,
)
from text_video_alignment import tokenize_script
from text_video_audio import (
    TARGET_BIT_RATE,
    TARGET_SAMPLE_RATE,
    assemble_master_audio,
)
from text_video_domain import empty_master_audio, normalize_speech_segments
from text_video_scene_plan import validate_word_timeline
from storage_paths import UPLOADS_DIR


MASTER_SCHEMA_VERSION = 1
MASTER_ENCODING = {
    "codec": "mp3",
    "sample_rate": TARGET_SAMPLE_RATE,
    "channels": 1,
    "bit_rate": TARGET_BIT_RATE,
}
ACTIVE_JOB_STATUSES = {"queued", "running"}
MASTER_DB_OPERATION_TIMEOUT_SECONDS = min(
    DATABASE_COMMAND_TIMEOUT_SECONDS + 5,
    305,
)
MASTER_DB_CANCEL_GRACE_SECONDS = 1.0
MASTER_DB_VERIFICATION_TIMEOUT_SECONDS = 6.0
_DETACHED_MASTER_DB_TASKS: set[asyncio.Task] = set()
_MASTER_LAUNCH_LOCKS: dict[int, asyncio.Lock] = {}
MASTER_ALIGNMENT_LEASE_SECONDS = 300.0


class MasterStateError(ValueError):
    pass


class StaleMasterJob(MasterStateError):
    pass


class MasterBusyError(MasterStateError):
    def __init__(self, message: str, *, retry_at: float):
        super().__init__(message)
        self.retry_at = retry_at


class MasterAlignmentFailedError(MasterStateError):
    def __init__(self, message: str, *, retryable: bool):
        super().__init__(message)
        self.retryable = retryable


@dataclass(frozen=True)
class MasterLaunchResult:
    jobs: list[ContentJob]
    project: TextVideoProject


@dataclass(frozen=True)
class MasterAlignmentContext:
    project: TextVideoProject
    already_ready: bool
    source_hash: str
    audio_path: Path | None
    audio_url: str
    sample_rate: int
    sample_count: int
    segment_offsets: tuple[dict, ...]
    segments: tuple[dict, ...]


def _master_document(value: Any) -> dict:
    return empty_master_audio() | deepcopy(
        value if isinstance(value, dict) else {},
    )


def _upload_path(url: str) -> Path | None:
    prefix = "/api/uploads/"
    if not url.startswith(prefix):
        return None
    relative = url[len(prefix):]
    if not relative or "?" in relative or "#" in relative:
        return None
    root = Path(UPLOADS_DIR).resolve()
    candidate = (root / relative).resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        return None
    return candidate if candidate.is_file() else None


def _asset_path(asset: CreativeAsset) -> Path | None:
    return _upload_path(asset.url)


def _master_payload(master: dict) -> dict:
    return {
        "asset_id": master["asset_id"],
        "audio_url": master["audio_url"],
        "duration": master["sample_count"] / master["sample_rate"],
        "sample_rate": master["sample_rate"],
        "sample_count": master["sample_count"],
        "source_hash": master["source_hash"],
        "segment_offsets": deepcopy(master["segment_offsets"]),
        "owns_asset": bool(master["owns_asset"]),
    }


def _snapshot_identity(snapshot: Sequence[dict]) -> list[dict]:
    return [
        {
            "speech_segment_id": item["speech_segment_id"],
            "text": item["text"],
            "asset_id": item["asset_id"],
            "audio_url": item["audio_url"],
            "source_hash": item["source_hash"],
            "sample_count": item["sample_count"],
            "sample_rate": item["sample_rate"],
            "word_timings": deepcopy(item["word_timings"]),
        }
        for item in snapshot
    ]


def master_source_hash(snapshot: Sequence[dict]) -> str:
    payload = {
        "schema_version": MASTER_SCHEMA_VERSION,
        "encoding": MASTER_ENCODING,
        "segments": [{
            "speech_segment_id": item["speech_segment_id"],
            "text_sha256": hashlib.sha256(
                item["text"].encode("utf-8"),
            ).hexdigest(),
            "asset_id": item["asset_id"],
            "source_hash": item["source_hash"],
            "sample_count": item["sample_count"],
            "sample_rate": item["sample_rate"],
        } for item in snapshot],
    }
    canonical = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


async def _speech_snapshot(
    db: AsyncSession,
    project: TextVideoProject,
) -> list[dict]:
    segments = normalize_speech_segments(
        str(project.script or ""),
        project.paragraphs or [],
    )
    if not str(project.script or "").strip():
        raise MasterStateError("请先输入需要配音的稿件")
    snapshot: list[dict] = []
    for segment in segments:
        text = str(segment["text"])
        if not text:
            continue
        if not tokenize_script(text):
            raise MasterStateError(
                f"口播分段 {segment['id']} 不包含可朗读内容",
            )
        if segment["status"] != "confirmed":
            raise MasterStateError("请先确认所有非空口播段落")
        asset_rows = (
            await db.execute(
                select(TextVideoSpeechAsset, CreativeAsset)
                .join(
                    CreativeAsset,
                    CreativeAsset.id
                    == TextVideoSpeechAsset.creative_asset_id,
                )
                .where(
                    CreativeAsset.url == segment["audio_url"],
                    TextVideoSpeechAsset.source_hash
                    == segment["source_hash"],
                ),
            )
        ).all()
        if len(asset_rows) != 1:
            raise MasterStateError(
                f"配音素材 {segment['id']} 的数据库元数据不唯一或已丢失",
            )
        metadata, asset = asset_rows[0]
        sample_count = int(metadata.sample_count or 0)
        sample_rate = int(metadata.sample_rate or 0)
        if (
            asset.asset_type != "media"
            or asset.media_kind != "audio"
            or asset.media_type != "audio/mpeg"
            or sample_count <= 0
            or sample_rate != TARGET_SAMPLE_RATE
            or not math.isclose(
                float(metadata.duration),
                sample_count / sample_rate,
                rel_tol=0,
                abs_tol=1e-9,
            )
        ):
            raise MasterStateError(
                f"配音素材 {segment['id']} 的元数据无效",
            )
        path = _asset_path(asset)
        if path is None:
            raise MasterStateError(
                f"配音素材 {segment['id']} 的本地文件已丢失",
            )
        snapshot.append({
            "speech_segment_id": segment["id"],
            "text": text,
            "asset_id": asset.id,
            "audio_url": asset.url,
            "path": str(path),
            "source_hash": metadata.source_hash,
            "sample_count": sample_count,
            "sample_rate": sample_rate,
            "word_timings": deepcopy(metadata.word_timings or []),
        })
    if not snapshot:
        raise MasterStateError("没有可用于主音频的已确认口播")
    return snapshot


async def _probe_speech_snapshot(snapshot: Sequence[dict]) -> None:
    for item in snapshot:
        path = Path(str(item["path"]))
        probe = await probe_audio(path)
        if (
            probe.codec_name != "mp3"
            or probe.sample_rate != item["sample_rate"]
            or probe.channels != 1
            or probe.sample_count != item["sample_count"]
            or abs(probe.bit_rate - TARGET_BIT_RATE) > 2000
        ):
            raise MasterStateError(
                f"配音素材 {item['speech_segment_id']} "
                "的实际音频与元数据不一致",
            )


async def _probe_master_audio(master: dict) -> bool:
    path = _upload_path(str(master.get("audio_url") or ""))
    if path is None:
        return False
    try:
        probe = await probe_audio(path)
    except MediaToolUnavailable:
        raise
    except MediaCommandError:
        return False
    return bool(
        probe.codec_name == "mp3"
        and probe.sample_rate == master.get("sample_rate")
        and probe.channels == 1
        and probe.sample_count == master.get("sample_count")
        and abs(probe.bit_rate - TARGET_BIT_RATE) <= 2000
    )


async def _master_asset_valid(
    db: AsyncSession,
    master: dict,
    *,
    source_hash: str,
    snapshot: Sequence[dict],
) -> bool:
    expected_total = sum(
        int(item.get("sample_count") or 0)
        for item in snapshot
    )
    expected_owns_asset = len(snapshot) > 1
    duration = master.get("duration")
    if (
        master.get("status") != "ready"
        or master.get("source_hash") != source_hash
        or isinstance(master.get("asset_id"), bool)
        or not isinstance(master.get("asset_id"), int)
        or isinstance(master.get("sample_count"), bool)
        or not isinstance(master.get("sample_count"), int)
        or master.get("sample_count", 0) <= 0
        or master.get("sample_rate") != TARGET_SAMPLE_RATE
        or not isinstance(master.get("segment_offsets"), list)
        or not master.get("segment_offsets")
        or not isinstance(master.get("owns_asset"), bool)
        or master.get("owns_asset") is not expected_owns_asset
        or isinstance(duration, bool)
        or not isinstance(duration, (int, float))
        or not math.isfinite(float(duration))
        or not math.isclose(
            float(duration),
            master["sample_count"] / master["sample_rate"],
            rel_tol=0,
            abs_tol=1e-9,
        )
        or master["sample_count"] != expected_total
        or not _offsets_match_snapshot(
            master["segment_offsets"],
            snapshot,
        )
    ):
        return False
    if expected_owns_asset:
        if master["asset_id"] in {
            item.get("asset_id") for item in snapshot
        }:
            return False
    elif (
        master["asset_id"] != snapshot[0].get("asset_id")
        or master.get("audio_url") != snapshot[0].get("audio_url")
    ):
        return False
    asset = await db.get(CreativeAsset, master["asset_id"])
    if (
        asset is None
        or asset.url != master.get("audio_url")
        or asset.asset_type != "media"
        or asset.media_kind != "audio"
        or asset.media_type != "audio/mpeg"
    ):
        return False
    if expected_owns_asset and (
        asset.title != "文字视频主音频"
        or asset.source != "generated"
        or asset.filename != Path(asset.url).name
    ):
        return False
    path = _asset_path(asset)
    if path is None:
        return False
    return True


async def recoverable_master_assembly_result(
    db: AsyncSession,
    project: TextVideoProject,
    job: ContentJob,
) -> dict | None:
    """Return an exact, decoded assembly committed by this durable job."""
    snapshot = job.input_data if isinstance(job.input_data, dict) else {}
    segments = snapshot.get("segments")
    if (
        job.flow != "text_video_master_audio"
        or snapshot.get("project_id") != project.id
        or not isinstance(snapshot.get("source_hash"), str)
        or not isinstance(segments, list)
        or not segments
    ):
        return None
    try:
        master = _current_master(project, snapshot, job.id)
    except (KeyError, StaleMasterJob):
        return None
    if not await _master_asset_valid(
        db,
        master,
        source_hash=snapshot["source_hash"],
        snapshot=segments,
    ):
        return None
    if not await _probe_master_audio(master):
        return None
    return _master_payload(master)


async def recoverable_master_alignment_project(
    db: AsyncSession,
    project: TextVideoProject,
    job: ContentJob,
    step: ContentJobStep,
) -> TextVideoProject | None:
    """Return an exact ready timeline committed for this alignment attempt."""
    result = await recoverable_master_assembly_result(db, project, job)
    if result is None:
        return None
    master = _master_document(project.master_audio)
    if (
        master.get("timeline_status") != "ready"
        or master.get("alignment_step_id") != step.id
        or master.get("alignment_attempt") != step.attempt
        or not isinstance(master.get("alignment_claim_token"), str)
        or not master["alignment_claim_token"]
        or (project.render_input or {}).get("audio")
        != master.get("audio_url")
        or project.status != "audio_ready"
    ):
        return None
    try:
        words = validate_word_timeline(
            master.get("word_timings"),
            master.get("duration"),
        )
    except (TypeError, ValueError):
        return None
    script = "".join(
        str(segment.get("text") or "")
        for segment in job.input_data["segments"]
        if isinstance(segment, dict)
    )
    if "".join(str(word.get("text") or "") for word in words) != script:
        return None
    return project


async def _job_for_master(
    db: AsyncSession,
    master: dict,
    source_hash: str,
    *,
    project_id: int,
    snapshot: Sequence[dict],
) -> ContentJob | None:
    job_id = master.get("job_id")
    if not isinstance(job_id, int):
        return None
    job = await db.get(ContentJob, job_id)
    if (
        job is not None
        and job.flow == "text_video_master_audio"
        and job.status in ACTIVE_JOB_STATUSES
        and job.input_data.get("source_hash") == source_hash
        and job.input_data.get("project_id") == project_id
        and int(job.input_data.get("repair_generation") or 0)
        == int(master.get("repair_generation") or 0)
        and job.input_data.get("segments")
        == _snapshot_identity(snapshot)
    ):
        return job
    return None


async def launch_master_audio(
    db: AsyncSession,
    project_id: int,
    *,
    expected_revision: int,
) -> MasterLaunchResult:
    launch_lock = _MASTER_LAUNCH_LOCKS.setdefault(
        project_id,
        asyncio.Lock(),
    )
    async with launch_lock:
        project = await db.get(TextVideoProject, project_id)
        if project is None:
            raise StaleMasterJob("文字视频作品不存在")
        if project.revision != expected_revision:
            raise StaleMasterJob("作品已在其他页面更新")

        # File probing is deliberately completed before any row lock. The
        # immutable snapshot is re-read and compared after locking below.
        snapshot = await _speech_snapshot(db, project)
        frozen_identity = _snapshot_identity(snapshot)
        source_hash = master_source_hash(snapshot)
        frozen_master = _master_document(project.master_audio)
        ready_shape_is_valid = await _master_asset_valid(
            db,
            frozen_master,
            source_hash=source_hash,
            snapshot=snapshot,
        )
        frozen_job_id = frozen_master.get("job_id")
        await db.rollback()
        await _probe_speech_snapshot(snapshot)
        ready_was_probed = bool(
            ready_shape_is_valid
            and await _probe_master_audio(frozen_master)
        )

        if isinstance(frozen_job_id, int):
            await db.scalar(
                select(ContentJob)
                .where(ContentJob.id == frozen_job_id)
                .with_for_update()
                .execution_options(populate_existing=True),
            )
        project = await db.scalar(
            select(TextVideoProject)
            .where(TextVideoProject.id == project_id)
            .with_for_update()
            .execution_options(populate_existing=True),
        )
        if project is None:
            raise StaleMasterJob("文字视频作品不存在")
        if project.revision != expected_revision:
            raise StaleMasterJob("作品已在其他页面更新")
        database_snapshot = await _speech_snapshot(db, project)
        if _snapshot_identity(database_snapshot) != frozen_identity:
            raise StaleMasterJob("口播素材快照已更新，请重新生成")
        master = _master_document(project.master_audio)
        if (
            master.get("job_id") != frozen_job_id
            or master_source_hash(database_snapshot) != source_hash
        ):
            raise StaleMasterJob("主音频任务已在其他请求中更新")
        valid_ready = bool(
            ready_was_probed
            and master == frozen_master
            and await _master_asset_valid(
                db,
                master,
                source_hash=source_hash,
                snapshot=database_snapshot,
            )
        )
        active = await _job_for_master(
            db,
            master,
            source_hash,
            project_id=project_id,
            snapshot=database_snapshot,
        )
        if valid_ready and master["timeline_status"] == "ready":
            await db.commit()
            await db.refresh(project)
            return MasterLaunchResult(jobs=[], project=project)
        if active is not None:
            await db.commit()
            await db.refresh(project)
            await db.refresh(active)
            if active.status == "queued":
                await enqueue_job(active.id)
            return MasterLaunchResult(jobs=[active], project=project)

        repair_generation = int(master.get("repair_generation") or 0)
        has_prior_attempt = bool(
            master.get("source_hash") == source_hash
            and (
                master.get("job_id") is not None
                or master.get("status") in {"ready", "failed"}
            )
        )
        if has_prior_attempt:
            repair_generation += 1
        key = (
            f"text-video-master:{project.id}:{source_hash}:"
            f"repair:{repair_generation}"
        )
        job = await create_or_get_job(
            db,
            flow="text_video_master_audio",
            title=f"生成文字视频主音频 · {project.title}",
            input_data={
                "project_id": project.id,
                "project_revision": project.revision,
                "source_hash": source_hash,
                "schema_version": MASTER_SCHEMA_VERSION,
                "encoding": MASTER_ENCODING,
                "repair_generation": repair_generation,
                "segments": frozen_identity,
            },
            idempotency_key=key,
            commit=False,
        )
        if valid_ready:
            master.update({
                "timeline_status": "missing",
                "word_timings": [],
                "timeline_source": "",
                "timeline_error": "",
                "job_id": job.id,
                "repair_generation": repair_generation,
            })
        else:
            master = empty_master_audio() | {
                "status": "building",
                "timeline_status": "missing",
                "source_hash": source_hash,
                "job_id": job.id,
                "repair_generation": repair_generation,
            }
        project.master_audio = master
        render_input = deepcopy(project.render_input or {})
        render_input["audio"] = ""
        project.render_input = render_input
        await db.commit()
        await db.refresh(project)
        await db.refresh(job)
        if job.status == "queued":
            await enqueue_job(job.id)
        return MasterLaunchResult(jobs=[job], project=project)


def _validate_job(
    job: ContentJob | None,
    *,
    project_id: int,
) -> dict:
    if (
        job is None
        or job.flow != "text_video_master_audio"
        or job.input_data.get("project_id") != project_id
        or not isinstance(job.input_data.get("source_hash"), str)
    ):
        raise StaleMasterJob("主音频任务已失效")
    if job.status == "cancelled":
        raise StaleMasterJob("任务已取消")
    return job.input_data


def _require_active_job(job: ContentJob | None) -> None:
    if job is None or job.status not in ACTIVE_JOB_STATUSES:
        raise StaleMasterJob("主音频任务已不再运行")


async def _require_alignment_step(
    db: AsyncSession,
    *,
    job_id: int,
    step_id: int,
    attempt: int,
) -> ContentJobStep:
    step = await db.scalar(
        select(ContentJobStep)
        .where(
            ContentJobStep.job_id == job_id,
            ContentJobStep.step_key == "align_master_timeline",
        )
        .order_by(
            ContentJobStep.attempt.desc(),
            ContentJobStep.id.desc(),
        ),
    )
    if (
        step is None
        or step.id != step_id
        or step.attempt != attempt
        or step.status != "running"
    ):
        raise StaleMasterJob("主音频对齐步骤已失效")
    return step


async def _lock_alignment_job_row(
    db: AsyncSession,
    job_id: int,
) -> ContentJob | None:
    # SELECT ... FOR UPDATE is ignored by SQLite. A harmless write gives both
    # SQLite and PostgreSQL a database-backed exclusion point, so independent
    # API processes cannot both persist an alignment claim.
    await db.execute(
        update(ContentJob)
        .where(ContentJob.id == job_id)
        .values(status=ContentJob.status),
    )
    return await db.scalar(
        select(ContentJob)
        .where(ContentJob.id == job_id)
        .with_for_update()
        .execution_options(populate_existing=True),
    )


def _alignment_claim_matches(
    master: dict,
    *,
    step_id: int,
    attempt: int,
    claim_token: str,
) -> bool:
    return (
        master.get("alignment_step_id") == step_id
        and master.get("alignment_attempt") == attempt
        and master.get("alignment_claim_token") == claim_token
    )


def _reject_live_or_expired_alignment_claim(
    master: dict,
    *,
    step_id: int,
    attempt: int,
    claim_token: str,
    now: float,
) -> None:
    if master.get("timeline_status") not in {"aligning", "failed"}:
        return
    claimed_step_id = master.get("alignment_step_id")
    claimed_attempt = master.get("alignment_attempt")
    claimed_token = master.get("alignment_claim_token")
    expires_at = master.get("alignment_claim_expires_at")
    if (
        isinstance(claimed_step_id, bool)
        or not isinstance(claimed_step_id, int)
        or isinstance(claimed_attempt, bool)
        or not isinstance(claimed_attempt, int)
        or not isinstance(claimed_token, str)
        or not claimed_token
        or isinstance(expires_at, bool)
        or not isinstance(expires_at, (int, float))
        or not math.isfinite(expires_at)
    ):
        return
    if (claimed_attempt, claimed_step_id) > (attempt, step_id):
        raise StaleMasterJob("主音频对齐步骤已被替换")
    if (claimed_attempt, claimed_step_id) < (attempt, step_id):
        return
    if expires_at > now:
        raise MasterBusyError(
            "主音频时间轴正在对齐",
            retry_at=float(expires_at),
        )
    raise StaleMasterJob(
        "主音频对齐结果仍不明确，请先结束当前步骤再重试",
    )


def _raise_replayed_alignment_failure(
    master: dict,
    *,
    step_id: int,
    attempt: int,
    claim_token: str,
) -> None:
    if (
        master.get("timeline_status") == "failed"
        and _alignment_claim_matches(
            master,
            step_id=step_id,
            attempt=attempt,
            claim_token=claim_token,
        )
    ):
        raise MasterAlignmentFailedError(
            str(master.get("timeline_error") or "主音频对齐失败"),
            retryable=master.get("timeline_retryable") is True,
        )


def _current_master(
    project: TextVideoProject,
    snapshot: dict,
    job_id: int,
) -> dict:
    master = _master_document(project.master_audio)
    if (
        master.get("source_hash") != snapshot["source_hash"]
        or master.get("job_id") != job_id
        or int(master.get("repair_generation") or 0)
        != int(snapshot.get("repair_generation") or 0)
    ):
        raise StaleMasterJob("主音频任务已被替换")
    return master


def _task_failure(task: asyncio.Task) -> BaseException | None:
    try:
        task.result()
    except BaseException as error:
        return error
    return None


@dataclass(frozen=True)
class _TaskOutcome:
    terminal: bool
    timed_out: bool
    cancellation_requested: bool
    failure: BaseException | None
    pending_cancellation: asyncio.CancelledError | None


async def _wait_for_task_window(
    task: asyncio.Task,
    timeout_seconds: float,
    pending_cancellation: asyncio.CancelledError | None,
    *,
    cancellation_interrupts: bool,
) -> tuple[
    asyncio.CancelledError | None,
    bool,
    Literal["terminal", "cancelled", "timeout"],
]:
    deadline = asyncio.get_running_loop().time() + timeout_seconds
    cancellation_seen = False
    while not task.done():
        remaining = deadline - asyncio.get_running_loop().time()
        if remaining <= 0:
            return pending_cancellation, cancellation_seen, "timeout"
        try:
            await asyncio.wait_for(
                asyncio.shield(task),
                timeout=remaining,
            )
        except asyncio.CancelledError as error:
            current = asyncio.current_task()
            caller_cancelled = bool(
                current is not None and current.cancelling()
            )
            if caller_cancelled:
                cancellation_seen = True
                if pending_cancellation is None:
                    pending_cancellation = error
            if task.done():
                break
            if caller_cancelled and cancellation_interrupts:
                return pending_cancellation, cancellation_seen, "cancelled"
        except TimeoutError:
            if task.done():
                break
            return pending_cancellation, cancellation_seen, "timeout"
        except BaseException:
            break
    return pending_cancellation, cancellation_seen, "terminal"


def _retain_unfinished_master_db_task(
    task: asyncio.Task,
    *,
    db: AsyncSession | None,
) -> None:
    _DETACHED_MASTER_DB_TASKS.add(task)
    if db is not None:
        defer_session_close_until_task_terminal(db, task)

    def consume(completed: asyncio.Task) -> None:
        _DETACHED_MASTER_DB_TASKS.discard(completed)
        _task_failure(completed)

    task.add_done_callback(consume)


async def _bounded_task_outcome(
    task: asyncio.Task,
    *,
    timeout_seconds: float,
    pending_cancellation: asyncio.CancelledError | None = None,
    db: AsyncSession | None = None,
) -> _TaskOutcome:
    (
        pending_cancellation,
        cancellation_seen,
        wait_status,
    ) = await _wait_for_task_window(
        task,
        timeout_seconds,
        pending_cancellation,
        cancellation_interrupts=True,
    )
    timed_out = wait_status == "timeout"
    interrupted = wait_status in {"cancelled", "timeout"}
    if interrupted and not task.done():
        task.cancel()
        (
            pending_cancellation,
            drain_cancellation_seen,
            _drain_status,
        ) = await _wait_for_task_window(
            task,
            MASTER_DB_CANCEL_GRACE_SECONDS,
            pending_cancellation,
            cancellation_interrupts=False,
        )
        cancellation_seen = (
            cancellation_seen or drain_cancellation_seen
        )
    if not task.done():
        _retain_unfinished_master_db_task(task, db=db)
        return _TaskOutcome(
            terminal=False,
            timed_out=timed_out,
            cancellation_requested=True,
            failure=None,
            pending_cancellation=pending_cancellation,
        )
    return _TaskOutcome(
        terminal=True,
        timed_out=timed_out,
        cancellation_requested=(
            cancellation_seen or interrupted or task.cancelled()
        ),
        failure=_task_failure(task),
        pending_cancellation=pending_cancellation,
    )


async def _durable_master_matches(
    db: AsyncSession,
    *,
    project_id: int,
    saved: dict,
) -> bool | None:
    bind = db.bind
    if not isinstance(bind, AsyncEngine):
        logger.error(
            "Cannot independently verify master asset {} durability: "
            "database bind is not an async engine",
            saved.get("asset_id"),
        )
        return None
    verification_pool = getattr(bind, "pool", None)
    if verification_pool is None or isinstance(
        verification_pool,
        StaticPool,
    ):
        logger.error(
            "Cannot independently verify master asset {} durability: "
            "database pool does not provide an independent connection",
            saved.get("asset_id"),
        )
        return None
    factory = async_sessionmaker(bind, expire_on_commit=False)
    try:
        async with asyncio.timeout(MASTER_DB_VERIFICATION_TIMEOUT_SECONDS):
            async with factory() as verification:
                project = await verification.get(
                    TextVideoProject,
                    project_id,
                )
                asset = await verification.get(
                    CreativeAsset,
                    saved["asset_id"],
                )
                if project is None and asset is None:
                    return False
                if project is None:
                    return None
                master = _master_document(project.master_audio)
                expected_duration = (
                    saved["sample_count"] / saved["sample_rate"]
                )
                project_matches = bool(
                    master.get("asset_id") == saved["asset_id"]
                    and master.get("audio_url") == saved["audio_url"]
                    and master.get("source_hash") == saved["source_hash"]
                    and master.get("sample_count") == saved["sample_count"]
                    and master.get("sample_rate") == saved["sample_rate"]
                    and master.get("segment_offsets")
                    == saved["segment_offsets"]
                    and master.get("owns_asset")
                    is saved.get("owns_asset")
                    and master.get("job_id") == saved.get("job_id")
                    and int(master.get("repair_generation") or 0)
                    == int(saved.get("repair_generation") or 0)
                    and math.isclose(
                        float(master.get("duration") or 0),
                        expected_duration,
                        rel_tol=0,
                        abs_tol=1e-9,
                    )
                )
                if asset is None:
                    project_references_asset = bool(
                        master.get("asset_id") == saved["asset_id"]
                        or master.get("audio_url") == saved["audio_url"]
                    )
                    return None if project_references_asset else False
                asset_matches = bool(
                    asset.asset_type == "media"
                    and asset.url == saved["audio_url"]
                    and asset.media_type == "audio/mpeg"
                    and asset.media_kind == "audio"
                    and asset.filename == Path(saved["audio_url"]).name
                    and (
                        not saved.get("owns_asset")
                        or (
                            asset.title == "文字视频主音频"
                            and asset.source == "generated"
                        )
                    )
                )
                if project_matches and asset_matches:
                    return True
                if asset_matches and not saved.get("owns_asset"):
                    return False
                return None
    except Exception as error:
        logger.error(
            "Cannot verify master asset {} durability: {}",
            saved.get("asset_id"),
            redact_secret_text(str(error))[:500],
        )
        return None


async def _commit_master(
    db: AsyncSession,
    *,
    project_id: int,
    saved: dict,
    owned_path: Path | None,
) -> None:
    commit_task = asyncio.create_task(
        db.commit(),
        name=f"text-video-master-commit-{saved['asset_id']}",
    )
    commit_outcome = await _bounded_task_outcome(
        commit_task,
        timeout_seconds=MASTER_DB_OPERATION_TIMEOUT_SECONDS,
        db=db,
    )
    pending_cancellation = commit_outcome.pending_cancellation
    if not commit_outcome.terminal:
        failure = TimeoutError(
            "master result commit did not reach a terminal state",
        )
        logger.error(
            "Master commit did not terminate for asset {}; preserving file "
            "and deferring session close",
            saved["asset_id"],
        )
        if pending_cancellation is not None:
            raise pending_cancellation from failure
        raise failure
    commit_confirmed = bool(
        commit_outcome.failure is None
        and not commit_outcome.timed_out
        and not commit_outcome.cancellation_requested
    )
    if commit_confirmed:
        if pending_cancellation is not None:
            raise pending_cancellation
        return
    failure = commit_outcome.failure
    if failure is None:
        if commit_outcome.timed_out:
            failure = TimeoutError("master result commit exceeded its deadline")
        elif commit_outcome.cancellation_requested:
            failure = asyncio.CancelledError(
                "master result commit was interrupted",
            )
        else:
            failure = RuntimeError("master result commit was not confirmed")
    effective_failure: BaseException = (
        TimeoutError("master result commit exceeded its deadline")
        if commit_outcome.timed_out
        else failure
    )

    rollback_task = asyncio.create_task(
        db.rollback(),
        name=f"text-video-master-rollback-{saved['asset_id']}",
    )
    rollback_outcome = await _bounded_task_outcome(
        rollback_task,
        timeout_seconds=(
            MASTER_DB_CANCEL_GRACE_SECONDS
            if pending_cancellation is not None
            else MASTER_DB_OPERATION_TIMEOUT_SECONDS
        ),
        pending_cancellation=pending_cancellation,
        db=db,
    )
    pending_cancellation = rollback_outcome.pending_cancellation
    rollback_confirmed = bool(
        rollback_outcome.terminal
        and rollback_outcome.failure is None
        and not rollback_outcome.timed_out
        and not rollback_outcome.cancellation_requested
    )
    if not rollback_confirmed:
        logger.warning(
            "Master rollback was not confirmed for asset {}: {}",
            saved["asset_id"],
            redact_secret_text(
                str(rollback_outcome.failure or "interrupted"),
            )[:500],
        )

    verification_task = asyncio.create_task(
        _durable_master_matches(
            db,
            project_id=project_id,
            saved=saved,
        ),
        name=f"text-video-master-verify-{saved['asset_id']}",
    )
    verification_outcome = await _bounded_task_outcome(
        verification_task,
        timeout_seconds=(
            MASTER_DB_CANCEL_GRACE_SECONDS
            if pending_cancellation is not None
            else MASTER_DB_VERIFICATION_TIMEOUT_SECONDS
        ),
        pending_cancellation=pending_cancellation,
    )
    pending_cancellation = verification_outcome.pending_cancellation
    durable = (
        verification_task.result()
        if (
            verification_outcome.terminal
            and verification_outcome.failure is None
            and not verification_outcome.timed_out
        )
        else None
    )
    ambiguous_commit = bool(
        commit_outcome.timed_out
        or commit_outcome.cancellation_requested
    )
    if (
        durable is False
        and rollback_confirmed
        and not ambiguous_commit
        and owned_path is not None
    ):
        owned_path.unlink(missing_ok=True)
    elif durable is True and not ambiguous_commit:
        logger.warning(
            "Master commit acknowledgement failed for asset {}, but "
            "independent verification found durable state",
            saved["asset_id"],
        )
    else:
        logger.error(
            "Master commit state is unknown for asset {}; preserving file",
            saved["asset_id"],
        )

    if pending_cancellation is not None:
        raise pending_cancellation from effective_failure
    if durable is True and not ambiguous_commit:
        return
    raise effective_failure


async def assemble_master(
    db: AsyncSession,
    *,
    project_id: int,
    job_id: int,
) -> dict:
    job = await db.get(ContentJob, job_id)
    snapshot = _validate_job(job, project_id=project_id)
    project = await db.get(TextVideoProject, project_id)
    if project is None:
        raise StaleMasterJob("文字视频作品不存在")
    master = _current_master(project, snapshot, job_id)
    live_snapshot = await _speech_snapshot(db, project)
    if _snapshot_identity(live_snapshot) != snapshot.get("segments"):
        raise StaleMasterJob("口播素材快照已更新")
    ready_shape_is_valid = await _master_asset_valid(
        db,
        master,
        source_hash=snapshot["source_hash"],
        snapshot=snapshot.get("segments") or [],
    )
    job_was_active = bool(job.status in ACTIVE_JOB_STATUSES)
    await db.rollback()
    if (
        ready_shape_is_valid
        and await _probe_master_audio(master)
    ):
        return _master_payload(master)
    if not job_was_active:
        raise StaleMasterJob("主音频任务已不再运行")
    await _probe_speech_snapshot(live_snapshot)

    uploads = Path(UPLOADS_DIR)
    uploads.mkdir(parents=True, exist_ok=True)
    temporary_directory = uploads / ".master-tmp"
    temporary_directory.mkdir(parents=True, exist_ok=True)
    temporary = temporary_directory / f"{uuid4().hex}.mp3"
    owned_path: Path | None = None
    owns_asset = len(live_snapshot) > 1
    if owns_asset:
        assembled = await assemble_master_audio(
            [Path(item["path"]) for item in live_snapshot],
            temporary,
            expected_sample_counts=[
                item["sample_count"] for item in live_snapshot
            ],
        )
        sample_offsets = list(assembled.sample_offsets)
        sample_count = assembled.probe.sample_count
        sample_rate = assembled.probe.sample_rate
    else:
        sample_offsets = [0]
        sample_count = live_snapshot[0]["sample_count"]
        sample_rate = live_snapshot[0]["sample_rate"]

    commit_started = False
    try:
        verification_project = await db.get(
            TextVideoProject,
            project_id,
        )
        if verification_project is None:
            raise StaleMasterJob("文字视频作品不存在")
        verified_snapshot = await _speech_snapshot(
            db,
            verification_project,
        )
        if _snapshot_identity(verified_snapshot) != snapshot.get("segments"):
            raise StaleMasterJob("口播素材快照已更新")
        await db.rollback()
        await _probe_speech_snapshot(verified_snapshot)
        locked_job = await db.scalar(
            select(ContentJob)
            .where(ContentJob.id == job_id)
            .with_for_update()
            .execution_options(populate_existing=True),
        )
        snapshot = _validate_job(locked_job, project_id=project_id)
        locked_project = await db.scalar(
            select(TextVideoProject)
            .where(TextVideoProject.id == project_id)
            .with_for_update()
            .execution_options(populate_existing=True),
        )
        if locked_project is None:
            raise StaleMasterJob("文字视频作品不存在")
        master = _current_master(locked_project, snapshot, job_id)
        if await _master_asset_valid(
            db,
            master,
            source_hash=snapshot["source_hash"],
            snapshot=snapshot.get("segments") or [],
        ):
            return _master_payload(master)
        _require_active_job(locked_job)
        database_snapshot = await _speech_snapshot(db, locked_project)
        if _snapshot_identity(database_snapshot) != snapshot.get("segments"):
            raise StaleMasterJob("口播素材快照已更新")
        offsets = [
            {
                "segment_id": item["speech_segment_id"],
                "asset_id": item["asset_id"],
                "source_hash": item["source_hash"],
                "sample_offset": sample_offsets[index],
                "sample_count": item["sample_count"],
                "sample_rate": item["sample_rate"],
            }
            for index, item in enumerate(live_snapshot)
        ]
        if owns_asset:
            identifier = uuid4().hex
            owned_path = uploads / f"{identifier}.mp3"
            os.replace(temporary, owned_path)
            asset = CreativeAsset(
                asset_type="media",
                media_kind="audio",
                title="文字视频主音频",
                url=f"/api/uploads/{owned_path.name}",
                media_type="audio/mpeg",
                filename=owned_path.name,
                source="generated",
            )
            db.add(asset)
            await db.flush()
            asset_id = asset.id
            audio_url = asset.url
        else:
            asset_id = live_snapshot[0]["asset_id"]
            audio_url = live_snapshot[0]["audio_url"]
        saved = {
            "asset_id": asset_id,
            "audio_url": audio_url,
            "sample_rate": sample_rate,
            "sample_count": sample_count,
            "source_hash": snapshot["source_hash"],
            "segment_offsets": offsets,
            "owns_asset": owns_asset,
            "job_id": job_id,
            "repair_generation": int(
                snapshot.get("repair_generation") or 0,
            ),
        }
        master.update({
            **saved,
            "status": "ready",
            "timeline_status": "missing",
            "duration": sample_count / sample_rate,
            "word_timings": [],
            "timeline_source": "",
            "error": "",
            "timeline_error": "",
        })
        locked_project.master_audio = master
        commit_started = True
        await _commit_master(
            db,
            project_id=project_id,
            saved=saved,
            owned_path=owned_path,
        )
        return _master_payload(master)
    except BaseException:
        if owned_path is not None and not commit_started:
            owned_path.unlink(missing_ok=True)
        raise
    finally:
        temporary.unlink(missing_ok=True)


def _offsets_match_snapshot(
    offsets: Sequence[dict],
    segments: Sequence[dict],
) -> bool:
    if len(offsets) != len(segments):
        return False
    expected_offset = 0
    for offset, segment in zip(offsets, segments, strict=True):
        asset_id = offset.get("asset_id") if isinstance(offset, dict) else None
        sample_offset = (
            offset.get("sample_offset") if isinstance(offset, dict) else None
        )
        sample_count = (
            offset.get("sample_count") if isinstance(offset, dict) else None
        )
        sample_rate = (
            offset.get("sample_rate") if isinstance(offset, dict) else None
        )
        if (
            not isinstance(offset, dict)
            or isinstance(asset_id, bool)
            or not isinstance(asset_id, int)
            or asset_id <= 0
            or isinstance(sample_offset, bool)
            or not isinstance(sample_offset, int)
            or sample_offset < 0
            or isinstance(sample_count, bool)
            or not isinstance(sample_count, int)
            or sample_count <= 0
            or isinstance(sample_rate, bool)
            or not isinstance(sample_rate, int)
            or sample_rate != TARGET_SAMPLE_RATE
            or offset.get("segment_id")
            != segment.get("speech_segment_id")
            or asset_id != segment.get("asset_id")
            or offset.get("source_hash") != segment.get("source_hash")
            or sample_count != segment.get("sample_count")
            or sample_rate != segment.get("sample_rate")
            or sample_offset != expected_offset
        ):
            return False
        expected_offset += int(segment.get("sample_count") or 0)
    return True


def _master_media_identity(master: dict) -> tuple:
    return (
        master.get("asset_id"),
        master.get("audio_url"),
        master.get("duration"),
        master.get("sample_rate"),
        master.get("sample_count"),
        master.get("source_hash"),
        deepcopy(master.get("segment_offsets")),
        master.get("owns_asset"),
    )


async def begin_master_alignment(
    db: AsyncSession,
    *,
    project_id: int,
    job_id: int,
    source_hash: str,
    step_id: int,
    attempt: int,
    claim_token: str,
) -> MasterAlignmentContext:
    job = await db.get(ContentJob, job_id)
    snapshot = _validate_job(job, project_id=project_id)
    if snapshot["source_hash"] != source_hash:
        raise StaleMasterJob("主音频 source hash 不匹配")
    _require_active_job(job)
    await _require_alignment_step(
        db,
        job_id=job_id,
        step_id=step_id,
        attempt=attempt,
    )
    project = await db.get(TextVideoProject, project_id)
    if project is None:
        raise StaleMasterJob("文字视频作品不存在")
    master = _current_master(project, snapshot, job_id)
    _raise_replayed_alignment_failure(
        master,
        step_id=step_id,
        attempt=attempt,
        claim_token=claim_token,
    )
    _reject_live_or_expired_alignment_claim(
        master,
        step_id=step_id,
        attempt=attempt,
        claim_token=claim_token,
        now=time.time(),
    )
    live_snapshot = await _speech_snapshot(db, project)
    if _snapshot_identity(live_snapshot) != snapshot.get("segments"):
        raise StaleMasterJob("口播素材快照已更新")
    master_shape_is_valid = await _master_asset_valid(
        db,
        master,
        source_hash=source_hash,
        snapshot=snapshot.get("segments") or [],
    )
    asset = await db.get(CreativeAsset, master["asset_id"])
    path = _asset_path(asset) if asset is not None else None
    if path is None:
        raise StaleMasterJob("主音频文件已丢失，请重新生成")
    probed_identity = _master_media_identity(master)
    await db.rollback()
    if (
        not master_shape_is_valid
        or not await _probe_master_audio(master)
    ):
        raise StaleMasterJob("主音频文件或 sample offsets 已失效")

    locked_job = await _lock_alignment_job_row(db, job_id)
    snapshot = _validate_job(locked_job, project_id=project_id)
    _require_active_job(locked_job)
    await _require_alignment_step(
        db,
        job_id=job_id,
        step_id=step_id,
        attempt=attempt,
    )
    locked_project = await db.scalar(
        select(TextVideoProject)
        .where(TextVideoProject.id == project_id)
        .with_for_update()
        .execution_options(populate_existing=True),
    )
    if locked_project is None:
        raise StaleMasterJob("文字视频作品不存在")
    master = _current_master(locked_project, snapshot, job_id)
    database_snapshot = await _speech_snapshot(db, locked_project)
    if _snapshot_identity(database_snapshot) != snapshot.get("segments"):
        raise StaleMasterJob("口播素材快照已更新")
    if (
        _master_media_identity(master) != probed_identity
        or not await _master_asset_valid(
            db,
            master,
            source_hash=source_hash,
            snapshot=snapshot.get("segments") or [],
        )
    ):
        raise StaleMasterJob("主音频任务状态已更新")
    current_path = _asset_path(
        await db.get(CreativeAsset, master["asset_id"]),
    )
    if current_path is None:
        raise StaleMasterJob("主音频文件已丢失，请重新生成")
    already_ready = master["timeline_status"] == "ready"
    if already_ready:
        await db.commit()
        await db.refresh(locked_project)
        return MasterAlignmentContext(
            project=locked_project,
            already_ready=True,
            source_hash=source_hash,
            audio_path=None,
            audio_url=master["audio_url"],
            sample_rate=master["sample_rate"],
            sample_count=master["sample_count"],
            segment_offsets=tuple(deepcopy(master["segment_offsets"])),
            segments=tuple(deepcopy(snapshot["segments"])),
        )
    now = time.time()
    _raise_replayed_alignment_failure(
        master,
        step_id=step_id,
        attempt=attempt,
        claim_token=claim_token,
    )
    _reject_live_or_expired_alignment_claim(
        master,
        step_id=step_id,
        attempt=attempt,
        claim_token=claim_token,
        now=now,
    )
    master["timeline_status"] = "aligning"
    master["alignment_step_id"] = step_id
    master["alignment_attempt"] = attempt
    master["alignment_claim_token"] = claim_token
    master["alignment_claim_expires_at"] = (
        now + MASTER_ALIGNMENT_LEASE_SECONDS
    )
    master["timeline_error"] = ""
    master["timeline_retryable"] = False
    master["word_timings"] = []
    locked_project.master_audio = master
    render_input = deepcopy(locked_project.render_input or {})
    render_input["audio"] = ""
    locked_project.render_input = render_input
    await db.commit()
    await db.refresh(locked_project)
    return MasterAlignmentContext(
        project=locked_project,
        already_ready=False,
        source_hash=source_hash,
        audio_path=current_path,
        audio_url=master["audio_url"],
        sample_rate=master["sample_rate"],
        sample_count=master["sample_count"],
        segment_offsets=tuple(deepcopy(master["segment_offsets"])),
        segments=tuple(deepcopy(snapshot["segments"])),
    )


async def complete_master_alignment(
    db: AsyncSession,
    *,
    project_id: int,
    job_id: int,
    source_hash: str,
    step_id: int,
    attempt: int,
    claim_token: str,
    words: Sequence[dict],
    timeline_source: str,
) -> TextVideoProject:
    job = await _lock_alignment_job_row(db, job_id)
    snapshot = _validate_job(job, project_id=project_id)
    _require_active_job(job)
    await _require_alignment_step(
        db,
        job_id=job_id,
        step_id=step_id,
        attempt=attempt,
    )
    if snapshot["source_hash"] != source_hash:
        raise StaleMasterJob("主音频 source hash 不匹配")
    project = await db.scalar(
        select(TextVideoProject)
        .where(TextVideoProject.id == project_id)
        .with_for_update()
        .execution_options(populate_existing=True),
    )
    if project is None:
        raise StaleMasterJob("文字视频作品不存在")
    master = _current_master(project, snapshot, job_id)
    if not _alignment_claim_matches(
        master,
        step_id=step_id,
        attempt=attempt,
        claim_token=claim_token,
    ):
        raise StaleMasterJob("主音频对齐 claim 已被替换")
    if master["timeline_status"] == "ready":
        return project
    database_snapshot = await _speech_snapshot(db, project)
    if _snapshot_identity(database_snapshot) != snapshot.get("segments"):
        raise StaleMasterJob("口播素材快照已更新")
    if (
        master["status"] != "ready"
        or master["timeline_status"] != "aligning"
        or not _offsets_match_snapshot(
            master.get("segment_offsets") or [],
            snapshot.get("segments") or [],
        )
    ):
        raise StaleMasterJob("主音频时间轴任务已更新")
    exact_script = "".join(
        str(segment.get("text") or "")
        for segment in snapshot["segments"]
    )
    if "".join(str(word.get("text") or "") for word in words) != exact_script:
        raise MasterStateError("逐字时间轴未能无损还原稿件")
    master.update({
        "timeline_status": "ready",
        "word_timings": deepcopy(list(words)),
        "timeline_source": timeline_source,
        "timeline_error": "",
        "timeline_retryable": False,
        "error": "",
    })
    project.master_audio = master
    render_input = deepcopy(project.render_input or {})
    render_input["audio"] = master["audio_url"]
    project.render_input = render_input
    project.status = "audio_ready"
    await db.commit()
    await db.refresh(project)
    return project


async def fail_master_audio(
    db: AsyncSession,
    *,
    project_id: int,
    job_id: int,
    source_hash: str,
    phase: str,
    error: str,
    step_id: int | None = None,
    attempt: int | None = None,
    claim_token: str | None = None,
    reconcile_only: bool = False,
    retryable: bool = False,
) -> TextVideoProject:
    if phase not in {"assemble_master_audio", "align_master_timeline"}:
        raise MasterStateError("未知的主音频任务阶段")
    if phase == "align_master_timeline":
        if (
            isinstance(step_id, bool)
            or not isinstance(step_id, int)
            or step_id <= 0
            or isinstance(attempt, bool)
            or not isinstance(attempt, int)
            or attempt <= 0
            or not isinstance(claim_token, str)
            or not claim_token
        ):
            raise MasterStateError("主音频对齐失败缺少有效 claim")
        job = await _lock_alignment_job_row(db, job_id)
        await _require_alignment_step(
            db,
            job_id=job_id,
            step_id=step_id,
            attempt=attempt,
        )
    else:
        job = await db.scalar(
            select(ContentJob)
            .where(ContentJob.id == job_id)
            .with_for_update()
            .execution_options(populate_existing=True),
        )
    snapshot = _validate_job(job, project_id=project_id)
    if snapshot["source_hash"] != source_hash:
        raise StaleMasterJob("主音频 source hash 不匹配")
    project = await db.scalar(
        select(TextVideoProject)
        .where(TextVideoProject.id == project_id)
        .with_for_update()
        .execution_options(populate_existing=True),
    )
    if project is None:
        raise StaleMasterJob("文字视频作品不存在")
    master = _current_master(project, snapshot, job_id)
    if phase == "align_master_timeline" and not _alignment_claim_matches(
        master,
        step_id=step_id,
        attempt=attempt,
        claim_token=claim_token,
    ):
        raise StaleMasterJob("主音频对齐 claim 已被替换")
    safe_error = redact_secret_text(str(error))[:500]
    if phase == "assemble_master_audio":
        if master["status"] == "ready":
            return project
        _require_active_job(job)
        master["status"] = "failed"
        master["error"] = safe_error
        master["timeline_status"] = "missing"
    elif master["timeline_status"] == "ready":
        return project
    elif reconcile_only:
        # The worker-facing failure endpoint is an acknowledgement probe for
        # alignment. Known transcription/alignment failures are persisted by
        # worker-align itself. A transport error must not let a duplicate
        # worker cancel an owner whose paid request may still be running.
        return project
    elif master["status"] == "ready":
        _require_active_job(job)
        master["timeline_status"] = "failed"
        master["timeline_error"] = safe_error
        master["timeline_retryable"] = retryable is True
    else:
        _require_active_job(job)
        master["status"] = "failed"
        master["error"] = safe_error
    project.master_audio = master
    render_input = deepcopy(project.render_input or {})
    render_input["audio"] = ""
    project.render_input = render_input
    await db.commit()
    await db.refresh(project)
    return project
