from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from database import get_db
from models import WriterPersona
from schemas import WriterPersonaCreate, WriterPersonaUpdate, WriterPersonaOut

router = APIRouter(prefix="/personas", tags=["personas"])

_DEFAULT_PERSONAS = [
    {
        "name": "公众号深度",
        "description": "适合公众号的深度分析长文",
        "prompt": (
            "你是一位专业的中文科技公众号作者，擅长深度分析和独到见解。\n"
            "根据选题信息，撰写一篇1500-2000字的原创文章。\n\n"
            "要求：\n"
            "1. 深度分析，不简单复述事实\n"
            "2. 结构清晰：引人入胜的开篇 → 背景 → 深度分析 → 趋势预判\n"
            "3. 专业但易读，加入独到观点\n"
            "4. 使用 ## 小标题分段\n"
            "5. 开篇直接切入核心，不废话"
        ),
        "is_default": True,
    },
    {
        "name": "X / Twitter",
        "description": "简洁有力的推文串风格",
        "prompt": (
            "你是一位科技领域的 X（Twitter）博主，擅长将复杂概念用简洁有力的语言表达。\n"
            "根据选题信息，撰写一组 5-8 条推文的推文串（thread）。\n\n"
            "要求：\n"
            "1. 第一条推文要有强烈的钩子，引人点开\n"
            "2. 每条推文不超过 280 字（中文约 140 字）\n"
            "3. 用数字或 emoji 开头区分每条\n"
            "4. 最后一条做总结或 CTA\n"
            "5. 语气直接、有观点、敢于下判断"
        ),
        "is_default": False,
    },
    {
        "name": "小红书",
        "description": "种草风格，emoji 丰富，口语化",
        "prompt": (
            "你是一位科技数码小红书博主，风格活泼、口语化，擅长用种草的方式分享科技内容。\n"
            "根据选题信息，撰写一篇小红书笔记。\n\n"
            "要求：\n"
            "1. 标题要有爆款感，可以加括号和数字，例如「我研究了X个月，发现...」\n"
            "2. 开头几行要抓住眼球（小红书只显示前3行）\n"
            "3. 多用 emoji 分隔段落，每段不超过3行\n"
            "4. 口语化，像在跟朋友聊天\n"
            "5. 结尾引导互动：「你觉得呢？」「评论告诉我～」\n"
            "6. 在末尾加5-8个相关话题标签，格式：#标签"
        ),
        "is_default": False,
    },
]


async def _seed_defaults(db: AsyncSession):
    count = (await db.execute(select(WriterPersona))).scalars().first()
    if count is not None:
        return
    for p in _DEFAULT_PERSONAS:
        db.add(WriterPersona(**p))
    await db.commit()


@router.get("", response_model=list[WriterPersonaOut])
async def list_personas(db: AsyncSession = Depends(get_db)):
    await _seed_defaults(db)
    defaults = (await db.execute(
        select(WriterPersona).where(WriterPersona.is_default == True).order_by(WriterPersona.id)
    )).scalars().all()
    if len(defaults) > 1:
        for row in defaults[1:]:
            row.is_default = False
        await db.commit()
    rows = (await db.execute(
        select(WriterPersona).order_by(WriterPersona.is_default.desc(), WriterPersona.id)
    )).scalars().all()
    return rows


@router.post("", response_model=WriterPersonaOut, status_code=201)
async def create_persona(body: WriterPersonaCreate, db: AsyncSession = Depends(get_db)):
    if body.is_default:
        rows = (await db.execute(select(WriterPersona))).scalars().all()
        for row in rows:
            row.is_default = False
    persona = WriterPersona(**body.model_dump())
    db.add(persona)
    await db.commit()
    await db.refresh(persona)
    return persona


@router.patch("/{persona_id}", response_model=WriterPersonaOut)
async def update_persona(persona_id: int, body: WriterPersonaUpdate, db: AsyncSession = Depends(get_db)):
    persona = await db.get(WriterPersona, persona_id)
    if not persona:
        raise HTTPException(404, "not found")
    data = body.model_dump(exclude_none=True)
    if data.get("is_default") is True:
        rows = (await db.execute(select(WriterPersona))).scalars().all()
        for row in rows:
            if row.id != persona_id:
                row.is_default = False
    for k, v in data.items():
        setattr(persona, k, v)
    await db.commit()
    await db.refresh(persona)
    return persona


@router.delete("/{persona_id}", status_code=204)
async def delete_persona(persona_id: int, db: AsyncSession = Depends(get_db)):
    persona = await db.get(WriterPersona, persona_id)
    if not persona:
        raise HTTPException(404, "not found")
    await db.delete(persona)
    await db.commit()
