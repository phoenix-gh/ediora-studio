"""Classify XPost content into categories using LLM."""
import asyncio

VALID_CATEGORIES = {"通告", "科普", "教程", "其他"}

DEFAULT_CLASSIFY_PROMPT = """你是一个推文分类助手。请将以下推文内容分类为以下类型之一：
- 通告：产品发布、活动通知、公告、品牌推广类推文
- 科普：知识分享、行业洞察、数据分析、观点输出类推文
- 教程：操作指南、技术教程、实操步骤、工具使用类推文
- 其他：不属于以上类型

只回复类别名称，不要包含任何其他文字。

推文内容：
{content}"""


async def classify_post(content: str, prompt_template: str = "") -> str:
    from llm import _call
    template = prompt_template.strip() or DEFAULT_CLASSIFY_PROMPT
    prompt = template.format(content=content[:600])
    try:
        result = (await _call(prompt)).strip()
        for cat in VALID_CATEGORIES:
            if cat in result:
                return cat
        return "其他"
    except Exception:
        return ""


async def classify_unclassified_posts(db, prompt_template: str = "", batch_size: int = 20) -> dict:
    from sqlalchemy import select
    from models import XPost

    rows = (await db.execute(
        select(XPost)
        .where(XPost.category == "")
        .where(XPost.content != "")
        .limit(batch_size)
    )).scalars().all()

    if not rows:
        return {"classified": 0, "total": 0}

    classified = 0
    for post in rows:
        cat = await classify_post(post.content, prompt_template)
        if cat:
            post.category = cat
            classified += 1
        await asyncio.sleep(0.3)

    await db.commit()
    return {"classified": classified, "total": len(rows)}
