import pytest

from agent_trajectory import (
    derive_agent_trajectory_state,
    trajectory_event_payloads,
    validate_agent_session_event,
)


def test_canonical_event_validation_is_strict_and_keeps_typed_payloads():
    payload = validate_agent_session_event(
        "tool/call",
        {
            "turn": 1,
            "step": 2,
            "callId": "call-1",
            "name": "search",
            "arguments": {"q": "AI"},
        },
    )

    assert payload["callId"] == "call-1"
    assert payload["arguments"] == {"q": "AI"}

    with pytest.raises(ValueError):
        validate_agent_session_event(
            "tool/call",
            {
                "turn": 1,
                "step": 2,
                "callId": "call-1",
                "name": "search",
                "arguments": {},
                "unexpected": True,
            },
        )

    with pytest.raises(ValueError):
        validate_agent_session_event(
            "tool/result",
            {"turn": 1, "step": 2, "content": []},
        )


def test_trajectory_state_pairs_tools_and_reports_open_turns():
    state = derive_agent_trajectory_state([
        {"seq": 1, "type": "turn/start", "turn": 1, "step": None, "data": {"turn": 1}},
        {"seq": 2, "type": "step/start", "turn": 1, "step": 1, "data": {"turn": 1, "step": 1}},
        {
            "seq": 3,
            "type": "tool/call",
            "turn": 1,
            "step": 1,
            "data": {"turn": 1, "step": 1, "callId": "call-1", "name": "search", "arguments": {}},
        },
    ])

    assert state == {
        "is_running": True,
        "running_call_ids": ["call-1"],
        "last_error": None,
    }

    completed = derive_agent_trajectory_state([
        {"seq": 1, "type": "turn/start", "turn": 1, "step": None, "data": {"turn": 1}},
        {"seq": 2, "type": "tool/call", "turn": 1, "step": 1, "data": {"callId": "call-1", "name": "search", "arguments": {}}},
        {"seq": 3, "type": "tool/result", "turn": 1, "step": 1, "data": {"callId": "call-1", "content": [], "isError": False}},
        {"seq": 4, "type": "turn/end", "turn": 1, "step": None, "data": {"reason": {"kind": "completed"}}},
    ])

    assert completed["is_running"] is False
    assert completed["running_call_ids"] == []


def test_trajectory_state_exposes_typed_turn_error():
    state = derive_agent_trajectory_state([
        {"seq": 1, "type": "turn/start", "turn": 4, "step": None, "data": {"turn": 4}},
        {
            "seq": 2,
            "type": "turn/end",
            "turn": 4,
            "step": None,
            "data": {"reason": {"kind": "error", "error": "模型接口失败"}},
        },
    ])

    assert state["is_running"] is False
    assert state["last_error"] == {
        "kind": "error",
        "message": "模型接口失败",
        "turn": 4,
    }


def test_legacy_generic_rows_are_not_adapted():
    projected = trajectory_event_payloads([{
        "sequence": 8,
        "created_at": "2026-08-22T00:00:00+00:00",
        "event_type": "llm/response",
        "status": "completed",
        "payload": {"text": "旧响应"},
        "usage": {"inputTokens": 2},
        "duration_ms": 120,
    }])

    assert projected == []


def test_canonical_rows_are_preferred_over_compatibility_audit_rows():
    projected = trajectory_event_payloads([
        {
            "sequence": 1,
            "created_at": "2026-08-22T00:00:00+00:00",
            "event_type": "session/turn-start",
            "status": "running",
            "payload": {},
        },
        {
            "sequence": 2,
            "created_at": "2026-08-22T00:00:01+00:00",
            "event_type": "turn/start",
            "status": "running",
            "payload": {"turn": 1},
        },
    ])

    assert [event["type"] for event in projected] == ["turn/start"]
    assert "legacy" not in projected[0]


def test_legacy_terminal_error_does_not_close_a_canonical_turn():
    projected = trajectory_event_payloads([
        {
            "sequence": 1,
            "created_at": "2026-08-22T00:00:00+00:00",
            "event_type": "turn/start",
            "status": "running",
            "payload": {"turn": 1},
        },
        {
            "sequence": 2,
            "created_at": "2026-08-22T00:00:01+00:00",
            "event_type": "session/error",
            "status": "error",
            "payload": {"error": "canonical append failed"},
        },
    ])

    assert [event["type"] for event in projected] == ["turn/start"]
