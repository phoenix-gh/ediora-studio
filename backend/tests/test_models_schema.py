import sys, asyncio, pytest


@pytest.fixture
def db_session(monkeypatch, postgres_env):
    for mod in list(sys.modules):
        if mod.startswith(("database", "models", "config")):
            sys.modules.pop(mod, None)
    from database import engine, Base, SessionLocal
    import models  # noqa
    async def _setup():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    asyncio.new_event_loop().run_until_complete(_setup())
    return SessionLocal


def test_new_columns_exist_with_defaults(db_session):
    from models import XSubscription, XPost
    from datetime import datetime, timezone

    async def _run():
        async with db_session() as db:
            sub = XSubscription(url=None, label="s", kind="search",
                                raw_query="min_faves:1", added_at=datetime.now(timezone.utc))
            db.add(sub); await db.commit(); await db.refresh(sub)
            assert sub.kind == "search" and sub.raw_query == "min_faves:1"
            assert sub.sort == "top" and sub.max_results == 100
            assert sub.collect_interval_minutes == 15

            post = XPost(tweet_id="t1", subscription_id=sub.id, username="u",
                         published_at=datetime.now(timezone.utc), possibly_sensitive=True)
            db.add(post); await db.commit(); await db.refresh(post)
            assert post.possibly_sensitive is True

    asyncio.new_event_loop().run_until_complete(_run())


def test_execution_job_aliases_keep_physical_tables():
    from models import (
        ContentJob,
        ContentJobEvent,
        ContentJobStep,
        ExecutionJob,
        ExecutionJobEvent,
        ExecutionJobStep,
    )

    assert ExecutionJob is ContentJob
    assert ExecutionJobStep is ContentJobStep
    assert ExecutionJobEvent is ContentJobEvent
    assert ExecutionJob.__table__.name == "content_jobs"


def test_agent_execution_and_artifact_constraints():
    from models import AgentExecution, ExecutionArtifact

    assert {"step_id", "attempt"} <= set(AgentExecution.__table__.c.keys())
    index_names = {index.name for index in AgentExecution.__table__.indexes}
    assert {
        "uq_agent_executions_legacy_job",
        "uq_agent_executions_stage_attempt",
    } <= index_names
    assert ExecutionArtifact.__table__.name == "execution_artifacts"
    assert {
        "job_id",
        "step_id",
        "attempt",
        "kind",
        "role",
        "digest",
        "status",
    } <= set(ExecutionArtifact.__table__.c.keys())
