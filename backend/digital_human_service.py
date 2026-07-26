"""Domain operations for reusable digital humans and talking-video projects."""

from __future__ import annotations

import os
from urllib.parse import urlparse

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from content_jobs import create_job
from models import (
    ContentJob,
    CreativeAsset,
    DigitalHuman,
    TalkingVideoProject,
    TalkingVideoRender,
    now_utc,
)


class DigitalHumanInUse(ValueError):
    pass


class InvalidTalkingVideo(ValueError):
    pass


_UPLOADS_DIR = os.path.join(os.path.dirname(__file__), "uploads")


def _local_asset_size(asset: CreativeAsset) -> int | None:
    path = urlparse(asset.url).path
    prefix = "/api/uploads/"
    if not path.startswith(prefix):
        return None
    filename = os.path.basename(path.removeprefix(prefix))
    if not filename:
        return None
    local_path = os.path.join(_UPLOADS_DIR, filename)
    if not os.path.isfile(local_path):
        return None
    return os.path.getsize(local_path)


async def require_media_asset(
    session: AsyncSession,
    asset_id: int,
    accepted_types: set[str],
    max_bytes: int,
) -> CreativeAsset:
    asset = await session.get(CreativeAsset, asset_id)
    if asset is None or asset.asset_type != "media":
        raise InvalidTalkingVideo("创作资产不存在")
    media_type = asset.media_type.lower().split(";", 1)[0].strip()
    if media_type not in accepted_types:
        raise InvalidTalkingVideo("素材格式不支持")
    size = _local_asset_size(asset)
    if size is not None and size > max_bytes:
        raise InvalidTalkingVideo("素材文件超过 32MB 限制")
    return asset


async def create_digital_human(
    session: AsyncSession,
    *,
    name: str,
    portrait_asset_id: int,
    voice_sample_asset_id: int,
    default_environment_asset_id: int,
) -> tuple[DigitalHuman, ContentJob]:
    clean_name = name.strip()
    if not clean_name:
        raise InvalidTalkingVideo("数字人名称不能为空")
    await require_media_asset(
        session,
        portrait_asset_id,
        {"image/png", "image/jpeg"},
        32 * 1024 * 1024,
    )
    await require_media_asset(
        session,
        voice_sample_asset_id,
        {"audio/mpeg", "audio/wav", "audio/x-wav"},
        32 * 1024 * 1024,
    )
    await require_media_asset(
        session,
        default_environment_asset_id,
        {"image/png", "image/jpeg"},
        32 * 1024 * 1024,
    )
    role = DigitalHuman(
        name=clean_name,
        status="processing",
        portrait_asset_id=portrait_asset_id,
        voice_sample_asset_id=voice_sample_asset_id,
        default_environment_asset_id=default_environment_asset_id,
    )
    session.add(role)
    await session.flush()
    job = await create_job(
        session,
        flow="digital_human_setup",
        title=f"初始化数字人 · {role.name}",
        input_data={"digital_human_id": role.id},
        idempotency_key=f"digital-human-setup:{role.id}:1",
    )
    role.setup_job_id = job.id
    await session.commit()
    await session.refresh(role)
    return role, job


async def create_talking_project(
    session: AsyncSession,
    *,
    title: str,
    digital_human_id: int,
    environment_asset_id: int | None = None,
    source_draft_id: int | None = None,
) -> TalkingVideoProject:
    role = await session.get(DigitalHuman, digital_human_id)
    if role is None or role.status == "archived":
        raise InvalidTalkingVideo("数字人角色不存在或已归档")
    if environment_asset_id is not None:
        await require_media_asset(
            session,
            environment_asset_id,
            {"image/png", "image/jpeg"},
            32 * 1024 * 1024,
        )
    project = TalkingVideoProject(
        title=title.strip(),
        digital_human_id=digital_human_id,
        environment_asset_id=environment_asset_id,
        source_draft_id=source_draft_id,
        script_source="draft" if source_draft_id is not None else "manual",
    )
    session.add(project)
    await session.commit()
    await session.refresh(project)
    return project


async def create_render(
    session: AsyncSession,
    *,
    project_id: int,
) -> tuple[TalkingVideoRender, ContentJob]:
    project = await session.get(TalkingVideoProject, project_id)
    if project is None:
        raise InvalidTalkingVideo("口播作品不存在")
    script = project.script.strip()
    if not script:
        raise InvalidTalkingVideo("请先填写口播脚本")
    role = await session.get(DigitalHuman, project.digital_human_id)
    if role is None or role.status != "ready":
        raise InvalidTalkingVideo("数字人角色尚未就绪")
    if not role.heygen_avatar_id or not role.heygen_voice_id:
        raise InvalidTalkingVideo("数字人角色缺少 HeyGen 形象或声音")
    environment_asset_id = (
        project.environment_asset_id or role.default_environment_asset_id
    )
    await require_media_asset(
        session,
        environment_asset_id,
        {"image/png", "image/jpeg"},
        32 * 1024 * 1024,
    )
    latest = await session.scalar(
        select(func.max(TalkingVideoRender.version)).where(
            TalkingVideoRender.project_id == project_id
        )
    )
    render = TalkingVideoRender(
        project_id=project.id,
        version=(latest or 0) + 1,
        status="queued",
        script_snapshot=script,
        digital_human_snapshot={
            "id": role.id,
            "name": role.name,
            "heygen_avatar_group_id": role.heygen_avatar_group_id,
            "heygen_avatar_id": role.heygen_avatar_id,
            "heygen_voice_id": role.heygen_voice_id,
        },
        environment_asset_id=environment_asset_id,
    )
    session.add(render)
    await session.flush()
    job = await create_job(
        session,
        flow="digital_human_render",
        title=f"生成口播视频 · {project.title or f'作品 {project.id}'} · V{render.version}",
        input_data={"render_id": render.id},
        idempotency_key=f"talking-video-render:{render.id}",
    )
    render.job_id = job.id
    await session.commit()
    await session.refresh(render)
    return render, job


async def archive_digital_human(
    session: AsyncSession, role_id: int
) -> DigitalHuman:
    role = await session.get(DigitalHuman, role_id)
    if role is None:
        raise InvalidTalkingVideo("数字人角色不存在")
    role.status = "archived"
    role.archived_at = now_utc()
    await session.commit()
    await session.refresh(role)
    return role


async def delete_digital_human(session: AsyncSession, role_id: int) -> None:
    role = await session.get(DigitalHuman, role_id)
    if role is None:
        raise InvalidTalkingVideo("数字人角色不存在")
    project_count = await session.scalar(
        select(func.count(TalkingVideoProject.id)).where(
            TalkingVideoProject.digital_human_id == role_id
        )
    )
    if project_count:
        raise DigitalHumanInUse("数字人已有口播作品，请改为归档")
    await session.execute(delete(DigitalHuman).where(DigitalHuman.id == role_id))
    await session.commit()


async def select_render(
    session: AsyncSession, project_id: int, render_id: int
) -> TalkingVideoProject:
    project = await session.get(TalkingVideoProject, project_id)
    render = await session.get(TalkingVideoRender, render_id)
    if (
        project is None
        or render is None
        or render.project_id != project_id
        or render.status != "succeeded"
    ):
        raise InvalidTalkingVideo("只能选择已成功的本项目成片")
    project.current_render_id = render.id
    await session.commit()
    await session.refresh(project)
    return project
