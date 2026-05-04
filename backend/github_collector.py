"""GitHub data collection: trending repos and per-repo issue tracking."""
import hashlib
import httpx
from datetime import datetime, timezone, timedelta
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from models import GithubRepo, GithubIssue, GithubTrendingRepo, GithubRelease

GITHUB_API = "https://api.github.com"


async def _github_token() -> str:
    try:
        from config import get_config
        cfg = await get_config()
        return cfg.get("github_token", "") or ""
    except Exception:
        return ""


async def _rsshub_base() -> str:
    try:
        from config import get_config
        cfg = await get_config()
        return cfg.get("rsshub_base", "http://127.0.0.1:1200") or "http://127.0.0.1:1200"
    except Exception:
        return "http://127.0.0.1:1200"


def _api_headers(token: str) -> dict:
    h = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h



async def collect_trending(db: AsyncSession) -> int:
    """Fetch GitHub trending repos via gtrending library (scrapes github.com/trending)."""
    import asyncio
    from gtrending import fetch_repos

    today = datetime.now(timezone.utc).date().isoformat()
    count = 0
    loop = asyncio.get_event_loop()

    for period in ("daily", "weekly"):
        try:
            repos = await loop.run_in_executor(None, lambda p=period: fetch_repos(since=p))
        except Exception as e:
            print(f"[github] trending/{period} fetch failed: {e}")
            continue

        if not repos:
            print(f"[github] trending/{period} returned 0 repos")
            continue

        for r in repos[:30]:
            owner = r.get("author", "")
            repo_name = r.get("name", "")
            if not owner or not repo_name:
                continue

            tid = hashlib.md5(f"{owner}/{repo_name}:{period}:{today}".encode()).hexdigest()[:16]
            if await db.get(GithubTrendingRepo, tid):
                continue

            db.add(GithubTrendingRepo(
                id=tid,
                owner=owner,
                repo=repo_name,
                description=(r.get("description") or "").strip()[:500],
                language=r.get("language") or "",
                stars=r.get("stars", 0),
                stars_gained=r.get("currentPeriodStars", 0),
                forks=r.get("forks", 0),
                period=period,
                trending_date=today,
                url=r.get("url") or f"https://github.com/{owner}/{repo_name}",
            ))
            count += 1

    await db.commit()
    return count


async def fetch_repo_meta(owner: str, repo: str, token: str = "") -> dict:
    """Fetch basic repo metadata from GitHub API."""
    headers = _api_headers(token)
    async with httpx.AsyncClient(timeout=15, headers=headers) as client:
        resp = await client.get(f"{GITHUB_API}/repos/{owner}/{repo}")
        resp.raise_for_status()
        return resp.json()


