import asyncio
import sys

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch, postgres_env):
    for module in list(sys.modules):
        if module.startswith((
            "config",
            "database",
            "models",
            "routers.settings",
        )):
            sys.modules.pop(module, None)

    from database import Base, SessionLocal, engine, get_db
    import models  # noqa: F401
    import routers.settings as settings_router

    async def create_schema():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.new_event_loop().run_until_complete(create_schema())

    app = FastAPI()
    app.include_router(settings_router.router, prefix="/api")

    async def override_db():
        async with SessionLocal() as session:
            yield session

    app.dependency_overrides[get_db] = override_db
    return TestClient(app)


def test_text_video_defaults_are_public_and_normalized(client):
    body = client.get("/api/settings").json()

    props = body["text_video_template_defaults"]["tech-text-v1@1"]
    assert props["brandTitle"] == "EDIORA"
    assert props["brandSubtitle"] == "述策"
    assert props["accentColor"] == "#69F6FF"


def test_text_video_default_overrides_are_persisted_normalized_and_public(client):
    saved = client.put("/api/settings", json={
        "text_video_template_defaults": {
            "tech-text-v1@1": {
                "brandTitle": "  CHANNEL ONE  ",
                "accentColor": "#ff3366",
            },
        },
    })

    assert saved.status_code == 200, saved.text
    props = saved.json()["text_video_template_defaults"]["tech-text-v1@1"]
    assert props["brandTitle"] == "CHANNEL ONE"
    assert props["brandSubtitle"] == "述策"
    assert props["accentColor"] == "#FF3366"

    fetched = client.get("/api/settings")
    assert fetched.status_code == 200, fetched.text
    assert (
        fetched.json()["text_video_template_defaults"]["tech-text-v1@1"]
        == props
    )


def test_text_video_default_update_rejects_bad_map_atomically(client):
    rejected = client.put("/api/settings", json={
        "text_video_template_defaults": {
            "tech-text-v1@1": {"brandTitle": "CHANNEL ONE"},
            "not-a-template@1": {},
        },
    })

    assert rejected.status_code == 422, rejected.text
    current = client.get("/api/settings").json()
    assert (
        current["text_video_template_defaults"]["tech-text-v1@1"]
        ["brandTitle"]
        == "EDIORA"
    )


def test_text_video_defaults_fall_back_when_stored_json_is_corrupt(client):
    from database import SessionLocal
    from models import AppSetting

    async def corrupt_stored_setting():
        async with SessionLocal() as session:
            session.add(AppSetting(
                key="text_video_template_defaults",
                value="{not json",
            ))
            await session.commit()

    asyncio.new_event_loop().run_until_complete(corrupt_stored_setting())
    import config

    config._cache = {}
    config._cache_ts = 0.0

    response = client.get("/api/settings")

    assert response.status_code == 200, response.text
    assert (
        response.json()["text_video_template_defaults"]["tech-text-v1@1"]
        ["brandTitle"]
        == "EDIORA"
    )
