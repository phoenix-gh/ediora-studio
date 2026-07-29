import asyncio
from io import BytesIO
import json
import sys

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.datastructures import Headers, UploadFile


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

    relaunched = client.post(
        f"/api/text-videos/{project['id']}/speech-segments/a/generate",
        json={"revision": split["revision"]},
    )
    assert relaunched.status_code == 201, relaunched.text
    replacement = relaunched.json()
    assert replacement["jobs"][0]["id"] != jobs[0]["id"]
    assert (
        replacement["project"]["paragraphs"][0]["generation_revision"]
        == pending["project"]["paragraphs"][0]["generation_revision"] + 1
    )


def test_worker_failure_retry_restores_current_job_but_not_after_replacement(
    client,
    monkeypatch,
):
    import routers.jobs as jobs_router
    import text_video_jobs

    async def ignore_enqueue(_job_id: int):
        return None

    monkeypatch.setattr(text_video_jobs, "enqueue_job", ignore_enqueue)
    monkeypatch.setattr(jobs_router, "enqueue_job", ignore_enqueue)
    project = _speech_project(client)
    segment = project["paragraphs"][0]
    generated = client.post(
        f"/api/text-videos/{project['id']}/speech-segments/"
        f"{segment['id']}/generate",
        json={"revision": project["revision"]},
    ).json()
    job = generated["jobs"][0]
    context = client.get(
        f"/api/text-videos/{project['id']}/speech-segments/"
        f"{segment['id']}/worker-context",
        headers={
            "X-WMS-Worker-Token": "test-worker-token-at-least-32-chars",
            "X-Content-Job-Id": str(job["id"]),
        },
    ).json()
    step = client.post(
        f"/api/jobs/{job['id']}/steps/generate_speech/start",
    ).json()
    worker_headers = {
        "X-WMS-Worker-Token": "test-worker-token-at-least-32-chars",
        "X-Content-Job-Id": str(job["id"]),
    }
    failure_body = {
        "generation_revision": context["generation_revision"],
        "source_hash": context["source_hash"],
        "error": "temporary provider failure",
    }

    domain_failure = client.post(
        f"/api/text-videos/{project['id']}/speech-segments/"
        f"{segment['id']}/worker-failure",
        json=failure_body,
        headers=worker_headers,
    )
    assert domain_failure.status_code == 200, domain_failure.text
    failed = client.post(
        f"/api/jobs/{job['id']}/steps/{step['id']}/fail",
        json={"error": "temporary provider failure", "retryable": True},
    )
    assert failed.status_code == 200, failed.text
    retry = client.post(
        f"/api/jobs/{job['id']}/retry",
        json={"step_key": "generate_speech"},
    )
    assert retry.status_code == 200, retry.text
    restored = client.get(f"/api/text-videos/{project['id']}").json()
    assert restored["paragraphs"][0]["status"] == "generating"
    assert restored["paragraphs"][0]["job_id"] == job["id"]

    second_step = client.post(
        f"/api/jobs/{job['id']}/steps/generate_speech/start",
    ).json()
    assert client.post(
        f"/api/text-videos/{project['id']}/speech-segments/"
        f"{segment['id']}/worker-failure",
        json=failure_body,
        headers=worker_headers,
    ).status_code == 200
    assert client.post(
        f"/api/jobs/{job['id']}/steps/{second_step['id']}/fail",
        json={"error": "temporary provider failure", "retryable": True},
    ).status_code == 200
    replacement = client.post(
        f"/api/text-videos/{project['id']}/speech-segments/"
        f"{segment['id']}/generate",
        json={"revision": project["revision"]},
    ).json()
    replacement_job = replacement["jobs"][0]
    assert replacement_job["id"] != job["id"]

    old_retry = client.post(
        f"/api/jobs/{job['id']}/retry",
        json={"step_key": "generate_speech"},
    )
    assert old_retry.status_code == 200, old_retry.text
    current = client.get(f"/api/text-videos/{project['id']}").json()
    assert current["paragraphs"][0]["job_id"] == replacement_job["id"]
    assert current["paragraphs"][0]["generation_revision"] == (
        context["generation_revision"] + 1
    )


