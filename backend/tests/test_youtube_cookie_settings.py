import asyncio
import sys

import pytest
from fastapi.testclient import TestClient


NETSCAPE_COOKIES = """# Netscape HTTP Cookie File
.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tyoutube-secret
"""


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv(
        "WMS_DATABASE_URL",
        f"sqlite+aiosqlite:///{tmp_path / 'youtube-cookie-settings.db'}",
    )
    monkeypatch.setenv("WMS_DISABLE_SCHEDULER", "1")
    for module in list(sys.modules):
        if module.startswith(("database", "models", "main", "routers", "config")):
            sys.modules.pop(module, None)

    from database import Base, engine
    import models  # noqa: F401

    async def setup():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.new_event_loop().run_until_complete(setup())
    from main import app

    return TestClient(app)


def test_youtube_cookies_are_write_only_and_can_be_cleared(client):
    saved = client.put("/api/settings", json={"youtube_cookies": NETSCAPE_COOKIES})

    assert saved.status_code == 200
    assert saved.json()["youtube_cookies_set"] is True
    assert "youtube-secret" not in saved.text

    fetched = client.get("/api/settings")
    assert fetched.json()["youtube_cookies_set"] is True
    assert "youtube-secret" not in fetched.text

    cleared = client.put("/api/settings", json={"youtube_cookies": ""})

    assert cleared.status_code == 200
    assert cleared.json()["youtube_cookies_set"] is False


def test_youtube_cookies_rejects_http_cookie_header(client):
    response = client.put(
        "/api/settings", json={"youtube_cookies": "Cookie: SID=youtube-secret"}
    )

    assert response.status_code == 422
    assert response.json()["detail"] == "YouTube Cookie 必须是 Netscape cookies.txt 格式"


def test_local_transcription_provider_saves_without_api_key(client):
    """Catches local mode inheriting cloud credential requirements."""
    response = client.put(
        "/api/settings",
        json={"transcription_provider": "local-whisper"},
    )

    assert response.status_code == 200, response.text
    assert response.json()["transcription_provider"] == "local-whisper"
    assert response.json()["transcription_model"] == (
        "Systran/faster-whisper-large-v3"
    )


def test_transcription_provider_rejects_unknown_value(client):
    """Catches misspelled providers being persisted as unusable config."""
    response = client.put(
        "/api/settings",
        json={"transcription_provider": "local-whispr"},
    )

    assert response.status_code == 422
    assert response.json()["detail"] == "不支持的语音转写服务商"


def test_local_transcription_test_uses_real_adapter_without_api_key(
    client,
    monkeypatch,
):
    """Catches the test action only checking a cloud /models endpoint."""
    import routers.settings as settings_router
    from transcription_service import TranscriptionResult

    async def transcribe(request, config):
        assert request.require_word_timestamps is False
        assert request.audio_path.suffix == ".wav"
        assert request.audio_path.exists()
        assert config["transcription_provider"] == "local-whisper"
        return TranscriptionResult(
            words=(),
            segments=(),
            text="",
            language="",
            request_id="local-test",
        )

    monkeypatch.setattr(
        settings_router,
        "transcribe_audio",
        transcribe,
        raising=False,
    )
    saved = client.put(
        "/api/settings",
        json={"transcription_provider": "local-whisper"},
    )
    assert saved.status_code == 200

    response = client.post("/api/settings/transcription/test")

    assert response.status_code == 200
    assert response.json() == {"ok": True, "error": ""}


def test_local_transcription_status_reports_runtime_without_internal_url(
    client,
    monkeypatch,
):
    """Catches the UI status endpoint leaking or misreporting local runtime."""
    import routers.settings as settings_router

    class FakeClient:
        def __init__(self, *_args, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

        async def get(self, url):
            assert url == "http://local-asr:8000/v1/models"
            return settings_router.httpx.Response(
                200,
                json={
                    "data": [{
                        "id": "Systran/faster-whisper-large-v3",
                    }],
                },
            )

    monkeypatch.setattr(
        settings_router.httpx,
        "AsyncClient",
        FakeClient,
    )
    saved = client.put(
        "/api/settings",
        json={"transcription_provider": "local-whisper"},
    )
    assert saved.status_code == 200

    response = client.get("/api/settings/transcription/status")

    assert response.status_code == 200
    assert response.json() == {
        "provider": "local-whisper",
        "status": "ready",
        "model": "Systran/faster-whisper-large-v3",
        "device": "cuda",
        "compute_type": "int8_float16",
        "error": "",
    }
    assert "local-asr" not in response.text
