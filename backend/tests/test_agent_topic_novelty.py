import asyncio
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


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("field", "invalid_value"),
    [
        ("key_facts", "not-an-array"),
        ("key_facts", ["valid", 7]),
        ("source_item_ids", "123"),
        ("source_item_ids", [True]),
        ("source_item_ids", [1.5]),
        ("source_item_ids", ["123"]),
        ("topic", ["not", "text"]),
        ("core_claim", {"not": "text"}),
        ("event_time", 123),
    ],
)
async def test_model_candidate_extraction_rejects_non_array_fields(
    monkeypatch, field, invalid_value
):
    from agent_topic_novelty import extract_candidate_with_model
    import json
    import llm

    payload = {
        "topic": "Agent 工具选择",
        "core_claim": "严格契约减少错误",
        "key_facts": ["契约必须稳定"],
        "event_time": None,
        "source_item_ids": [123],
    }
    payload[field] = invalid_value

    async def invalid_call(prompt, max_tokens):
        return json.dumps(payload, ensure_ascii=False)

    monkeypatch.setattr(llm, "_call", invalid_call)

    with pytest.raises(ValueError, match=field):
        await extract_candidate_with_model("工具契约", "正文")


def candidate_extractor(topic: str, core_claim: str):
    async def extract(title: str, content: str):
        from agent_topic_novelty import NoveltyCandidate

        assert title.strip()
        assert content.strip()
        return NoveltyCandidate(topic=topic, core_claim=core_claim)

    return extract


def verdict_judge(decision: str):
    async def judge(candidate, conflicts):
        return {
            "decision": decision,
            "reason": "test verdict",
            "novelty_basis": (
                "new fact" if decision == "new_development" else ""
            ),
            "suggested_action": {
                "novel": "continue",
                "duplicate": "change_topic",
                "new_development": "continue",
                "uncertain": "ask_user",
            }[decision],
        }

    return judge


async def seed_topic_claim(db, *, draft_id: int = 100):
    from models import AgentTopicClaim

    claim = AgentTopicClaim(
        draft_id=draft_id,
        topic="Agent 工具选择",
        core_claim="严格契约能够减少错误参数",
        decision="novel",
        reason="seed",
        window_days=14,
        agent_mode="chat",
    )
    db.add(claim)
    await db.commit()
    return claim


@pytest.mark.asyncio
async def test_agent_save_persists_draft_and_topic_claim_atomically(db):
    from agent_topic_novelty import (
        AgentIdentity,
        save_agent_draft_with_novelty_check,
    )
    from models import AgentTopicClaim, ArticleDraft

    result = await save_agent_draft_with_novelty_check(
        db,
        title="工具契约",
        content="工具契约决定 Agent 能否稳定选择工具。",
        topic_id="agent",
        status="drafting",
        pipeline_task_id=None,
        draft_type="article",
        identity=AgentIdentity(mode="chat", session_id=92),
        window_days=14,
        extract_candidate=candidate_extractor("Agent 工具选择", "契约决定稳定性"),
        judge=verdict_judge("novel"),
    )

    assert result["saved"] is True
    assert result["id"] > 0
    draft = await db.get(ArticleDraft, result["id"])
    claim = await db.scalar(select(AgentTopicClaim).where(
        AgentTopicClaim.draft_id == result["id"]
    ))
    assert draft is not None
    assert claim is not None
    assert claim.agent_session_id == 92
    assert claim.topic == "Agent 工具选择"


@pytest.mark.asyncio
async def test_duplicate_chat_save_requires_one_time_bound_override(db):
    from agent_topic_novelty import (
        AgentIdentity,
        save_agent_draft_with_novelty_check,
    )
    from models import AgentNoveltyOverride, AgentTopicClaim

    conflict = await seed_topic_claim(db)
    arguments = {
        "title": "工具契约续写",
        "content": "严格工具契约能够减少错误参数。",
        "topic_id": "agent",
        "status": "drafting",
        "pipeline_task_id": None,
        "draft_type": "article",
        "identity": AgentIdentity(mode="chat", session_id=92),
        "window_days": 14,
        "extract_candidate": candidate_extractor(
            "Agent 工具选择", "严格契约能够减少错误参数"
        ),
        "judge": verdict_judge("duplicate"),
    }

    blocked = await save_agent_draft_with_novelty_check(db, **arguments)
    assert blocked["saved"] is False
    assert "id" not in blocked
    assert blocked["novelty"]["decision"] == "duplicate"
    token = blocked["novelty_override_token"]
    assert isinstance(token, str) and len(token) >= 32

    saved = await save_agent_draft_with_novelty_check(
        db, **arguments, override_token=token
    )
    assert saved["saved"] is True
    claim = await db.scalar(select(AgentTopicClaim).where(
        AgentTopicClaim.draft_id == saved["id"]
    ))
    challenge = await db.scalar(select(AgentNoveltyOverride).where(
        AgentNoveltyOverride.agent_session_id == 92
    ))
    assert claim is not None
    assert claim.conflict_claim_ids == [conflict.id]
    assert claim.override_token_digest
    assert challenge is not None and challenge.consumed_at is not None

    replayed = await save_agent_draft_with_novelty_check(
        db, **arguments, override_token=token
    )
    assert replayed["saved"] is False
    assert replayed["override_error"] == "novelty override is invalid or expired"