def test_old_retry_preserves_confirmed_reusable_asset(client, monkeypatch, tmp_path):
    import routers.jobs as jobs_router
    import text_video_jobs
    from database import SessionLocal
    from models import CreativeAsset, TextVideoSpeechAsset

    async def ignore_enqueue(_job_id: int):
        return None

    uploads = tmp_path / "reusable retry"
    uploads.mkdir()
    monkeypatch.setattr(text_video_jobs, "UPLOADS_DIR", uploads)
    monkeypatch.setattr(text_video_jobs, "enqueue_job", ignore_enqueue)
    monkeypatch.setattr(jobs_router, "enqueue_job", ignore_enqueue)
    project = _speech_project(client)
    segment = project["paragraphs"][0]
    generated = client.post(
        f"/api/text-videos/{project['id']}/speech-segments/"
        f"{segment['id']}/generate",
        json={"revision": project["revision"]},
    ).json()
    job = generated["jobs"][0]
    context = client.get(
        f"/api/text-videos/{project['id']}/speech-segments/"
        f"{segment['id']}/worker-context",
        headers={
            "X-WMS-Worker-Token": "test-worker-token-at-least-32-chars",
            "X-Content-Job-Id": str(job["id"]),
        },
    ).json()
    step = client.post(
        f"/api/jobs/{job['id']}/steps/generate_speech/start",
    ).json()
    worker_headers = {
        "X-WMS-Worker-Token": "test-worker-token-at-least-32-chars",
        "X-Content-Job-Id": str(job["id"]),
    }
    assert client.post(
        f"/api/text-videos/{project['id']}/speech-segments/"
        f"{segment['id']}/worker-failure",
        json={
            "generation_revision": context["generation_revision"],
            "source_hash": context["source_hash"],
            "error": "temporary provider failure",
        },
        headers=worker_headers,
    ).status_code == 200
    assert client.post(
        f"/api/jobs/{job['id']}/steps/{step['id']}/fail",
        json={"error": "temporary provider failure", "retryable": True},
    ).status_code == 200

    async def persist_reusable_asset():
        path = uploads / "reusable.mp3"
        path.write_bytes(b"persisted audio")
        async with SessionLocal() as session:
            asset = CreativeAsset(
                asset_type="media",
                media_kind="audio",
                title="reusable",
                url="/api/uploads/reusable.mp3",
                media_type="audio/mpeg",
                filename="reusable.mp3",
                source="generated",
            )
            session.add(asset)
            await session.flush()
            session.add(TextVideoSpeechAsset(
                creative_asset_id=asset.id,
                source_hash=context["source_hash"],
                duration=1,
                sample_count=44100,
                sample_rate=44100,
            ))
            await session.commit()

    asyncio.new_event_loop().run_until_complete(persist_reusable_asset())
    reused = client.post(
        f"/api/text-videos/{project['id']}/speech-segments/generate-pending",
        json={"revision": project["revision"]},
    )
    assert reused.status_code == 201, reused.text
    assert reused.json()["jobs"] == []
    ready = reused.json()["project"]["paragraphs"][0]
    assert ready["status"] == "ready"
    assert ready["audio_url"] == "/api/uploads/reusable.mp3"
    confirmed = client.post(
        f"/api/text-videos/{project['id']}/speech-segments/"
        f"{segment['id']}/confirm",
        json={
            "revision": project["revision"],
            "generation_revision": ready["generation_revision"],
            "source_hash": ready["source_hash"],
        },
    )
    assert confirmed.status_code == 200, confirmed.text

    retry = client.post(
        f"/api/jobs/{job['id']}/retry",
        json={"step_key": "generate_speech"},
    )
    assert retry.status_code == 200, retry.text
    current = client.get(f"/api/text-videos/{project['id']}").json()
    assert current["paragraphs"][0] == confirmed.json()["paragraphs"][0]
    replay = client.get(
        f"/api/text-videos/{project['id']}/speech-segments/"
        f"{segment['id']}/worker-context",
        headers=worker_headers,
    )
    assert replay.status_code == 200, replay.text
    assert replay.json()["already_saved"]["audio_url"] == ready["audio_url"]


