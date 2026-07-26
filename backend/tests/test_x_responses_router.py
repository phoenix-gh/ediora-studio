import asyncio
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{tmp_path / 'api.db'}")
    monkeypatch.setenv("WMS_DISABLE_SCHEDULER", "1")
    for name in list(sys.modules):
        if name.startswith(("database", "models", "main", "routers", "config", "x_response")):
            sys.modules.pop(name, None)
    from database import Base, SessionLocal, engine
    from models import XPost, XSubscription

    async def setup():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        now = datetime.now(timezone.utc)
        async with SessionLocal() as db:
            sub = XSubscription(
                url="https://x.com/openai",
                label="OpenAI",
                kind="timeline",
                enabled=True,
                notify_new_posts=True,
                notify_enabled_at=now - timedelta(minutes=10),
            )
            db.add(sub)
            await db.commit()
            await db.refresh(sub)
            db.add(XPost(
                tweet_id="t1",
                subscription_id=sub.id,
                username="OpenAI",
                display_name="OpenAI",
                content="We launched a new API https://official.example/announcement",
                raw_markdown="We launched a new API https://official.example/announcement",
                url="https://x.com/OpenAI/status/t1",
                published_at=now,
                collected_at=now,
            ))
            await db.commit()

    asyncio.run(setup())
    from main import app
    return TestClient(app)


def _decision_body():
    return {
        "action": "translate_quote",
        "score": 88,
        "confidence": 0.91,
        "reason": "官方发布重要 API",
        "summary_cn": "OpenAI 发布了新的 API。",
        "comment_draft": None,
        "quote_draft": "OpenAI 发布了新的 Responses API。",
        "claims": [],
        "verification_status": "verified",
        "verified_urls": [{"url": "https://official.example/announcement"}],
        "model_provider": "openai",
        "model_name": "gpt-test",
        "prompt_version": "x-response-prompt-v1",
    }


def test_worker_context_returns_eligible_post_and_neutral_profile(client):
    response = client.get("/api/x/responses/internal/t1/context")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["eligible"] is True
    assert body["post"]["tweet_id"] == "t1"
    assert body["account_profile"]["positioning"] == "中文科技从业者"
    assert body["external_urls"] == ["https://official.example/announcement"]


@pytest.mark.parametrize(
    ("platform", "is_active"),
    [("wechat", True), ("x", False)],
)
def test_worker_context_defensively_ignores_invalid_saved_publish_account(
    client,
    platform,
    is_active,
):
    from config import set_config
    from database import SessionLocal
    from models import PublishAccount

    async def seed():
        async with SessionLocal() as db:
            db.add(PublishAccount(
                id="unsafe",
                name="Unsafe",
                platform=platform,
                is_active=is_active,
                positioning="不应使用",
            ))
            await db.commit()
        await set_config({"x_response_account_id": "unsafe"})

    asyncio.run(seed())
    body = client.get("/api/x/responses/internal/t1/context").json()

    assert body["account_profile"]["id"] == ""
    assert body["account_profile"]["positioning"] == "中文科技从业者"


def test_decision_persists_and_list_filters(client):
    created = client.post("/api/x/responses/internal/t1/decision", json=_decision_body())
    assert created.status_code == 200, created.text
    assert created.json()["notification_tier"] == "immediate"

    listed = client.get("/api/x/responses?action=translate_quote&workflow_status=ready").json()
    assert len(listed["items"]) == 1
    assert listed["items"][0]["tweet_id"] == "t1"
    assert listed["items"][0]["source_label"] == "OpenAI"


def test_feedback_is_idempotent_and_convert_route_is_removed(client):
    decision = client.post("/api/x/responses/internal/t1/decision", json=_decision_body()).json()

    used = client.post(f"/api/x/responses/{decision['id']}/feedback", json={"status": "used"})
    assert used.status_code == 200
    assert used.json()["workflow_status"] == "used"
    assert client.post(
        f"/api/x/responses/{decision['id']}/feedback", json={"status": "used"},
    ).status_code == 200

    converted = client.post(f"/api/x/responses/{decision['id']}/convert-to-topic")
    assert converted.status_code == 404


