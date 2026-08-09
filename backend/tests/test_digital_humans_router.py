import asyncio
import sys

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture
def api(monkeypatch, postgres_env):
    monkeypatch.setenv("HEYGEN_API_KEY", "test-heygen-key")
    monkeypatch.setenv(
        "WMS_WORKER_TOKEN", "test-worker-token-at-least-32-chars"
    )
    for module in list(sys.modules):
        if module.startswith(
            (
                "config",
                "database",
                "models",
                "content_jobs",
                "digital_human_assets",
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
    return (
        TestClient(
            app,
            headers={
                "X-WMS-Worker-Token": "test-worker-token-at-least-32-chars"
            },
        ),
        SessionLocal,
        router_module,
    )


def _job_headers(role: dict) -> dict[str, str]:
    return {"X-Content-Job-Id": str(role["setup_job_id"])}


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


def _asset_directories(session_factory, asset_ids):
    async def run():
        from models import CreativeAsset

        async with session_factory() as session:
            assets = [
                await session.get(CreativeAsset, asset_id)
                for asset_id in asset_ids
            ]
            return [
                asset.directory if asset is not None else None
                for asset in assets
            ]

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
    assert _asset_directories(
        session_factory, [portrait, voice, environment]
    ) == ["数字人资产", "数字人资产", "数字人资产"]


def test_create_role_rejects_missing_heygen_configuration(api, monkeypatch):
    client, session_factory, _ = api
    portrait, voice, environment = _create_media_assets(session_factory)
    monkeypatch.delenv("HEYGEN_API_KEY")

    response = client.post(
        "/api/digital-humans",
        json={
            "name": "林晓",
            "portrait_asset_id": portrait,
            "voice_sample_asset_id": voice,
            "default_environment_asset_id": environment,
        },
    )

    assert response.status_code == 409
    assert response.json()["detail"] == "请先配置 HeyGen API Key"


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
        f"/api/digital-humans/{role['id']}/worker-context",
        headers=_job_headers(role),
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
        headers=_job_headers(role),
        json={
            "status": "processing",
            "provider_state": {"pending_avatar_id": "avatar-1"},
        },
    )
    assert partial.status_code == 200
    assert partial.json()["heygen_avatar_id"] == ""

    ready = client.post(
        f"/api/digital-humans/{role['id']}/worker-progress",
        headers=_job_headers(role),
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


def test_stale_setup_job_cannot_overwrite_newer_role_state(api, monkeypatch):
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
    old_job_id = role["setup_job_id"]

    async def replace_job():
        from content_jobs import create_job
        from models import DigitalHuman

        async with session_factory() as session:
            current = await session.get(DigitalHuman, role["id"])
            new_job = await create_job(
                session,
                flow="digital_human_setup",
                title="new setup",
                input_data={"digital_human_id": role["id"]},
                commit=False,
            )
            current.setup_job_id = new_job.id
            current.provider_state = {"new": True}
            await session.commit()
            return new_job.id

    new_job_id = asyncio.new_event_loop().run_until_complete(replace_job())
    stale_context = client.get(
        f"/api/digital-humans/{role['id']}/worker-context",
        headers={"X-Content-Job-Id": str(old_job_id)},
    )
    stale = client.post(
        f"/api/digital-humans/{role['id']}/worker-progress",
        headers={"X-Content-Job-Id": str(old_job_id)},
        json={
            "status": "ready",
            "heygen_avatar_id": "stale-avatar",
            "heygen_voice_id": "stale-voice",
            "provider_state": {"stale": True},
        },
    )

    assert stale_context.status_code == 409
    assert stale_context.headers["X-WMS-Retryable"] == "false"
    assert stale.status_code == 409
    assert stale.headers["X-WMS-Retryable"] == "false"
    current = client.get(f"/api/digital-humans/{role['id']}").json()
    assert current["setup_job_id"] == new_job_id
    assert current["provider_state"] == {"new": True}
    assert current["heygen_avatar_id"] == ""


def test_changing_portrait_rebuilds_only_avatar_and_keeps_live_ids_until_ready(
    api, monkeypatch
):
    client, session_factory, router_module = api
    portrait, voice, environment = _create_media_assets(session_factory)
    replacement_portrait, _, _ = _create_media_assets(session_factory)
    queued = []

    async def capture(job_id: int):
        queued.append(job_id)

    monkeypatch.setattr(router_module, "enqueue_job", capture)
    role = client.post(
        "/api/digital-humans",
        json={
            "name": "林晓",
            "portrait_asset_id": portrait,
            "voice_sample_asset_id": voice,
            "default_environment_asset_id": environment,
        },
    ).json()
    client.post(
        f"/api/digital-humans/{role['id']}/worker-progress",
        headers=_job_headers(role),
        json={
            "status": "ready",
            "heygen_avatar_group_id": "group-old",
            "heygen_avatar_id": "avatar-old",
            "heygen_voice_id": "voice-stable",
            "provider_state": {
                "portrait_asset_id": "portrait-old-asset",
                "avatar_group_id": "group-old",
                "avatar_id": "avatar-old",
                "voice_asset_id": "voice-stable-asset",
                "voice_id": "voice-stable",
            },
        },
    )

    updated = client.patch(
        f"/api/digital-humans/{role['id']}",
        json={"portrait_asset_id": replacement_portrait},
    )

    assert updated.status_code == 200, updated.text
    body = updated.json()
    assert body["status"] == "processing"
    assert body["heygen_avatar_id"] == "avatar-old"
    assert body["heygen_voice_id"] == "voice-stable"
    assert "portrait_asset_id" not in body["provider_state"]
    assert "avatar_group_id" not in body["provider_state"]
    assert "avatar_id" not in body["provider_state"]
    assert body["provider_state"]["voice_id"] == "voice-stable"
    assert queued == [role["setup_job_id"], body["setup_job_id"]]


def test_changing_only_default_environment_does_not_rebuild_provider(
    api, monkeypatch
):
    client, session_factory, router_module = api
    portrait, voice, environment = _create_media_assets(session_factory)
    _, _, replacement_environment = _create_media_assets(session_factory)
    queued = []

    async def capture(job_id: int):
        queued.append(job_id)

    monkeypatch.setattr(router_module, "enqueue_job", capture)
    role = client.post(
        "/api/digital-humans",
        json={
            "name": "林晓",
            "portrait_asset_id": portrait,
            "voice_sample_asset_id": voice,
            "default_environment_asset_id": environment,
        },
    ).json()
    ready = client.post(
        f"/api/digital-humans/{role['id']}/worker-progress",
        headers=_job_headers(role),
        json={
            "status": "ready",
            "heygen_avatar_group_id": "group-1",
            "heygen_avatar_id": "avatar-1",
            "heygen_voice_id": "voice-1",
            "provider_state": {
                "avatar_group_id": "group-1",
                "avatar_id": "avatar-1",
                "voice_id": "voice-1",
            },
        },
    ).json()

    updated = client.patch(
        f"/api/digital-humans/{role['id']}",
        json={"default_environment_asset_id": replacement_environment},
    )

    assert updated.status_code == 200, updated.text
    assert updated.json()["status"] == "ready"
    assert updated.json()["setup_job_id"] == ready["setup_job_id"]
    assert queued == [role["setup_job_id"]]
    assert _asset_directories(
        session_factory, [replacement_environment]
    ) == ["数字人资产"]


def test_changing_provider_inputs_requires_heygen_configuration(
    api, monkeypatch
):
    client, session_factory, router_module = api
    portrait, voice, environment = _create_media_assets(session_factory)
    replacement_portrait, _, _ = _create_media_assets(session_factory)

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
    client.post(
        f"/api/digital-humans/{role['id']}/worker-progress",
        headers=_job_headers(role),
        json={
            "status": "ready",
            "heygen_avatar_group_id": "group-1",
            "heygen_avatar_id": "avatar-1",
            "heygen_voice_id": "voice-1",
        },
    )
    monkeypatch.delenv("HEYGEN_API_KEY")

    response = client.patch(
        f"/api/digital-humans/{role['id']}",
        json={"portrait_asset_id": replacement_portrait},
    )

    assert response.status_code == 409
    assert response.json()["detail"] == "请先配置 HeyGen API Key"


def test_processing_role_rejects_a_second_provider_rebuild(api, monkeypatch):
    client, session_factory, router_module = api
    portrait, voice, environment = _create_media_assets(session_factory)
    replacement_portrait, _, _ = _create_media_assets(session_factory)

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

    response = client.patch(
        f"/api/digital-humans/{role['id']}",
        json={"portrait_asset_id": replacement_portrait},
    )

    assert response.status_code == 409
    assert response.json()["detail"] == "数字人正在处理，请完成后再更换形象或声音"


def test_retry_requires_a_failed_role_and_heygen_configuration(api, monkeypatch):
    client, session_factory, router_module = api
    portrait, voice, environment = _create_media_assets(session_factory)
    queued = []

    async def capture(job_id: int):
        queued.append(job_id)

    monkeypatch.setattr(router_module, "enqueue_job", capture)
    role = client.post(
        "/api/digital-humans",
        json={
            "name": "林晓",
            "portrait_asset_id": portrait,
            "voice_sample_asset_id": voice,
            "default_environment_asset_id": environment,
        },
    ).json()

    still_processing = client.post(
        f"/api/digital-humans/{role['id']}/retry"
    )
    assert still_processing.status_code == 409
    assert still_processing.json()["detail"] == "只能重试处理失败的数字人"

    client.post(
        f"/api/digital-humans/{role['id']}/worker-progress",
        headers=_job_headers(role),
        json={"status": "failed", "error": "provider timeout"},
    )
    monkeypatch.delenv("HEYGEN_API_KEY")
    missing_config = client.post(
        f"/api/digital-humans/{role['id']}/retry"
    )
    assert missing_config.status_code == 409
    assert missing_config.json()["detail"] == "请先配置 HeyGen API Key"
    assert queued == [role["setup_job_id"]]
