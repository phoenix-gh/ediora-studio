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
    monkeypatch.setenv(
        "WMS_WORKER_TOKEN",
        "test-worker-token-at-least-32-chars",
    )
    for module in list(sys.modules):
        if module.startswith((
            "content_jobs",
            "config",
            "database",
            "models",
            "routers.jobs",
            "routers.text_videos",
            "text_video_audio",
            "text_video_jobs",
        )):
            sys.modules.pop(module, None)

    from database import Base, SessionLocal, engine, get_db
    import models  # noqa: F401
    import routers.jobs as jobs_module
    import routers.text_videos as router_module

    async def setup():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.new_event_loop().run_until_complete(setup())
    app = FastAPI()
    app.include_router(router_module.router, prefix="/api")
    app.include_router(jobs_module.router, prefix="/api")

    async def override_db():
        async with SessionLocal() as session:
            yield session

    app.dependency_overrides[get_db] = override_db
    return TestClient(app)


def _speech_project(client, text="需要配音。"):
    project = client.post("/api/text-videos", json={}).json()
    return client.patch(
        f"/api/text-videos/{project['id']}",
        json={
            "revision": project["revision"],
            "script": text,
        },
    ).json()


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
    assert created["speech_split_mode"] == "single"
    assert created["paragraphs"][0]["text"] == ""
    assert created["paragraphs"][0]["generation_revision"] == 0
    assert created["master_audio"]["status"] == "missing"
    assert created["scene_plan"]["status"] == "missing"
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
    assert [item["text"] for item in updated["paragraphs"]] == ["一段真实稿件"]
    assert "".join(item["text"] for item in updated["paragraphs"]) == updated["script"]

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
            }],
        },
    )

    assert response.status_code == 422
    assert "确认所有配音" in response.text


def test_patch_ignores_browser_owned_speech_generation_fields(client):
    project = client.post("/api/text-videos", json={}).json()
    response = client.patch(
        f"/api/text-videos/{project['id']}",
        json={
            "revision": project["revision"],
            "script": "不能伪造",
            "paragraphs": [{
                "id": "paragraph-1",
                "text": "不能伪造",
                "status": "confirmed",
                "audio_url": "/api/uploads/forged.mp3",
                "duration": 88,
                "source_hash": "forged",
                "generation_revision": 99,
                "job_id": 7,
            }],
        },
    )

    assert response.status_code == 200, response.text
    segment = response.json()["paragraphs"][0]
    assert segment["status"] == "draft"
    assert segment["audio_url"] == ""
    assert segment["duration"] == 0
    assert segment["source_hash"] == ""
    assert segment["generation_revision"] == 1
    assert segment["job_id"] is None


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


def test_speech_split_preview_snapshots_exact_script_and_worker_validation(client, monkeypatch):
    import routers.text_videos as router_module

    queued = []

    async def capture_enqueue(job_id: int):
        queued.append(job_id)

    monkeypatch.setattr(router_module, "enqueue_job", capture_enqueue)
    project = client.post("/api/text-videos", json={}).json()
    updated = client.patch(
        f"/api/text-videos/{project['id']}",
        json={
            "revision": project["revision"],
            "script": "甲。乙。",
        },
    ).json()

    preview = client.post(
        f"/api/text-videos/{project['id']}/speech-split-preview",
        json={"revision": updated["revision"], "direction": "适合短句口播"},
    )

    assert preview.status_code == 201, preview.text
    body = preview.json()
    assert body["project"]["id"] == project["id"]
    assert body["jobs"][0]["flow"] == "text_video_split_preview"
    assert body["jobs"][0]["target_id"] == project["id"]
    assert queued == [body["jobs"][0]["id"]]

    job = client.get(f"/api/jobs/{body['jobs'][0]['id']}").json()
    assert job["input"]["script"] == "甲。乙。"
    assert job["input"]["script_hash"]
    boundary_ids = [item["id"] for item in job["input"]["candidates"]]

    validation = client.post(
        f"/api/text-videos/{project['id']}/speech-split-preview/worker-validate",
        json={"script_hash": job["input"]["script_hash"], "boundary_ids": boundary_ids[:1]},
        headers={
            "X-WMS-Worker-Token": "test-worker-token-at-least-32-chars",
            "X-Content-Job-Id": str(body["jobs"][0]["id"]),
        },
    )

    assert validation.status_code == 200, validation.text
    proposal = validation.json()
    assert "".join(item["text"] for item in proposal["segments"]) == "甲。乙。"
    assert proposal["speech_split_mode"] == "auto"