def test_old_retry_preserves_committed_result_when_reconciliation_was_lost(
    client,
    monkeypatch,
    tmp_path,
):
    import routers.jobs as jobs_router
    import routers.text_videos as router_module
    import text_video_audio
    import text_video_jobs

    async def ignore_enqueue(_job_id: int):
        return None

    uploads = tmp_path / "persisted retry"
    monkeypatch.setattr(router_module, "UPLOADS_DIR", uploads)
    monkeypatch.setattr(text_video_audio, "UPLOADS_DIR", uploads)
    monkeypatch.setattr(text_video_jobs, "UPLOADS_DIR", uploads)
    monkeypatch.setattr(text_video_jobs, "enqueue_job", ignore_enqueue)
    monkeypatch.setattr(jobs_router, "enqueue_job", ignore_enqueue)
    project = _speech_project(client)
    segment = project["paragraphs"][0]
    job = client.post(
        f"/api/text-videos/{project['id']}/speech-segments/"
        f"{segment['id']}/generate",
        json={"revision": project["revision"]},
    ).json()["jobs"][0]
    context = client.get(
        f"/api/text-videos/{project['id']}/speech-segments/"
        f"{segment['id']}/worker-context",
        headers={
            "X-WMS-Worker-Token": "test-worker-token-at-least-32-chars",
            "X-Content-Job-Id": str(job["id"]),
        },
    ).json()
    step = client.post(
        f"/api/jobs/{job['id']}/steps/generate_speech/start",
    ).json()
    wav = tmp_path / "provider-result.wav"
    asyncio.new_event_loop().run_until_complete(
        __import__("tests.test_media_command", fromlist=["sine_wave"])
        .sine_wave(wav),
    )
    worker_headers = {
        "X-WMS-Worker-Token": "test-worker-token-at-least-32-chars",
        "X-Content-Job-Id": str(job["id"]),
    }
    persisted = client.post(
        f"/api/text-videos/{project['id']}/speech-segments/"
        f"{segment['id']}/worker-result",
        data={
            "generation_revision": str(context["generation_revision"]),
            "source_hash": context["source_hash"],
            "provider_request_id": "provider-committed",
            "media_type": "audio/wav",
        },
        files={"audio": ("provider.wav", wav.read_bytes(), "audio/wav")},
        headers=worker_headers,
    )
    assert persisted.status_code == 200, persisted.text
    assert client.post(
        f"/api/jobs/{job['id']}/steps/{step['id']}/fail",
        json={"error": "reconciliation unavailable", "retryable": True},
    ).status_code == 200

    retry = client.post(
        f"/api/jobs/{job['id']}/retry",
        json={"step_key": "generate_speech"},
    )
    assert retry.status_code == 200, retry.text
    current = client.get(f"/api/text-videos/{project['id']}").json()
    assert current["paragraphs"][0]["status"] == "ready"
    assert current["paragraphs"][0]["job_id"] is None
    assert (
        current["paragraphs"][0]["audio_url"]
        == persisted.json()["audio_url"]
    )
    replay = client.get(
        f"/api/text-videos/{project['id']}/speech-segments/"
        f"{segment['id']}/worker-context",
        headers=worker_headers,
    )
    assert replay.status_code == 200, replay.text
    assert replay.json()["already_saved"] == persisted.json()


def test_worker_result_normalizes_persists_and_replays_after_response_loss(
    client,
    monkeypatch,
    tmp_path,
):
    import routers.text_videos as router_module
    import text_video_audio
    import text_video_jobs

    uploads = tmp_path / "worker uploads"
    monkeypatch.setattr(router_module, "UPLOADS_DIR", uploads)
    monkeypatch.setattr(text_video_audio, "UPLOADS_DIR", uploads)
    monkeypatch.setattr(text_video_jobs, "UPLOADS_DIR", uploads)

    async def ignore_enqueue(_job_id: int):
        return None

    monkeypatch.setattr(text_video_jobs, "enqueue_job", ignore_enqueue)
    project = _speech_project(client)
    segment = project["paragraphs"][0]
    generated = client.post(
        f"/api/text-videos/{project['id']}/speech-segments/"
        f"{segment['id']}/generate",
        json={"revision": project["revision"]},
    ).json()
    job = generated["jobs"][0]
    context = client.get(
        f"/api/text-videos/{project['id']}/speech-segments/"
        f"{segment['id']}/worker-context",
        headers={
            "X-WMS-Worker-Token": "test-worker-token-at-least-32-chars",
            "X-Content-Job-Id": str(job["id"]),
        },
    ).json()
    wav = tmp_path / "provider.wav"
    asyncio.new_event_loop().run_until_complete(
        __import__("tests.test_media_command", fromlist=["sine_wave"])
        .sine_wave(wav),
    )
    form = {
        "generation_revision": str(context["generation_revision"]),
        "source_hash": context["source_hash"],
        "provider_request_id": "provider-1",
        "media_type": "audio/wav",
        "word_timings": json.dumps([
            {"id": "w1", "text": "需要", "start": 0, "end": 0.4},
        ]),
    }
    headers = {
        "X-WMS-Worker-Token": "test-worker-token-at-least-32-chars",
        "X-Content-Job-Id": str(job["id"]),
    }

    first = client.post(
        f"/api/text-videos/{project['id']}/speech-segments/"
        f"{segment['id']}/worker-result",
        data=form,
        files={"audio": ("ignored-name.wav", wav.read_bytes(), "audio/wav")},
        headers=headers,
    )
    assert first.status_code == 200, first.text
    saved = first.json()
    assert saved["audio_url"].endswith(".mp3")
    assert saved["sample_rate"] == 44100
    assert saved["duration"] == (
        saved["sample_count"] / saved["sample_rate"]
    )
    detail = client.get(f"/api/text-videos/{project['id']}").json()
    assert detail["paragraphs"][0]["status"] == "ready"
    assert detail["paragraphs"][0]["audio_url"] == saved["audio_url"]
    assert detail["paragraphs"][0]["job_id"] is None

    replay = client.post(
        f"/api/text-videos/{project['id']}/speech-segments/"
        f"{segment['id']}/worker-result",
        data=form,
        files={"audio": ("different.wav", b"response lost", "audio/wav")},
        headers=headers,
    )
    assert replay.status_code == 200, replay.text
    assert replay.json() == saved

    confirmed = client.post(
        f"/api/text-videos/{project['id']}/speech-segments/"
        f"{segment['id']}/confirm",
        json={
            "revision": project["revision"],
            "generation_revision": context["generation_revision"],
            "source_hash": context["source_hash"],
        },
    )
    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json()["paragraphs"][0]["status"] == "confirmed"
    repeated_confirmation = client.post(
        f"/api/text-videos/{project['id']}/speech-segments/"
        f"{segment['id']}/confirm",
        json={
            "revision": project["revision"],
            "generation_revision": context["generation_revision"],
            "source_hash": context["source_hash"],
        },
    )
    assert repeated_confirmation.status_code == 409


