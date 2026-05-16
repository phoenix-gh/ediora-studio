from fastapi import APIRouter, HTTPException, Query, BackgroundTasks
from sqlalchemy import select, desc
from typing import Optional

from database import SessionLocal, get_db
from models import GithubRepo, GithubIssue, IssuePainPoint, GithubTrendingRepo, GithubRelease
from schemas import (
    GithubRepoCreate, GithubRepoUpdate, GithubRepoOut,
    GithubIssueOut, IssuePainPointOut, GithubTrendingRepoOut, GithubReleaseOut,
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

    # Immediately collect issues + releases for the new repo in background
    async def _initial_collect(rid: str):
        from database import SessionLocal
        async with SessionLocal() as bg_db:
            r = await bg_db.get(GithubRepo, rid)
            if r:
                from github_collector import collect_repo_issues, collect_repo_releases
                await collect_repo_issues(r, bg_db)
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


# ── Issues ────────────────────────────────────────────────────────────────────

@router.get("/issues", response_model=list[GithubIssueOut])
async def list_issues(
    repo_id: Optional[str] = Query(None),
    limit: int = Query(50, le=200),
    db: AsyncSession = Depends(get_db),
):
    q = select(GithubIssue).order_by(
        desc(GithubIssue.reactions + GithubIssue.comments)
    ).limit(limit)
    if repo_id:
        q = q.where(GithubIssue.repo_id == repo_id)
    rows = (await db.execute(q)).scalars().all()
    return rows


# ── Pain Points ───────────────────────────────────────────────────────────────

@router.get("/pain-points", response_model=list[IssuePainPointOut])
async def list_pain_points(
    repo_id: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
):
    q = select(IssuePainPoint).order_by(desc(IssuePainPoint.created_at))
    if repo_id:
        q = q.where(IssuePainPoint.repo_id == repo_id)
    rows = (await db.execute(q)).scalars().all()
    return rows


@router.post("/pain-points/analyze")
async def analyze_pain_points(repo_id: str, db: AsyncSession = Depends(get_db)):
    """Trigger LLM pain point analysis for a repo."""
    from github_analyzer import analyze_repo_pain_points
    n = await analyze_repo_pain_points(repo_id, db)
    return {"new_pain_points": n}


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
    """Trigger issue collection for all due repos + trending refresh (runs in background)."""
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
    """Trigger issue + release collection for a specific repo (runs in background)."""
    rid = f"{owner}/{repo_name}"
    repo = await db.get(GithubRepo, rid)
    if not repo:
        raise HTTPException(404, "Repo not found")
    async def _run():
        from database import SessionLocal
        async with SessionLocal() as bg_db:
            bg_repo = await bg_db.get(GithubRepo, rid)
            if bg_repo:
                from github_collector import collect_repo_issues, collect_repo_releases
                await collect_repo_issues(bg_repo, bg_db)
                await collect_repo_releases(bg_repo, bg_db)
    background_tasks.add_task(_run)
    return {"repo_id": rid, "new_issues": 0, "new_releases": 0, "message": "采集任务已启动"}
