from fastapi import APIRouter, HTTPException, Query, BackgroundTasks
from sqlalchemy import select, desc
from typing import Optional

from database import SessionLocal, get_db
from models import GithubRepo, GithubTrendingRepo, GithubRelease
from schemas import (
    GithubRepoCreate, GithubRepoUpdate, GithubRepoOut,
    GithubTrendingRepoOut, GithubReleaseOut,
    DispatchReleaseWriteRequest, DispatchRepoIntroRequest, DispatchResponse,
)
from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/github", tags=["github"])


# ── Repos ─────────────────────────────────────────────────────────────────────

@router.get("/repos", response_model=list[GithubRepoOut])
async def list_repos(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(GithubRepo).order_by(GithubRepo.created_at))).scalars().all()
    return rows


@router.post("/repos", response_model=GithubRepoOut)
async def add_repo(body: GithubRepoCreate, background_tasks: BackgroundTasks, db: AsyncSession = Depends(get_db)):
    rid = f"{body.owner}/{body.repo}"
    existing = await db.get(GithubRepo, rid)
    if existing:
        raise HTTPException(400, f"{rid} already tracked")

    # Fetch metadata from GitHub to populate stars/description/language
    from github_collector import fetch_repo_meta, _github_token
    token = await _github_token()
    description = ""
    stars = 0
    language = ""
    try:
        meta = await fetch_repo_meta(body.owner, body.repo, token)
        description = (meta.get("description") or "")[:500]
        stars = meta.get("stargazers_count", 0)
        language = meta.get("language") or ""
    except Exception as e:
        # Allow adding even if GitHub API fails (rate limit / not found validated by client)
        print(f"[github] metadata fetch failed for {rid}: {e}")

    repo = GithubRepo(
        id=rid,
        owner=body.owner,
        repo=body.repo,
        description=description,
        stars=stars,
        language=language,
        group=body.group,
        collect_interval_minutes=body.collect_interval_minutes,
    )
    db.add(repo)
    await db.commit()
    await db.refresh(repo)

    # Immediately collect releases for the new repo in background
    async def _initial_collect(rid: str):
        from database import SessionLocal
        async with SessionLocal() as bg_db:
            r = await bg_db.get(GithubRepo, rid)
            if r:
                from github_collector import collect_repo_releases
                await collect_repo_releases(r, bg_db)
    background_tasks.add_task(_initial_collect, rid)

    return repo


@router.patch("/repos/{owner}/{repo_name}", response_model=GithubRepoOut)
async def update_repo(
    owner: str, repo_name: str,
    body: GithubRepoUpdate,
    db: AsyncSession = Depends(get_db),
):
    rid = f"{owner}/{repo_name}"
    repo = await db.get(GithubRepo, rid)
    if not repo:
        raise HTTPException(404, "Repo not found")
    if body.group is not None:
        repo.group = body.group
    if body.muted is not None:
        repo.muted = body.muted
    if body.collect_interval_minutes is not None:
        repo.collect_interval_minutes = max(1, body.collect_interval_minutes)
    if body.release_draft_enabled is not None:
        repo.release_draft_enabled = body.release_draft_enabled
    if body.release_draft_types is not None and len(body.release_draft_types) > 0:
        repo.release_draft_types = [t for t in body.release_draft_types if t in ("tech", "product")]
    await db.commit()
    await db.refresh(repo)
    return repo


@router.delete("/repos/{owner}/{repo_name}")
async def delete_repo(owner: str, repo_name: str, db: AsyncSession = Depends(get_db)):
    rid = f"{owner}/{repo_name}"
    repo = await db.get(GithubRepo, rid)
    if not repo:
        raise HTTPException(404, "Repo not found")
    await db.delete(repo)
    await db.commit()
    return {"ok": True}


# ── Releases ─────────────────────────────────────────────────────────────────

@router.get("/releases", response_model=list[GithubReleaseOut])
async def list_releases(
    repo_id: Optional[str] = Query(None),
    limit: int = Query(30, le=100),
    db: AsyncSession = Depends(get_db),
):
    q = select(GithubRelease).order_by(desc(GithubRelease.published_at)).limit(limit)
    if repo_id:
        q = q.where(GithubRelease.repo_id == repo_id)
    rows = (await db.execute(q)).scalars().all()
    return rows


@router.post("/collect/{owner}/{repo_name}/releases")
async def collect_releases(owner: str, repo_name: str, db: AsyncSession = Depends(get_db)):
    rid = f"{owner}/{repo_name}"
    repo = await db.get(GithubRepo, rid)
    if not repo:
        raise HTTPException(404, "Repo not found")
    from github_collector import collect_repo_releases
    n = await collect_repo_releases(repo, db)
    return {"repo_id": rid, "new_releases": n}


