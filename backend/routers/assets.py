import os
import uuid
import re
import hashlib
from datetime import datetime
from typing import Literal
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from fastapi import APIRouter, Depends, File, Header, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import ContentJob, CreativeAsset, CreativeAssetDirectory, TopicSourceDecision, TopicSourceRule, XPost, XSubscription
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


class AssetListOut(BaseModel):
    assets: list[AssetOut]

class AssetUpdate(BaseModel):
    title: str | None = None
    content: str | None = None
    url: str | None = None
    directory: str | None = None
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


class TopicSourceRuleCreate(BaseModel):
    subscription_id: int
    directory: str = Field(min_length=1, max_length=80)
    keywords: list[str] = Field(default_factory=list)


class TopicSourceRulePatch(BaseModel):
    keywords: list[str] | None = None
    enabled: bool | None = None


class TopicSourceRuleOut(BaseModel):
    id: int
    subscription_id: int
    directory: str
    keywords: list[str]
    enabled: bool
    created_at: datetime
    updated_at: datetime
    model_config = {"from_attributes": True}


class TopicSourceDecisionInput(BaseModel):
    tweet_id: str = Field(min_length=1)
    accepted: bool


class TopicSourceAccept(BaseModel):
    decisions: list[TopicSourceDecisionInput] = Field(default_factory=list)


class DailyCandidateRequest(BaseModel):
    directory: str = Field(min_length=1, max_length=80)
    limit: int = Field(default=10, ge=1, le=10)


def _directory_payload(directory: CreativeAssetDirectory) -> dict:
    return {
        "id": directory.id,
        "name": directory.name,
        "asset_type": directory.asset_type,
        "parent_id": directory.parent_id,
        "is_system": bool(directory.system_key),
        "created_at": directory.created_at,
    }


def _normalized_url(value: str) -> str:
    value = value.strip()
    if not value:
        return ""
    parsed = urlsplit(value)
    query = urlencode(sorted((key, item) for key, item in parse_qsl(parsed.query) if not key.lower().startswith("utm_")))
    return urlunsplit((parsed.scheme.lower(), parsed.netloc.lower(), parsed.path.rstrip("/"), query, ""))


