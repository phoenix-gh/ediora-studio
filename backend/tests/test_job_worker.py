import asyncio
import sys

import pytest


@pytest.fixture
def session_factory(monkeypatch, tmp_path):
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{tmp_path / 'worker.db'}")
    for module in list(sys.modules):
        if module.startswith(("database", "models", "content_jobs", "content_flows", "job_worker")):
            sys.modules.pop(module, None)
    from database import Base, SessionLocal, engine
    import models  # noqa: F401

    async def setup():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.new_event_loop().run_until_complete(setup())
    return SessionLocal


def test_worker_executes_brief_then_draft(session_factory, monkeypatch):
    from content_jobs import create_job
    import content_flows
    from job_worker import run_job

    async def fake_brief(job, step):
        return {"brief": "ok"}

    async def fake_draft(job, step):
        return {"draft_id": 12}

    monkeypatch.setattr(content_flows, "run_brief", fake_brief)
    monkeypatch.setattr(content_flows, "run_draft", fake_draft)

    async def run():
        async with session_factory() as session:
            job = await create_job(session, flow="draft", title="T", input_data={})
            await run_job(job.id, session_factory=session_factory)

        async with session_factory() as session:
            from models import ContentJobStep
            from sqlalchemy import select
            steps = (await session.execute(select(ContentJobStep).order_by(ContentJobStep.id))).scalars().all()
            assert [(step.step_key, step.status) for step in steps] == [
                ("brief", "succeeded"), ("draft", "succeeded"),
            ]

    asyncio.new_event_loop().run_until_complete(run())


def test_memory_queue_delivers_enqueued_job_once():
    from job_queue import InMemoryJobQueue

    async def run():
        queue = InMemoryJobQueue()
        await queue.enqueue(42)
        assert await queue.dequeue() == 42

    asyncio.new_event_loop().run_until_complete(run())
