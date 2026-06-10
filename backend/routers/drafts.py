import mimetypes
import os
import uuid
import httpx
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc
from pydantic import BaseModel
from typing import Optional

import wechat_api_client as wx
from database import get_db
from models import ArticleDraft, ArticleSeries, DraftImage, PublishAccount

_UPLOADS_DIR = os.path.join(os.path.dirname(__file__), "..", "uploads")
_ALLOWED_MIME = {"image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml", "image/avif"}
_MAX_SIZE = 10 * 1024 * 1024
_BASE_URL = os.getenv("WMS_BASE_URL", "http://localhost:8000")
from schemas import ArticleDraftOut, ArticleDraftCreate, ArticleDraftUpdate, ArticleSeriesOut, ArticleSeriesCreate, ArticleSeriesUpdate


class ChatMessage(BaseModel):
    role: str   # "user" | "assistant"
    content: str

class DraftChatRequest(BaseModel):
    message: str
    history: list[ChatMessage] = []   # used only when Hermes is not configured
    session_name: Optional[str] = None  # override conversation name (for "new chat")

class DraftChatResponse(BaseModel):
    reply: str
    updated_content: Optional[str] = None
    session_name: str = ""


class WechatPublishRequest(BaseModel):
    account_id: str
    title: str
    digest: str = ""
    html: str               # 前端 wenyan 渲染好的内联样式 HTML
    cover_image_id: int


class WechatPublishResponse(BaseModel):
    media_id: str

router = APIRouter(prefix="/write", tags=["drafts"])


# ── Drafts ────────────────────────────────────────────────────────────────────

@router.post("/drafts", response_model=ArticleDraftOut, status_code=201)
async def create_draft(body: ArticleDraftCreate, db: AsyncSession = Depends(get_db)):
    obj = ArticleDraft(**body.model_dump())
    db.add(obj)
    await db.commit()
    await db.refresh(obj)
    return obj


@router.get("/drafts", response_model=list[ArticleDraftOut])
async def list_drafts(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(
        select(ArticleDraft).order_by(desc(ArticleDraft.updated_at))
    )).scalars().all()
    return rows


@router.get("/drafts/{draft_id}", response_model=ArticleDraftOut)
async def get_draft(draft_id: int, db: AsyncSession = Depends(get_db)):
    obj = await db.get(ArticleDraft, draft_id)
    if not obj:
        raise HTTPException(404, "Draft not found")
    return obj


@router.patch("/drafts/{draft_id}", response_model=ArticleDraftOut)
async def update_draft(draft_id: int, body: ArticleDraftUpdate, db: AsyncSession = Depends(get_db)):
    obj = await db.get(ArticleDraft, draft_id)
    if not obj:
        raise HTTPException(404, "Draft not found")
    for field, val in body.model_dump(exclude_none=True).items():
        setattr(obj, field, val)
    await db.commit()
    await db.refresh(obj)
    return obj


@router.post("/drafts/{draft_id}/chat", response_model=DraftChatResponse)
async def chat_with_draft(draft_id: int, body: DraftChatRequest, db: AsyncSession = Depends(get_db)):
    obj = await db.get(ArticleDraft, draft_id)
    if not obj:
        raise HTTPException(404, "Draft not found")

    draft_type = getattr(obj, "draft_type", "article")
    type_hints = {
        "article": ("自媒体文章", ""),
        "x": (
            "X（推特）帖子",
            "X 帖子限 280 字符，语言简洁有力，善用换行增强节奏，可以写成线程（thread）形式。"
            "避免冗余，每句话都要有信息量，结尾可带一个开放性问题或观点引发互动。",
        ),
        "mp": (
            "微信公众号文章",
            "公众号文章读者在手机阅读，段落要短，多用小标题和列表，语言亲切但有深度。"
            "开头要有钩子，结尾引导关注/转发。",
        ),
        "bili": (
            "哔哩哔哩视频稿",
            "B 站视频脚本，语言口语化、有活力，可以加一些弹幕感的表达。"
            "开头要有强钩子留住观众，结尾引导三连（点赞投币收藏）。节奏明快，避免冗长铺垫。",
        ),
        "xhs": (
            "小红书笔记",
            "小红书笔记要「种草感」强，语言活泼口语化，多用 emoji，段落极短（1-3 句），"
            "用换行制造视觉层次。标题要有爆款感（数字/疑问/痛点），正文多用「！」增强感染力，"
            "结尾加 3-5 个话题标签（#xxx）。",
        ),
    }
    type_desc, type_hint = type_hints.get(draft_type, type_hints["article"])

    context = (
        f"你是一位专业的中文内容创作助手，帮助用户修改和优化{type_desc}。\n"
        + (f"{type_hint}\n" if type_hint else "")
        + f"\n当前草稿内容：\n"
        f"【标题】{obj.title or '（无标题）'}\n\n"
        f"【正文】\n{obj.content or '（空）'}\n\n"
        "你可以回答问题、给出修改建议、润色语言、调整结构，也可以直接重写段落或整篇内容。\n"
        "【规则】只要涉及对正文的实质性修改（润色、改写、扩写、压缩、调整结构等），"
        "必须在回复末尾追加完整修改版本，格式如下（只输出正文 Markdown，不含标题行，不要省略任何段落）：\n"
        "===UPDATED===\n(修改后完整正文)\n===END===\n"
        "如果用户只是提问或你只给出建议而未实际改写，则不需要追加该标记。"
    )

    full_message = f"{context}\n\n---\n\n用户请求：{body.message}"

    session_name = body.session_name or f"draft-edit-{draft_id}"

    try:
        from llm import _named_session_chat
        raw = await _named_session_chat(
            message=full_message,
            conversation=session_name,
        )
    except Exception as e:
        raise HTTPException(500, f"LLM 调用失败: {e}")

    updated_content: Optional[str] = None
    reply = raw
    s = raw.find("===UPDATED===")
    e_idx = raw.find("===END===")
    if s != -1 and e_idx != -1:
        updated_content = raw[s + 13: e_idx].strip()
        reply = raw[:s].strip()

    return DraftChatResponse(reply=reply, updated_content=updated_content, session_name=session_name)


