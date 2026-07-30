"""Worker entry point for durable content jobs."""

from __future__ import annotations

import asyncio
from collections.abc import Callable

import content_flows
from content_jobs import fail_step, start_step, succeed_job, succeed_step
from database import SessionLocal
from job_queue import RedisJobQueue
from models import ContentJob


async def run_job(job_id: int, *, session_factory: Callable = SessionLocal) -> None:
    async with session_factory() as session:
        job = await session.get(ContentJob, job_id)
        if job is None or job.status == "cancelled":
            return
        for step_key in content_flows.steps_for_flow(job.flow):
            step = await start_step(session, job.id, step_key)
            runner = getattr(content_flows, f"run_{step_key}")
            try:
                output = await runner(job, step)
            except Exception as exc:
                await fail_step(session, step.id, str(exc), retryable=True)
                return
            await succeed_step(session, step.id, output)
        await succeed_job(session, job.id)


def main() -> None:
    async def listen() -> None:
        async with RedisJobQueue() as queue:
            while True:
                await run_job(await queue.dequeue())

    asyncio.run(listen())


if __name__ == "__main__":
    main()
