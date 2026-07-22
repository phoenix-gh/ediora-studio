"""Create durable content jobs for legacy entry points."""
from __future__ import annotations

from content_jobs import create_job
from database import SessionLocal
from job_queue import enqueue_job


class JobDispatchError(RuntimeError):
    pass


class JobDispatcher:
    async def create(self, *, title: str, input_data: dict, flow: str = "draft") -> str:
        async with SessionLocal() as db:
            job = await create_job(db, flow=flow, title=title, input_data=input_data)
        await enqueue_job(job.id)
        return str(job.id)
