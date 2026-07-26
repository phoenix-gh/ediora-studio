"""Digital-human role API and trusted worker hand-off endpoints."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from content_jobs import create_job
from database import get_db
from digital_human_service import (
    DigitalHumanInUse,
    InvalidTalkingVideo,
    archive_digital_human,
    create_digital_human,
    delete_digital_human,
    require_media_asset,
)
from job_queue import enqueue_job
from models import CreativeAsset, DigitalHuman


router = APIRouter(prefix="/digital-humans", tags=["digital-humans"])


class RoleCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    portrait_asset_id: int
    voice_sample_asset_id: int
    default_environment_asset_id: int


class RoleUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    portrait_asset_id: int | None = None
    voice_sample_asset_id: int | None = None
    default_environment_asset_id: int | None = None


class RoleWorkerProgress(BaseModel):
    status: Literal["processing", "ready", "failed"]
    heygen_avatar_group_id: str = ""
    heygen_avatar_id: str = ""
    heygen_voice_id: str = ""
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
    voice = await db.get(CreativeAsset, role.voice_sample_asset_id)
    environment = await db.get(CreativeAsset, role.default_environment_asset_id)
    return {
        "id": role.id,
        "name": role.name,
        "status": role.status,
        "portrait_asset_id": role.portrait_asset_id,
        "voice_sample_asset_id": role.voice_sample_asset_id,
        "default_environment_asset_id": role.default_environment_asset_id,
        "portrait": _asset_payload(portrait) if portrait else None,
        "voice_sample": _asset_payload(voice) if voice else None,
        "default_environment": _asset_payload(environment) if environment else None,
        "heygen_avatar_group_id": role.heygen_avatar_group_id,
        "heygen_avatar_id": role.heygen_avatar_id,
        "heygen_voice_id": role.heygen_voice_id,
        "provider_state": role.provider_state,
        "setup_job_id": role.setup_job_id,
        "error": role.error,
        "archived_at": role.archived_at,
        "created_at": role.created_at,
        "updated_at": role.updated_at,
    }


async def _get_role(db: AsyncSession, role_id: int) -> DigitalHuman:
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
    try:
        role, job = await create_digital_human(
            db,
            name=body.name,
            portrait_asset_id=body.portrait_asset_id,
            voice_sample_asset_id=body.voice_sample_asset_id,
            default_environment_asset_id=body.default_environment_asset_id,
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
    role = await _get_role(db, role_id)
    if body.name is not None:
        role.name = body.name.strip()
    changed_provider_input = False
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
                changed_provider_input = True
    except InvalidTalkingVideo as exc:
        raise HTTPException(422, str(exc)) from exc
    await db.commit()
    await db.refresh(role)
    if changed_provider_input:
        await _queue_setup(db, role)
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
    role = await _get_role(db, role_id)
    await _queue_setup(db, role)
    await db.refresh(role)
    return await _role_payload(db, role)


@router.get("/{role_id}/worker-context")
async def role_worker_context(role_id: int, db: AsyncSession = Depends(get_db)):
    role = await _get_role(db, role_id)
    portrait = await db.get(CreativeAsset, role.portrait_asset_id)
    voice = await db.get(CreativeAsset, role.voice_sample_asset_id)
    environment = await db.get(CreativeAsset, role.default_environment_asset_id)
    if portrait is None or voice is None or environment is None:
        raise HTTPException(409, "数字人本地素材不完整")
    return {
        "id": role.id,
        "name": role.name,
        "status": role.status,
        "portrait": _asset_payload(portrait),
        "voice_sample": _asset_payload(voice),
        "default_environment": _asset_payload(environment),
        "provider_state": role.provider_state,
        "heygen_avatar_group_id": role.heygen_avatar_group_id,
        "heygen_avatar_id": role.heygen_avatar_id,
        "heygen_voice_id": role.heygen_voice_id,
    }


@router.post("/{role_id}/worker-progress")
async def role_worker_progress(
    role_id: int,
    body: RoleWorkerProgress,
    db: AsyncSession = Depends(get_db),
):
    role = await _get_role(db, role_id)
    if body.status == "ready":
        if not body.heygen_avatar_id or not body.heygen_voice_id:
            raise HTTPException(422, "就绪状态必须同时包含 HeyGen 形象和声音")
        role.heygen_avatar_group_id = body.heygen_avatar_group_id
        role.heygen_avatar_id = body.heygen_avatar_id
        role.heygen_voice_id = body.heygen_voice_id
    role.status = body.status
    role.provider_state = body.provider_state
    role.error = body.error[:500]
    await db.commit()
    await db.refresh(role)
    return await _role_payload(db, role)
