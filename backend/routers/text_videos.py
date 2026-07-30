import asyncio
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime
import hashlib
import json
import math
from pathlib import Path
from typing import Any, Literal
from uuid import uuid4

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    Header,
    HTTPException,
    Response,
    UploadFile,
    status,
)
from loguru import logger
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictInt,
    model_validator,
)
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
)
from sqlalchemy.pool import StaticPool

from database import (
    DATABASE_COMMAND_TIMEOUT_SECONDS,
    defer_session_close_until_task_terminal,
    get_db,
)
from config import get_config
from content_jobs import create_or_get_job, lock_content_job_row
from job_queue import enqueue_job
from log_redaction import redact_secret_text
from models import (
    ContentJob,
    ContentJobStep,
    CreativeAsset,
    TextVideoProject,
    TextVideoSpeechAsset,
    now_utc,
)
from text_video_domain import (
    default_speech_segment,
    empty_master_audio,
    empty_render_state,
    empty_scene_plan,
    merge_editable_project,
    normalize_speech_segments,
    video_stage_open,
)
from text_video_scene_plan import (
    CONTINUITY_EPSILON_SECONDS,
    canonicalize_scene_generation_proposal,
    resolve_scene_seconds,
    validate_canonical_scene_result,
    validate_render_input_projection,
    validate_scene_partition,
    validate_template_configuration,
    validate_word_timeline,
)
from text_video_templates import (
    get_text_video_template,
    normalize_text_video_template_default_map,
)
from text_video_render import launch_text_video_render
from text_video_jobs import (
    StaleTextVideoJob,
    assert_current_speech_job,
    launch_pending_speech_jobs,
    launch_speech_job,
    mark_text_video_downstream_stale,
    speech_asset_result,
)
from media_command import MediaCommandError, MediaToolUnavailable
from speech_upload_boundary import MAX_SPEECH_AUDIO_BYTES
from storage_paths import UPLOADS_DIR
from text_video_audio import (
    SUPPORTED_MEDIA_TYPES,
    save_text_video_audio_asset,
)
from text_video_alignment import (
    AlignmentError,
    align_transcript_words,
    build_global_timeline,
)
from text_video_master import (
    MasterAlignmentFailedError,
    MasterBusyError,
    MasterStateError,
    StaleMasterJob,
    assemble_master,
    begin_master_alignment,
    complete_master_alignment,
    fail_master_audio,
    launch_master_audio,
)
from text_video_segmentation import (
    SegmentationError,
    build_boundary_candidates,
    slice_at_boundary_ids,
    speakable_character_count,
)
from text_video_transcription import (
    TranscriptionError,
    transcribe_audio_words,
)
from worker_auth import require_worker_token


router = APIRouter(prefix="/text-videos", tags=["text-videos"])
SPEECH_DB_OPERATION_TIMEOUT_SECONDS = min(
    DATABASE_COMMAND_TIMEOUT_SECONDS + 5,
    305,
)
SPEECH_DB_CANCEL_GRACE_SECONDS = 1.0
SPEECH_DB_VERIFICATION_TIMEOUT_SECONDS = 6.0
_DETACHED_SPEECH_DB_TASKS: set[asyncio.Task] = set()
_MASTER_ALIGNMENT_LOCKS: dict[tuple[int, int], asyncio.Lock] = {}


class WordTimingDocument(BaseModel):
    id: str
    text: str
    start: float = Field(ge=0)
    end: float = Field(ge=0)


class SpeechSegmentDocument(BaseModel):
    id: str = Field(min_length=1)
    text: str = ""
    duration: float = Field(default=0, ge=0)
    status: Literal["draft", "generating", "ready", "confirmed", "failed"] = "draft"
    audio_url: str = ""
    word_timings: list[WordTimingDocument] = Field(default_factory=list)
    source_hash: str = ""
    generation_revision: int = Field(default=0, ge=0)
    error: str = ""
    job_id: int | None = None


class SpeechSegmentEdit(BaseModel):
    id: str = Field(min_length=1)
    text: str = ""


class VoiceSettingsDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")

    voice_id: str = ""
    model: str = ""
    speed: float = Field(default=1, ge=0.5, le=2)
    volume: float = Field(default=1, ge=0, le=2)
    pitch: float = Field(default=0, ge=-12, le=12)


class CompositionDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")

    width: StrictInt = Field(gt=0, le=9_007_199_254_740_991)
    height: StrictInt = Field(gt=0, le=9_007_199_254_740_991)
    fps: StrictInt = Field(gt=0, le=9_007_199_254_740_991)

    @model_validator(mode="after")
    def supported_ratio(self):
        if not (
            self.width == self.height
            or self.width * 16 == self.height * 9
            or self.width * 9 == self.height * 16
        ):
            raise ValueError("画面比例仅支持 9:16、16:9 或 1:1")
        return self


class SegmentDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1)
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    text: str = Field(min_length=1)
    highlight: list[str] = Field(default_factory=list)
    animation: str = Field(min_length=1)

    @model_validator(mode="after")
    def valid_time_range(self):
        if self.end <= self.start:
            raise ValueError("分镜结束时间必须晚于开始时间")
        return self


class RenderInputDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")

    templateId: str = Field(min_length=1)
    templateVersion: StrictInt = Field(
        ge=1,
        le=9_007_199_254_740_991,
    )
    composition: CompositionDocument
    audio: str = ""
    segments: list[SegmentDocument] = Field(min_length=1)
    templateProps: dict[str, Any]

    @model_validator(mode="after")
    def ordered_segments(self):
        if abs(self.segments[0].start) > CONTINUITY_EPSILON_SECONDS:
            raise ValueError("分镜必须从主音频零点开始")
        for index in range(1, len(self.segments)):
            if abs(
                self.segments[index].start
                - self.segments[index - 1].end
            ) > CONTINUITY_EPSILON_SECONDS:
                raise ValueError("分镜必须连续且按时间排序")
        return self


class TemplateSelectionDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")

    templateId: str = Field(min_length=1)
    templateVersion: StrictInt = Field(
        ge=1,
        le=9_007_199_254_740_991,
    )
    templateProps: dict[str, Any] = Field(default_factory=dict)


class ScenePlanSceneEdit(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1)
    fromWordId: str = Field(min_length=1)
    throughWordId: str = Field(min_length=1)
    displayText: str = Field(min_length=1)
    highlight: list[str] = Field(default_factory=list)
    animation: str = Field(min_length=1)


class ScenePlanEdit(BaseModel):
    model_config = ConfigDict(extra="forbid")

    generation_revision: StrictInt | None = Field(default=None, ge=0)
    scenes: list[ScenePlanSceneEdit]


class ScenePlanGenerateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    revision: StrictInt = Field(ge=1)
    scope: Literal["all", "selected"] = "all"
    selected_scene_id: str = Field(default="", max_length=200)
    direction: str = Field(default="", max_length=1_000)

    @model_validator(mode="after")
    def validate_selected_scene(self):
        if self.scope == "selected" and not self.selected_scene_id.strip():
            raise ValueError("选中分镜生成必须指定目标分镜")
        if self.scope == "all" and self.selected_scene_id:
            raise ValueError("全量分镜生成不能指定目标分镜")
        return self


class ScenePlanWorkerProposalRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scenes: list[ScenePlanSceneEdit] = Field(min_length=1)


class ScenePlanWorkerResultRequest(ScenePlanWorkerProposalRequest):
    validation_token: str = Field(
        min_length=64,
        max_length=64,
        pattern=r"^[a-fA-F0-9]{64}$",
    )


class ScenePlanWorkerFailureRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    error: str = Field(min_length=1, max_length=500)


class ProjectCreate(BaseModel):
    title: str = Field(default="未命名文字视频", max_length=300)


class ProjectUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    revision: int = Field(ge=1)
    title: str | None = Field(default=None, max_length=300)
    status: Literal["draft", "audio_ready", "video_ready", "completed", "archived"] | None = None
    stage: Literal["script", "audio", "video"] | None = None
    script: str | None = None
    voice_settings: VoiceSettingsDocument | None = None
    paragraphs: list[SpeechSegmentEdit] | None = None
    speech_split_mode: Literal["single", "auto", "manual"] | None = None
    composition: CompositionDocument | None = None
    template: TemplateSelectionDocument | None = None
    scene_plan: ScenePlanEdit | None = None
    cover_asset_url: str | None = None
    output_asset_url: str | None = None


class SpeechSplitPreviewRequest(BaseModel):
    revision: int = Field(ge=1)
    direction: str = Field(default="", max_length=1_000)


class SpeechSplitWorkerValidationRequest(BaseModel):
    boundary_ids: list[str] = Field(default_factory=list)
    script_hash: str = Field(min_length=64, max_length=64)


class SpeechActionRequest(BaseModel):
    revision: int = Field(ge=1)


class SpeechConfirmRequest(SpeechActionRequest):
    generation_revision: int = Field(ge=0)
    source_hash: str = Field(min_length=64, max_length=64)


class SpeechWorkerFailureRequest(BaseModel):
    generation_revision: int = Field(ge=0)
    source_hash: str = Field(min_length=64, max_length=64)
    error: str = Field(min_length=1, max_length=500)


class MasterAlignRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_hash: str = Field(min_length=64, max_length=64)
    step_id: StrictInt = Field(ge=1)
    attempt: StrictInt = Field(ge=1)
    claim_token: str = Field(min_length=16, max_length=128)


class MasterWorkerFailureRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_hash: str = Field(min_length=64, max_length=64)
    phase: Literal[
        "assemble_master_audio",
        "align_master_timeline",
    ]
    error: str = Field(min_length=1, max_length=500)
    step_id: StrictInt | None = Field(default=None, ge=1)
    attempt: StrictInt | None = Field(default=None, ge=1)
    claim_token: str | None = Field(
        default=None,
        min_length=16,
        max_length=128,
    )

    @model_validator(mode="after")
    def validate_alignment_claim(self):
        claim = (self.step_id, self.attempt, self.claim_token)
        if (
            self.phase == "align_master_timeline"
            and any(value is None for value in claim)
        ):
            raise ValueError("对齐失败上报必须携带 step/attempt/claim")
        if (
            self.phase == "assemble_master_audio"
            and any(value is not None for value in claim)
        ):
            raise ValueError("拼接失败上报不能携带对齐 claim")
        return self


