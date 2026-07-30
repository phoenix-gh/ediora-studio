"""Durable launch boundary for local Remotion text-video renders."""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from content_jobs import create_or_get_job
from models import ContentJob, TextVideoProject
from text_video_domain import (
    empty_render_state,
    render_source_hash,
    video_stage_ready,
)
from text_video_scene_plan import validate_render_input_projection
from text_video_templates import get_text_video_template


ACTIVE_JOB_STATUSES = {"queued", "running"}


@dataclass(frozen=True)
class RenderLaunchResult:
    jobs: list[ContentJob]
    project: TextVideoProject
    should_enqueue: bool


def render_state_document(project: TextVideoProject) -> dict:
    return empty_render_state() | (
        project.render_state
        if isinstance(project.render_state, dict)
        else {}
    )


async def launch_text_video_render(
    db: AsyncSession,
    project_id: int,
    *,
    revision: int,
) -> RenderLaunchResult:
    project = await db.scalar(
        select(TextVideoProject)
        .where(TextVideoProject.id == project_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if project is None:
        raise LookupError("文字视频作品不存在")
    if project.revision != revision:
        raise RuntimeError("作品已在其他页面更新")
    if not video_stage_ready(project):
        raise ValueError("当前主音频、成片时间轴或分镜尚未准备完成")

    state = render_state_document(project)
    current_job_id = state.get("job_id")
    current_job = (
        await db.get(ContentJob, current_job_id)
        if (
            isinstance(current_job_id, int)
            and not isinstance(current_job_id, bool)
        )
        else None
    )
    if (
        state["status"] in {"queued", "rendering"}
        and current_job is not None
        and current_job.flow == "text_video_render"
        and current_job.status in ACTIVE_JOB_STATUSES
    ):
        return RenderLaunchResult(
            jobs=[current_job],
            project=project,
            should_enqueue=False,
        )

    master = project.master_audio or {}
    render_input = validate_render_input_projection(
        deepcopy(project.render_input or {}),
        master_duration=master.get("duration"),
    )
    manifest = get_text_video_template(
        render_input["templateId"],
        render_input["templateVersion"],
    )
    source_hash = render_source_hash(render_input)
    generation = int(state.get("generation") or 0) + 1
    idempotency_key = (
        f"text-video-render:{project.id}:{generation}:{source_hash}"
    )
    snapshot = {
        "project_id": project.id,
        "project_revision": project.revision,
        "render_generation": generation,
        "source_hash": source_hash,
        "composition_id": manifest["composition_id"],
        "render_input": render_input,
        "idempotency_key": idempotency_key,
    }
    job = await create_or_get_job(
        db,
        flow="text_video_render",
        title=f"渲染文字视频 · {project.title}",
        input_data=snapshot,
        idempotency_key=idempotency_key,
        commit=False,
    )
    project.render_state = {
        **state,
        "status": "queued",
        "generation": generation,
        "source_hash": source_hash,
        "job_id": job.id,
        "applied_job_id": None,
        "progress": 0,
        "error": "",
    }
    await db.commit()
    await db.refresh(project)
    await db.refresh(job)
    return RenderLaunchResult(
        jobs=[job],
        project=project,
        should_enqueue=job.status == "queued",
    )
