from agent_token_usage import aggregate_token_usage


def test_aggregate_token_usage_sums_canonical_assistant_messages_once():
    events = [
        {
            "event_type": "assistant/message",
            "payload_data": {
                "usage": {
                    "inputTokens": 120,
                    "outputTokens": 30,
                    "totalTokens": 150,
                },
            },
        },
        {
            "event_type": "llm/response",
            "payload_data": {
                "usage": {
                    "inputTokens": 120,
                    "outputTokens": 30,
                    "totalTokens": 150,
                },
            },
        },
        {
            "event_type": "assistant/message",
            "payload_data": {
                "usage": {
                    "input_tokens": 80,
                    "output_tokens": 20,
                },
            },
        },
    ]

    assert aggregate_token_usage(events) == {
        "input_tokens": 200,
        "output_tokens": 50,
        "total_tokens": 250,
        "request_count": 2,
    }


def test_aggregate_token_usage_falls_back_to_legacy_responses_when_needed():
    events = [
        {
            "event_type": "llm/response",
            "payload_data": {
                "usage": {
                    "prompt_tokens": "7",
                    "completion_tokens": "3",
                },
            },
        },
        {
            "event_type": "llm/response",
            "payload_data": {"text": "no usage"},
        },
    ]

    assert aggregate_token_usage(events) == {
        "input_tokens": 7,
        "output_tokens": 3,
        "total_tokens": 10,
        "request_count": 1,
    }


def test_aggregate_token_usage_returns_none_without_usable_usage():
    assert aggregate_token_usage([
        {
            "event_type": "assistant/message",
            "payload_data": {"usage": {"totalTokens": "invalid"}},
        },
    ]) is None