async def _resolve_root_id(draft_id: int, db: AsyncSession) -> int:
    """Return the root draft ID for any draft in a group."""
    obj = await db.get(ArticleDraft, draft_id)
    if not obj:
        raise HTTPException(404, "Draft not found")
    return obj.linked_draft_id if obj.linked_draft_id else obj.id


@router.get("/drafts/{draft_id}/images")
async def list_draft_images(draft_id: int, db: AsyncSession = Depends(get_db)):
    root_id = await _resolve_root_id(draft_id, db)
    rows = (await db.execute(
        select(DraftImage)
        .where(DraftImage.root_draft_id == root_id)
        .order_by(desc(DraftImage.created_at))
    )).scalars().all()
    return [
        {
            "id": img.id,
            "filename": img.filename,
            "original_name": img.original_name,
            "url": img.url,
            "hosted_url": f"{_BASE_URL}{img.url}",
            "size_bytes": img.size_bytes,
            "mime_type": img.mime_type,
            "created_at": img.created_at.isoformat(),
        }
        for img in rows
    ]


@router.post("/drafts/{draft_id}/images", status_code=201)
async def upload_draft_image(
    draft_id: int,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
):
    root_id = await _resolve_root_id(draft_id, db)

    ct = file.content_type or "image/jpeg"
    if ct not in _ALLOWED_MIME:
        raise HTTPException(400, f"不支持的文件类型: {ct}")

    data = await file.read()
    if len(data) > _MAX_SIZE:
        raise HTTPException(413, "文件超过 10MB 限制")

    ext = (file.filename or "img").rsplit(".", 1)[-1].lower()
    if ext in ("jpg", "jpeg"):
        ext = "jpg"
    filename = f"{uuid.uuid4().hex}.{ext}"
    os.makedirs(_UPLOADS_DIR, exist_ok=True)
    with open(os.path.join(_UPLOADS_DIR, filename), "wb") as f:
        f.write(data)

    url = f"/api/uploads/{filename}"
    img = DraftImage(
        root_draft_id=root_id,
        filename=filename,
        original_name=file.filename or "",
        url=url,
        size_bytes=len(data),
        mime_type=ct,
    )
    db.add(img)
    await db.commit()
    await db.refresh(img)

    return {
        "id": img.id,
        "filename": img.filename,
        "original_name": img.original_name,
        "url": img.url,
        "hosted_url": f"{_BASE_URL}{img.url}",
        "size_bytes": img.size_bytes,
        "mime_type": img.mime_type,
        "created_at": img.created_at.isoformat(),
    }


@router.delete("/drafts/{draft_id}/images/{image_id}", status_code=204)
async def delete_draft_image(draft_id: int, image_id: int, db: AsyncSession = Depends(get_db)):
    root_id = await _resolve_root_id(draft_id, db)
    img = await db.get(DraftImage, image_id)
    if not img or img.root_draft_id != root_id:
        raise HTTPException(404, "Image not found")
    # Remove file from disk
    filepath = os.path.join(_UPLOADS_DIR, img.filename)
    if os.path.isfile(filepath):
        os.remove(filepath)
    await db.delete(img)
    await db.commit()


# ── 发布到公众号 ──────────────────────────────────────────────────────────────

async def _load_image_bytes(src: str) -> tuple[bytes, str]:
    """把 <img src> 解析成字节。本站 uploads 直接读盘，其余按外链下载。"""
    if "/api/uploads/" in src:
        filename = src.rsplit("/", 1)[-1].split("?")[0]
        path = os.path.join(_UPLOADS_DIR, filename)
        if not os.path.isfile(path):
            raise HTTPException(404, f"图片文件缺失: {filename}")
        mime = mimetypes.guess_type(filename)[0] or "image/jpeg"
        with open(path, "rb") as f:
            return f.read(), mime
    if src.startswith(("http://", "https://")):
        async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
            resp = await client.get(src)
            if resp.status_code != 200:
                raise HTTPException(502, f"外链图片下载失败({resp.status_code}): {src}")
            return resp.content, (resp.headers.get("content-type") or "image/jpeg").split(";")[0]
    raise HTTPException(400, f"无法解析图片地址: {src}")


