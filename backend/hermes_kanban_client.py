"""Temporary compatibility facade for legacy dispatch callers.

It intentionally has no CLI, profile, filesystem, or Kanban dependency.
"""
from __future__ import annotations

from content_jobs import create_job
from database import SessionLocal
from job_queue import enqueue_job


class HermesKanbanError(RuntimeError):
    pass


class HermesKanbanClient:
    async def create_task(self, *, title: str, body: str, assignee: str = "", parents=None) -> str:
        async with SessionLocal() as db:
            job = await create_job(db, flow="draft", title=title, input_data={"legacy_body": body, "legacy_role": assignee})
        await enqueue_job(job.id)
        return str(job.id)

    async def list_tasks(self, include_archived: bool = True) -> list[dict]:
        return []

    async def get_task(self, task_id: str) -> dict:
        raise HermesKanbanError("legacy task details are unavailable; use /api/jobs")

    async def get_log(self, task_id: str, tail_bytes=None) -> dict:
        return {"log": ""}

    async def add_comment(self, *args, **kwargs) -> None:
        return None

    async def add_link(self, *args, **kwargs) -> None:
        return None

    async def archive_task(self, *args, **kwargs) -> None:
        return None

    async def unblock_task(self, *args, **kwargs) -> None:
        return None

    async def complete_task(self, *args, **kwargs) -> None:
        return None


def get_client() -> HermesKanbanClient:
    return HermesKanbanClient()


async def shutdown_client() -> None:
    return None