def test_worker_result_rejects_stale_audio_without_persisting(
    client,
    monkeypatch,
    tmp_path,
):
    import routers.text_videos as router_module
    import text_video_audio
    import text_video_jobs

    uploads = tmp_path / "stale uploads"
    monkeypatch.setattr(router_module, "UPLOADS_DIR", uploads)
    monkeypatch.setattr(text_video_audio, "UPLOADS_DIR", uploads)
    monkeypatch.setattr(text_video_jobs, "UPLOADS_DIR", uploads)

    async def ignore_enqueue(_job_id: int):
        return None

    monkeypatch.setattr(text_video_jobs, "enqueue_job", ignore_enqueue)
    project = _speech_project(client)
    segment = project["paragraphs"][0]
    generated = client.post(
        f"/api/text-videos/{project['id']}/speech-segments/"
        f"{segment['id']}/generate",
        json={"revision": project["revision"]},
    ).json()
    job = generated["jobs"][0]
    context = client.get(
        f"/api/text-videos/{project['id']}/speech-segments/"
        f"{segment['id']}/worker-context",
        headers={
            "X-WMS-Worker-Token": "test-worker-token-at-least-32-chars",
            "X-Content-Job-Id": str(job["id"]),
        },
    ).json()
    client.patch(
        f"/api/text-videos/{project['id']}",
        json={
            "revision": project["revision"],
            "script": "已经修改。",
        },
    )

    stale = client.post(
        f"/api/text-videos/{project['id']}/speech-segments/"
        f"{segment['id']}/worker-result",
        data={
            "generation_revision": str(context["generation_revision"]),
            "source_hash": context["source_hash"],
            "provider_request_id": "",
            "media_type": "audio/wav",
        },
        files={"audio": ("provider.wav", b"not persisted", "audio/wav")},
        headers={
            "X-WMS-Worker-Token": "test-worker-token-at-least-32-chars",
            "X-Content-Job-Id": str(job["id"]),
        },
    )
    assert stale.status_code == 409
    assert stale.headers["X-WMS-Retryable"] == "false"
    assert not uploads.exists() or list(uploads.rglob("*.mp3")) == []


