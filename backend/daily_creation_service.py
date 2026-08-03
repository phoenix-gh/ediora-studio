"""Shared bounded operations for configurable daily creation rules."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import json
from zoneinfo import ZoneInfo

from sqlalchemy import desc, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from models import (
    ArticleDraft,
    AgentExecution,
    AgentToolCall,
    ContentJob,
    ContentUsageLedger,
    CreativeAsset,
    DailyCreationRun,
    DailyCreationOutputBatch,
    DailyPlan,
    DailyPlanItem,
    DailyCreationRule,
)


_ASSET_EVIDENCE_TOOLS = {
    "list_creative_asset_candidates",
    "search_creative_assets",
    "get_creative_asset",
}
_USAGE_EVIDENCE_TOOLS = {"get_recent_content_usage"}


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
    directories = normalize_creation_directories(
        rule.directories,
        rule.directory,
    )
    return {
        "id": rule.id,
        "name": rule.name,
        "asset_type": rule.asset_type,
        "directory": directories[0],
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
        "skill_mode": rule.skill_mode or "auto",
        "skill_name": rule.skill_name,
    }


def _evidence_rows(value: object) -> list[dict]:
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    if isinstance(value, dict):
        if "structuredContent" in value:
            return _evidence_rows(value["structuredContent"])
        if "result" in value:
            return _evidence_rows(value["result"])
        if isinstance(value.get("results"), list):
            return [item for item in value["results"] if isinstance(item, dict)]
        if isinstance(value.get("content"), list):
            for item in value["content"]:
                if (
                    isinstance(item, dict)
                    and item.get("type") == "text"
                    and isinstance(item.get("text"), str)
                ):
                    try:
                        return _evidence_rows(json.loads(item["text"]))
                    except json.JSONDecodeError:
                        continue
        return [value]
    return []


def _positive_evidence_ids(value: object, key: str) -> set[int]:
    if not isinstance(value, dict) or not isinstance(value.get(key), list):
        return set()
    return {
        item for item in value[key]
        if isinstance(item, int) and not isinstance(item, bool) and item > 0
    }


async def _observed_creation_evidence(
    session: AsyncSession,
    execution_id: int,
) -> tuple[set[int], set[int]]:
    calls = (await session.execute(
        select(AgentToolCall).where(
            AgentToolCall.execution_id == execution_id,
            AgentToolCall.status == "succeeded",
        )
    )).scalars().all()
    asset_ids: set[int] = set()
    usage_ids: set[int] = set()
    for call in calls:
        rows = _evidence_rows(call.output_data)
        if call.tool_name in _ASSET_EVIDENCE_TOOLS:
            asset_ids.update(
                row["id"] for row in rows
                if isinstance(row.get("id"), int) and row["id"] > 0
            )
            asset_ids.update(_positive_evidence_ids(call.output_data, "evidenceIds"))
        if call.tool_name in _USAGE_EVIDENCE_TOOLS:
            usage_ids.update(
                row["id"] for row in rows
                if isinstance(row.get("id"), int) and row["id"] > 0
            )
            asset_ids.update(
                row["asset_id"] for row in rows
                if isinstance(row.get("asset_id"), int) and row["asset_id"] > 0
            )
            usage_ids.update(_positive_evidence_ids(call.output_data, "evidenceIds"))
            asset_ids.update(
                _positive_evidence_ids(call.output_data, "evidenceAssetIds")
            )
    return asset_ids, usage_ids


def _batch_result(batch: DailyCreationOutputBatch) -> dict:
    return {
        "execution_id": batch.execution_id,
        "run_id": batch.run_id,
        "created_count": batch.created_count,
        "output_ids": list(batch.output_ids or []),
        "draft_ids": list(batch.draft_ids or []),
        "plan_item_ids": list(batch.plan_item_ids or []),
        "usage_ids": list(batch.usage_ids or []),
    }


def _normalize_agent_post(post: object) -> dict:
    if not isinstance(post, dict):
        raise ValueError("each post must be an object")
    source_values = post.get("source_asset_ids")
    if not isinstance(source_values, list):
        raise ValueError("source_asset_ids must be a non-empty list")
    source_ids: list[int] = []
    for value in source_values:
        if not isinstance(value, int) or value <= 0:
            raise ValueError("source_asset_ids must contain positive integers")
        if value not in source_ids:
            source_ids.append(value)
    if not source_ids or len(source_ids) > 20:
        raise ValueError("source_asset_ids must contain between 1 and 20 items")
    text = post.get("text")
    if not isinstance(text, str) or not text.strip() or len(text.strip()) > 5_000:
        raise ValueError("post text must contain between 1 and 5000 characters")
    title = post.get("title")
    if title is not None and (not isinstance(title, str) or len(title.strip()) > 300):
        raise ValueError("post title must contain at most 300 characters")
    reuse_decision = post.get("reuse_decision")
    if reuse_decision not in {"fresh", "reuse_allowed"}:
        raise ValueError("reuse_decision is invalid")
    reuse_explanation = post.get("reuse_explanation", "")
    if not isinstance(reuse_explanation, str) or len(reuse_explanation) > 1_000:
        raise ValueError("reuse_explanation must contain at most 1000 characters")
    compared_values = post.get("compared_usage_ids", [])
    if not isinstance(compared_values, list) or any(
        not isinstance(value, int) or value <= 0 for value in compared_values
    ):
        raise ValueError("compared_usage_ids must contain positive integers")
    compared_ids = list(dict.fromkeys(compared_values))
    metadata = post.get("metadata", {})
    if not isinstance(metadata, dict) or any(
        not isinstance(key, str) or not isinstance(value, str)
        for key, value in metadata.items()
    ) or len(json.dumps(metadata, ensure_ascii=False)) > 4_000:
        raise ValueError("metadata must be a bounded string map")
    return {
        "source_asset_ids": source_ids,
        "title": title.strip() if isinstance(title, str) and title.strip() else None,
        "text": text.strip(),
        "reuse_decision": reuse_decision,
        "reuse_explanation": reuse_explanation.strip(),
        "compared_usage_ids": compared_ids,
        "metadata": metadata,
    }


async def persist_daily_creation_output_batch(
    session: AsyncSession,
    *,
    execution_id: int,
    run_id: int,
    idempotency_key: str,
    posts: list[dict],
    self_validation: dict,
) -> dict:
    """Validate evidence and commit one Agent-owned output batch atomically."""
    normalized_key = idempotency_key.strip()
    if not normalized_key or len(normalized_key) > 200:
        raise ValueError("idempotency_key must contain between 1 and 200 characters")
    if not isinstance(posts, list) or not 1 <= len(posts) <= 50:
        raise ValueError("posts must contain between 1 and 50 items")
    if not isinstance(self_validation, dict) or self_validation.get("passed") is not True:
        raise ValueError("self_validation must explicitly pass")
    normalized_posts = [_normalize_agent_post(post) for post in posts]
    request_hash = hashlib.sha256(json.dumps(
        {"posts": normalized_posts, "self_validation": self_validation},
        ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    ).encode("utf-8")).hexdigest()

    existing = await session.scalar(select(DailyCreationOutputBatch).where(
        DailyCreationOutputBatch.run_id == run_id,
        DailyCreationOutputBatch.idempotency_key == normalized_key,
    ))
    if existing is not None:
        if existing.input_hash != request_hash:
            raise ValueError("idempotency key was already used for different output")
        return _batch_result(existing)

    try:
        await session.execute(
            update(DailyCreationRun)
            .where(DailyCreationRun.id == run_id)
            .values(status=DailyCreationRun.status)
        )
        creation_run = await session.scalar(
            select(DailyCreationRun)
            .where(DailyCreationRun.id == run_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        execution = await session.get(AgentExecution, execution_id)
        if creation_run is None or execution is None:
            raise ValueError("daily creation run or Agent execution not found")
        job = await session.get(ContentJob, execution.job_id)
        if (
            job is None
            or creation_run.content_job_id != job.id
            or job.input_data.get("run_id") != run_id
        ):
            raise ValueError("Agent execution does not belong to the creation run")
        if creation_run.status not in {"queued", "running"}:
            raise ValueError("daily creation run is not eligible for persistence")
        if len(normalized_posts) > creation_run.requested_count:
            raise ValueError("output count exceeds the requested count")

        observed_asset_ids, observed_usage_ids = await _observed_creation_evidence(
            session, execution_id
        )
        requested_asset_ids = {
            asset_id
            for post in normalized_posts
            for asset_id in post["source_asset_ids"]
        }
        if not requested_asset_ids <= observed_asset_ids:
            raise ValueError("one or more source assets were not observed")
        requested_usage_ids = {
            usage_id
            for post in normalized_posts
            for usage_id in post["compared_usage_ids"]
        }
        if not requested_usage_ids <= observed_usage_ids:
            raise ValueError("one or more usage records were not observed")

        snapshot = creation_run.rule_snapshot or {}
        output_ids: list[int] = []
        draft_ids: list[int] = []
        plan_item_ids: list[int] = []
        usage_ids: list[int] = []
        output_details: list[dict] = []
        for post in normalized_posts:
            primary_asset_id = post["source_asset_ids"][0]
            metadata = post["metadata"]
            title = post["title"] or post["text"][:40]
            topic = metadata.get("topic") or title[:300]
            angle = metadata.get("angle") or "Agent validated output"
            if snapshot.get("delivery_mode") == "drafts":
                output, usage = await persist_x_draft_with_usage(
                    session,
                    run_id=run_id,
                    asset_id=primary_asset_id,
                    title=title,
                    text=post["text"],
                    topic=topic,
                    angle=angle,
                    reuse_decision=post["reuse_decision"],
                    reuse_explanation=post["reuse_explanation"],
                    account_id=snapshot.get("account_id"),
                )
                assets = (await session.execute(select(CreativeAsset).where(
                    CreativeAsset.id.in_(post["source_asset_ids"])
                ))).scalars().all()
                output.sources = [
                    {"asset_id": asset.id, "url": asset.url or ""}
                    for asset in assets
                ]
                draft_ids.append(output.id)
            else:
                account_id = snapshot.get("account_id")
                if not account_id:
                    raise ValueError("account_id is required for plan item delivery")
                output, usage = await persist_plan_item_with_usage(
                    session,
                    run_id=run_id,
                    asset_id=primary_asset_id,
                    account_id=account_id,
                    title=title,
                    text=post["text"],
                    topic=topic,
                    angle=angle,
                    reuse_decision=post["reuse_decision"],
                    reuse_explanation=post["reuse_explanation"],
                )
                output.sources = [
                    {"asset_id": asset_id}
                    for asset_id in post["source_asset_ids"]
                ]
                plan_item_ids.append(output.id)
            output_ids.append(output.id)
            usage_ids.append(usage.id)
            output_details.append({
                "output_kind": usage.output_kind,
                "output_id": output.id,
                "draft_id": usage.draft_id,
                "plan_item_id": usage.plan_item_id,
            })

        created_count = len(output_ids)
        batch = DailyCreationOutputBatch(
            run_id=run_id,
            execution_id=execution_id,
            idempotency_key=normalized_key,
            input_hash=request_hash,
            posts_data=normalized_posts,
            self_validation=self_validation,
            output_ids=output_ids,
            draft_ids=draft_ids,
            plan_item_ids=plan_item_ids,
            usage_ids=usage_ids,
            created_count=created_count,
        )
        session.add(batch)
        creation_run.created_count = created_count
        creation_run.status = (
            "succeeded" if created_count == creation_run.requested_count else "partial"
        )
        creation_run.detail = {
            **(creation_run.detail or {}),
            "outputs": output_details,
            "self_validation": self_validation,
        }
        creation_run.completed_at = datetime.now(timezone.utc)
        await session.commit()
        await session.refresh(batch)
        return _batch_result(batch)
    except Exception:
        await session.rollback()
        raise


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
        requested_count=rule.target_count,
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
    plan_item_id: int | None,
    account_id: str | None,
    topic: str,
    angle: str,
    excerpt: str,
    reuse_decision: str,
    reuse_explanation: str,
) -> dict:
    if (draft_id is None) == (plan_item_id is None):
        raise ValueError("exactly one persisted output reference is required")
    return {
        "run_id": creation_run.id,
        "rule_id": creation_run.rule_id,
        "creative_asset_id": asset.id,
        "output_type": snapshot.get("output_type", "x_short_post"),
        "output_kind": output_kind,
        "output_id": output_id,
        "draft_id": draft_id,
        "plan_item_id": plan_item_id,
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
            draft_type="x_post",
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
            plan_item_id=None,
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


async def persist_plan_item_with_usage(
    session: AsyncSession,
    *,
    run_id: int,
    asset_id: int,
    account_id: str,
    title: str,
    text: str,
    topic: str,
    angle: str,
    reuse_decision: str,
    reuse_explanation: str,
) -> tuple[DailyPlanItem, ContentUsageLedger]:
    """Append a rule-owned plan item and usage evidence atomically."""
    transaction = session.begin_nested() if session.in_transaction() else session.begin()
    async with transaction:
        creation_run, asset, snapshot = await _validated_run_asset(
            session, run_id=run_id, asset_id=asset_id
        )
        if snapshot.get("delivery_mode") != "plan_items":
            raise ValueError("Daily creation run is not configured for plan items")
        zone = ZoneInfo(snapshot.get("timezone") or "UTC")
        plan_date = creation_run.scheduled_for.astimezone(zone).date().isoformat()
        plan = await session.scalar(
            select(DailyPlan).where(DailyPlan.plan_date == plan_date)
        )
        if plan is None:
            plan = DailyPlan(plan_date=plan_date, status="ready")
            session.add(plan)
            await session.flush()
        item = DailyPlanItem(
            plan_id=plan.id,
            account_id=account_id,
            title=title.strip(),
            angle=angle.strip(),
            reason=text.strip(),
            content_type="short",
            sources=[{"asset_id": asset.id, "url": asset.url or ""}],
            origin="creation_rule",
            creation_run_id=creation_run.id,
        )
        session.add(item)
        await session.flush()
        usage = ContentUsageLedger(**_usage_values(
            creation_run=creation_run,
            asset=asset,
            snapshot=snapshot,
            output_kind="plan_item",
            output_id=item.id,
            draft_id=None,
            plan_item_id=item.id,
            account_id=account_id,
            topic=topic,
            angle=angle,
            excerpt=text,
            reuse_decision=reuse_decision,
            reuse_explanation=reuse_explanation,
        ))
        session.add(usage)
        await session.flush()
    return item, usage


async def record_content_usage(
    session: AsyncSession,
    *,
    run_id: int,
    asset_id: int,
    output_kind: str,
    output_id: int,
    topic: str,
    angle: str,
    excerpt: str,
    reuse_decision: str,
    reuse_explanation: str = "",
    account_id: str | None = None,
) -> ContentUsageLedger:
    """Record evidence only for an already-persisted draft or plan item."""
    creation_run, asset, snapshot = await _validated_run_asset(
        session, run_id=run_id, asset_id=asset_id
    )
    if output_kind == "draft":
        output = await session.get(ArticleDraft, output_id)
        draft_id, plan_item_id = output_id, None
    elif output_kind == "plan_item":
        output = await session.get(DailyPlanItem, output_id)
        draft_id, plan_item_id = None, output_id
    else:
        raise ValueError("output_kind must be 'draft' or 'plan_item'")
    if output is None:
        raise ValueError(f"Persisted {output_kind} {output_id} not found")
    usage = ContentUsageLedger(**_usage_values(
        creation_run=creation_run,
        asset=asset,
        snapshot=snapshot,
        output_kind=output_kind,
        output_id=output_id,
        draft_id=draft_id,
        plan_item_id=plan_item_id,
        account_id=account_id,
        topic=topic,
        angle=angle,
        excerpt=excerpt,
        reuse_decision=reuse_decision,
        reuse_explanation=reuse_explanation,
    ))
    session.add(usage)
    await session.flush()
    return usage
