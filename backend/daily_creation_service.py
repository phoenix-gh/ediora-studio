"""Shared bounded operations for configurable daily creation rules."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from models import (
    ArticleDraft,
    ContentUsageLedger,
    CreativeAsset,
    DailyCreationRun,
    DailyCreationRule,
)


def _bounded(value: int, *, name: str, minimum: int, maximum: int) -> int:
    parsed = int(value)
    if parsed < minimum or parsed > maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return parsed


def normalize_creation_directories(
    directories: object,
    directory: object = "",
) -> list[str]:
    """Return one bounded, ordered list while accepting legacy input."""
    values = directories if isinstance(directories, (list, tuple)) else []
    if not values and isinstance(directory, str) and directory.strip():
        values = [directory]
    normalized: list[str] = []
    for value in values:
        if not isinstance(value, str) or not value.strip():
            continue
        name = value.strip()
        if name not in normalized:
            normalized.append(name)
    if not normalized:
        raise ValueError("at least one directory is required")
    if len(normalized) > 50:
        raise ValueError("directories must contain at most 50 items")
    return normalized


async def list_creative_asset_candidates(
    session: AsyncSession,
    *,
    asset_type: str,
    directories: list[str] | None = None,
    directory: str = "",
    query: str = "",
    limit: int = 50,
) -> list[dict]:
    """Return compact candidate evidence without leaking full asset bodies."""
    normalized_type = asset_type.strip().lower()
    if normalized_type not in {"article", "media"}:
        raise ValueError("asset_type must be 'article' or 'media'")
    normalized_directories = normalize_creation_directories(
        directories,
        directory,
    )
    take = _bounded(limit, name="limit", minimum=1, maximum=50)
    keywords = [part.lower() for part in query.split() if part.strip()]

    statement = (
        select(CreativeAsset)
        .where(
            CreativeAsset.asset_type == normalized_type,
            CreativeAsset.directory.in_(normalized_directories),
        )
        .order_by(desc(CreativeAsset.updated_at), desc(CreativeAsset.id))
        .limit(500)
    )
    assets = (await session.execute(statement)).scalars().all()

    def matches(asset: CreativeAsset) -> bool:
        searchable = " ".join(
            [asset.title or "", asset.content or "", " ".join(asset.tags or [])]
        ).lower()
        return all(keyword in searchable for keyword in keywords)

    return [
        {
            "id": asset.id,
            "title": asset.title or "",
            "summary": " ".join((asset.content or "").split())[:300],
            "tags": asset.tags or [],
            "source_url": asset.url or "",
            "created_at": _isoformat(asset.created_at),
            "content_length": len(asset.content or ""),
        }
        for asset in assets
        if matches(asset)
    ][:take]


async def get_recent_content_usage(
    session: AsyncSession,
    *,
    lookback_days: int,
    output_type: str,
    rule_id: int | None = None,
    account_id: str | None = None,
    limit: int = 100,
    now: datetime | None = None,
) -> list[dict]:
    """Return global usage history unless the caller explicitly narrows it."""
    days = _bounded(
        lookback_days, name="lookback_days", minimum=1, maximum=90
    )
    take = _bounded(limit, name="limit", minimum=1, maximum=100)
    normalized_output_type = output_type.strip()
    if not normalized_output_type:
        raise ValueError("output_type is required")
    reference = now or datetime.now(timezone.utc)
    if reference.tzinfo is None:
        reference = reference.replace(tzinfo=timezone.utc)
    since = reference.astimezone(timezone.utc) - timedelta(days=days)

    statement = select(ContentUsageLedger).where(
        ContentUsageLedger.output_type == normalized_output_type,
        ContentUsageLedger.created_at >= since,
    )
    if rule_id is not None:
        statement = statement.where(ContentUsageLedger.rule_id == rule_id)
    if account_id is not None:
        statement = statement.where(ContentUsageLedger.account_id == account_id)
    rows = (
        await session.execute(
            statement.order_by(
                desc(ContentUsageLedger.created_at),
                desc(ContentUsageLedger.id),
            ).limit(take)
        )
    ).scalars().all()
    return [
        {
            "id": row.id,
            "asset_id": row.creative_asset_id,
            "rule_name": row.rule_name or "",
            "topic": row.topic or "",
            "angle": row.angle or "",
            "excerpt": row.excerpt or "",
            "reuse_decision": row.reuse_decision or "fresh",
            "reuse_explanation": row.reuse_explanation or "",
            "created_at": _isoformat(row.created_at),
        }
        for row in rows
    ]


def _isoformat(value: datetime | None) -> str:
    if value is None:
        return ""
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat()


def snapshot_creation_rule(rule: DailyCreationRule) -> dict:
    """Capture every execution-relevant field before a rule can change."""
    directories = (
        normalize_creation_directories(rule.directories, rule.directory)
        if rule.directories or rule.directory
        else []
    )
    return {
        "id": rule.id,
        "name": rule.name,
        "asset_type": rule.asset_type,
        "directory": directories[0] if directories else "",
        "directories": directories,
        "output_type": rule.output_type,
        "target_count": rule.target_count,
        "execution_mode": rule.execution_mode,
        "scheduled_date": rule.scheduled_date,
        "scheduled_time": rule.scheduled_time,
        "timezone": rule.timezone,
        "lookback_days": rule.lookback_days,
        "delivery_mode": rule.delivery_mode,
        "account_id": rule.account_id,
        "instructions": rule.instructions or "",
        "prompt": rule.prompt,
        "skill_mode": rule.skill_mode or "auto",
        "skill_name": rule.skill_name,
    }


async def create_daily_creation_run(
    session: AsyncSession,
    *,
    rule: DailyCreationRule,
    scheduled_for: datetime,
    trigger_kind: str,
) -> tuple[DailyCreationRun, bool]:
    """Create the run and durable job once; the caller dispatches after commit."""
    from content_jobs import create_job

    if rule.deleted_at is not None or not rule.enabled:
        raise ValueError("Daily creation rule is disabled or deleted")
    if trigger_kind == "explicit":
        existing = await session.scalar(
            select(DailyCreationRun).where(
                DailyCreationRun.rule_id == rule.id,
                DailyCreationRun.trigger_kind == "explicit",
                DailyCreationRun.status.in_(("queued", "running")),
            ).order_by(desc(DailyCreationRun.id)).limit(1)
        )
        if existing is not None:
            return existing, False
    creation_run = DailyCreationRun(
        rule_id=rule.id,
        scheduled_for=scheduled_for,
        trigger_kind=trigger_kind,
        status="queued",
        requested_count=0,
        rule_snapshot=snapshot_creation_rule(rule),
    )
    session.add(creation_run)
    await session.flush()
    job = await create_job(
        session,
        flow="daily_creation",
        title=rule.name,
        input_data={"run_id": creation_run.id},
        idempotency_key=(
            f"daily-creation:{rule.id}:{scheduled_for.isoformat()}:{trigger_kind}"
        ),
        commit=False,
    )
    creation_run.content_job_id = job.id
    await session.flush()
    return creation_run, True


async def _validated_run_asset(
    session: AsyncSession,
    *,
    run_id: int,
    asset_id: int,
) -> tuple[DailyCreationRun, CreativeAsset, dict]:
    creation_run = await session.get(DailyCreationRun, run_id)
    if creation_run is None:
        raise ValueError(f"Daily creation run {run_id} not found")
    asset = await session.get(CreativeAsset, asset_id)
    if asset is None:
        raise ValueError(f"Creative asset {asset_id} not found")
    snapshot = creation_run.rule_snapshot or {}
    allowed_directories = normalize_creation_directories(
        snapshot.get("directories"),
        snapshot.get("directory"),
    )
    if (
        asset.asset_type != snapshot.get("asset_type")
        or asset.directory not in allowed_directories
    ):
        raise ValueError("Creative asset is outside the configured directory")
    return creation_run, asset, snapshot


def _usage_values(
    *,
    creation_run: DailyCreationRun,
    asset: CreativeAsset,
    snapshot: dict,
    output_kind: str,
    output_id: int,
    draft_id: int | None,
    account_id: str | None,
    topic: str,
    angle: str,
    excerpt: str,
    reuse_decision: str,
    reuse_explanation: str,
) -> dict:
    if draft_id is None:
        raise ValueError("a persisted draft reference is required")
    return {
        "run_id": creation_run.id,
        "rule_id": creation_run.rule_id,
        "creative_asset_id": asset.id,
        "output_type": snapshot.get("output_type", "x_short_post"),
        "output_kind": output_kind,
        "output_id": output_id,
        "draft_id": draft_id,
        "account_id": account_id,
        "rule_name": snapshot.get("name", ""),
        "topic": topic.strip(),
        "angle": angle.strip(),
        "excerpt": " ".join(excerpt.split())[:500],
        "reuse_decision": reuse_decision.strip() or "fresh",
        "reuse_explanation": reuse_explanation.strip(),
    }


async def persist_x_draft_with_usage(
    session: AsyncSession,
    *,
    run_id: int,
    asset_id: int,
    title: str,
    text: str,
    topic: str,
    angle: str,
    reuse_decision: str,
    reuse_explanation: str,
    account_id: str | None = None,
) -> tuple[ArticleDraft, ContentUsageLedger]:
    """Persist an X draft and its deduplication evidence in one transaction."""
    transaction = session.begin_nested() if session.in_transaction() else session.begin()
    async with transaction:
        creation_run, asset, snapshot = await _validated_run_asset(
            session, run_id=run_id, asset_id=asset_id
        )
        if snapshot.get("delivery_mode") != "drafts":
            raise ValueError("Daily creation run is not configured for drafts")
        draft = ArticleDraft(
            topic_id=f"daily-creation:{run_id}",
            title=title.strip(),
            content=text.strip(),
            status="drafting",
            draft_type="x",
            sources=[{"asset_id": asset.id, "url": asset.url or ""}],
        )
        session.add(draft)
        await session.flush()
        usage = ContentUsageLedger(**_usage_values(
            creation_run=creation_run,
            asset=asset,
            snapshot=snapshot,
            output_kind="draft",
            output_id=draft.id,
            draft_id=draft.id,
            account_id=account_id,
            topic=topic,
            angle=angle,
            excerpt=text,
            reuse_decision=reuse_decision,
            reuse_explanation=reuse_explanation,
        ))
        session.add(usage)
        await session.flush()
    return draft, usage


async def record_content_usage(
    session: AsyncSession, *, run_id: int, asset_id: int, output_kind: str,
    output_id: int, topic: str, angle: str, excerpt: str,
    reuse_decision: str, reuse_explanation: str = "", account_id: str | None = None,
) -> ContentUsageLedger:
    if output_kind != "draft":
        raise ValueError("output_kind must be 'draft'")
    existing = await session.scalar(
        select(ContentUsageLedger).where(
            ContentUsageLedger.run_id == run_id,
            ContentUsageLedger.output_kind == output_kind,
            ContentUsageLedger.output_id == output_id,
        ).limit(1)
    )
    if existing is not None:
        if existing.creative_asset_id != asset_id:
            raise ValueError("Persisted output usage was already recorded for another asset")
        return existing
    creation_run = await session.get(DailyCreationRun, run_id)
    if creation_run is None:
        raise ValueError(f"Daily creation run {run_id} not found")
    asset = await session.get(CreativeAsset, asset_id)
    if asset is None:
        raise ValueError(f"Creative asset {asset_id} not found")
    output = await session.get(ArticleDraft, output_id)
    if output is None:
        raise ValueError(f"Persisted draft {output_id} not found")
    snapshot = creation_run.rule_snapshot or {}
    usage_snapshot = {
        "name": snapshot.get("name", ""),
        "output_type": (
            "x_short_post" if output.draft_type == "x"
            else output.draft_type or "article"
        ),
    }
    usage = ContentUsageLedger(**_usage_values(
        creation_run=creation_run, asset=asset, snapshot=usage_snapshot,
        output_kind="draft", output_id=output_id, draft_id=output_id,
        account_id=account_id,
        topic=topic, angle=angle, excerpt=excerpt, reuse_decision=reuse_decision,
        reuse_explanation=reuse_explanation,
    ))
    session.add(usage)
    await session.flush()
    return usage
