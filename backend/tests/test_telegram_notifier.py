import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace

import httpx
import pytest


def test_render_test_message_is_fixed_chinese_and_shanghai_time():
    from telegram_notifier import render_test_message

    tested_at = datetime(2026, 7, 25, 13, 6, 7, tzinfo=timezone.utc)

    message = render_test_message(tested_at)

    assert "WeMedia Studio Telegram 连接测试成功" in message
    assert "2026-07-25 21:06:07" in message
    assert "<script" not in message


def _decision(**overrides):
    data = {
        "id": 7,
        "action": "translate_quote",
        "score": 88,
        "confidence": 0.91,
        "reason": "官方发布重要 API <beta>",
        "summary_cn": "官方发布了新的 API。",
        "comment_draft": None,
        "quote_draft": "OpenAI 发布了新的 Responses API。",
    }
    data.update(overrides)
    return SimpleNamespace(**data)


def test_immediate_message_escapes_html_and_keeps_copy_block():
    from telegram_notifier import render_immediate_messages

    messages = render_immediate_messages(
        _decision(),
        SimpleNamespace(username="OpenAI", url="https://x.com/OpenAI/status/1"),
        SimpleNamespace(label="OpenAI"),
        "http://localhost:3000/x-responses?decision=7",
    )

    assert len(messages) == 1
    assert "&lt;beta&gt;" in messages[0]
    assert "<pre>OpenAI 发布了新的 Responses API。</pre>" in messages[0]
    assert "https://x.com/OpenAI/status/1" in messages[0]
    assert len(messages[0]) < 4096


def test_long_summary_splits_without_splitting_copyable_draft():
    from telegram_notifier import render_immediate_messages

    messages = render_immediate_messages(
        _decision(summary_cn="摘要" * 2200),
        SimpleNamespace(username="OpenAI", url="https://x.com/OpenAI/status/1"),
        SimpleNamespace(label="OpenAI"),
        "http://localhost:3000/x-responses?decision=7",
    )

    assert len(messages) == 2
    assert "<pre>" not in messages[0]
    assert "<pre>OpenAI 发布了新的 Responses API。</pre>" in messages[1]
    assert all(len(message) < 4096 for message in messages)


def test_digest_message_contains_copyable_drafts_and_source_links():
    from telegram_notifier import render_digest_messages

    rows = [(
        _decision(score=62, action="comment", comment_draft="这个更新值得关注。", quote_draft=None),
        SimpleNamespace(username="OpenAI", url="https://x.com/OpenAI/status/1"),
        SimpleNamespace(label="OpenAI"),
    )]

    messages = render_digest_messages(
        rows,
        "2026-07-25",
        "http://localhost:3000/x-responses",
    )

    assert len(messages) == 1
    assert "18:00 摘要" in messages[0]
    assert "<pre>这个更新值得关注。</pre>" in messages[0]
    assert "https://x.com/OpenAI/status/1" in messages[0]


def test_send_html_messages_returns_message_ids():
    from telegram_notifier import send_html_messages

    sent = []

    def handler(request: httpx.Request):
        sent.append(request)
        return httpx.Response(200, json={"ok": True, "result": {"message_id": len(sent)}})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await send_html_messages("token", "chat", ["one", "two"], client=client)

    assert asyncio.run(run()) == [1, 2]
    assert len(sent) == 2


def test_send_html_messages_marks_bad_configuration_non_retryable():
    from telegram_notifier import TelegramSendError, send_html_messages

    def handler(request: httpx.Request):
        return httpx.Response(400, json={"ok": False, "description": "chat not found"})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            await send_html_messages("token", "chat", ["one"], client=client)

    try:
        asyncio.run(run())
    except TelegramSendError as exc:
        assert exc.retryable is False
        assert "chat not found" in str(exc)
    else:
        raise AssertionError("expected TelegramSendError")


def test_request_error_is_redacted_and_severs_sensitive_exception_chain():
    from telegram_notifier import TelegramSendError, send_html_messages

    token = "123456:secret-token"

    def handler(request: httpx.Request):
        raise httpx.ConnectError(
            f"failed for https://api.telegram.org/bot{token}/sendMessage",
            request=request,
        )

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            await send_html_messages(token, "chat", ["one"], client=client)

    with pytest.raises(TelegramSendError) as raised:
        asyncio.run(run())

    error = raised.value
    assert error.retryable is False
    assert error.delivery_unknown is True
    assert error.message_ids == []
    assert token not in str(error)
    assert token not in repr(error)
    assert error.__cause__ is None
    assert error.__context__ is None


def test_telegram_api_error_keeps_semantics_without_echoing_configured_token():
    from telegram_notifier import TelegramSendError, send_html_messages

    token = "123456:secret-token"

    def handler(request: httpx.Request):
        return httpx.Response(400, json={
            "ok": False,
            "description": f"chat not found via bot {token}",
        })

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            await send_html_messages(token, "chat", ["one"], client=client)

    with pytest.raises(TelegramSendError) as raised:
        asyncio.run(run())

    assert "chat not found" in str(raised.value)
    assert token not in str(raised.value)
    assert raised.value.delivery_unknown is False
