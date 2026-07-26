import asyncio
import sys

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture
def api(monkeypatch, tmp_path):
    monkeypatch.setenv(
        "WMS_DATABASE_URL",
        f"sqlite+aiosqlite:///{tmp_path / 'digital-human-router.db'}",
    )
    for module in list(sys.modules):
        if module.startswith(
            (
                "database",
                "models",
                "content_jobs",
                "digital_human_service",
                "routers.digital_humans",
            )
        ):
            sys.modules.pop(module, None)

    from database import Base, SessionLocal, engine, get_db
    import models  # noqa: F401
    import routers.digital_humans as router_module

    async def setup():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.new_event_loop().run_until_complete(setup())
    app = FastAPI()
    app.include_router(router_module.router, prefix="/api")

    async def override_db():
        async with SessionLocal() as session:
            yield session

    app.dependency_overrides[get_db] = override_db
    return TestClient(app), SessionLocal, router_module


def _create_media_assets(session_factory):
    async def run():
        from models import CreativeAsset

        async with session_factory() as session:
            rows = [
                CreativeAsset(
                    asset_type="media",
                    media_kind="image",
                    title="portrait",
                    url="/api/uploads/portrait.png",
                    media_type="image/png",
                    filename="portrait.png",
                ),
                CreativeAsset(
                    asset_type="media",
                    media_kind="audio",
                    title="voice",
                    url="/api/uploads/voice.wav",
                    media_type="audio/wav",
                    filename="voice.wav",
                ),
                CreativeAsset(
                    asset_type="media",
                    media_kind="image",
                    title="environment",
                    url="/api/uploads/environment.jpg",
                    media_type="image/jpeg",
                    filename="environment.jpg",
                ),
            ]
            session.add_all(rows)
            await session.commit()
            return [row.id for row in rows]

    return asyncio.new_event_loop().run_until_complete(run())


def test_create_role_enqueues_setup_job(api, monkeypatch):
    client, session_factory, router_module = api
    portrait, voice, environment = _create_media_assets(session_factory)
    queued = []

    async def capture_enqueue(job_id: int):
        queued.append(job_id)

    monkeypatch.setattr(router_module, "enqueue_job", capture_enqueue)
    response = client.post(
        "/api/digital-humans",
        json={
            "name": "林晓",
            "portrait_asset_id": portrait,
            "voice_sample_asset_id": voice,
            "default_environment_asset_id": environment,
        },
    )

    assert response.status_code == 201, response.text
    assert response.json()["status"] == "processing"
    assert queued == [response.json()["setup_job_id"]]


def test_worker_context_returns_only_required_internal_assets(api, monkeypatch):
    client, session_factory, router_module = api
    portrait, voice, environment = _create_media_assets(session_factory)

    async def no_op(_job_id: int):
        return None

    monkeypatch.setattr(router_module, "enqueue_job", no_op)
    role = client.post(
        "/api/digital-humans",
        json={
            "name": "林晓",
            "portrait_asset_id": portrait,
            "voice_sample_asset_id": voice,
            "default_environment_asset_id": environment,
        },
    ).json()
    context = client.get(
        f"/api/digital-humans/{role['id']}/worker-context"
    ).json()

    assert context["portrait"]["url"].startswith("/api/uploads/")
    assert context["voice_sample"]["media_type"] == "audio/wav"
    assert context["default_environment"]["media_type"] == "image/jpeg"
    assert "api_key" not in context


def test_worker_progress_promotes_avatar_and_voice_together(api, monkeypatch):
    client, session_factory, router_module = api
    portrait, voice, environment = _create_media_assets(session_factory)

    async def no_op(_job_id: int):
        return None

    monkeypatch.setattr(router_module, "enqueue_job", no_op)
    role = client.post(
        "/api/digital-humans",
        json={
            "name": "林晓",
            "portrait_asset_id": portrait,
            "voice_sample_asset_id": voice,
            "default_environment_asset_id": environment,
        },
    ).json()

    partial = client.post(
        f"/api/digital-humans/{role['id']}/worker-progress",
        json={
            "status": "processing",
            "provider_state": {"pending_avatar_id": "avatar-1"},
        },
    )
    assert partial.status_code == 200
    assert partial.json()["heygen_avatar_id"] == ""

    ready = client.post(
        f"/api/digital-humans/{role['id']}/worker-progress",
        json={
            "status": "ready",
            "heygen_avatar_group_id": "group-1",
            "heygen_avatar_id": "avatar-1",
            "heygen_voice_id": "voice-1",
            "provider_state": {"complete": True},
        },
    )
    assert ready.status_code == 200
    assert ready.json()["heygen_avatar_id"] == "avatar-1"
    assert ready.json()["heygen_voice_id"] == "voice-1"

