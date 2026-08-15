import asyncio
import sys
import traceback

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch, postgres_env):
    for module in list(sys.modules):
        if module.startswith(("database", "models", "main", "routers", "config")):
            sys.modules.pop(module, None)
    from database import Base, engine
    import models  # noqa: F401

    async def create_schema():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.new_event_loop().run_until_complete(create_schema())
    from main import app
    return TestClient(app)


def test_settings_persists_searxng_provider(client):
    response = client.put("/api/settings", json={"web_search_providers": [{
        "key": "searxng", "enabled": True, "base_url": "http://searxng:8080", "timeout_seconds": 12,
    }]})

    assert response.status_code == 200, response.text
    assert response.json()["web_search_providers"] == [{
        "key": "searxng", "enabled": True, "base_url": "http://searxng:8080", "timeout_seconds": 12,
    }]


def test_settings_rejects_non_http_search_url(client):
    response = client.put("/api/settings", json={"web_search_providers": [{
        "key": "searxng", "enabled": True, "base_url": "file:///tmp", "timeout_seconds": 12,
    }]})

    assert response.status_code == 422


def test_settings_persists_web_fetch_provider_order(client):
    providers = [
        {"key": "direct", "enabled": True, "base_url": "", "timeout_seconds": 12},
        {"key": "jina_reader", "enabled": True, "base_url": "https://r.jina.ai", "timeout_seconds": 20},
        {"key": "camofox", "enabled": False, "base_url": "", "timeout_seconds": 30},
    ]

    response = client.put("/api/settings", json={"web_fetch_providers": providers})

    assert response.status_code == 200, response.text
    assert response.json()["web_fetch_providers"] == providers


def test_telegram_token_is_write_only(client):
    response = client.put("/api/settings", json={
        "telegram_bot_token": "123456:secret-token",
        "telegram_chat_id": "-100123",
    })

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["telegram_bot_token_set"] is True
    assert body["telegram_bot_token_preview"] == "…oken"
    assert body["telegram_chat_id"] == "-100123"
    assert "telegram_bot_token" not in body


def test_telegram_test_uses_only_saved_credentials_and_persists_success(client, monkeypatch):
    client.put("/api/settings", json={
        "telegram_bot_token": "saved-token",
        "telegram_chat_id": "-100123",
    })
    captured = {}

    async def fake_send(token, chat_id, messages, **_kwargs):
        captured.update(token=token, chat_id=chat_id, messages=messages)
        return [91]

    monkeypatch.setattr("telegram_notifier.send_html_messages", fake_send)

    response = client.post("/api/settings/telegram/test", json={
        "telegram_bot_token": "request-token",
        "telegram_chat_id": "-100999",
    })

    assert response.status_code == 200, response.text
    assert captured["token"] == "saved-token"
    assert captured["chat_id"] == "-100123"
    assert len(captured["messages"]) == 1
    assert "Ediora Telegram 连接测试成功" in captured["messages"][0]
    body = response.json()
    assert body["telegram_test_status"] == "success"
    assert body["telegram_last_tested_at"]
    assert body["telegram_last_test_error"] == ""
    assert "telegram_bot_token" not in body
    assert "saved-token" not in response.text
    assert "request-token" not in response.text


def test_telegram_test_failure_keeps_configuration_and_bounds_redacted_error(client, monkeypatch):
    from telegram_notifier import TelegramSendError

    client.put("/api/settings", json={
        "telegram_bot_token": "saved-token",
        "telegram_chat_id": "-100123",
    })

    async def fail_send(*_args, **_kwargs):
        raise TelegramSendError(
            "POST https://api.telegram.org/botsaved-token/sendMessage "
            "auth_token=raw-x-token " + "x" * 600,
            retryable=False,
        )

    monkeypatch.setattr("telegram_notifier.send_html_messages", fail_send)

    response = client.post("/api/settings/telegram/test")

    assert response.status_code == 503
    assert "saved-token" not in response.text
    assert "raw-x-token" not in response.text
    settings = client.get("/api/settings").json()
    assert settings["telegram_bot_token_set"] is True
    assert settings["telegram_bot_token_preview"] == "…oken"
    assert settings["telegram_chat_id"] == "-100123"
    assert settings["telegram_test_status"] == "failed"
    assert settings["telegram_last_tested_at"]
    assert len(settings["telegram_last_test_error"]) == 500
    assert "saved-token" not in settings["telegram_last_test_error"]
    assert "raw-x-token" not in settings["telegram_last_test_error"]


def test_telegram_test_with_empty_saved_configuration_persists_safe_failure(client):
    response = client.post("/api/settings/telegram/test")

    assert response.status_code == 503
    assert response.json()["detail"] == "Telegram Bot Token 或 Chat ID 未配置"
    settings = client.get("/api/settings").json()
    assert settings["telegram_bot_token_set"] is False
    assert settings["telegram_chat_id"] == ""
    assert settings["telegram_test_status"] == "failed"
    assert settings["telegram_last_tested_at"]
    assert settings["telegram_last_test_error"] == "Telegram Bot Token 或 Chat ID 未配置"