def test_notify_is_idempotent(client, monkeypatch):
    decision = client.post("/api/x/responses/internal/t1/decision", json=_decision_body()).json()
    client.put("/api/settings", json={
        "telegram_bot_token": "token",
        "telegram_chat_id": "chat",
    })
    calls = []

    async def fake_send(token, chat_id, messages, **kwargs):
        calls.append((token, chat_id, messages))
        return [321]

    import telegram_notifier
    monkeypatch.setattr(telegram_notifier, "send_html_messages", fake_send)

    first = client.post(f"/api/x/responses/{decision['id']}/notify")
    second = client.post(f"/api/x/responses/{decision['id']}/notify")
    assert first.status_code == 200, first.text
    assert second.status_code == 200
    assert first.json()["telegram_status"] == "sent"
    assert second.json()["telegram_message_ids"] == [321]
    assert len(calls) == 1


def test_rejects_english_only_publishable_draft(client):
    body = _decision_body()
    body["quote_draft"] = "OpenAI launched Responses API."
    response = client.post("/api/x/responses/internal/t1/decision", json=body)
    assert response.status_code == 422


def test_digest_send_is_idempotent(client, monkeypatch):
    body = _decision_body()
    body.update({
        "action": "comment",
        "score": 60,
        "confidence": 0.8,
        "comment_draft": "这个更新值得关注。",
        "quote_draft": None,
    })
    decision = client.post("/api/x/responses/internal/t1/decision", json=body).json()
    assert decision["notification_tier"] == "digest"
    client.put("/api/settings", json={
        "telegram_bot_token": "token",
        "telegram_chat_id": "chat",
    })
    calls = []

    async def fake_send(token, chat_id, messages, **kwargs):
        calls.append((token, chat_id, messages))
        return [901]

    import telegram_notifier
    monkeypatch.setattr(telegram_notifier, "send_html_messages", fake_send)

    date_key = datetime.now(ZoneInfo("Asia/Shanghai")).date().isoformat()
    first = client.post("/api/x/responses/digest/send", json={"date": date_key})
    second = client.post("/api/x/responses/digest/send", json={"date": date_key})

    assert first.status_code == 200, first.text
    assert first.json() == {"sent": 1, "message_ids": [901]}
    assert second.json() == {"sent": 0, "message_ids": []}
    assert len(calls) == 1
    listed = client.get("/api/x/responses").json()["items"]
    assert listed[0]["telegram_status"] == "sent"


def test_notify_claim_prevents_concurrent_duplicate_send(client, monkeypatch):
    decision = client.post(
        "/api/x/responses/internal/t1/decision",
        json=_decision_body(),
    ).json()
    client.put("/api/settings", json={
        "telegram_bot_token": "token",
        "telegram_chat_id": "chat",
    })
    entered = threading.Event()
    release = threading.Event()
    calls = 0
    calls_lock = threading.Lock()

    async def blocking_send(*_args, **_kwargs):
        nonlocal calls
        with calls_lock:
            calls += 1
        entered.set()
        await asyncio.to_thread(release.wait, 5)
        return [711]

    import telegram_notifier
    monkeypatch.setattr(telegram_notifier, "send_html_messages", blocking_send)

    url = f"/api/x/responses/{decision['id']}/notify"
    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(client.post, url)
        assert entered.wait(2)
        second = executor.submit(client.post, url)
        second_response = second.result(timeout=2)
        release.set()
        first_response = first.result(timeout=5)

    assert first_response.status_code == 200
    assert second_response.status_code == 200
    assert calls == 1
    assert client.get(f"/api/x/responses/{decision['id']}").json()[
        "telegram_status"
    ] == "sent"