def test_worker_result_rejects_empty_corrupt_oversized_and_unsupported_audio(
    client,
    monkeypatch,
    tmp_path,
):
    import routers.text_videos as router_module
    import text_video_audio
    import text_video_jobs

    uploads = tmp_path / "invalid uploads"
    monkeypatch.setattr(router_module, "UPLOADS_DIR", uploads)
    monkeypatch.setattr(text_video_audio, "UPLOADS_DIR", uploads)
    monkeypatch.setattr(text_video_jobs, "UPLOADS_DIR", uploads)

    async def ignore_enqueue(_job_id: int):
        return None

    monkeypatch.setattr(text_video_jobs, "enqueue_job", ignore_enqueue)
    project = _speech_project(client)
    segment = project["paragraphs"][0]
    job = client.post(
        f"/api/text-videos/{project['id']}/speech-segments/"
        f"{segment['id']}/generate",
        json={"revision": project["revision"]},
    ).json()["jobs"][0]
    context = client.get(
        f"/api/text-videos/{project['id']}/speech-segments/"
        f"{segment['id']}/worker-context",
        headers={
            "X-WMS-Worker-Token": "test-worker-token-at-least-32-chars",
            "X-Content-Job-Id": str(job["id"]),
        },
    ).json()
    path = (
        f"/api/text-videos/{project['id']}/speech-segments/"
        f"{segment['id']}/worker-result"
    )
    headers = {
        "X-WMS-Worker-Token": "test-worker-token-at-least-32-chars",
        "X-Content-Job-Id": str(job["id"]),
    }
    form = {
        "generation_revision": str(context["generation_revision"]),
        "source_hash": context["source_hash"],
        "provider_request_id": "",
        "media_type": "audio/wav",
    }

    empty = client.post(
        path,
        data=form,
        files={"audio": ("empty.wav", b"", "audio/wav")},
        headers=headers,
    )
    corrupt = client.post(
        path,
        data=form,
        files={"audio": ("corrupt.wav", b"not audio", "audio/wav")},
        headers=headers,
    )
    unsupported = client.post(
        path,
        data={**form, "media_type": "audio/ogg"},
        files={"audio": ("speech.ogg", b"data", "audio/ogg")},
        headers=headers,
    )
    monkeypatch.setattr(router_module, "MAX_SPEECH_AUDIO_BYTES", 4)
    oversized = client.post(
        path,
        data=form,
        files={"audio": ("large.wav", b"12345", "audio/wav")},
        headers=headers,
    )

    assert empty.status_code == 422
    assert corrupt.status_code == 422
    assert unsupported.status_code == 422
    assert oversized.status_code == 413
    assert list(uploads.rglob("*.mp3")) == []


def test_worker_result_maps_missing_ffmpeg_to_actionable_503(
    client,
    monkeypatch,
    tmp_path,
):
    import routers.text_videos as router_module
    import text_video_jobs
    from media_command import MediaToolUnavailable

    uploads = tmp_path / "missing ffmpeg"
    monkeypatch.setattr(router_module, "UPLOADS_DIR", uploads)
    monkeypatch.setattr(text_video_jobs, "UPLOADS_DIR", uploads)

    async def ignore_enqueue(_job_id: int):
        return None

    async def missing_tool(*_args, **_kwargs):
        raise MediaToolUnavailable(
            ["ffmpeg"],
            None,
            "",
            message="ffmpeg is not installed",
        )

    monkeypatch.setattr(text_video_jobs, "enqueue_job", ignore_enqueue)
    monkeypatch.setattr(
        router_module,
        "save_text_video_audio_asset",
        missing_tool,
    )
    project = _speech_project(client)
    segment = project["paragraphs"][0]
    job = client.post(
        f"/api/text-videos/{project['id']}/speech-segments/"
        f"{segment['id']}/generate",
        json={"revision": project["revision"]},
    ).json()["jobs"][0]
    context = client.get(
        f"/api/text-videos/{project['id']}/speech-segments/"
        f"{segment['id']}/worker-context",
        headers={
            "X-WMS-Worker-Token": "test-worker-token-at-least-32-chars",
            "X-Content-Job-Id": str(job["id"]),
        },
    ).json()

    response = client.post(
        f"/api/text-videos/{project['id']}/speech-segments/"
        f"{segment['id']}/worker-result",
        data={
            "generation_revision": str(context["generation_revision"]),
            "source_hash": context["source_hash"],
            "provider_request_id": "",
            "media_type": "audio/wav",
        },
        files={"audio": ("provider.wav", b"RIFF", "audio/wav")},
        headers={
            "X-WMS-Worker-Token": "test-worker-token-at-least-32-chars",
            "X-Content-Job-Id": str(job["id"]),
        },
    )

    assert response.status_code == 503
    assert "FFmpeg/FFprobe" in response.text
    assert list(uploads.rglob("*.mp3")) == []


