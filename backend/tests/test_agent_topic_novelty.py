from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


@pytest.fixture
async def db(postgres_database_url):
    from database import Base
    import models  # noqa: F401

    engine = create_async_engine(postgres_database_url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    async with sessions() as session:
        yield session
    await engine.dispose()


@pytest.mark.asyncio
async def test_agent_topic_claim_and_override_persist_auditable_defaults(db):
    from models import AgentNoveltyOverride, AgentTopicClaim, ArticleDraft

    draft = ArticleDraft(topic_id="agent", title="工具契约", content="正文")
    db.add(draft)
    await db.flush()
    claim = AgentTopicClaim(
        draft_id=draft.id,
        topic="Agent 工具选择",
        core_claim="严格契约比扩大工具列表更重要",
        key_facts=["schema 可限制参数"],
        decision="novel",
        reason="窗口内没有相同观点",
        window_days=14,
        agent_mode="chat",
        agent_session_id=12,
    )
    override = AgentNoveltyOverride(
        token_digest="a" * 64,
        candidate_digest="b" * 64,
        conflict_claim_ids=[1],
        agent_session_id=12,
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=10),
    )
    db.add_all([claim, override])
    await db.commit()

    stored_claim = await db.scalar(select(AgentTopicClaim))
    stored_override = await db.scalar(select(AgentNoveltyOverride))
    assert stored_claim is not None
    assert stored_claim.source_item_ids == []
    assert stored_claim.conflict_claim_ids == []
    assert stored_claim.released_at is None
    assert stored_override is not None
    assert stored_override.consumed_at is None


@pytest.mark.asyncio
async def test_agent_topic_claim_is_unique_per_draft(db):
    from models import AgentTopicClaim, ArticleDraft

    draft = ArticleDraft(topic_id="agent", title="工具契约", content="正文")
    db.add(draft)
    await db.flush()
    values = {
        "draft_id": draft.id,
        "topic": "Agent 工具选择",
        "core_claim": "契约优先",
        "decision": "novel",
        "window_days": 14,
        "agent_mode": "chat",
    }
    db.add(AgentTopicClaim(**values))
    await db.commit()
    db.add(AgentTopicClaim(**values))

    with pytest.raises(IntegrityError):
        await db.commit()
