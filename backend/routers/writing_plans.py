from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, delete, update as sa_update

from database import get_db
from models import WritingPlan, PlanSource, PlanTag, WritingPlanTag, ArticleDraft, PlanUpdate, PublishAccount, PipelineTask
from schemas import (
    WritingPlanCreate, WritingPlanUpdate, WritingPlanOut,
    PlanTagCreate, PlanTagOut,
    PlanSourceCreate, PlanSourceOut,
    ArticleDraftSummary, DispatchPlanRequest, DispatchResponse,
    PlanUpdateOut, AnalyzeRequest, AnalyzeResponse,
)

router = APIRouter(prefix="/writing-plans", tags=["writing-plans"])

_TAG_COLORS = [
    "#6366f1", "#8b5cf6", "#ec4899", "#f59e0b",
    "#10b981", "#3b82f6", "#ef4444", "#14b8a6",
]


def _color_for_name(name: str) -> str:
    return _TAG_COLORS[sum(ord(c) for c in name) % len(_TAG_COLORS)]


async def _get_or_create_tag(db: AsyncSession, name: str) -> PlanTag:
    normalized = name.strip().lower()
    existing = (await db.execute(
        select(PlanTag).where(func.lower(PlanTag.name) == normalized)
    )).scalar_one_or_none()
    if existing:
        return existing
    tag = PlanTag(name=name.strip(), color=_color_for_name(name))
    db.add(tag)
    await db.flush()
    return tag


async def _set_plan_tags(db: AsyncSession, plan_id: int, tag_names: list[str]) -> None:
    await db.execute(
        delete(WritingPlanTag).where(WritingPlanTag.plan_id == plan_id)
    )
    for name in tag_names:
        if name.strip():
            tag = await _get_or_create_tag(db, name)
            db.add(WritingPlanTag(plan_id=plan_id, tag_id=tag.id))


async def _enrich_plans(db: AsyncSession, plans: list[WritingPlan]) -> list[WritingPlanOut]:
    if not plans:
        return []

    ids = [p.id for p in plans]

    tag_rows = (await db.execute(
        select(WritingPlanTag.plan_id, PlanTag)
        .join(PlanTag, WritingPlanTag.tag_id == PlanTag.id)
        .where(WritingPlanTag.plan_id.in_(ids))
        .order_by(PlanTag.name)
    )).all()
    tags_by_plan: dict[int, list] = {i: [] for i in ids}
    for plan_id, tag in tag_rows:
        tags_by_plan[plan_id].append(tag)

    source_rows = (await db.execute(
        select(PlanSource)
        .where(PlanSource.plan_id.in_(ids))
        .order_by(PlanSource.created_at.desc())
    )).scalars().all()
    sources_by_plan: dict[int, list] = {i: [] for i in ids}
    for s in source_rows:
        sources_by_plan[s.plan_id].append(s)

    draft_counts = (await db.execute(
        select(ArticleDraft.writing_plan_id, func.count())
        .where(ArticleDraft.writing_plan_id.in_(ids))
        .group_by(ArticleDraft.writing_plan_id)
    )).all()
    dc_map = {row[0]: row[1] for row in draft_counts}

    result = []
    for p in plans:
        out = WritingPlanOut.model_validate(p)
        out.tags = [PlanTagOut.model_validate(tag) for tag in tags_by_plan[p.id]]
        out.sources = [PlanSourceOut.model_validate(s) for s in sources_by_plan[p.id]]
        out.source_count = len(sources_by_plan[p.id])
        out.draft_count = dc_map.get(p.id, 0)
        result.append(out)
    return result


# ── Tag endpoints (registered before /{plan_id} to avoid routing conflict) ────

@router.get("/tags", response_model=list[PlanTagOut])
async def list_tags(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(
        select(PlanTag).order_by(PlanTag.name)
    )).scalars().all()
    return rows


@router.post("/tags", response_model=PlanTagOut, status_code=201)
async def create_tag(body: PlanTagCreate, db: AsyncSession = Depends(get_db)):
    tag = await _get_or_create_tag(db, body.name)
    await db.commit()
    await db.refresh(tag)
    return tag


@router.delete("/tags/{tag_id}", status_code=204)
async def delete_tag(tag_id: int, db: AsyncSession = Depends(get_db)):
    tag = await db.get(PlanTag, tag_id)
    if not tag:
        raise HTTPException(404, "Tag not found")
    await db.execute(delete(WritingPlanTag).where(WritingPlanTag.tag_id == tag_id))
    await db.delete(tag)
    await db.commit()


# ── Search (registered before /{plan_id} to avoid routing conflict) ───────────