DEFAULT_PARAGRAPHS = [default_speech_segment("", segment_id="paragraph-1")]

DEFAULT_RENDER_INPUT = {
    "templateId": "tech-text-v1",
    "templateVersion": 1,
    "composition": {"width": 1080, "height": 1920, "fps": 30},
    "audio": "",
    "segments": [{
        "id": "scene-1",
        "start": 0,
        "end": 2.4,
        "text": "在这里输入稿件",
        "highlight": [],
        "animation": "fade-up",
    }],
    "templateProps": {
        "theme": "tech-blue",
        "font": "source-han-sans",
        "background": "dark-grid",
        "transition": "soft-push",
        "textDensity": "standard",
        "brandTitle": "EDIORA",
        "brandSubtitle": "述策",
        "showBrand": True,
        "accentColor": "#69F6FF",
        "showProgress": True,
        "showSceneNumber": True,
    },
}

EDITABLE_PROJECT_FIELDS = (
    "title",
    "status",
    "stage",
    "script",
    "voice_settings",
    "paragraphs",
    "speech_split_mode",
    "master_audio",
    "scene_plan",
    "render_input",
    "cover_asset_url",
    "output_asset_url",
    "output_stale",
)


def serialize_project(project: TextVideoProject, *, summary: bool = False) -> dict[str, Any]:
    render_input = project.render_input or DEFAULT_RENDER_INPUT
    master_audio = empty_master_audio() | (project.master_audio or {})
    master_duration = master_audio.get("duration")
    duration = (
        float(master_duration)
        if (
            master_audio.get("status") == "ready"
            and isinstance(master_duration, (int, float))
            and not isinstance(master_duration, bool)
            and math.isfinite(master_duration)
            and master_duration > 0
        )
        else 0.0
    )
    data = {
        "id": project.id,
        "title": project.title,
        "status": project.status,
        "stage": project.stage,
        "cover_asset_url": project.cover_asset_url,
        "output_asset_url": project.output_asset_url,
        "output_stale": project.output_stale,
        "render_state": (
            empty_render_state()
            | (project.render_state or {})
        ),
        "revision": project.revision,
        "duration": duration,
        "aspect_ratio": _aspect_ratio(render_input),
        "created_at": _iso(project.created_at),
        "updated_at": _iso(project.updated_at),
    }
    if not summary:
        data.update({
            "script": project.script,
            "voice_settings": project.voice_settings or {},
            "paragraphs": normalize_speech_segments(
                project.script or "",
                project.paragraphs or [],
            ),
            "speech_split_mode": project.speech_split_mode or "single",
            "master_audio": master_audio,
            "scene_plan": empty_scene_plan() | (project.scene_plan or {}),
            "render_input": render_input,
        })
    return data


def _aspect_ratio(render_input: dict[str, Any]) -> str:
    composition = render_input.get("composition") or {}
    width = composition.get("width")
    height = composition.get("height")
    if width == height:
        return "1:1"
    return "16:9" if width and height and width > height else "9:16"


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


async def get_project_or_404(db: AsyncSession, project_id: int) -> TextVideoProject:
    project = await db.get(TextVideoProject, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="文字视频作品不存在")
    return project


async def _lock_text_video_project_row(
    db: AsyncSession,
    project_id: int,
) -> TextVideoProject | None:
    await db.execute(
        update(TextVideoProject)
        .where(TextVideoProject.id == project_id)
        .values(revision=TextVideoProject.revision)
    )
    return await db.scalar(
        select(TextVideoProject)
        .where(TextVideoProject.id == project_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )


@router.get("")
async def list_projects(
    project_status: Literal["draft", "audio_ready", "video_ready", "completed", "archived"] | None = None,
    db: AsyncSession = Depends(get_db),
):
    query = select(TextVideoProject)
    if project_status:
        query = query.where(TextVideoProject.status == project_status)
    projects = (
        await db.execute(query.order_by(TextVideoProject.updated_at.desc()))
    ).scalars().all()
    return [serialize_project(project, summary=True) for project in projects]


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_project(payload: ProjectCreate, db: AsyncSession = Depends(get_db)):
    title = payload.title.strip() or "未命名文字视频"
    config = await get_config()
    try:
        stored_template_defaults = json.loads(
            config.get("text_video_template_defaults", "{}"),
        )
        template_defaults = normalize_text_video_template_default_map(
            stored_template_defaults,
        )
    except (json.JSONDecodeError, TypeError, ValueError) as error:
        logger.warning(
            "Ignoring malformed text video template defaults on creation: {}",
            error,
        )
        template_defaults = normalize_text_video_template_default_map(None)
    render_input = deepcopy(DEFAULT_RENDER_INPUT)
    render_input["templateProps"] = deepcopy(
        template_defaults["tech-text-v1@1"],
    )
    try:
        manifest = get_text_video_template(
            render_input["templateId"],
            render_input["templateVersion"],
        )
        _, render_input["templateProps"] = validate_template_configuration(
            manifest=manifest,
            composition=render_input["composition"],
            template_props=render_input["templateProps"],
        )
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    project = TextVideoProject(
        title=title,
        status="draft",
        stage="script",
        script="",
        voice_settings={
            "voice_id": "",
            "model": "",
            "speed": 1,
            "volume": 1,
            "pitch": 0,
        },
        paragraphs=deepcopy(DEFAULT_PARAGRAPHS),
        speech_split_mode="single",
        master_audio=empty_master_audio(),
        scene_plan=empty_scene_plan(),
        render_input=render_input,
        revision=1,
    )
    db.add(project)
    await db.commit()
    await db.refresh(project)
    return serialize_project(project)


@router.get("/{project_id}")
async def get_project(project_id: int, db: AsyncSession = Depends(get_db)):
    return serialize_project(await get_project_or_404(db, project_id))


@router.patch("/{project_id}")
async def update_project(
    project_id: int,
    payload: ProjectUpdate,
    db: AsyncSession = Depends(get_db),
):
    project = await _lock_text_video_project_row(db, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="文字视频作品不存在")
    if project.revision != payload.revision:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "作品已在其他页面更新",
                "revision": project.revision,
            },
        )

    changes = payload.model_dump(exclude_unset=True, exclude={"revision"}, mode="json")
    scene_update = changes.get("scene_plan")
    if isinstance(scene_update, dict):
        current_plan = (
            empty_scene_plan()
            | deepcopy(project.scene_plan or {})
        )
        requested_scenes = scene_update["scenes"]
        if (
            requested_scenes != current_plan["scenes"]
            and scene_update.get("generation_revision")
            != current_plan["generation_revision"]
        ):
            raise HTTPException(
                status_code=409,
                detail={
                    "message": "AI 分镜已在其他页面更新",
                    "revision": project.revision,
                    "generation_revision": (
                        current_plan["generation_revision"]
                    ),
                },
                headers={"X-WMS-Retryable": "false"},
            )
        scene_update.pop("generation_revision", None)
    if changes.get("title") is not None:
        changes["title"] = changes["title"].strip() or "未命名文字视频"
    before = {
        field: deepcopy(getattr(project, field))
        for field in EDITABLE_PROJECT_FIELDS
    }
    try:
        merge_editable_project(
            project,
            changes,
            speech_model=(
                (project.voice_settings or {}).get("model")
                or "mimo-v2.5-tts"
            ),
        )
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    if all(
        getattr(project, field) == value
        for field, value in before.items()
    ):
        return serialize_project(project)
    if project.stage == "video" and not video_stage_open(project):
        raise HTTPException(
            status_code=422,
            detail="进入视频合成前请先确认所有配音并生成主音频时间轴",
        )
    project.revision += 1
    project.updated_at = now_utc()
    await db.commit()
    await db.refresh(project)
    return serialize_project(project)


def _script_hash(script: str) -> str:
    return hashlib.sha256(script.encode("utf-8")).hexdigest()


