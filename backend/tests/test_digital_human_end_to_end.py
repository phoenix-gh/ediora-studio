import asyncio
import sys

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv(
        "WMS_DATABASE_URL",
        f"sqlite+aiosqlite:///{tmp_path / 'digital-human-e2e.db'}",
    )
    monkeypatch.setenv("WMS_DISABLE_SCHEDULER", "1")
    monkeypatch.setenv("HEYGEN_API_KEY", "test-heygen-key")
    monkeypatch.setenv(
        "WMS_WORKER_TOKEN", "test-worker-token-at-least-32-chars"
    )
    for module in list(sys.modules):
        if module.startswith(
            (
                "database",
                "config",
                "models",
                "main",
                "routers",
                "content_jobs",
                "digital_human_assets",
                "digital_human_service",
            )
        ):
            sys.modules.pop(module, None)

    from database import Base, engine
    import models  # noqa: F401

    async def setup():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.new_event_loop().run_until_complete(setup())
    from main import app
    import routers.assets as assets_router
    import routers.digital_humans as roles_router
    import routers.talking_videos as videos_router

    uploads = tmp_path / "uploads"
    uploads.mkdir()
    monkeypatch.setattr(assets_router, "_UPLOADS_DIR", str(uploads))

    async def no_op_enqueue(_job_id: int):
        return None

    monkeypatch.setattr(roles_router, "enqueue_job", no_op_enqueue)
    monkeypatch.setattr(videos_router, "enqueue_job", no_op_enqueue)
    return TestClient(
        app,
        headers={
            "X-WMS-Worker-Token": "test-worker-token-at-least-32-chars"
        },
    )


def upload_asset(
    client,
    *,
    media_kind: str,
    filename: str,
    content: bytes,
    media_type: str,
) -> dict:
    response = client.post(
        f"/api/assets/upload?media_kind={media_kind}",
        files={"file": (filename, content, media_type)},
    )
    assert response.status_code == 201, response.text
    return response.json()


def create_role_with_assets(client) -> dict:
    portrait = upload_asset(
        client,
        media_kind="image",
        filename="portrait.png",
        content=b"fake-png",
        media_type="image/png",
    )
    voice = upload_asset(
        client,
        media_kind="audio",
        filename="voice.wav",
        content=b"fake-wav",
        media_type="audio/wav",
    )
    environment = upload_asset(
        client,
        media_kind="image",
        filename="environment.jpg",
        content=b"fake-jpeg",
        media_type="image/jpeg",
    )
    response = client.post(
        "/api/digital-humans",
        json={
            "name": "林晓",
            "portrait_asset_id": portrait["id"],
            "voice_sample_asset_id": voice["id"],
            "default_environment_asset_id": environment["id"],
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def upload_fake_mp4(client, filename: str) -> dict:
    return upload_asset(
        client,
        media_kind="video",
        filename=filename,
        content=b"fake-mp4-bytes",
        media_type="video/mp4",
    )


def test_role_to_two_versioned_local_videos(client):
    role = create_role_with_assets(client)
    progress = client.post(
        f"/api/digital-humans/{role['id']}/worker-progress",
        headers={"X-Content-Job-Id": str(role["setup_job_id"])},
        json={
            "status": "ready",
            "heygen_avatar_group_id": "group-1",
            "heygen_avatar_id": "avatar-1",
            "heygen_voice_id": "voice-1",
            "provider_state": {},
        },
    )
    assert progress.status_code == 200, progress.text
    assert client.get(
        f"/api/digital-humans/{role['id']}"
    ).json()["status"] == "ready"

    project_response = client.post(
        "/api/talking-videos",
        json={
            "title": "AI 工作流口播",
            "digital_human_id": role["id"],
            "script": "第一版脚本",
        },
    )
    assert project_response.status_code == 201, project_response.text
    project = project_response.json()

    first_response = client.post(
        f"/api/talking-videos/{project['id']}/renders"
    )
    assert first_response.status_code == 201, first_response.text
    first = first_response.json()
    first_asset = upload_fake_mp4(client, "version-1.mp4")
    first_progress = client.post(
        f"/api/talking-videos/renders/{first['id']}/worker-progress",
        headers={"X-Content-Job-Id": str(first["job_id"])},
        json={
            "status": "succeeded",
            "heygen_environment_asset_id": "environment-1",
            "heygen_video_id": "video-1",
            "video_asset_id": first_asset["id"],
            "provider_state": {},
        },
    )
    assert first_progress.status_code == 200, first_progress.text
    assert client.get(
        f"/api/talking-videos/{project['id']}"
    ).json()["current_render_id"] == first["id"]

    updated = client.patch(
        f"/api/talking-videos/{project['id']}",
        json={"script": "第二版脚本"},
    )
    assert updated.status_code == 200, updated.text
    second_response = client.post(
        f"/api/talking-videos/{project['id']}/renders"
    )
    assert second_response.status_code == 201, second_response.text
    second = second_response.json()
    second_asset = upload_fake_mp4(client, "version-2.mp4")
    second_progress = client.post(
        f"/api/talking-videos/renders/{second['id']}/worker-progress",
        headers={"X-Content-Job-Id": str(second["job_id"])},
        json={
            "status": "succeeded",
            "heygen_environment_asset_id": "environment-1",
            "heygen_video_id": "video-2",
            "video_asset_id": second_asset["id"],
            "provider_state": {},
        },
    )
    assert second_progress.status_code == 200, second_progress.text

    detail = client.get(f"/api/talking-videos/{project['id']}").json()
    assert detail["current_render_id"] == first["id"]
    assert [item["version"] for item in detail["renders"]] == [2, 1]
    assert [item["script_snapshot"] for item in detail["renders"]] == [
        "第二版脚本",
        "第一版脚本",
    ]
    assert all(
        item["video_asset"]["url"].startswith("/api/uploads/")
        for item in detail["renders"]
    )