def _normalized_content(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def _article_content_hash(value: str) -> str:
    return hashlib.sha256(_normalized_content(value).encode("utf-8")).hexdigest()


async def _ensure_unique_article(db: AsyncSession, *, content: str, url: str, directory: str, exclude_id: int | None = None):
    rows = (await db.execute(select(CreativeAsset).where(
        CreativeAsset.asset_type == "article", CreativeAsset.directory == directory,
    ))).scalars().all()
    key_url = _normalized_url(url)
    key_content = _article_content_hash(content)
    for item in rows:
        if item.id == exclude_id:
            continue
        if key_url and _normalized_url(item.url) == key_url:
            raise HTTPException(409, "该来源 URL 已在此主题素材库中")
        if not key_url and _article_content_hash(item.content) == key_content:
            raise HTTPException(409, "相同内容已在此主题素材库中")


def _keyword_matches(content: str, keywords: list[str]) -> bool:
    normalized = [keyword.strip().lower() for keyword in keywords if keyword.strip()]
    return not normalized or any(keyword in content.lower() for keyword in normalized)


async def _topic_candidates(
    db: AsyncSession,
    rule: TopicSourceRule,
    tweet_ids: list[str] | None = None,
) -> list[XPost]:
    posts = (await db.execute(
        select(XPost)
        .where(XPost.subscription_id == rule.subscription_id)
        .order_by(desc(XPost.published_at))
    )).scalars().all()
    decided_ids = set((await db.execute(
        select(TopicSourceDecision.tweet_id).where(TopicSourceDecision.rule_id == rule.id)
    )).scalars().all())
    requested = set(tweet_ids or [])
    return [
        post for post in posts
        if post.tweet_id not in decided_ids
        and (not requested or post.tweet_id in requested)
        and post.content.strip()
        and _keyword_matches(post.content, rule.keywords)
    ]

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


@router.get("/topic-rules", response_model=list[TopicSourceRuleOut])
async def list_topic_source_rules(db: AsyncSession = Depends(get_db)):
    return (await db.execute(select(TopicSourceRule).order_by(desc(TopicSourceRule.updated_at)))).scalars().all()


@router.post("/topic-rules", response_model=TopicSourceRuleOut, status_code=201)
async def create_topic_source_rule(body: TopicSourceRuleCreate, db: AsyncSession = Depends(get_db)):
    subscription = await db.get(XSubscription, body.subscription_id)
    if subscription is None:
        raise HTTPException(404, "X 订阅不存在")
    directory = body.directory.strip()
    if not directory:
        raise HTTPException(422, "主题目录不能为空")
    rule = TopicSourceRule(
        subscription_id=body.subscription_id,
        directory=directory,
        keywords=[keyword.strip() for keyword in body.keywords if keyword.strip()],
    )
    db.add(rule)
    try:
        await db.commit()
    except Exception:
        await db.rollback()
        raise HTTPException(409, "该订阅已配置此主题目录") from None
    await db.refresh(rule)
    return rule


@router.patch("/topic-rules/{rule_id}", response_model=TopicSourceRuleOut)
async def update_topic_source_rule(rule_id: int, body: TopicSourceRulePatch, db: AsyncSession = Depends(get_db)):
    rule = await db.get(TopicSourceRule, rule_id)
    if rule is None:
        raise HTTPException(404, "主题规则不存在")
    if body.keywords is not None:
        rule.keywords = [keyword.strip() for keyword in body.keywords if keyword.strip()]
    if body.enabled is not None:
        rule.enabled = body.enabled
    await db.commit()
    await db.refresh(rule)
    return rule


@router.delete("/topic-rules/{rule_id}", status_code=204)
async def delete_topic_source_rule(rule_id: int, db: AsyncSession = Depends(get_db)):
    rule = await db.get(TopicSourceRule, rule_id)
    if rule is None:
        raise HTTPException(404, "主题规则不存在")
    await db.delete(rule)
    await db.commit()


@router.get("/topic-rules/{rule_id}/candidates")
async def topic_source_candidates(
    rule_id: int,
    tweet_ids: list[str] = Query(default=[]),
    db: AsyncSession = Depends(get_db),
):
    rule = await db.get(TopicSourceRule, rule_id)
    if rule is None:
        raise HTTPException(404, "主题规则不存在")
    posts = await _topic_candidates(db, rule, tweet_ids)
    return {"rule": {"id": rule.id, "directory": rule.directory, "keywords": rule.keywords}, "posts": [
        {"tweet_id": post.tweet_id, "content": post.content, "url": post.url} for post in posts
    ]}


@router.post("/topic-rules/{rule_id}/accepted")
async def save_topic_source_candidates(
    rule_id: int,
    body: TopicSourceAccept,
    worker_token: str | None = Header(default=None, alias="X-WMS-Worker-Token"),
    db: AsyncSession = Depends(get_db),
):
    require_worker_token(worker_token)
    rule = await db.get(TopicSourceRule, rule_id)
    if rule is None:
        raise HTTPException(404, "主题规则不存在")
    allowed = {post.tweet_id: post for post in await _topic_candidates(db, rule)}
    saved = 0
    skipped = 0
    decided = 0
    seen: set[str] = set()
    for decision in body.decisions:
        if decision.tweet_id in seen:
            continue
        seen.add(decision.tweet_id)
        post = allowed.get(decision.tweet_id)
        if post is None:
            skipped += 1
            continue
        db.add(TopicSourceDecision(
            rule_id=rule.id, tweet_id=post.tweet_id, accepted=decision.accepted,
        ))
        decided += 1
        if decision.accepted:
            try:
                await _ensure_unique_article(db, content=post.content, url=post.url, directory=rule.directory)
            except HTTPException as exc:
                if exc.status_code == 409:
                    skipped += 1
                    continue
                raise
            db.add(CreativeAsset(
                asset_type="article", media_kind="", title="", content=post.content,
                url=post.url, media_type="", filename="", directory=rule.directory,
                tags=[], source="x_topic",
            ))
            saved += 1
    await db.commit()
    return {"saved": saved, "skipped": skipped, "decided": decided}

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


@router.get("/daily-candidates", response_model=AssetListOut)
async def daily_article_candidates(directory: str, limit: int = 10, db: AsyncSession = Depends(get_db)):
    name = directory.strip()
    if not name:
        raise HTTPException(422, "请选择主题目录")
    limit = max(1, min(limit, 10))
    assets = (await db.execute(
        select(CreativeAsset)
        .where(CreativeAsset.asset_type == "article", CreativeAsset.directory == name)
        .order_by(desc(CreativeAsset.updated_at), desc(CreativeAsset.id))
        .limit(limit)
    )).scalars().all()
    return {"assets": assets}


@router.post("/daily-candidates", response_model=AssetListOut)
async def select_daily_article_candidates(
    body: DailyCandidateRequest,
    db: AsyncSession = Depends(get_db),
):
    """Choose fresh material once for a day's secondary-creation shortlist."""
    directory = body.directory.strip()
    assets = (await db.execute(
        select(CreativeAsset)
        .where(
            CreativeAsset.asset_type == "article",
            CreativeAsset.directory == directory,
            CreativeAsset.last_selected_at.is_(None),
        )
        .order_by(desc(CreativeAsset.updated_at), desc(CreativeAsset.id))
        .limit(body.limit)
    )).scalars().all()
    now = datetime.now().astimezone()
    for asset in assets:
        asset.last_selected_at = now
    await db.commit()
    return {"assets": assets}

@router.post("", response_model=AssetOut, status_code=201)
async def create_asset(body: AssetCreate, db: AsyncSession = Depends(get_db)):
    if body.asset_type == "article" and not body.content.strip(): raise HTTPException(422, "文章资产需要内容")
    if body.asset_type != "article" and (not body.url or not body.media_kind): raise HTTPException(422, "多媒体资产需要文件和类型")
    if body.asset_type == "article":
        await _ensure_unique_article(db, content=body.content, url=body.url, directory=body.directory)
    asset = CreativeAsset(**body.model_dump(), source="manual")
    db.add(asset); await db.commit(); await db.refresh(asset)
    return asset

@router.patch("/{asset_id}", response_model=AssetOut)
async def update_asset(asset_id: int, body: AssetUpdate, db: AsyncSession = Depends(get_db)):
    asset = await db.get(CreativeAsset, asset_id)
    if not asset: raise HTTPException(404, "创作资产不存在")
    values = body.model_dump(exclude_none=True)
    if asset.asset_type == "article":
        await _ensure_unique_article(db, content=str(values.get("content", asset.content)), url=str(values.get("url", asset.url)), directory=str(values.get("directory", asset.directory)), exclude_id=asset.id)
    for key, value in values.items(): setattr(asset, key, value)
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
