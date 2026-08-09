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
                "routers.talking_videos",
            )
        ):
            sys.modules.pop(module, None)

    from database import Base, SessionLocal, engine, get_db
    import models  # noqa: F401
    import routers.talking_videos as router_module

    async def no_op_enqueue(_job_id: int):
        return None

    monkeypatch.setattr(router_module, "enqueue_job", no_op_enqueue)

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


def _job_headers(render: dict) -> dict[str, str]:
    return {"X-Content-Job-Id": str(render["job_id"])}


def _seed(session_factory, *, ready: bool):
    async def run():
        from models import CreativeAsset, DigitalHuman

        async with session_factory() as session:
            environment = CreativeAsset(
                asset_type="media",
                media_kind="image",
                title="environment",
                url="/api/uploads/environment.jpg",
                media_type="image/jpeg",
                filename="environment.jpg",
            )
            portrait = CreativeAsset(
                asset_type="media",
                media_kind="image",
                title="portrait",
                url="/api/uploads/portrait.png",
                media_type="image/png",
                filename="portrait.png",
            )
            voice = CreativeAsset(
                asset_type="media",
                media_kind="audio",
                title="voice",
                url="/api/uploads/voice.wav",
                media_type="audio/wav",
                filename="voice.wav",
            )
            session.add_all([environment, portrait, voice])
            await session.flush()
            role = DigitalHuman(
                name="林晓",
                status="ready" if ready else "processing",
                portrait_asset_id=portrait.id,
                voice_sample_asset_id=voice.id,
                default_environment_asset_id=environment.id,
                heygen_avatar_id="avatar-1" if ready else "",
                heygen_voice_id="voice-1" if ready else "",
            )
            session.add(role)
            await session.commit()
            return role.id, environment.id

    return asyncio.new_event_loop().run_until_complete(run())


def _create_environment(session_factory, filename: str):
    async def run():
        from models import CreativeAsset

        async with session_factory() as session:
            asset = CreativeAsset(
                asset_type="media",
                media_kind="image",
                title=filename,
                url=f"/api/uploads/{filename}",
                media_type="image/png",
                filename=filename,
            )
            session.add(asset)
            await session.commit()
            return asset.id

    return asyncio.new_event_loop().run_until_complete(run())


def _asset_directory(session_factory, asset_id: int):
    async def run():
        from models import CreativeAsset

        async with session_factory() as session:
            asset = await session.get(CreativeAsset, asset_id)
            return asset.directory if asset is not None else None

    return asyncio.new_event_loop().run_until_complete(run())


def test_project_override_environment_is_archived_on_create(api):
    client, session_factory, _ = api
    role_id, _ = _seed(session_factory, ready=True)
    override_id = _create_environment(session_factory, "override-create.png")

    response = client.post(
        "/api/talking-videos",
        json={
            "title": "作品",
            "digital_human_id": role_id,
            "environment_asset_id": override_id,
        },
    )

    assert response.status_code == 201, response.text
    assert _asset_directory(
        session_factory, override_id
    ) == "数字人资产"


def test_project_override_environment_is_archived_on_update(api):
    client, session_factory, _ = api
    role_id, _ = _seed(session_factory, ready=True)
    override_id = _create_environment(session_factory, "override-update.png")
    project = client.post(
        "/api/talking-videos",
        json={"title": "作品", "digital_human_id": role_id},
    ).json()

    response = client.patch(
        f"/api/talking-videos/{project['id']}",
        json={"environment_asset_id": override_id},
    )

    assert response.status_code == 200, response.text
    assert _asset_directory(
        session_factory, override_id
    ) == "数字人资产"


def test_render_endpoint_rejects_non_ready_role(api):
    client, session_factory, _ = api
    role_id, _ = _seed(session_factory, ready=False)
    project = client.post(
        "/api/talking-videos",
        json={"title": "作品", "digital_human_id": role_id},
    ).json()
    client.patch(
        f"/api/talking-videos/{project['id']}",
        json={"script": "准备生成"},
    )

    response = client.post(f"/api/talking-videos/{project['id']}/renders")

    assert response.status_code == 409
    assert "尚未就绪" in response.json()["detail"]


def test_render_endpoint_rejects_missing_heygen_configuration(api, monkeypatch):
    client, session_factory, _ = api
    role_id, _ = _seed(session_factory, ready=True)
    project = client.post(
        "/api/talking-videos",
        json={
            "title": "作品",
            "digital_human_id": role_id,
            "script": "准备生成",
        },
    ).json()
    monkeypatch.delenv("HEYGEN_API_KEY")

    response = client.post(f"/api/talking-videos/{project['id']}/renders")

    assert response.status_code == 409
    assert response.json()["detail"] == "请先配置 HeyGen API Key"


