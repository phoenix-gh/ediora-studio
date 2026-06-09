import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import delete as sa_delete
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

import profile_manager as pm
from database import get_db
from models import AgentProfile, ProfileSoulBackup

router = APIRouter(prefix="/profiles", tags=["profiles"])


UPLOADS_DIR = Path(__file__).resolve().parent.parent / "uploads"
AVATARS_SUBDIR = "avatars"
ALLOWED_AVATAR_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp"}
MAX_AVATAR_SIZE = 5 * 1024 * 1024  # 5 MB
_NAME_RE = re.compile(r"^[a-zA-Z0-9_-]+$")


def _avatars_dir() -> Path:
    p = UPLOADS_DIR / AVATARS_SUBDIR
    p.mkdir(parents=True, exist_ok=True)
    return p


class SoulBody(BaseModel):
    content: str


class ToggleBody(BaseModel):
    name: str
    enabled: bool


class SkillsToggleBody(BaseModel):
    names: list[str]
    enabled: bool


class CreateBody(BaseModel):
    id: str = Field(..., pattern=r"^[a-zA-Z0-9_-]+$", min_length=1, max_length=64)
    display_name: str = ""
    clone_from: str | None = None
    description: str = ""


class UpdateMetaBody(BaseModel):
    display_name: str | None = None
    avatar_url: str | None = None
    description: str | None = None


class GenerateAvatarBody(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=1000)


async def _get_or_create_row(db: AsyncSession, name: str) -> AgentProfile:
    row = await db.get(AgentProfile, name)
    if row is None:
        row = AgentProfile(id=name, display_name="", avatar_url="", description="", soul="")
        db.add(row)
        await db.commit()
        await db.refresh(row)
    return row


@router.get("")
async def list_profiles(db: AsyncSession = Depends(get_db)):
    fs_rows = pm.list_profiles()
    if not fs_rows:
        return {"profiles": []}
    names = [r["name"] for r in fs_rows]
    db_rows = (await db.execute(select(AgentProfile).where(AgentProfile.id.in_(names)))).scalars().all()
    db_map = {r.id: r for r in db_rows}
    # Lazy-create missing rows so first paint always has metadata fields.
    missing = [n for n in names if n not in db_map]
    if missing:
        for n in missing:
            row = AgentProfile(id=n)
            db.add(row)
            db_map[n] = row
        await db.commit()
    out = []
    for r in fs_rows:
        meta = db_map[r["name"]]
        out.append({
            **r,
            "display_name": meta.display_name or r["name"],
            "avatar_url": meta.avatar_url,
            "description": meta.description,
        })
    return {"profiles": out}


@router.get("/{name}")
async def get_profile(name: str, db: AsyncSession = Depends(get_db)):
    try:
        detail = pm.get_profile_detail(name)
    except ValueError:
        raise HTTPException(400, "invalid profile name")
    except FileNotFoundError:
        raise HTTPException(404, "profile not found")
    row = await _get_or_create_row(db, name)
    detail["display_name"] = row.display_name or name
    detail["avatar_url"] = row.avatar_url
    detail["description"] = row.description
    return detail


