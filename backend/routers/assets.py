import os
import uuid
import re
import hashlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from fastapi import APIRouter, Depends, File, Header, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import delete, desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import (
    AssetIngestionDecision,
    ContentJob,
    CreativeAsset,
    CreativeAssetDirectory,
    PromptGeneration,
    TopicSourceDecision,
    TopicSourceRule,
    XPost,
    XSubscription,
    XSubscriptionIngestionDirectory,
)
from remote_image_import import import_remote_images
from content_jobs import create_job
from job_queue import enqueue_job
from worker_auth import require_worker_token

router = APIRouter(prefix="/assets", tags=["assets"])
AssetType = Literal["article", "media", "prompt"]
_UPLOADS_DIR = os.path.join(os.path.dirname(__file__), "..", "uploads")

class AssetOut(BaseModel):
    id: int
    asset_type: AssetType
    prompt_kind: str = ""
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
    prompt_kind: Literal["image", "video", "other"] | None = None
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
    prompt_kind: Literal["image", "video", "other"] | None = None
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
    ai_ingestion_enabled: bool = False
    ai_ingestion_keywords: list[str] = Field(default_factory=list)
    ai_ingestion_prompt: str = ""
    created_at: datetime


class PromptGenerationAttach(BaseModel):
    media_asset_id: int
    provider: str = Field(default="", max_length=200)
    model: str = Field(default="", max_length=200)


class PromptGenerationSucceed(BaseModel):
    media_asset_id: int
    provider: str = Field(min_length=1, max_length=200)
    model: str = Field(min_length=1, max_length=200)


class PromptGenerationFail(BaseModel):
    error: str = Field(min_length=1, max_length=2000)


class PromptGenerationOut(BaseModel):
    id: int
    prompt_asset_id: int
    media_asset_id: int | None
    provider: str
    model: str
    status: Literal["queued", "running", "succeeded", "failed"]
    job_id: int | None
    error: str
    generated_at: datetime | None
    created_at: datetime
    media: AssetOut | None = None


class DirectoryIngestionRulePatch(BaseModel):
    enabled: bool = False
    keywords: list[str] = Field(default_factory=list)
    prompt: str = Field(default="", max_length=4000)


class DirectoryIngestionRuleOut(BaseModel):
    directory_id: int
    enabled: bool
    keywords: list[str]
    prompt: str


class TopicSourceRuleCreate(BaseModel):
    subscription_id: int
    directory: str = Field(min_length=1, max_length=80)
    keywords: list[str] = Field(default_factory=list)
    screening_prompt: str = Field(default="", max_length=4000)


class TopicSourceRulePatch(BaseModel):
    directory: str | None = Field(default=None, min_length=1, max_length=80)
    keywords: list[str] | None = None
    screening_prompt: str | None = Field(default=None, max_length=4000)
    enabled: bool | None = None


class TopicSourceRuleOut(BaseModel):
    id: int
    subscription_id: int
    directory: str
    keywords: list[str]
    screening_prompt: str
    enabled: bool
    created_at: datetime
    updated_at: datetime
    model_config = {"from_attributes": True}


class TopicSourceDecisionInput(BaseModel):
    tweet_id: str = Field(min_length=1)
    accepted: bool


class TopicSourceAccept(BaseModel):
    decisions: list[TopicSourceDecisionInput] = Field(default_factory=list)


class AssetIngestionDecisionInput(BaseModel):
    tweet_id: str = Field(min_length=1)
    directory_id: int | None = None


class AssetIngestionAccept(BaseModel):
    subscription_id: int
    decisions: list[AssetIngestionDecisionInput] = Field(default_factory=list)


class DailyCandidateRequest(BaseModel):
    directory: str = Field(min_length=1, max_length=80)
    limit: int = Field(default=10, ge=1, le=10)


class RemoteImageImportBody(BaseModel):
    urls: list[str] = Field(min_length=1, max_length=20)


class RemoteImageImportItem(BaseModel):
    source_url: str
    url: str = ""
    error_code: str = ""
    error: str = ""


class RemoteImageImportOut(BaseModel):
    items: list[RemoteImageImportItem]