def test_create_render_enqueues_job_and_returns_immutable_version(api, monkeypatch):
    client, session_factory, router_module = api
    role_id, environment_id = _seed(session_factory, ready=True)
    queued = []

    async def capture(job_id: int):
        queued.append(job_id)

    monkeypatch.setattr(router_module, "enqueue_job", capture)
    project = client.post(
        "/api/talking-videos",
        json={"title": "作品", "digital_human_id": role_id},
    ).json()
    client.patch(
        f"/api/talking-videos/{project['id']}",
        json={"script": "第一版脚本"},
    )
    first = client.post(
        f"/api/talking-videos/{project['id']}/renders"
    )

    assert first.status_code == 201, first.text
    assert first.json()["version"] == 1
    assert first.json()["script_snapshot"] == "第一版脚本"
    assert first.json()["environment_asset_id"] == environment_id
    assert queued == [first.json()["job_id"]]
    assert _asset_directory(
        session_factory, environment_id
    ) == "数字人资产"


def test_render_progress_requires_local_video_asset_and_detail_is_nested(api):
    client, session_factory, _ = api
    role_id, _ = _seed(session_factory, ready=True)
    project = client.post(
        "/api/talking-videos",
        json={
            "title": "作品",
            "digital_human_id": role_id,
            "script": "第一版脚本",
        },
    ).json()
    render = client.post(
        f"/api/talking-videos/{project['id']}/renders"
    ).json()

    invalid = client.post(
        f"/api/talking-videos/renders/{render['id']}/worker-progress",
        headers=_job_headers(render),
        json={"status": "succeeded", "heygen_video_id": "video-1"},
    )
    assert invalid.status_code == 422

    async def create_video_asset():
        from models import CreativeAsset

        async with session_factory() as session:
            asset = CreativeAsset(
                asset_type="media",
                media_kind="video",
                title="render.mp4",
                url="/api/uploads/render.mp4",
                media_type="video/mp4",
                filename="render.mp4",
            )
            session.add(asset)
            await session.commit()
            return asset.id

    video_asset_id = asyncio.new_event_loop().run_until_complete(
        create_video_asset()
    )
    succeeded = client.post(
        f"/api/talking-videos/renders/{render['id']}/worker-progress",
        headers=_job_headers(render),
        json={
            "status": "succeeded",
            "heygen_video_id": "video-1",
            "video_asset_id": video_asset_id,
        },
    )
    assert succeeded.status_code == 200, succeeded.text
    assert _asset_directory(
        session_factory, video_asset_id
    ) == "数字人资产"

    auto_selected = client.get(
        f"/api/talking-videos/{project['id']}"
    ).json()
    assert auto_selected["current_render_id"] == render["id"]

    client.post(
        f"/api/talking-videos/{project['id']}/renders/{render['id']}/select"
    )
    detail = client.get(f"/api/talking-videos/{project['id']}").json()
    assert detail["role"]["id"] == role_id
    assert detail["effective_environment"]["media_kind"] == "image"
    assert detail["renders"][0]["video_asset"]["url"] == "/api/uploads/render.mp4"
    assert detail["current_render_id"] == render["id"]

    listing = client.get("/api/talking-videos").json()
    assert listing[0]["id"] == project["id"]
    assert listing[0]["renders"][0]["id"] == render["id"]


def test_replaced_render_job_is_not_retryable(api):
    client, session_factory, _ = api
    role_id, _ = _seed(session_factory, ready=True)
    project = client.post(
        "/api/talking-videos",
        json={
            "title": "作品",
            "digital_human_id": role_id,
            "script": "第一版脚本",
        },
    ).json()
    render = client.post(
        f"/api/talking-videos/{project['id']}/renders"
    ).json()
    old_job_id = render["job_id"]

    async def replace_job():
        from content_jobs import create_job
        from models import TalkingVideoRender

        async with session_factory() as session:
            current = await session.get(TalkingVideoRender, render["id"])
            new_job = await create_job(
                session,
                flow="digital_human_render",
                title="new render",
                input_data={"render_id": render["id"]},
                commit=False,
            )
            current.job_id = new_job.id
            await session.commit()

    asyncio.new_event_loop().run_until_complete(replace_job())

    stale_context = client.get(
        f"/api/talking-videos/renders/{render['id']}/worker-context",
        headers={"X-Content-Job-Id": str(old_job_id)},
    )
    stale_progress = client.post(
        f"/api/talking-videos/renders/{render['id']}/worker-progress",
        headers={"X-Content-Job-Id": str(old_job_id)},
        json={"status": "running"},
    )

    assert stale_context.status_code == 409
    assert stale_context.headers["X-WMS-Retryable"] == "false"
    assert stale_progress.status_code == 409
    assert stale_progress.headers["X-WMS-Retryable"] == "false"
