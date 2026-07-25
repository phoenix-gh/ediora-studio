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
    from models import ContentJob, XResponseDecision, XSubscription
    from x_response_service import ensure_response_job, reconcile_response_jobs

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
            db.add(XResponseDecision(
                tweet_id="decided",
                subscription_id=sub.id,
                action="ignore",
                score=10,
                confidence=0.9,
            ))
            await db.commit()

        result = await reconcile_response_jobs(enqueue=enqueue)
        async with SessionLocal() as db:
            jobs = (await db.execute(select(ContentJob))).scalars().all()
            return result, jobs

    result, jobs = asyncio.run(run())
    assert result == {"created": 1, "enqueued": 1, "errors": []}
    assert {job.idempotency_key for job in jobs} == {
        "x-response:has-job",
        "x-response:missing",
    }
    assert len(enqueued) == 1


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