@router.get("/search", response_model=list[WritingPlanOut])
async def search_plans(q: str = "", db: AsyncSession = Depends(get_db)):
    if not q.strip():
        return []
    keywords = [k.strip() for k in q.replace(",", " ").split() if k.strip()]
    rows = (await db.execute(
        select(WritingPlan).where(WritingPlan.status == "active")
    )).scalars().all()
    matched = [p for p in rows if any(kw.lower() in (p.title + " " + p.brief).lower() for kw in keywords)]
    return await _enrich_plans(db, matched[:10])


# ── Analyze (dispatches to scout, registered before /{plan_id}) ───────────────

@router.post("/analyze", response_model=AnalyzeResponse)
async def analyze_article(body: AnalyzeRequest):
    if not body.url and not body.content:
        raise HTTPException(400, "url 或 content 至少提供一个")
    parts = ["## 任务类型\ncontent-to-writing-plan\n\n## 输入"]
    if body.url:
        parts.append(f"URL: {body.url}")
    if body.content:
        parts.append(f"内容:\n{body.content[:3000]}")
    parts.append(
        "\n## 指令\n"
        "1. 读取文章，提取 3-5 个主题关键词\n"
        "2. 调 search_writing_plans 检索候选写作方案（传入关键词列表）\n"
        "3. 判断相似度：\n"
        "   - 相似且有新角度 → update_writing_plan + add_plan_update（记录新增了什么）\n"
        "   - 相似但无新内容 → add_plan_update（记录跳过原因，plan_id 取相似方案 id）\n"
        "   - 无匹配 → create_writing_plan + add_plan_update（记录新建原因）\n"
        "4. 提炼写作方案要素：\n"
        "   - 文章模式（这类文章的写法、视角、字数）\n"
        "   - 标题公式（标题结构 + 举例）\n"
        "   - 找素材的方法（关键词、来源、判断标准）\n"
        "   - 禁区\n"
        "\n## 方案命名规范（必须遵守）\n"
        "方案名称描述「可重复使用的写法类型」，不是某篇具体文章的标题。\n"
        "✅ 正确示例：「非程序员AI工具创业故事」「普通人副业收入数字拆解」「工具对比实测横评」\n"
        "❌ 错误示例：「AI压缩产品周期：非程序员用ChatGPT做付费APP案例拆解」（这是文章标题）\n"
        "检验方法：去掉所有具体姓名/数字/工具名，剩下的还能作为一类内容的分类标签 → 合格。"
    )
    from hermes_kanban_client import HermesKanbanClient, HermesKanbanError
    try:
        kanban = HermesKanbanClient()
        task_id = await kanban.create_task(
            title="[写作方案] 文章提炼",
            body="\n".join(parts),
            assignee="wms_scout",
        )
    except HermesKanbanError as e:
        raise HTTPException(502, f"Hermes 不可用: {e}")
    return AnalyzeResponse(task_id=task_id, kanban_url="/studio")


# ── Writing plan endpoints ─────────────────────────────────────────────────────

@router.get("", response_model=list[WritingPlanOut])
async def list_plans(tags: str | None = None, db: AsyncSession = Depends(get_db)):
    q = select(WritingPlan).order_by(WritingPlan.priority, WritingPlan.created_at.desc())

    if tags:
        tag_names = [t.strip().lower() for t in tags.split(",") if t.strip()]
        if tag_names:
            # OR filter: return plans that have ANY of the given tags
            q = q.where(
                WritingPlan.id.in_(
                    select(WritingPlanTag.plan_id)
                    .join(PlanTag, WritingPlanTag.tag_id == PlanTag.id)
                    .where(func.lower(PlanTag.name).in_(tag_names))
                )
            )

    rows = (await db.execute(q)).scalars().all()
    return await _enrich_plans(db, list(rows))


@router.post("", response_model=WritingPlanOut, status_code=201)
async def create_plan(body: WritingPlanCreate, db: AsyncSession = Depends(get_db)):
    obj = WritingPlan(
        title=body.title,
        brief=body.brief,
        priority=body.priority,
    )
    db.add(obj)
    await db.flush()
    await _set_plan_tags(db, obj.id, body.tags)
    await db.commit()
    await db.refresh(obj)
    return (await _enrich_plans(db, [obj]))[0]


@router.get("/{plan_id}", response_model=WritingPlanOut)
async def get_plan(plan_id: int, db: AsyncSession = Depends(get_db)):
    obj = await db.get(WritingPlan, plan_id)
    if not obj:
        raise HTTPException(404, "Plan not found")
    return (await _enrich_plans(db, [obj]))[0]


@router.patch("/{plan_id}", response_model=WritingPlanOut)
async def update_plan(plan_id: int, body: WritingPlanUpdate, db: AsyncSession = Depends(get_db)):
    obj = await db.get(WritingPlan, plan_id)
    if not obj:
        raise HTTPException(404, "Plan not found")
    for field, val in body.model_dump(exclude_none=True, exclude={"tags"}).items():
        setattr(obj, field, val)
    if body.tags is not None:
        await _set_plan_tags(db, obj.id, body.tags)
    await db.commit()
    await db.refresh(obj)
    return (await _enrich_plans(db, [obj]))[0]


