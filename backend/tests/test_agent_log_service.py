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
