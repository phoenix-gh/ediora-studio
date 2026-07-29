import asyncio
from copy import deepcopy
from datetime import datetime
import hashlib
import json
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
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from config import get_config
from content_jobs import create_or_get_job
from job_queue import enqueue_job
from log_redaction import redact_secret_text
from models import ContentJob, TextVideoProject, now_utc
from text_video_domain import (
    default_speech_segment,
    empty_master_audio,
    empty_scene_plan,
    merge_editable_project,
    normalize_speech_segments,
    video_stage_ready,
)
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
from text_video_audio import (
    SUPPORTED_MEDIA_TYPES,
    save_text_video_audio_asset,
)
from text_video_segmentation import (
    SegmentationError,
    build_boundary_candidates,
    slice_at_boundary_ids,
    speakable_character_count,
)
from worker_auth import require_worker_token


router = APIRouter(prefix="/text-videos", tags=["text-videos"])
UPLOADS_DIR = Path(__file__).resolve().parent.parent / "uploads"


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
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    fps: int = Field(gt=0)

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
    id: str = Field(min_length=1)
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    text: str = Field(min_length=1)
    highlight: list[str] = Field(default_factory=list)
    animation: Literal["fade-up", "scale"]

    @model_validator(mode="after")
    def valid_time_range(self):
        if self.end <= self.start:
            raise ValueError("分镜结束时间必须晚于开始时间")
        return self


class TemplatePropsDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")

    theme: Literal["tech-blue"]
    font: Literal["source-han-sans"]
    background: Literal["dark-grid"]
    transition: Literal["soft-push"]
    textDensity: Literal["compact", "standard", "spacious"]


class RenderInputDocument(BaseModel):
    templateId: Literal["tech-text-v1"]
    templateVersion: Literal[1]
    composition: CompositionDocument
    audio: str = ""
    segments: list[SegmentDocument] = Field(min_length=1)
    templateProps: TemplatePropsDocument

    @model_validator(mode="after")
    def ordered_segments(self):
        for index in range(1, len(self.segments)):
            if self.segments[index].start < self.segments[index - 1].end:
                raise ValueError("分镜时间不能重叠，且必须按时间排序")
        return self


class TemplateSelectionDocument(BaseModel):
    templateId: str
    templateVersion: int = Field(ge=1)
    templateProps: dict[str, Any] = Field(default_factory=dict)


class ScenePlanSceneEdit(BaseModel):
    id: str = Field(min_length=1)
    fromWordId: str = ""
    throughWordId: str = ""
    displayText: str = ""
    highlight: list[str] = Field(default_factory=list)
    animation: str = ""


class ScenePlanEdit(BaseModel):
    scenes: list[ScenePlanSceneEdit]


class ProjectCreate(BaseModel):
    title: str = Field(default="未命名文字视频", max_length=300)


class ProjectUpdate(BaseModel):
    revision: int = Field(ge=1)
    title: str | None = Field(default=None, max_length=300)
    status: Literal["draft", "audio_ready", "video_ready", "completed", "archived"] | None = None
    stage: Literal["script", "audio", "video"] | None = None
    script: str | None = None
    voice_settings: VoiceSettingsDocument | None = None
    paragraphs: list[SpeechSegmentEdit] | None = None
    composition: CompositionDocument | None = None
    template: TemplateSelectionDocument | None = None
    scene_plan: ScenePlanEdit | None = None
    render_input: RenderInputDocument | None = None
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
    },
}


def serialize_project(project: TextVideoProject, *, summary: bool = False) -> dict[str, Any]:
    render_input = project.render_input or DEFAULT_RENDER_INPUT
    segments = render_input.get("segments") or []
    duration = max((float(segment.get("end", 0)) for segment in segments), default=0)
    data = {
        "id": project.id,
        "title": project.title,
        "status": project.status,
        "stage": project.stage,
        "cover_asset_url": project.cover_asset_url,
        "output_asset_url": project.output_asset_url,
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
            "master_audio": empty_master_audio() | (project.master_audio or {}),
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
        render_input=deepcopy(DEFAULT_RENDER_INPUT),
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
    project = await get_project_or_404(db, project_id)
    if project.revision != payload.revision:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "作品已在其他页面更新",
                "revision": project.revision,
            },
        )

    changes = payload.model_dump(exclude_unset=True, exclude={"revision"}, mode="json")
    if changes.get("title") is not None:
        changes["title"] = changes["title"].strip() or "未命名文字视频"
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
    if project.stage == "video" and not video_stage_ready(project):
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


def _stale_conflict(error: Exception) -> HTTPException:
    return HTTPException(
        status_code=409,
        detail=str(error),
        headers={"X-WMS-Retryable": "false"},
    )


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
    saved_file_released = False
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
        await db.commit()
        saved_file_released = True
        return saved
    except StaleTextVideoJob as error:
        if saved is None:
            await db.rollback()
        else:
            # The normalized asset is valid and may be reused, but the second
            # stale check forbids it from replacing edited project state.
            await db.commit()
            saved_file_released = True
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
        if saved is not None and not saved_file_released:
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


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(
    project_id: int,
    db: AsyncSession = Depends(get_db),
):
    project = await get_project_or_404(db, project_id)
    await db.delete(project)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