@router.post("/drafts/{draft_id}/publish/wechat", response_model=WechatPublishResponse)
async def publish_draft_to_wechat(
    draft_id: int, body: WechatPublishRequest, db: AsyncSession = Depends(get_db),
):
    draft = await db.get(ArticleDraft, draft_id)
    if not draft:
        raise HTTPException(404, "Draft not found")
    account = await db.get(PublishAccount, body.account_id)
    if not account:
        raise HTTPException(404, "发布账号不存在")
    if not account.app_id or not account.app_secret:
        raise HTTPException(400, "该账号未配置 AppID/AppSecret，请到设置页补全")

    root_id = await _resolve_root_id(draft_id, db)
    cover = await db.get(DraftImage, body.cover_image_id)
    if not cover or cover.root_draft_id != root_id:
        raise HTTPException(404, "封面图不存在")
    cover_path = os.path.join(_UPLOADS_DIR, cover.filename)
    if not os.path.isfile(cover_path):
        raise HTTPException(404, "封面图文件缺失")

    html = body.html
    try:
        # 正文图片逐张传微信图床并替换 src —— 外域图片微信会剥离
        mapping: dict[str, str] = {}
        for src in wx.extract_image_srcs(html):
            data, mime = await _load_image_bytes(src)
            prepared, ext, p_mime = wx.prepare_image_bytes(data, mime)
            mapping[src] = await wx.upload_content_image(
                account.app_id, account.app_secret, prepared, f"img.{ext}", p_mime)
        html = wx.replace_image_srcs(html, mapping)

        with open(cover_path, "rb") as f:
            cover_data = f.read()
        c_data, c_ext, c_mime = wx.prepare_image_bytes(cover_data, cover.mime_type)
        thumb_media_id = await wx.add_thumb_material(
            account.app_id, account.app_secret, c_data, f"cover.{c_ext}", c_mime)

        media_id = await wx.add_draft(account.app_id, account.app_secret, {
            "title": body.title[:64],
            "digest": body.digest[:120],
            "content": html,
            "thumb_media_id": thumb_media_id,
            "need_open_comment": 1,
            "only_fans_can_comment": 0,
        })
    except wx.WechatApiError as e:
        raise HTTPException(502, str(e))
    except httpx.HTTPError as e:
        raise HTTPException(502, f"微信接口网络请求失败: {e}")
    return WechatPublishResponse(media_id=media_id)


@router.delete("/drafts/{draft_id}", status_code=204)
async def delete_draft(draft_id: int, db: AsyncSession = Depends(get_db)):
    obj = await db.get(ArticleDraft, draft_id)
    if not obj:
        raise HTTPException(404, "Draft not found")
    # Clean up images keyed on this draft. `root_draft_id == draft_id` only
    # matches when this is the group root, so deleting a child (thread)
    # draft leaves the root's images intact.
    images = (await db.execute(
        select(DraftImage).where(DraftImage.root_draft_id == draft_id)
    )).scalars().all()
    for img in images:
        path = os.path.join(_UPLOADS_DIR, img.filename)
        if os.path.isfile(path):
            try:
                os.remove(path)
            except OSError:
                pass  # best-effort: don't block the draft delete on filesystem hiccups
        await db.delete(img)
    await db.delete(obj)
    await db.commit()


# ── Series ────────────────────────────────────────────────────────────────────

@router.get("/series", response_model=list[ArticleSeriesOut])
async def list_series(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(
        select(ArticleSeries).order_by(ArticleSeries.sort_order, ArticleSeries.created_at)
    )).scalars().all()
    return rows


@router.post("/series", response_model=ArticleSeriesOut, status_code=201)
async def create_series(body: ArticleSeriesCreate, db: AsyncSession = Depends(get_db)):
    obj = ArticleSeries(**body.model_dump())
    db.add(obj)
    await db.commit()
    await db.refresh(obj)
    return obj


@router.patch("/series/{series_id}", response_model=ArticleSeriesOut)
async def update_series(series_id: int, body: ArticleSeriesUpdate, db: AsyncSession = Depends(get_db)):
    obj = await db.get(ArticleSeries, series_id)
    if not obj:
        raise HTTPException(404, "Series not found")
    for field, val in body.model_dump(exclude_none=True).items():
        setattr(obj, field, val)
    await db.commit()
    await db.refresh(obj)
    return obj


@router.delete("/series/{series_id}", status_code=204)
async def delete_series(series_id: int, db: AsyncSession = Depends(get_db)):
    obj = await db.get(ArticleSeries, series_id)
    if not obj:
        raise HTTPException(404, "Series not found")
    await db.delete(obj)
    await db.commit()
