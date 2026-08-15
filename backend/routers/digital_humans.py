"""Digital-human role API and trusted worker hand-off endpoints."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from config import effective_heygen_api_key, get_config
from digital_human_look import compose_role_look
from content_jobs import create_job
from database import get_db
from digital_human_assets import archive_digital_human_asset_ids
from digital_human_service import (
    DigitalHumanInUse,
    InvalidTalkingVideo,
    archive_digital_human,
    create_digital_human,
    delete_digital_human,
    require_media_asset,
)
from job_queue import enqueue_job
from models import ContentJob, CreativeAsset, DigitalHuman, TalkingVideoProject
from worker_auth import require_worker_token


router = APIRouter(prefix="/digital-humans", tags=["digital-humans"])


class RoleCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    provider: Literal["heygen", "comfyui"] = "heygen"
    portrait_asset_id: int
    voice_sample_asset_id: int
    default_environment_asset_id: int
    look_prompt: str = Field(default="", max_length=500)


class RoleUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    portrait_asset_id: int | None = None
    voice_sample_asset_id: int | None = None
    default_environment_asset_id: int | None = None
    look_prompt: str | None = Field(default=None, max_length=500)


class RoleWorkerProgress(BaseModel):
    status: Literal["processing", "ready", "failed"]
    heygen_avatar_group_id: str = ""
    heygen_avatar_id: str = ""
    heygen_voice_id: str = ""
    look_asset_id: int | None = None
    provider_state: dict = Field(default_factory=dict)
    error: str = ""


def _asset_payload(asset: CreativeAsset) -> dict:
    return {
        "id": asset.id,
        "title": asset.title,
        "media_kind": asset.media_kind,
        "url": asset.url,
        "media_type": asset.media_type,
        "filename": asset.filename,
    }


async def _role_payload(db: AsyncSession, role: DigitalHuman) -> dict:
    portrait = await db.get(CreativeAsset, role.portrait_asset_id)
    voice = (
        await db.get(CreativeAsset, role.voice_sample_asset_id)
        if role.voice_sample_asset_id
        else None
    )
    environment = await db.get(CreativeAsset, role.default_environment_asset_id)
    look = (
        await db.get(CreativeAsset, role.look_asset_id)
        if role.look_asset_id
        else None
    )
    project_count = await db.scalar(
        select(func.count(TalkingVideoProject.id)).where(
            TalkingVideoProject.digital_human_id == role.id
        )
    )
    return {
        "id": role.id,
        "name": role.name,
        "status": role.status,
        "provider": role.provider or "heygen",
        "portrait_asset_id": role.portrait_asset_id,
        "voice_sample_asset_id": role.voice_sample_asset_id,
        "default_environment_asset_id": role.default_environment_asset_id,
        "look_asset_id": role.look_asset_id,
        "look_prompt": role.look_prompt or "",
        "portrait": _asset_payload(portrait) if portrait else None,
        "voice_sample": _asset_payload(voice) if voice else None,
        "default_environment": _asset_payload(environment) if environment else None,
        "look": _asset_payload(look) if look else None,
        "heygen_avatar_group_id": role.heygen_avatar_group_id,
        "heygen_avatar_id": role.heygen_avatar_id,
        "heygen_voice_id": role.heygen_voice_id,
        "provider_state": role.provider_state,
        "setup_job_id": role.setup_job_id,
        "error": role.error,
        "archived_at": role.archived_at,
        "created_at": role.created_at,
        "updated_at": role.updated_at,
        "project_count": project_count or 0,
    }


async def _get_role(
    db: AsyncSession,
    role_id: int,
    *,
    for_update: bool = False,
) -> DigitalHuman:
    if for_update:
        role = await db.scalar(
            select(DigitalHuman)
            .where(DigitalHuman.id == role_id)
            .with_for_update()
        )
    else:
        role = await db.get(DigitalHuman, role_id)
    if role is None:
        raise HTTPException(404, "数字人角色不存在")
    return role


async def _queue_setup(db: AsyncSession, role: DigitalHuman):
    job = await create_job(
        db,
        flow="digital_human_setup",
        title=f"初始化数字人 · {role.name}",
        input_data={"digital_human_id": role.id},
        idempotency_key=f"digital-human-setup:{role.id}:{role.updated_at.timestamp()}",
        commit=False,
    )
    role.setup_job_id = job.id
    role.status = "processing"
    role.error = ""
    await db.commit()
    await enqueue_job(job.id)
    return job


@router.get("")
async def list_roles(
    include_archived: bool = False,
    db: AsyncSession = Depends(get_db),
):
    query = select(DigitalHuman).order_by(DigitalHuman.updated_at.desc())
    if not include_archived:
        query = query.where(DigitalHuman.status != "archived")
    roles = (await db.execute(query)).scalars().all()
    return [await _role_payload(db, role) for role in roles]


@router.post("", status_code=status.HTTP_201_CREATED)
async def post_role(body: RoleCreate, db: AsyncSession = Depends(get_db)):
    cfg = await get_config()
    if body.provider == "heygen" and not effective_heygen_api_key(cfg):
        raise HTTPException(409, "请先配置 HeyGen API Key")
    try:
        role, job = await create_digital_human(
            db,
            name=body.name,
            provider=body.provider,
            portrait_asset_id=body.portrait_asset_id,
            voice_sample_asset_id=body.voice_sample_asset_id,
            default_environment_asset_id=body.default_environment_asset_id,
            look_prompt=body.look_prompt,
        )
    except InvalidTalkingVideo as exc:
        raise HTTPException(422, str(exc)) from exc
    await enqueue_job(job.id)
    return await _role_payload(db, role)


@router.get("/{role_id}")
async def get_role(role_id: int, db: AsyncSession = Depends(get_db)):
    return await _role_payload(db, await _get_role(db, role_id))


@router.patch("/{role_id}")
async def patch_role(
    role_id: int,
    body: RoleUpdate,
    db: AsyncSession = Depends(get_db),
):
    role = await _get_role(db, role_id, for_update=True)
    if body.name is not None:
        role.name = body.name.strip()
    changed_provider_inputs: set[str] = set()
    if body.look_prompt is not None:
        next_prompt = body.look_prompt.strip()
        if next_prompt != (role.look_prompt or ""):
            role.look_prompt = next_prompt
            if role.provider == "comfyui":
                changed_provider_inputs.add("look_prompt")
    validations = (
        (
            "portrait_asset_id",
            body.portrait_asset_id,
            {"image/png", "image/jpeg"},
        ),
        (
            "voice_sample_asset_id",
            body.voice_sample_asset_id,
            {"audio/mpeg", "audio/wav", "audio/x-wav"},
        ),
        (
            "default_environment_asset_id",
            body.default_environment_asset_id,
            {"image/png", "image/jpeg"},
        ),
    )
    try:
        for field, value, media_types in validations:
            if value is None:
                continue
            await require_media_asset(db, value, media_types, 32 * 1024 * 1024)
            if getattr(role, field) != value:
                setattr(role, field, value)
                setup_fields = (
                    {"portrait_asset_id", "default_environment_asset_id"}
                    if role.provider == "comfyui"
                    else {"portrait_asset_id", "voice_sample_asset_id"}
                )
                if field in setup_fields:
                    changed_provider_inputs.add(field)
    except InvalidTalkingVideo as exc:
        raise HTTPException(422, str(exc)) from exc
    await archive_digital_human_asset_ids(
        db,
        {
            body.portrait_asset_id,
            body.voice_sample_asset_id,
            body.default_environment_asset_id,
        },
    )
    if changed_provider_inputs and role.status == "processing":
        await db.rollback()
        raise HTTPException(409, "数字人正在处理，请完成后再更换形象或声音")
    if (
        changed_provider_inputs
        and role.provider != "comfyui"
        and not effective_heygen_api_key(await get_config())
    ):
        await db.rollback()
        raise HTTPException(409, "请先配置 HeyGen API Key")
    if "portrait_asset_id" in changed_provider_inputs:
        state = dict(role.provider_state)
        for key in ("portrait_asset_id", "avatar_group_id", "avatar_id"):
            state.pop(key, None)
        role.provider_state = state
    if "voice_sample_asset_id" in changed_provider_inputs:
        state = dict(role.provider_state)
        for key in ("voice_asset_id", "voice_id"):
            state.pop(key, None)
        role.provider_state = state
    if changed_provider_inputs:
        if role.provider == "comfyui":
            role.look_asset_id = None
            state = dict(role.provider_state or {})
            state.pop("look_asset_id", None)
            role.provider_state = state
        await db.flush()
        await _queue_setup(db, role)
    else:
        await db.commit()
    await db.refresh(role)
    return await _role_payload(db, role)


@router.delete("/{role_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_role(role_id: int, db: AsyncSession = Depends(get_db)):
    try:
        await delete_digital_human(db, role_id)
    except DigitalHumanInUse as exc:
        raise HTTPException(409, str(exc)) from exc
    except InvalidTalkingVideo as exc:
        raise HTTPException(404, str(exc)) from exc


@router.post("/{role_id}/archive")
async def archive_role(role_id: int, db: AsyncSession = Depends(get_db)):
    try:
        role = await archive_digital_human(db, role_id)
    except InvalidTalkingVideo as exc:
        raise HTTPException(404, str(exc)) from exc
    return await _role_payload(db, role)


@router.post("/{role_id}/retry")
async def retry_role(role_id: int, db: AsyncSession = Depends(get_db)):
    role = await _get_role(db, role_id, for_update=True)
    if role.status != "failed":
        raise HTTPException(409, "只能重试处理失败的数字人")
    if (
        role.provider != "comfyui"
        and not effective_heygen_api_key(await get_config())
    ):
        raise HTTPException(409, "请先配置 HeyGen API Key")
    await _queue_setup(db, role)
    await db.refresh(role)
    return await _role_payload(db, role)


@router.post(
    "/{role_id}/compose-look",
    dependencies=[Depends(require_worker_token)],
)
async def compose_look(
    role_id: int,
    job_id: int = Header(alias="X-Content-Job-Id"),
    db: AsyncSession = Depends(get_db),
):
    role = await _get_role(db, role_id)
    if role.setup_job_id != job_id:
        raise HTTPException(
            409,
            "该数字人任务已被更新任务替代",
            headers={"X-WMS-Retryable": "false"},
        )
    if role.provider != "comfyui":
        raise HTTPException(409, "只有 ComfyUI 数字人需要合成定妆图")
    try:
        asset = await compose_role_look(db, role)
    except FileNotFoundError as exc:
        raise HTTPException(409, str(exc)) from exc
    role.look_asset_id = asset.id
    await db.commit()
    await db.refresh(asset)
    return {
        "look_asset_id": asset.id,
        "url": asset.url,
        "filename": asset.filename,
        "media_type": asset.media_type,
    }


@router.get(
    "/{role_id}/worker-context",
    dependencies=[Depends(require_worker_token)],
)
async def role_worker_context(
    role_id: int,
    job_id: int = Header(alias="X-Content-Job-Id"),
    db: AsyncSession = Depends(get_db),
):
    role = await _get_role(db, role_id)
    if role.setup_job_id != job_id:
        raise HTTPException(
            409,
            "该数字人任务已被更新任务替代",
            headers={"X-WMS-Retryable": "false"},
        )
    portrait = await db.get(CreativeAsset, role.portrait_asset_id)
    environment = await db.get(CreativeAsset, role.default_environment_asset_id)
    voice = (
        await db.get(CreativeAsset, role.voice_sample_asset_id)
        if role.voice_sample_asset_id
        else None
    )
    look = (
        await db.get(CreativeAsset, role.look_asset_id)
        if role.look_asset_id
        else None
    )
    if portrait is None or environment is None:
        raise HTTPException(409, "数字人本地素材不完整")
    if role.provider != "comfyui" and voice is None:
        raise HTTPException(409, "数字人本地素材不完整")
    return {
        "id": role.id,
        "name": role.name,
        "status": role.status,
        "provider": role.provider or "heygen",
        "portrait": _asset_payload(portrait),
        "voice_sample": _asset_payload(voice) if voice else None,
        "default_environment": _asset_payload(environment),
        "look": _asset_payload(look) if look else None,
        "look_asset_id": role.look_asset_id,
        "look_prompt": role.look_prompt or "",
        "provider_state": role.provider_state,
        "heygen_avatar_group_id": role.heygen_avatar_group_id,
        "heygen_avatar_id": role.heygen_avatar_id,
        "heygen_voice_id": role.heygen_voice_id,
    }


@router.post(
    "/{role_id}/worker-progress",
    dependencies=[Depends(require_worker_token)],
)
async def role_worker_progress(
    role_id: int,
    body: RoleWorkerProgress,
    job_id: int = Header(alias="X-Content-Job-Id"),
    db: AsyncSession = Depends(get_db),
):
    job = await db.scalar(
        select(ContentJob).where(ContentJob.id == job_id).with_for_update()
    )
    if job is None:
        raise HTTPException(409, "数字人任务不存在")
    role = await _get_role(db, role_id, for_update=True)
    if role.setup_job_id != job_id:
        raise HTTPException(
            409,
            "该数字人任务已被更新任务替代",
            headers={"X-WMS-Retryable": "false"},
        )
    if job.status == "cancelled":
        if role.status == "processing":
            role.status = "failed"
            role.error = "任务已取消"
            await db.commit()
            await db.refresh(role)
        return await _role_payload(db, role)
    if role.status == "ready":
        return await _role_payload(db, role)
    if body.status == "ready":
        if role.provider == "comfyui":
            if not body.look_asset_id:
                raise HTTPException(422, "就绪状态必须包含定妆图")
            role.look_asset_id = body.look_asset_id
        else:
            if not body.heygen_avatar_id or not body.heygen_voice_id:
                raise HTTPException(422, "就绪状态必须同时包含 HeyGen 形象和声音")
            role.heygen_avatar_group_id = body.heygen_avatar_group_id
            role.heygen_avatar_id = body.heygen_avatar_id
            role.heygen_voice_id = body.heygen_voice_id
    elif body.look_asset_id:
        role.look_asset_id = body.look_asset_id
    role.status = body.status
    role.provider_state = body.provider_state
    role.error = body.error[:500]
    await db.commit()
    await db.refresh(role)
    return await _role_payload(db, role)
