"""Durable, idempotent speech jobs for text-video segments."""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
import hashlib
import json
import math
from pathlib import Path
from typing import Iterable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from content_jobs import create_or_get_job
from job_queue import enqueue_job
from models import (
    ContentJob,
    CreativeAsset,
    TextVideoProject,
    TextVideoSpeechAsset,
)
from text_video_domain import (
    empty_master_audio,
    empty_scene_plan,
    normalize_speech_segments,
    speech_source_hash,
)
from storage_paths import UPLOADS_DIR


ACTIVE_JOB_STATUSES = {"queued", "running"}


@dataclass(frozen=True)
class SpeechLaunchResult:
    jobs: list[ContentJob]
    reused_segment_ids: list[str]
    project: TextVideoProject


class StaleTextVideoJob(ValueError):
    pass


def _segment(project: TextVideoProject, segment_id: str) -> dict:
    for segment in project.paragraphs or []:
        if isinstance(segment, dict) and segment.get("id") == segment_id:
            return deepcopy(segment)
    raise StaleTextVideoJob("配音段落已更新")


def freeze_speech_job_input(
    project: TextVideoProject,
    segment_id: str,
    *,
    model: str,
) -> dict:
    segment = _segment(project, segment_id)
    voice_settings = deepcopy(project.voice_settings or {})
    resolved_model = str(voice_settings.get("model") or model)
    voice_settings["model"] = resolved_model
    return {
        "project_id": project.id,
        "segment_id": segment["id"],
        "project_revision": project.revision,
        "generation_revision": int(segment["generation_revision"]),
        "text": str(segment["text"]),
        "source_hash": speech_source_hash(
            str(segment["text"]),
            voice_settings,
            resolved_model,
        ),
        "voice_settings": voice_settings,
        "speech_model": resolved_model,
    }


def assert_current_speech_job(
    project: TextVideoProject,
    snapshot: dict,
) -> dict:
    try:
        segment = _segment(project, str(snapshot.get("segment_id") or ""))
    except StaleTextVideoJob:
        raise
    voice_settings = deepcopy(project.voice_settings or {})
    resolved_model = str(
        voice_settings.get("model")
        or snapshot.get("speech_model")
        or ""
    )
    voice_settings["model"] = resolved_model
    current_hash = speech_source_hash(
        str(segment["text"]),
        voice_settings,
        resolved_model,
    )
    if (
        int(segment.get("generation_revision") or 0)
        != int(snapshot.get("generation_revision") or 0)
        or current_hash != snapshot.get("source_hash")
    ):
        raise StaleTextVideoJob("配音段落已更新")
    return segment