def test_notify_request_error_with_partial_delivery_is_unknown_and_never_retried(
    client,
    monkeypatch,
):
    from telegram_notifier import TelegramSendError

    decision = client.post(
        "/api/x/responses/internal/t1/decision",
        json=_decision_body(),
    ).json()
    client.put("/api/settings", json={
        "telegram_bot_token": "123456:secret-token",
        "telegram_chat_id": "chat",
    })
    calls = 0

    async def unknown_send(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        raise TelegramSendError(
            "network timed out",
            retryable=False,
            message_ids=[701],
            delivery_unknown=True,
        )

    import telegram_notifier
    monkeypatch.setattr(telegram_notifier, "send_html_messages", unknown_send)
    url = f"/api/x/responses/{decision['id']}/notify"

    first = client.post(url)
    second = client.post(url)
    stored = client.get(f"/api/x/responses/{decision['id']}").json()

    assert first.status_code == 503
    assert first.headers["x-wms-retryable"] == "false"
    assert second.status_code == 200
    assert calls == 1
    assert stored["telegram_status"] == "unknown"
    assert stored["telegram_message_ids"] == [701]


@pytest.mark.parametrize(
    ("retryable", "expected"),
    [(False, "false"), (True, "true")],
)
def test_notify_exposes_safe_retryability_contract(
    client,
    monkeypatch,
    retryable,
    expected,
):
    from telegram_notifier import TelegramSendError

    decision = client.post(
        "/api/x/responses/internal/t1/decision",
        json=_decision_body(),
    ).json()
    client.put("/api/settings", json={
        "telegram_bot_token": "123456:secret-token",
        "telegram_chat_id": "chat",
    })

    async def fail_send(*_args, **_kwargs):
        raise TelegramSendError(
            "Too Many Requests" if retryable else "chat not found",
            retryable=retryable,
        )

    import telegram_notifier
    monkeypatch.setattr(telegram_notifier, "send_html_messages", fail_send)

    response = client.post(f"/api/x/responses/{decision['id']}/notify")

    assert response.status_code == 503
    assert response.headers["x-wms-retryable"] == expected
    assert "secret-token" not in response.text


def test_concurrent_digest_claims_one_non_overlapping_decision_set(client, monkeypatch):
    from database import SessionLocal
    from models import XPost

    now = datetime.now(timezone.utc)

    async def seed_second_post():
        async with SessionLocal() as db:
            db.add(XPost(
                tweet_id="t2",
                subscription_id=1,
                username="AnthropicAI",
                display_name="Anthropic",
                content="Second update",
                raw_markdown="Second update",
                url="https://x.com/AnthropicAI/status/t2",
                published_at=now,
                collected_at=now,
            ))
            await db.commit()

    asyncio.run(seed_second_post())
    digest_body = _decision_body()
    digest_body.update({
        "action": "comment",
        "score": 60,
        "confidence": 0.8,
        "comment_draft": "这个更新值得关注。",
        "quote_draft": None,
    })
    assert client.post(
        "/api/x/responses/internal/t1/decision",
        json=digest_body,
    ).status_code == 200
    assert client.post(
        "/api/x/responses/internal/t2/decision",
        json=digest_body,
    ).status_code == 200
    client.put("/api/settings", json={
        "telegram_bot_token": "token",
        "telegram_chat_id": "chat",
    })
    entered = threading.Event()
    release = threading.Event()
    sends: list[list[str]] = []

    async def blocking_send(_token, _chat_id, messages, **_kwargs):
        sends.append(messages)
        entered.set()
        await asyncio.to_thread(release.wait, 5)
        return [801]

    import telegram_notifier
    monkeypatch.setattr(telegram_notifier, "send_html_messages", blocking_send)
    date_key = datetime.now(ZoneInfo("Asia/Shanghai")).date().isoformat()

    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(
            client.post,
            "/api/x/responses/digest/send",
            json={"date": date_key},
        )
        assert entered.wait(2)
        second = executor.submit(
            client.post,
            "/api/x/responses/digest/send",
            json={"date": date_key},
        )
        second_response = second.result(timeout=2)
        release.set()
        first_response = first.result(timeout=5)

    assert first_response.json()["sent"] == 2
    assert second_response.json() == {"sent": 0, "message_ids": []}
    assert len(sends) == 1


def test_digest_partial_delivery_is_unknown_and_preserves_message_ids(
    client,
    monkeypatch,
):
    from telegram_notifier import TelegramSendError

    body = _decision_body()
    body.update({
        "action": "comment",
        "score": 60,
        "confidence": 0.8,
        "comment_draft": "这个更新值得关注。",
        "quote_draft": None,
    })
    decision = client.post(
        "/api/x/responses/internal/t1/decision",
        json=body,
    ).json()
    client.put("/api/settings", json={
        "telegram_bot_token": "token",
        "telegram_chat_id": "chat",
    })
    calls = 0

    async def partial_send(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        raise TelegramSendError(
            "second message timed out",
            retryable=False,
            message_ids=[911],
            delivery_unknown=True,
        )

    import telegram_notifier
    monkeypatch.setattr(telegram_notifier, "send_html_messages", partial_send)
    date_key = datetime.now(ZoneInfo("Asia/Shanghai")).date().isoformat()

    first = client.post(
        "/api/x/responses/digest/send",
        json={"date": date_key},
    )
    second = client.post(
        "/api/x/responses/digest/send",
        json={"date": date_key},
    )
    stored = client.get(f"/api/x/responses/{decision['id']}").json()

    assert first.status_code == 503
    assert first.headers["x-wms-retryable"] == "false"
    assert second.json() == {"sent": 0, "message_ids": []}
    assert calls == 1
    assert stored["telegram_status"] == "unknown"
    assert stored["telegram_message_ids"] == [911]
