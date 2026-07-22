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
    ReanalyzeRequest, AnalyzePromptUpdate,
)
from config import get_config, set_config

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
    matched = [p for p in rows if any(kw.lower() in (p.title + " " + p.strategy).lower() for kw in keywords)]
    return await _enrich_plans(db, matched[:10])


# ── Analyze / Prompt CRUD (registered before /{plan_id}) ─────────────────────

@router.get("/analyze-prompt")
async def get_analyze_prompt():
    cfg = await get_config()
    return {"instructions": cfg.get("analyze_instructions", "")}


@router.put("/analyze-prompt", status_code=204)
async def update_analyze_prompt(body: AnalyzePromptUpdate):
    await set_config({"analyze_instructions": body.instructions})


@router.post("/analyze", response_model=AnalyzeResponse)
async def analyze_article(body: AnalyzeRequest):
    if not body.url and not body.content:
        raise HTTPException(400, "url 或 content 至少提供一个")
    cfg = await get_config()
    instructions = cfg.get("analyze_instructions", "")
    parts = ["## 任务类型\ncontent-to-writing-plan\n\n## 输入"]
    if body.url:
        parts.append(f"URL: {body.url}")
    if body.content:
        parts.append(f"内容:\n{body.content[:3000]}")
    parts.append(instructions)
    from job_dispatch import JobDispatcher, JobDispatchError
    try:
        task_id = await JobDispatcher().create(title="[写作方案] 文章提炼", input_data={"prompt": "\n".join(parts)})
    except JobDispatchError as e:
        raise HTTPException(502, f"任务队列不可用: {e}")
    return AnalyzeResponse(task_id=task_id, kanban_url="/jobs")


@router.post("/{plan_id}/reanalyze", response_model=AnalyzeResponse)
async def reanalyze_plan(plan_id: int, body: ReanalyzeRequest, db: AsyncSession = Depends(get_db)):
    obj = await db.get(WritingPlan, plan_id)
    if not obj:
        raise HTTPException(404, "Plan not found")
    cfg = await get_config()
    instructions = cfg.get("analyze_instructions", "")
    suggestions_block = f"\n## 用户建议\n{body.suggestions.strip()}" if body.suggestions.strip() else ""
    task_body = (
        f"## 任务类型\nreanalyze-writing-plan\n\n"
        f"## 目标方案\nID: {obj.id}\n标题: {obj.title}\n\n"
        f"## 当前策略（需要修订）\n{obj.strategy or '（空）'}"
        f"{suggestions_block}\n\n"
        f"## 指令\n"
        f"直接更新方案 ID {obj.id}（调 update_writing_plan，plan_id={obj.id}），"
        f"并调 add_plan_update 记录改了什么。不需要搜索其他方案，也不需要新建方案。\n"
        f"{instructions}"
    )
    from job_dispatch import JobDispatcher, JobDispatchError
    try:
        task_id = await JobDispatcher().create(title=f"[写作方案] 重新提炼：{obj.title}", input_data={"prompt": task_body})
    except JobDispatchError as e:
        raise HTTPException(502, f"任务队列不可用: {e}")
    return AnalyzeResponse(task_id=task_id, kanban_url="/jobs")


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
        strategy=body.strategy,
        priority=body.priority,
        cover_style=body.cover_style,
        image_style=body.image_style,
        genre=body.genre,
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
    if not obj.strategy.strip():
        raise HTTPException(400, "Strategy is empty — add a writing strategy before dispatching")

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

    from pipeline_template import (
        render_profile_editor, parse_word_spec, FULL_PIPELINE, resolve_effective_design,
        plan_editor_task_block,
    )
    from hermes_kanban_client import HermesKanbanClient, HermesKanbanError

    # 设计字段三层合并：账号默认 < 写作方案覆盖 < 本次 dispatch 临时覆盖。
    eff_cover, eff_image = resolve_effective_design(
        account.cover_style if account else {}, account.image_style if account else "",
        obj.cover_style, obj.image_style,
        body.cover_style, body.image_style,
    )
    if profile:
        profile["cover_style"] = eff_cover
        profile["image_style"] = eff_image

    # 写作方案的「写作模式」可能规定字数（如 100-200 字短文案）。解析出来，
    # 既喂给 writer（覆盖账号 word_range），也让 editor 的 brief 对齐。
    word_spec = parse_word_spec(obj.strategy)
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
    if body.angle:
        editor_body_parts.extend([
            "## 本次角度（用户指定，直接用，不要重新推导）",
            body.angle,
            "",
        ])
    editor_body_parts.extend([
        "## 写作模式（来自写作方案）",
        obj.strategy,
        "",
        "---",
        "",
        plan_editor_task_block(obj.genre, plan_id, word_rule_line),
    ])

    ctx = {
        "title": obj.title,
        "account_id": account_id_str,
        "account_profile": profile,
        "platform": platform_str,
        "pipeline_task_id": pt.id,
        "word_spec": word_spec,
        "draft_type": body.draft_type,
        "genre": obj.genre,
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
    pt.goal = {"angle": body.angle or "", "draft_type": body.draft_type, "genre": obj.genre}
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
