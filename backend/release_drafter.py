"""Generate ArticleDraft records from new GitHub releases."""
from datetime import datetime, timezone, timedelta
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc

from models import GithubRepo, GithubRelease, ArticleDraft

_SKIP_OLDER_THAN_DAYS = 30


async def generate_release_drafts(release: GithubRelease, repo: GithubRepo, db: AsyncSession) -> int:
    """Generate tech/product ArticleDraft records for a single release. Returns count created."""
    import llm

    draft_types: list[str] = repo.release_draft_types or ["tech", "product"]
    if not draft_types:
        release.draft_generated_at = datetime.now(timezone.utc)
        await db.commit()
        return 0

    result = await llm.generate_release_article(
        repo=repo.id,
        tag=release.tag_name,
        release_name=release.name or release.tag_name,
        html_url=release.html_url,
        body=release.body or "",
        draft_types=draft_types,
    )

    count = 0
    for dtype in draft_types:
        data = result.get(dtype)
        if not data:
            continue

        topic_id = f"release:{repo.id}:{release.tag_name}"
        title = data.get("title") or f"[{dtype}] {repo.id} {release.tag_name}"

        # Belt-and-suspenders: skip if draft for this release+type already exists
        existing = (await db.execute(
            select(ArticleDraft).where(
                ArticleDraft.topic_id == topic_id,
                ArticleDraft.title == title,
            )
        )).scalar_one_or_none()
        if existing:
            continue

        sections = data.get("sections") or []
        content_parts = []
        for sec in sections:
            content_parts.append(sec.get("heading", ""))
            content_parts.append(sec.get("content", ""))
            for todo in sec.get("todos") or []:
                content_parts.append(f"\n{todo}")
            content_parts.append("")

        content = "\n\n".join(p for p in content_parts if p is not None)

        db.add(ArticleDraft(
            topic_id=topic_id,
            title=title,
            content=content,
            status="drafting",
            draft_type="article",
            sources=[{"url": release.html_url, "title": release.tag_name, "note": ""}],
        ))
        count += 1

    release.draft_generated_at = datetime.now(timezone.utc)
    await db.commit()
    return count


async def generate_pending_drafts(db: AsyncSession) -> int:
    """For each enabled repo, check its latest release and generate drafts if not yet done."""
    repos = (
        await db.execute(
            select(GithubRepo).where(
                GithubRepo.release_draft_enabled == True,  # noqa: E712
                GithubRepo.muted == False,  # noqa: E712
            )
        )
    ).scalars().all()

    cutoff = datetime.now(timezone.utc) - timedelta(days=_SKIP_OLDER_THAN_DAYS)
    total = 0

    for repo in repos:
        latest = (
            await db.execute(
                select(GithubRelease)
                .where(GithubRelease.repo_id == repo.id)
                .order_by(desc(GithubRelease.published_at))
                .limit(1)
            )
        ).scalar_one_or_none()

        if not latest:
            continue
        if latest.draft_generated_at is not None:
            continue

        pub = latest.published_at
        if pub.tzinfo is None:
            pub = pub.replace(tzinfo=timezone.utc)

        if pub < cutoff:
            # Too old — mark as skipped without generating
            latest.draft_generated_at = datetime.now(timezone.utc)
            await db.commit()
            continue

        try:
            n = await generate_release_drafts(latest, repo, db)
            total += n
        except Exception as e:
            print(f"[release_drafter] failed for {repo.id}: {e}")

    return total
