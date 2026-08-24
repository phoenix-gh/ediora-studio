"""Token usage aggregation for durable Agent task logs."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any


_INPUT_KEYS = ("inputTokens", "input_tokens", "promptTokens", "prompt_tokens")
_OUTPUT_KEYS = ("outputTokens", "output_tokens", "completionTokens", "completion_tokens")
_TOTAL_KEYS = ("totalTokens", "total_tokens", "total")
_REASONING_KEYS = ("reasoningTokens", "reasoning_tokens")
_CACHED_INPUT_KEYS = (
    "cachedInputTokens",
    "cached_input_tokens",
    "cacheReadInputTokens",
    "cache_read_input_tokens",
)


def _value(event: object, key: str, default: Any = None) -> Any:
    if isinstance(event, Mapping):
        return event.get(key, default)
    return getattr(event, key, default)


def _record(value: object) -> dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


def _token_count(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int) and value >= 0:
        return value
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


def _first_count(usage: Mapping[str, Any], keys: tuple[str, ...]) -> int | None:
    for key in keys:
        value = _token_count(usage.get(key))
        if value is not None:
            return value
    return None


def _event_usage(event: object) -> tuple[str, dict[str, Any]]:
    event_type = str(_value(event, "event_type", _value(event, "type", "")))
    payload = _record(_value(event, "payload_data"))
    if not payload:
        payload = _record(_value(event, "payload"))
    usage = _record(payload.get("usage"))
    if not usage:
        usage = _record(_value(event, "usage_data"))
    if not usage:
        usage = _record(_value(event, "usage"))
    return event_type, usage


def _normalize_usage(usage: Mapping[str, Any]) -> dict[str, int]:
    input_tokens = _first_count(usage, _INPUT_KEYS)
    output_tokens = _first_count(usage, _OUTPUT_KEYS)
    total_tokens = _first_count(usage, _TOTAL_KEYS)
    if total_tokens is None and (input_tokens is not None or output_tokens is not None):
        total_tokens = (input_tokens or 0) + (output_tokens or 0)

    normalized: dict[str, int] = {}
    for name, value in (
        ("input_tokens", input_tokens),
        ("output_tokens", output_tokens),
        ("total_tokens", total_tokens),
        ("reasoning_tokens", _first_count(usage, _REASONING_KEYS)),
        ("cached_input_tokens", _first_count(usage, _CACHED_INPUT_KEYS)),
    ):
        if value is not None:
            normalized[name] = value
    return normalized


def aggregate_token_usage(events: Iterable[object]) -> dict[str, int] | None:
    """Aggregate one task's model usage without double-counting compatibility rows.

    Canonical ``assistant/message`` events are preferred.  Older jobs that only
    have ``llm/response`` audit rows remain readable through the fallback.
    """

    canonical: list[dict[str, int]] = []
    legacy: list[dict[str, int]] = []
    for event in events:
        event_type, usage = _event_usage(event)
        normalized = _normalize_usage(usage)
        if not normalized:
            continue
        if event_type == "assistant/message":
            canonical.append(normalized)
        elif event_type == "llm/response":
            legacy.append(normalized)

    samples = canonical or legacy
    if not samples:
        return None

    totals: dict[str, int] = {"request_count": len(samples)}
    for sample in samples:
        for key, value in sample.items():
            totals[key] = totals.get(key, 0) + value
    return totals
