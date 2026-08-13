"""Domain policy for the source-neutral content response inbox."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from content_jobs import create_job
from models import (
    ContentAnalysisRun,
    ContentJob,
    ContentResponseEvent,
    ContentResponseItem,
    ContentResponseOutput,
    PublishAccount,
    XPost,
    YoutubeVideo,
)


VALUE_DIMENSIONS = {
    "novelty",
    "practicality",
    "credibility",
    "writing_space",
    "evergreen_value",
}
CONTENT_TYPES = {
    "tool",
    "industry_update",
    "case",
    "tutorial",
    "research",
}
DISPOSITIONS = {
    "worth_writing",
    "creative_asset",
    "not_processed",
}
LEGACY_OUTPUT_TYPES = {
    "expanded_article",
    "commentary",
    "x_share",
    "x_reply",
    "x_quote",
}
WRITING_TARGETS = {
    "x_short_post": {"label": "X 短帖", "draft_type": "x"},
    "x_article": {"label": "X Article", "draft_type": "x_article"},
    "wechat_article": {"label": "公众号文章", "draft_type": "mp"},
}
OUTPUT_TYPES = LEGACY_OUTPUT_TYPES | set(WRITING_TARGETS)
DRAFT_OUTPUT_TYPES = {
    "expanded_article": "article",
    "commentary": "article",
    **{
        output_type: target["draft_type"]
        for output_type, target in WRITING_TARGETS.items()
    },
}


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def validate_analysis_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Validate the cross-runtime AI contract before anything is persisted."""
    score = payload.get("content_value_score")
    if not isinstance(score, int) or isinstance(score, bool) or not 0 <= score <= 100:
        raise ValueError("content_value_score must be an integer from 0 to 100")
    dimensions = payload.get("value_dimensions")
    if not isinstance(dimensions, dict) or set(dimensions) != VALUE_DIMENSIONS:
        raise ValueError("value_dimensions must contain exactly five dimensions")
    for name, value in dimensions.items():
        if (
            not isinstance(value, dict)
            or not isinstance(value.get("score"), int)
            or not 0 <= value["score"] <= 100
            or not str(value.get("reason") or "").strip()
        ):
            raise ValueError(f"value_dimensions.{name} is invalid")

    def string_list(name: str) -> list[str]:
        value = payload.get(name)
        if not isinstance(value, list) or any(
            not isinstance(entry, str) or not entry.strip() for entry in value
        ):
            raise ValueError(f"{name} must be a list of non-empty strings")
        return value

    string_list("value_points")
    string_list("risks")
    string_list("verification_items")
    string_list("suggested_structure")
    for name in ("summary_cn", "core_thesis", "recommendation_reason", "suggested_title", "suggested_angle", "target_reader"):
        if not isinstance(payload.get(name), str) or not payload[name].strip():
            raise ValueError(f"{name} must be a non-empty string")

    content_types = payload.get("recommended_content_types")
    if not isinstance(content_types, list) or any(
        not isinstance(content_type, str) or content_type not in CONTENT_TYPES
        for content_type in content_types
    ) or len(set(content_types)) != len(content_types):
        raise ValueError("recommended content type is invalid")
    disposition = payload.get("recommended_disposition")
    if disposition not in DISPOSITIONS:
        raise ValueError("recommended disposition is invalid")

    evidence = payload.get("evidence")
    if not isinstance(evidence, list):
        raise ValueError("evidence must be a list")
    for entry in evidence:
        if not isinstance(entry, dict) or not str(entry.get("text") or "").strip():
            raise ValueError("evidence entry is invalid")
        if entry.get("type") not in {"fact", "source_claim", "model_inference"}:
            raise ValueError("evidence type is invalid")
        if "source" in entry and not isinstance(entry["source"], str):
            raise ValueError("evidence source is invalid")

    removed_fields = {
        "comment_angles",
        "recommended_output_types",
        "recommended_action",
        "recommended_publish_account_id",
        "account_scores",
        "key_points",
        "personal_angles",
        "article_outlines",
    }
    if removed_fields.intersection(payload):
        raise ValueError("analysis contains removed comment or account fields")
    return payload