@pytest.mark.asyncio
async def test_chat_override_is_stable_when_model_extraction_varies(db):
    from agent_topic_novelty import (
        AgentIdentity,
        NoveltyCandidate,
        save_agent_draft_with_novelty_check,
    )

    await seed_topic_claim(db)
    extraction_count = 0

    async def varying_extractor(title, content):
        nonlocal extraction_count
        extraction_count += 1
        return NoveltyCandidate(
            topic="Agent 工具选择",
            core_claim="严格契约能够减少错误参数",
            key_facts=[f"模型表达 {extraction_count}"],
        )

    arguments = {
        "title": "工具契约续写",
        "content": "严格工具契约能够减少错误参数。",
        "topic_id": "agent",
        "status": "drafting",
        "pipeline_task_id": None,
        "draft_type": "article",
        "identity": AgentIdentity(mode="chat", session_id=92),
        "window_days": 14,
        "extract_candidate": varying_extractor,
        "judge": verdict_judge("duplicate"),
    }

    blocked = await save_agent_draft_with_novelty_check(db, **arguments)
    saved = await save_agent_draft_with_novelty_check(
        db,
        **arguments,
        override_token=blocked["novelty_override_token"],
    )

    assert saved["saved"] is True


@pytest.mark.asyncio
async def test_scheduled_duplicate_cannot_request_or_use_override(db):
    from agent_topic_novelty import (
        AgentIdentity,
        save_agent_draft_with_novelty_check,
    )

    await seed_topic_claim(db)
    result = await save_agent_draft_with_novelty_check(
        db,
        title="重复主题",
        content="严格工具契约能够减少错误参数。",
        topic_id="daily-creation:1",
        status="drafting",
        pipeline_task_id=None,
        draft_type="x",
        identity=AgentIdentity(mode="scheduled", daily_creation_run_id=1),
        window_days=14,
        override_token="forged",
        extract_candidate=candidate_extractor(
            "Agent 工具选择", "严格契约能够减少错误参数"
        ),
        judge=verdict_judge("duplicate"),
    )

    assert result["saved"] is False
    assert result["novelty"]["decision"] == "duplicate"
    assert "novelty_override_token" not in result
    assert result["override_error"] == "scheduled Agent cannot override novelty"


@pytest.mark.asyncio
async def test_candidate_extraction_failure_is_uncertain_instead_of_saving(db):
    from agent_topic_novelty import (
        AgentIdentity,
        save_agent_draft_with_novelty_check,
    )
    from models import ArticleDraft
    from sqlalchemy import func

    async def failed_extractor(title, content):
        raise ValueError("invalid model output")

    result = await save_agent_draft_with_novelty_check(
        db,
        title="无法提取的主题",
        content="模型返回了不合法结构。",
        topic_id="agent",
        status="drafting",
        pipeline_task_id=None,
        draft_type="article",
        identity=AgentIdentity(mode="chat", session_id=92),
        window_days=14,
        extract_candidate=failed_extractor,
        judge=verdict_judge("novel"),
    )

    assert result["saved"] is False
    assert result["novelty"]["decision"] == "uncertain"
    assert result["novelty_override_token"]
    assert await db.scalar(select(func.count(ArticleDraft.id))) == 0


@pytest.mark.asyncio
async def test_scheduled_agent_override_is_rejected_even_for_novel_topic(db):
    from agent_topic_novelty import (
        AgentIdentity,
        save_agent_draft_with_novelty_check,
    )

    result = await save_agent_draft_with_novelty_check(
        db,
        title="全新主题",
        content="这是一个没有历史冲突的主题。",
        topic_id="daily-creation:1",
        status="drafting",
        pipeline_task_id=None,
        draft_type="x",
        identity=AgentIdentity(mode="scheduled", daily_creation_run_id=1),
        window_days=14,
        override_token="forged",
        extract_candidate=candidate_extractor("全新主题", "没有历史冲突"),
        judge=verdict_judge("novel"),
    )

    assert result["saved"] is False
    assert result["override_error"] == "scheduled Agent cannot override novelty"


@pytest.mark.asyncio
async def test_postgresql_lock_prevents_two_concurrent_duplicate_saves(
    postgres_database_url,
):
    from agent_topic_novelty import (
        AgentIdentity,
        save_agent_draft_with_novelty_check,
    )
    from database import Base
    import models  # noqa: F401

    engine = create_async_engine(postgres_database_url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    ready = 0
    both_ready = asyncio.Event()

    async def extract(title, content):
        nonlocal ready
        ready += 1
        if ready == 2:
            both_ready.set()
        await both_ready.wait()
        from agent_topic_novelty import NoveltyCandidate
        return NoveltyCandidate("Agent 工具选择", "严格契约减少错误参数")

    async def save(session_number):
        async with sessions() as session:
            return await save_agent_draft_with_novelty_check(
                session,
                title=f"并发草稿 {session_number}",
                content="严格契约减少错误参数。",
                topic_id="agent",
                status="drafting",
                pipeline_task_id=None,
                draft_type="article",
                identity=AgentIdentity(mode="job"),
                window_days=14,
                extract_candidate=extract,
                judge=verdict_judge("duplicate"),
            )

    results = await asyncio.gather(save(1), save(2))
    await engine.dispose()

    assert sorted(result["saved"] for result in results) == [False, True]