async def collect_repo_issues(repo: GithubRepo, db: AsyncSession) -> int:
    """Fetch open issues for a tracked repo from GitHub API."""
    token = await _github_token()
    headers = _api_headers(token)

    try:
        async with httpx.AsyncClient(timeout=30, headers=headers) as client:
            resp = await client.get(
                f"{GITHUB_API}/repos/{repo.owner}/{repo.repo}/issues",
                params={
                    "state": "open",
                    "sort": "updated",
                    "direction": "desc",
                    "per_page": 100,
                },
            )
            remaining = int(resp.headers.get("X-RateLimit-Remaining", "999"))
            if resp.status_code == 403 or remaining == 0:
                reset_ts = resp.headers.get("X-RateLimit-Reset", "")
                print(f"[github] rate limited for {repo.id}; reset at {reset_ts}")
                return 0
            resp.raise_for_status()
            issues = resp.json()
    except Exception as e:
        print(f"[github] issue fetch failed for {repo.id}: {e}")
        return 0

    new_count = 0
    for issue in issues:
        # Skip pull requests (they share the issues endpoint)
        if issue.get("pull_request"):
            continue

        number = issue["number"]
        iid = f"{repo.id}:{number}"
        reactions = issue.get("reactions", {}).get("total_count", 0)

        existing = await db.get(GithubIssue, iid)
        if existing:
            existing.comments = issue.get("comments", 0)
            existing.reactions = reactions
            existing.updated_at = datetime.fromisoformat(
                issue["updated_at"].replace("Z", "+00:00")
            )
        else:
            labels = [lbl["name"] for lbl in issue.get("labels", [])]
            body = (issue.get("body") or "")[:3000]
            db.add(GithubIssue(
                id=iid,
                repo_id=repo.id,
                number=number,
                title=(issue.get("title") or "")[:500],
                body=body,
                labels=labels,
                state="open",
                comments=issue.get("comments", 0),
                reactions=reactions,
                html_url=issue.get("html_url", ""),
                created_at=datetime.fromisoformat(
                    issue["created_at"].replace("Z", "+00:00")
                ),
                updated_at=datetime.fromisoformat(
                    issue["updated_at"].replace("Z", "+00:00")
                ),
            ))
            new_count += 1

    # Refresh repo metadata (stars, description)
    try:
        meta = await fetch_repo_meta(repo.owner, repo.repo, token)
        repo.stars = meta.get("stargazers_count", repo.stars)
        repo.description = (meta.get("description") or repo.description)[:500]
        repo.language = meta.get("language") or repo.language
    except Exception:
        pass

    repo.last_collected_at = datetime.now(timezone.utc)
    await db.commit()
    return new_count


async def collect_repo_releases(repo: GithubRepo, db: AsyncSession) -> int:
    """Fetch the latest 20 releases for a tracked repo."""
    token = await _github_token()
    headers = _api_headers(token)

    try:
        async with httpx.AsyncClient(timeout=20, headers=headers) as client:
            resp = await client.get(
                f"{GITHUB_API}/repos/{repo.owner}/{repo.repo}/releases",
                params={"per_page": 20},
            )
            remaining = int(resp.headers.get("X-RateLimit-Remaining", "999"))
            if resp.status_code == 403 or remaining == 0:
                print(f"[github] rate limited (releases) for {repo.id}")
                return 0
            resp.raise_for_status()
            releases = resp.json()
    except Exception as e:
        print(f"[github] release fetch failed for {repo.id}: {e}")
        return 0

    new_count = 0
    for rel in releases:
        tag = rel.get("tag_name", "")
        if not tag:
            continue
        rid = f"{repo.id}:{tag}"
        if await db.get(GithubRelease, rid):
            continue

        published_raw = rel.get("published_at") or rel.get("created_at")
        if not published_raw:
            continue

        db.add(GithubRelease(
            id=rid,
            repo_id=repo.id,
            tag_name=tag,
            name=(rel.get("name") or tag)[:300],
            body=(rel.get("body") or "")[:5000],
            is_prerelease=rel.get("prerelease", False),
            is_draft=rel.get("draft", False),
            html_url=rel.get("html_url", ""),
            published_at=datetime.fromisoformat(published_raw.replace("Z", "+00:00")),
        ))
        new_count += 1

    await db.commit()
    return new_count


async def collect_all_repos(db: AsyncSession) -> list[dict]:
    """Collect issues for all non-muted repos that are due for collection."""
    repos = (
        await db.execute(select(GithubRepo).where(GithubRepo.muted == False))
    ).scalars().all()

    results = []
    now = datetime.now(timezone.utc)

    for repo in repos:
        if repo.last_collected_at:
            last = repo.last_collected_at
            if last.tzinfo is None:
                last = last.replace(tzinfo=timezone.utc)
            elapsed_min = (now - last).total_seconds() / 60
            if elapsed_min < repo.collect_interval_minutes:
                continue
        try:
            n = await collect_repo_issues(repo, db)
            r = await collect_repo_releases(repo, db)
            results.append({"repo_id": repo.id, "new_issues": n, "new_releases": r, "error": None})
        except Exception as e:
            results.append({"repo_id": repo.id, "new_issues": 0, "new_releases": 0, "error": str(e)})

    return results
