from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional

router = APIRouter(prefix="/x", tags=["synthesize"])

ANGLE_PROMPTS = {
    "tutorial": (
        "你是一位自媒体创作者，擅长把推文讨论整理成实用教程。\n"
        "请根据下面提供的原帖内容和精选评论，撰写一篇面向中文读者的教程型文章。\n"
        "要求：步骤清晰、可操作、去掉无关讨论噪音，聚焦在「如何做到」上。\n"
        "输出格式：Markdown，包含标题、正文段落、必要的步骤列表。"
    ),
    "opinion": (
        "你是一位自媒体创作者，擅长把推文讨论提炼成有观点的分析文章。\n"
        "请根据下面提供的原帖内容和精选评论，撰写一篇观点型文章。\n"
        "要求：归纳各方观点、给出你的判断、有论据支撑、语气有态度但不偏激。\n"
        "输出格式：Markdown，包含标题、正文段落。"
    ),
    "resource": (
        "你是一位自媒体创作者，擅长把推文讨论整理成资源清单。\n"
        "请根据下面提供的原帖内容和精选评论，提取所有提到的工具、链接、方法、资源，\n"
        "整理成一篇干货清单型文章。\n"
        "要求：每条资源简短说明用途，去掉重复和无价值内容。\n"
        "输出格式：Markdown，包含标题、分类清单。"
    ),
}


class SynthesizeRequest(BaseModel):
    post: str                          # 原帖文字
    replies: list[str]                 # 评论列表（已由插件提取）
    angle: str = "tutorial"            # tutorial / opinion / resource
    writing_plan_id: Optional[int] = None
    source_url: str = ""


class SynthesizeResult(BaseModel):
    draft_id: int
    title: str
    content: str


@router.post("/synthesize", response_model=SynthesizeResult)
async def synthesize_thread(body: SynthesizeRequest):
    from llm import _call
    from database import SessionLocal
    from models import ArticleDraft

    angle = body.angle if body.angle in ANGLE_PROMPTS else "tutorial"
    system_prompt = ANGLE_PROMPTS[angle]

    replies_text = "\n".join(
        f"- {r.strip()}" for r in body.replies if r.strip()
    ) or "（无评论）"

    user_prompt = (
        f"【原帖内容】\n{body.post.strip()}\n\n"
        f"【精选评论】\n{replies_text}\n\n"
        f"请按要求撰写文章，第一行输出文章标题（不含 # 前缀），"
        f"空一行后输出正文 Markdown。"
    )

    try:
        raw = await _call(f"{system_prompt}\n\n{user_prompt}", max_tokens=2048)
    except Exception as e:
        raise HTTPException(500, f"LLM 调用失败: {e}")

    # 分离标题和正文
    lines = raw.strip().splitlines()
    title = lines[0].lstrip("# ").strip() if lines else "提炼草稿"
    content = "\n".join(lines[1:]).strip() if len(lines) > 1 else raw

    initial_sources = []
    if body.source_url:
        initial_sources = [{"url": body.source_url, "title": "原始 X 帖子", "note": ""}]

    async with SessionLocal() as db:
        draft = ArticleDraft(
            topic_id="synthesize",
            writing_plan_id=body.writing_plan_id,
            title=title,
            content=content,
            status="drafting",
            sources=initial_sources,
        )
        db.add(draft)
        await db.commit()
        await db.refresh(draft)

    return SynthesizeResult(draft_id=draft.id, title=title, content=content)