def _request_key(project_id: int, snapshot: dict) -> str:
    canonical = json.dumps(
        {
            "segment_id": snapshot["segment_id"],
            "generation_revision": snapshot["generation_revision"],
            "source_hash": snapshot["source_hash"],
        },
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    request_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return f"text-video-speech:{project_id}:{request_hash}"


def _asset_path(asset: CreativeAsset) -> Path | None:
    prefix = "/api/uploads/"
    if not asset.url.startswith(prefix):
        return None
    relative = asset.url[len(prefix):]
    if not relative or "?" in relative or "#" in relative:
        return None
    root = Path(UPLOADS_DIR).resolve()
    candidate = (root / relative).resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        return None
    return candidate if candidate.is_file() else None


async def speech_asset_result(
    db: AsyncSession,
    *,
    source_hash: str,
    audio_url: str = "",
) -> dict | None:
    query = (
        select(TextVideoSpeechAsset, CreativeAsset)
        .join(
            CreativeAsset,
            CreativeAsset.id == TextVideoSpeechAsset.creative_asset_id,
        )
        .where(TextVideoSpeechAsset.source_hash == source_hash)
        .order_by(
            TextVideoSpeechAsset.created_at.desc(),
            TextVideoSpeechAsset.id.desc(),
        )
    )
    if audio_url:
        query = query.where(CreativeAsset.url == audio_url)
    rows = (await db.execute(query)).all()
    for metadata, asset in rows:
        if _asset_path(asset) is None:
            continue
        sample_rate = int(metadata.sample_rate or 0)
        sample_count = int(metadata.sample_count or 0)
        duration = (
            sample_count / sample_rate
            if sample_rate > 0 and sample_count > 0
            else float(metadata.duration)
        )
        return {
            "asset_id": asset.id,
            "audio_url": asset.url,
            "duration": duration,
            "sample_count": sample_count,
            "sample_rate": sample_rate,
            "word_timings": deepcopy(metadata.word_timings or []),
            "provider_request_id": metadata.provider_request_id,
        }
    return None


async def recoverable_speech_asset_result(
    db: AsyncSession,
    project: TextVideoProject,
    job: ContentJob,
) -> dict | None:
    """Return only an exact, durable result written by this speech job."""
    snapshot = job.input_data if isinstance(job.input_data, dict) else {}
    if (
        job.flow != "text_video_speech"
        or snapshot.get("project_id") != project.id
        or not isinstance(snapshot.get("source_hash"), str)
    ):
        return None
    try:
        segment = assert_current_speech_job(project, snapshot)
    except StaleTextVideoJob:
        return None
    if (
        segment.get("status") not in {"ready", "confirmed"}
        or segment.get("job_id") is not None
        or segment.get("source_hash") != snapshot["source_hash"]
        or not isinstance(segment.get("audio_url"), str)
        or not segment["audio_url"]
    ):
        return None
    result = await speech_asset_result(
        db,
        source_hash=snapshot["source_hash"],
        audio_url=segment["audio_url"],
    )
    if result is None:
        return None
    metadata_rows = (
        await db.execute(
            select(TextVideoSpeechAsset, CreativeAsset)
            .join(
                CreativeAsset,
                CreativeAsset.id
                == TextVideoSpeechAsset.creative_asset_id,
            )
            .where(
                TextVideoSpeechAsset.creative_asset_id
                == result["asset_id"],
                TextVideoSpeechAsset.source_hash
                == snapshot["source_hash"],
            ),
        )
    ).all()
    if len(metadata_rows) != 1:
        return None
    metadata, asset = metadata_rows[0]
    sample_count = result["sample_count"]
    sample_rate = result["sample_rate"]
    expected_duration = (
        sample_count / sample_rate
        if (
            isinstance(sample_count, int)
            and not isinstance(sample_count, bool)
            and sample_count > 0
            and isinstance(sample_rate, int)
            and not isinstance(sample_rate, bool)
            and sample_rate > 0
        )
        else 0
    )
    segment_duration = segment.get("duration")
    if (
        expected_duration <= 0
        or asset.asset_type != "media"
        or asset.media_kind != "audio"
        or asset.title != "文字视频口播配音"
        or asset.media_type != "audio/mpeg"
        or asset.filename != Path(asset.url).name
        or asset.source != "generated"
        or metadata.sample_count != sample_count
        or metadata.sample_rate != sample_rate
        or not math.isclose(
            float(metadata.duration),
            expected_duration,
            rel_tol=0,
            abs_tol=1e-9,
        )
        or isinstance(segment_duration, bool)
        or not isinstance(segment_duration, (int, float))
        or not math.isclose(
            float(segment_duration),
            expected_duration,
            rel_tol=0,
            abs_tol=1e-9,
        )
        or segment.get("word_timings") != result["word_timings"]
        or metadata.word_timings != result["word_timings"]
        or metadata.provider_request_id
        != result["provider_request_id"]
    ):
        return None
    return result


def mark_text_video_downstream_stale(project: TextVideoProject) -> None:
    master = empty_master_audio() | deepcopy(project.master_audio or {})
    if master["status"] != "missing":
        master["status"] = "stale"
    if master["timeline_status"] != "missing":
        master["timeline_status"] = "stale"
    master["job_id"] = None
    master["error"] = ""
    master["timeline_error"] = ""
    project.master_audio = master
    scene = empty_scene_plan() | deepcopy(project.scene_plan or {})
    if scene["status"] != "missing":
        scene["status"] = "stale"
    scene["job_id"] = None
    scene["error"] = ""
    project.scene_plan = scene
    render_input = deepcopy(project.render_input or {})
    render_input["audio"] = ""
    project.render_input = render_input


async def _locked_project(
    db: AsyncSession,
    project: TextVideoProject,
    expected_revision: int,
) -> TextVideoProject:
    locked = await db.scalar(
        select(TextVideoProject)
        .where(TextVideoProject.id == project.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if locked is None:
        raise StaleTextVideoJob("文字视频作品不存在")
    if locked.revision != expected_revision:
        raise StaleTextVideoJob("作品已在其他页面更新")
    return locked


async def _active_job(
    db: AsyncSession,
    segment: dict,
    snapshot: dict,
) -> ContentJob | None:
    job_id = segment.get("job_id")
    if not isinstance(job_id, int):
        return None
    job = await db.get(ContentJob, job_id)
    if (
        job is not None
        and job.flow == "text_video_speech"
        and job.status in ACTIVE_JOB_STATUSES
        and job.input_data.get("segment_id") == snapshot["segment_id"]
        and job.input_data.get("generation_revision")
        == snapshot["generation_revision"]
        and job.input_data.get("source_hash") == snapshot["source_hash"]
    ):
        return job
    return None


async def _launch(
    db: AsyncSession,
    project: TextVideoProject,
    segment_ids: Iterable[str],
    *,
    speech_model: str,
    speech_default_voice: str,
    reuse_assets: bool,
) -> SpeechLaunchResult:
    paragraphs = normalize_speech_segments(
        str(project.script or ""),
        project.paragraphs or [],
    )
    by_id = {segment["id"]: index for index, segment in enumerate(paragraphs)}
    jobs: list[ContentJob] = []
    jobs_to_enqueue: list[ContentJob] = []
    reused: list[str] = []

    voice_settings = deepcopy(project.voice_settings or {})
    resolved_model = str(voice_settings.get("model") or speech_model)
    resolved_voice = str(
        voice_settings.get("voice_id")
        or speech_default_voice
        or "mimo_default"
    )
    if (
        voice_settings.get("model") != resolved_model
        or voice_settings.get("voice_id") != resolved_voice
    ):
        voice_settings = {
            **voice_settings,
            "model": resolved_model,
            "voice_id": resolved_voice,
        }
        project.voice_settings = voice_settings

    for segment_id in segment_ids:
        index = by_id.get(segment_id)
        if index is None:
            raise StaleTextVideoJob("配音段落已更新")
        segment = deepcopy(paragraphs[index])
        if not str(segment["text"]).strip():
            continue
        snapshot = freeze_speech_job_input(
            project,
            segment_id,
            model=resolved_model,
        )
        active = await _active_job(db, segment, snapshot)
        if active is not None:
            jobs.append(active)
            if active.status == "queued":
                jobs_to_enqueue.append(active)
            continue

        if reuse_assets:
            reusable = await speech_asset_result(
                db,
                source_hash=snapshot["source_hash"],
            )
            if reusable is not None:
                paragraphs[index] = {
                    **segment,
                    "status": "ready",
                    "audio_url": reusable["audio_url"],
                    "duration": reusable["duration"],
                    "word_timings": reusable["word_timings"],
                    "source_hash": snapshot["source_hash"],
                    "error": "",
                    "job_id": None,
                }
                reused.append(segment_id)
                mark_text_video_downstream_stale(project)
                continue

        if segment["status"] in {"ready", "confirmed", "failed", "generating"}:
            segment["generation_revision"] = (
                int(segment["generation_revision"]) + 1
            )
            paragraphs[index] = segment
            project.paragraphs = deepcopy(paragraphs)
            snapshot = freeze_speech_job_input(
                project,
                segment_id,
                model=resolved_model,
            )
        key = _request_key(project.id, snapshot)
        job = await create_or_get_job(
            db,
            flow="text_video_speech",
            title=f"生成口播配音 · {project.title}",
            input_data=snapshot,
            idempotency_key=key,
            commit=False,
        )
        if job.status not in ACTIVE_JOB_STATUSES:
            segment["generation_revision"] = (
                int(segment["generation_revision"]) + 1
            )
            paragraphs[index] = segment
            project.paragraphs = deepcopy(paragraphs)
            snapshot = freeze_speech_job_input(
                project,
                segment_id,
                model=resolved_model,
            )
            job = await create_or_get_job(
                db,
                flow="text_video_speech",
                title=f"生成口播配音 · {project.title}",
                input_data=snapshot,
                idempotency_key=_request_key(project.id, snapshot),
                commit=False,
            )
        paragraphs[index] = {
            **segment,
            "status": "generating",
            "audio_url": "",
            "duration": 0.0,
            "word_timings": [],
            "source_hash": snapshot["source_hash"],
            "generation_revision": snapshot["generation_revision"],
            "error": "",
            "job_id": job.id,
        }
        jobs.append(job)
        if job.status == "queued":
            jobs_to_enqueue.append(job)
        mark_text_video_downstream_stale(project)

    project.paragraphs = deepcopy(paragraphs)
    await db.commit()
    await db.refresh(project)
    for job in jobs:
        await db.refresh(job)
    for job in jobs_to_enqueue:
        await enqueue_job(job.id)
    return SpeechLaunchResult(
        jobs=jobs,
        reused_segment_ids=reused,
        project=project,
    )


async def launch_speech_job(
    db: AsyncSession,
    project: TextVideoProject,
    segment_id: str,
    *,
    expected_revision: int,
    speech_model: str,
    speech_default_voice: str = "mimo_default",
) -> SpeechLaunchResult:
    project = await _locked_project(db, project, expected_revision)
    return await _launch(
        db,
        project,
        [segment_id],
        speech_model=speech_model,
        speech_default_voice=speech_default_voice,
        reuse_assets=False,
    )


async def launch_pending_speech_jobs(
    db: AsyncSession,
    project: TextVideoProject,
    *,
    expected_revision: int,
    speech_model: str,
    speech_default_voice: str = "mimo_default",
) -> SpeechLaunchResult:
    project = await _locked_project(db, project, expected_revision)
    segment_ids = [
        segment["id"]
        for segment in normalize_speech_segments(
            str(project.script or ""),
            project.paragraphs or [],
        )
        if (
            segment["status"] in {"draft", "failed"}
            or (
                segment["status"] == "generating"
                and isinstance(segment.get("job_id"), int)
            )
        )
    ]
    return await _launch(
        db,
        project,
        segment_ids,
        speech_model=speech_model,
        speech_default_voice=speech_default_voice,
        reuse_assets=True,
    )
