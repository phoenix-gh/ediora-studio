from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import RefMaterial, RefCollectRule
from config import get_config
from ref_collector import collect_rule, collect_all, clean_batch

router = APIRouter(prefix="/materials", tags=["materials"])

SCENE_TAGS = ["opener", "closer", "argument", "twist", "resonance", "warning"]


# ── Schemas ───────────────────────────────────────────────────────────────────
class MaterialOut(BaseModel):
    id: int
    platform: str
    source_id: Optional[str] = None
    text: str
    text_clean: str = ""
    author: str = ""
    handle: str = ""
    source: str = ""
    source_url: str = ""
    cover_image: str = ""
    likes: int = 0
    reposts: int = 0
    replies: int = 0
    views: int = 0
    score: int = 0
    category: str = ""
    scene_tags: list[str] = []
    tags: list[str] = []
    writing_plan_id: Optional[int] = None
    status: str = "active"
    published_at: Optional[datetime] = None
    created_at: datetime
    model_config = {"from_attributes": True}


class MaterialCreate(BaseModel):
    text: str
    author: str = ""
    source: str = ""
    source_url: str = ""
    category: str = ""
    scene_tags: list[str] = []
    tags: list[str] = []
    writing_plan_id: Optional[int] = None


class MaterialPatch(BaseModel):
    text: Optional[str] = None
    category: Optional[str] = None
    scene_tags: Optional[list[str]] = None
    tags: Optional[list[str]] = None
    status: Optional[str] = None
    writing_plan_id: Optional[int] = None


class RuleOut(BaseModel):
    id: int
    label: str
    source_subscription_id: Optional[int] = None
    min_faves: int
    min_retweets: int
    lang: str
    days: int
    exclude_sensitive: bool
    extra_terms: str
    raw_query: str
    sort: str
    max_results: int
    enabled: bool
    last_collected_at: Optional[datetime]
    last_error: str
    model_config = {"from_attributes": True}


class RuleCreate(BaseModel):
    label: str = ""
    source_subscription_id: Optional[int] = None
    min_faves: int = 1500
    min_retweets: int = 0
    lang: str = "zh"
    days: int = 2
    exclude_sensitive: bool = True
    extra_terms: str = ""
    raw_query: str = ""
    max_results: int = 100


class RulePatch(BaseModel):
    label: Optional[str] = None
    source_subscription_id: Optional[int] = None
    min_faves: Optional[int] = None
    min_retweets: Optional[int] = None
    lang: Optional[str] = None
    days: Optional[int] = None
    exclude_sensitive: Optional[bool] = None
    extra_terms: Optional[str] = None
    raw_query: Optional[str] = None
    max_results: Optional[int] = None
    enabled: Optional[bool] = None


# ── Categories / scene tags ─────────────────────────────────────────────────
@router.get("/categories", response_model=list[str])
async def get_categories():
    cfg = await get_config()
    return [c for c in cfg.get("ref_categories", "").split(",") if c]


@router.get("/scene-tags", response_model=list[str])
async def get_scene_tags():
    return SCENE_TAGS


# ── Materials browse / CRUD ─────────────────────────────────────────────────
@router.get("", response_model=list[MaterialOut])
async def list_materials(
    platform: str = "", category: str = "", scene_tag: str = "",
    min_score: int = 0, q: str = "", sort: str = "time",
    plan_id: int = 0, limit: int = 100, offset: int = 0,
    status: str = "active",
    db: AsyncSession = Depends(get_db),
):
    stmt = select(RefMaterial).where(RefMaterial.status == status)
    if platform:
        stmt = stmt.where(RefMaterial.platform == platform)
    if category:
        stmt = stmt.where(RefMaterial.category == category)
    if min_score > 0:
        stmt = stmt.where(RefMaterial.score >= min_score)
    if plan_id:
        stmt = stmt.where(RefMaterial.writing_plan_id == plan_id)
    order = {"score": desc(RefMaterial.score), "views": desc(RefMaterial.views),
             "time": desc(RefMaterial.created_at)}.get(sort, desc(RefMaterial.created_at))
    stmt = stmt.order_by(order).limit(1000)
    rows = list((await db.execute(stmt)).scalars().all())
    if scene_tag:
        rows = [r for r in rows if scene_tag in (r.scene_tags or [])]
    if q:
        s = q.lower()
        rows = [r for r in rows if s in r.text.lower() or s in (r.author or "").lower()]
    return rows[offset:offset + max(1, min(limit, 500))]