def _directory_payload(directory: CreativeAssetDirectory) -> dict:
    return {
        "id": directory.id,
        "name": directory.name,
        "asset_type": directory.asset_type,
        "parent_id": directory.parent_id,
        "is_system": bool(directory.system_key),
        "ai_ingestion_enabled": bool(directory.ai_ingestion_enabled),
        "ai_ingestion_keywords": list(directory.ai_ingestion_keywords or []),
        "ai_ingestion_prompt": directory.ai_ingestion_prompt or "",
        "created_at": directory.created_at,
    }


def _directory_ingestion_payload(directory: CreativeAssetDirectory) -> dict:
    return {
        "directory_id": directory.id,
        "enabled": bool(directory.ai_ingestion_enabled),
        "keywords": list(directory.ai_ingestion_keywords or []),
        "prompt": directory.ai_ingestion_prompt or "",
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


def _asset_payload(asset: CreativeAsset | None) -> AssetOut | None:
    if asset is None:
        return None
    return AssetOut.model_validate(asset)


def _generation_payload(
    generation: PromptGeneration,
    media: CreativeAsset | None = None,
) -> dict:
    return {
        "id": generation.id,
        "prompt_asset_id": generation.prompt_asset_id,
        "media_asset_id": generation.media_asset_id,
        "provider": generation.provider,
        "model": generation.model,
        "status": generation.status,
        "job_id": generation.job_id,
        "error": generation.error,
        "generated_at": generation.generated_at,
        "created_at": generation.created_at,
        "media": _asset_payload(media),
    }


async def _prompt_asset(
    db: AsyncSession,
    asset_id: int,
) -> CreativeAsset:
    asset = await db.get(CreativeAsset, asset_id)
    if asset is None:
        raise HTTPException(404, "提示词资产不存在")
    if asset.asset_type != "prompt":
        raise HTTPException(422, "该资产不是提示词资产")
    return asset


async def _prompt_history_limit() -> int:
    try:
        from config import get_config

        raw_value = (await get_config()).get(
            "prompt_generation_history_limit",
            "3",
        )
        return max(1, min(20, int(raw_value)))
    except (TypeError, ValueError, RuntimeError):
        return 3


def _validate_prompt_media(
    prompt: CreativeAsset,
    media: CreativeAsset,
) -> None:
    if media.asset_type != "media":
        raise HTTPException(422, "只能关联多媒体资产")
    if prompt.prompt_kind not in {"image", "video"}:
        raise HTTPException(422, "其他提示词不能关联生成媒体")
    if media.media_kind != prompt.prompt_kind:
        raise HTTPException(422, "提示词类型与媒体类型不匹配")


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


async def _selected_ingestion_directories(
    db: AsyncSession,
    subscription_id: int,
    directory_ids: list[int],
) -> list[CreativeAssetDirectory]:
    subscription = await db.get(XSubscription, subscription_id)
    if subscription is None:
        raise HTTPException(404, "X 订阅不存在")
    requested = list(dict.fromkeys(directory_ids))
    stmt = (
        select(CreativeAssetDirectory)
        .join(
            XSubscriptionIngestionDirectory,
            XSubscriptionIngestionDirectory.directory_id == CreativeAssetDirectory.id,
        )
        .where(
            XSubscriptionIngestionDirectory.subscription_id == subscription_id,
            CreativeAssetDirectory.asset_type == "article",
        )
        .order_by(CreativeAssetDirectory.id)
    )
    if requested:
        stmt = stmt.where(CreativeAssetDirectory.id.in_(requested))
    directories = (await db.execute(stmt)).scalars().all()
    if requested and {directory.id for directory in directories} != set(requested):
        raise HTTPException(422, "只能使用该 X 订阅已选择的文章目录")
    unavailable = [
        directory.id for directory in directories
        if not directory.ai_ingestion_enabled
        or not (directory.ai_ingestion_prompt or "").strip()
    ]
    if unavailable:
        raise HTTPException(422, "所选目录的 AI 素材入库规则未启用")
    return directories


async def _asset_ingestion_candidates(
    db: AsyncSession,
    subscription_id: int,
    directories: list[CreativeAssetDirectory],
    tweet_ids: list[str] | None = None,
) -> list[XPost]:
    posts = (await db.execute(
        select(XPost)
        .where(XPost.subscription_id == subscription_id)
        .order_by(desc(XPost.published_at))
    )).scalars().all()
    decided_ids = set((await db.execute(
        select(AssetIngestionDecision.tweet_id).where(
            AssetIngestionDecision.subscription_id == subscription_id,
        )
    )).scalars().all())
    requested = set(tweet_ids or [])
    return [
        post for post in posts
        if post.tweet_id not in decided_ids
        and (not requested or post.tweet_id in requested)
        and post.content.strip()
        and any(_keyword_matches(post.content, directory.ai_ingestion_keywords or []) for directory in directories)
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


@router.get("/directories/{directory_id}/ingestion-rule", response_model=DirectoryIngestionRuleOut)
async def get_directory_ingestion_rule(
    directory_id: int,
    db: AsyncSession = Depends(get_db),
):
    directory = await db.get(CreativeAssetDirectory, directory_id)
    if directory is None:
        raise HTTPException(404, "目录不存在")
    if directory.asset_type != "article":
        raise HTTPException(422, "只有文章目录可以配置 AI 素材入库")
    return _directory_ingestion_payload(directory)


@router.put("/directories/{directory_id}/ingestion-rule", response_model=DirectoryIngestionRuleOut)
async def update_directory_ingestion_rule(
    directory_id: int,
    body: DirectoryIngestionRulePatch,
    db: AsyncSession = Depends(get_db),
):
    directory = await db.get(CreativeAssetDirectory, directory_id)
    if directory is None:
        raise HTTPException(404, "目录不存在")
    if directory.asset_type != "article":
        raise HTTPException(422, "只有文章目录可以配置 AI 素材入库")
    prompt = body.prompt.strip()
    if body.enabled and not prompt:
        raise HTTPException(422, "启用 AI 素材入库时必须填写规则")
    directory.ai_ingestion_enabled = body.enabled
    directory.ai_ingestion_keywords = [
        keyword.strip() for keyword in body.keywords if keyword.strip()
    ]
    directory.ai_ingestion_prompt = prompt
    await db.commit()
    await db.refresh(directory)
    return _directory_ingestion_payload(directory)

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
    if any(item.ai_ingestion_enabled for item in descendants):
        raise HTTPException(409, "请先停用该目录的 AI 素材入库规则")
    association = await db.scalar(select(XSubscriptionIngestionDirectory.id).where(
        XSubscriptionIngestionDirectory.directory_id.in_(known_ids),
    ))
    if association is not None:
        raise HTTPException(409, "请先解除 X 订阅与该目录的关联")
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
        screening_prompt=body.screening_prompt.strip(),
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
    if body.directory is not None:
        directory = body.directory.strip()
        if not directory:
            raise HTTPException(422, "主题目录不能为空")
        duplicate = await db.scalar(select(TopicSourceRule).where(
            TopicSourceRule.subscription_id == rule.subscription_id,
            TopicSourceRule.directory == directory,
            TopicSourceRule.id != rule.id,
        ))
        if duplicate is not None:
            raise HTTPException(409, "该订阅已配置此主题目录")
        rule.directory = directory
    if body.keywords is not None:
        rule.keywords = [keyword.strip() for keyword in body.keywords if keyword.strip()]
    if body.screening_prompt is not None:
        rule.screening_prompt = body.screening_prompt.strip()
    if body.enabled is not None:
        rule.enabled = body.enabled
    if rule.enabled:
        other_rules = (await db.execute(select(TopicSourceRule).where(
            TopicSourceRule.subscription_id == rule.subscription_id,
            TopicSourceRule.id != rule.id,
            TopicSourceRule.enabled.is_(True),
        ))).scalars().all()
        for other_rule in other_rules:
            other_rule.enabled = False
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


@router.post("/images/import", response_model=RemoteImageImportOut)
async def import_asset_images(body: RemoteImageImportBody):
    results = await import_remote_images(body.urls, Path(_UPLOADS_DIR))
    return {"items": [
        {
            "source_url": item.source_url,
            "url": item.url,
            "error_code": item.error_code,
            "error": item.error,
        }
        for item in results
    ]}


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
    return {"rule": {
        "id": rule.id,
        "directory": rule.directory,
        "keywords": rule.keywords,
        "screening_prompt": rule.screening_prompt,
    }, "posts": [
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


@router.get("/ingestion/candidates")
async def asset_ingestion_candidates(
    subscription_id: int,
    directory_ids: list[int] = Query(default=[]),
    tweet_ids: list[str] = Query(default=[]),
    db: AsyncSession = Depends(get_db),
):
    directories = await _selected_ingestion_directories(
        db, subscription_id, directory_ids,
    )
    posts = await _asset_ingestion_candidates(
        db, subscription_id, directories, tweet_ids,
    )
    return {
        "directories": [
            {
                "id": directory.id,
                "name": directory.name,
                "keywords": list(directory.ai_ingestion_keywords or []),
                "prompt": directory.ai_ingestion_prompt or "",
            }
            for directory in directories
        ],
        "posts": [
            {
                "tweet_id": post.tweet_id,
                "content": post.content,
                "url": post.url,
            }
            for post in posts
        ],
    }


@router.post("/ingestion/accepted")
async def save_asset_ingestion_decisions(
    body: AssetIngestionAccept,
    worker_token: str | None = Header(default=None, alias="X-WMS-Worker-Token"),
    db: AsyncSession = Depends(get_db),
):
    require_worker_token(worker_token)
    directories = await _selected_ingestion_directories(
        db, body.subscription_id, [],
    )
    directory_by_id = {directory.id: directory for directory in directories}
    for decision in body.decisions:
        if decision.directory_id is not None and decision.directory_id not in directory_by_id:
            raise HTTPException(422, "AI 返回了未选择的文章目录")

    posts = await _asset_ingestion_candidates(
        db, body.subscription_id, directories,
    )
    allowed = {post.tweet_id: post for post in posts}
    existing_ids = set((await db.execute(
        select(AssetIngestionDecision.tweet_id).where(
            AssetIngestionDecision.subscription_id == body.subscription_id,
        )
    )).scalars().all())
    seen: set[str] = set()
    saved = 0
    skipped = 0
    decided = 0
    for decision in body.decisions:
        if decision.tweet_id in seen:
            raise HTTPException(422, "同一条帖子不能提交多个分类结果")
        seen.add(decision.tweet_id)
        if decision.tweet_id in existing_ids:
            skipped += 1
            continue
        post = allowed.get(decision.tweet_id)
        if post is None:
            skipped += 1
            continue
        db.add(AssetIngestionDecision(
            subscription_id=body.subscription_id,
            tweet_id=post.tweet_id,
            directory_id=decision.directory_id,
        ))
        decided += 1
        if decision.directory_id is None:
            continue
        directory = directory_by_id[decision.directory_id]
        try:
            await _ensure_unique_article(
                db,
                content=post.content,
                url=post.url,
                directory=directory.name,
            )
        except HTTPException as exc:
            if exc.status_code == 409:
                skipped += 1
                continue
            raise
        db.add(CreativeAsset(
            asset_type="article",
            media_kind="",
            title="",
            content=post.content,
            url=post.url,
            media_type="",
            filename="",
            directory=directory.name,
            tags=[],
            source="x_topic",
        ))
        saved += 1
    await db.commit()
    return {"saved": saved, "skipped": skipped, "decided": decided}


@router.get(
    "/{prompt_asset_id}/generations",
    response_model=list[PromptGenerationOut],
)
async def list_prompt_generations(
    prompt_asset_id: int,
    limit: int | None = Query(default=None, ge=1, le=20),
    db: AsyncSession = Depends(get_db),
):
    await _prompt_asset(db, prompt_asset_id)
    history_limit = limit or await _prompt_history_limit()
    generations = (
        await db.execute(
            select(PromptGeneration)
            .where(PromptGeneration.prompt_asset_id == prompt_asset_id)
            .order_by(
                desc(PromptGeneration.created_at),
                desc(PromptGeneration.id),
            )
            .limit(history_limit)
        )
    ).scalars().all()
    media_ids = {
        generation.media_asset_id
        for generation in generations
        if generation.media_asset_id is not None
    }
    media_by_id = {}
    if media_ids:
        media_by_id = {
            asset.id: asset
            for asset in (
                await db.execute(
                    select(CreativeAsset).where(CreativeAsset.id.in_(media_ids))
                )
            ).scalars().all()
        }
    return [
        _generation_payload(generation, media_by_id.get(generation.media_asset_id))
        for generation in generations
    ]


@router.post(
    "/{prompt_asset_id}/generations",
    response_model=PromptGenerationOut,
    status_code=201,
)
async def create_prompt_generation(
    prompt_asset_id: int,
    db: AsyncSession = Depends(get_db),
):
    prompt = await _prompt_asset(db, prompt_asset_id)
    if prompt.prompt_kind != "image":
        raise HTTPException(422, "第一版只支持图片提示词直接生成")

    generation = PromptGeneration(
        prompt_asset_id=prompt.id,
        provider="openai-compatible",
        model="",
        status="queued",
    )
    db.add(generation)
    await db.flush()
    job = await create_job(
        db,
        flow="prompt_image_generation",
        title=f"[提示词图片] {prompt.title or prompt.id}",
        input_data={
            "prompt_asset_id": prompt.id,
            "generation_id": generation.id,
            "prompt_snapshot": prompt.content.strip(),
            "title_snapshot": prompt.title,
        },
        commit=False,
    )
    generation.job_id = job.id
    await db.commit()
    await db.refresh(generation)
    await enqueue_job(job.id)
    return _generation_payload(generation)


@router.post(
    "/{prompt_asset_id}/generations/attach",
    response_model=PromptGenerationOut,
    status_code=201,
)
async def attach_prompt_generation(
    prompt_asset_id: int,
    body: PromptGenerationAttach,
    db: AsyncSession = Depends(get_db),
):
    prompt = await _prompt_asset(db, prompt_asset_id)
    media = await db.get(CreativeAsset, body.media_asset_id)
    if media is None:
        raise HTTPException(404, "多媒体资产不存在")
    _validate_prompt_media(prompt, media)
    generation = PromptGeneration(
        prompt_asset_id=prompt.id,
        media_asset_id=media.id,
        provider=body.provider.strip() or "manual",
        model=body.model.strip() or "手动补录",
        status="succeeded",
        generated_at=datetime.now(timezone.utc),
    )
    db.add(generation)
    await db.commit()
    await db.refresh(generation)
    return _generation_payload(generation, media)


@router.post(
    "/generations/{generation_id}/succeed",
    response_model=PromptGenerationOut,
)
async def succeed_prompt_generation(
    generation_id: int,
    body: PromptGenerationSucceed,
    worker_token: str | None = Header(default=None, alias="X-WMS-Worker-Token"),
    db: AsyncSession = Depends(get_db),
):
    require_worker_token(worker_token)
    generation = await db.get(PromptGeneration, generation_id)
    if generation is None:
        raise HTTPException(404, "提示词生成记录不存在")
    prompt = await _prompt_asset(db, generation.prompt_asset_id)
    media = await db.get(CreativeAsset, body.media_asset_id)
    if media is None:
        raise HTTPException(404, "多媒体资产不存在")
    _validate_prompt_media(prompt, media)
    if generation.status == "failed":
        raise HTTPException(409, "生成记录已失败，不能标记成功")
    if generation.status == "succeeded" and generation.media_asset_id != media.id:
        raise HTTPException(409, "生成记录已经关联其他媒体")
    provider = body.provider.strip()
    model = body.model.strip()
    if not provider or not model:
        raise HTTPException(422, "必须记录实际生成服务和模型")
    generation.media_asset_id = media.id
    generation.provider = provider
    generation.model = model
    generation.status = "succeeded"
    generation.error = ""
    generation.generated_at = generation.generated_at or datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(generation)
    return _generation_payload(generation, media)


@router.post(
    "/generations/{generation_id}/fail",
    response_model=PromptGenerationOut,
)
async def fail_prompt_generation(
    generation_id: int,
    body: PromptGenerationFail,
    worker_token: str | None = Header(default=None, alias="X-WMS-Worker-Token"),
    db: AsyncSession = Depends(get_db),
):
    require_worker_token(worker_token)
    generation = await db.get(PromptGeneration, generation_id)
    if generation is None:
        raise HTTPException(404, "提示词生成记录不存在")
    if generation.status == "succeeded":
        raise HTTPException(409, "生成记录已成功，不能标记失败")
    generation.status = "failed"
    generation.error = body.error.strip()[:500]
    generation.generated_at = None
    await db.commit()
    await db.refresh(generation)
    media = (
        await db.get(CreativeAsset, generation.media_asset_id)
        if generation.media_asset_id is not None
        else None
    )
    return _generation_payload(generation, media)


@router.delete(
    "/{prompt_asset_id}/generations/{generation_id}",
    status_code=204,
)
async def delete_prompt_generation(
    prompt_asset_id: int,
    generation_id: int,
    db: AsyncSession = Depends(get_db),
):
    await _prompt_asset(db, prompt_asset_id)
    generation = await db.scalar(
        select(PromptGeneration).where(
            PromptGeneration.id == generation_id,
            PromptGeneration.prompt_asset_id == prompt_asset_id,
        )
    )
    if generation is None:
        raise HTTPException(404, "提示词生成记录不存在")
    await db.delete(generation)
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
    if body.asset_type == "prompt":
        if body.prompt_kind not in {"image", "video", "other"}:
            raise HTTPException(422, "提示词类型无效")
        if not body.content.strip():
            raise HTTPException(422, "提示词内容不能为空")
        prompt_kind = body.prompt_kind
        media_kind = ""
    elif body.asset_type == "article":
        if not body.content.strip():
            raise HTTPException(422, "文章资产需要内容")
        prompt_kind = ""
        media_kind = ""
        await _ensure_unique_article(db, content=body.content, url=body.url, directory=body.directory)
    else:
        if not body.url or not body.media_kind:
            raise HTTPException(422, "多媒体资产需要文件和类型")
        prompt_kind = ""
        media_kind = body.media_kind
    asset = CreativeAsset(
        asset_type=body.asset_type,
        prompt_kind=prompt_kind,
        media_kind=media_kind,
        title=body.title,
        content=body.content,
        url=body.url,
        media_type=body.media_type,
        filename=body.filename,
        directory=body.directory,
        tags=body.tags,
        source="manual",
    )
    db.add(asset); await db.commit(); await db.refresh(asset)
    return asset

@router.patch("/{asset_id}", response_model=AssetOut)
async def update_asset(asset_id: int, body: AssetUpdate, db: AsyncSession = Depends(get_db)):
    asset = await db.get(CreativeAsset, asset_id)
    if not asset: raise HTTPException(404, "创作资产不存在")
    values = body.model_dump(exclude_none=True)
    if asset.asset_type == "prompt":
        prompt_kind = values.get("prompt_kind", asset.prompt_kind)
        content = str(values.get("content", asset.content))
        if prompt_kind not in {"image", "video", "other"}:
            raise HTTPException(422, "提示词类型无效")
        if not content.strip():
            raise HTTPException(422, "提示词内容不能为空")
    elif asset.asset_type == "article":
        if "prompt_kind" in values:
            raise HTTPException(422, "文章资产不能设置提示词类型")
        await _ensure_unique_article(db, content=str(values.get("content", asset.content)), url=str(values.get("url", asset.url)), directory=str(values.get("directory", asset.directory)), exclude_id=asset.id)
    elif "prompt_kind" in values:
        raise HTTPException(422, "多媒体资产不能设置提示词类型")
    for key, value in values.items(): setattr(asset, key, value)
    await db.commit(); await db.refresh(asset)
    return asset

@router.delete("/{asset_id}", status_code=204)
async def delete_asset(asset_id: int, db: AsyncSession = Depends(get_db)):
    asset = await db.get(CreativeAsset, asset_id)
    if not asset: raise HTTPException(404, "创作资产不存在")
    upload_path = ""
    if asset.asset_type == "prompt":
        await db.execute(
            delete(PromptGeneration).where(
                PromptGeneration.prompt_asset_id == asset.id,
            )
        )
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
    directory: str = "",
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
    directory_name = directory.strip()
    if directory_name:
        media_directory = await db.scalar(
            select(CreativeAssetDirectory).where(
                CreativeAssetDirectory.asset_type == "media",
                CreativeAssetDirectory.name == directory_name,
            )
        )
        if media_directory is None:
            raise HTTPException(422, "多媒体目录不存在")
        directory_name = media_directory.name
    ext = os.path.splitext(file.filename or "")[1] or ".bin"
    filename = f"{uuid.uuid4().hex}{ext}"
    os.makedirs(_UPLOADS_DIR, exist_ok=True)
    with open(os.path.join(_UPLOADS_DIR, filename), "wb") as output: output.write(data)
    asset = CreativeAsset(asset_type="media", media_kind=media_kind, title=title or file.filename or filename, url=f"/api/uploads/{filename}", media_type=file.content_type, filename=file.filename or filename, directory=directory_name, source="upload")
    db.add(asset); await db.commit(); await db.refresh(asset)
    return asset