def test_worker_result_second_stale_check_keeps_asset_unreferenced(
    client,
    monkeypatch,
    tmp_path,
):
    import routers.text_videos as router_module
    import text_video_audio
    import text_video_jobs
    from models import CreativeAsset

    uploads = tmp_path / "second stale"
    monkeypatch.setattr(router_module, "UPLOADS_DIR", uploads)
    monkeypatch.setattr(text_video_audio, "UPLOADS_DIR", uploads)
    monkeypatch.setattr(text_video_jobs, "UPLOADS_DIR", uploads)

    async def ignore_enqueue(_job_id: int):
        return None

    monkeypatch.setattr(text_video_jobs, "enqueue_job", ignore_enqueue)
    project = _speech_project(client)
    segment = project["paragraphs"][0]
    job = client.post(
        f"/api/text-videos/{project['id']}/speech-segments/"
        f"{segment['id']}/generate",
        json={"revision": project["revision"]},
    ).json()["jobs"][0]
    context = client.get(
        f"/api/text-videos/{project['id']}/speech-segments/"
        f"{segment['id']}/worker-context",
        headers={
            "X-WMS-Worker-Token": "test-worker-token-at-least-32-chars",
            "X-Content-Job-Id": str(job["id"]),
        },
    ).json()
    original_save = router_module.save_text_video_audio_asset

    async def save_then_edit(db, *args, **kwargs):
        saved = await original_save(db, *args, **kwargs)
        current = await db.get(router_module.TextVideoProject, project["id"])
        paragraphs = list(current.paragraphs)
        paragraphs[0] = {
            **paragraphs[0],
            "generation_revision": (
                paragraphs[0]["generation_revision"] + 1
            ),
        }
        current.paragraphs = paragraphs
        await db.flush()
        return saved

    monkeypatch.setattr(
        router_module,
        "save_text_video_audio_asset",
        save_then_edit,
    )
    wav = tmp_path / "provider.wav"
    asyncio.new_event_loop().run_until_complete(
        __import__("tests.test_media_command", fromlist=["sine_wave"])
        .sine_wave(wav),
    )
    response = client.post(
        f"/api/text-videos/{project['id']}/speech-segments/"
        f"{segment['id']}/worker-result",
        data={
            "generation_revision": str(context["generation_revision"]),
            "source_hash": context["source_hash"],
            "provider_request_id": "",
            "media_type": "audio/wav",
        },
        files={"audio": ("provider.wav", wav.read_bytes(), "audio/wav")},
        headers={
            "X-WMS-Worker-Token": "test-worker-token-at-least-32-chars",
            "X-Content-Job-Id": str(job["id"]),
        },
    )
    assert response.status_code == 409
    assert response.headers["X-WMS-Retryable"] == "false"
    detail = client.get(f"/api/text-videos/{project['id']}").json()
    assert detail["paragraphs"][0]["audio_url"] == ""
    assert detail["paragraphs"][0]["status"] == "generating"

    from database import SessionLocal
    from sqlalchemy import func, select

    async def count_assets():
        async with SessionLocal() as session:
            return await session.scalar(select(func.count(CreativeAsset.id)))

    assert asyncio.new_event_loop().run_until_complete(count_assets()) == 1
    assert len(list(uploads.glob("*.mp3"))) == 1


def test_worker_result_second_check_observes_cancellation_after_normalize(
    client,
    monkeypatch,
    tmp_path,
):
    import routers.text_videos as router_module
    import text_video_audio
    import text_video_jobs

    uploads = tmp_path / "cancel during normalize"
    monkeypatch.setattr(router_module, "UPLOADS_DIR", uploads)
    monkeypatch.setattr(text_video_audio, "UPLOADS_DIR", uploads)
    monkeypatch.setattr(text_video_jobs, "UPLOADS_DIR", uploads)

    async def ignore_enqueue(_job_id: int):
        return None

    monkeypatch.setattr(text_video_jobs, "enqueue_job", ignore_enqueue)
    project = _speech_project(client)
    segment = project["paragraphs"][0]
    job = client.post(
        f"/api/text-videos/{project['id']}/speech-segments/"
        f"{segment['id']}/generate",
        json={"revision": project["revision"]},
    ).json()["jobs"][0]
    context = client.get(
        f"/api/text-videos/{project['id']}/speech-segments/"
        f"{segment['id']}/worker-context",
        headers={
            "X-WMS-Worker-Token": "test-worker-token-at-least-32-chars",
            "X-Content-Job-Id": str(job["id"]),
        },
    ).json()
    original_save = router_module.save_text_video_audio_asset

    async def save_then_cancel(db, *args, **kwargs):
        saved = await original_save(db, *args, **kwargs)
        current_job = await db.get(router_module.ContentJob, job["id"])
        current_job.status = "cancelled"
        await db.flush()
        return saved

    monkeypatch.setattr(
        router_module,
        "save_text_video_audio_asset",
        save_then_cancel,
    )
    wav = tmp_path / "provider.wav"
    asyncio.new_event_loop().run_until_complete(
        __import__("tests.test_media_command", fromlist=["sine_wave"])
        .sine_wave(wav),
    )
    response = client.post(
        f"/api/text-videos/{project['id']}/speech-segments/"
        f"{segment['id']}/worker-result",
        data={
            "generation_revision": str(context["generation_revision"]),
            "source_hash": context["source_hash"],
            "provider_request_id": "",
            "media_type": "audio/wav",
        },
        files={"audio": ("provider.wav", wav.read_bytes(), "audio/wav")},
        headers={
            "X-WMS-Worker-Token": "test-worker-token-at-least-32-chars",
            "X-Content-Job-Id": str(job["id"]),
        },
    )

    assert response.status_code == 409
    assert response.headers["X-WMS-Retryable"] == "false"
    detail = client.get(f"/api/text-videos/{project['id']}").json()
    assert detail["paragraphs"][0]["audio_url"] == ""
    assert detail["paragraphs"][0]["status"] == "generating"
    assert len(list(uploads.glob("*.mp3"))) == 1