@router.post("/releases/{owner}/{repo_name}/{tag}/dispatch-write", response_model=DispatchResponse)
async def dispatch_release_write(
    owner: str, repo_name: str, tag: str,
    body: DispatchReleaseWriteRequest,
    db: AsyncSession = Depends(get_db),
):
    """Dispatch wms_writer pipeline (editor→writer→illustrator) for a release article."""
    rid = f"{owner}/{repo_name}"
    release_id = f"{rid}:{tag}"
    repo = await db.get(GithubRepo, rid)
    if not repo:
        raise HTTPException(404, "Repo not found")
    release = await db.get(GithubRelease, release_id)
    if not release:
        raise HTTPException(404, "Release not found")

    from models import PublishAccount, WritingPlan, PipelineTask
    account = await db.get(PublishAccount, body.account_id)
    if not account:
        raise HTTPException(404, f"Account '{body.account_id}' not found")
    plan = await db.get(WritingPlan, body.plan_id)
    if not plan:
        raise HTTPException(404, f"Writing plan {body.plan_id} not found")

    account_profile = {
        "name": account.name, "platform": account.platform,
        "positioning": account.positioning, "audience": account.audience,
        "tone": account.tone, "word_range": account.word_range or {},
        "image_style": account.image_style, "cover_style": account.cover_style or {},
        "voice_samples": account.voice_samples or [], "style_rules": account.style_rules or [],
    }

    from pipeline_template import (
        parse_word_spec, resolve_effective_design, RELEASE_WRITE_PIPELINE,
    )
    eff_cover, eff_image = resolve_effective_design(
        account.cover_style, account.image_style or "",
        plan.cover_style, plan.image_style or "",
    )
    account_profile["cover_style"] = eff_cover
    account_profile["image_style"] = eff_image

    word_spec = parse_word_spec(plan.strategy)
    word_rule_line = (
        f"严格按写作策略字数 **{word_spec['raw']}**（忽略上方账号画像的 word_range）"
        if word_spec else "严格按写作策略里的文章格式 / 字数"
    )

    article_title = f"{rid} {release.tag_name}"

    pt = PipelineTask(
        account_id=account.id,
        title=article_title,
        source_url=release.html_url or "",
        writing_plan_id=plan.id,
        task_ids={},
    )
    db.add(pt)
    await db.commit()
    await db.refresh(pt)

    ctx = {
        "title": article_title,
        "account_id": account.id,
        "account_profile": account_profile,
        "platform": account.platform,
        "pipeline_task_id": pt.id,
        "word_spec": word_spec,
        "draft_type": "article",
        "genre": plan.genre or "commentary",
        "plan_strategy": plan.strategy or "",
        "plan_title": plan.title,
        "repo_name": rid,
        "release_tag": release.tag_name,
        "release_name": release.name or "",
        "release_body": release.body or "",
        "release_html_url": release.html_url or "",
        "word_rule_line": word_rule_line,
    }

    from job_dispatch import JobDispatcher, JobDispatchError
    try:
        job_id = await JobDispatcher().create(title=ctx["title"], input_data=ctx, flow="draft")
    except JobDispatchError as e:
        raise HTTPException(502, f"任务队列不可用: {e}")

    pt.task_ids = {"job": job_id}
    await db.commit()

    return DispatchResponse(task_id=job_id, kanban_url="/jobs")


@router.post("/repos/{owner}/{repo_name}/dispatch-intro", response_model=DispatchResponse)
async def dispatch_repo_intro(
    owner: str, repo_name: str,
    body: DispatchRepoIntroRequest,
    db: AsyncSession = Depends(get_db),
):
    """Dispatch wms_writer pipeline to write a project introduction article for a GitHub repo."""
    rid = f"{owner}/{repo_name}"
    repo = await db.get(GithubRepo, rid)
    if not repo:
        raise HTTPException(404, "Repo not found")

    from models import PublishAccount, WritingPlan, PipelineTask
    account = await db.get(PublishAccount, body.account_id)
    if not account:
        raise HTTPException(404, f"Account '{body.account_id}' not found")
    plan = await db.get(WritingPlan, body.plan_id)
    if not plan:
        raise HTTPException(404, f"Writing plan {body.plan_id} not found")

    account_profile = {
        "name": account.name, "platform": account.platform,
        "positioning": account.positioning, "audience": account.audience,
        "tone": account.tone, "word_range": account.word_range or {},
        "image_style": account.image_style, "cover_style": account.cover_style or {},
        "voice_samples": account.voice_samples or [], "style_rules": account.style_rules or [],
    }

    from pipeline_template import resolve_effective_design, REPO_INTRO_PIPELINE
    eff_cover, eff_image = resolve_effective_design(
        account.cover_style, account.image_style or "",
        plan.cover_style, plan.image_style or "",
    )
    account_profile["cover_style"] = eff_cover
    account_profile["image_style"] = eff_image

    article_title = f"{rid} 项目简介"

    pt = PipelineTask(
        account_id=account.id,
        title=article_title,
        source_url=f"https://github.com/{rid}",
        writing_plan_id=plan.id,
        task_ids={},
    )
    db.add(pt)
    await db.commit()
    await db.refresh(pt)

    ctx = {
        "title": article_title,
        "account_id": account.id,
        "account_profile": account_profile,
        "platform": account.platform,
        "pipeline_task_id": pt.id,
        "draft_type": "article",
        "genre": plan.genre or "commentary",
        "plan_strategy": plan.strategy or "",
        "plan_title": plan.title,
        "repo_name": rid,
        "repo_description": repo.description or "",
        "repo_language": repo.language or "",
        "repo_stars": repo.stars or 0,
        "repo_html_url": f"https://github.com/{rid}",
    }

    from job_dispatch import JobDispatcher, JobDispatchError
    try:
        job_id = await JobDispatcher().create(title=ctx["title"], input_data=ctx, flow="draft")
    except JobDispatchError as e:
        raise HTTPException(502, f"任务队列不可用: {e}")

    pt.task_ids = {"job": job_id}
    await db.commit()

    return DispatchResponse(task_id=job_id, kanban_url="/jobs")


