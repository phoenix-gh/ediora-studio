"""Unified response inbox and trusted worker endpoints."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import String, desc, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from content_response_service import (
    CONTENT_TYPES,
    DRAFT_OUTPUT_TYPES,
    create_analysis_run,
    create_outputs,
    persist_analysis,
    set_decision,
)
from content_response_handoff import (
    DestinationConflictError,
    SourceUnavailableError,
    StaleAnalysisError,
    create_or_get_destination,
    get_response_source,
)
from database import get_db
from job_queue import enqueue_job
from models import (
    ArticleDraft,
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
from worker_auth import require_worker_token


router = APIRouter(prefix="/responses", tags=["responses"])


class AnalyzeIn(BaseModel):
    force: bool = False


class DecisionIn(BaseModel):
    action: Literal["not_processed", "reset"]
    reason: str = Field(default="", max_length=1000)


class ClassificationIn(BaseModel):
    content_types: list[str] = Field(default_factory=list, max_length=5)


class DestinationIn(BaseModel):
    destination: Literal["creative_asset"]
    analysis_run_id: int
    directory: str | None = None


class OutputsIn(BaseModel):
    analysis_run_id: int
    publish_account_id: str | None = None
    output_types: list[str] = Field(min_length=1, max_length=5)


class WorkerAnalysisIn(BaseModel):
    analysis: dict
    metadata: dict = Field(default_factory=dict)


class WorkerOutputResultIn(BaseModel):
    title: str = ""
    content: str = Field(min_length=1)
    source_attribution: dict = Field(default_factory=dict)


class WorkerLinkIn(BaseModel):
    article_draft_id: int = Field(gt=0)


def _analysis_payload(run: ContentAnalysisRun | None) -> dict | None:
    if run is None:
        return None
    return {
        "id": run.id,
        "version": run.version,
        "status": run.status,
        "job_id": run.job_id,
        "content_value_score": run.content_value_score,
        "value_dimensions": run.value_dimensions,
        "summary_cn": run.summary_cn,
        "core_thesis": run.core_thesis,
        "suggested_title": run.suggested_title,
        "suggested_angle": run.suggested_angle,
        "target_reader": run.target_reader,
        "suggested_structure": run.suggested_structure,
        "value_points": run.value_points,
        "evidence": run.evidence,
        "risks": run.risks,
        "verification_items": run.verification_items,
        "recommended_content_types": run.recommended_content_types,
        "recommended_disposition": run.recommended_disposition,
        "recommendation_reason": run.recommendation_reason,
        "model_provider": run.model_provider,
        "model_name": run.model_name,
        "prompt_version": run.prompt_version,
        "policy_version": run.policy_version,
        "error_code": run.error_code,
        "error": run.error,
        "created_at": run.created_at,
        "completed_at": run.completed_at,
    }


def _item_payload(
    item: ContentResponseItem,
    run: ContentAnalysisRun | None = None,
    *,
    job: ContentJob | None = None,
) -> dict:
    return {
        "id": item.id,
        "source_type": item.source_type,
        "source_id": item.source_id,
        "source_url": item.source_url,
        "source_title": item.source_title,
        "source_author": item.source_author,
        "source_published_at": item.source_published_at,
        "subscription_id": item.subscription_id,
        "workflow_status": item.workflow_status,
        "decision_status": item.decision_status,
        "content_types": item.content_types,
        "destination": None if not item.destination_type else {
            "type": item.destination_type,
            "id": item.destination_id,
            "url": (
                f"/drafts?draft={item.destination_id}"
                if item.destination_type == "draft"
                else f"/assets?selected={item.destination_id}"
            ),
        },
        "current_analysis_run_id": item.current_analysis_run_id,
        "selected_publish_account_id": item.selected_publish_account_id,
        "selected_output_types": item.selected_output_types,
        "feedback_reason": item.feedback_reason,
        "decided_at": item.decided_at,
        "created_at": item.created_at,
        "updated_at": item.updated_at,
        "analysis": _analysis_payload(run),
        "job": None if job is None else {
            "id": job.id,
            "status": job.status,
            "flow": job.flow,
        },
    }


async def _item_with_run(db: AsyncSession, item_id: int):
    row = (await db.execute(
        select(ContentResponseItem, ContentAnalysisRun, ContentJob)
        .outerjoin(
            ContentAnalysisRun,
            ContentAnalysisRun.id == ContentResponseItem.current_analysis_run_id,
        )
        .outerjoin(ContentJob, ContentJob.id == ContentAnalysisRun.job_id)
        .where(ContentResponseItem.id == item_id)
    )).first()
    if row is None:
        raise HTTPException(404, "response item not found")
    return row


async def _item_with_job_run(
    db: AsyncSession,
    item_id: int,
    job_id: int,
):
    row = (await db.execute(
        select(ContentResponseItem, ContentAnalysisRun, ContentJob)
        .join(
            ContentAnalysisRun,
            ContentAnalysisRun.response_item_id == ContentResponseItem.id,
        )
        .join(ContentJob, ContentJob.id == ContentAnalysisRun.job_id)
        .where(ContentResponseItem.id == item_id)
        .where(ContentJob.id == job_id)
    )).first()
    if row is not None:
        return row
    if await db.get(ContentResponseItem, item_id) is None:
        raise HTTPException(404, "response item not found")
    raise HTTPException(409, "analysis run is missing for this job")


@router.get("")
async def list_responses(
    source_type: str | None = None,
    decision_status: str | None = None,
    workflow_status: str | None = None,
    content_type: str | None = None,
    min_score: int | None = Query(default=None, ge=0, le=100),
    days: int = Query(default=3, ge=0, le=3650),
    search: str = "",
    sort: Literal["score", "newest"] = "score",
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=30, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
):
    query = (
        select(ContentResponseItem, ContentAnalysisRun, ContentJob)
        .outerjoin(
            ContentAnalysisRun,
            ContentAnalysisRun.id == ContentResponseItem.current_analysis_run_id,
        )
        .outerjoin(ContentJob, ContentJob.id == ContentAnalysisRun.job_id)
    )
    if source_type:
        query = query.where(ContentResponseItem.source_type == source_type)
    if decision_status:
        query = query.where(ContentResponseItem.decision_status == decision_status)
    if workflow_status:
        query = query.where(ContentResponseItem.workflow_status == workflow_status)
    if min_score is not None:
        query = query.where(ContentAnalysisRun.content_value_score >= min_score)
    if days:
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        query = query.where(
            func.coalesce(
                ContentResponseItem.source_published_at,
                ContentResponseItem.created_at,
            ) >= cutoff
        )
    if content_type:
        if content_type not in CONTENT_TYPES:
            raise HTTPException(422, "invalid content type")
        query = query.where(
            func.cast(ContentResponseItem.content_types, String).like(
                f'%"{content_type}"%'
            )
        )
    if search.strip():
        pattern = f"%{search.strip()}%"
        query = query.where(or_(
            ContentResponseItem.source_title.ilike(pattern),
            ContentResponseItem.source_author.ilike(pattern),
        ))
    order = {
        "score": (
            desc(ContentAnalysisRun.content_value_score),
            desc(ContentResponseItem.source_published_at),
            desc(ContentResponseItem.id),
        ),
        "newest": (desc(ContentResponseItem.source_published_at), desc(ContentResponseItem.id)),
    }[sort]
    filtered = query.order_by(*order)
    rows = (await db.execute(
        filtered.offset((page - 1) * page_size).limit(page_size)
    )).all()
    filtered_subquery = query.order_by(None).subquery()
    total = int((await db.scalar(
        select(func.count()).select_from(filtered_subquery)
    )) or 0)
    count_rows = (await db.execute(
        select(
            filtered_subquery.c.decision_status,
            func.count().label("count"),
        )
        .group_by(filtered_subquery.c.decision_status)
    )).all()
    counts = {
        "all": total,
        "pending": 0,
        "worth_writing": 0,
        "creative_asset": 0,
        "not_processed": 0,
    }
    counts.update({status: int(count) for status, count in count_rows})
    return {
        "items": [_item_payload(item, run, job=job) for item, run, job in rows],
        "counts": counts,
        "page": page,
        "page_size": page_size,
        "total": total,
    }


@router.get("/outputs/{output_id}/worker-context", dependencies=[Depends(require_worker_token)])
async def output_worker_context(output_id: int, db: AsyncSession = Depends(get_db)):
    output = await db.get(ContentResponseOutput, output_id)
    if output is None:
        raise HTTPException(404, "response output not found")
    item = await db.get(ContentResponseItem, output.response_item_id)
    run = await db.get(ContentAnalysisRun, output.analysis_run_id)
    account = await db.get(PublishAccount, output.publish_account_id) if output.publish_account_id else None
    if item is None or run is None:
        raise HTTPException(409, "response output context is incomplete")
    if item.source_type == "youtube_video":
        video = await db.get(YoutubeVideo, item.source_id)
        source = None if video is None else {
            "title": video.title,
            "url": video.url,
            "description": video.description,
            "transcript_language": video.transcript_language,
            "transcript_text": video.transcript_text,
        }
    else:
        post = await db.get(XPost, item.source_id)
        source = None if post is None else {
            "title": post.content[:500],
            "url": post.url,
            "content": post.content,
            "raw_markdown": post.raw_markdown,
        }
    return {
        "output": {
            "id": output.id,
            "output_type": output.output_type,
            "status": output.status,
        },
        "item": _item_payload(item, run),
        "source": source,
        "account": None if account is None else {
            "id": account.id,
            "name": account.name,
            "platform": account.platform,
            "positioning": account.positioning,
            "audience": account.audience,
            "tone": account.tone,
            "topic_focus": account.topic_focus,
            "taboo": account.taboo,
            "style_rules": account.style_rules,
        },
    }


@router.post("/outputs/{output_id}/worker-result", dependencies=[Depends(require_worker_token)])
async def output_worker_result(
    output_id: int,
    body: WorkerOutputResultIn,
    db: AsyncSession = Depends(get_db),
):
    output = await db.scalar(
        select(ContentResponseOutput)
        .where(ContentResponseOutput.id == output_id)
        .with_for_update()
    )
    if output is None:
        raise HTTPException(404, "response output not found")
    item = await db.get(ContentResponseItem, output.response_item_id)
    if item is None:
        raise HTTPException(409, "response output item is missing")
    if output.status == "draft_ready":
        if output.article_draft_id and item.destination_type is None:
            item.destination_type = "draft"
            item.destination_id = output.article_draft_id
            db.add(ContentResponseEvent(
                response_item_id=item.id,
                analysis_run_id=output.analysis_run_id,
                event_type="destination_created",
                actor="worker",
                payload={
                    "destination": "draft",
                    "destination_id": output.article_draft_id,
                    "output_id": output.id,
                },
            ))
            await db.commit()
        return {"id": output.id, "status": output.status, "article_draft_id": output.article_draft_id}
    expected_draft_type = DRAFT_OUTPUT_TYPES.get(output.output_type)
    if expected_draft_type is not None:
        draft = ArticleDraft(
            topic_id=f"response:{output.response_item_id}",
            title=body.title,
            content=body.content,
            draft_type=expected_draft_type,
            sources=[body.source_attribution],
        )
        db.add(draft)
        await db.flush()
        output.article_draft_id = draft.id
    else:
        output.content = body.content
    output.source_attribution = body.source_attribution
    output.status = "draft_ready"
    output.error_code = ""
    output.error = ""
    if output.article_draft_id is not None and item.destination_type is None:
        item.destination_type = "draft"
        item.destination_id = output.article_draft_id
        db.add(ContentResponseEvent(
            response_item_id=item.id,
            analysis_run_id=output.analysis_run_id,
            event_type="destination_created",
            actor="worker",
            payload={
                "destination": "draft",
                "destination_id": output.article_draft_id,
                "output_id": output.id,
            },
        ))
    await db.commit()
    return {"id": output.id, "status": output.status, "article_draft_id": output.article_draft_id}


@router.post("/outputs/{output_id}/worker-link", dependencies=[Depends(require_worker_token)])
async def output_worker_link(
    output_id: int,
    body: WorkerLinkIn,
    db: AsyncSession = Depends(get_db),
):
    output = await db.scalar(
        select(ContentResponseOutput)
        .where(ContentResponseOutput.id == output_id)
        .with_for_update()
    )
    if output is None:
        raise HTTPException(404, "response output not found")
    expected_draft_type = DRAFT_OUTPUT_TYPES.get(output.output_type)
    if expected_draft_type is None:
        raise HTTPException(422, "worker link requires a draft output")

    item = await db.get(ContentResponseItem, output.response_item_id)
    if item is None:
        raise HTTPException(409, "response output item is missing")
    draft = await db.get(ArticleDraft, body.article_draft_id)
    if draft is None:
        raise HTTPException(404, "article draft not found")
    if draft.topic_id != f"response:{item.id}":
        raise HTTPException(409, "article draft topic_id does not belong to this response item")
    if draft.draft_type != expected_draft_type:
        raise HTTPException(
            422,
            f"worker link requires draft_type={expected_draft_type}",
        )
    if not draft.content.strip():
        raise HTTPException(422, "article draft content is empty")
    if output.status == "draft_ready":
        if output.article_draft_id != draft.id:
            raise HTTPException(409, "response output is already linked to another draft")
        if item.destination_type is None:
            item.destination_type = "draft"
            item.destination_id = draft.id
            db.add(ContentResponseEvent(
                response_item_id=item.id,
                analysis_run_id=output.analysis_run_id,
                event_type="destination_created",
                actor="worker",
                payload={
                    "destination": "draft",
                    "destination_id": draft.id,
                    "output_id": output.id,
                },
            ))
            await db.commit()
        return {"id": output.id, "status": output.status, "article_draft_id": draft.id}

    source_attribution = {
        "url": item.source_url or "",
        "title": item.source_title or "",
    }
    sources = list(draft.sources or [])
    if source_attribution not in sources:
        sources.append(source_attribution)
    draft.sources = sources
    output.article_draft_id = draft.id
    output.source_attribution = source_attribution
    output.status = "draft_ready"
    output.error_code = ""
    output.error = ""
    if item.destination_type is None:
        item.destination_type = "draft"
        item.destination_id = draft.id
        db.add(ContentResponseEvent(
            response_item_id=item.id,
            analysis_run_id=output.analysis_run_id,
            event_type="destination_created",
            actor="worker",
            payload={
                "destination": "draft",
                "destination_id": draft.id,
                "output_id": output.id,
            },
        ))
    await db.commit()
    return {"id": output.id, "status": output.status, "article_draft_id": draft.id}


@router.get("/{item_id}")
async def get_response(item_id: int, db: AsyncSession = Depends(get_db)):
    item, run, job = await _item_with_run(db, item_id)
    scores = (await db.execute(
        select(ContentAccountScore)
        .where(ContentAccountScore.analysis_run_id == item.current_analysis_run_id)
        .order_by(ContentAccountScore.rank, desc(ContentAccountScore.score))
    )).scalars().all() if item.current_analysis_run_id else []
    outputs = (await db.execute(
        select(ContentResponseOutput, ContentJob)
        .outerjoin(ContentJob, ContentJob.id == ContentResponseOutput.job_id)
        .where(ContentResponseOutput.response_item_id == item.id)
        .order_by(desc(ContentResponseOutput.created_at))
    )).all()
    payload = _item_payload(item, run, job=job)
    payload["account_scores"] = [{
        "publish_account_id": score.publish_account_id,
        "account_snapshot": score.account_snapshot,
        "score": score.score,
        "rank": score.rank,
        "fit_reasons": score.fit_reasons,
        "audience_value": score.audience_value,
        "recommended_tone": score.recommended_tone,
        "recommended_output_types": score.recommended_output_types,
        "taboo_risks": score.taboo_risks,
        "has_hard_conflict": score.has_hard_conflict,
    } for score in scores]
    payload["outputs"] = [{
        "id": output.id,
        "output_type": output.output_type,
        "status": output.status,
        "job_id": output.job_id,
        "job_status": output_job.status if output_job is not None else None,
        "article_draft_id": output.article_draft_id,
        "content": output.content,
        "error_code": output.error_code,
        "error": output.error,
    } for output, output_job in outputs]
    source = await get_response_source(db, item)
    source.pop("body", None)
    payload["source"] = source
    return payload


@router.post("/{item_id}/analyze")
async def analyze_response(
    item_id: int,
    body: AnalyzeIn = AnalyzeIn(),
    db: AsyncSession = Depends(get_db),
):
    item = await db.get(ContentResponseItem, item_id)
    if item is None:
        raise HTTPException(404, "response item not found")
    run, job, created = await create_analysis_run(db, item, force=body.force)
    if created:
        await enqueue_job(job.id)
    return {"response_item_id": item.id, "analysis_run_id": run.id, "job_id": job.id, "created": created}


@router.post("/{item_id}/retry")
async def retry_response(item_id: int, db: AsyncSession = Depends(get_db)):
    item = await db.get(ContentResponseItem, item_id)
    if item is None:
        raise HTTPException(404, "response item not found")
    run, job, created = await create_analysis_run(db, item, force=True)
    await enqueue_job(job.id)
    return {"response_item_id": item.id, "analysis_run_id": run.id, "job_id": job.id, "created": created}


@router.post("/{item_id}/decision")
async def decide_response(
    item_id: int,
    body: DecisionIn,
    db: AsyncSession = Depends(get_db),
):
    item = await db.get(ContentResponseItem, item_id)
    if item is None:
        raise HTTPException(404, "response item not found")
    try:
        return _item_payload(await set_decision(db, item, body.action, feedback_reason=body.reason))
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/{item_id}/classification")
async def classify_response(
    item_id: int,
    body: ClassificationIn,
    db: AsyncSession = Depends(get_db),
):
    if any(content_type not in CONTENT_TYPES for content_type in body.content_types):
        raise HTTPException(422, "invalid content type")
    if len(set(body.content_types)) != len(body.content_types):
        raise HTTPException(422, "duplicate content type")
    item = await db.get(ContentResponseItem, item_id)
    if item is None:
        raise HTTPException(404, "response item not found")
    item.content_types = list(body.content_types)
    db.add(ContentResponseEvent(
        response_item_id=item.id,
        analysis_run_id=item.current_analysis_run_id,
        event_type="classification_changed",
        actor="user",
        payload={"content_types": item.content_types},
    ))
    await db.commit()
    await db.refresh(item)
    return _item_payload(item)


@router.post("/{item_id}/destination")
async def create_response_destination(
    item_id: int,
    body: DestinationIn,
    db: AsyncSession = Depends(get_db),
):
    item, run, _job = await _item_with_run(db, item_id)
    if run is None or run.id != body.analysis_run_id:
        raise HTTPException(409, "analysis run is stale")
    try:
        return await create_or_get_destination(
            db,
            item=item,
            run=run,
            destination=body.destination,
            directory=body.directory,
        )
    except StaleAnalysisError as exc:
        raise HTTPException(409, str(exc)) from exc
    except DestinationConflictError as exc:
        raise HTTPException(409, str(exc)) from exc
    except SourceUnavailableError as exc:
        raise HTTPException(422, str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/{item_id}/outputs")
async def post_outputs(
    item_id: int,
    body: OutputsIn,
    db: AsyncSession = Depends(get_db),
):
    item = await db.get(ContentResponseItem, item_id)
    if item is None:
        raise HTTPException(404, "response item not found")
    if item.current_analysis_run_id != body.analysis_run_id:
        raise HTTPException(409, "analysis run is not selected")
    try:
        outputs = await create_outputs(
            db,
            item,
            body.analysis_run_id,
            body.publish_account_id,
            body.output_types,
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    for _, job, created in outputs:
        if created:
            await enqueue_job(job.id)
    return {"outputs": [
        {
            "id": output.id,
            "output_type": output.output_type,
            "status": output.status,
            "job_id": job.id,
            "job_status": job.status,
            "created": created,
        }
        for output, job, created in outputs
    ]}


@router.get("/{item_id}/events")
async def get_events(item_id: int, db: AsyncSession = Depends(get_db)):
    events = (await db.execute(
        select(ContentResponseEvent)
        .where(ContentResponseEvent.response_item_id == item_id)
        .order_by(desc(ContentResponseEvent.created_at))
    )).scalars().all()
    return {"items": [{
        "id": event.id,
        "analysis_run_id": event.analysis_run_id,
        "event_type": event.event_type,
        "actor": event.actor,
        "payload": event.payload,
        "created_at": event.created_at,
    } for event in events]}


@router.get("/{item_id}/analyses")
async def get_analyses(item_id: int, db: AsyncSession = Depends(get_db)):
    runs = (await db.execute(
        select(ContentAnalysisRun)
        .where(ContentAnalysisRun.response_item_id == item_id)
        .order_by(desc(ContentAnalysisRun.version))
    )).scalars().all()
    return {"items": [_analysis_payload(run) for run in runs]}


@router.post("/{item_id}/analyses/{analysis_id}/select")
async def select_analysis(
    item_id: int,
    analysis_id: int,
    db: AsyncSession = Depends(get_db),
):
    item = await db.get(ContentResponseItem, item_id)
    run = await db.get(ContentAnalysisRun, analysis_id)
    if item is None or run is None or run.response_item_id != item.id:
        raise HTTPException(404, "analysis not found")
    item.current_analysis_run_id = run.id
    db.add(ContentResponseEvent(
        response_item_id=item.id,
        analysis_run_id=run.id,
        event_type="analysis_selected",
        actor="user",
    ))
    await db.commit()
    return _item_payload(item, run)


@router.get("/{item_id}/worker-context", dependencies=[Depends(require_worker_token)])
async def worker_context(
    item_id: int,
    worker_job_id: int = Header(alias="X-Content-Job-Id"),
    db: AsyncSession = Depends(get_db),
):
    item, run, job = await _item_with_job_run(db, item_id, worker_job_id)
    source = await get_response_source(db, item)
    return {
        "item": _item_payload(item, run, job=job),
        "source": source,
    }


@router.post("/{item_id}/worker-analysis", dependencies=[Depends(require_worker_token)])
async def worker_analysis(
    item_id: int,
    body: WorkerAnalysisIn,
    db: AsyncSession = Depends(get_db),
):
    run_id = body.metadata.get("analysis_run_id")
    if not isinstance(run_id, int):
        raise HTTPException(422, "analysis_run_id is required")
    try:
        run = await persist_analysis(db, item_id, run_id, body.analysis, body.metadata)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return _analysis_payload(run)