@router.delete("/{plan_id}", status_code=204)
async def delete_plan(plan_id: int, db: AsyncSession = Depends(get_db)):
    obj = await db.get(WritingPlan, plan_id)
    if not obj:
        raise HTTPException(404, "Plan not found")
    # Detach drafts instead of deleting them
    await db.execute(
        sa_update(ArticleDraft)
        .where(ArticleDraft.writing_plan_id == plan_id)
        .values(writing_plan_id=None)
    )
    await db.execute(delete(WritingPlanTag).where(WritingPlanTag.plan_id == plan_id))
    await db.execute(delete(PlanSource).where(PlanSource.plan_id == plan_id))
    await db.delete(obj)
    await db.commit()


# ── Drafts list ───────────────────────────────────────────────────────────────

@router.get("/{plan_id}/drafts", response_model=list[ArticleDraftSummary])
async def list_plan_drafts(plan_id: int, db: AsyncSession = Depends(get_db)):
    obj = await db.get(WritingPlan, plan_id)
    if not obj:
        raise HTTPException(404, "Plan not found")
    rows = (await db.execute(
        select(ArticleDraft)
        .where(ArticleDraft.writing_plan_id == plan_id)
        .order_by(ArticleDraft.created_at.desc())
    )).scalars().all()
    return rows


# ── Dispatch ──────────────────────────────────────────────────────────────────

@router.post("/{plan_id}/dispatch", response_model=DispatchResponse)
async def dispatch_plan(plan_id: int, body: DispatchPlanRequest, db: AsyncSession = Depends(get_db)):
    obj = await db.get(WritingPlan, plan_id)
    if not obj:
        raise HTTPException(404, "Plan not found")
    if not obj.brief.strip():
        raise HTTPException(400, "Brief is empty — add a research brief before dispatching")

    account: PublishAccount | None = None
    if body.account_id:
        account = await db.get(PublishAccount, body.account_id)

    account_id_str = account.id if account else "unknown"
    platform_str = account.platform if account else "unknown"
    profile: dict = {}
    if account:
        profile = {
            "name": account.name, "platform": account.platform,
            "positioning": account.positioning, "audience": account.audience,
            "tone": account.tone, "word_range": account.word_range,
            "image_style": account.image_style, "cover_style": account.cover_style or {},
            "topic_focus": account.topic_focus, "taboo": account.taboo,
            "voice_samples": account.voice_samples or [], "style_rules": account.style_rules or [],
        }

    # Create PipelineTask record so the writer can save the draft with a pipeline reference.
    # writing_plan_id lets save_draft link the produced draft back to this plan.
    pt = PipelineTask(account_id=account_id_str, title=obj.title, source_url="",
                      writing_plan_id=plan_id, task_ids={})
    db.add(pt)
    await db.commit()
    await db.refresh(pt)

    from pipeline_template import render_profile_editor, parse_word_spec, FULL_PIPELINE
    from hermes_kanban_client import HermesKanbanClient, HermesKanbanError

    # 写作方案的「写作模式」可能规定字数（如 100-200 字短文案）。解析出来，
    # 既喂给 writer（覆盖账号 word_range），也让 editor 的 brief 对齐。
    word_spec = parse_word_spec(obj.brief)
    word_rule_line = (
        f"严格按写作模式字数 **{word_spec['raw']}**（忽略上方账号画像的 word_range）"
        if word_spec else
        "严格按写作模式里的文章格式 / 字数"
    )

    # Editor body: plan brief is the raw material
    editor_body_parts = [
        f"account_id: {account_id_str}",
        f"platform: {platform_str}",
        "",
        f"# {obj.title}",
        "",
    ]
    if profile:
        editor_body_parts.append(render_profile_editor(profile))
        editor_body_parts.append("")
    editor_body_parts.extend([
        "## 写作模式（来自写作方案）",
        obj.brief,
        "",
        "---",
        "",
        "## 这棒任务（editor）",
        "",
        "上方是这个写作方案的**写作模式**——一种固定的文章公式，包含文章结构、标题公式和找素材的方法。",
        "你的工作是：**按模式找今天的素材，把素材填进模式，出 brief 交 writer。**",
        "",
        "**Step 1 — 找今天的素材**",
        "按模式里的搜索方法和关键词，搜索最近发生的真实内容。",
        "目标：找到一个**符合模式判断标准**的具体案例（有人名/数字/时间/来源链接）。",
        f"每找到一条有价值的参考文章/帖子，立即调 `add_plan_source(plan_id={plan_id}, url=..., title=..., note=\"一句话说明为什么有价值\", platform=...)`，把它存入写作方案的线索库。",
        "",
        "**Step 2 — 用模式的标题公式造标题**",
        "把找到的素材填进标题公式，造出 ≥3 个候选标题。",
        "每个标题去掉具体细节后必须变成空话——否则说明细节不够具体，重找。",
        "",
        "**Step 3 — 出创作 brief**",
        "- **core_point**：把素材填进模式后的主线，一句话（含具体人/数/事）",
        "- **必须出现的事实** 3-5 条：每条带原始链接 + 一个具体细节",
        "- **候选锚点** ≥2 个：来自找到的素材，第一人称可代入",
        "- **候选标题** ≥3：用模式里的标题公式填入今天的素材",
        f"- **字数/结构**：{word_rule_line}",
        "",
        "完成时：",
        f'- `kanban_complete(summary=\'brief 完成: <一句话角度>\', metadata={{"plan_id": {plan_id}, "brief_md": "<完整 brief markdown>", "brief_chars": N, "core_point": "<一句话>"}})`',
    ])

    ctx = {
        "title": obj.title,
        "account_id": account_id_str,
        "account_profile": profile,
        "platform": platform_str,
        "pipeline_task_id": pt.id,
        "word_spec": word_spec,
    }

    try:
        kanban = HermesKanbanClient()

        editor_id = await kanban.create_task(
            title=f"[创作] {obj.title}",
            body="\n".join(editor_body_parts),
            assignee="wms_editor",
        )
        writer_step = FULL_PIPELINE[1]
        writer_id = await kanban.create_task(
            title=writer_step.title(ctx),
            body=writer_step.body(ctx),
            assignee=writer_step.assignee,
            parents=[editor_id],
        )
        illus_step = FULL_PIPELINE[2]
        illus_id = await kanban.create_task(
            title=illus_step.title(ctx),
            body=illus_step.body(ctx),
            assignee=illus_step.assignee,
            parents=[writer_id],
        )
    except HermesKanbanError as e:
        raise HTTPException(502, f"Hermes 不可用: {e}")

    pt.task_ids = {"editor": editor_id, "writer": writer_id, "illustrator": illus_id}
    await db.commit()

    return DispatchResponse(task_id=editor_id, kanban_url="/studio")


