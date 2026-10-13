"""Shared bounded operations for configurable daily creation rules."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import desc, or_, select
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


def creative_asset_search_score(asset: CreativeAsset, query: str) -> int:
    """Score an asset for a space-separated, metadata-aware keyword query.

    Each non-empty term is an alternative match. Including the directory is
    important for media assets whose title is intentionally short, while the
    score keeps assets matching more terms ahead of weaker matches.
    """
    keywords = [part.casefold() for part in query.split() if part.strip()]
    if not keywords:
        return 0
    searchable = " ".join([
        asset.directory or "",
        asset.title or "",
        asset.content or "",
        " ".join(asset.tags or []),
    ]).casefold()
    return sum(keyword in searchable for keyword in keywords)


def adoption_cutoff(
    lookback_days: int,
    now: datetime | None = None,
) -> datetime | None:
    """Assets adopted at or after this instant are still inside the window."""
    try:
        days = int(lookback_days)
    except (TypeError, ValueError):
        return None
    if days <= 0:
        return None
    days = min(days, 90)
    reference = now or datetime.now(timezone.utc)
    if reference.tzinfo is None:
        reference = reference.replace(tzinfo=timezone.utc)
    return reference.astimezone(timezone.utc) - timedelta(days=days)


def not_recently_adopted(
    lookback_days: int,
    now: datetime | None = None,
    *,
    asset: type[CreativeAsset] = CreativeAsset,
):
    """SQL clause that keeps assets outside the adoption window.

    Pass the same mapped class the SELECT uses. A reloaded model registry
    has another table object with the same name, and mixing them makes
    PostgreSQL reject the statement as a duplicate alias.
    """
    cutoff = adoption_cutoff(lookback_days, now)
    if cutoff is None:
        return None
    adopted_at = asset.last_adopted_at
    return or_(adopted_at.is_(None), adopted_at < cutoff)


async def mark_assets_adopted(
    session: AsyncSession,
    asset_ids: list[int] | None,
    *,
    now: datetime | None = None,
) -> None:
    """Stamp last_adopted_at. A missing id raises so the draft can roll back."""
    ids: list[int] = []
    for raw in asset_ids or []:
        try:
            asset_id = int(raw)
        except (TypeError, ValueError) as error:
            raise ValueError("Creative asset id is invalid") from error
        if asset_id <= 0:
            raise ValueError(f"Creative asset {asset_id} not found")
        if asset_id not in ids:
            ids.append(asset_id)
    if not ids:
        return
    if len(ids) > 50:
        raise ValueError("asset_ids must contain at most 50 items")
    reference = now or datetime.now(timezone.utc)
    if reference.tzinfo is None:
        reference = reference.replace(tzinfo=timezone.utc)
    reference = reference.astimezone(timezone.utc)
    assets = (
        await session.execute(
            select(CreativeAsset).where(CreativeAsset.id.in_(ids))
        )
    ).scalars().all()
    found = {asset.id for asset in assets}
    missing = next((asset_id for asset_id in ids if asset_id not in found), None)
    if missing is not None:
        raise ValueError(f"Creative asset {missing} not found")
    for asset in assets:
        asset.last_adopted_at = reference
    await session.flush()


async def list_creative_asset_candidates(
    session: AsyncSession,
    *,
    asset_type: str,
    directories: list[str] | None = None,
    directory: str = "",
    query: str = "",
    limit: int = 50,
    lookback_days: int = 0,
    now: datetime | None = None,
) -> list[dict]:
    """Return compact candidate evidence without leaking full asset bodies.

    lookback_days above zero omits assets adopted inside that window.
    """
    normalized_type = asset_type.strip().lower()
    if normalized_type not in {"article", "media"}:
        raise ValueError("asset_type must be 'article' or 'media'")
    normalized_directories = normalize_creation_directories(
        directories,
        directory,
    )
    take = _bounded(limit, name="limit", minimum=1, maximum=50)

    statement = (
        select(CreativeAsset)
        .where(
            CreativeAsset.asset_type == normalized_type,
            CreativeAsset.directory.in_(normalized_directories),
        )
    )
    available = not_recently_adopted(lookback_days, now)
    if available is not None:
        statement = statement.where(available)
    statement = statement.order_by(
        desc(CreativeAsset.updated_at), desc(CreativeAsset.id)
    ).limit(500)
    assets = (await session.execute(statement)).scalars().all()

    scored_assets = [
        (asset, creative_asset_search_score(asset, query))
        for asset in assets
    ]
    if query.strip():
        scored_assets = [item for item in scored_assets if item[1] > 0]
        scored_assets.sort(key=lambda item: item[1], reverse=True)

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
        for asset, _score in scored_assets
    ][:take]


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
        "codex_model": _stored_codex_value(rule.codex_model),
        "codex_reasoning_effort": _stored_codex_value(rule.codex_reasoning_effort),
    }


def _stored_codex_value(value: str | None) -> str | None:
    """Blank task settings follow the system Codex model and effort."""
    text = str(value or "").strip()
    return text or None


async def create_daily_creation_run(
    session: AsyncSession,
    *,
    rule: DailyCreationRule,
    scheduled_for: datetime,
    trigger_kind: str,
) -> tuple[DailyCreationRun, bool]:
    """Create the run and durable job once; the caller dispatches after commit."""
    from content_jobs import create_job

    if rule.deleted_at is not None or (
        not rule.enabled and trigger_kind != "explicit"
    ):
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
        await mark_assets_adopted(session, [asset.id])
    return draft, usage
