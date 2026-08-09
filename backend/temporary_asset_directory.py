"""System-owned media folder for short-lived generated assets."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models import CreativeAssetDirectory


TEMPORARY_ASSET_DIRECTORY_NAME = "临时文件"
TEMPORARY_ASSET_DIRECTORY_SYSTEM_KEY = "temporary_files"


async def ensure_temporary_asset_directory(
    session: AsyncSession,
) -> CreativeAssetDirectory:
    """Create or claim the media system folder used by generated images."""
    directory = await session.scalar(
        select(CreativeAssetDirectory).where(
            CreativeAssetDirectory.system_key
            == TEMPORARY_ASSET_DIRECTORY_SYSTEM_KEY
        )
    )
    if directory is None:
        directory = await session.scalar(
            select(CreativeAssetDirectory).where(
                CreativeAssetDirectory.asset_type == "media",
                CreativeAssetDirectory.name == TEMPORARY_ASSET_DIRECTORY_NAME,
            )
        )
    if directory is None:
        directory = CreativeAssetDirectory(
            name=TEMPORARY_ASSET_DIRECTORY_NAME,
            asset_type="media",
            parent_id=None,
        )
        session.add(directory)
    directory.system_key = TEMPORARY_ASSET_DIRECTORY_SYSTEM_KEY
    await session.flush()
    return directory
