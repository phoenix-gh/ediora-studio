"""Deterministic 16:9 look still for ComfyUI digital-human roles."""

from __future__ import annotations

import os
import uuid
from io import BytesIO
from urllib.parse import urlparse

from PIL import Image
from sqlalchemy.ext.asyncio import AsyncSession

from digital_human_assets import archive_digital_human_asset_ids
from models import CreativeAsset, DigitalHuman


_UPLOADS_DIR = os.path.join(os.path.dirname(__file__), "uploads")


LOOK_WIDTH = 1344
LOOK_HEIGHT = 768
PORTRAIT_HEIGHT_RATIO = 0.70


def _cover(image: Image.Image, width: int, height: int) -> Image.Image:
    scale = max(width / image.width, height / image.height)
    resized = image.resize(
        (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
        Image.Resampling.LANCZOS,
    )
    left = max(0, (resized.width - width) // 2)
    top = max(0, (resized.height - height) // 2)
    return resized.crop((left, top, left + width, top + height))


def compose_look_image(portrait_bytes: bytes, environment_bytes: bytes) -> bytes:
    environment = Image.open(BytesIO(environment_bytes)).convert("RGB")
    canvas = _cover(environment, LOOK_WIDTH, LOOK_HEIGHT).convert("RGBA")
    portrait = Image.open(BytesIO(portrait_bytes)).convert("RGBA")
    target_height = max(1, round(LOOK_HEIGHT * PORTRAIT_HEIGHT_RATIO))
    scale = target_height / portrait.height
    target_width = max(1, round(portrait.width * scale))
    portrait = portrait.resize((target_width, target_height), Image.Resampling.LANCZOS)
    left = (LOOK_WIDTH - target_width) // 2
    top = LOOK_HEIGHT - target_height
    canvas.paste(portrait, (left, top), portrait)
    output = BytesIO()
    canvas.convert("RGB").save(output, format="JPEG", quality=92)
    return output.getvalue()


def _local_asset_path(asset: CreativeAsset) -> str:
    path = urlparse(asset.url).path
    prefix = "/api/uploads/"
    if not path.startswith(prefix):
        raise FileNotFoundError("素材不在本地上传目录")
    filename = os.path.basename(path.removeprefix(prefix))
    local_path = os.path.join(_UPLOADS_DIR, filename)
    if not os.path.isfile(local_path):
        raise FileNotFoundError("素材文件不存在")
    return local_path


async def compose_role_look(
    session: AsyncSession,
    role: DigitalHuman,
) -> CreativeAsset:
    portrait = await session.get(CreativeAsset, role.portrait_asset_id)
    environment = await session.get(
        CreativeAsset, role.default_environment_asset_id
    )
    if portrait is None or environment is None:
        raise FileNotFoundError("定妆图素材不存在")
    with open(_local_asset_path(portrait), "rb") as handle:
        portrait_bytes = handle.read()
    with open(_local_asset_path(environment), "rb") as handle:
        environment_bytes = handle.read()
    payload = compose_look_image(portrait_bytes, environment_bytes)
    os.makedirs(_UPLOADS_DIR, exist_ok=True)
    filename = f"{uuid.uuid4().hex}.jpg"
    with open(os.path.join(_UPLOADS_DIR, filename), "wb") as handle:
        handle.write(payload)
    asset = CreativeAsset(
        asset_type="media",
        media_kind="image",
        title=f"{role.name} 定妆图",
        url=f"/api/uploads/{filename}",
        media_type="image/jpeg",
        filename=filename,
        source="digital_human_look",
    )
    session.add(asset)
    await session.flush()
    await archive_digital_human_asset_ids(session, {asset.id})
    return asset
