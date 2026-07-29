import asyncio
import sys

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv(
        "WMS_DATABASE_URL",
        f"sqlite+aiosqlite:///{tmp_path / 'text-videos-router.db'}",
    )
    for module in list(sys.modules):
        if module.startswith(("database", "models", "routers.text_videos")):
            sys.modules.pop(module, None)

    from database import Base, SessionLocal, engine, get_db
    import models  # noqa: F401
    import routers.text_videos as router_module

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
    return TestClient(app)


def test_text_video_project_crud_and_revision_conflict(client):
    assert client.get("/api/text-videos").json() == []

    created_response = client.post(
        "/api/text-videos",
        json={"title": "第一条文字视频"},
    )
    assert created_response.status_code == 201, created_response.text
    created = created_response.json()
    assert created["title"] == "第一条文字视频"
    assert created["stage"] == "script"
    assert created["status"] == "draft"
    assert created["revision"] == 1
    assert created["render_input"]["templateId"] == "tech-text-v1"

    detail = client.get(f"/api/text-videos/{created['id']}")
    assert detail.status_code == 200

    updated_response = client.patch(
        f"/api/text-videos/{created['id']}",
        json={
            "revision": 1,
            "title": "自动保存后的标题",
            "script": "一段真实稿件",
        },
    )
    assert updated_response.status_code == 200, updated_response.text
    updated = updated_response.json()
    assert updated["revision"] == 2
    assert updated["title"] == "自动保存后的标题"

    conflict = client.patch(
        f"/api/text-videos/{created['id']}",
        json={"revision": 1, "title": "过期页面覆盖"},
    )
    assert conflict.status_code == 409
    assert conflict.json()["detail"]["revision"] == 2

    summary = client.get("/api/text-videos").json()[0]
    assert summary["id"] == created["id"]
    assert summary["title"] == "自动保存后的标题"

    deleted = client.delete(f"/api/text-videos/{created['id']}")
    assert deleted.status_code == 204
    assert client.get(f"/api/text-videos/{created['id']}").status_code == 404


def test_video_stage_requires_all_paragraphs_confirmed(client):
    project = client.post("/api/text-videos", json={}).json()
    response = client.patch(
        f"/api/text-videos/{project['id']}",
        json={
            "revision": project["revision"],
            "stage": "video",
            "paragraphs": [{
                "id": "paragraph-1",
                "text": "尚未确认",
                "duration": 1.2,
                "status": "ready",
                "audio_url": "",
                "word_timings": [],
            }],
        },
    )

    assert response.status_code == 422
    assert "确认所有配音" in response.text


def test_rejects_overlapping_render_segments(client):
    project = client.post("/api/text-videos", json={}).json()
    render_input = project["render_input"]
    render_input["segments"] = [
        {
            "id": "scene-1",
            "start": 0,
            "end": 2.4,
            "text": "第一幕",
            "highlight": [],
            "animation": "fade-up",
        },
        {
            "id": "scene-2",
            "start": 2,
            "end": 4,
            "text": "第二幕",
            "highlight": [],
            "animation": "scale",
        },
    ]

    response = client.patch(
        f"/api/text-videos/{project['id']}",
        json={"revision": project["revision"], "render_input": render_input},
    )

    assert response.status_code == 422
    assert "重叠" in response.text