def test_worker_result_commit_failure_deletes_final_file(
    client,
    monkeypatch,
    tmp_path,
):
    import routers.text_videos as router_module
    import text_video_audio
    import text_video_jobs
    from sqlalchemy.ext.asyncio import AsyncSession

    uploads = tmp_path / "commit failure"
    monkeypatch.setattr(router_module, "UPLOADS_DIR", uploads)
    monkeypatch.setattr(text_video_audio, "UPLOADS_DIR", uploads)
    monkeypatch.setattr(text_video_jobs, "UPLOADS_DIR", uploads)

    async def ignore_enqueue(_job_id: int):
        return None

    monkeypatch.setattr(text_video_jobs, "enqueue_job", ignore_enqueue)
    project = _speech_project(client)
    segment = project["paragraphs"][0]
    job = client.post(
        f"/api/text-videos/{project['id']}/speech-segments/"
        f"{segment['id']}/generate",
        json={"revision": project["revision"]},
    ).json()["jobs"][0]
    context = client.get(
        f"/api/text-videos/{project['id']}/speech-segments/"
        f"{segment['id']}/worker-context",
        headers={
            "X-WMS-Worker-Token": "test-worker-token-at-least-32-chars",
            "X-Content-Job-Id": str(job["id"]),
        },
    ).json()
    wav = tmp_path / "provider.wav"
    asyncio.new_event_loop().run_until_complete(
        __import__("tests.test_media_command", fromlist=["sine_wave"])
        .sine_wave(wav),
    )

    async def fail_commit(_self):
        raise RuntimeError("database commit failed")

    monkeypatch.setattr(AsyncSession, "commit", fail_commit)
    with pytest.raises(RuntimeError, match="database commit failed"):
        client.post(
            f"/api/text-videos/{project['id']}/speech-segments/"
            f"{segment['id']}/worker-result",
            data={
                "generation_revision": str(context["generation_revision"]),
                "source_hash": context["source_hash"],
                "provider_request_id": "",
                "media_type": "audio/wav",
            },
            files={
                "audio": ("provider.wav", wav.read_bytes(), "audio/wav"),
            },
            headers={
                "X-WMS-Worker-Token": (
                    "test-worker-token-at-least-32-chars"
                ),
                "X-Content-Job-Id": str(job["id"]),
            },
        )
    assert list(uploads.glob("*.mp3")) == []


