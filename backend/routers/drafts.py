from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc
from pydantic import BaseModel
from typing import Optional

from database import get_db
from models import ArticleDraft, ArticleSeries
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
            "注意：X 帖子限 280 字符，语言简洁有力，善用换行增强节奏，可以写成线程（thread）形式。"
            "避免冗余，每句话都要有信息量，结尾可带一个开放性问题或观点引发互动。",
        ),
        "mp": (
            "微信公众号文章",
            "注意：公众号文章读者在手机阅读，段落要短，多用小标题和列表，语言亲切但有深度。"
            "开头要有钩子，结尾引导关注/转发。",
        ),
        "bili": (
            "哔哩哔哩视频稿",
            "注意：这是 B 站视频脚本，语言口语化、有活力，可以加一些弹幕感的表达。"
            "开头要有强钩子留住观众，结尾引导三连（点赞投币收藏）。节奏明快，避免冗长铺垫。",
        ),
        "xhs": (
            "小红书笔记",
            "注意：小红书笔记要「种草感」强，语言活泼口语化，多用 emoji，段落极短（1-3 句），"
            "用换行制造视觉层次。标题要有爆款感（数字/疑问/痛点），正文多用「！」增强感染力，"
            "结尾加 3-5 个话题标签（#xxx）。",
        ),
    }
    type_desc, type_hint = type_hints.get(draft_type, type_hints["article"])

    instructions = (
        f"你是一位专业的中文内容创作助手，帮助用户修改和优化{type_desc}。\n"
        f"{type_hint}\n\n"
        f"当前正在编辑的内容：\n\n"
        f"【标题】{obj.title or '（无标题）'}\n\n"
        f"【正文】\n{obj.content or '（空）'}\n\n"
        "你可以回答问题、给出修改建议、润色语言、调整结构，也可以直接重写段落或整篇内容。\n"
        "如果用户要求对内容做修改，在回复末尾追加以下格式（只输出正文 Markdown，不含标题行）：\n"
        "===UPDATED===\n(修改后完整正文)\n===END==="
    )

    session_name = body.session_name or f"draft-edit-{draft_id}"

    try:
        from llm import _named_session_chat
        raw = await _named_session_chat(
            message=body.message,
            conversation=session_name,
            instructions=instructions,
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


@router.delete("/drafts/{draft_id}", status_code=204)
async def delete_draft(draft_id: int, db: AsyncSession = Depends(get_db)):
    obj = await db.get(ArticleDraft, draft_id)
    if not obj:
        raise HTTPException(404, "Draft not found")
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
