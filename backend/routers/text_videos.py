from copy import deepcopy
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import TextVideoProject, now_utc
from text_video_domain import (
    default_speech_segment,
    empty_master_audio,
    empty_scene_plan,
    merge_editable_project,
    normalize_speech_segments,
    video_stage_ready,
)


router = APIRouter(prefix="/text-videos", tags=["text-videos"])


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


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(
    project_id: int,
    db: AsyncSession = Depends(get_db),
):
    project = await get_project_or_404(db, project_id)
    await db.delete(project)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