@router.post("", response_model=MaterialOut, status_code=201)
async def create_material(body: MaterialCreate, db: AsyncSession = Depends(get_db)):
    obj = RefMaterial(platform="manual", **body.model_dump())
    db.add(obj)
    await db.commit()
    await db.refresh(obj)
    return obj


@router.patch("/{mid}", response_model=MaterialOut)
async def patch_material(mid: int, body: MaterialPatch, db: AsyncSession = Depends(get_db)):
    obj = await db.get(RefMaterial, mid)
    if not obj:
        raise HTTPException(404, "条目不存在")
    for f, v in body.model_dump(exclude_none=True).items():
        setattr(obj, f, v)
    await db.commit()
    await db.refresh(obj)
    return obj


@router.delete("/{mid}", status_code=204)
async def delete_material(mid: int, db: AsyncSession = Depends(get_db)):
    obj = await db.get(RefMaterial, mid)
    if not obj:
        raise HTTPException(404, "条目不存在")
    await db.delete(obj)
    await db.commit()


# ── Collect rules ────────────────────────────────────────────────────────────
@router.get("/rules", response_model=list[RuleOut])
async def list_rules(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(
        select(RefCollectRule).order_by(desc(RefCollectRule.added_at)))).scalars().all()
    return rows


@router.post("/rules", response_model=RuleOut, status_code=201)
async def create_rule(body: RuleCreate, db: AsyncSession = Depends(get_db)):
    obj = RefCollectRule(**body.model_dump(), added_at=datetime.now(timezone.utc))
    db.add(obj)
    await db.commit()
    await db.refresh(obj)
    return obj


@router.patch("/rules/{rid}", response_model=RuleOut)
async def patch_rule(rid: int, body: RulePatch, db: AsyncSession = Depends(get_db)):
    obj = await db.get(RefCollectRule, rid)
    if not obj:
        raise HTTPException(404, "规则不存在")
    for f, v in body.model_dump(exclude_none=True).items():
        setattr(obj, f, v)
    await db.commit()
    await db.refresh(obj)
    return obj


@router.delete("/rules/{rid}")
async def delete_rule(rid: int, db: AsyncSession = Depends(get_db)):
    obj = await db.get(RefCollectRule, rid)
    if not obj:
        raise HTTPException(404, "规则不存在")
    await db.delete(obj)
    await db.commit()
    return {"ok": True}


@router.post("/rules/{rid}/collect")
async def collect_one_rule(rid: int, db: AsyncSession = Depends(get_db)):
    rule = await db.get(RefCollectRule, rid)
    if not rule:
        raise HTTPException(404, "规则不存在")
    try:
        n = await collect_rule(db, rule)
    except Exception as e:
        raise HTTPException(502, str(e))
    return {"ok": True, "new_raw": n}


@router.post("/collect-all")
async def collect_all_rules(db: AsyncSession = Depends(get_db)):
    return {"ok": True, **(await collect_all(db))}


class CleanBatchBody(BaseModel):
    size: Optional[int] = None


@router.post("/clean-batch")
async def clean_batch_endpoint(body: CleanBatchBody, db: AsyncSession = Depends(get_db)):
    cfg = await get_config()
    size = body.size or int(cfg.get("clean_batch_size", 20))
    try:
        result = await clean_batch(db, size)
    except Exception as e:
        raise HTTPException(502, f"LLM 精筛失败：{str(e)[:200]}")
    return {"ok": True, **result}
