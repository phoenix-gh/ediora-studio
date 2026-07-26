"""Controlled queue-to-Telegram verification for the X response workflow."""

import asyncio
import sys
from datetime import datetime, timedelta, timezone

import pytest
import httpx
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv(
        "WMS_DATABASE_URL",
        f"sqlite+aiosqlite:///{tmp_path / 'x-response-e2e.db'}",
    )
    monkeypatch.setenv("WMS_DISABLE_SCHEDULER", "1")
    for name in list(sys.modules):
        if name.startswith((
            "database", "models", "main", "routers", "config",
            "content_jobs", "job_queue", "x_response",
        )):
            sys.modules.pop(name, None)

    from database import Base, engine
    import models  # noqa: F401

    async def setup():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.run(setup())
    from main import app
    return TestClient(app)


def _complete_step(client, job_id, key, output):
    started = client.post(f"/api/jobs/{job_id}/steps/{key}/start")
    assert started.status_code == 200, started.text
    completed = client.post(
        f"/api/jobs/{job_id}/steps/{started.json()['id']}/succeed",
        json={"output": output},
    )
    assert completed.status_code == 200, completed.text


def _aware_iso(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def test_controlled_queue_to_telegram_flow_finishes_under_one_minute(client, monkeypatch):
    from database import SessionLocal
    from job_queue import InMemoryJobQueue
    from models import XPost, XSubscription
    from x_response_service import dispatch_response_posts

    queue = InMemoryJobQueue()
    collected_at = datetime.now(timezone.utc)

    async def seed_and_dispatch():
        async with SessionLocal() as db:
            subscription = XSubscription(
                label="OpenAI",
                kind="timeline",
                url="https://x.com/openai",
                enabled=True,
                notify_new_posts=True,
                notify_enabled_at=collected_at - timedelta(minutes=1),
                added_at=collected_at,
            )
            db.add(subscription)
            await db.commit()
            await db.refresh(subscription)
            db.add(XPost(
                tweet_id="controlled-e2e",
                subscription_id=subscription.id,
                username="OpenAI",
                display_name="OpenAI",
                content="We launched a controlled test API.",
                url="https://x.com/OpenAI/status/controlled-e2e",
                published_at=collected_at,
                collected_at=collected_at,
            ))
            await db.commit()
            dispatched = await dispatch_response_posts(
                db,
                subscription,
                ["controlled-e2e"],
                enqueue=queue.enqueue,
            )
        return dispatched, await queue.dequeue()

    dispatched, job_id = asyncio.run(seed_and_dispatch())
    assert dispatched == {"created": 1, "enqueued": 1, "errors": []}

    client.put("/api/settings", json={
        "telegram_bot_token": "test-token",
        "telegram_chat_id": "test-chat",
    })
    sent_messages: list[str] = []

    async def fake_send(_token, _chat_id, messages, **_kwargs):
        sent_messages.extend(messages)
        return [7001]

    import telegram_notifier
    monkeypatch.setattr(telegram_notifier, "send_html_messages", fake_send)

    context = client.get("/api/x/responses/internal/controlled-e2e/context").json()
    assert context["eligible"] is True
    _complete_step(client, job_id, "qualify", context)

    verification = client.post(
        "/api/x/responses/internal/controlled-e2e/verify-links",
    ).json()
    assert verification["verification_status"] == "not_required"
    _complete_step(client, job_id, "verify_links", verification)

    controlled = {
        "action": "comment",
        "score": 90,
        "confidence": 0.95,
        "reason": "官方重要产品更新",
        "summary_cn": "OpenAI 发布了一个新的测试 API。",
        "comment_draft": "这个 API 对真实工作流的延迟改善有多大？期待看到基准数据。",
        "quote_draft": None,
        "claims": [],
        "model_provider": "controlled-test",
        "model_name": "deterministic",
        "prompt_version": "x-response-prompt-v1",
    }
    _complete_step(client, job_id, "decide", {
        "decision": controlled,
        "model_provider": "controlled-test",
        "model_name": "deterministic",
    })

    persisted = client.post(
        "/api/x/responses/internal/controlled-e2e/decision",
        json={
            **controlled,
            "verification_status": verification["verification_status"],
            "verified_urls": [],
        },
    )
    assert persisted.status_code == 200, persisted.text
    decision = persisted.json()
    assert decision["notification_tier"] == "immediate"
    _complete_step(client, job_id, "persist", decision)

    notified = client.post(f"/api/x/responses/{decision['id']}/notify")
    assert notified.status_code == 200, notified.text
    _complete_step(client, job_id, "notify", notified.json())
    completed = client.post(f"/api/jobs/{job_id}/succeed")
    assert completed.status_code == 200, completed.text

    duplicate_notify = client.post(f"/api/x/responses/{decision['id']}/notify")
    assert duplicate_notify.status_code == 200
    assert len(sent_messages) == 1
    assert "<pre>这个 API 对真实工作流的延迟改善有多大？期待看到基准数据。</pre>" in sent_messages[0]

    used = client.post(
        f"/api/x/responses/{decision['id']}/feedback",
        json={"status": "used"},
    )
    assert used.json()["workflow_status"] == "used"
    converted = client.post(f"/api/x/responses/{decision['id']}/convert-to-topic")
    assert converted.status_code == 404
    used_list = client.get(
        "/api/x/responses?workflow_status=used",
    ).json()["items"]
    assert [item["tweet_id"] for item in used_list] == ["controlled-e2e"]

    job = client.get(f"/api/jobs/{job_id}").json()
    assert job["status"] == "succeeded"
    assert [step["key"] for step in job["steps"]] == [
        "qualify", "verify_links", "decide", "persist", "notify",
    ]
    queue_event = next(
        event for event in job["events"]
        if event["kind"] == "queue_dispatched"
    )
    published_at = _aware_iso(context["post"]["published_at"])
    queued_at = _aware_iso(queue_event["created_at"])
    decided_at = _aware_iso(decision["created_at"])
    notified_at = _aware_iso(duplicate_notify.json()["notified_at"])
    assert published_at <= collected_at <= queued_at <= decided_at <= notified_at
    assert (notified_at - collected_at).total_seconds() < 60


def test_telegram_request_error_secret_never_reaches_job_storage_or_api(
    client,
    monkeypatch,
):
    from content_jobs import create_job
    from database import SessionLocal
    from models import ContentJobStep, XPost, XSubscription
    import telegram_notifier

    token = "123456:secret-token"
    now = datetime.now(timezone.utc)

    async def seed():
        async with SessionLocal() as db:
            subscription = XSubscription(
                label="OpenAI",
                kind="timeline",
                url="https://x.com/openai",
                enabled=True,
                notify_new_posts=True,
                notify_enabled_at=now - timedelta(minutes=1),
            )
            db.add(subscription)
            await db.commit()
            await db.refresh(subscription)
            db.add(XPost(
                tweet_id="secret-e2e",
                subscription_id=subscription.id,
                username="OpenAI",
                display_name="OpenAI",
                content="A release",
                url="https://x.com/OpenAI/status/secret-e2e",
                published_at=now,
                collected_at=now,
            ))
            await db.commit()
            return await create_job(
                db,
                flow="x_response",
                title="secret regression",
                input_data={"tweet_id": "secret-e2e"},
            )

    job = asyncio.run(seed())
    decision_body = {
        "action": "comment",
        "score": 90,
        "confidence": 0.95,
        "reason": "官方重要产品更新",
        "summary_cn": "OpenAI 发布了新功能。",
        "comment_draft": "这个更新带来了哪些实际改进？",
        "quote_draft": None,
        "claims": [],
        "verification_status": "not_required",
        "verified_urls": [],
        "model_provider": "controlled-test",
        "model_name": "deterministic",
        "prompt_version": "x-response-prompt-v1",
    }
    decision = client.post(
        "/api/x/responses/internal/secret-e2e/decision",
        json=decision_body,
    ).json()
    client.put("/api/settings", json={
        "telegram_bot_token": token,
        "telegram_chat_id": "test-chat",
    })
    real_send = telegram_notifier.send_html_messages

    def fail_transport(request: httpx.Request):
        raise httpx.ConnectError(
            f"failed for https://api.telegram.org/bot{token}/sendMessage",
            request=request,
        )

    async def request_error_send(token_value, chat_id, messages, **_kwargs):
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(fail_transport),
        ) as transport_client:
            return await real_send(
                token_value,
                chat_id,
                messages,
                client=transport_client,
            )

    monkeypatch.setattr(
        telegram_notifier,
        "send_html_messages",
        request_error_send,
    )

    started = client.post(f"/api/jobs/{job.id}/steps/notify/start").json()
    notify = client.post(f"/api/x/responses/{decision['id']}/notify")
    assert notify.status_code == 503
    assert token not in notify.text
    failed = client.post(
        f"/api/jobs/{job.id}/steps/{started['id']}/fail",
        json={"error": notify.text, "retryable": True},
    )
    assert failed.status_code == 200, failed.text

    async def stored_error():
        async with SessionLocal() as db:
            step = await db.get(ContentJobStep, started["id"])
            return step.error

    persisted = asyncio.run(stored_error())
    public_job = client.get(f"/api/jobs/{job.id}")
    observable = notify.text + failed.text + public_job.text + persisted
    assert token not in observable
    assert "bot***/sendMessage" in observable
