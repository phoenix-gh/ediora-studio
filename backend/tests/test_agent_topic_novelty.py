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


@pytest.mark.asyncio
async def test_novelty_check_skips_model_when_global_window_has_no_candidates(db):
    from agent_topic_novelty import NoveltyCandidate, check_content_novelty

    called = False

    async def judge(candidate, conflicts):
        nonlocal called
        called = True
        return {}

    result = await check_content_novelty(
        db,
        candidate=NoveltyCandidate(
            topic="Agent 工具选择",
            core_claim="严格契约能够减少错误参数",
        ),
        window_days=14,
        judge=judge,
    )

    assert result.decision == "novel"
    assert result.suggested_action == "continue"
    assert result.conflicts == ()
    assert called is False


@pytest.mark.asyncio
async def test_novelty_check_sends_only_active_in_window_similar_claims(db):
    from agent_topic_novelty import NoveltyCandidate, check_content_novelty
    from models import AgentTopicClaim

    now = datetime.now(timezone.utc)
    db.add_all([
        AgentTopicClaim(
            draft_id=10,
            topic="Agent 工具选择",
            core_claim="严格工具契约能够减少错误参数",
            decision="novel",
            reason="seed",
            window_days=14,
            agent_mode="chat",
            claimed_at=now - timedelta(days=2),
        ),
        AgentTopicClaim(
            draft_id=11,
            topic="Agent 工具选择",
            core_claim="旧观点",
            decision="novel",
            reason="seed",
            window_days=14,
            agent_mode="chat",
            claimed_at=now - timedelta(days=15),
        ),
        AgentTopicClaim(
            draft_id=12,
            topic="Agent 工具选择",
            core_claim="已删除草稿",
            decision="novel",
            reason="seed",
            window_days=14,
            agent_mode="chat",
            claimed_at=now - timedelta(days=1),
            released_at=now,
        ),
        AgentTopicClaim(
            draft_id=13,
            topic="旅行摄影",
            core_claim="使用长焦压缩空间",
            decision="novel",
            reason="seed",
            window_days=14,
            agent_mode="chat",
            claimed_at=now - timedelta(hours=1),
        ),
    ])
    await db.commit()

    async def judge(candidate, conflicts):
        assert [item["draft_id"] for item in conflicts] == [10]
        return {
            "decision": "duplicate",
            "reason": "主题和核心观点相同",
            "novelty_basis": "",
            "suggested_action": "change_topic",
        }

    result = await check_content_novelty(
        db,
        candidate=NoveltyCandidate(
            topic="Agent 工具选择",
            core_claim="严格契约可以避免工具参数错误",
        ),
        window_days=14,
        judge=judge,
        now=now,
    )

    assert result.decision == "duplicate"
    assert result.reason == "主题和核心观点相同"
    assert [item["draft_id"] for item in result.conflicts] == [10]


@pytest.mark.asyncio
async def test_novelty_check_treats_invalid_or_failed_judgment_as_uncertain(db):
    from agent_topic_novelty import NoveltyCandidate, check_content_novelty
    from models import AgentTopicClaim

    db.add(AgentTopicClaim(
        draft_id=20,
        topic="Agent 工具选择",
        core_claim="契约优先",
        decision="novel",
        reason="seed",
        window_days=14,
        agent_mode="chat",
    ))
    await db.commit()

    async def invalid_judge(candidate, conflicts):
        return {"decision": "maybe", "reason": "不合法"}

    invalid = await check_content_novelty(
        db,
        candidate=NoveltyCandidate("Agent 工具选择", "契约优先"),
        window_days=14,
        judge=invalid_judge,
    )

    async def failed_judge(candidate, conflicts):
        raise RuntimeError("provider unavailable")

    failed = await check_content_novelty(
        db,
        candidate=NoveltyCandidate("Agent 工具选择", "契约优先"),
        window_days=14,
        judge=failed_judge,
    )

    assert invalid.decision == "uncertain"
    assert invalid.suggested_action == "ask_user"
    assert failed.decision == "uncertain"
    assert failed.suggested_action == "ask_user"


@pytest.mark.asyncio
async def test_model_judge_parses_fenced_json_and_rejects_missing_new_basis(monkeypatch):
    from agent_topic_novelty import NoveltyCandidate, judge_novelty_with_model
    import llm

    async def valid_call(prompt, max_tokens):
        assert "Agent 工具选择" in prompt
        assert max_tokens == 1200
        return "```json\n{\"decision\":\"novel\",\"reason\":\"观点相反\",\"novelty_basis\":\"\",\"suggested_action\":\"continue\"}\n```"

    monkeypatch.setattr(llm, "_call", valid_call)
    parsed = await judge_novelty_with_model(
        NoveltyCandidate("Agent 工具选择", "契约优先"),
        [{"id": 1, "topic": "Agent 工具选择", "core_claim": "工具越多越好"}],
    )
    assert parsed["decision"] == "novel"

    async def missing_basis(prompt, max_tokens):
        return '{"decision":"new_development","reason":"有更新","novelty_basis":"","suggested_action":"continue"}'

    monkeypatch.setattr(llm, "_call", missing_basis)
    with pytest.raises(ValueError, match="novelty_basis"):
        await judge_novelty_with_model(
            NoveltyCandidate("Agent 工具选择", "出现更新"),
            [{"id": 1, "topic": "Agent 工具选择", "core_claim": "旧内容"}],
        )