@router.post("/releases/{owner}/{repo_name}/{tag}/generate-draft")
async def generate_release_draft(
    owner: str, repo_name: str, tag: str, db: AsyncSession = Depends(get_db)
):
    """Manually generate (or re-generate) draft articles for a specific release."""
    rid = f"{owner}/{repo_name}"
    release_id = f"{rid}:{tag}"
    repo = await db.get(GithubRepo, rid)
    if not repo:
        raise HTTPException(404, "Repo not found")
    release = await db.get(GithubRelease, release_id)
    if not release:
        raise HTTPException(404, "Release not found")

    # Reset so generate_release_drafts will re-run even if already generated
    release.draft_generated_at = None
    await db.commit()

    from release_drafter import generate_release_drafts
    n = await generate_release_drafts(release, repo, db)
    return {"drafts_created": n}


# ── Trending ──────────────────────────────────────────────────────────────────

@router.get("/trending", response_model=list[GithubTrendingRepoOut])
async def list_trending(
    period: str = Query("daily"),
    db: AsyncSession = Depends(get_db),
):
    from sqlalchemy import func
    # Get the latest trending_date for the requested period
    latest = (
        await db.execute(
            select(func.max(GithubTrendingRepo.trending_date))
            .where(GithubTrendingRepo.period == period)
        )
    ).scalar()
    if not latest:
        return []
    rows = (
        await db.execute(
            select(GithubTrendingRepo)
            .where(
                GithubTrendingRepo.period == period,
                GithubTrendingRepo.trending_date == latest,
            )
            .order_by(GithubTrendingRepo.position)
        )
    ).scalars().all()
    return rows


# ── Collection triggers ───────────────────────────────────────────────────────

@router.post("/collect")
async def collect_all(background_tasks: BackgroundTasks, db: AsyncSession = Depends(get_db)):
    """Trigger release collection for all due repos + trending refresh (runs in background)."""
    async def _run():
        from database import SessionLocal
        async with SessionLocal() as bg_db:
            from github_collector import collect_all_repos, collect_trending
            await collect_trending(bg_db)
            await collect_all_repos(bg_db)
    background_tasks.add_task(_run)
    return {"ok": True, "message": "采集任务已启动"}


@router.post("/collect/{owner}/{repo_name}/releases-only")
async def collect_one_releases(owner: str, repo_name: str, db: AsyncSession = Depends(get_db)):
    """Fetch only releases for a repo (fast, synchronous)."""
    rid = f"{owner}/{repo_name}"
    repo = await db.get(GithubRepo, rid)
    if not repo:
        raise HTTPException(404, "Repo not found")
    from github_collector import collect_repo_releases
    n = await collect_repo_releases(repo, db)
    return {"repo_id": rid, "new_releases": n}


@router.post("/collect/{owner}/{repo_name}")
async def collect_one(owner: str, repo_name: str, background_tasks: BackgroundTasks, db: AsyncSession = Depends(get_db)):
    """Trigger release collection for a specific repo (runs in background)."""
    rid = f"{owner}/{repo_name}"
    repo = await db.get(GithubRepo, rid)
    if not repo:
        raise HTTPException(404, "Repo not found")
    async def _run():
        from database import SessionLocal
        async with SessionLocal() as bg_db:
            bg_repo = await bg_db.get(GithubRepo, rid)
            if bg_repo:
                from github_collector import collect_repo_releases
                await collect_repo_releases(bg_repo, bg_db)
    background_tasks.add_task(_run)
    return {"repo_id": rid, "new_releases": 0, "message": "采集任务已启动"}
