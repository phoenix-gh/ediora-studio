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
