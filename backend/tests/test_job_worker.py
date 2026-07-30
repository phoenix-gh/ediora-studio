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


def test_redis_queue_enqueues_once_checks_exact_lease_and_closes():
    from job_queue import RedisJobQueue

    class FakeRedis:
        def __init__(self):
            self.items: list[str] = []
            self.values: dict[str, str] = {}
            self.closed = False

        async def eval(self, _script, _key_count, queue, job_id):
            if job_id in self.items:
                return 0
            self.items.append(job_id)
            return 1

        async def get(self, key):
            return self.values.get(key)

        async def aclose(self):
            self.closed = True

    async def run():
        client = FakeRedis()
        async with RedisJobQueue(
            client=client,
            queue_name="content-jobs:test",
        ) as queue:
            assert await queue.enqueue_once(42) is True
            assert await queue.enqueue_once(42) is False
            assert client.items == ["42"]
            lease_key = (
                "wms:content-job-lease:content-jobs:test:42"
            )
            assert await queue.has_active_lease(42) is False
            client.values[lease_key] = "worker-owner"
            assert await queue.has_active_lease(42) is True
        assert client.closed is True

    asyncio.new_event_loop().run_until_complete(run())


def test_redis_queue_lease_fence_uses_atomic_set_and_compare_delete():
    from job_queue import (
        COMPARE_DELETE_SCRIPT,
        COMPARE_PEXPIRE_SCRIPT,
        RedisJobQueue,
        content_job_lease_key,
    )

    class FakeRedis:
        def __init__(self):
            self.values: dict[str, str] = {}
            self.set_calls: list[tuple] = []
            self.eval_calls: list[tuple] = []

        async def set(self, key, value, *, px, nx):
            self.set_calls.append((key, value, px, nx))
            if key in self.values:
                return None
            self.values[key] = value
            return "OK"

        async def eval(self, script, key_count, key, owner, *args):
            self.eval_calls.append(
                (script, key_count, key, owner, *args),
            )
            if (
                script == COMPARE_PEXPIRE_SCRIPT
                and self.values.get(key) == owner
            ):
                return 1
            if (
                script == COMPARE_DELETE_SCRIPT
                and self.values.get(key) == owner
            ):
                del self.values[key]
                return 1
            return 0

        async def aclose(self):
            return None

    async def run():
        client = FakeRedis()
        queue = RedisJobQueue(
            client=client,
            queue_name="private-content-jobs",
        )
        key = content_job_lease_key("private-content-jobs", 19)

        assert await queue.try_acquire_lease(
            19,
            "reconciler-a",
            ttl_ms=30_000,
        ) is True
        assert client.set_calls == [
            (key, "reconciler-a", 30_000, True),
        ]
        assert await queue.try_acquire_lease(
            19,
            "reconciler-b",
            ttl_ms=30_000,
        ) is False
        assert await queue.refresh_lease(
            19,
            "reconciler-b",
            ttl_ms=30_000,
        ) is False
        assert await queue.refresh_lease(
            19,
            "reconciler-a",
            ttl_ms=30_000,
        ) is True
        assert await queue.release_lease(19, "reconciler-b") is False
        assert client.values[key] == "reconciler-a"
        assert await queue.release_lease(19, "reconciler-a") is True
        assert key not in client.values
        assert client.eval_calls[-1] == (
            COMPARE_DELETE_SCRIPT,
            1,
            key,
            "reconciler-a",
        )

    asyncio.new_event_loop().run_until_complete(run())


def test_enqueue_job_owns_and_closes_its_redis_client(monkeypatch):
    import job_queue

    calls: list[object] = []

    class FakeQueue:
        async def __aenter__(self):
            calls.append("enter")
            return self

        async def enqueue_once(self, job_id):
            calls.append(job_id)

        async def __aexit__(self, *_args):
            calls.append("close")

    monkeypatch.setattr(job_queue, "RedisJobQueue", FakeQueue)

    asyncio.new_event_loop().run_until_complete(
        job_queue.enqueue_job(17),
    )

    assert calls == ["enter", 17, "close"]
