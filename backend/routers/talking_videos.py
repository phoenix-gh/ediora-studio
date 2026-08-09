"""Talking-video projects, immutable render versions, and worker hand-off."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from config import effective_heygen_api_key, get_config
from database import get_db
from digital_human_assets import archive_digital_human_asset_ids
from digital_human_service import (
    InvalidTalkingVideo,
    create_render,
    create_talking_project,
    require_media_asset,
    select_render,
)
from job_queue import enqueue_job
from models import (
    CreativeAsset,
    ContentJob,
    DigitalHuman,
    TalkingVideoProject,
    TalkingVideoRender,
    now_utc,
)
from worker_auth import require_worker_token


router = APIRouter(prefix="/talking-videos", tags=["talking-videos"])


class ProjectCreate(BaseModel):
    title: str = Field(default="", max_length=300)
    digital_human_id: int
    script: str = ""
    script_source: Literal["manual", "ai", "draft"] = "manual"
    source_draft_id: int | None = None
    environment_asset_id: int | None = None


class ProjectUpdate(BaseModel):
    title: str | None = Field(default=None, max_length=300)
    digital_human_id: int | None = None
    script: str | None = None
    script_source: Literal["manual", "ai", "draft"] | None = None
    source_draft_id: int | None = None
    environment_asset_id: int | None = None


class RenderWorkerProgress(BaseModel):
    status: Literal["running", "succeeded", "failed", "cancelled"]
    heygen_environment_asset_id: str = ""
    heygen_video_id: str = ""
    video_asset_id: int | None = None
    provider_state: dict = Field(default_factory=dict)
    error: str = ""


def _asset_payload(asset: CreativeAsset | None) -> dict | None:
    if asset is None:
        return None
    return {
        "id": asset.id,
        "title": asset.title,
        "media_kind": asset.media_kind,
        "url": asset.url,
        "media_type": asset.media_type,
        "filename": asset.filename,
    }


def _role_payload(role: DigitalHuman) -> dict:
    return {
        "id": role.id,
        "name": role.name,
        "status": role.status,
        "portrait_asset_id": role.portrait_asset_id,
        "default_environment_asset_id": role.default_environment_asset_id,
    }


async def _render_payload(
    db: AsyncSession, render: TalkingVideoRender
) -> dict:
    video_asset = (
        await db.get(CreativeAsset, render.video_asset_id)
        if render.video_asset_id
        else None
    )
    return {
        "id": render.id,
        "project_id": render.project_id,
        "version": render.version,
        "status": render.status,
        "job_id": render.job_id,
        "script_snapshot": render.script_snapshot,
        "digital_human_snapshot": render.digital_human_snapshot,
        "environment_asset_id": render.environment_asset_id,
        "provider_state": render.provider_state,
        "heygen_environment_asset_id": render.heygen_environment_asset_id,
        "heygen_video_id": render.heygen_video_id,
        "video_asset_id": render.video_asset_id,
        "video_asset": _asset_payload(video_asset),
        "error": render.error,
        "created_at": render.created_at,
        "completed_at": render.completed_at,
    }


async def _project_payload(
    db: AsyncSession, project: TalkingVideoProject, *, detail: bool
) -> dict:
    role = await db.get(DigitalHuman, project.digital_human_id)
    if role is None:
        raise HTTPException(409, "作品关联的数字人角色不存在")
    environment_id = (
        project.environment_asset_id or role.default_environment_asset_id
    )
    environment = await db.get(CreativeAsset, environment_id)
    payload = {
        "id": project.id,
        "title": project.title,
        "digital_human_id": project.digital_human_id,
        "script": project.script,
        "script_source": project.script_source,
        "source_draft_id": project.source_draft_id,
        "environment_asset_id": project.environment_asset_id,
        "effective_environment_asset_id": environment_id,
        "current_render_id": project.current_render_id,
        "role": _role_payload(role),
        "effective_environment": _asset_payload(environment),
        "created_at": project.created_at,
        "updated_at": project.updated_at,
    }
    if detail:
        renders = (
            await db.execute(
                select(TalkingVideoRender)
                .where(TalkingVideoRender.project_id == project.id)
                .order_by(TalkingVideoRender.version.desc())
            )
        ).scalars().all()
        payload["renders"] = [
            await _render_payload(db, render) for render in renders
        ]
    return payload


async def _get_project(
    db: AsyncSession, project_id: int
) -> TalkingVideoProject:
    project = await db.get(TalkingVideoProject, project_id)
    if project is None:
        raise HTTPException(404, "口播作品不存在")
    return project


@router.get("")
async def list_projects(db: AsyncSession = Depends(get_db)):
    projects = (
        await db.execute(
            select(TalkingVideoProject).order_by(
                TalkingVideoProject.updated_at.desc()
            )
        )
    ).scalars().all()
    return [
        await _project_payload(db, project, detail=True)
        for project in projects
    ]


@router.post("", status_code=status.HTTP_201_CREATED)
async def post_project(
    body: ProjectCreate, db: AsyncSession = Depends(get_db)
):
    try:
        project = await create_talking_project(
            db,
            title=body.title,
            digital_human_id=body.digital_human_id,
            environment_asset_id=body.environment_asset_id,
            source_draft_id=body.source_draft_id,
        )
    except InvalidTalkingVideo as exc:
        raise HTTPException(422, str(exc)) from exc
    project.script = body.script
    project.script_source = body.script_source
    await db.commit()
    await db.refresh(project)
    return await _project_payload(db, project, detail=True)


@router.get(
    "/renders/{render_id}/worker-context",
    dependencies=[Depends(require_worker_token)],
)
async def render_worker_context(
    render_id: int,
    job_id: int = Header(alias="X-Content-Job-Id"),
    db: AsyncSession = Depends(get_db),
):
    render = await db.get(TalkingVideoRender, render_id)
    if render is None:
        raise HTTPException(404, "渲染版本不存在")
    if render.job_id != job_id:
        raise HTTPException(
            409,
            "该渲染任务已被更新任务替代",
            headers={"X-WMS-Retryable": "false"},
        )
    environment = await db.get(CreativeAsset, render.environment_asset_id)
    if environment is None:
        raise HTTPException(409, "环境图素材不存在")
    return {
        "id": render.id,
        "project_id": render.project_id,
        "version": render.version,
        "status": render.status,
        "script": render.script_snapshot,
        "digital_human": render.digital_human_snapshot,
        "environment": _asset_payload(environment),
        "provider_state": render.provider_state,
        "heygen_environment_asset_id": render.heygen_environment_asset_id,
        "heygen_video_id": render.heygen_video_id,
        "video_asset_id": render.video_asset_id,
    }


@router.post(
    "/renders/{render_id}/worker-progress",
    dependencies=[Depends(require_worker_token)],
)
async def render_worker_progress(
    render_id: int,
    body: RenderWorkerProgress,
    job_id: int = Header(alias="X-Content-Job-Id"),
    db: AsyncSession = Depends(get_db),
):
    job = await db.scalar(
        select(ContentJob).where(ContentJob.id == job_id).with_for_update()
    )
    if job is None:
        raise HTTPException(409, "渲染任务不存在")
    render = await db.scalar(
        select(TalkingVideoRender)
        .where(TalkingVideoRender.id == render_id)
        .with_for_update()
    )
    if render is None:
        raise HTTPException(404, "渲染版本不存在")
    if render.job_id != job_id:
        raise HTTPException(
            409,
            "该渲染任务已被更新任务替代",
            headers={"X-WMS-Retryable": "false"},
        )
    if job.status == "cancelled":
        if render.status in {"queued", "running"}:
            render.status = "cancelled"
            render.completed_at = now_utc()
            render.error = "任务已取消"
            await db.commit()
            await db.refresh(render)
        return await _render_payload(db, render)
    if render.status == "succeeded":
        return await _render_payload(db, render)
    if body.status == "succeeded":
        if body.video_asset_id is None:
            raise HTTPException(422, "成功状态必须包含本地视频资产")
        video_asset = await db.get(CreativeAsset, body.video_asset_id)
        if (
            video_asset is None
            or video_asset.asset_type != "media"
            or video_asset.media_kind != "video"
            or video_asset.media_type.lower().split(";", 1)[0] != "video/mp4"
        ):
            raise HTTPException(422, "本地视频资产无效")
        await archive_digital_human_asset_ids(
            db, {video_asset.id}
        )
        render.video_asset_id = video_asset.id
        render.completed_at = now_utc()
        project = await db.scalar(
            select(TalkingVideoProject)
            .where(TalkingVideoProject.id == render.project_id)
            .with_for_update()
        )
        if project is not None and project.current_render_id is None:
            project.current_render_id = render.id
    render.status = body.status
    render.heygen_environment_asset_id = body.heygen_environment_asset_id
    render.heygen_video_id = body.heygen_video_id
    render.provider_state = body.provider_state
    render.error = body.error[:500]
    if body.status in {"failed", "cancelled"}:
        render.completed_at = now_utc()
    await db.commit()
    await db.refresh(render)
    return await _render_payload(db, render)


@router.get("/{project_id}")
async def get_project(
    project_id: int, db: AsyncSession = Depends(get_db)
):
    return await _project_payload(
        db, await _get_project(db, project_id), detail=True
    )


@router.patch("/{project_id}")
async def patch_project(
    project_id: int,
    body: ProjectUpdate,
    db: AsyncSession = Depends(get_db),
):
    project = await _get_project(db, project_id)
    values = body.model_dump(exclude_unset=True)
    if "digital_human_id" in values:
        role = await db.get(DigitalHuman, values["digital_human_id"])
        if role is None or role.status == "archived":
            raise HTTPException(422, "数字人角色不存在或已归档")
    if (
        "environment_asset_id" in values
        and values["environment_asset_id"] is not None
    ):
        try:
            await require_media_asset(
                db,
                values["environment_asset_id"],
                {"image/png", "image/jpeg"},
                32 * 1024 * 1024,
            )
        except InvalidTalkingVideo as exc:
            raise HTTPException(422, str(exc)) from exc
        await archive_digital_human_asset_ids(
            db, {values["environment_asset_id"]}
        )
    for key, value in values.items():
        setattr(project, key, value)
    await db.commit()
    await db.refresh(project)
    return await _project_payload(db, project, detail=True)


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_project(
    project_id: int, db: AsyncSession = Depends(get_db)
):
    await _get_project(db, project_id)
    await db.execute(
        delete(TalkingVideoRender).where(
            TalkingVideoRender.project_id == project_id
        )
    )
    await db.execute(
        delete(TalkingVideoProject).where(
            TalkingVideoProject.id == project_id
        )
    )
    await db.commit()


@router.post("/{project_id}/renders", status_code=status.HTTP_201_CREATED)
async def post_render(
    project_id: int, db: AsyncSession = Depends(get_db)
):
    if not effective_heygen_api_key(await get_config()):
        raise HTTPException(409, "请先配置 HeyGen API Key")
    try:
        render, job = await create_render(db, project_id=project_id)
    except InvalidTalkingVideo as exc:
        raise HTTPException(409, str(exc)) from exc
    await enqueue_job(job.id)
    return await _render_payload(db, render)


@router.post("/{project_id}/renders/{render_id}/select")
async def post_select_render(
    project_id: int,
    render_id: int,
    db: AsyncSession = Depends(get_db),
):
    try:
        project = await select_render(db, project_id, render_id)
    except InvalidTalkingVideo as exc:
        raise HTTPException(409, str(exc)) from exc
    return await _project_payload(db, project, detail=True)


@router.delete(
    "/{project_id}/renders/{render_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def remove_render(
    project_id: int,
    render_id: int,
    db: AsyncSession = Depends(get_db),
):
    project = await _get_project(db, project_id)
    render = await db.get(TalkingVideoRender, render_id)
    if render is None or render.project_id != project_id:
        raise HTTPException(404, "渲染版本不存在")
    if render.status not in {"failed", "cancelled"}:
        raise HTTPException(409, "只能删除失败或已取消的渲染版本")
    if project.current_render_id == render.id:
        raise HTTPException(409, "当前成片需先切换后再删除")
    await db.delete(render)
    await db.commit()