@router.post("", status_code=201)
async def create_profile(body: CreateBody, db: AsyncSession = Depends(get_db)):
    if body.id == "default":
        raise HTTPException(400, "cannot create profile named 'default'")
    if await db.get(AgentProfile, body.id):
        raise HTTPException(400, "profile already exists")
    try:
        pm.create_profile_via_cli(
            body.id,
            clone_from=body.clone_from or "default",
            description=body.description,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    except RuntimeError as e:
        raise HTTPException(502, str(e))
    # Snapshot SOUL.md from disk into DB to seed the backup history.
    soul = ""
    try:
        detail = pm.get_profile_detail(body.id)
        soul = detail.get("soul") or ""
    except Exception:
        pass
    now = datetime.now(timezone.utc)
    row = AgentProfile(
        id=body.id,
        display_name=body.display_name or body.id,
        description=body.description,
        soul=soul,
        soul_updated_at=now if soul else None,
    )
    db.add(row)
    if soul:
        db.add(ProfileSoulBackup(profile_id=body.id, content=soul, created_at=now))
    await db.commit()
    await db.refresh(row)
    return {
        "id": row.id,
        "display_name": row.display_name,
        "avatar_url": row.avatar_url,
        "description": row.description,
    }


@router.delete("/{name}", status_code=204)
async def delete_profile(name: str, db: AsyncSession = Depends(get_db)):
    if name == "default":
        raise HTTPException(403, "default profile is read-only")
    try:
        pm.delete_profile_via_cli(name)
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except FileNotFoundError:
        raise HTTPException(404, "profile not found")
    except RuntimeError as e:
        raise HTTPException(502, str(e))
    # Hard delete DB rows (including SOUL backup history) per user choice.
    await db.execute(sa_delete(ProfileSoulBackup).where(ProfileSoulBackup.profile_id == name))
    await db.execute(sa_delete(AgentProfile).where(AgentProfile.id == name))
    await db.commit()


@router.patch("/{name}")
async def update_meta(name: str, body: UpdateMetaBody, db: AsyncSession = Depends(get_db)):
    if name == "default":
        raise HTTPException(403, "default profile is read-only")
    if not _NAME_RE.match(name):
        raise HTTPException(400, "invalid profile name")
    row = await _get_or_create_row(db, name)
    desc_changed = body.description is not None and body.description != row.description
    if body.display_name is not None:
        row.display_name = body.display_name
    if body.avatar_url is not None:
        row.avatar_url = body.avatar_url
    if body.description is not None:
        row.description = body.description
    await db.commit()
    if desc_changed:
        try:
            pm.set_hermes_description(name, body.description or "")
        except RuntimeError:
            # DB already committed — description is saved. hermes describe sync
            # is best-effort; don't fail the whole request if hermes is unavailable.
            pass
    await db.refresh(row)
    return {
        "id": row.id,
        "display_name": row.display_name,
        "avatar_url": row.avatar_url,
        "description": row.description,
    }


@router.put("/{name}/soul")
async def put_soul(name: str, body: SoulBody, db: AsyncSession = Depends(get_db)):
    try:
        pm.write_soul(name, body.content)
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError:
        raise HTTPException(400, "invalid profile name")
    except FileNotFoundError:
        raise HTTPException(404, "profile not found")
    # Mirror into DB + append a backup row for durability.
    row = await _get_or_create_row(db, name)
    row.soul = body.content
    row.soul_updated_at = datetime.now(timezone.utc)
    db.add(ProfileSoulBackup(profile_id=name, content=body.content))
    await db.commit()
    return {"ok": True}


@router.post("/{name}/avatar")
async def upload_avatar(name: str, file: UploadFile = File(...), db: AsyncSession = Depends(get_db)):
    if name == "default":
        raise HTTPException(403, "default profile is read-only")
    if not _NAME_RE.match(name):
        raise HTTPException(400, "invalid profile name")
    if file.content_type not in ALLOWED_AVATAR_TYPES:
        raise HTTPException(400, f"unsupported type: {file.content_type}")
    data = await file.read()
    if len(data) > MAX_AVATAR_SIZE:
        raise HTTPException(413, "avatar exceeds 5MB")
    ext = (file.filename or "").rsplit(".", 1)[-1].lower() if file.filename and "." in file.filename else "png"
    if ext not in {"jpg", "jpeg", "png", "gif", "webp"}:
        ext = "png"
    fname = f"{name}-{uuid.uuid4().hex[:8]}.{ext}"
    out = _avatars_dir() / fname
    out.write_bytes(data)
    url = f"/api/uploads/{AVATARS_SUBDIR}/{fname}"
    row = await _get_or_create_row(db, name)
    row.avatar_url = url
    await db.commit()
    return {"avatar_url": url}


@router.post("/{name}/avatar/generate")
async def generate_avatar(name: str, body: GenerateAvatarBody, db: AsyncSession = Depends(get_db)):
    if name == "default":
        raise HTTPException(403, "default profile is read-only")
    if not _NAME_RE.match(name):
        raise HTTPException(400, "invalid profile name")
    fname = f"{name}-{uuid.uuid4().hex[:8]}.png"
    out = _avatars_dir() / fname
    try:
        pm.generate_avatar_via_codex(body.prompt, out)
    except RuntimeError as e:
        raise HTTPException(502, str(e))
    url = f"/api/uploads/{AVATARS_SUBDIR}/{fname}"
    row = await _get_or_create_row(db, name)
    row.avatar_url = url
    await db.commit()
    return {"avatar_url": url}


@router.post("/{name}/toolsets")
def post_toolset(name: str, body: ToggleBody):
    try:
        pm.set_toolset(name, body.name, body.enabled)
        return {"ok": True}
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except FileNotFoundError:
        raise HTTPException(404, "profile not found")
    except RuntimeError as e:
        raise HTTPException(502, str(e))


@router.post("/{name}/skills")
def post_skills(name: str, body: SkillsToggleBody):
    try:
        pm.set_skills(name, body.names, body.enabled)
        return {"ok": True}
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except FileNotFoundError:
        raise HTTPException(404, "profile not found")


@router.post("/{name}/mcp")
def post_mcp(name: str, body: ToggleBody):
    try:
        pm.set_mcp_server(name, body.name, body.enabled)
        return {"ok": True}
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except FileNotFoundError:
        raise HTTPException(404, "profile not found")
    except RuntimeError as e:
        raise HTTPException(502, str(e))


@router.get("/{name}/project-skills")
def get_project_skills(name: str):
    try:
        return {"skills": pm.list_project_skills_for_profile(name)}
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/{name}/project-skills/{skill}")
def post_project_skill(name: str, skill: str):
    try:
        pm.install_project_skill(name, skill)
        return {"ok": True}
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except RuntimeError as e:
        raise HTTPException(409, str(e))


@router.delete("/{name}/project-skills/{skill}", status_code=204)
def delete_project_skill(name: str, skill: str):
    try:
        pm.uninstall_project_skill(name, skill)
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except RuntimeError as e:
        raise HTTPException(409, str(e))
