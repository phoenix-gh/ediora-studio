"""System-owned creative asset folder for digital-human media."""

from __future__ import annotations

from collections.abc import Iterable

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from models import (
    CreativeAsset,
    CreativeAssetDirectory,
    DigitalHuman,
    TalkingVideoProject,
    TalkingVideoRender,
)


DIGITAL_HUMAN_ASSET_DIRECTORY_NAME = "数字人资产"
DIGITAL_HUMAN_ASSET_SYSTEM_KEY = "digital_human_assets"


async def ensure_digital_human_asset_directory(
    session: AsyncSession,
) -> CreativeAssetDirectory:
    directory = await session.scalar(
        select(CreativeAssetDirectory).where(
            CreativeAssetDirectory.system_key
            == DIGITAL_HUMAN_ASSET_SYSTEM_KEY
        )
    )
    if directory is None:
        directory = await session.scalar(
            select(CreativeAssetDirectory).where(
                CreativeAssetDirectory.asset_type == "media",
                CreativeAssetDirectory.name
                == DIGITAL_HUMAN_ASSET_DIRECTORY_NAME,
            )
        )
    if directory is None:
        directory = CreativeAssetDirectory(
            name=DIGITAL_HUMAN_ASSET_DIRECTORY_NAME,
            asset_type="media",
            parent_id=None,
        )
        session.add(directory)
    directory.system_key = DIGITAL_HUMAN_ASSET_SYSTEM_KEY
    await session.flush()
    return directory


async def archive_digital_human_asset_ids(
    session: AsyncSession,
    asset_ids: Iterable[int | None],
) -> None:
    directory = await ensure_digital_human_asset_directory(session)
    normalized_ids = {
        asset_id
        for asset_id in asset_ids
        if isinstance(asset_id, int) and asset_id > 0
    }
    if normalized_ids:
        await session.execute(
            update(CreativeAsset)
            .where(
                CreativeAsset.id.in_(normalized_ids),
                CreativeAsset.asset_type == "media",
            )
            .values(directory=directory.name)
        )
    await session.flush()


async def backfill_digital_human_assets(session: AsyncSession) -> None:
    asset_ids: set[int] = set()
    role_rows = (
        await session.execute(
            select(
                DigitalHuman.portrait_asset_id,
                DigitalHuman.voice_sample_asset_id,
                DigitalHuman.default_environment_asset_id,
                DigitalHuman.look_asset_id,
            )
        )
    ).all()
    project_rows = (
        await session.execute(
            select(TalkingVideoProject.environment_asset_id)
        )
    ).all()
    render_rows = (
        await session.execute(
            select(
                TalkingVideoRender.environment_asset_id,
                TalkingVideoRender.video_asset_id,
            )
        )
    ).all()
    for row in [*role_rows, *project_rows, *render_rows]:
        asset_ids.update(
            value for value in row if isinstance(value, int) and value > 0
        )
    await archive_digital_human_asset_ids(session, asset_ids)
