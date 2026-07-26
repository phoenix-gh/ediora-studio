import os
import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, File, Header, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import ContentJob, CreativeAsset, CreativeAssetDirectory
from worker_auth import require_worker_token

router = APIRouter(prefix="/assets", tags=["assets"])
AssetType = Literal["article", "media"]
_UPLOADS_DIR = os.path.join(os.path.dirname(__file__), "..", "uploads")

class AssetOut(BaseModel):
    id: int
    asset_type: AssetType
    media_kind: str = ""
    title: str
    content: str
    url: str
    media_type: str
    filename: str
    directory: str = ""
    tags: list[str]
    source: str
    created_at: datetime
    updated_at: datetime
    model_config = {"from_attributes": True}

class AssetCreate(BaseModel):
    asset_type: AssetType
    media_kind: Literal["image", "video", "audio"] | None = None
    title: str = ""
    content: str = ""
    url: str = ""
    media_type: str = ""
    filename: str = ""
    directory: str = ""
    tags: list[str] = Field(default_factory=list)

class AssetUpdate(BaseModel):
    title: str | None = None
    content: str | None = None
    tags: list[str] | None = None

class DirectoryBody(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    asset_type: AssetType = "article"
    parent_id: int | None = None

class DirectoryOut(BaseModel):
    id: int
    name: str
    asset_type: AssetType
    parent_id: int | None
    is_system: bool
    created_at: datetime


def _directory_payload(directory: CreativeAssetDirectory) -> dict:
    return {
        "id": directory.id,
        "name": directory.name,
        "asset_type": directory.asset_type,
        "parent_id": directory.parent_id,
        "is_system": bool(directory.system_key),
        "created_at": directory.created_at,
    }

@router.get("/directories", response_model=list[DirectoryOut])
async def list_directories(asset_type: AssetType, db: AsyncSession = Depends(get_db)):
    directories = (await db.execute(select(CreativeAssetDirectory).where(CreativeAssetDirectory.asset_type == asset_type).order_by(CreativeAssetDirectory.name))).scalars().all()
    return [_directory_payload(directory) for directory in directories]

@router.post("/directories", response_model=DirectoryOut, status_code=201)
async def create_directory(body: DirectoryBody, db: AsyncSession = Depends(get_db)):
    name = body.name.strip()
    if not name: raise HTTPException(422, "目录名称不能为空")
    if body.parent_id is not None:
        parent = await db.get(CreativeAssetDirectory, body.parent_id)
        if not parent or parent.asset_type != body.asset_type: raise HTTPException(422, "父目录不存在或类型不匹配")
    directory = CreativeAssetDirectory(name=name, asset_type=body.asset_type, parent_id=body.parent_id); db.add(directory)
    try: await db.commit()
    except Exception: await db.rollback(); raise HTTPException(409, "目录已存在")
    await db.refresh(directory); return _directory_payload(directory)

@router.patch("/directories/{directory_id}", response_model=DirectoryOut)
async def rename_directory(directory_id: int, body: DirectoryBody, db: AsyncSession = Depends(get_db)):
    directory = await db.get(CreativeAssetDirectory, directory_id)
    if not directory: raise HTTPException(404, "目录不存在")
    if directory.system_key:
        raise HTTPException(409, "系统目录不能重命名")
    old, directory.name = directory.name, body.name.strip()
    assets = (await db.execute(select(CreativeAsset).where(
        CreativeAsset.directory == old,
        CreativeAsset.asset_type == directory.asset_type,
    ))).scalars().all()
    for asset in assets: asset.directory = directory.name
    await db.commit(); await db.refresh(directory); return _directory_payload(directory)

@router.delete("/directories/{directory_id}", status_code=204)
async def delete_directory(directory_id: int, db: AsyncSession = Depends(get_db)):
    directory = await db.get(CreativeAssetDirectory, directory_id)
    if not directory: raise HTTPException(404, "目录不存在")
    if directory.system_key:
        raise HTTPException(409, "系统目录不能删除")
    descendants = [directory]
    known_ids = {directory.id}
    while True:
        children = (await db.execute(select(CreativeAssetDirectory).where(
            CreativeAssetDirectory.parent_id.in_(known_ids),
        ))).scalars().all()
        new_children = [child for child in children if child.id not in known_ids]
        if not new_children:
            break
        descendants.extend(new_children)
        known_ids.update(child.id for child in new_children)
    names = [item.name for item in descendants]
    assets = (await db.execute(select(CreativeAsset).where(
        CreativeAsset.directory.in_(names),
        CreativeAsset.asset_type == directory.asset_type,
    ))).scalars().all()
    for asset in assets:
        asset.directory = ""
    for item in descendants:
        await db.delete(item)
    await db.commit()

@router.get("", response_model=list[AssetOut])
async def list_assets(asset_type: AssetType | None = None, media_kind: Literal["image", "video", "audio"] | None = None, directory: str = "", q: str = "", db: AsyncSession = Depends(get_db)):
    stmt = select(CreativeAsset).order_by(desc(CreativeAsset.updated_at), desc(CreativeAsset.id))
    if asset_type: stmt = stmt.where(CreativeAsset.asset_type == asset_type)
    if media_kind: stmt = stmt.where(CreativeAsset.media_kind == media_kind)
    if directory: stmt = stmt.where(CreativeAsset.directory == directory)
    rows = (await db.execute(stmt)).scalars().all()
    if q:
        needle = q.lower()
        rows = [item for item in rows if needle in f"{item.title} {item.content} {' '.join(item.tags)}".lower()]
    return rows

@router.post("", response_model=AssetOut, status_code=201)
async def create_asset(body: AssetCreate, db: AsyncSession = Depends(get_db)):
    if body.asset_type == "article" and not body.content.strip(): raise HTTPException(422, "文章资产需要内容")
    if body.asset_type != "article" and (not body.url or not body.media_kind): raise HTTPException(422, "多媒体资产需要文件和类型")
    asset = CreativeAsset(**body.model_dump(), source="manual")
    db.add(asset); await db.commit(); await db.refresh(asset)
    return asset

@router.patch("/{asset_id}", response_model=AssetOut)
async def update_asset(asset_id: int, body: AssetUpdate, db: AsyncSession = Depends(get_db)):
    asset = await db.get(CreativeAsset, asset_id)
    if not asset: raise HTTPException(404, "创作资产不存在")
    for key, value in body.model_dump(exclude_none=True).items(): setattr(asset, key, value)
    await db.commit(); await db.refresh(asset)
    return asset

@router.delete("/{asset_id}", status_code=204)
async def delete_asset(asset_id: int, db: AsyncSession = Depends(get_db)):
    asset = await db.get(CreativeAsset, asset_id)
    if not asset: raise HTTPException(404, "创作资产不存在")
    upload_path = ""
    if asset.source == "upload" and asset.url.startswith("/api/uploads/"):
        stored_name = os.path.basename(asset.url)
        candidate = os.path.abspath(os.path.join(_UPLOADS_DIR, stored_name))
        uploads_root = os.path.abspath(_UPLOADS_DIR)
        if os.path.commonpath([candidate, uploads_root]) == uploads_root:
            upload_path = candidate
    await db.delete(asset); await db.commit()
    if upload_path:
        try:
            os.remove(upload_path)
        except FileNotFoundError:
            pass

@router.post("/upload", response_model=AssetOut, status_code=201)
async def upload_asset(
    media_kind: Literal["image", "video", "audio"],
    file: UploadFile = File(...),
    title: str = "",
    job_id: int | None = Header(default=None, alias="X-Content-Job-Id"),
    worker_token: str | None = Header(
        default=None, alias="X-WMS-Worker-Token"
    ),
    db: AsyncSession = Depends(get_db),
):
    expected = f"{media_kind}/"
    if not file.content_type or not file.content_type.startswith(expected): raise HTTPException(400, f"请上传{media_kind}文件")
    data = await file.read()
    if len(data) > 100 * 1024 * 1024: raise HTTPException(413, "文件超过100MB限制")
    if job_id is not None:
        require_worker_token(worker_token)
        job = await db.scalar(
            select(ContentJob)
            .where(ContentJob.id == job_id)
            .with_for_update()
        )
        if job is None:
            raise HTTPException(409, "内容任务不存在")
        if job.status == "cancelled":
            raise HTTPException(409, "内容任务已取消")
    ext = os.path.splitext(file.filename or "")[1] or ".bin"
    filename = f"{uuid.uuid4().hex}{ext}"
    os.makedirs(_UPLOADS_DIR, exist_ok=True)
    with open(os.path.join(_UPLOADS_DIR, filename), "wb") as output: output.write(data)
    asset = CreativeAsset(asset_type="media", media_kind=media_kind, title=title or file.filename or filename, url=f"/api/uploads/{filename}", media_type=file.content_type, filename=file.filename or filename, source="upload")
    db.add(asset); await db.commit(); await db.refresh(asset)
    return asset
