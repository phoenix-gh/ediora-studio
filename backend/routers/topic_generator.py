from __future__ import annotations

import json
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from hermes_kanban_client import HermesKanbanClient
from models import XPost, PublishAccount, TopicGeneratorCache, PipelineTask

router = APIRouter(prefix="/topic-generator", tags=["topic-generator"])


class SourcePost(BaseModel):
    username: str
    content: str
    url: str


class TopicSuggestion(BaseModel):
    title: str
    angle: str
    type: str  # "long" | "short" | "story"
    source_posts: list[SourcePost]


DEFAULT_ANALYSIS_PROMPT = (
    "你是资深自媒体策划，擅长从社交媒体热点中提炼有价值的创作选题。\n\n"
    "请根据以上内容，严格按以下分布生成 10 条候选选题（每种类型数量必须达到）：\n\n"
    "【长文 long × 4】1500-3000 字，深度分析，有数据有观点\n\n"
    "【短文 short × 2】200-500 字，X 风格，一个核心观点，语气犀利\n\n"
    "【微故事 story × 2】只写 5-6 句话。讲一个发生在身边的真实瞬间——可以是朋友用了某个新工具的反应、同事对 AI 的困惑、自己踩坑的经历——有细节、有情绪，让人读完想转发\n\n"
    "【发现 share × 2】只写 3-5 句话 + 一句「为什么值得关注」。"
    "触发条件：帖子里出现 GitHub 项目、开源工具、产品发布、新 API、有趣网站时，必须生成 share 类选题。"
    "格式参考：「发现一个用 Cloudflare 做的自托管邮件系统……支持自定义域名……核心亮点是……值得关注的原因是……」\n\n"
    "注意：\n"
    "- 四种类型缺一不可，share 和 story 各必须有 2 条\n"
    "- source_posts 列出该选题参考的 1-3 条原帖摘要\n"
    "- 仅输出 JSON 数组，不要任何解释文字，格式：\n"
    '[{"title":"...","angle":"...","type":"long|short|story|share",'
    '"source_posts":[{"username":"@xxx","content":"...","url":"..."}]}]'
)


class GenerateRequest(BaseModel):
    account_id: Optional[str] = None
    sources: list[str] = ["x"]
    custom_prompt: Optional[str] = None  # 用户自定义分析提示词，覆盖默认值


class GenerateResponse(BaseModel):
    warning: Optional[str] = None
    topics: list[TopicSuggestion]


_WORD_RANGE: dict[str, str] = {
    "long":  "1500-3000 字",
    "short": "200-500 字",
    "story": "5-6 句话",
    "share": "3-5 句话",
}

_TYPE_LABEL: dict[str, str] = {
    "long":  "长文",
    "short": "短文",
    "story": "微故事",
    "share": "发现",
}


class EnqueueRequest(BaseModel):
    account_id: str
    topics: list[TopicSuggestion]


class EnqueueResponse(BaseModel):
    enqueued: int
    task_ids: list[str]
    pipeline_task_ids: list[int]


@router.post("/generate", response_model=GenerateResponse)
async def generate_topics(body: GenerateRequest, db: AsyncSession = Depends(get_db)):
    from llm import _call

    since = datetime.now(timezone.utc) - timedelta(hours=24)

    posts = (await db.execute(
        select(XPost)
        .where(XPost.published_at >= since)
        .order_by(desc(XPost.likes + XPost.reposts))
        .limit(50)
    )).scalars().all()

    warning = None
    if len(posts) < 5:
        warning = "过去 24 小时内 X 数据不足（< 5 条），建议在「设置 → X」补充订阅源。已尽力生成。"

    account_profile = ""
    if body.account_id:
        acc = await db.get(PublishAccount, body.account_id)
        if acc:
            account_profile = (
                f"\n\n【目标账号画像】\n"
                f"名称：{acc.name}\n"
                f"定位：{acc.positioning}\n"
                f"受众：{acc.audience}\n"
                f"调性：{acc.tone}\n"
                f"选题重点：{', '.join(acc.topic_focus) if acc.topic_focus else '不限'}\n"
                f"禁区：{', '.join(acc.taboo) if acc.taboo else '无'}"
            )

    posts_text = "\n".join(
        f"{idx+1}. @{p.username}（赞{p.likes} 转{p.reposts}）: {p.content[:200]}"
        for idx, p in enumerate(posts)
    ) or "（暂无数据）"

    analysis_instruction = (body.custom_prompt.strip() if body.custom_prompt and body.custom_prompt.strip()
                            else DEFAULT_ANALYSIS_PROMPT)

    prompt = (
        f"【过去 24 小时 X 热门帖子】\n{posts_text}"
        f"{account_profile}\n\n"
        f"{analysis_instruction}"
    )

    try:
        raw = await _call(prompt, max_tokens=6000)
    except Exception as e:
        raise HTTPException(500, f"LLM 调用失败: {e}")

    raw = raw.strip()
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[-1].rsplit("```", 1)[0].strip()

    # Try strict parse first; fall back to extracting complete objects if truncated
    try:
        data = json.loads(raw)
        if not isinstance(data, list):
            raise ValueError("not a list")
    except json.JSONDecodeError:
        data = _extract_complete_objects(raw)
        if not data:
            raise HTTPException(500, f"LLM 输出解析失败\n原始输出: {raw[:500]}")

    try:
        topics = [TopicSuggestion(**item) for item in data[:10]]
    except Exception as e:
        raise HTTPException(500, f"选题结构解析失败: {e}")

    # Upsert cache: one row per account_id (NULL for no account)
    cache_key = body.account_id or None
    existing = (await db.execute(
        select(TopicGeneratorCache).where(TopicGeneratorCache.account_id == cache_key)
    )).scalar_one_or_none()
    topics_json = [t.model_dump() for t in topics]
    if existing:
        existing.topics = topics_json
        existing.generated_at = datetime.now(timezone.utc)
    else:
        db.add(TopicGeneratorCache(account_id=cache_key, topics=topics_json))
    await db.commit()

    return GenerateResponse(warning=warning, topics=topics)