async def _source_snapshot(
    db: AsyncSession,
    source_type: str,
    source_id: str,
) -> dict[str, Any]:
    if source_type == "youtube_video":
        video = await db.get(YoutubeVideo, source_id)
        if video is None:
            raise KeyError(f"YouTube video {source_id} not found")
        return {
            "source_url": video.url,
            "source_title": video.title,
            "source_author": video.channel_name,
            "source_published_at": video.published_at,
            "description": video.description,
            "transcript_status": video.transcript_status,
            "transcript_language": video.transcript_language,
            "transcript_content_hash": video.transcript_content_hash,
        }
    if source_type == "x_post":
        post = await db.get(XPost, source_id)
        if post is None:
            raise KeyError(f"X post {source_id} not found")
        return {
            "source_url": post.url,
            "source_title": post.content[:500],
            "source_author": post.username,
            "source_published_at": post.published_at,
            "content": post.content,
            "raw_markdown": post.raw_markdown,
        }
    raise ValueError(f"unsupported source type: {source_type}")


async def ensure_response_item(
    db: AsyncSession,
    source_type: str,
    source_id: str,
    subscription_id: int | None = None,
) -> tuple[ContentResponseItem, bool]:
    item = (await db.execute(
        select(ContentResponseItem).where(
            ContentResponseItem.source_type == source_type,
            ContentResponseItem.source_id == source_id,
        )
    )).scalar_one_or_none()
    if item is not None:
        if subscription_id is not None and item.subscription_id is None:
            item.subscription_id = subscription_id
            await db.flush()
        return item, False
    snapshot = await _source_snapshot(db, source_type, source_id)
    item = ContentResponseItem(
        source_type=source_type,
        source_id=source_id,
        source_url=snapshot["source_url"],
        source_title=snapshot["source_title"],
        source_author=snapshot["source_author"],
        source_published_at=snapshot["source_published_at"],
        subscription_id=subscription_id,
    )
    db.add(item)
    await db.flush()
    db.add(ContentResponseEvent(
        response_item_id=item.id,
        event_type="created",
        payload={"source_type": source_type, "source_id": source_id},
    ))
    return item, True


async def create_analysis_run(
    db: AsyncSession,
    item: ContentResponseItem,
    *,
    force: bool = False,
) -> tuple[ContentAnalysisRun, ContentJob, bool]:
    active = (await db.execute(
        select(ContentAnalysisRun, ContentJob)
        .join(ContentJob, ContentJob.id == ContentAnalysisRun.job_id)
        .where(ContentAnalysisRun.response_item_id == item.id)
        .where(ContentAnalysisRun.status.in_({"queued", "running"}))
        .order_by(ContentAnalysisRun.version.desc())
    )).first()
    if active is not None and not force:
        return active[0], active[1], False
    version = int((await db.scalar(
        select(func.coalesce(func.max(ContentAnalysisRun.version), 0))
        .where(ContentAnalysisRun.response_item_id == item.id)
    )) or 0) + 1
    run = ContentAnalysisRun(
        response_item_id=item.id,
        version=version,
        status="queued",
    )
    db.add(run)
    await db.flush()
    job = await create_job(
        db,
        flow="content_response_analysis",
        title=f"分析：{item.source_title[:100] or item.source_id}",
        input_data={"response_item_id": item.id, "analysis_run_id": run.id},
        idempotency_key=f"content-response-analysis:{item.id}:{version}",
        commit=False,
    )
    run.job_id = job.id
    item.workflow_status = "queued"
    db.add(ContentResponseEvent(
        response_item_id=item.id,
        analysis_run_id=run.id,
        event_type="analysis_queued",
        payload={"job_id": job.id, "version": version},
    ))
    await db.commit()
    await db.refresh(run)
    await db.refresh(job)
    return run, job, True


