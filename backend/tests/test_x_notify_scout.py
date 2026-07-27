"""Dispatch, reconciliation, and digest tests for the X response workflow."""

import asyncio
import sys
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select


@pytest.fixture
def service_env(monkeypatch, tmp_path):
    monkeypatch.setenv(
        "WMS_DATABASE_URL",
        f"sqlite+aiosqlite:///{tmp_path / 'responses.db'}",
    )
    monkeypatch.setenv("WMS_DISABLE_SCHEDULER", "1")
    for name in list(sys.modules):
        if name.startswith((
            "database", "models", "config", "x_response_service", "scheduler",
            "content_jobs", "job_queue",
        )):
            sys.modules.pop(name, None)

    from database import Base, engine
    import models  # noqa: F401 - register ORM tables before create_all

    async def create_schema():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.run(create_schema())


def _post(tweet_id, subscription_id, *, now, is_reply=False, age_hours=0):
    from models import XPost

    return XPost(
        tweet_id=tweet_id,
        subscription_id=subscription_id,
        username="openai",
        display_name="OpenAI",
        content=f"announcement {tweet_id}",
        url=f"https://x.com/openai/status/{tweet_id}",
        published_at=now - timedelta(hours=age_hours),
        collected_at=now,
        is_reply=is_reply,
    )


def test_dispatch_is_eligible_and_idempotent(service_env):
    from database import SessionLocal
    from models import ContentJob, XSubscription
    from x_response_service import dispatch_response_posts

    enqueued: list[int] = []

    async def enqueue(job_id):
        enqueued.append(job_id)

    async def run():
        now = datetime.now(timezone.utc)
        async with SessionLocal() as db:
            sub = XSubscription(
                label="OpenAI",
                kind="timeline",
                url="https://x.com/openai",
                enabled=True,
                notify_new_posts=True,
                notify_enabled_at=now - timedelta(minutes=5),
                added_at=now,
            )
            db.add(sub)
            await db.commit()
            await db.refresh(sub)
            db.add_all([
                _post("fresh", sub.id, now=now),
                _post("reply", sub.id, now=now, is_reply=True),
                _post("stale", sub.id, now=now, age_hours=72),
            ])
            await db.commit()

            first = await dispatch_response_posts(
                db, sub, ["fresh", "reply", "stale"], enqueue=enqueue,
            )
            second = await dispatch_response_posts(
                db, sub, ["fresh"], enqueue=enqueue,
            )
            jobs = (await db.execute(select(ContentJob))).scalars().all()
            return first, second, jobs

    first, second, jobs = asyncio.run(run())
    assert first == {"created": 1, "enqueued": 1, "errors": []}
    assert second == {"created": 0, "enqueued": 0, "errors": []}
    assert len(jobs) == 1
    assert jobs[0].idempotency_key == "x-response:fresh"
    assert jobs[0].input_data == {"tweet_id": "fresh"}
    assert enqueued == [jobs[0].id]


def test_reconciliation_creates_only_missing_jobs(service_env):
    from database import SessionLocal
    from models import ContentJob, XSubscription
    from x_response_service import (
        ensure_response_job,
        persist_decision,
        reconcile_response_jobs,
    )

    enqueued: list[int] = []

    async def enqueue(job_id):
        enqueued.append(job_id)

    async def run():
        now = datetime.now(timezone.utc)
        async with SessionLocal() as db:
            sub = XSubscription(
                label="OpenAI",
                kind="timeline",
                url="https://x.com/openai",
                enabled=True,
                notify_new_posts=True,
                notify_enabled_at=now - timedelta(minutes=10),
                added_at=now,
            )
            db.add(sub)
            await db.commit()
            await db.refresh(sub)
            db.add_all([
                _post("missing", sub.id, now=now),
                _post("has-job", sub.id, now=now),
                _post("decided", sub.id, now=now),
            ])
            await db.commit()
            await ensure_response_job(db, "has-job")
            await persist_decision(
                db,
                "decided",
                {
                    "action": "ignore",
                    "score": 10,
                    "confidence": 0.9,
                    "reason": "无需响应",
                    "summary_cn": "普通更新",
                    "claims": [],
                },
                {"verification_status": "not_required"},
            )

        result = await reconcile_response_jobs(enqueue=enqueue)
        repeated = await reconcile_response_jobs(enqueue=enqueue)
        async with SessionLocal() as db:
            jobs = (await db.execute(select(ContentJob))).scalars().all()
            return result, repeated, jobs

    result, repeated, jobs = asyncio.run(run())
    assert result == {"created": 1, "enqueued": 2, "errors": []}
    assert repeated == {"created": 0, "enqueued": 0, "errors": []}
    assert {job.idempotency_key for job in jobs} == {
        "x-response:has-job",
        "x-response:missing",
    }
    assert len(enqueued) == 2


def test_daily_digest_job_is_idempotent(service_env):
    from database import SessionLocal
    from models import ContentJob
    from x_response_service import create_response_digest_job

    async def run():
        async with SessionLocal() as db:
            first, first_created = await create_response_digest_job(
                "2026-07-25", db=db,
            )
            second, second_created = await create_response_digest_job(
                "2026-07-25", db=db,
            )
            jobs = (await db.execute(select(ContentJob))).scalars().all()
            return first, first_created, second, second_created, jobs

    first, first_created, second, second_created, jobs = asyncio.run(run())
    assert first_created is True
    assert second_created is False
    assert first.id == second.id
    assert len(jobs) == 1
    assert jobs[0].flow == "x_response_digest"
    assert jobs[0].idempotency_key == "x-response-digest:2026-07-25"


def test_reconciliation_repairs_digest_job_that_was_not_enqueued(service_env):
    from x_response_service import (
        create_response_digest_job,
        reconcile_response_jobs,
    )

    enqueued: list[int] = []

    async def enqueue(job_id):
        enqueued.append(job_id)

    async def run():
        job, created = await create_response_digest_job("2026-07-25")
        first = await reconcile_response_jobs(enqueue=enqueue)
        second = await reconcile_response_jobs(enqueue=enqueue)
        return job.id, created, first, second

    job_id, created, first, second = asyncio.run(run())
    assert created is True
    assert first["enqueued"] == 1
    assert second["enqueued"] == 0
    assert enqueued == [job_id]


def test_scheduler_registers_reconciliation_and_shanghai_digest(service_env):
    import scheduler

    registered: list[tuple] = []

    class FakeScheduler:
        def add_job(self, func, **kwargs):
            registered.append((func, kwargs))

    scheduler.register_jobs(FakeScheduler(), {})
    by_id = {kwargs["id"]: (func, kwargs) for func, kwargs in registered}

    assert "x_reply_scout" not in by_id
    reconcile_func, reconcile = by_id["x_response_reconcile"]
    digest_func, digest = by_id["x_response_digest"]
    assert reconcile_func is scheduler.scheduled_x_response_reconcile
    assert reconcile["trigger"] == "interval"
    assert reconcile["minutes"] == 5
    assert digest_func is scheduler.scheduled_x_response_digest
    assert digest == {
        "trigger": "cron",
        "hour": 18,
        "minute": 0,
        "timezone": "Asia/Shanghai",
        "id": "x_response_digest",
    }
    topic_reconcile_func, topic_reconcile = by_id["topic_source_reconcile"]
    assert topic_reconcile_func is scheduler.scheduled_topic_source_reconcile
    assert topic_reconcile["trigger"] == "interval"
    assert topic_reconcile["minutes"] == 5
    assert topic_reconcile["id"] == "topic_source_reconcile"
    assert topic_reconcile["next_run_time"] is not None
