"""Compatibility creation endpoints backed by durable content jobs."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from content_jobs import create_job
from database import SessionLocal
from job_queue import enqueue_job
from models import ArticleDraft, PublishAccount

router = APIRouter(prefix="/studio", tags=["studio"])
_CONTENT_CAP = 30_000


class EnqueueOut(BaseModel):
    content_job_id: int
    task_id: str
    task_ids: list[str] = []
    pipeline_task_id: int = 0


def _account_profile_full(account: PublishAccount) -> dict:
    return {
        "id": account.id, "name": account.name, "platform": account.platform,
        "positioning": account.positioning, "audience": account.audience,
        "tone": account.tone, "topic_focus": account.topic_focus or [],
        "taboo": account.taboo or [], "word_range": account.word_range or {},
        "image_style": account.image_style, "cover_style": account.cover_style or {},
        "voice_samples": account.voice_samples or [], "style_rules": account.style_rules or [],
    }


async def _run_pipeline_chain(flow: str, ctx: dict, *, account_id: str, title: str, source_url: str = "") -> EnqueueOut:
    """Legacy name retained for callers; creates one persistent job, not a task graph."""
    payload = {**ctx, "account_id": account_id, "source_url": source_url}
    async with SessionLocal() as db:
        job = await create_job(db, flow=flow, title=title, input_data=payload)
    await enqueue_job(job.id)
    return EnqueueOut(content_job_id=job.id, task_id=str(job.id), task_ids=[str(job.id)], pipeline_task_id=job.id)


async def _account(account_id: str) -> PublishAccount:
    async with SessionLocal() as db:
        account = await db.get(PublishAccount, account_id)
    if account is None:
        raise HTTPException(400, f"account '{account_id}' not found")
    return account


class EnqueueIn(BaseModel):
    account_id: str
    title: str
    source_url: str
    platform: str = ""
    summary: str = ""
    note: str = ""
    content: str = ""


@router.post("/enqueue", response_model=EnqueueOut, status_code=201)
async def enqueue_scout_task(payload: EnqueueIn):
    if not payload.account_id.strip() or not payload.title.strip() or not payload.source_url.strip():
        raise HTTPException(400, "account_id, title and source_url are required")
    account = await _account(payload.account_id)
    content = payload.content.strip()[:_CONTENT_CAP]
    return await _run_pipeline_chain("draft", {
        "account_profile": _account_profile_full(account), "platform": payload.platform,
        "summary": payload.summary, "content": content, "note": payload.note,
    }, account_id=account.id, title=payload.title.strip(), source_url=payload.source_url.strip())


class ManualEnqueueIn(BaseModel):
    account_id: str
    title: str
    idea: str = ""
    genre: str = "commentary"
    note: str = ""


@router.post("/enqueue-manual", response_model=EnqueueOut, status_code=201)
async def enqueue_manual_task(payload: ManualEnqueueIn):
    if not payload.account_id.strip() or not payload.title.strip():
        raise HTTPException(400, "account_id and title are required")
    account = await _account(payload.account_id)
    return await _run_pipeline_chain("draft", {
        "account_profile": _account_profile_full(account), "idea": payload.idea.strip()[:_CONTENT_CAP],
        "genre": payload.genre, "note": payload.note.strip(),
    }, account_id=account.id, title=payload.title.strip())


class DraftJobIn(BaseModel):
    draft_id: int
    account_id: str = ""
    note: str = ""
    cover_style: dict = {}
    image_style: str = ""
    max_images: int = 1


async def _draft_job(payload: DraftJobIn, flow: str) -> EnqueueOut:
    if payload.draft_id <= 0:
        raise HTTPException(400, "draft_id is required")
    async with SessionLocal() as db:
        draft = await db.get(ArticleDraft, payload.draft_id)
    if draft is None:
        raise HTTPException(404, "draft not found")
    return await _run_pipeline_chain(flow, {
        "draft_id": draft.id, "note": payload.note, "cover_style": payload.cover_style,
        "image_style": payload.image_style, "max_images": max(1, min(payload.max_images, 4)),
    },
                                     account_id=payload.account_id, title=draft.title or f"draft #{draft.id}")


@router.post("/regenerate-cover", response_model=EnqueueOut, status_code=201)
async def regenerate_cover(payload: DraftJobIn):
    return await _draft_job(payload, "cover")


@router.post("/illustrate-body", response_model=EnqueueOut, status_code=201)
async def illustrate_body(payload: DraftJobIn):
    return await _draft_job(payload, "illustrations")


@router.post("/rewrite-draft", response_model=EnqueueOut, status_code=201)
async def rewrite_draft(payload: DraftJobIn):
    return await _draft_job(payload, "draft")