def test_telegram_test_unexpected_failure_is_redacted_and_persisted(client, monkeypatch):
    client.put("/api/settings", json={
        "telegram_bot_token": "saved-token",
        "telegram_chat_id": "-100123",
    })

    async def fail_send(*_args, **_kwargs):
        raise RuntimeError(
            "transport failed at https://api.telegram.org/botsaved-token/sendMessage",
        )

    monkeypatch.setattr("telegram_notifier.send_html_messages", fail_send)

    response = client.post("/api/settings/telegram/test")

    assert response.status_code == 503
    assert "saved-token" not in response.text
    settings = client.get("/api/settings").json()
    assert settings["telegram_test_status"] == "failed"
    assert settings["telegram_last_test_error"] == (
        "transport failed at https://api.telegram.org/bot***/sendMessage"
    )


def test_telegram_test_metadata_failure_has_fixed_response_and_no_sensitive_exception_chain(
    client,
    monkeypatch,
    capsys,
):
    import routers.settings as settings_router

    client.put("/api/settings", json={
        "telegram_bot_token": "saved-token",
        "telegram_chat_id": "-100123",
    })

    async def fail_send(*_args, **_kwargs):
        raise RuntimeError(
            "send failed at https://api.telegram.org/botsaved-token/sendMessage",
        )

    async def fail_set_config(_updates):
        raise RuntimeError("database write failed for saved-token")

    monkeypatch.setattr("telegram_notifier.send_html_messages", fail_send)
    monkeypatch.setattr(settings_router, "set_config", fail_set_config)

    safe_client = TestClient(client.app, raise_server_exceptions=False)
    response = safe_client.post("/api/settings/telegram/test")

    assert response.status_code == 503
    assert response.json() == {"detail": "Telegram 测试状态保存失败"}

    with pytest.raises(HTTPException) as raised:
        asyncio.run(settings_router.test_telegram())

    formatted = "".join(
        traceback.format_exception(
            type(raised.value),
            raised.value,
            raised.value.__traceback__,
        ),
    )
    captured = capsys.readouterr()
    observable = response.text + formatted + captured.out + captured.err
    assert raised.value.__cause__ is None
    assert raised.value.__context__ is None
    assert raised.value.__suppress_context__ is True
    assert "saved-token" not in observable
    assert "database write failed" not in observable


def test_telegram_test_does_not_swallow_cancelled_error(client, monkeypatch):
    import routers.settings as settings_router

    client.put("/api/settings", json={
        "telegram_bot_token": "saved-token",
        "telegram_chat_id": "-100123",
    })

    async def cancel_send(*_args, **_kwargs):
        raise asyncio.CancelledError

    monkeypatch.setattr("telegram_notifier.send_html_messages", cancel_send)

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(settings_router.test_telegram())


def test_telegram_save_preserves_blank_token_and_resets_old_test_status(client, monkeypatch):
    client.put("/api/settings", json={
        "telegram_bot_token": "saved-token",
        "telegram_chat_id": "-100123",
    })

    async def fake_send(*_args, **_kwargs):
        return [91]

    monkeypatch.setattr("telegram_notifier.send_html_messages", fake_send)
    assert client.post("/api/settings/telegram/test").status_code == 200

    response = client.put("/api/settings", json={
        "telegram_bot_token": " ",
        "telegram_chat_id": "-100999",
    })

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["telegram_bot_token_set"] is True
    assert body["telegram_bot_token_preview"] == "…oken"
    assert body["telegram_chat_id"] == "-100999"
    assert body["telegram_test_status"] == ""
    assert body["telegram_last_tested_at"] == ""
    assert body["telegram_last_test_error"] == ""


def test_telegram_token_change_resets_old_test_status(client, monkeypatch):
    client.put("/api/settings", json={
        "telegram_bot_token": "first-token",
        "telegram_chat_id": "-100123",
    })

    async def fake_send(*_args, **_kwargs):
        return [91]

    monkeypatch.setattr("telegram_notifier.send_html_messages", fake_send)
    assert client.post("/api/settings/telegram/test").status_code == 200

    response = client.put("/api/settings", json={
        "telegram_bot_token": "second-token",
    })

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["telegram_bot_token_set"] is True
    assert body["telegram_bot_token_preview"] == "…oken"
    assert body["telegram_chat_id"] == "-100123"
    assert body["telegram_test_status"] == ""
    assert body["telegram_last_tested_at"] == ""
    assert body["telegram_last_test_error"] == ""


def test_clear_telegram_removes_credentials_and_test_metadata(client, monkeypatch):
    client.put("/api/settings", json={
        "telegram_bot_token": "saved-token",
        "telegram_chat_id": "-100123",
    })

    async def fake_send(*_args, **_kwargs):
        return [91]

    monkeypatch.setattr("telegram_notifier.send_html_messages", fake_send)
    tested = client.post("/api/settings/telegram/test")
    assert tested.status_code == 200

    response = client.delete("/api/settings/telegram")

    assert response.status_code == 200
    body = response.json()
    assert body["telegram_bot_token_set"] is False
    assert body["telegram_bot_token_preview"] == ""
    assert body["telegram_chat_id"] == ""
    assert body["telegram_test_status"] == ""
    assert body["telegram_last_tested_at"] == ""
    assert body["telegram_last_test_error"] == ""
    assert "telegram_bot_token" not in body
    assert "saved-token" not in response.text
