"""Domain policy for the source-neutral content response inbox."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from content_jobs import create_job
from models import (
    ContentAccountScore,
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
    "discussion_value",
    "evergreen_value",
}
OUTPUT_TYPES = {
    "expanded_article",
    "commentary",
    "x_share",
    "x_reply",
    "x_quote",
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

    account_scores = payload.get("account_scores", [])
    if not isinstance(account_scores, list):
        raise ValueError("account_scores must be a list")
    account_ids: set[str] = set()
    blocked_ids: set[str] = set()
    for account in account_scores:
        account_id = str(account.get("publish_account_id") or "").strip()
        if not account_id or account_id in account_ids:
            raise ValueError("account_scores contains an invalid or duplicate account")
        account_ids.add(account_id)
        account_score = account.get("score")
        if (
            not isinstance(account_score, int)
            or isinstance(account_score, bool)
            or not 0 <= account_score <= 100
        ):
            raise ValueError("account score must be an integer from 0 to 100")
        if account.get("has_hard_conflict"):
            blocked_ids.add(account_id)
    recommended_id = payload.get("recommended_publish_account_id")
    if recommended_id and recommended_id in blocked_ids:
        raise ValueError("recommended account has a hard conflict")
    if recommended_id and recommended_id not in account_ids:
        raise ValueError("recommended account is missing from account_scores")
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
) -> tuple[ContentResponseItem, bool]:
    item = (await db.execute(
        select(ContentResponseItem).where(
            ContentResponseItem.source_type == source_type,
            ContentResponseItem.source_id == source_id,
        )
    )).scalar_one_or_none()
    if item is not None:
        return item, False
    snapshot = await _source_snapshot(db, source_type, source_id)
    item = ContentResponseItem(
        source_type=source_type,
        source_id=source_id,
        source_url=snapshot["source_url"],
        source_title=snapshot["source_title"],
        source_author=snapshot["source_author"],
        source_published_at=snapshot["source_published_at"],
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
    active_accounts = (await db.execute(
        select(PublishAccount).where(PublishAccount.is_active.is_(True))
    )).scalars().all()
    active_ids = {account.id for account in active_accounts}
    supplied_ids = {
        str(score["publish_account_id"])
        for score in data.get("account_scores", [])
    }
    if supplied_ids != active_ids:
        raise ValueError("account_scores must cover every active publish account")

    await db.execute(delete(ContentAccountScore).where(
        ContentAccountScore.analysis_run_id == run.id
    ))
    accounts = {account.id: account for account in active_accounts}
    for score in data.get("account_scores", []):
        account = accounts[score["publish_account_id"]]
        db.add(ContentAccountScore(
            analysis_run_id=run.id,
            publish_account_id=account.id,
            account_snapshot={
                "name": account.name,
                "platform": account.platform,
                "positioning": account.positioning,
                "audience": account.audience,
                "tone": account.tone,
                "topic_focus": account.topic_focus,
                "taboo": account.taboo,
            },
            score=score["score"],
            rank=score.get("rank", 0),
            fit_reasons=score.get("fit_reasons", []),
            audience_value=score.get("audience_value", ""),
            recommended_tone=score.get("recommended_tone", ""),
            recommended_output_types=score.get("recommended_output_types", []),
            taboo_risks=score.get("taboo_risks", []),
            has_hard_conflict=bool(score.get("has_hard_conflict")),
        ))
    for field in (
        "content_value_score",
        "value_dimensions",
        "summary_cn",
        "core_thesis",
        "key_points",
        "evidence",
        "value_points",
        "risks",
        "verification_items",
        "personal_angles",
        "article_outlines",
        "comment_angles",
        "recommended_output_types",
        "recommended_action",
        "recommendation_reason",
        "recommended_publish_account_id",
    ):
        setattr(run, field, data.get(field, getattr(run, field)))
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
        "adopt": "adopted",
        "later": "later",
        "not_valuable": "rejected",
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
    if publish_account_id:
        account = await db.get(PublishAccount, publish_account_id)
        if account is None or not account.is_active:
            raise ValueError("publish account is not active")
    results: list[tuple[ContentResponseOutput, ContentJob, bool]] = []
    for output_type in dict.fromkeys(output_types):
        output = (await db.execute(
            select(ContentResponseOutput).where(
                ContentResponseOutput.analysis_run_id == analysis_run_id,
                ContentResponseOutput.publish_account_id == publish_account_id,
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
            publish_account_id=publish_account_id,
            output_type=output_type,
        )
        db.add(output)
        await db.flush()
        job = await create_job(
            db,
            flow="content_response_output",
            title=f"生成 {output_type}：{item.source_title[:80]}",
            input_data={"response_output_id": output.id},
            idempotency_key=f"content-response-output:{output.id}",
            commit=False,
        )
        output.job_id = job.id
        results.append((output, job, True))
    item.decision_status = "adopted"
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