# ── Plan updates (changelog written by scout) ─────────────────────────────────

@router.get("/{plan_id}/updates", response_model=list[PlanUpdateOut])
async def list_plan_updates(plan_id: int, db: AsyncSession = Depends(get_db)):
    obj = await db.get(WritingPlan, plan_id)
    if not obj:
        raise HTTPException(404, "Plan not found")
    rows = (await db.execute(
        select(PlanUpdate)
        .where(PlanUpdate.plan_id == plan_id)
        .order_by(PlanUpdate.created_at.desc())
    )).scalars().all()
    return rows


# ── Sources (unchanged) ───────────────────────────────────────────────────────

@router.get("/{plan_id}/sources", response_model=list[PlanSourceOut])
async def list_sources(plan_id: int, db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(
        select(PlanSource).where(PlanSource.plan_id == plan_id)
        .order_by(PlanSource.created_at.desc())
    )).scalars().all()
    return rows


@router.post("/{plan_id}/sources", response_model=PlanSourceOut, status_code=201)
async def add_source(plan_id: int, body: PlanSourceCreate, db: AsyncSession = Depends(get_db)):
    obj = await db.get(WritingPlan, plan_id)
    if not obj:
        raise HTTPException(404, "Plan not found")
    source = PlanSource(**{**body.model_dump(), "plan_id": plan_id})
    db.add(source)

    if body.draft_id is not None:
        draft = await db.get(ArticleDraft, body.draft_id)
        if not draft:
            raise HTTPException(404, "Draft not found")
        existing = list(draft.sources or [])
        existing.append({"url": body.url, "title": body.title, "note": body.note})
        draft.sources = existing

    await db.commit()
    await db.refresh(source)
    return source


@router.delete("/{plan_id}/sources/{source_id}", status_code=204)
async def delete_source(plan_id: int, source_id: int, db: AsyncSession = Depends(get_db)):
    obj = await db.get(PlanSource, source_id)
    if not obj or obj.plan_id != plan_id:
        raise HTTPException(404, "Source not found")
    await db.delete(obj)
    await db.commit()


@router.post("/sources/quick-save", response_model=PlanSourceOut, status_code=201)
async def quick_save_source(body: PlanSourceCreate, db: AsyncSession = Depends(get_db)):
    obj = await db.get(WritingPlan, body.plan_id)
    if not obj:
        raise HTTPException(404, "Plan not found")
    source = PlanSource(**body.model_dump())
    db.add(source)
    await db.commit()
    await db.refresh(source)
    return source