def _split_preview_request_hash(
    *,
    revision: int,
    script_hash: str,
    direction: str,
) -> str:
    canonical = json.dumps(
        {
            "direction": direction,
            "revision": revision,
            "script_hash": script_hash,
        },
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _public_candidate(candidate) -> dict[str, str]:
    return {
        "id": candidate.id,
        "kind": candidate.kind,
        "context": candidate.context,
    }


def _speech_split_preview_job_payload(job: ContentJob, project_id: int) -> dict:
    return {
        "id": job.id,
        "flow": job.flow,
        "target_id": project_id,
    }


def _speech_job_payload(job: ContentJob) -> dict:
    return {
        "id": job.id,
        "flow": job.flow,
        "target_id": str(job.input_data.get("segment_id") or ""),
    }


def _master_job_payload(job: ContentJob) -> dict:
    return {
        "id": job.id,
        "flow": job.flow,
        "target_id": int(job.input_data["project_id"]),
    }


def _render_job_payload(job: ContentJob, project_id: int) -> dict:
    return {
        "id": job.id,
        "flow": job.flow,
        "target_id": project_id,
    }


def _stale_conflict(error: Exception) -> HTTPException:
    return HTTPException(
        status_code=409,
        detail=str(error),
        headers={"X-WMS-Retryable": "false"},
    )


class StaleScenePlanJob(ValueError):
    pass


class ScenePlanClaimConflict(ValueError):
    pass


def _scene_claim_conflict() -> HTTPException:
    return HTTPException(
        status_code=409,
        detail={
            "code": "scene_claim_conflict",
            "message": "AI 分镜步骤已被其他 worker 领取",
        },
        headers={"X-WMS-Retryable": "false"},
    )


def _canonical_digest(value: Any) -> str:
    canonical = json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _scene_plan_document(project: TextVideoProject) -> dict[str, Any]:
    return empty_scene_plan() | deepcopy(project.scene_plan or {})


def _scene_master_snapshot(project: TextVideoProject) -> dict[str, Any]:
    master = empty_master_audio() | deepcopy(project.master_audio or {})
    if (
        master.get("status") != "ready"
        or master.get("timeline_status") != "ready"
        or not isinstance(master.get("source_hash"), str)
        or len(master["source_hash"]) != 64
        or not master.get("audio_url")
    ):
        raise ValueError("AI 分镜需要已就绪的当前主音频时间轴")
    words = validate_word_timeline(
        master.get("word_timings"),
        master.get("duration"),
    )
    master["word_timings"] = words
    return master


def _scene_template_snapshot(
    project: TextVideoProject,
) -> tuple[dict, dict, dict, str, str]:
    render_input = deepcopy(project.render_input or {})
    template_id = render_input.get("templateId")
    template_version = render_input.get("templateVersion")
    manifest = get_text_video_template(template_id, template_version)
    composition, template_props = validate_template_configuration(
        manifest=manifest,
        composition=render_input.get("composition"),
        template_props=render_input.get("templateProps"),
    )
    manifest_digest = _canonical_digest(manifest)
    visual_fingerprint = _canonical_digest({
        "template_id": manifest["id"],
        "template_version": manifest["version"],
        "composition": composition,
        "template_props": template_props,
    })
    return (
        manifest,
        composition,
        template_props,
        manifest_digest,
        visual_fingerprint,
    )


def _scene_timeline_fingerprint(master: dict[str, Any]) -> str:
    return _canonical_digest({
        "source_hash": master["source_hash"],
        "duration": master["duration"],
        "words": master["word_timings"],
    })


def _scene_speech_boundaries(words: list[dict]) -> list[dict[str, str]]:
    boundaries: list[dict[str, str]] = []
    closed: set[str] = set()
    for word in words:
        segment_id = word.get("speech_segment_id")
        if not isinstance(segment_id, str) or not segment_id:
            raise ValueError("主音频词时间轴缺少口播段归属")
        if not boundaries or boundaries[-1]["id"] != segment_id:
            if segment_id in closed:
                raise ValueError("主音频词时间轴的口播段必须连续")
            if boundaries:
                closed.add(boundaries[-1]["id"])
            boundaries.append({
                "id": segment_id,
                "fromWordId": word["id"],
                "throughWordId": word["id"],
            })
        else:
            boundaries[-1]["throughWordId"] = word["id"]
    return boundaries


def _scene_request_hash(snapshot: dict[str, Any]) -> str:
    return _canonical_digest({
        "master_source_hash": snapshot["master_source_hash"],
        "timeline_fingerprint": snapshot["timeline_fingerprint"],
        "scene_generation_revision": snapshot[
            "scene_generation_revision"
        ],
        "template_id": snapshot["template_id"],
        "template_version": snapshot["template_version"],
        "manifest_digest": snapshot["manifest_digest"],
        "visual_selection_fingerprint": snapshot[
            "visual_selection_fingerprint"
        ],
        "existing_scenes_digest": snapshot["existing_scenes_digest"],
        "scope": snapshot["scope"],
        "selected_scene_id": snapshot["selected_scene_id"],
        "direction": snapshot["direction"],
    })


def _freeze_scene_job_input(
    project: TextVideoProject,
    payload: ScenePlanGenerateRequest,
) -> dict[str, Any]:
    master = _scene_master_snapshot(project)
    (
        manifest,
        composition,
        template_props,
        manifest_digest,
        visual_fingerprint,
    ) = _scene_template_snapshot(project)
    plan = _scene_plan_document(project)
    existing_scenes = deepcopy(plan["scenes"])
    if payload.scope == "selected":
        if (
            plan["status"] != "ready"
            or plan["master_source_hash"] != master["source_hash"]
        ):
            raise ValueError("选中分镜生成需要当前有效的完整分镜计划")
        validate_scene_partition(
            existing_scenes,
            master["word_timings"],
            manifest,
        )
        if not any(
            scene["id"] == payload.selected_scene_id
            for scene in existing_scenes
        ):
            raise ValueError("目标分镜不存在")
    snapshot: dict[str, Any] = {
        "project_id": project.id,
        "project_revision": project.revision,
        "master_source_hash": master["source_hash"],
        "timeline_fingerprint": _scene_timeline_fingerprint(master),
        "scene_generation_revision": int(
            plan["generation_revision"] or 0,
        ),
        "script": str(project.script or ""),
        "words": deepcopy(master["word_timings"]),
        "speech_segments": _scene_speech_boundaries(
            master["word_timings"],
        ),
        "template_id": manifest["id"],
        "template_version": manifest["version"],
        "template": {
            "id": manifest["id"],
            "version": manifest["version"],
            "animations": deepcopy(manifest["animations"]),
            "transitions": deepcopy(manifest["transitions"]),
        },
        "composition": composition,
        "template_props": template_props,
        "manifest_digest": manifest_digest,
        "visual_selection_fingerprint": visual_fingerprint,
        "existing_scenes": existing_scenes,
        "existing_scenes_digest": _canonical_digest(existing_scenes),
        "scope": payload.scope,
        "selected_scene_id": payload.selected_scene_id,
        "direction": payload.direction,
    }
    snapshot["request_hash"] = _scene_request_hash(snapshot)
    snapshot["idempotency_key"] = (
        f"text-video-scene:{project.id}:{snapshot['request_hash']}"
    )
    if len(snapshot["idempotency_key"]) > 128:
        raise ValueError("AI 分镜任务唯一键过长")
    return snapshot


def _scene_job_payload(job: ContentJob, project_id: int) -> dict:
    return {
        "id": job.id,
        "flow": job.flow,
        "target_id": project_id,
    }


def _scene_current_job_statement(job_id: int):
    """Read the job after locking the project; never invert worker lock order."""
    return select(ContentJob).where(ContentJob.id == job_id)


def _validate_scene_job(
    job: ContentJob | None,
    *,
    project_id: int,
) -> dict[str, Any]:
    if (
        job is None
        or job.flow != "text_video_scene_plan"
    ):
        raise StaleScenePlanJob("AI 分镜任务快照无效")
    snapshot = job.input_data
    if not isinstance(snapshot, dict):
        raise StaleScenePlanJob("AI 分镜任务快照无效")
    try:
        expected_hash = _scene_request_hash(snapshot)
    except (KeyError, TypeError, ValueError, OverflowError) as error:
        raise StaleScenePlanJob("AI 分镜任务快照无效") from error
    request_hash = snapshot.get("request_hash")
    if (
        snapshot.get("project_id") != project_id
        or request_hash != expected_hash
        or snapshot.get("idempotency_key")
        != f"text-video-scene:{project_id}:{request_hash}"
    ):
        raise StaleScenePlanJob("AI 分镜任务快照无效")
    if job.status != "running":
        raise StaleScenePlanJob("AI 分镜任务已不再运行")
    return snapshot


def _validate_scene_claim_values(
    step_id: int,
    attempt: int,
    claim_token: str,
) -> None:
    if (
        isinstance(step_id, bool)
        or step_id <= 0
        or isinstance(attempt, bool)
        or attempt <= 0
        or not isinstance(claim_token, str)
        or not 16 <= len(claim_token) <= 128
    ):
        raise StaleScenePlanJob("AI 分镜步骤 claim 无效")


async def _require_scene_claim(
    db: AsyncSession,
    *,
    job_id: int,
    project_id: int,
    step_id: int,
    attempt: int,
    claim_token: str,
    acquire: bool,
) -> tuple[ContentJob, ContentJobStep, dict[str, Any]]:
    _validate_scene_claim_values(step_id, attempt, claim_token)
    job = await lock_content_job_row(db, job_id)
    snapshot = _validate_scene_job(job, project_id=project_id)
    step = await db.scalar(
        select(ContentJobStep)
        .where(
            ContentJobStep.id == step_id,
            ContentJobStep.job_id == job_id,
            ContentJobStep.step_key == "generate_scene_plan",
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    latest = await db.scalar(
        select(ContentJobStep)
        .where(
            ContentJobStep.job_id == job_id,
            ContentJobStep.step_key == "generate_scene_plan",
        )
        .order_by(
            ContentJobStep.attempt.desc(),
            ContentJobStep.id.desc(),
        )
    )
    if (
        step is None
        or latest is None
        or latest.id != step.id
        or step.attempt != attempt
        or step.status != "running"
    ):
        raise StaleScenePlanJob("AI 分镜步骤已失效")
    output = deepcopy(step.output_data or {})
    frozen_claim = output.get("_scene_claim")
    requested_claim = {
        "step_id": step_id,
        "attempt": attempt,
        "claim_token": claim_token,
    }
    if frozen_claim is None and acquire:
        step.output_data = {
            **output,
            "_scene_claim": requested_claim,
        }
    elif frozen_claim != requested_claim:
        raise ScenePlanClaimConflict(
            "AI 分镜步骤已被其他 worker 领取",
        )
    return job, step, snapshot


def _assert_scene_snapshot_current(
    project: TextVideoProject,
    job: ContentJob,
    snapshot: dict[str, Any],
) -> tuple[dict, dict, dict, dict]:
    plan = _scene_plan_document(project)
    master = _scene_master_snapshot(project)
    (
        manifest,
        composition,
        template_props,
        manifest_digest,
        visual_fingerprint,
    ) = _scene_template_snapshot(project)
    if (
        plan["status"] != "generating"
        or plan["job_id"] != job.id
        or int(plan["generation_revision"] or 0)
        != snapshot["scene_generation_revision"]
        or plan["scenes"] != snapshot["existing_scenes"]
        or _canonical_digest(plan["scenes"])
        != snapshot["existing_scenes_digest"]
        or master["source_hash"] != snapshot["master_source_hash"]
        or master["word_timings"] != snapshot["words"]
        or _scene_timeline_fingerprint(master)
        != snapshot["timeline_fingerprint"]
        or manifest["id"] != snapshot["template_id"]
        or manifest["version"] != snapshot["template_version"]
        or manifest_digest != snapshot["manifest_digest"]
        or visual_fingerprint
        != snapshot["visual_selection_fingerprint"]
    ):
        raise StaleScenePlanJob("AI 分镜任务快照已更新")
    return master, manifest, composition, template_props


def _scene_render_input(
    project: TextVideoProject,
    *,
    scenes: list[dict],
    master: dict,
    manifest: dict,
    composition: dict,
    template_props: dict,
) -> dict:
    segments = resolve_scene_seconds(
        proposals=scenes,
        words=master["word_timings"],
        master_duration=master["duration"],
        manifest=manifest,
    )
    return validate_render_input_projection(
        {
            "templateId": manifest["id"],
            "templateVersion": manifest["version"],
            "composition": composition,
            "audio": master["audio_url"],
            "segments": segments,
            "templateProps": template_props,
        },
        master_duration=master["duration"],
    )


def _scene_result_already_applied(
    project: TextVideoProject,
    job: ContentJob,
    snapshot: dict[str, Any],
) -> bool:
    try:
        plan = _scene_plan_document(project)
        master = _scene_master_snapshot(project)
        (
            manifest,
            composition,
            template_props,
            manifest_digest,
            visual_fingerprint,
        ) = _scene_template_snapshot(project)
        if not (
            plan["status"] == "ready"
            and plan["job_id"] is None
            and plan["applied_job_id"] == job.id
            and plan["generation_revision"]
            == snapshot["scene_generation_revision"] + 1
            and plan["master_source_hash"]
            == snapshot["master_source_hash"]
            and _scene_timeline_fingerprint(master)
            == snapshot["timeline_fingerprint"]
            and manifest_digest == snapshot["manifest_digest"]
            and visual_fingerprint
            == snapshot["visual_selection_fingerprint"]
        ):
            return False
        expected = _scene_render_input(
            project,
            scenes=plan["scenes"],
            master=master,
            manifest=manifest,
            composition=composition,
            template_props=template_props,
        )
        return deepcopy(project.render_input or {}) == expected
    except (KeyError, TypeError, ValueError, OverflowError):
        return False


def _scene_context(snapshot: dict[str, Any]) -> dict[str, Any]:
    return {
        key: deepcopy(snapshot[key])
        for key in (
            "project_id",
            "master_source_hash",
            "timeline_fingerprint",
            "scene_generation_revision",
            "script",
            "words",
            "speech_segments",
            "template",
            "existing_scenes",
            "scope",
            "selected_scene_id",
            "direction",
        )
    }


def _scene_validation_token(
    *,
    job: ContentJob,
    step: ContentJobStep,
    claim_token: str,
    scenes: list[dict],
) -> str:
    return _canonical_digest({
        "job_id": job.id,
        "request_hash": job.input_data["request_hash"],
        "step_id": step.id,
        "attempt": step.attempt,
        "claim_token": claim_token,
        "scenes": scenes,
    })


def _scene_validation_error(error: Exception) -> HTTPException:
    message = str(error)
    return HTTPException(
        status_code=422,
        detail={"message": message, "errors": [message]},
        headers={"X-WMS-Retryable": "false"},
    )


@router.post(
    "/{project_id}/scene-plan/generate",
    status_code=status.HTTP_201_CREATED,
)
async def generate_scene_plan(
    project_id: int,
    payload: ScenePlanGenerateRequest,
    db: AsyncSession = Depends(get_db),
):
    project = await db.scalar(
        select(TextVideoProject)
        .where(TextVideoProject.id == project_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if project is None:
        raise HTTPException(404, "文字视频作品不存在")
    if project.revision != payload.revision:
        raise HTTPException(
            409,
            {
                "message": "作品已在其他页面更新",
                "revision": project.revision,
            },
        )
    try:
        snapshot = _freeze_scene_job_input(project, payload)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    current_plan = _scene_plan_document(project)
    current_job_id = current_plan.get("job_id")
    current_job = (
        await db.scalar(
            _scene_current_job_statement(current_job_id)
            .execution_options(populate_existing=True)
        )
        if (
            isinstance(current_job_id, int)
            and not isinstance(current_job_id, bool)
        )
        else None
    )
    if (
        current_plan["status"] == "generating"
        and current_job is not None
        and current_job.flow == "text_video_scene_plan"
        and current_job.status in {"queued", "running"}
        and isinstance(current_job.input_data, dict)
    ):
        if (
            current_job.input_data.get("idempotency_key")
            != snapshot["idempotency_key"]
        ):
            raise HTTPException(
                409,
                "已有不同的 AI 分镜任务正在运行，请先等待或取消",
                headers={"X-WMS-Retryable": "false"},
            )
        job = current_job
    else:
        job = await create_or_get_job(
            db,
            flow="text_video_scene_plan",
            title=f"生成文字视频分镜 · {project.title}",
            input_data=snapshot,
            idempotency_key=snapshot["idempotency_key"],
            commit=False,
        )
    if job.status in {"queued", "running"}:
        plan = _scene_plan_document(project)
        plan.update({
            "status": "generating",
            "job_id": job.id,
            "error": "",
        })
        project.scene_plan = plan
    await db.commit()
    await db.refresh(project)
    await db.refresh(job)
    if job.status == "queued":
        await enqueue_job(job.id)
    return {
        "jobs": [_scene_job_payload(job, project_id)],
        "project": serialize_project(project),
    }


@router.get(
    "/{project_id}/scene-plan/worker-context",
    dependencies=[Depends(require_worker_token)],
)
async def get_scene_plan_worker_context(
    project_id: int,
    job_id: int = Header(alias="X-Content-Job-Id"),
    step_id: int = Header(alias="X-Content-Step-Id"),
    attempt: int = Header(alias="X-Content-Step-Attempt"),
    claim_token: str = Header(alias="X-Content-Step-Claim"),
    db: AsyncSession = Depends(get_db),
):
    try:
        job, _, snapshot = await _require_scene_claim(
            db,
            job_id=job_id,
            project_id=project_id,
            step_id=step_id,
            attempt=attempt,
            claim_token=claim_token,
            acquire=True,
        )
        project = await db.scalar(
            select(TextVideoProject)
            .where(TextVideoProject.id == project_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if project is None:
            raise StaleScenePlanJob("文字视频作品不存在")
        if _scene_result_already_applied(project, job, snapshot):
            await db.commit()
            return {"already_saved": serialize_project(project)}
        _assert_scene_snapshot_current(project, job, snapshot)
        await db.commit()
        return _scene_context(snapshot)
    except ScenePlanClaimConflict as error:
        await db.rollback()
        raise _scene_claim_conflict() from error
    except StaleScenePlanJob as error:
        await db.rollback()
        raise _stale_conflict(error) from error
    except ValueError as error:
        await db.rollback()
        raise _scene_validation_error(error) from error


@router.post(
    "/{project_id}/scene-plan/worker-validate",
    dependencies=[Depends(require_worker_token)],
)
async def validate_scene_plan_worker_result(
    project_id: int,
    payload: ScenePlanWorkerProposalRequest,
    job_id: int = Header(alias="X-Content-Job-Id"),
    step_id: int = Header(alias="X-Content-Step-Id"),
    attempt: int = Header(alias="X-Content-Step-Attempt"),
    claim_token: str = Header(alias="X-Content-Step-Claim"),
    db: AsyncSession = Depends(get_db),
):
    try:
        job, step, snapshot = await _require_scene_claim(
            db,
            job_id=job_id,
            project_id=project_id,
            step_id=step_id,
            attempt=attempt,
            claim_token=claim_token,
            acquire=False,
        )
        project = await db.scalar(
            select(TextVideoProject)
            .where(TextVideoProject.id == project_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if project is None:
            raise StaleScenePlanJob("文字视频作品不存在")
        master, manifest, composition, template_props = (
            _assert_scene_snapshot_current(
                project,
                job,
                snapshot,
            )
        )
        scenes = canonicalize_scene_generation_proposal(
            proposals=[
                item.model_dump(mode="json")
                for item in payload.scenes
            ],
            words=snapshot["words"],
            manifest=manifest,
            scope=snapshot["scope"],
            selected_scene_id=snapshot["selected_scene_id"],
            existing_scenes=snapshot["existing_scenes"],
        )
        _scene_render_input(
            project,
            scenes=scenes,
            master=master,
            manifest=manifest,
            composition=composition,
            template_props=template_props,
        )
        return {
            "scenes": scenes,
            "validation_token": _scene_validation_token(
                job=job,
                step=step,
                claim_token=claim_token,
                scenes=scenes,
            ),
        }
    except ScenePlanClaimConflict as error:
        await db.rollback()
        raise _scene_claim_conflict() from error
    except StaleScenePlanJob as error:
        await db.rollback()
        raise _stale_conflict(error) from error
    except ValueError as error:
        await db.rollback()
        raise _scene_validation_error(error) from error


@router.post(
    "/{project_id}/scene-plan/worker-result",
    dependencies=[Depends(require_worker_token)],
)
async def save_scene_plan_worker_result(
    project_id: int,
    payload: ScenePlanWorkerResultRequest,
    job_id: int = Header(alias="X-Content-Job-Id"),
    step_id: int = Header(alias="X-Content-Step-Id"),
    attempt: int = Header(alias="X-Content-Step-Attempt"),
    claim_token: str = Header(alias="X-Content-Step-Claim"),
    db: AsyncSession = Depends(get_db),
):
    try:
        job, step, snapshot = await _require_scene_claim(
            db,
            job_id=job_id,
            project_id=project_id,
            step_id=step_id,
            attempt=attempt,
            claim_token=claim_token,
            acquire=False,
        )
        raw_scenes = [
            item.model_dump(mode="json")
            for item in payload.scenes
        ]
        expected_token = _scene_validation_token(
            job=job,
            step=step,
            claim_token=claim_token,
            scenes=raw_scenes,
        )
        if payload.validation_token != expected_token:
            raise StaleScenePlanJob("AI 分镜校验凭证不匹配")
        project = await db.scalar(
            select(TextVideoProject)
            .where(TextVideoProject.id == project_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if project is None:
            raise StaleScenePlanJob("文字视频作品不存在")
        if _scene_result_already_applied(project, job, snapshot):
            return serialize_project(project)
        master, manifest, composition, template_props = (
            _assert_scene_snapshot_current(project, job, snapshot)
        )
        scenes = validate_canonical_scene_result(
            proposals=raw_scenes,
            words=snapshot["words"],
            manifest=manifest,
            scope=snapshot["scope"],
            selected_scene_id=snapshot["selected_scene_id"],
            existing_scenes=snapshot["existing_scenes"],
        )
        render_input = _scene_render_input(
            project,
            scenes=scenes,
            master=master,
            manifest=manifest,
            composition=composition,
            template_props=template_props,
        )
        project.scene_plan = {
            "status": "ready",
            "generation_revision": (
                snapshot["scene_generation_revision"] + 1
            ),
            "master_source_hash": master["source_hash"],
            "scenes": scenes,
            "job_id": None,
            "applied_job_id": job.id,
            "error": "",
        }
        project.render_input = render_input
        await db.commit()
        await db.refresh(project)
        return serialize_project(project)
    except ScenePlanClaimConflict as error:
        await db.rollback()
        raise _scene_claim_conflict() from error
    except StaleScenePlanJob as error:
        await db.rollback()
        raise _stale_conflict(error) from error
    except ValueError as error:
        await db.rollback()
        raise _scene_validation_error(error) from error


@router.post(
    "/{project_id}/scene-plan/worker-failure",
    dependencies=[Depends(require_worker_token)],
)
async def save_scene_plan_worker_failure(
    project_id: int,
    payload: ScenePlanWorkerFailureRequest,
    job_id: int = Header(alias="X-Content-Job-Id"),
    step_id: int = Header(alias="X-Content-Step-Id"),
    attempt: int = Header(alias="X-Content-Step-Attempt"),
    claim_token: str = Header(alias="X-Content-Step-Claim"),
    db: AsyncSession = Depends(get_db),
):
    try:
        job, _, snapshot = await _require_scene_claim(
            db,
            job_id=job_id,
            project_id=project_id,
            step_id=step_id,
            attempt=attempt,
            claim_token=claim_token,
            acquire=False,
        )
        project = await db.scalar(
            select(TextVideoProject)
            .where(TextVideoProject.id == project_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if project is None:
            raise StaleScenePlanJob("文字视频作品不存在")
        plan = _scene_plan_document(project)
        error_text = redact_secret_text(payload.error)[:500]
        if (
            plan["status"] == "failed"
            and plan["job_id"] == job.id
            and plan["generation_revision"]
            == snapshot["scene_generation_revision"]
            and plan["scenes"] == snapshot["existing_scenes"]
            and plan["error"] == error_text
        ):
            return serialize_project(project)
        _assert_scene_snapshot_current(project, job, snapshot)
        plan.update({
            "status": "failed",
            "job_id": job.id,
            "error": error_text,
        })
        project.scene_plan = plan
        await db.commit()
        await db.refresh(project)
        return serialize_project(project)
    except ScenePlanClaimConflict as error:
        await db.rollback()
        raise _scene_claim_conflict() from error
    except StaleScenePlanJob as error:
        await db.rollback()
        raise _stale_conflict(error) from error
    except ValueError as error:
        await db.rollback()
        raise _scene_validation_error(error) from error


async def _speech_runtime() -> dict:
    config = await get_config()
    return {
        "speech_model": config.get("speech_model", "mimo-v2.5-tts"),
        "default_voice": config.get(
            "speech_default_voice",
            "mimo_default",
        ),
    }


def _validate_speech_job(
    job: ContentJob | None,
    *,
    project_id: int,
    segment_id: str,
) -> dict:
    if (
        job is None
        or job.flow != "text_video_speech"
        or job.input_data.get("project_id") != project_id
        or job.input_data.get("segment_id") != segment_id
    ):
        raise StaleTextVideoJob("配音任务已失效")
    return job.input_data


@router.post("/{project_id}/speech-split-preview", status_code=status.HTTP_201_CREATED)
async def create_speech_split_preview(
    project_id: int,
    payload: SpeechSplitPreviewRequest,
    db: AsyncSession = Depends(get_db),
):
    project = await get_project_or_404(db, project_id)
    if project.revision != payload.revision:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "作品已在其他页面更新",
                "revision": project.revision,
            },
        )
    script = str(project.script or "")
    if not script.strip():
        raise HTTPException(422, "请先输入需要分段的口播稿")

    script_hash = _script_hash(script)
    request_hash = _split_preview_request_hash(
        revision=payload.revision,
        script_hash=script_hash,
        direction=payload.direction,
    )
    key = f"text-video-split:{project.id}:{request_hash}"
    candidates = build_boundary_candidates(script)
    job = await create_or_get_job(
        db,
        flow="text_video_split_preview",
        title=f"AI 口播分段预览 · {project.title}",
        input_data={
            "project_id": project.id,
            "revision": project.revision,
            "script": script,
            "script_hash": script_hash,
            "direction": payload.direction,
            "candidates": [_public_candidate(candidate) for candidate in candidates],
        },
        idempotency_key=key,
        commit=False,
    )
    await db.commit()
    await db.refresh(job)
    await enqueue_job(job.id)
    return {
        "jobs": [_speech_split_preview_job_payload(job, project.id)],
        "project": serialize_project(project),
    }


@router.post(
    "/{project_id}/speech-segments/{segment_id}/generate",
    status_code=status.HTTP_201_CREATED,
)
async def generate_speech_segment(
    project_id: int,
    segment_id: str,
    payload: SpeechActionRequest,
    db: AsyncSession = Depends(get_db),
):
    project = await get_project_or_404(db, project_id)
    runtime = await _speech_runtime()
    try:
        result = await launch_speech_job(
            db,
            project,
            segment_id,
            expected_revision=payload.revision,
            speech_model=runtime["speech_model"],
            speech_default_voice=runtime["default_voice"],
        )
    except StaleTextVideoJob as error:
        raise _stale_conflict(error) from error
    return {
        "jobs": [_speech_job_payload(job) for job in result.jobs],
        "project": serialize_project(result.project),
    }


@router.post(
    "/{project_id}/speech-segments/generate-pending",
    status_code=status.HTTP_201_CREATED,
)
async def generate_pending_speech_segments(
    project_id: int,
    payload: SpeechActionRequest,
    db: AsyncSession = Depends(get_db),
):
    project = await get_project_or_404(db, project_id)
    runtime = await _speech_runtime()
    try:
        result = await launch_pending_speech_jobs(
            db,
            project,
            expected_revision=payload.revision,
            speech_model=runtime["speech_model"],
            speech_default_voice=runtime["default_voice"],
        )
    except StaleTextVideoJob as error:
        raise _stale_conflict(error) from error
    return {
        "jobs": [_speech_job_payload(job) for job in result.jobs],
        "project": serialize_project(result.project),
    }


@router.post("/{project_id}/speech-segments/{segment_id}/confirm")
async def confirm_speech_segment(
    project_id: int,
    segment_id: str,
    payload: SpeechConfirmRequest,
    db: AsyncSession = Depends(get_db),
):
    project = await db.scalar(
        select(TextVideoProject)
        .where(TextVideoProject.id == project_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if project is None:
        raise HTTPException(404, "文字视频作品不存在")
    if project.revision != payload.revision:
        raise _stale_conflict(StaleTextVideoJob("作品已在其他页面更新"))
    paragraphs = normalize_speech_segments(
        str(project.script or ""),
        project.paragraphs or [],
    )
    for index, segment in enumerate(paragraphs):
        if segment["id"] != segment_id:
            continue
        if (
            segment["status"] != "ready"
            or segment["generation_revision"] != payload.generation_revision
            or segment["source_hash"] != payload.source_hash
        ):
            raise _stale_conflict(StaleTextVideoJob("配音段落已更新"))
        existing = await speech_asset_result(
            db,
            source_hash=payload.source_hash,
            audio_url=str(segment["audio_url"]),
        )
        if existing is None:
            raise HTTPException(
                409,
                "配音素材已丢失，请重新生成当前段",
            )
        paragraphs[index] = {**segment, "status": "confirmed", "error": ""}
        project.paragraphs = paragraphs
        await db.commit()
        await db.refresh(project)
        return serialize_project(project)
    raise HTTPException(404, "配音段落不存在")


@router.post(
    "/{project_id}/master-audio/build",
    status_code=status.HTTP_201_CREATED,
)
async def build_master_audio(
    project_id: int,
    payload: SpeechActionRequest,
    db: AsyncSession = Depends(get_db),
):
    try:
        result = await launch_master_audio(
            db,
            project_id,
            expected_revision=payload.revision,
        )
    except (StaleMasterJob, MasterStateError) as error:
        await db.rollback()
        raise HTTPException(
            409,
            str(error),
            headers={"X-WMS-Retryable": "false"},
        ) from error
    return {
        "jobs": [_master_job_payload(job) for job in result.jobs],
        "project": serialize_project(result.project),
    }


@router.post(
    "/{project_id}/master-audio/worker-assemble",
    dependencies=[Depends(require_worker_token)],
)
async def worker_assemble_master_audio(
    project_id: int,
    job_id: int = Header(alias="X-Content-Job-Id"),
    db: AsyncSession = Depends(get_db),
):
    try:
        return await assemble_master(
            db,
            project_id=project_id,
            job_id=job_id,
        )
    except StaleMasterJob as error:
        await db.rollback()
        raise _stale_conflict(error) from error
    except MasterStateError as error:
        await db.rollback()
        raise HTTPException(
            422,
            str(error),
            headers={"X-WMS-Retryable": "false"},
        ) from error
    except MediaToolUnavailable as error:
        await db.rollback()
        raise HTTPException(
            503,
            "FFmpeg/FFprobe 不可用，请安装媒体工具后重试",
            headers={"X-WMS-Retryable": "true"},
        ) from error
    except MediaCommandError as error:
        await db.rollback()
        raise HTTPException(
            422,
            "主音频无法解析或拼接",
            headers={"X-WMS-Retryable": "false"},
        ) from error


@router.post(
    "/{project_id}/master-audio/worker-align",
    dependencies=[Depends(require_worker_token)],
)
async def worker_align_master_audio(
    project_id: int,
    payload: MasterAlignRequest,
    job_id: int = Header(alias="X-Content-Job-Id"),
    db: AsyncSession = Depends(get_db),
):
    lock = _MASTER_ALIGNMENT_LOCKS.setdefault(
        (project_id, job_id),
        asyncio.Lock(),
    )
    async with lock:
        return await _worker_align_master_audio(
            project_id,
            payload,
            job_id,
            db,
        )


async def _worker_align_master_audio(
    project_id: int,
    payload: MasterAlignRequest,
    job_id: int,
    db: AsyncSession,
):
    while True:
        try:
            context = await begin_master_alignment(
                db,
                project_id=project_id,
                job_id=job_id,
                source_hash=payload.source_hash,
                step_id=payload.step_id,
                attempt=payload.attempt,
                claim_token=payload.claim_token,
            )
            break
        except MasterBusyError:
            # Another API process owns the durable claim. Wait for its
            # committed result instead of starting a second paid
            # transcription or failing the shared durable step. Lease expiry
            # is fail-closed for the same durable attempt.
            await db.rollback()
            await asyncio.sleep(0.05)
        except MasterAlignmentFailedError as error:
            await db.rollback()
            raise HTTPException(
                422,
                str(error),
                headers={
                    "X-WMS-Retryable": (
                        "true" if error.retryable else "false"
                    ),
                },
            ) from error
        except StaleMasterJob as error:
            await db.rollback()
            raise _stale_conflict(error) from error
        except MediaToolUnavailable as error:
            await db.rollback()
            raise HTTPException(
                503,
                "FFmpeg/FFprobe 不可用，请安装媒体工具后重试",
                headers={"X-WMS-Retryable": "true"},
            ) from error
        except (MediaCommandError, MasterStateError) as error:
            await db.rollback()
            raise HTTPException(
                422,
                str(error),
                headers={"X-WMS-Retryable": "false"},
            ) from error
    if context.already_ready:
        return serialize_project(context.project)

    segments = [
        {
            "id": item["speech_segment_id"],
            "text": item["text"],
            "sample_count": item["sample_count"],
            "word_timings": deepcopy(item.get("word_timings") or []),
        }
        for item in context.segments
    ]
    script = "".join(item["text"] for item in segments)
    offsets = {
        item["segment_id"]: item["sample_offset"]
        for item in context.segment_offsets
    }
    duration = context.sample_count / context.sample_rate
    try:
        try:
            words = build_global_timeline(
                script,
                segments,
                offsets,
                duration,
                sample_rate=context.sample_rate,
                master_sample_count=context.sample_count,
            )
            timeline_source = "provider"
        except AlignmentError:
            if context.audio_path is None:
                raise AlignmentError("主音频文件已丢失")
            transcription = await transcribe_audio_words(
                context.audio_path,
                await get_config(),
                duration=duration,
            )
            words = align_transcript_words(
                script,
                list(transcription.words),
                duration,
                speech_segments=[
                    {
                        "id": item["id"],
                        "text": item["text"],
                    }
                    for item in segments
                ],
                sample_rate=context.sample_rate,
                master_sample_count=context.sample_count,
            )
            timeline_source = "forced-alignment"
        project = await complete_master_alignment(
            db,
            project_id=project_id,
            job_id=job_id,
            source_hash=payload.source_hash,
            step_id=payload.step_id,
            attempt=payload.attempt,
            claim_token=payload.claim_token,
            words=words,
            timeline_source=timeline_source,
        )
        return serialize_project(project)
    except TranscriptionError as error:
        try:
            await fail_master_audio(
                db,
                project_id=project_id,
                job_id=job_id,
                source_hash=payload.source_hash,
                phase="align_master_timeline",
                error=str(error),
                step_id=payload.step_id,
                attempt=payload.attempt,
                claim_token=payload.claim_token,
                retryable=error.retryable,
            )
        except StaleMasterJob as stale:
            await db.rollback()
            raise _stale_conflict(stale) from error
        raise HTTPException(
            422,
            str(error),
            headers={
                "X-WMS-Retryable": (
                    "true" if error.retryable else "false"
                ),
            },
        ) from error
    except AlignmentError as error:
        try:
            await fail_master_audio(
                db,
                project_id=project_id,
                job_id=job_id,
                source_hash=payload.source_hash,
                phase="align_master_timeline",
                error=str(error),
                step_id=payload.step_id,
                attempt=payload.attempt,
                claim_token=payload.claim_token,
                retryable=False,
            )
        except StaleMasterJob as stale:
            await db.rollback()
            raise _stale_conflict(stale) from error
        raise HTTPException(
            422,
            str(error),
            headers={"X-WMS-Retryable": "false"},
        ) from error
    except StaleMasterJob as error:
        await db.rollback()
        raise _stale_conflict(error) from error


@router.post(
    "/{project_id}/master-audio/worker-failure",
    dependencies=[Depends(require_worker_token)],
)
async def worker_fail_master_audio(
    project_id: int,
    payload: MasterWorkerFailureRequest,
    job_id: int = Header(alias="X-Content-Job-Id"),
    db: AsyncSession = Depends(get_db),
):
    try:
        project = await fail_master_audio(
            db,
            project_id=project_id,
            job_id=job_id,
            source_hash=payload.source_hash,
            phase=payload.phase,
            error=payload.error,
            step_id=payload.step_id,
            attempt=payload.attempt,
            claim_token=payload.claim_token,
            reconcile_only=(
                payload.phase == "align_master_timeline"
            ),
        )
        serialized = serialize_project(project)
        master = serialized["master_audio"]
        failure_applied = (
            master["status"] == "failed"
            if payload.phase == "assemble_master_audio"
            else master["timeline_status"] == "failed"
        )
        return {
            **serialized,
            "failure_applied": failure_applied,
        }
    except StaleMasterJob as error:
        await db.rollback()
        raise _stale_conflict(error) from error
    except MasterStateError as error:
        await db.rollback()
        raise HTTPException(
            422,
            str(error),
            headers={"X-WMS-Retryable": "false"},
        ) from error


@router.get(
    "/{project_id}/speech-segments/{segment_id}/worker-context",
    dependencies=[Depends(require_worker_token)],
)
async def get_speech_worker_context(
    project_id: int,
    segment_id: str,
    job_id: int = Header(alias="X-Content-Job-Id"),
    db: AsyncSession = Depends(get_db),
):
    try:
        job = await db.get(ContentJob, job_id)
        snapshot = deepcopy(
            _validate_speech_job(
                job,
                project_id=project_id,
                segment_id=segment_id,
            ),
        )
        project = await get_project_or_404(db, project_id)
        segment = assert_current_speech_job(project, snapshot)
        if segment.get("job_id") not in {job_id, None}:
            raise StaleTextVideoJob("配音任务已被替换")
        if segment["status"] in {"ready", "confirmed"}:
            saved = await speech_asset_result(
                db,
                source_hash=snapshot["source_hash"],
                audio_url=str(segment["audio_url"]),
            )
            if saved is None:
                raise StaleTextVideoJob(
                    "配音素材已丢失，请重新生成当前段",
                )
            return {"already_saved": saved}
        if segment.get("job_id") != job_id:
            raise StaleTextVideoJob("配音任务已被替换")
        runtime = await _speech_runtime()
        return {
            **snapshot,
            "runtime": {
                "default_voice": runtime["default_voice"],
            },
        }
    except StaleTextVideoJob as error:
        raise _stale_conflict(error) from error


@router.post(
    "/{project_id}/speech-segments/{segment_id}/worker-failure",
    dependencies=[Depends(require_worker_token)],
)
async def save_speech_worker_failure(
    project_id: int,
    segment_id: str,
    payload: SpeechWorkerFailureRequest,
    job_id: int = Header(alias="X-Content-Job-Id"),
    db: AsyncSession = Depends(get_db),
):
    try:
        job = await db.scalar(
            select(ContentJob)
            .where(ContentJob.id == job_id)
            .with_for_update()
        )
        snapshot = _validate_speech_job(
            job,
            project_id=project_id,
            segment_id=segment_id,
        )
        if (
            snapshot.get("generation_revision")
            != payload.generation_revision
            or snapshot.get("source_hash") != payload.source_hash
        ):
            raise StaleTextVideoJob("配音任务快照不匹配")
        project = await db.scalar(
            select(TextVideoProject)
            .where(TextVideoProject.id == project_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if project is None:
            raise StaleTextVideoJob("文字视频作品不存在")
        segment = assert_current_speech_job(project, snapshot)
        if segment.get("job_id") != job_id:
            raise StaleTextVideoJob("配音任务已被替换")
        paragraphs = list(project.paragraphs or [])
        for index, current in enumerate(paragraphs):
            if current.get("id") == segment_id:
                paragraphs[index] = {
                    **current,
                    "status": "failed",
                    "job_id": None,
                    "error": redact_secret_text(payload.error)[:500],
                }
                break
        project.paragraphs = paragraphs
        await db.commit()
        await db.refresh(project)
        return serialize_project(project)
    except StaleTextVideoJob as error:
        await db.rollback()
        raise _stale_conflict(error) from error


async def _stream_speech_upload(audio: UploadFile) -> Path:
    uploads = Path(UPLOADS_DIR)
    temporary_directory = uploads / ".speech-tmp"
    temporary_directory.mkdir(parents=True, exist_ok=True)
    path = temporary_directory / f"incoming-{uuid4().hex}"
    size = 0
    try:
        with path.open("wb") as output:
            while True:
                chunk = await audio.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_SPEECH_AUDIO_BYTES:
                    raise HTTPException(413, "配音文件不能超过 100 MB")
                await asyncio.to_thread(output.write, chunk)
        if size == 0:
            raise HTTPException(422, "配音文件不能为空")
        return path
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    finally:
        await audio.close()


def _remove_saved_audio(saved: dict) -> None:
    prefix = "/api/uploads/"
    url = str(saved.get("audio_url") or "")
    if not url.startswith(prefix):
        return
    root = Path(UPLOADS_DIR).resolve()
    candidate = (root / url[len(prefix):]).resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        return
    candidate.unlink(missing_ok=True)


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


def _retain_unfinished_speech_db_task(
    task: asyncio.Task,
    *,
    db: AsyncSession | None,
) -> None:
    _DETACHED_SPEECH_DB_TASKS.add(task)
    if db is not None:
        defer_session_close_until_task_terminal(db, task)

    def consume(completed: asyncio.Task) -> None:
        _DETACHED_SPEECH_DB_TASKS.discard(completed)
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
            SPEECH_DB_CANCEL_GRACE_SECONDS,
            pending_cancellation,
            cancellation_interrupts=False,
        )
        cancellation_seen = (
            cancellation_seen or drain_cancellation_seen
        )
    if not task.done():
        _retain_unfinished_speech_db_task(task, db=db)
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


def _finite_duration_matches(value: Any, expected: float) -> bool:
    if isinstance(value, bool):
        return False
    try:
        candidate = float(value)
    except (TypeError, ValueError):
        return False
    return bool(
        math.isfinite(candidate)
        and math.isclose(
            candidate,
            expected,
            rel_tol=0,
            abs_tol=1e-9,
        )
    )


async def _verify_saved_speech_result(
    db: AsyncSession,
    saved: dict,
    *,
    source_hash: str,
    project_id: int,
    segment_id: str,
    generation_revision: int,
    require_project_reference: bool,
) -> bool | None:
    bind = db.bind
    if bind is None:
        logger.error(
            "Cannot verify speech asset {} durability: no database bind",
            saved.get("asset_id"),
        )
        return None
    if not isinstance(bind, AsyncEngine):
        logger.error(
            "Cannot independently verify speech asset {} durability: "
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
            "Cannot independently verify speech asset {} durability: "
            "database pool does not provide an independent connection",
            saved.get("asset_id"),
        )
        return None
    verification_factory = async_sessionmaker(
        bind,
        expire_on_commit=False,
    )
    try:
        sample_count = saved["sample_count"]
        sample_rate = saved["sample_rate"]
        if (
            isinstance(sample_count, bool)
            or not isinstance(sample_count, int)
            or sample_count <= 0
            or isinstance(sample_rate, bool)
            or not isinstance(sample_rate, int)
            or sample_rate <= 0
        ):
            raise ValueError("saved speech sample metadata is invalid")
        expected_duration = sample_count / sample_rate
        if (
            not math.isfinite(expected_duration)
            or not _finite_duration_matches(
                saved.get("duration"),
                expected_duration,
            )
        ):
            raise ValueError("saved speech duration is invalid")
        expected_filename = Path(saved["audio_url"]).name
        async with asyncio.timeout(5):
            async with verification_factory() as verification:
                asset = await verification.get(
                    CreativeAsset,
                    saved["asset_id"],
                )
                metadata_rows = (
                    await verification.scalars(
                        select(TextVideoSpeechAsset).where(
                            TextVideoSpeechAsset.creative_asset_id
                            == saved["asset_id"],
                        ),
                    )
                ).all()
                project_references: list[dict] = []
                if require_project_reference:
                    project = await verification.get(
                        TextVideoProject,
                        project_id,
                    )
                    if project is not None:
                        project_references = [
                            item
                            for item in (project.paragraphs or [])
                            if item.get("id") == segment_id
                        ]
                if asset is None and not metadata_rows:
                    contradictory_reference = bool(
                        require_project_reference
                        and (
                            len(project_references) > 1
                            or any(
                                item.get("audio_url")
                                == saved["audio_url"]
                                for item in project_references
                            )
                        )
                    )
                    if contradictory_reference:
                        logger.error(
                            "Speech asset {} rows are absent but its project "
                            "reference is durable; preserving its file",
                            saved["asset_id"],
                        )
                        return None
                    return False
                if asset is None or len(metadata_rows) != 1:
                    logger.error(
                        "Speech asset {} durability is partial, duplicated, "
                        "or inconsistent; preserving its file",
                        saved["asset_id"],
                    )
                    return None
                metadata = metadata_rows[0]
                asset_matches = bool(
                    asset.asset_type == "media"
                    and asset.media_kind == "audio"
                    and asset.title == "文字视频口播配音"
                    and asset.url == saved["audio_url"]
                    and asset.media_type == "audio/mpeg"
                    and asset.filename == expected_filename
                    and asset.source == "generated"
                )
                metadata_matches = bool(
                    metadata.source_hash == source_hash
                    and metadata.sample_count == sample_count
                    and metadata.sample_rate == sample_rate
                    and _finite_duration_matches(
                        metadata.duration,
                        expected_duration,
                    )
                    and metadata.word_timings
                    == saved.get("word_timings")
                    and metadata.provider_request_id
                    == saved.get("provider_request_id")
                )
                if not asset_matches or not metadata_matches:
                    logger.error(
                        "Speech asset {} immutable state is inconsistent; "
                        "preserving its file",
                        saved["asset_id"],
                    )
                    return None
                if require_project_reference:
                    item = (
                        project_references[0]
                        if len(project_references) == 1
                        else None
                    )
                    referenced = bool(
                        item is not None
                        and item.get("id") == segment_id
                        and item.get("status") in {"ready", "confirmed"}
                        and item.get("audio_url") == saved["audio_url"]
                        and item.get("source_hash") == source_hash
                        and item.get("generation_revision")
                        == generation_revision
                        and item.get("job_id") is None
                        and _finite_duration_matches(
                            item.get("duration"),
                            expected_duration,
                        )
                        and item.get("word_timings")
                        == saved.get("word_timings")
                        and item.get("error") == ""
                    )
                    if not referenced:
                        logger.error(
                            "Durable speech asset {} has no exact project "
                            "reference; preserving its file",
                            saved["asset_id"],
                        )
                        return None
                return True
    except Exception as error:
        logger.error(
            "Cannot verify speech asset {} durability: {}",
            saved.get("asset_id"),
            redact_secret_text(str(error))[:500],
        )
        return None


async def _commit_saved_speech_result(
    db: AsyncSession,
    saved: dict,
    *,
    source_hash: str,
    project_id: int,
    segment_id: str,
    generation_revision: int,
    require_project_reference: bool,
) -> None:
    commit_task = asyncio.create_task(
        db.commit(),
        name=f"text-video-speech-commit-{saved['asset_id']}",
    )
    commit_outcome = await _bounded_task_outcome(
        commit_task,
        timeout_seconds=SPEECH_DB_OPERATION_TIMEOUT_SECONDS,
        db=db,
    )
    pending_cancellation = commit_outcome.pending_cancellation
    if not commit_outcome.terminal:
        commit_failure = TimeoutError(
            "speech result commit did not reach a terminal state",
        )
        logger.error(
            "Speech result commit did not terminate for asset {}; "
            "preserving its file and deferring session close",
            saved["asset_id"],
        )
        if pending_cancellation is not None:
            raise pending_cancellation from commit_failure
        raise commit_failure
    commit_confirmed = bool(
        commit_outcome.failure is None
        and not commit_outcome.timed_out
        and not commit_outcome.cancellation_requested
    )
    if commit_confirmed:
        if pending_cancellation is not None:
            raise pending_cancellation
        return
    commit_failure = commit_outcome.failure
    if commit_failure is None:
        if commit_outcome.timed_out:
            commit_failure = TimeoutError(
                "speech result commit exceeded its deadline",
            )
        elif commit_outcome.cancellation_requested:
            commit_failure = asyncio.CancelledError(
                "speech result commit was interrupted",
            )
        else:
            commit_failure = RuntimeError(
                "speech result commit was not confirmed",
            )
    effective_commit_failure = (
        TimeoutError("speech result commit exceeded its deadline")
        if commit_outcome.timed_out
        else commit_failure
    )

    rollback_task = asyncio.create_task(
        db.rollback(),
        name=f"text-video-speech-rollback-{saved['asset_id']}",
    )
    rollback_outcome = await _bounded_task_outcome(
        rollback_task,
        timeout_seconds=(
            SPEECH_DB_CANCEL_GRACE_SECONDS
            if pending_cancellation is not None
            else SPEECH_DB_OPERATION_TIMEOUT_SECONDS
        ),
        pending_cancellation=pending_cancellation,
        db=db,
    )
    pending_cancellation = rollback_outcome.pending_cancellation
    if not rollback_outcome.terminal:
        logger.error(
            "Speech result rollback did not terminate for asset {}; "
            "preserving its file and deferring session close",
            saved["asset_id"],
        )
        if pending_cancellation is not None:
            raise pending_cancellation from effective_commit_failure
        raise effective_commit_failure
    rollback_failure = rollback_outcome.failure
    rollback_confirmed = bool(
        rollback_failure is None
        and not rollback_outcome.timed_out
        and not rollback_outcome.cancellation_requested
    )
    if not rollback_confirmed:
        logger.warning(
            "Speech result rollback was not confirmed for asset {}: {}",
            saved["asset_id"],
            redact_secret_text(str(rollback_failure or "interrupted"))[:500],
        )

    verification_task = asyncio.create_task(
        _verify_saved_speech_result(
            db,
            saved,
            source_hash=source_hash,
            project_id=project_id,
            segment_id=segment_id,
            generation_revision=generation_revision,
            require_project_reference=require_project_reference,
        ),
        name=f"text-video-speech-verify-{saved['asset_id']}",
    )
    verification_outcome = await _bounded_task_outcome(
        verification_task,
        timeout_seconds=(
            SPEECH_DB_CANCEL_GRACE_SECONDS
            if pending_cancellation is not None
            else SPEECH_DB_VERIFICATION_TIMEOUT_SECONDS
        ),
        pending_cancellation=pending_cancellation,
    )
    pending_cancellation = verification_outcome.pending_cancellation
    verification_failure = verification_outcome.failure
    durable = (
        verification_task.result()
        if (
            verification_outcome.terminal
            and verification_failure is None
            and not verification_outcome.timed_out
        )
        else None
    )
    if not verification_outcome.terminal or verification_failure is not None:
        logger.error(
            "Speech result verification crashed for asset {}: {}",
            saved["asset_id"],
            redact_secret_text(
                str(verification_failure or "did not terminate"),
            )[:500],
        )

    deletion_is_safe = bool(
        durable is False
        and rollback_confirmed
        and not commit_outcome.timed_out
        and not commit_outcome.cancellation_requested
    )
    if deletion_is_safe:
        _remove_saved_audio(saved)
    elif durable is True:
        logger.warning(
            "Speech result commit acknowledgement failed for asset {}, but "
            "independent verification found durable state",
            saved["asset_id"],
        )
    else:
        logger.error(
            "Speech result commit state is unknown for asset {}; preserving "
            "its file",
            saved["asset_id"],
        )

    if pending_cancellation is not None:
        raise pending_cancellation from effective_commit_failure
    if (
        durable is True
        and not commit_outcome.timed_out
        and not commit_outcome.cancellation_requested
    ):
        return
    raise effective_commit_failure


@router.post(
    "/{project_id}/speech-segments/{segment_id}/worker-result",
    dependencies=[Depends(require_worker_token)],
)
async def save_speech_worker_result(
    project_id: int,
    segment_id: str,
    audio: UploadFile = File(...),
    generation_revision: int = Form(..., ge=0),
    source_hash: str = Form(..., min_length=64, max_length=64),
    provider_request_id: str = Form(default="", max_length=500),
    media_type: str = Form(...),
    word_timings: str = Form(default="[]"),
    job_id: int = Header(alias="X-Content-Job-Id"),
    db: AsyncSession = Depends(get_db),
):
    temporary: Path | None = None
    saved: dict | None = None
    commit_owns_saved_file = False
    try:
        job = await db.get(ContentJob, job_id)
        snapshot = _validate_speech_job(
            job,
            project_id=project_id,
            segment_id=segment_id,
        )
        if job.status == "cancelled":
            raise StaleTextVideoJob("任务已取消")
        if (
            snapshot.get("generation_revision") != generation_revision
            or snapshot.get("source_hash") != source_hash
        ):
            raise StaleTextVideoJob("配音任务快照不匹配")
        project = await db.get(TextVideoProject, project_id)
        if project is None:
            raise StaleTextVideoJob("文字视频作品不存在")
        segment = assert_current_speech_job(project, snapshot)
        if segment["status"] in {"ready", "confirmed"}:
            replay = await speech_asset_result(
                db,
                source_hash=source_hash,
                audio_url=str(segment["audio_url"]),
            )
            if replay is None:
                raise StaleTextVideoJob(
                    "配音素材已丢失，请重新生成当前段",
                )
            await db.rollback()
            return replay
        if segment.get("job_id") != job_id:
            raise StaleTextVideoJob("配音任务已被替换")
        voice = deepcopy(snapshot.get("voice_settings") or {})
        # Release the initial read transaction before upload and FFmpeg work.
        # The current job and project are checked again under locks afterward.
        await db.rollback()
        if (
            media_type not in SUPPORTED_MEDIA_TYPES
            or audio.content_type not in SUPPORTED_MEDIA_TYPES
            or audio.content_type != media_type
        ):
            raise HTTPException(422, "不支持的配音文件类型")
        try:
            parsed_timings = json.loads(word_timings)
        except json.JSONDecodeError as error:
            raise HTTPException(422, "word timings 必须是 JSON 数组") from error
        if not isinstance(parsed_timings, list):
            raise HTTPException(422, "word timings 必须是 JSON 数组")
        temporary = await _stream_speech_upload(audio)
        saved = await save_text_video_audio_asset(
            db,
            temporary,
            source_hash=source_hash,
            media_type=media_type,
            speed=float(voice.get("speed", 1)),
            volume=float(voice.get("volume", 1)),
            pitch=float(voice.get("pitch", 0)),
            word_timings=parsed_timings,
            provider_request_id=provider_request_id,
        )

        locked_job = await db.scalar(
            select(ContentJob)
            .where(ContentJob.id == job_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        snapshot = _validate_speech_job(
            locked_job,
            project_id=project_id,
            segment_id=segment_id,
        )
        if locked_job.status == "cancelled":
            raise StaleTextVideoJob("任务已取消")
        if (
            snapshot.get("generation_revision") != generation_revision
            or snapshot.get("source_hash") != source_hash
        ):
            raise StaleTextVideoJob("配音任务快照不匹配")
        locked_project = await db.scalar(
            select(TextVideoProject)
            .where(TextVideoProject.id == project_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if locked_project is None:
            raise StaleTextVideoJob("文字视频作品不存在")
        current = assert_current_speech_job(locked_project, snapshot)
        if current.get("job_id") != job_id:
            raise StaleTextVideoJob("配音任务已被替换")
        paragraphs = list(locked_project.paragraphs or [])
        for index, item in enumerate(paragraphs):
            if item.get("id") == segment_id:
                paragraphs[index] = {
                    **item,
                    "status": "ready",
                    "audio_url": saved["audio_url"],
                    "duration": saved["duration"],
                    "word_timings": saved["word_timings"],
                    "source_hash": source_hash,
                    "error": "",
                    "job_id": None,
                }
                break
        locked_project.paragraphs = paragraphs
        mark_text_video_downstream_stale(locked_project)
        commit_owns_saved_file = True
        await _commit_saved_speech_result(
            db,
            saved,
            source_hash=source_hash,
            project_id=project_id,
            segment_id=segment_id,
            generation_revision=generation_revision,
            require_project_reference=True,
        )
        return saved
    except StaleTextVideoJob as error:
        if saved is None:
            await db.rollback()
        else:
            # The normalized asset is valid and may be reused, but the second
            # stale check forbids it from replacing edited project state.
            commit_owns_saved_file = True
            await _commit_saved_speech_result(
                db,
                saved,
                source_hash=source_hash,
                project_id=project_id,
                segment_id=segment_id,
                generation_revision=generation_revision,
                require_project_reference=False,
            )
        raise _stale_conflict(error) from error
    except MediaToolUnavailable as error:
        await db.rollback()
        raise HTTPException(
            503,
            "FFmpeg/FFprobe 不可用，请安装媒体工具后重试",
        ) from error
    except MediaCommandError as error:
        await db.rollback()
        raise HTTPException(422, "配音文件无法解析或转换") from error
    except ValueError as error:
        await db.rollback()
        raise HTTPException(422, str(error)) from error
    finally:
        if saved is not None and not commit_owns_saved_file:
            try:
                await db.rollback()
            finally:
                _remove_saved_audio(saved)
        if temporary is not None:
            temporary.unlink(missing_ok=True)


@router.post(
    "/{project_id}/speech-split-preview/worker-validate",
    dependencies=[Depends(require_worker_token)],
)
async def validate_speech_split_preview(
    project_id: int,
    payload: SpeechSplitWorkerValidationRequest,
    job_id: int = Header(alias="X-Content-Job-Id"),
    db: AsyncSession = Depends(get_db),
):
    job = await db.get(ContentJob, job_id)
    if (
        job is None
        or job.flow != "text_video_split_preview"
        or job.input_data.get("project_id") != project_id
        or job.input_data.get("script_hash") != payload.script_hash
    ):
        raise HTTPException(409, "口播分段预览任务已失效")
    script = str(job.input_data.get("script") or "")
    if _script_hash(script) != payload.script_hash:
        raise HTTPException(409, "口播分段预览稿件校验失败")
    try:
        slices = slice_at_boundary_ids(
            script,
            build_boundary_candidates(script),
            payload.boundary_ids,
        )
    except SegmentationError as error:
        raise HTTPException(422, str(error)) from error
    prefix = payload.script_hash[:12]
    return {
        "segments": [
            {
                "id": f"segment-{prefix}-{index}",
                "text": segment,
                "estimated_duration": round(
                    max(0.5, speakable_character_count(segment) / 4.2),
                    1,
                ),
                "reason": "AI 建议分段",
            }
            for index, segment in enumerate(slices, start=1)
        ],
        "speech_split_mode": "auto",
    }


@router.post(
    "/{project_id}/render",
    status_code=status.HTTP_201_CREATED,
)
async def render_text_video(
    project_id: int,
    payload: SpeechActionRequest,
    db: AsyncSession = Depends(get_db),
):
    try:
        result = await launch_text_video_render(
            db,
            project_id,
            revision=payload.revision,
        )
    except LookupError as error:
        raise HTTPException(404, str(error)) from error
    except RuntimeError as error:
        await db.rollback()
        current = await get_project_or_404(db, project_id)
        raise HTTPException(
            409,
            {
                "message": str(error),
                "revision": current.revision,
            },
        ) from error
    except ValueError as error:
        await db.rollback()
        raise HTTPException(422, str(error)) from error
    job = result.jobs[0]
    if result.should_enqueue:
        await enqueue_job(job.id)
    return {
        "jobs": [_render_job_payload(job, project_id)],
        "project": serialize_project(result.project),
    }


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(
    project_id: int,
    db: AsyncSession = Depends(get_db),
):
    project = await get_project_or_404(db, project_id)
    await db.delete(project)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
