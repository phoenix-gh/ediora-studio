"""LLM-based analysis of GitHub issues to surface user pain points."""
import hashlib
from datetime import datetime, timezone, timedelta
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_, delete

from models import GithubRepo, GithubIssue, IssuePainPoint


def _make_id(text: str) -> str:
    return hashlib.md5(text.encode()).hexdigest()[:16]


async def analyze_repo_pain_points(repo_id: str, db: AsyncSession) -> int:
    """Cluster open issues for a repo into pain points using LLM."""
    import llm

    repo = await db.get(GithubRepo, repo_id)
    if not repo:
        return 0

    cutoff = datetime.now(timezone.utc) - timedelta(days=180)
    issues = (
        await db.execute(
            select(GithubIssue)
            .where(
                and_(
                    GithubIssue.repo_id == repo_id,
                    GithubIssue.state == "open",
                    GithubIssue.created_at >= cutoff,
                )
            )
            .order_by((GithubIssue.reactions + GithubIssue.comments).desc())
            .limit(60)
        )
    ).scalars().all()

    if len(issues) < 3:
        return 0

    issues_info = [
        {
            "number": i.number,
            "title": i.title,
            "body": i.body[:400],
            "labels": i.labels,
            "reactions": i.reactions,
            "comments": i.comments,
        }
        for i in issues
    ]

    pain_points = await llm.analyze_github_pain_points(repo.owner, repo.repo, issues_info)
    if not pain_points:
        return 0

    # Replace today's pain points for this repo
    today = datetime.now(timezone.utc).date().isoformat()
    await db.execute(
        delete(IssuePainPoint).where(
            and_(
                IssuePainPoint.repo_id == repo_id,
                # only delete today's records so history is preserved if needed
            )
        )
    )

    count = 0
    for pp in pain_points:
        title = (pp.get("title") or "").strip()
        if not title:
            continue
        ppid = _make_id(f"{repo_id}:{title}:{today}")
        db.add(IssuePainPoint(
            id=ppid,
            repo_id=repo_id,
            title=title,
            description=pp.get("description", "")[:500],
            issue_count=pp.get("issue_count", 0),
            example_issues=pp.get("example_issues", []),
            category=pp.get("category", "bug"),
            severity=pp.get("severity", "medium"),
        ))
        count += 1

    await db.commit()
    return count