def test_worker_result_second_lock_failure_deletes_final_file(
    client,
    monkeypatch,
    tmp_path,
):
    import routers.text_videos as router_module
    import text_video_audio
    import text_video_jobs

    uploads = tmp_path / "second lock failure"
    monkeypatch.setattr(router_module, "UPLOADS_DIR", uploads)
    monkeypatch.setattr(text_video_audio, "UPLOADS_DIR", uploads)
    monkeypatch.setattr(text_video_jobs, "UPLOADS_DIR", uploads)

    async def ignore_enqueue(_job_id: int):
        return None

    monkeypatch.setattr(text_video_jobs, "enqueue_job", ignore_enqueue)
    project = _speech_project(client)
    segment = project["paragraphs"][0]
    job = client.post(
        f"/api/text-videos/{project['id']}/speech-segments/"
        f"{segment['id']}/generate",
        json={"revision": project["revision"]},
    ).json()["jobs"][0]
    context = client.get(
        f"/api/text-videos/{project['id']}/speech-segments/"
        f"{segment['id']}/worker-context",
        headers={
            "X-WMS-Worker-Token": "test-worker-token-at-least-32-chars",
            "X-Content-Job-Id": str(job["id"]),
        },
    ).json()
    wav = tmp_path / "provider-lock-failure.wav"
    asyncio.new_event_loop().run_until_complete(
        __import__("tests.test_media_command", fromlist=["sine_wave"])
        .sine_wave(wav),
    )
    original_save = router_module.save_text_video_audio_asset

    async def save_then_break_lock(db, *args, **kwargs):
        saved = await original_save(db, *args, **kwargs)

        async def fail_lock_query(*_args, **_kwargs):
            raise RuntimeError("second lock query failed")

        db.scalar = fail_lock_query
        return saved

    monkeypatch.setattr(
        router_module,
        "save_text_video_audio_asset",
        save_then_break_lock,
    )
    with pytest.raises(RuntimeError, match="second lock query failed"):
        client.post(
            f"/api/text-videos/{project['id']}/speech-segments/"
            f"{segment['id']}/worker-result",
            data={
                "generation_revision": str(context["generation_revision"]),
                "source_hash": context["source_hash"],
                "provider_request_id": "",
                "media_type": "audio/wav",
            },
            files={"audio": ("provider.wav", wav.read_bytes(), "audio/wav")},
            headers={
                "X-WMS-Worker-Token": (
                    "test-worker-token-at-least-32-chars"
                ),
                "X-Content-Job-Id": str(job["id"]),
            },
        )
    assert list(uploads.glob("*.mp3")) == []


def test_worker_result_cancelled_during_second_lock_deletes_final_file(
    client,
    monkeypatch,
    tmp_path,
):
    import routers.text_videos as router_module
    import text_video_audio
    import text_video_jobs
    from database import SessionLocal

    uploads = tmp_path / "cancelled lock wait"
    monkeypatch.setattr(router_module, "UPLOADS_DIR", uploads)
    monkeypatch.setattr(text_video_audio, "UPLOADS_DIR", uploads)
    monkeypatch.setattr(text_video_jobs, "UPLOADS_DIR", uploads)

    async def ignore_enqueue(_job_id: int):
        return None

    monkeypatch.setattr(text_video_jobs, "enqueue_job", ignore_enqueue)
    project = _speech_project(client)
    segment = project["paragraphs"][0]
    job = client.post(
        f"/api/text-videos/{project['id']}/speech-segments/"
        f"{segment['id']}/generate",
        json={"revision": project["revision"]},
    ).json()["jobs"][0]
    context = client.get(
        f"/api/text-videos/{project['id']}/speech-segments/"
        f"{segment['id']}/worker-context",
        headers={
            "X-WMS-Worker-Token": "test-worker-token-at-least-32-chars",
            "X-Content-Job-Id": str(job["id"]),
        },
    ).json()
    wav = tmp_path / "provider-cancel.wav"
    asyncio.new_event_loop().run_until_complete(
        __import__("tests.test_media_command", fromlist=["sine_wave"])
        .sine_wave(wav),
    )
    original_save = router_module.save_text_video_audio_asset

    async def run():
        waiting_for_lock = asyncio.Event()
        never = asyncio.Event()

        async def save_then_wait_on_lock(db, *args, **kwargs):
            saved = await original_save(db, *args, **kwargs)

            async def wait_on_lock(*_args, **_kwargs):
                waiting_for_lock.set()
                await never.wait()

            db.scalar = wait_on_lock
            return saved

        monkeypatch.setattr(
            router_module,
            "save_text_video_audio_asset",
            save_then_wait_on_lock,
        )
        async with SessionLocal() as session:
            upload = UploadFile(
                BytesIO(wav.read_bytes()),
                filename="provider.wav",
                headers=Headers({"content-type": "audio/wav"}),
            )
            task = asyncio.create_task(
                router_module.save_speech_worker_result(
                    project["id"],
                    segment["id"],
                    upload,
                    context["generation_revision"],
                    context["source_hash"],
                    "",
                    "audio/wav",
                    "[]",
                    job["id"],
                    session,
                ),
            )
            await asyncio.wait_for(waiting_for_lock.wait(), timeout=10)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

    asyncio.new_event_loop().run_until_complete(run())
    assert list(uploads.glob("*.mp3")) == []
