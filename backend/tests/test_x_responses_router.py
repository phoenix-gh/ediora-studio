import asyncio
import sys
from datetime import datetime, timedelta, timezone

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


def test_decision_persists_and_list_filters(client):
    created = client.post("/api/x/responses/internal/t1/decision", json=_decision_body())
    assert created.status_code == 200, created.text
    assert created.json()["notification_tier"] == "immediate"

    listed = client.get("/api/x/responses?action=translate_quote&workflow_status=ready").json()
    assert len(listed["items"]) == 1
    assert listed["items"][0]["tweet_id"] == "t1"
    assert listed["items"][0]["source_label"] == "OpenAI"


def test_feedback_and_convert_are_idempotent(client):
    decision = client.post("/api/x/responses/internal/t1/decision", json=_decision_body()).json()

    used = client.post(f"/api/x/responses/{decision['id']}/feedback", json={"status": "used"})
    assert used.status_code == 200
    assert used.json()["workflow_status"] == "used"
    assert client.post(
        f"/api/x/responses/{decision['id']}/feedback", json={"status": "used"},
    ).status_code == 200

    converted = client.post(f"/api/x/responses/{decision['id']}/convert-to-topic")
    assert converted.status_code == 200
    assert converted.json()["workflow_status"] == "converted"
    assert client.post(f"/api/x/responses/{decision['id']}/convert-to-topic").status_code == 200


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
