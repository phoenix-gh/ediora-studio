"""Canonical Agent session events and compatibility projection helpers.

The physical event store is still ``agent_log_events``.  This module keeps the
typed Agent contract at the write boundary and adapts historical generic rows
when they are read by the trajectory API.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from models import AgentLogEvent


CANONICAL_EVENT_TYPES = (
    "turn/start",
    "turn/end",
    "step/start",
    "step/end",
    "user/message",
    "assistant/chunk",
    "assistant/message",
    "tool/call",
    "tool/result",
    "request/header",
    "agent/skill",
)

TurnEndKind = Literal[
    "completed",
    "error",
    "aborted",
    "interrupted",
    "max_tokens",
    "waiting_approval",
]


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class _TurnData(_StrictModel):
    turn: int | None = Field(default=None, gt=0)


class _TurnReason(_StrictModel):
    kind: TurnEndKind
    error: Any | None = None
    message: str | None = Field(default=None, max_length=4_000)


class _TurnEndData(_StrictModel):
    reason: _TurnReason


class _StepData(_StrictModel):
    turn: int = Field(gt=0)
    step: int = Field(gt=0)


class _UserMessageData(_StrictModel):
    content: list[dict | str] = Field(min_length=1, max_length=4_096)
    source: dict[str, Any]


class _AssistantChunkData(_StrictModel):
    turn: int = Field(gt=0)
    step: int = Field(gt=0)
    chunk: dict[str, Any]


class _AssistantMessageData(_StrictModel):
    turn: int = Field(gt=0)
    step: int = Field(gt=0)
    blocks: list[dict[str, Any]] = Field(max_length=4_096)
    usage: dict[str, Any] | None = None
    timing: dict[str, Any] | None = None
    provider: str | None = Field(default=None, max_length=200)
    model: str | None = Field(default=None, max_length=200)
    interrupted: bool = False


class _ToolCallData(_StrictModel):
    turn: int = Field(gt=0)
    step: int = Field(gt=0)
    callId: str = Field(min_length=1, max_length=300)
    name: str = Field(min_length=1, max_length=300)
    arguments: Any | None = None
    argsRaw: str | None = Field(default=None, max_length=2_000_000)
    input: Any | None = None

    @model_validator(mode="after")
    def require_arguments(self):
        if self.arguments is None and self.argsRaw is None and self.input is None:
            raise ValueError("tool/call requires arguments, argsRaw, or input")
        return self


class _ToolResultData(_StrictModel):
    turn: int = Field(gt=0)
    step: int = Field(gt=0)
    callId: str = Field(min_length=1, max_length=300)
    content: list[dict | str] | None = Field(default=None, max_length=4_096)
    output: Any | None = None
    result: Any | None = None
    error: str | None = Field(default=None, max_length=20_000)
    isError: bool = False
    meta: dict[str, Any] | None = None

    @model_validator(mode="after")
    def require_result_body(self):
        if self.content is None and self.output is None and self.result is None and self.error is None:
            raise ValueError("tool/result requires content, output, result, or error")
        return self


class _RequestHeaderData(_StrictModel):
    turn: int = Field(gt=0)
    step: int | None = Field(default=None, gt=0)
    provider: str | None = Field(default=None, max_length=200)
    model: str | None = Field(default=None, max_length=200)
    headers: dict[str, str] | None = None
    request: dict[str, Any] | None = None
    toolSchemaDigest: str | None = Field(default=None, max_length=200)


class _AgentSkillData(_StrictModel):
    name: str = Field(min_length=1, max_length=200)
    activation: str | None = Field(default=None, max_length=40)
    references: list[str] = Field(default_factory=list, max_length=256)
    metadata: dict[str, Any] | None = None


_EVENT_MODELS = {
    "turn/start": _TurnData,
    "turn/end": _TurnEndData,
    "step/start": _StepData,
    "step/end": _StepData,
    "user/message": _UserMessageData,
    "assistant/chunk": _AssistantChunkData,
    "assistant/message": _AssistantMessageData,
    "tool/call": _ToolCallData,
    "tool/result": _ToolResultData,
    "request/header": _RequestHeaderData,
    "agent/skill": _AgentSkillData,
}


def validate_agent_session_event(event_type: str, data: object) -> dict[str, Any]:
    """Validate and normalize one canonical event payload.

    Historical generic event names deliberately do not pass through this
    function; they remain accepted by the compatibility ingestion endpoint.
    """

    model_type = _EVENT_MODELS.get(event_type)
    if model_type is None:
        raise ValueError(f"unsupported canonical Agent event: {event_type}")
    try:
        return model_type.model_validate(data).model_dump(exclude_none=True)
    except ValidationError as exc:
        raise ValueError(f"invalid {event_type} payload: {exc}") from exc


def _value(event: AgentLogEvent | dict[str, Any], key: str, default: Any = None) -> Any:
    if isinstance(event, dict):
        return event.get(key, default)
    return getattr(event, key, default)


def _record(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _int_value(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int) and value > 0:
        return value
    if isinstance(value, str) and value.isdigit() and int(value) > 0:
        return int(value)
    return None


def _event_turn(event: AgentLogEvent | dict[str, Any], payload: dict[str, Any]) -> int:
    return (
        _int_value(_value(event, "turn_id"))
        or _int_value(payload.get("turn"))
        or 1
    )


def _event_step(event: AgentLogEvent | dict[str, Any], payload: dict[str, Any]) -> int | None:
    return _int_value(_value(event, "step_id")) or _int_value(payload.get("step"))


def _event_time_ms(value: object) -> int:
    if isinstance(value, datetime):
        return int(value.timestamp() * 1_000)
    if isinstance(value, str):
        try:
            return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1_000)
        except ValueError:
            pass
    return 0


def _payload(event: AgentLogEvent | dict[str, Any]) -> dict[str, Any]:
    return _record(_value(event, "payload", _value(event, "payload_data", {})))


def _text(value: object) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "".join(_text(item) for item in value)
    if isinstance(value, dict):
        for key in ("text", "content", "output", "value"):
            if key in value:
                return _text(value[key])
    return ""


def _legacy_reason(event_type: str, status: str, payload: dict[str, Any]) -> dict[str, Any]:
    if event_type in {"session/error", "llm/error", "execution/error"} or status in {"error", "failed"}:
        return {
            "kind": "error",
            "error": str(payload.get("error") or payload.get("message") or "Agent 运行失败"),
        }
    return {"kind": "completed"}


def adapt_legacy_agent_log_event(event: AgentLogEvent | dict[str, Any]) -> dict[str, Any] | None:
    """Map a known historical generic row into the canonical envelope."""

    event_type = str(_value(event, "event_type", ""))
    payload = _payload(event)
    sequence = _int_value(_value(event, "sequence")) or _int_value(_value(event, "id")) or 0
    turn = _event_turn(event, payload)
    step = _event_step(event, payload)
    status = str(_value(event, "status", "info"))
    duration_ms = _value(event, "duration_ms")
    usage = _value(event, "usage", _value(event, "usage_data"))
    created_at = _value(event, "created_at")

    mapped_type: str | None = None
    data: dict[str, Any] = {}
    if event_type in {"session/turn-start", "execution/start"}:
        mapped_type = "turn/start"
        data = {"turn": turn}
    elif event_type in {"session/turn-end", "execution/complete", "session/error", "execution/error", "llm/error"}:
        mapped_type = "turn/end"
        data = {"reason": _legacy_reason(event_type, status, payload)}
    elif event_type in {"session/user-message", "user/message"}:
        mapped_type = "user/message"
        data = {
            "content": [{"kind": "text", "text": _text(payload.get("text") or payload.get("content"))}],
            "source": {"kind": "user"},
        }
    elif event_type in {"session/assistant-message", "llm/response", "assistant/message"}:
        mapped_type = "assistant/message"
        blocks: list[dict[str, Any]] = []
        reasoning = _text(payload.get("reasoning") or payload.get("thinking"))
        text = _text(payload.get("text") or payload.get("content"))
        if reasoning:
            blocks.append({"kind": "reasoning", "text": reasoning})
        if text:
            blocks.append({"kind": "text", "text": text})
        for tool_call in payload.get("toolCalls") or payload.get("tool_calls") or []:
            if isinstance(tool_call, dict):
                blocks.append({
                    "kind": "tool-call",
                    "callId": tool_call.get("callId") or tool_call.get("toolCallId") or tool_call.get("id"),
                    "name": tool_call.get("name") or tool_call.get("toolName") or "Tool",
                    "arguments": tool_call.get("arguments") or tool_call.get("input") or {},
                })
        data = {"blocks": blocks}
        if isinstance(usage, dict):
            data["usage"] = usage
        if isinstance(duration_ms, int):
            data["timing"] = {"durationMs": duration_ms}
        data["legacyEventType"] = event_type
    elif event_type in {"tool/call", "tool/approval"}:
        call_id = payload.get("callId") or payload.get("toolCallId") or payload.get("tool_call_id")
        if not isinstance(call_id, str) or not call_id:
            return None
        mapped_type = "tool/call"
        data = {
            "callId": call_id,
            "name": payload.get("name") or payload.get("toolName") or payload.get("tool_name") or "Tool",
            "arguments": payload.get("arguments") or payload.get("input") or payload.get("inputSummary") or {},
        }
    elif event_type == "tool/result":
        call_id = payload.get("callId") or payload.get("toolCallId") or payload.get("tool_call_id")
        if not isinstance(call_id, str) or not call_id:
            return None
        mapped_type = "tool/result"
        data = {
            "callId": call_id,
            "content": payload.get("content") if isinstance(payload.get("content"), list) else [{"kind": "text", "text": _text(payload.get("output") or payload.get("result"))}],
            "isError": status in {"error", "failed", "uncertain"} or payload.get("isError") is True,
        }
        if payload.get("error"):
            data["error"] = str(payload["error"])
    elif event_type in {"llm/request", "request/header"}:
        mapped_type = "request/header"
        data = {"turn": turn, **payload}
        data.pop("turn_id", None)
        if step is not None:
            data["step"] = step
    elif event_type in {"skill/selected", "skill/reference", "session/capabilities", "execution/checkpoint"}:
        mapped_type = "agent/skill"
        data = {
            "name": str(payload.get("skillName") or payload.get("name") or event_type),
            "metadata": payload,
        }
    else:
        return None

    return {
        "seq": sequence,
        "time": _event_time_ms(created_at),
        "type": mapped_type,
        "turn": turn,
        "step": step,
        "data": data,
        "legacy": True,
    }


def agent_session_event_payload(event: AgentLogEvent | dict[str, Any]) -> dict[str, Any]:
    """Serialize a canonical database row using the frontend event envelope."""

    data = _payload(event)
    return {
        "seq": _int_value(_value(event, "sequence")) or _int_value(_value(event, "id")) or 0,
        "time": _event_time_ms(_value(event, "created_at")),
        "type": str(_value(event, "event_type", "")),
        "turn": _event_turn(event, data),
        "step": _event_step(event, data),
        "data": data,
    }


def trajectory_event_payloads(
    events: list[AgentLogEvent | dict[str, Any]],
) -> list[dict[str, Any]]:
    """Prefer canonical rows when a stream contains them to avoid duplicates."""

    canonical = [
        event for event in events
        if str(_value(event, "event_type", "")) in CANONICAL_EVENT_TYPES
    ]
    source = canonical or events
    if canonical and not any(
        str(_value(event, "event_type", "")) == "turn/end" for event in canonical
    ):
        source = canonical + [
            event for event in events
            if str(_value(event, "event_type", "")) in {
                "session/turn-end", "session/error", "execution/complete", "execution/error", "llm/error",
            }
        ]
    projected = []
    for event in source:
        event_type = str(_value(event, "event_type", ""))
        if event_type in CANONICAL_EVENT_TYPES:
            projected.append(agent_session_event_payload(event))
        else:
            adapted = adapt_legacy_agent_log_event(event)
            if adapted is not None:
                projected.append(adapted)
    return sorted(projected, key=lambda item: item["seq"])


def _state_turn(data: dict[str, Any], envelope: dict[str, Any]) -> int:
    return _int_value(envelope.get("turn")) or _int_value(data.get("turn")) or 1


def derive_agent_trajectory_state(events: list[dict[str, Any]]) -> dict[str, Any]:
    """Derive open-turn, open-tool, and terminal-error state from envelopes."""

    open_turns: set[int] = set()
    open_calls: dict[str, int] = {}
    last_error: dict[str, Any] | None = None
    for event in sorted(events, key=lambda item: int(item.get("seq") or 0)):
        data = _record(event.get("data"))
        turn = _state_turn(data, event)
        event_type = event.get("type")
        if event_type == "turn/start":
            open_turns.add(turn)
        elif event_type == "turn/end":
            open_turns.discard(turn)
            reason = _record(data.get("reason"))
            if reason.get("kind") == "error":
                last_error = {
                    "kind": "error",
                    "message": str(reason.get("error") or reason.get("message") or "Agent 运行失败"),
                    "turn": turn,
                }
            elif last_error is not None and last_error.get("turn") == turn:
                last_error = None
        elif event_type == "tool/call":
            call_id = data.get("callId")
            if isinstance(call_id, str) and call_id:
                open_calls[call_id] = turn
        elif event_type == "tool/result":
            call_id = data.get("callId")
            if isinstance(call_id, str):
                open_calls.pop(call_id, None)

    running_call_ids = [call_id for call_id, turn in open_calls.items() if turn in open_turns]
    return {
        "is_running": bool(open_turns),
        "running_call_ids": running_call_ids,
        "last_error": last_error,
    }


def canonical_event_status(event_type: str, data: dict[str, Any]) -> str:
    if event_type in {"turn/start", "step/start", "assistant/chunk", "tool/call"}:
        return "running"
    if event_type == "turn/end":
        return str(_record(data.get("reason")).get("kind") or "completed")
    if event_type == "tool/result":
        return "error" if data.get("isError") or data.get("error") else "completed"
    if event_type in {"step/end", "assistant/message"}:
        return "completed"
    return "info"
