import asyncio
import sys

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture
def api(monkeypatch, postgres_env):
    monkeypatch.setenv("WORKER_TOKEN", "prompt-assets-worker-token-0123456789012345")
    for module in list(sys.modules):
        if module.startswith(
            ("config", "database", "models", "routers.assets", "content_jobs")
        ):
            sys.modules.pop(module, None)

    from database import Base, SessionLocal, engine, get_db
    import models  # noqa: F401
    import routers.assets as router_module

    async def setup():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.new_event_loop().run_until_complete(setup())
    enqueued: list[int] = []

    async def capture_enqueue(job_id: int):
        enqueued.append(job_id)

    monkeypatch.setattr(router_module, "enqueue_job", capture_enqueue)
    app = FastAPI()
    app.include_router(router_module.router, prefix="/api")

    async def override_db():
        async with SessionLocal() as session:
            yield session

    app.dependency_overrides[get_db] = override_db
    return TestClient(app), SessionLocal, enqueued


def _create_prompt(client, *, kind="image", content="一张未来城市夜景海报"):
    response = client.post(
        "/api/assets",
        json={
            "asset_type": "prompt",
            "prompt_kind": kind,
            "title": "测试提示词",
            "content": content,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def _create_media(client, *, kind="image"):
    response = client.post(
        "/api/assets",
        json={
            "asset_type": "media",
            "media_kind": kind,
            "title": f"测试{kind}",
            "url": f"https://example.com/{kind}.{'png' if kind == 'image' else 'mp4'}",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_prompt_requires_kind_and_content(api):
    client, _, _ = api

    missing_kind = client.post(
        "/api/assets",
        json={"asset_type": "prompt", "content": "有内容但没有分类"},
    )
    blank_content = client.post(
        "/api/assets",
        json={
            "asset_type": "prompt",
            "prompt_kind": "image",
            "content": "   ",
        },
    )

    assert missing_kind.status_code == 422
    assert blank_content.status_code == 422


def test_video_prompt_round_trips_and_prompt_directory_is_independent(api):
    client, _, _ = api

    prompt = _create_prompt(client, kind="video", content="一段产品发布会镜头")
    directory = client.post(
        "/api/assets/directories",
        json={"name": "视频提示词", "asset_type": "prompt"},
    )
    listed = client.get("/api/assets/directories?asset_type=prompt")
    updated = client.patch(
        f"/api/assets/{prompt['id']}",
        json={"directory": "视频提示词"},
    )

    assert directory.status_code == 201, directory.text
    assert any(item["name"] == "视频提示词" for item in listed.json())
    assert updated.status_code == 200, updated.text
    assert updated.json()["asset_type"] == "prompt"
    assert updated.json()["prompt_kind"] == "video"
    assert updated.json()["directory"] == "视频提示词"


def test_image_prompt_cannot_attach_video_media(api):
    client, _, _ = api
    prompt = _create_prompt(client)
    media = _create_media(client, kind="video")

    response = client.post(
        f"/api/assets/{prompt['id']}/generations/attach",
        json={"media_asset_id": media["id"]},
    )

    assert response.status_code == 422


def test_manual_attach_records_model_and_media_history(api):
    client, _, _ = api
    prompt = _create_prompt(client)
    media = _create_media(client)

    attached = client.post(
        f"/api/assets/{prompt['id']}/generations/attach",
        json={"media_asset_id": media["id"]},
    )
    history = client.get(f"/api/assets/{prompt['id']}/generations")

    assert attached.status_code == 201, attached.text
    assert attached.json()["status"] == "succeeded"
    assert attached.json()["provider"] == "manual"
    assert attached.json()["model"] == "手动补录"
    assert history.status_code == 200, history.text
    assert history.json()[0]["media"]["id"] == media["id"]


def test_deleting_generation_relation_keeps_media_asset(api):
    client, _, _ = api
    prompt = _create_prompt(client)
    media = _create_media(client)
    attached = client.post(
        f"/api/assets/{prompt['id']}/generations/attach",
        json={"media_asset_id": media["id"], "model": "manual-model"},
    )

    deleted = client.delete(
        f"/api/assets/{prompt['id']}/generations/{attached.json()['id']}"
    )
    remaining_media = client.get(f"/api/assets?asset_type=media")

    assert deleted.status_code == 204, deleted.text
    assert [item["id"] for item in remaining_media.json()] == [media["id"]]


def test_starting_image_generation_creates_queued_job_with_prompt_snapshot(api):
    client, session_factory, enqueued = api
    prompt = _create_prompt(client, content="  保留这个快照  ")

    response = client.post(f"/api/assets/{prompt['id']}/generations")

    assert response.status_code == 201, response.text
    assert response.json()["status"] == "queued"
    assert response.json()["job_id"] in enqueued

    async def inspect_rows():
        from models import ContentJob, PromptGeneration
        from sqlalchemy import select

        async with session_factory() as session:
            generation = await session.get(PromptGeneration, response.json()["id"])
            job = await session.get(ContentJob, generation.job_id)
            return generation, job

    generation, job = asyncio.new_event_loop().run_until_complete(inspect_rows())
    assert generation.status == "queued"
    assert job.flow == "prompt_image_generation"
    assert job.input_data["prompt_snapshot"] == "保留这个快照"


def test_worker_succeed_records_media_and_runtime_model(api):
    client, _, _ = api
    prompt = _create_prompt(client)
    media = _create_media(client)
    started = client.post(f"/api/assets/{prompt['id']}/generations")

    succeeded = client.post(
        f"/api/assets/generations/{started.json()['id']}/succeed",
        headers={"X-Worker-Token": "prompt-assets-worker-token-0123456789012345"},
        json={
            "media_asset_id": media["id"],
            "provider": "openai-compatible",
            "model": "gpt-image-1",
        },
    )

    assert succeeded.status_code == 200, succeeded.text
    assert succeeded.json()["status"] == "succeeded"
    assert succeeded.json()["media_asset_id"] == media["id"]
    assert succeeded.json()["model"] == "gpt-image-1"
    assert succeeded.json()["generated_at"]


def test_worker_failure_records_bounded_error(api):
    client, _, _ = api
    prompt = _create_prompt(client)
    started = client.post(f"/api/assets/{prompt['id']}/generations")
    error = "错误信息" * 300

    failed = client.post(
        f"/api/assets/generations/{started.json()['id']}/fail",
        headers={"X-Worker-Token": "prompt-assets-worker-token-0123456789012345"},
        json={"error": error},
    )

    assert failed.status_code == 200, failed.text
    assert failed.json()["status"] == "failed"
    assert len(failed.json()["error"]) <= 500


def test_deleting_prompt_removes_history_but_not_linked_media(api):
    client, _, _ = api
    prompt = _create_prompt(client)
    media = _create_media(client)
    client.post(
        f"/api/assets/{prompt['id']}/generations/attach",
        json={"media_asset_id": media["id"]},
    )

    deleted = client.delete(f"/api/assets/{prompt['id']}")
    history = client.get(f"/api/assets/{prompt['id']}/generations")
    remaining_media = client.get("/api/assets?asset_type=media")

    assert deleted.status_code == 204, deleted.text
    assert history.status_code == 404
    assert [item["id"] for item in remaining_media.json()] == [media["id"]]