class CachedResponse(BaseModel):
    generated_at: Optional[datetime] = None
    topics: list[TopicSuggestion] = []


@router.get("/cached", response_model=CachedResponse)
async def get_cached_topics(account_id: Optional[str] = None, db: AsyncSession = Depends(get_db)):
    cache_key = account_id or None
    row = (await db.execute(
        select(TopicGeneratorCache).where(TopicGeneratorCache.account_id == cache_key)
    )).scalar_one_or_none()
    if not row:
        return CachedResponse()
    return CachedResponse(generated_at=row.generated_at, topics=[TopicSuggestion(**t) for t in row.topics])


def _extract_complete_objects(raw: str) -> list:
    """Extract complete JSON objects from a potentially truncated array."""
    results = []
    depth = 0
    start = None
    for i, ch in enumerate(raw):
        if ch == '{':
            if depth == 0:
                start = i
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0 and start is not None:
                try:
                    results.append(json.loads(raw[start:i+1]))
                except json.JSONDecodeError:
                    pass
                start = None
    return results


@router.post("/enqueue", response_model=EnqueueResponse)
async def enqueue_topics(body: EnqueueRequest, db: AsyncSession = Depends(get_db)):
    from pipeline_template import get_pipeline

    if not body.account_id or not body.account_id.strip():
        raise HTTPException(400, "account_id 必填")

    acc = await db.get(PublishAccount, body.account_id)
    if acc is None:
        raise HTTPException(400, f"account '{body.account_id}' not found")

    account_profile = {
        "name": acc.name,
        "platform": acc.platform,
        "positioning": acc.positioning,
        "audience": acc.audience,
        "tone": acc.tone,
        "topic_focus": acc.topic_focus or [],
        "taboo": acc.taboo or [],
        "word_range": acc.word_range or {},
        "image_style": acc.image_style,
        "cover_style": acc.cover_style or {},
        "voice_samples": acc.voice_samples or [],
        "style_rules": acc.style_rules or [],
    }

    kanban = HermesKanbanClient()
    task_ids: list[str] = []
    pipeline_task_ids: list[int] = []

    for topic in body.topics:
        pt = PipelineTask(
            account_id=body.account_id,
            title=topic.title,
            source_url="",
            task_ids={},
        )
        db.add(pt)
        await db.commit()
        await db.refresh(pt)

        ctx = {
            "title": topic.title,
            "account_id": body.account_id,
            "account_profile": account_profile,
            "content_type": topic.type,
            "content_type_label": _TYPE_LABEL.get(topic.type, topic.type),
            "word_range": _WORD_RANGE.get(topic.type, ""),
            "angle": topic.angle,
            "source_posts_md": "\n".join(
                f"- {p.username}: {p.content[:120]} [{p.url}]"
                for p in topic.source_posts
            ) or "（无参考帖子）",
            "pipeline_task_id": pt.id,
            "draft_id": 0,
        }

        flow = "topic_long" if topic.type == "long" else "topic_short"
        steps = get_pipeline(flow)

        step_task_ids: list[str] = []
        for step in steps:
            try:
                tid = await kanban.create_task(
                    title=step.title(ctx),
                    body=step.body(ctx),
                    assignee=step.assignee,
                    parents=[step_task_ids[-1]] if step_task_ids else None,
                )
            except Exception as e:
                raise HTTPException(500, f"入队失败: {e}")
            step_task_ids.append(tid)

        task_ids_map = {steps[i].role: step_task_ids[i] for i in range(len(steps))}
        pt.task_ids = task_ids_map
        await db.commit()

        task_ids.append(step_task_ids[0])
        pipeline_task_ids.append(pt.id)

    return EnqueueResponse(
        enqueued=len(task_ids),
        task_ids=task_ids,
        pipeline_task_ids=pipeline_task_ids,
    )