def test_speech_split_preview_retry_reenqueues_existing_job_after_first_enqueue_failure(
    client,
    monkeypatch,
):
    import routers.text_videos as router_module

    enqueue_attempts = []

    async def fail_once_then_enqueue(job_id: int):
        enqueue_attempts.append(job_id)
        if len(enqueue_attempts) == 1:
            raise RuntimeError("redis unavailable")

    monkeypatch.setattr(router_module, "enqueue_job", fail_once_then_enqueue)
    project = client.post("/api/text-videos", json={}).json()
    updated = client.patch(
        f"/api/text-videos/{project['id']}",
        json={
            "revision": project["revision"],
            "script": "甲。乙。",
        },
    ).json()
    request = {
        "revision": updated["revision"],
        "direction": "适合短句口播",
    }

    with pytest.raises(RuntimeError, match="redis unavailable"):
        client.post(
            f"/api/text-videos/{project['id']}/speech-split-preview",
            json=request,
        )

    retry = client.post(
        f"/api/text-videos/{project['id']}/speech-split-preview",
        json=request,
    )

    assert retry.status_code == 201, retry.text
    job_id = retry.json()["jobs"][0]["id"]
    assert enqueue_attempts == [job_id, job_id]
    jobs = client.get("/api/jobs").json()["jobs"]
    assert [(job["id"], job["status"]) for job in jobs] == [(job_id, "queued")]


def test_speech_generation_confirmation_and_stale_worker_result(
    client,
    monkeypatch,
):
    import routers.text_videos as router_module
    import text_video_jobs

    queued: list[int] = []

    async def capture_enqueue(job_id: int):
        queued.append(job_id)

    monkeypatch.setattr(text_video_jobs, "enqueue_job", capture_enqueue)
    project = _speech_project(client)
    segment = project["paragraphs"][0]
    generated = client.post(
        f"/api/text-videos/{project['id']}/speech-segments/"
        f"{segment['id']}/generate",
        json={"revision": project["revision"]},
    )
    assert generated.status_code == 201, generated.text
    body = generated.json()
    job = body["jobs"][0]
    assert job["flow"] == "text_video_speech"
    assert job["target_id"] == segment["id"]
    assert queued == [job["id"]]

    context = client.get(
        f"/api/text-videos/{project['id']}/speech-segments/"
        f"{segment['id']}/worker-context",
        headers={
            "X-WMS-Worker-Token": "test-worker-token-at-least-32-chars",
            "X-Content-Job-Id": str(job["id"]),
        },
    )
    assert context.status_code == 200, context.text
    snapshot = context.json()
    assert snapshot["text"] == "需要配音。"
    assert snapshot["generation_revision"] == 1
    assert snapshot["runtime"]["default_voice"] == "mimo_default"

    edited = client.patch(
        f"/api/text-videos/{project['id']}",
        json={
            "revision": project["revision"],
            "script": "已经改稿。",
        },
    )
    assert edited.status_code == 200
    stale = client.post(
        f"/api/text-videos/{project['id']}/speech-segments/"
        f"{segment['id']}/worker-failure",
        json={
            "generation_revision": snapshot["generation_revision"],
            "source_hash": snapshot["source_hash"],
            "error": "late provider response",
        },
        headers={
            "X-WMS-Worker-Token": "test-worker-token-at-least-32-chars",
            "X-Content-Job-Id": str(job["id"]),
        },
    )
    assert stale.status_code == 409
    assert stale.headers["X-WMS-Retryable"] == "false"


def test_cancelling_speech_job_changes_only_its_segment(client, monkeypatch):
    import text_video_jobs

    async def ignore_enqueue(_job_id: int):
        return None

    monkeypatch.setattr(text_video_jobs, "enqueue_job", ignore_enqueue)
    project = _speech_project(client, "甲。乙。")
    split = client.patch(
        f"/api/text-videos/{project['id']}",
        json={
            "revision": project["revision"],
            "paragraphs": [
                {"id": "a", "text": "甲。"},
                {"id": "b", "text": "乙。"},
            ],
        },
    ).json()
    pending = client.post(
        f"/api/text-videos/{project['id']}/speech-segments/generate-pending",
        json={"revision": split["revision"]},
    ).json()
    jobs = pending["jobs"]

    cancelled = client.post(f"/api/jobs/{jobs[0]['id']}/cancel")
    assert cancelled.status_code == 200, cancelled.text
    detail = client.get(f"/api/text-videos/{project['id']}").json()
    assert detail["paragraphs"][0]["status"] == "failed"
    assert detail["paragraphs"][0]["job_id"] is None
    assert detail["paragraphs"][0]["error"] == "任务已取消"
    assert detail["paragraphs"][1]["status"] == "generating"
    assert detail["paragraphs"][1]["job_id"] == jobs[1]["id"]
