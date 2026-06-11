"""GitHub data collection: trending repos and per-repo release tracking."""
import hashlib
import httpx
from datetime import datetime, timezone, timedelta
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from models import GithubRepo, GithubTrendingRepo, GithubRelease

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
    """Fetch GitHub trending repos by scraping github.com/trending directly."""
    import re

    today = datetime.now(timezone.utc).date().isoformat()
    count = 0
    errors = []

    for period in ("daily", "weekly"):
        url = f"https://github.com/trending?since={period}"
        try:
            async with httpx.AsyncClient(timeout=20, follow_redirects=True,
                                         headers={"User-Agent": "WeMediaStudio/1.0"}) as client:
                resp = await client.get(url)
                resp.raise_for_status()
                html = resp.text
        except Exception as e:
            errors.append(f"{period}: fetch failed — {e}")
            continue

        # Parse trending repos from the page HTML
        # Each repo article: <article class="Box-row"> with h2 > a containing owner/repo
        articles = re.split(r'<article[^>]*class="[^"]*Box-row[^"]*"[^>]*>', html)[1:]

        if not articles:
            errors.append(f"{period}: no repos found in HTML")
            continue

        repos = []
        for article in articles:
            # owner/repo from <h2> link: href="/owner/repo"
            h2_match = re.search(r'<h2[^>]*>.*?<a[^>]*href="/([^/"]+)/([^/"]+)"', article, re.DOTALL)
            if not h2_match:
                continue
            owner, repo_name = h2_match.group(1), h2_match.group(2)

            # Description from <p class="col-9 ...">
            desc_match = re.search(r'<p\s+class="[^"]*col-9[^"]*"[^>]*>\s*(.*?)\s*</p>', article, re.DOTALL)
            desc = re.sub(r'<[^>]+>', '', desc_match.group(1)).strip() if desc_match else ""

            # Language
            lang_match = re.search(r'itemprop="programmingLanguage"[^>]*>([^<]+)<', article)
            lang = lang_match.group(1).strip() if lang_match else ""

            # Stars / forks from the trailing text: "123 stars" "45 forks"
            stars_match = re.search(r'(\d[\d,]*)\s+stars', article)
            stars = int(stars_match.group(1).replace(",", "")) if stars_match else 0

            forks_match = re.search(r'(\d[\d,]*)\s+forks', article)
            forks = int(forks_match.group(1).replace(",", "")) if forks_match else 0

            # Stars gained today/this week
            gained_match = re.search(r'(\d[\d,]*)\s+stars?\s+(today|this week|this month)', article)
            stars_gained = int(gained_match.group(1).replace(",", "")) if gained_match else 0

            repos.append({
                "owner": owner,
                "repo": repo_name,
                "description": desc.strip()[:500],
                "language": lang,
                "stars": stars,
                "stars_gained": stars_gained,
                "forks": forks,
                "url": f"https://github.com/{owner}/{repo_name}",
            })

        # Delete today's existing snapshot
        from sqlalchemy import delete
        await db.execute(
            delete(GithubTrendingRepo).where(
                GithubTrendingRepo.period == period,
                GithubTrendingRepo.trending_date == today,
            )
        )

        for i, r in enumerate(repos[:30]):
            tid = hashlib.md5(f"{r['owner']}/{r['repo']}:{period}:{today}".encode()).hexdigest()[:16]
            db.add(GithubTrendingRepo(
                id=tid,
                owner=r["owner"],
                repo=r["repo"],
                description=r["description"],
                language=r["language"],
                stars=r["stars"],
                stars_gained=r["stars_gained"],
                forks=r["forks"],
                period=period,
                position=i + 1,
                trending_date=today,
                url=r["url"],
            ))
            count += 1

    await db.commit()
    if errors and count == 0:
        raise RuntimeError("; ".join(errors))
    return count


async def fetch_repo_meta(owner: str, repo: str, token: str = "") -> dict:
    """Fetch basic repo metadata from GitHub API."""
    headers = _api_headers(token)
    async with httpx.AsyncClient(timeout=15, headers=headers) as client:
        resp = await client.get(f"{GITHUB_API}/repos/{owner}/{repo}")
        resp.raise_for_status()
        return resp.json()


async def collect_repo_releases(repo: GithubRepo, db: AsyncSession) -> int:
    """Fetch the latest 20 releases for a tracked repo.

    唯一的定期采集路径，负责刷新仓库 meta（stars/描述/语言）
    并更新 last_collected_at。"""
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


async def collect_all_repos(db: AsyncSession) -> list[dict]:
    """Collect releases for all non-muted repos that are due for collection.

    最久未采集的优先（NULL 最前）——配额耗尽时被跳过的库
    下一轮自动排到队首，不会有库永远饿死。"""
    repos = (
        await db.execute(
            select(GithubRepo)
            .where(GithubRepo.muted == False)
            .order_by(GithubRepo.last_collected_at.asc().nulls_first())
        )
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
            r = await collect_repo_releases(repo, db)
            results.append({"repo_id": repo.id, "new_releases": r, "error": None})
        except Exception as e:
            results.append({"repo_id": repo.id, "new_releases": 0, "error": str(e)})

    return results
