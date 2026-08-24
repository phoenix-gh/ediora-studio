import asyncio
import sys

import pytest


@pytest.fixture
def log_db(monkeypatch, postgres_env):
    for module_name in list(sys.modules):
        if module_name.startswith(("database", "models", "agent_log_service")):
            sys.modules.pop(module_name, None)

    from database import Base, SessionLocal, engine
    import models  # noqa: F401

    async def setup():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.run(setup())
    try:
        yield SessionLocal
    finally:
        asyncio.run(engine.dispose())


def test_append_agent_log_event_assigns_order_and_redacts_payload(log_db):
    from agent_log_service import append_agent_log_event, list_agent_log_events
    from models import ChatSession

    async def exercise():
        async with log_db() as session:
            chat_session = ChatSession(title="日志测试")
            session.add(chat_session)
            await session.commit()
            await session.refresh(chat_session)

            first = await append_agent_log_event(
                session,
                stream_kind="chat",
                stream_key=f"chat:{chat_session.id}",
                session_id=chat_session.id,
                event_type="session/turn-start",
                phase="chat",
                payload={"prompt": "hello", "auth_token": "should-not-persist"},
            )
            second = await append_agent_log_event(
                session,
                stream_kind="chat",
                stream_key=f"chat:{chat_session.id}",
                session_id=chat_session.id,
                event_type="llm/response",
                phase="execute",
                payload={"text": "world", "metadata": {"ct0": "secret"}},
                usage={"inputTokens": 4, "outputTokens": 2},
                duration_ms=321,
            )
            events = await list_agent_log_events(
                session,
                stream_key=f"chat:{chat_session.id}",
            )
            return first, second, events

    first, second, events = asyncio.run(exercise())

    assert first.sequence < second.sequence
    assert [event.event_type for event in events] == [
        "session/turn-start",
        "llm/response",
    ]
    assert events[0].payload_data["auth_token"] == "***"
    assert events[1].payload_data["metadata"]["ct0"] == "***"
    assert events[1].usage_data == {"inputTokens": 4, "outputTokens": 2}
    assert events[1].duration_ms == 321


def test_list_agent_log_events_supports_cursor_and_filters(log_db):
    from agent_log_service import append_agent_log_event, list_agent_log_events

    async def exercise():
        async with log_db() as session:
            for index, event_type in enumerate(("llm/request", "tool/call", "llm/error")):
                await append_agent_log_event(
                    session,
                    stream_kind="job",
                    stream_key="execution:9",
                    job_id=4,
                    execution_id=9,
                    event_type=event_type,
                    phase="execute",
                    status="error" if event_type == "llm/error" else "completed",
                    payload={"index": index},
                )
            first_page = await list_agent_log_events(
                session,
                stream_key="execution:9",
                limit=2,
            )
            second_page = await list_agent_log_events(
                session,
                stream_key="execution:9",
                after_sequence=first_page[-1].sequence,
                event_type="llm/error",
            )
            return first_page, second_page

    first_page, second_page = asyncio.run(exercise())

    assert [event.payload_data["index"] for event in first_page] == [0, 1]
    assert [event.payload_data["index"] for event in second_page] == [2]


def test_append_canonical_turn_end_resolves_current_turn_after_long_stream(log_db):
    from agent_log_service import append_agent_log_event, append_agent_session_event
    from models import ChatSession

    async def exercise():
        async with log_db() as session:
            chat_session = ChatSession(title="长会话 turn 推断")
            session.add(chat_session)
            await session.commit()
            await session.refresh(chat_session)

            stream_key = f"chat:{chat_session.id}"
            await append_agent_session_event(
                session,
                stream_kind="chat",
                stream_key=stream_key,
                session_id=chat_session.id,
                turn_id="old-turn",
                event_type="turn/start",
                data={"turn": 1},
            )
            for index in range(501):
                await append_agent_log_event(
                    session,
                    stream_kind="chat",
                    stream_key=stream_key,
                    session_id=chat_session.id,
                    turn_id="old-turn",
                    event_type="llm/response",
                    phase="execute",
                    payload={"turn": 1, "index": index},
                )

            await append_agent_session_event(
                session,
                stream_kind="chat",
                stream_key=stream_key,
                session_id=chat_session.id,
                turn_id="current-turn",
                event_type="turn/start",
                data={"turn": 3},
            )
            ended = await append_agent_session_event(
                session,
                stream_kind="chat",
                stream_key=stream_key,
                session_id=chat_session.id,
                turn_id="current-turn",
                event_type="turn/end",
                data={"reason": {"kind": "completed"}},
            )
            return ended

    ended = asyncio.run(exercise())

    assert ended.payload_data["turn"] == 3


def test_get_agent_token_usage_aggregates_a_job_across_execution_streams(log_db):
    from agent_log_service import (
        append_agent_log_event,
        append_agent_session_event,
        get_agent_token_usage,
    )

    async def exercise():
        async with log_db() as session:
            from models import AgentExecution

            execution = AgentExecution(
                job_id=7,
                status="running",
                objective="Write an article",
                skill_mode="auto",
            )
            session.add(execution)
            await session.flush()
            await append_agent_session_event(
                session,
                stream_kind="job",
                stream_key=f"execution:{execution.id}",
                execution_id=execution.id,
                turn_id=f"execution:{execution.id}:turn:1",
                event_type="assistant/message",
                data={
                    "turn": 1,
                    "step": 1,
                    "blocks": [{"kind": "text", "text": "execution-only"}],
                    "usage": {"inputTokens": 25, "outputTokens": 5},
                },
            )
            await append_agent_session_event(
                session,
                stream_kind="job",
                stream_key="execution:1",
                job_id=7,
                execution_id=1,
                turn_id="execution:1:turn:1",
                event_type="assistant/message",
                data={
                    "turn": 1,
                    "step": 1,
                    "blocks": [{"kind": "text", "text": "one"}],
                    "usage": {"inputTokens": 100, "outputTokens": 20},
                },
            )
            await append_agent_session_event(
                session,
                stream_kind="job",
                stream_key="execution:2",
                job_id=7,
                execution_id=2,
                turn_id="execution:2:turn:1",
                event_type="assistant/message",
                data={
                    "turn": 1,
                    "step": 1,
                    "blocks": [{"kind": "text", "text": "two"}],
                    "usage": {"inputTokens": 40, "outputTokens": 10},
                },
            )
            await append_agent_log_event(
                session,
                stream_kind="job",
                stream_key="execution:2",
                job_id=7,
                execution_id=2,
                event_type="llm/response",
                phase="execute",
                payload={"usage": {"inputTokens": 40, "outputTokens": 10}},
            )
            return await get_agent_token_usage(session, job_id=7)

    assert asyncio.run(exercise()) == {
        "input_tokens": 165,
        "output_tokens": 35,
        "total_tokens": 200,
        "request_count": 3,
    }