async def _enqueue_analysis_job_once(
    db: AsyncSession,
    job: ContentJob,
    *,
    enqueue: Callable[[int], Awaitable[None]] | None = None,
) -> bool:
    """Enqueue one analysis job once and leave an auditable event marker."""
    from models import ContentJobEvent

    dispatched = (await db.execute(
        select(ContentJobEvent.id)
        .where(ContentJobEvent.job_id == job.id)
        .where(ContentJobEvent.kind == "queue_dispatched")
        .limit(1)
    )).scalar_one_or_none()
    if job.status != "queued" or dispatched is not None:
        return False
    if enqueue is None:
        from job_queue import enqueue_job
        enqueue = enqueue_job
    await enqueue(job.id)
    db.add(ContentJobEvent(job_id=job.id, kind="queue_dispatched"))
    await db.commit()
    return True


async def dispatch_intelligence_posts(
    db: AsyncSession,
    subscription: Any,
    source_ids: list[str],
    *,
    enqueue: Callable[[int], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """Create unified analysis jobs for freshly collected original X posts."""
    result: dict[str, Any] = {"created": 0, "enqueued": 0, "errors": []}
    if (
        not source_ids
        or not subscription.enabled
        or not subscription.intelligence_enabled
        or subscription.intelligence_enabled_at is None
    ):
        return result
    posts = (await db.execute(
        select(XPost).where(XPost.tweet_id.in_(source_ids))
    )).scalars().all()
    for post in posts:
        enabled_at = subscription.intelligence_enabled_at
        collected_at = post.collected_at
        if enabled_at.tzinfo is None:
            enabled_at = enabled_at.replace(tzinfo=timezone.utc)
        if collected_at.tzinfo is None:
            collected_at = collected_at.replace(tzinfo=timezone.utc)
        if post.is_reply or collected_at < enabled_at:
            continue
        try:
            item, _ = await ensure_response_item(
                db,
                "x_post",
                post.tweet_id,
                subscription_id=subscription.id,
            )
            current_run = (
                await db.get(ContentAnalysisRun, item.current_analysis_run_id)
                if item.current_analysis_run_id else None
            )
            if current_run is not None and current_run.status == "succeeded":
                continue
            run, job, created = await create_analysis_run(db, item)
            if not created:
                continue
            result["created"] += 1
            if await _enqueue_analysis_job_once(db, job, enqueue=enqueue):
                result["enqueued"] += 1
        except Exception as exc:
            result["errors"].append(f"{post.tweet_id}: {exc}")
    return result


async def persist_analysis(
    db: AsyncSession,
    item_id: int,
    run_id: int,
    payload: dict[str, Any],
    metadata: dict[str, Any] | None = None,
) -> ContentAnalysisRun:
    data = validate_analysis_payload(payload)
    item = await db.get(ContentResponseItem, item_id)
    run = await db.get(ContentAnalysisRun, run_id)
    if item is None or run is None or run.response_item_id != item.id:
        raise KeyError("response item or analysis run not found")
    for field in (
        "content_value_score",
        "value_dimensions",
        "summary_cn",
        "core_thesis",
        "value_points",
        "evidence",
        "risks",
        "verification_items",
        "recommended_content_types",
        "recommended_disposition",
        "recommendation_reason",
        "suggested_title",
        "suggested_angle",
        "target_reader",
        "suggested_structure",
    ):
        setattr(run, field, data.get(field, getattr(run, field)))
    if not item.content_types:
        item.content_types = list(data["recommended_content_types"])
    meta = metadata or {}
    for field in ("source_content_hash", "source_snapshot", "model_provider", "model_name", "prompt_version", "policy_version"):
        if field in meta:
            setattr(run, field, meta[field])
    run.status = "succeeded"
    run.completed_at = now_utc()
    run.error_code = ""
    run.error = ""
    item.current_analysis_run_id = run.id
    item.workflow_status = "ready"
    db.add(ContentResponseEvent(
        response_item_id=item.id,
        analysis_run_id=run.id,
        event_type="analysis_succeeded",
        payload={"score": run.content_value_score},
    ))
    await db.commit()
    await db.refresh(run)
    return run


async def set_decision(
    db: AsyncSession,
    item: ContentResponseItem,
    action: str,
    *,
    feedback_reason: str = "",
) -> ContentResponseItem:
    status_by_action = {
        "not_processed": "not_processed",
        "reset": "pending",
    }
    if action not in status_by_action:
        raise ValueError("invalid response decision")
    item.decision_status = status_by_action[action]
    item.feedback_reason = feedback_reason.strip() if action == "not_valuable" else ""
    item.decided_at = None if action == "reset" else now_utc()
    db.add(ContentResponseEvent(
        response_item_id=item.id,
        analysis_run_id=item.current_analysis_run_id,
        event_type="decision_changed",
        actor="user",
        payload={"action": action, "reason": item.feedback_reason},
    ))
    await db.commit()
    await db.refresh(item)
    return item


async def create_outputs(
    db: AsyncSession,
    item: ContentResponseItem,
    analysis_run_id: int,
    publish_account_id: str | None,
    output_types: list[str],
) -> list[tuple[ContentResponseOutput, ContentJob, bool]]:
    if not output_types or any(output_type not in OUTPUT_TYPES for output_type in output_types):
        raise ValueError("invalid output types")
    locked_item = await db.scalar(
        select(ContentResponseItem)
        .where(ContentResponseItem.id == item.id)
        .with_for_update()
    )
    if locked_item is None:
        raise ValueError("response item not found")
    item = locked_item
    if publish_account_id:
        account = await db.get(PublishAccount, publish_account_id)
        if account is None or not account.is_active:
            raise ValueError("publish account is not active")
    results: list[tuple[ContentResponseOutput, ContentJob, bool]] = []
    for output_type in dict.fromkeys(output_types):
        target = WRITING_TARGETS.get(output_type)
        output_publish_account_id = None if target else publish_account_id
        if target is None:
            output = (await db.execute(
                select(ContentResponseOutput).where(
                    ContentResponseOutput.analysis_run_id == analysis_run_id,
                    ContentResponseOutput.publish_account_id == output_publish_account_id,
                    ContentResponseOutput.output_type == output_type,
                )
            )).scalar_one_or_none()
            if output is not None:
                job = await db.get(ContentJob, output.job_id) if output.job_id else None
                if job is not None:
                    results.append((output, job, False))
                    continue
        output = ContentResponseOutput(
            response_item_id=item.id,
            analysis_run_id=analysis_run_id,
            publish_account_id=output_publish_account_id,
            output_type=output_type,
        )
        db.add(output)
        await db.flush()
        job = await create_job(
            db,
            flow="content_response_output",
            title=f"生成 {target['label'] if target else output_type}：{item.source_title[:80]}",
            input_data={"response_output_id": output.id},
            idempotency_key=f"content-response-output:{output.id}",
            commit=False,
        )
        output.job_id = job.id
        results.append((output, job, True))
    # The user decision is the response-domain value shown by the Intelligence
    # Center.  Keep it aligned with the public status contract; "adopted" was
    # a legacy value that made a queued writing job disappear from the UI.
    item.decision_status = "worth_writing"
    item.selected_publish_account_id = publish_account_id
    item.selected_output_types = list(dict.fromkeys(output_types))
    item.decided_at = now_utc()
    db.add(ContentResponseEvent(
        response_item_id=item.id,
        analysis_run_id=analysis_run_id,
        event_type="outputs_queued",
        actor="user",
        payload={"output_types": item.selected_output_types, "publish_account_id": publish_account_id},
    ))
    await db.commit()
    return results
