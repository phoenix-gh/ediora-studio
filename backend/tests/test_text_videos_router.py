import asyncio
from io import BytesIO
import json
from pathlib import Path
import sys
from types import SimpleNamespace

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


def _set_ready_master(project_id, *, duration=4.2, words=None):
    from database import SessionLocal
    from models import TextVideoProject
    from text_video_domain import empty_master_audio

    if words is None:
        words = [
            {
                "id": "word-1",
                "text": "甲",
                "start": 0.2,
                "end": 0.5,
                "speech_segment_id": "paragraph-1",
            },
            {
                "id": "word-2",
                "text": "乙",
                "start": 0.7,
                "end": 1.0,
                "speech_segment_id": "paragraph-1",
            },
            {
                "id": "word-3",
                "text": "丙",
                "start": 2.2,
                "end": 2.5,
                "speech_segment_id": "paragraph-1",
            },
            {
                "id": "word-4",
                "text": "丁",
                "start": 3.2,
                "end": 3.5,
                "speech_segment_id": "paragraph-1",
            },
        ]

    async def prepare():
        async with SessionLocal() as session:
            project = await session.get(TextVideoProject, project_id)
            project.master_audio = empty_master_audio() | {
                "status": "ready",
                "timeline_status": "ready",
                "audio_url": "/api/uploads/master.mp3",
                "duration": duration,
                "source_hash": "a" * 64,
                "word_timings": words,
                "timeline_source": "provider",
            }
            await session.commit()

    asyncio.new_event_loop().run_until_complete(prepare())
    return words


def _scene_scenes():
    return [
        {
            "id": "scene-1",
            "fromWordId": "word-1",
            "throughWordId": "word-2",
            "displayText": "甲乙",
            "highlight": ["甲"],
            "animation": "fade-up",
        },
        {
            "id": "scene-2",
            "fromWordId": "word-3",
            "throughWordId": "word-4",
            "displayText": "丙丁",
            "highlight": ["丁"],
            "animation": "scale",
        },
    ]


def _subframe_words():
    return [
        {
            "id": f"word-{index}",
            "text": text,
            "start": start,
            "end": end,
            "speech_segment_id": "paragraph-1",
        }
        for index, (text, start, end) in enumerate(
            [
                ("甲", 0.0, 0.005),
                ("乙", 0.01, 0.015),
                ("丙", 0.02, 0.025),
            ],
            start=1,
        )
    ]


def _subframe_scenes():
    return [
        {
            "id": "scene-1",
            "fromWordId": "word-1",
            "throughWordId": "word-1",
            "displayText": "甲",
            "highlight": [],
            "animation": "fade-up",
        },
        {
            "id": "scene-2",
            "fromWordId": "word-2",
            "throughWordId": "word-2",
            "displayText": "乙",
            "highlight": [],
            "animation": "scale",
        },
        {
            "id": "scene-3",
            "fromWordId": "word-3",
            "throughWordId": "word-3",
            "displayText": "丙",
            "highlight": [],
            "animation": "fade-up",
        },
    ]


def _scene_worker_headers(
    job_id,
    step_id,
    *,
    attempt=1,
    claim="scene-claim-token-1234567890",
):
    return {
        "X-WMS-Worker-Token": "test-worker-token-at-least-32-chars",
        "X-Content-Job-Id": str(job_id),
        "X-Content-Step-Id": str(step_id),
        "X-Content-Step-Attempt": str(attempt),
        "X-Content-Step-Claim": claim,
    }


def _start_scene_job(
    client,
    job_id,
    *,
    project_id=None,
    claim="scene-claim-token-1234567890",
):
    started = client.post(
        f"/api/jobs/{job_id}/steps/generate_scene_plan/start",
    )
    assert started.status_code == 200, started.text
    step = started.json()
    headers = _scene_worker_headers(
        job_id,
        step["id"],
        attempt=step["attempt"],
        claim=claim,
    )
    if project_id is not None:
        context = client.get(
            f"/api/text-videos/{project_id}/scene-plan/worker-context",
            headers=headers,
        )
        assert context.status_code == 200, context.text
    return step, headers


def _prepare_speech_worker_result(
    client,
    monkeypatch,
    tmp_path,
    directory_name,
):
    import routers.text_videos as router_module
    import text_video_audio
    import text_video_jobs

    uploads = tmp_path / directory_name
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
    wav = tmp_path / f"{directory_name}.wav"
    asyncio.new_event_loop().run_until_complete(
        __import__("tests.test_media_command", fromlist=["sine_wave"])
        .sine_wave(wav),
    )
    return {
        "router": router_module,
        "uploads": uploads,
        "project": project,
        "segment": segment,
        "job": job,
        "context": context,
        "wav": wav,
    }


async def _submit_prepared_speech_worker_result(case, session):
    upload = UploadFile(
        BytesIO(case["wav"].read_bytes()),
        filename="provider.wav",
        headers=Headers({"content-type": "audio/wav"}),
    )
    return await case["router"].save_speech_worker_result(
        case["project"]["id"],
        case["segment"]["id"],
        upload,
        case["context"]["generation_revision"],
        case["context"]["source_hash"],
        "",
        "audio/wav",
        "[]",
        case["job"]["id"],
        session,
    )


def test_scene_generate_reads_current_job_without_a_second_row_lock(client):
    from sqlalchemy.dialects import postgresql

    import routers.text_videos as router_module

    statement = router_module._scene_current_job_statement(17)
    sql = str(statement.compile(dialect=postgresql.dialect())).upper()

    assert "CONTENT_JOBS" in sql
    assert "FOR UPDATE" not in sql


def test_scene_worker_rejects_a_malformed_frozen_job_as_stale(client):
    import routers.text_videos as router_module

    malformed = SimpleNamespace(
        flow="text_video_scene_plan",
        status="running",
        input_data={
            "project_id": 1,
            "request_hash": "not-a-valid-snapshot",
        },
    )

    with pytest.raises(
        router_module.StaleScenePlanJob,
        match="任务快照无效",
    ):
        router_module._validate_scene_job(malformed, project_id=1)


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
    assert client.get("/api/text-videos").json()[0]["duration"] == 0

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


def test_patch_persists_explicit_ai_speech_split_mode(client):
    project = client.post("/api/text-videos", json={}).json()

    response = client.patch(
        f"/api/text-videos/{project['id']}",
        json={
            "revision": project["revision"],
            "script": "甲。乙。",
            "paragraphs": [
                {"id": "a", "text": "甲。"},
                {"id": "b", "text": "乙。"},
            ],
            "speech_split_mode": "auto",
        },
    )

    assert response.status_code == 200, response.text
    assert response.json()["speech_split_mode"] == "auto"


def test_patch_normalizes_single_segment_ai_mode_to_single(client):
    project = client.post("/api/text-videos", json={}).json()

    response = client.patch(
        f"/api/text-videos/{project['id']}",
        json={
            "revision": project["revision"],
            "script": "完整口播。",
            "paragraphs": [
                {"id": "only", "text": "完整口播。"},
            ],
            "speech_split_mode": "auto",
        },
    )

    assert response.status_code == 200, response.text
    assert response.json()["speech_split_mode"] == "single"


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


def test_patch_rejects_browser_owned_render_input(client):
    project = client.post("/api/text-videos", json={}).json()
    response = client.patch(
        f"/api/text-videos/{project['id']}",
        json={
            "revision": project["revision"],
            "render_input": project["render_input"],
        },
    )

    assert response.status_code == 422
    assert "render_input" in response.text


def test_scene_plan_patch_projects_authoritative_audio_and_seconds(client):
    project = _speech_project(client, "甲乙丙")
    _set_ready_master(project["id"])
    before = client.get(f"/api/text-videos/{project['id']}").json()
    scenes = [
        {
            "id": "scene-1",
            "fromWordId": "word-1",
            "throughWordId": "word-2",
            "displayText": "甲乙",
            "highlight": ["甲"],
            "animation": "fade-up",
        },
        {
            "id": "scene-2",
            "fromWordId": "word-3",
            "throughWordId": "word-4",
            "displayText": "丙丁",
            "highlight": ["丁"],
            "animation": "scale",
        },
    ]

    response = client.patch(
        f"/api/text-videos/{project['id']}",
        json={
            "revision": project["revision"],
            "scene_plan": {"scenes": scenes},
        },
    )

    assert response.status_code == 200, response.text
    updated = response.json()
    assert updated["scene_plan"] == {
        "status": "ready",
        "generation_revision": 1,
        "master_source_hash": "a" * 64,
        "scenes": scenes,
        "job_id": None,
        "applied_job_id": None,
        "error": "",
    }
    assert updated["render_input"]["audio"] == "/api/uploads/master.mp3"
    assert updated["render_input"]["segments"] == [
        {
            "id": "scene-1",
            "start": 0.0,
            "end": 2.2,
            "text": "甲乙",
            "highlight": ["甲"],
            "animation": "fade-up",
        },
        {
            "id": "scene-2",
            "start": 2.2,
            "end": 4.2,
            "text": "丙丁",
            "highlight": ["丁"],
            "animation": "scale",
        },
    ]
    summary = client.get("/api/text-videos").json()[0]
    assert summary["duration"] == 4.2
    assert updated["master_audio"] == before["master_audio"]
    assert updated["paragraphs"] == before["paragraphs"]

    repeated = client.patch(
        f"/api/text-videos/{project['id']}",
        json={
            "revision": updated["revision"],
            "scene_plan": {"scenes": scenes},
        },
    )
    assert repeated.status_code == 200, repeated.text
    assert repeated.json()["scene_plan"]["generation_revision"] == 1

    last_valid = repeated.json()
    invalid = client.patch(
        f"/api/text-videos/{project['id']}",
        json={
            "revision": last_valid["revision"],
            "scene_plan": {
                "scenes": [{
                    **scenes[0],
                    "throughWordId": "word-3",
                }, scenes[1]],
            },
        },
    )
    assert invalid.status_code == 422
    preserved = client.get(f"/api/text-videos/{project['id']}").json()
    assert preserved["revision"] == last_valid["revision"]
    assert preserved["scene_plan"] == last_valid["scene_plan"]
    assert preserved["render_input"] == last_valid["render_input"]


def test_scene_plan_patch_rejects_timing_fields_and_preserves_projection(client):
    project = _speech_project(client, "甲乙丙丁")
    _set_ready_master(project["id"])
    before = client.get(f"/api/text-videos/{project['id']}").json()

    response = client.patch(
        f"/api/text-videos/{project['id']}",
        json={
            "revision": project["revision"],
            "scene_plan": {
                "scenes": [{
                    "id": "scene-1",
                    "fromWordId": "word-1",
                    "throughWordId": "word-4",
                    "displayText": "甲乙丙丁",
                    "highlight": [],
                    "animation": "fade-up",
                    "start": 0,
                    "end": 4.2,
                }],
            },
        },
    )

    assert response.status_code == 422
    after = client.get(f"/api/text-videos/{project['id']}").json()
    assert after["revision"] == before["revision"]
    assert after["scene_plan"] == before["scene_plan"]
    assert after["render_input"] == before["render_input"]


def test_scene_plan_requires_ready_current_master_timeline(client):
    project = _speech_project(client, "甲乙")
    response = client.patch(
        f"/api/text-videos/{project['id']}",
        json={
            "revision": project["revision"],
            "scene_plan": {
                "scenes": [{
                    "id": "scene-1",
                    "fromWordId": "word-1",
                    "throughWordId": "word-1",
                    "displayText": "甲乙",
                    "highlight": [],
                    "animation": "fade-up",
                }],
            },
        },
    )
    assert response.status_code == 422
    assert "主音频时间轴" in response.text


def test_template_and_composition_edits_reproject_or_fail_atomically(client):
    project = _speech_project(client, "甲乙丙丁")
    _set_ready_master(project["id"])
    scenes = [
        {
            "id": "scene-1",
            "fromWordId": "word-1",
            "throughWordId": "word-2",
            "displayText": "甲乙",
            "highlight": [],
            "animation": "fade-up",
        },
        {
            "id": "scene-2",
            "fromWordId": "word-3",
            "throughWordId": "word-4",
            "displayText": "丙丁",
            "highlight": [],
            "animation": "scale",
        },
    ]
    ready = client.patch(
        f"/api/text-videos/{project['id']}",
        json={
            "revision": project["revision"],
            "scene_plan": {"scenes": scenes},
        },
    ).json()

    landscape = client.patch(
        f"/api/text-videos/{project['id']}",
        json={
            "revision": ready["revision"],
            "composition": {"width": 1920, "height": 1080, "fps": 30},
        },
    )
    assert landscape.status_code == 200, landscape.text
    changed = landscape.json()
    assert changed["render_input"]["composition"] == {
        "width": 1920,
        "height": 1080,
        "fps": 30,
    }
    assert changed["render_input"]["segments"] == ready["render_input"]["segments"]
    assert changed["render_input"]["audio"] == ready["render_input"]["audio"]
    assert (
        changed["scene_plan"]["generation_revision"]
        == ready["scene_plan"]["generation_revision"]
    )

    invalid = client.patch(
        f"/api/text-videos/{project['id']}",
        json={
            "revision": changed["revision"],
            "template": {
                "templateId": "tech-text-v1",
                "templateVersion": 1,
                "templateProps": {
                    **changed["render_input"]["templateProps"],
                    "transition": "wipe",
                },
            },
        },
    )
    assert invalid.status_code == 422
    after = client.get(f"/api/text-videos/{project['id']}").json()
    assert after["revision"] == changed["revision"]
    assert after["scene_plan"] == changed["scene_plan"]
    assert after["render_input"] == changed["render_input"]


def test_unknown_template_pair_is_visible_but_not_editable(client):
    from database import SessionLocal
    from models import TextVideoProject

    project = client.post("/api/text-videos", json={}).json()

    async def store_legacy_unknown_pair():
        async with SessionLocal() as session:
            stored = await session.get(TextVideoProject, project["id"])
            stored.render_input = {
                **stored.render_input,
                "templateId": "retired-template",
                "templateVersion": 9,
            }
            await session.commit()

    asyncio.new_event_loop().run_until_complete(store_legacy_unknown_pair())
    readable = client.get(f"/api/text-videos/{project['id']}")
    assert readable.status_code == 200
    assert readable.json()["render_input"]["templateId"] == "retired-template"
    assert client.get("/api/text-videos").json()[0]["duration"] == 0

    edit = client.patch(
        f"/api/text-videos/{project['id']}",
        json={
            "revision": project["revision"],
            "composition": {"width": 1080, "height": 1080, "fps": 30},
        },
    )
    assert edit.status_code == 422
    assert "retired-template@9" in edit.text


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


def test_scene_plan_launch_snapshots_ready_timeline_template_and_preserves_render(
    client,
    monkeypatch,
):
    import routers.text_videos as router_module

    queued: list[int] = []

    async def capture_enqueue(job_id: int):
        queued.append(job_id)

    monkeypatch.setattr(router_module, "enqueue_job", capture_enqueue)
    project = _speech_project(client, "甲乙丙丁")
    words = _set_ready_master(project["id"])
    current = client.get(f"/api/text-videos/{project['id']}").json()
    original_render = current["render_input"]

    response = client.post(
        f"/api/text-videos/{project['id']}/scene-plan/generate",
        json={
            "revision": current["revision"],
            "scope": "all",
            "selected_scene_id": "",
            "direction": "减少每屏文字",
        },
    )

    assert response.status_code == 201, response.text
    launched = response.json()
    job = client.get(f"/api/jobs/{launched['jobs'][0]['id']}").json()
    assert launched["jobs"] == [{
        "id": job["id"],
        "flow": "text_video_scene_plan",
        "target_id": project["id"],
    }]
    assert queued == [job["id"]]
    assert job["input"]["master_source_hash"] == "a" * 64
    assert len(job["input"]["timeline_fingerprint"]) == 64
    assert len(job["input"]["manifest_digest"]) == 64
    assert len(job["input"]["visual_selection_fingerprint"]) == 64
    assert len(job["input"]["existing_scenes_digest"]) == 64
    assert job["input"]["scene_generation_revision"] == 0
    assert job["input"]["words"] == words
    assert job["input"]["speech_segments"] == [{
        "id": "paragraph-1",
        "fromWordId": "word-1",
        "throughWordId": "word-4",
    }]
    assert job["input"]["template"] == {
        "id": "tech-text-v1",
        "version": 1,
        "animations": ["fade-up", "scale"],
        "transitions": ["soft-push"],
    }
    assert job["input"]["scope"] == "all"
    assert job["input"]["direction"] == "减少每屏文字"
    assert len(job["input"]["request_hash"]) == 64
    assert len(job["input"]["idempotency_key"]) < 128
    assert job["input"]["idempotency_key"].startswith(
        f"text-video-scene:{project['id']}:",
    )
    assert launched["project"]["scene_plan"] == {
        **current["scene_plan"],
        "status": "generating",
        "job_id": job["id"],
        "error": "",
    }
    assert launched["project"]["render_input"] == original_render


def test_scene_worker_context_claim_and_strict_word_only_validation(
    client,
    monkeypatch,
):
    import routers.text_videos as router_module

    async def ignore_enqueue(_job_id: int):
        return None

    monkeypatch.setattr(router_module, "enqueue_job", ignore_enqueue)
    project = _speech_project(client, "甲乙丙丁")
    _set_ready_master(project["id"])
    current = client.get(f"/api/text-videos/{project['id']}").json()
    launched = client.post(
        f"/api/text-videos/{project['id']}/scene-plan/generate",
        json={
            "revision": current["revision"],
            "scope": "all",
            "selected_scene_id": "",
            "direction": "",
        },
    ).json()
    job_id = launched["jobs"][0]["id"]
    _, headers = _start_scene_job(
        client,
        job_id,
        project_id=project["id"],
    )

    context = client.get(
        f"/api/text-videos/{project['id']}/scene-plan/worker-context",
        headers=headers,
    )
    assert context.status_code == 200, context.text
    assert context.json()["project_id"] == project["id"]
    assert context.json()["timeline_fingerprint"]
    assert context.json()["template"]["id"] == "tech-text-v1"

    competing = client.get(
        f"/api/text-videos/{project['id']}/scene-plan/worker-context",
        headers={
            **headers,
            "X-Content-Step-Claim": "competing-claim-token-123456",
        },
    )
    assert competing.status_code == 409
    assert competing.headers["X-WMS-Retryable"] == "false"

    with_timing = client.post(
        f"/api/text-videos/{project['id']}/scene-plan/worker-validate",
        json={
            "scenes": [{
                **_scene_scenes()[0],
                "throughWordId": "word-4",
                "displayText": "甲乙丙丁",
                "highlight": [],
                "start": 0,
                "end": 4.2,
            }],
        },
        headers=headers,
    )
    assert with_timing.status_code == 422

    valid = client.post(
        f"/api/text-videos/{project['id']}/scene-plan/worker-validate",
        json={
            "scenes": [{
                **_scene_scenes()[0],
                "throughWordId": "word-4",
                "displayText": "甲乙丙丁",
                "highlight": ["甲"],
            }],
        },
        headers=headers,
    )
    assert valid.status_code == 200, valid.text
    assert len(valid.json()["validation_token"]) == 64


def test_scene_worker_validation_rejects_subframe_scene_and_accepts_repair(
    client,
    monkeypatch,
):
    import routers.text_videos as router_module

    async def ignore_enqueue(_job_id: int):
        return None

    monkeypatch.setattr(router_module, "enqueue_job", ignore_enqueue)
    project = _speech_project(client, "甲乙丙丁")
    _set_ready_master(
        project["id"],
        duration=0.04,
        words=_subframe_words(),
    )
    current = client.get(f"/api/text-videos/{project['id']}").json()
    launched = client.post(
        f"/api/text-videos/{project['id']}/scene-plan/generate",
        json={
            "revision": current["revision"],
            "scope": "all",
            "selected_scene_id": "",
            "direction": "",
        },
    ).json()
    job_id = launched["jobs"][0]["id"]
    _, headers = _start_scene_job(
        client,
        job_id,
        project_id=project["id"],
    )

    unsafe = client.post(
        f"/api/text-videos/{project['id']}/scene-plan/worker-validate",
        json={"scenes": _subframe_scenes()},
        headers=headers,
    )
    assert unsafe.status_code == 422, unsafe.text
    assert unsafe.headers["X-WMS-Retryable"] == "false"
    assert "安全帧" in unsafe.json()["detail"]["message"]

    repaired_scenes = [
        _subframe_scenes()[0],
        {
            **_subframe_scenes()[1],
            "throughWordId": "word-3",
            "displayText": "乙丙",
        },
    ]
    repaired = client.post(
        f"/api/text-videos/{project['id']}/scene-plan/worker-validate",
        json={"scenes": repaired_scenes},
        headers=headers,
    )
    assert repaired.status_code == 200, repaired.text
    assert repaired.json()["scenes"] == repaired_scenes
    assert len(repaired.json()["validation_token"]) == 64


def test_scene_worker_result_rechecks_subframe_safety_with_master_duration(
    client,
    monkeypatch,
):
    import routers.text_videos as router_module
    from database import SessionLocal
    from models import ContentJob, ContentJobStep

    async def ignore_enqueue(_job_id: int):
        return None

    monkeypatch.setattr(router_module, "enqueue_job", ignore_enqueue)
    project = _speech_project(client, "甲乙丙")
    _set_ready_master(
        project["id"],
        duration=0.04,
        words=_subframe_words(),
    )
    current = client.get(f"/api/text-videos/{project['id']}").json()
    launched = client.post(
        f"/api/text-videos/{project['id']}/scene-plan/generate",
        json={
            "revision": current["revision"],
            "scope": "all",
            "selected_scene_id": "",
            "direction": "",
        },
    ).json()
    job_id = launched["jobs"][0]["id"]
    step, headers = _start_scene_job(
        client,
        job_id,
        project_id=project["id"],
    )
    scenes = _subframe_scenes()

    async def make_token():
        async with SessionLocal() as session:
            job = await session.get(ContentJob, job_id)
            stored_step = await session.get(ContentJobStep, step["id"])
            return router_module._scene_validation_token(
                job=job,
                step=stored_step,
                claim_token=headers["X-Content-Step-Claim"],
                scenes=scenes,
            )

    token = asyncio.new_event_loop().run_until_complete(make_token())
    result = client.post(
        f"/api/text-videos/{project['id']}/scene-plan/worker-result",
        json={"scenes": scenes, "validation_token": token},
        headers=headers,
    )

    assert result.status_code == 422, result.text
    assert result.headers["X-WMS-Retryable"] == "false"
    assert "安全帧" in result.json()["detail"]["message"]
    after = client.get(f"/api/text-videos/{project['id']}").json()
    assert after["scene_plan"]["status"] == "generating"
    assert after["scene_plan"]["scenes"] == current["scene_plan"]["scenes"]
    assert after["render_input"] == current["render_input"]


def test_selected_scene_validation_returns_frozen_full_canonical_plan(
    client,
    monkeypatch,
):
    import routers.text_videos as router_module

    async def ignore_enqueue(_job_id: int):
        return None

    monkeypatch.setattr(router_module, "enqueue_job", ignore_enqueue)
    project = _speech_project(client, "甲乙丙丁")
    _set_ready_master(project["id"])
    ready = client.patch(
        f"/api/text-videos/{project['id']}",
        json={
            "revision": project["revision"],
            "scene_plan": {"scenes": _scene_scenes()},
        },
    ).json()
    launched = client.post(
        f"/api/text-videos/{project['id']}/scene-plan/generate",
        json={
            "revision": ready["revision"],
            "scope": "selected",
            "selected_scene_id": "scene-1",
            "direction": "强化重点",
        },
    ).json()
    job_id = launched["jobs"][0]["id"]
    _, headers = _start_scene_job(
        client,
        job_id,
        project_id=project["id"],
    )
    raw = {
        **_scene_scenes()[0],
        "displayText": "重点甲乙",
        "highlight": ["甲"],
        "animation": "scale",
    }

    validated = client.post(
        f"/api/text-videos/{project['id']}/scene-plan/worker-validate",
        json={"scenes": [raw]},
        headers=headers,
    )

    assert validated.status_code == 200, validated.text
    assert validated.json()["scenes"] == [raw, _scene_scenes()[1]]
    assert len(validated.json()["validation_token"]) == 64

    changed_boundary = client.post(
        f"/api/text-videos/{project['id']}/scene-plan/worker-validate",
        json={
            "scenes": [{
                **raw,
                "throughWordId": "word-3",
            }],
        },
        headers=headers,
    )
    assert changed_boundary.status_code == 422
    assert changed_boundary.headers["X-WMS-Retryable"] == "false"


def test_scene_worker_result_rejects_changed_timeline_and_preserves_last_plan(
    client,
    monkeypatch,
):
    import routers.text_videos as router_module
    from database import SessionLocal
    from models import TextVideoProject

    async def ignore_enqueue(_job_id: int):
        return None

    monkeypatch.setattr(router_module, "enqueue_job", ignore_enqueue)
    project = _speech_project(client, "甲乙丙丁")
    _set_ready_master(project["id"])
    ready = client.patch(
        f"/api/text-videos/{project['id']}",
        json={
            "revision": project["revision"],
            "scene_plan": {"scenes": _scene_scenes()},
        },
    ).json()
    original_scene = ready["scene_plan"]
    original_render = ready["render_input"]
    launched = client.post(
        f"/api/text-videos/{project['id']}/scene-plan/generate",
        json={
            "revision": ready["revision"],
            "scope": "all",
            "selected_scene_id": "",
            "direction": "",
        },
    ).json()
    job_id = launched["jobs"][0]["id"]
    _, headers = _start_scene_job(
        client,
        job_id,
        project_id=project["id"],
    )
    proposal = {
        "scenes": [{
            **_scene_scenes()[0],
            "throughWordId": "word-4",
            "displayText": "甲乙丙丁",
            "highlight": ["甲"],
        }],
    }
    validated = client.post(
        f"/api/text-videos/{project['id']}/scene-plan/worker-validate",
        json=proposal,
        headers=headers,
    ).json()

    async def alter_word_timing():
        async with SessionLocal() as session:
            stored = await session.get(TextVideoProject, project["id"])
            master = dict(stored.master_audio)
            words = [dict(item) for item in master["word_timings"]]
            words[1]["start"] = 0.8
            master["word_timings"] = words
            stored.master_audio = master
            await session.commit()

    asyncio.new_event_loop().run_until_complete(alter_word_timing())
    stale = client.post(
        f"/api/text-videos/{project['id']}/scene-plan/worker-result",
        json=validated,
        headers=headers,
    )

    assert stale.status_code == 409, stale.text
    assert stale.headers["X-WMS-Retryable"] == "false"
    after = client.get(f"/api/text-videos/{project['id']}").json()
    assert after["scene_plan"]["scenes"] == original_scene["scenes"]
    assert after["scene_plan"]["generation_revision"] == (
        original_scene["generation_revision"]
    )
    assert after["render_input"] == original_render


def test_scene_worker_result_is_atomic_and_recovers_lost_ack_by_provenance(
    client,
    monkeypatch,
):
    import routers.text_videos as router_module

    async def ignore_enqueue(_job_id: int):
        return None

    monkeypatch.setattr(router_module, "enqueue_job", ignore_enqueue)
    project = _speech_project(client, "甲乙丙丁")
    _set_ready_master(project["id"])
    current = client.get(f"/api/text-videos/{project['id']}").json()
    launched = client.post(
        f"/api/text-videos/{project['id']}/scene-plan/generate",
        json={
            "revision": current["revision"],
            "scope": "all",
            "selected_scene_id": "",
            "direction": "",
        },
    ).json()
    job_id = launched["jobs"][0]["id"]
    _, headers = _start_scene_job(
        client,
        job_id,
        project_id=project["id"],
    )
    validation = client.post(
        f"/api/text-videos/{project['id']}/scene-plan/worker-validate",
        json={
            "scenes": [{
                **_scene_scenes()[0],
                "throughWordId": "word-4",
                "displayText": "甲乙丙丁",
                "highlight": ["甲"],
            }],
        },
        headers=headers,
    ).json()

    saved = client.post(
        f"/api/text-videos/{project['id']}/scene-plan/worker-result",
        json=validation,
        headers=headers,
    )
    assert saved.status_code == 200, saved.text
    body = saved.json()
    assert body["scene_plan"]["status"] == "ready"
    assert body["scene_plan"]["generation_revision"] == 1
    assert body["scene_plan"]["job_id"] is None
    assert body["scene_plan"]["applied_job_id"] == job_id
    assert body["render_input"]["audio"] == "/api/uploads/master.mp3"
    assert body["render_input"]["segments"] == [{
        "id": "scene-1",
        "start": 0.0,
        "end": 4.2,
        "text": "甲乙丙丁",
        "highlight": ["甲"],
        "animation": "fade-up",
    }]

    recovered = client.get(
        f"/api/text-videos/{project['id']}/scene-plan/worker-context",
        headers=headers,
    )
    assert recovered.status_code == 200, recovered.text
    assert recovered.json()["already_saved"] == body

    repeated = client.post(
        f"/api/text-videos/{project['id']}/scene-plan/worker-result",
        json=validation,
        headers=headers,
    )
    assert repeated.status_code == 200, repeated.text
    assert repeated.json() == body


def test_scene_failure_and_cancel_preserve_plan_and_cancel_relaunches_new_key(
    client,
    monkeypatch,
):
    import routers.jobs as jobs_router
    import routers.text_videos as router_module

    async def ignore_enqueue(_job_id: int):
        return None

    monkeypatch.setattr(router_module, "enqueue_job", ignore_enqueue)
    monkeypatch.setattr(jobs_router, "enqueue_job", ignore_enqueue)
    project = _speech_project(client, "甲乙丙丁")
    _set_ready_master(project["id"])
    ready = client.patch(
        f"/api/text-videos/{project['id']}",
        json={
            "revision": project["revision"],
            "scene_plan": {"scenes": _scene_scenes()},
        },
    ).json()
    original_render = ready["render_input"]
    first = client.post(
        f"/api/text-videos/{project['id']}/scene-plan/generate",
        json={
            "revision": ready["revision"],
            "scope": "all",
            "selected_scene_id": "",
            "direction": "",
        },
    ).json()
    first_id = first["jobs"][0]["id"]
    _, first_headers = _start_scene_job(
        client,
        first_id,
        project_id=project["id"],
    )
    failed = client.post(
        f"/api/text-videos/{project['id']}/scene-plan/worker-failure",
        json={"error": "provider unavailable"},
        headers=first_headers,
    )
    assert failed.status_code == 200, failed.text
    assert failed.json()["scene_plan"]["status"] == "failed"
    assert failed.json()["scene_plan"]["generation_revision"] == 1
    assert failed.json()["scene_plan"]["job_id"] == first_id
    assert failed.json()["scene_plan"]["scenes"] == _scene_scenes()
    assert failed.json()["render_input"] == original_render

    retry_failure_ack = client.post(
        f"/api/text-videos/{project['id']}/scene-plan/worker-failure",
        json={"error": "provider unavailable"},
        headers=first_headers,
    )
    assert retry_failure_ack.status_code == 200, retry_failure_ack.text

    cancelled = client.post(f"/api/jobs/{first_id}/cancel")
    assert cancelled.status_code == 200, cancelled.text
    after_cancel = client.get(f"/api/text-videos/{project['id']}").json()
    assert after_cancel["scene_plan"]["status"] == "failed"
    assert after_cancel["scene_plan"]["generation_revision"] == 2
    assert after_cancel["scene_plan"]["job_id"] is None
    assert after_cancel["scene_plan"]["scenes"] == _scene_scenes()
    assert after_cancel["render_input"] == original_render

    third = client.post(
        f"/api/text-videos/{project['id']}/scene-plan/generate",
        json={
            "revision": ready["revision"],
            "scope": "all",
            "selected_scene_id": "",
            "direction": "",
        },
    )
    assert third.status_code == 201, third.text
    assert third.json()["jobs"][0]["id"] != first_id


def test_scene_plan_launch_reuses_same_request_and_rejects_competing_request(
    client,
    monkeypatch,
):
    import routers.text_videos as router_module

    queued: list[int] = []

    async def capture_enqueue(job_id: int):
        queued.append(job_id)

    monkeypatch.setattr(router_module, "enqueue_job", capture_enqueue)
    project = _speech_project(client, "甲乙丙丁")
    _set_ready_master(project["id"])
    current = client.get(f"/api/text-videos/{project['id']}").json()
    request = {
        "revision": current["revision"],
        "scope": "all",
        "selected_scene_id": "",
        "direction": "简洁",
    }
    first = client.post(
        f"/api/text-videos/{project['id']}/scene-plan/generate",
        json=request,
    )
    repeated = client.post(
        f"/api/text-videos/{project['id']}/scene-plan/generate",
        json=request,
    )
    competing = client.post(
        f"/api/text-videos/{project['id']}/scene-plan/generate",
        json={**request, "direction": "完全不同"},
    )

    assert first.status_code == repeated.status_code == 201
    assert first.json()["jobs"][0]["id"] == repeated.json()["jobs"][0]["id"]
    assert competing.status_code == 409
    assert competing.headers["X-WMS-Retryable"] == "false"
    assert queued == [
        first.json()["jobs"][0]["id"],
        first.json()["jobs"][0]["id"],
    ]


def test_scene_worker_result_rejects_changed_visual_selection(
    client,
    monkeypatch,
):
    import routers.text_videos as router_module

    async def ignore_enqueue(_job_id: int):
        return None

    monkeypatch.setattr(router_module, "enqueue_job", ignore_enqueue)
    project = _speech_project(client, "甲乙丙丁")
    _set_ready_master(project["id"])
    ready = client.patch(
        f"/api/text-videos/{project['id']}",
        json={
            "revision": project["revision"],
            "scene_plan": {"scenes": _scene_scenes()},
        },
    ).json()
    launched = client.post(
        f"/api/text-videos/{project['id']}/scene-plan/generate",
        json={
            "revision": ready["revision"],
            "scope": "all",
            "selected_scene_id": "",
            "direction": "",
        },
    ).json()
    job_id = launched["jobs"][0]["id"]
    _, headers = _start_scene_job(
        client,
        job_id,
        project_id=project["id"],
    )
    validation = client.post(
        f"/api/text-videos/{project['id']}/scene-plan/worker-validate",
        json={"scenes": _scene_scenes()},
        headers=headers,
    ).json()

    changed_visual = client.patch(
        f"/api/text-videos/{project['id']}",
        json={
            "revision": ready["revision"],
            "template": {
                "templateId": "tech-text-v1",
                "templateVersion": 1,
                "templateProps": {
                    **ready["render_input"]["templateProps"],
                    "textDensity": "compact",
                },
            },
        },
    )
    assert changed_visual.status_code == 200, changed_visual.text
    stale_visual = client.post(
        f"/api/text-videos/{project['id']}/scene-plan/worker-result",
        json=validation,
        headers=headers,
    )
    assert stale_visual.status_code == 409
    assert (
        client.get(f"/api/text-videos/{project['id']}").json()
        ["render_input"]["templateProps"]["textDensity"]
        == "compact"
    )

    # Launch a new job, then a normal revision-checked scene edit owns state.
    latest = client.get(f"/api/text-videos/{project['id']}").json()
    relaunched = client.post(
        f"/api/text-videos/{project['id']}/scene-plan/generate",
        json={
            "revision": latest["revision"],
            "scope": "all",
            "selected_scene_id": "",
            "direction": "new",
        },
    )
    # The stale running job must block a competing paid request.
    assert relaunched.status_code == 409


def test_scene_worker_result_rejects_manifest_drift_for_same_template_pair(
    client,
    monkeypatch,
):
    from copy import deepcopy

    import routers.text_videos as router_module

    async def ignore_enqueue(_job_id: int):
        return None

    monkeypatch.setattr(router_module, "enqueue_job", ignore_enqueue)
    project = _speech_project(client, "甲乙丙丁")
    _set_ready_master(project["id"])
    current = client.get(f"/api/text-videos/{project['id']}").json()
    launched = client.post(
        f"/api/text-videos/{project['id']}/scene-plan/generate",
        json={
            "revision": current["revision"],
            "scope": "all",
            "selected_scene_id": "",
            "direction": "",
        },
    ).json()
    job_id = launched["jobs"][0]["id"]
    _, headers = _start_scene_job(
        client,
        job_id,
        project_id=project["id"],
    )
    validated = client.post(
        f"/api/text-videos/{project['id']}/scene-plan/worker-validate",
        json={
            "scenes": [{
                **_scene_scenes()[0],
                "throughWordId": "word-4",
                "displayText": "甲乙丙丁",
            }],
        },
        headers=headers,
    ).json()
    original_loader = router_module.get_text_video_template

    def drifted_manifest(template_id, template_version):
        manifest = deepcopy(
            original_loader(template_id, template_version),
        )
        manifest["animations"] = [
            *manifest["animations"],
            "manifest-added-animation",
        ]
        return manifest

    monkeypatch.setattr(
        router_module,
        "get_text_video_template",
        drifted_manifest,
    )

    stale = client.post(
        f"/api/text-videos/{project['id']}/scene-plan/worker-result",
        json=validated,
        headers=headers,
    )

    assert stale.status_code == 409, stale.text
    assert stale.headers["X-WMS-Retryable"] == "false"
    after = client.get(f"/api/text-videos/{project['id']}").json()
    assert after["scene_plan"]["status"] == "generating"
    assert after["scene_plan"]["scenes"] == current["scene_plan"]["scenes"]
    assert after["render_input"] == current["render_input"]


def test_manual_scene_edit_supersedes_old_validate_result_and_failure(
    client,
    monkeypatch,
):
    import routers.text_videos as router_module

    async def ignore_enqueue(_job_id: int):
        return None

    monkeypatch.setattr(router_module, "enqueue_job", ignore_enqueue)
    project = _speech_project(client, "甲乙丙丁")
    _set_ready_master(project["id"])
    ready = client.patch(
        f"/api/text-videos/{project['id']}",
        json={
            "revision": project["revision"],
            "scene_plan": {"scenes": _scene_scenes()},
        },
    ).json()
    launched = client.post(
        f"/api/text-videos/{project['id']}/scene-plan/generate",
        json={
            "revision": ready["revision"],
            "scope": "all",
            "selected_scene_id": "",
            "direction": "",
        },
    ).json()
    job_id = launched["jobs"][0]["id"]
    _, headers = _start_scene_job(
        client,
        job_id,
        project_id=project["id"],
    )
    validated = client.post(
        f"/api/text-videos/{project['id']}/scene-plan/worker-validate",
        json={"scenes": _scene_scenes()},
        headers=headers,
    ).json()
    manual_scenes = [
        {
            **_scene_scenes()[0],
            "displayText": "手动甲乙",
            "highlight": ["甲"],
            "animation": "scale",
        },
        _scene_scenes()[1],
    ]
    manual = client.patch(
        f"/api/text-videos/{project['id']}",
        json={
            "revision": ready["revision"],
            "scene_plan": {"scenes": manual_scenes},
        },
    )
    assert manual.status_code == 200, manual.text
    manual_project = manual.json()

    old_validate = client.post(
        f"/api/text-videos/{project['id']}/scene-plan/worker-validate",
        json={"scenes": _scene_scenes()},
        headers=headers,
    )
    old_result = client.post(
        f"/api/text-videos/{project['id']}/scene-plan/worker-result",
        json=validated,
        headers=headers,
    )
    old_failure = client.post(
        f"/api/text-videos/{project['id']}/scene-plan/worker-failure",
        json={"error": "late provider error"},
        headers=headers,
    )

    for response in (old_validate, old_result, old_failure):
        assert response.status_code == 409, response.text
        assert response.headers["X-WMS-Retryable"] == "false"
    after = client.get(f"/api/text-videos/{project['id']}").json()
    assert after["scene_plan"] == manual_project["scene_plan"]
    assert after["render_input"] == manual_project["render_input"]


def test_scene_worker_result_rejects_a_different_payload_with_old_token(
    client,
    monkeypatch,
):
    import routers.text_videos as router_module

    async def ignore_enqueue(_job_id: int):
        return None

    monkeypatch.setattr(router_module, "enqueue_job", ignore_enqueue)
    project = _speech_project(client, "甲乙丙丁")
    _set_ready_master(project["id"])
    current = client.get(f"/api/text-videos/{project['id']}").json()
    launched = client.post(
        f"/api/text-videos/{project['id']}/scene-plan/generate",
        json={
            "revision": current["revision"],
            "scope": "all",
            "selected_scene_id": "",
            "direction": "",
        },
    ).json()
    job_id = launched["jobs"][0]["id"]
    _, headers = _start_scene_job(
        client,
        job_id,
        project_id=project["id"],
    )
    validated = client.post(
        f"/api/text-videos/{project['id']}/scene-plan/worker-validate",
        json={
            "scenes": [{
                **_scene_scenes()[0],
                "throughWordId": "word-4",
                "displayText": "甲乙丙丁",
                "highlight": ["甲"],
            }],
        },
        headers=headers,
    ).json()
    tampered = {
        **validated,
        "scenes": [{
            **validated["scenes"][0],
            "displayText": "另一份内容",
            "highlight": [],
        }],
    }

    result = client.post(
        f"/api/text-videos/{project['id']}/scene-plan/worker-result",
        json=tampered,
        headers=headers,
    )

    assert result.status_code == 409
    assert result.headers["X-WMS-Retryable"] == "false"
    after = client.get(f"/api/text-videos/{project['id']}").json()
    assert after["scene_plan"]["status"] == "generating"
    assert after["render_input"] == current["render_input"]


def test_failed_scene_job_remains_discoverable_and_retry_restores_generation(
    client,
    monkeypatch,
):
    import routers.jobs as jobs_router
    import routers.text_videos as router_module

    async def ignore_enqueue(_job_id: int):
        return None

    monkeypatch.setattr(router_module, "enqueue_job", ignore_enqueue)
    monkeypatch.setattr(jobs_router, "enqueue_job", ignore_enqueue)
    project = _speech_project(client, "甲乙丙丁")
    _set_ready_master(project["id"])
    current = client.get(f"/api/text-videos/{project['id']}").json()
    launched = client.post(
        f"/api/text-videos/{project['id']}/scene-plan/generate",
        json={
            "revision": current["revision"],
            "scope": "all",
            "selected_scene_id": "",
            "direction": "",
        },
    ).json()
    job_id = launched["jobs"][0]["id"]
    step, headers = _start_scene_job(
        client,
        job_id,
        project_id=project["id"],
    )
    domain_failure = client.post(
        f"/api/text-videos/{project['id']}/scene-plan/worker-failure",
        json={"error": "provider unavailable"},
        headers=headers,
    )
    assert domain_failure.status_code == 200
    durable_failure = client.post(
        f"/api/jobs/{job_id}/steps/{step['id']}/fail",
        json={"error": "provider unavailable", "retryable": True},
    )
    assert durable_failure.status_code == 200

    refreshed = client.get(f"/api/text-videos/{project['id']}").json()
    assert refreshed["scene_plan"]["status"] == "failed"
    assert refreshed["scene_plan"]["job_id"] == job_id
    retry = client.post(
        f"/api/jobs/{job_id}/retry",
        json={"step_key": "generate_scene_plan"},
    )
    assert retry.status_code == 200, retry.text
    assert retry.json()["status"] == "queued"
    restored = client.get(f"/api/text-videos/{project['id']}").json()
    assert restored["scene_plan"]["status"] == "generating"
    assert restored["scene_plan"]["job_id"] == job_id
    assert restored["scene_plan"]["scenes"] == current["scene_plan"]["scenes"]
    assert restored["render_input"] == current["render_input"]


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


def test_worker_result_waits_for_durable_commit_before_propagating_cancel(
    client,
    monkeypatch,
    tmp_path,
):
    from database import SessionLocal
    from models import CreativeAsset, TextVideoProject

    case = _prepare_speech_worker_result(
        client,
        monkeypatch,
        tmp_path,
        "durable commit cancel",
    )
    router_module = case["router"]

    async def run():
        durable = asyncio.Event()
        acknowledge = asyncio.Event()
        commit_finished = asyncio.Event()
        async with SessionLocal() as session:
            original_commit = session.commit

            async def commit_then_wait_for_ack():
                try:
                    await original_commit()
                    durable.set()
                    await acknowledge.wait()
                finally:
                    commit_finished.set()

            session.commit = commit_then_wait_for_ack
            upload = UploadFile(
                BytesIO(case["wav"].read_bytes()),
                filename="provider.wav",
                headers=Headers({"content-type": "audio/wav"}),
            )
            request_task = asyncio.create_task(
                router_module.save_speech_worker_result(
                    case["project"]["id"],
                    case["segment"]["id"],
                    upload,
                    case["context"]["generation_revision"],
                    case["context"]["source_hash"],
                    "",
                    "audio/wav",
                    "[]",
                    case["job"]["id"],
                    session,
                ),
            )
            await asyncio.wait_for(durable.wait(), timeout=10)
            request_task.cancel()
            done, _ = await asyncio.wait({request_task}, timeout=0.3)
            finished_in_time = request_task in done
            if not finished_in_time:
                acknowledge.set()
            with pytest.raises(asyncio.CancelledError):
                await request_task
            assert finished_in_time is True
            assert commit_finished.is_set()
            assert [
                task
                for task in asyncio.all_tasks()
                if task is not asyncio.current_task()
                and task.get_name().startswith("text-video-speech-")
                and not task.done()
            ] == []

        async with SessionLocal() as verification:
            project = await verification.get(
                TextVideoProject,
                case["project"]["id"],
            )
            asset = await verification.scalar(
                __import__("sqlalchemy").select(CreativeAsset),
            )
            return project, asset

    project, asset = asyncio.new_event_loop().run_until_complete(run())
    segment = project.paragraphs[0]
    assert segment["status"] == "ready"
    assert segment["audio_url"] == asset.url
    assert (case["uploads"] / Path(asset.url).name).is_file()


def test_worker_result_propagates_cancelled_commit_task_after_durable_write(
    client,
    monkeypatch,
    tmp_path,
):
    from database import SessionLocal
    from models import CreativeAsset, TextVideoProject

    case = _prepare_speech_worker_result(
        client,
        monkeypatch,
        tmp_path,
        "durable commit task cancel",
    )
    router_module = case["router"]

    async def run():
        async with SessionLocal() as session:
            original_commit = session.commit

            async def commit_then_cancel():
                await original_commit()
                raise asyncio.CancelledError()

            session.commit = commit_then_cancel
            upload = UploadFile(
                BytesIO(case["wav"].read_bytes()),
                filename="provider.wav",
                headers=Headers({"content-type": "audio/wav"}),
            )
            with pytest.raises(asyncio.CancelledError):
                await router_module.save_speech_worker_result(
                    case["project"]["id"],
                    case["segment"]["id"],
                    upload,
                    case["context"]["generation_revision"],
                    case["context"]["source_hash"],
                    "",
                    "audio/wav",
                    "[]",
                    case["job"]["id"],
                    session,
                )
            assert [
                task
                for task in asyncio.all_tasks()
                if task is not asyncio.current_task()
                and task.get_name().startswith("text-video-speech-")
                and not task.done()
            ] == []

        async with SessionLocal() as verification:
            project = await verification.get(
                TextVideoProject,
                case["project"]["id"],
            )
            asset = await verification.scalar(
                __import__("sqlalchemy").select(CreativeAsset),
            )
            return project, asset

    project, asset = asyncio.new_event_loop().run_until_complete(run())
    segment = project.paragraphs[0]
    assert segment["status"] == "ready"
    assert segment["audio_url"] == asset.url
    assert (case["uploads"] / Path(asset.url).name).is_file()


def test_worker_result_recovers_normal_commit_when_ack_is_lost(
    client,
    monkeypatch,
    tmp_path,
):
    from database import SessionLocal
    from models import CreativeAsset, TextVideoProject

    case = _prepare_speech_worker_result(
        client,
        monkeypatch,
        tmp_path,
        "normal durable commit",
    )
    router_module = case["router"]
    original_save = router_module.save_text_video_audio_asset

    async def save_then_lose_commit_ack(db, *args, **kwargs):
        saved = await original_save(db, *args, **kwargs)
        original_commit = db.commit

        async def durable_then_connection_error():
            await original_commit()
            raise ConnectionError("commit acknowledgement lost")

        db.commit = durable_then_connection_error
        return saved

    monkeypatch.setattr(
        router_module,
        "save_text_video_audio_asset",
        save_then_lose_commit_ack,
    )
    response = client.post(
        f"/api/text-videos/{case['project']['id']}/speech-segments/"
        f"{case['segment']['id']}/worker-result",
        data={
            "generation_revision": str(
                case["context"]["generation_revision"],
            ),
            "source_hash": case["context"]["source_hash"],
            "provider_request_id": "",
            "media_type": "audio/wav",
        },
        files={
            "audio": (
                "provider.wav",
                case["wav"].read_bytes(),
                "audio/wav",
            ),
        },
        headers={
            "X-WMS-Worker-Token": "test-worker-token-at-least-32-chars",
            "X-Content-Job-Id": str(case["job"]["id"]),
        },
    )

    assert response.status_code == 200, response.text

    async def persisted_result():
        async with SessionLocal() as session:
            project = await session.get(
                TextVideoProject,
                case["project"]["id"],
            )
            asset = await session.scalar(
                __import__("sqlalchemy").select(CreativeAsset),
            )
            return project, asset

    project, asset = asyncio.new_event_loop().run_until_complete(
        persisted_result(),
    )
    segment = project.paragraphs[0]
    assert segment["status"] == "ready"
    assert segment["audio_url"] == asset.url
    assert (case["uploads"] / Path(asset.url).name).is_file()


def test_stale_worker_result_preserves_durable_asset_when_commit_ack_is_lost(
    client,
    monkeypatch,
    tmp_path,
):
    from database import SessionLocal
    from models import CreativeAsset, TextVideoSpeechAsset
    from sqlalchemy import func, select

    case = _prepare_speech_worker_result(
        client,
        monkeypatch,
        tmp_path,
        "stale durable commit",
    )
    router_module = case["router"]
    original_save = router_module.save_text_video_audio_asset

    async def save_edit_then_lose_commit_ack(db, *args, **kwargs):
        saved = await original_save(db, *args, **kwargs)
        current = await db.get(
            router_module.TextVideoProject,
            case["project"]["id"],
        )
        paragraphs = list(current.paragraphs)
        paragraphs[0] = {
            **paragraphs[0],
            "generation_revision": (
                paragraphs[0]["generation_revision"] + 1
            ),
        }
        current.paragraphs = paragraphs
        await db.flush()
        original_commit = db.commit

        async def durable_then_connection_error():
            await original_commit()
            raise ConnectionError("commit acknowledgement lost")

        db.commit = durable_then_connection_error
        return saved

    monkeypatch.setattr(
        router_module,
        "save_text_video_audio_asset",
        save_edit_then_lose_commit_ack,
    )
    response = client.post(
        f"/api/text-videos/{case['project']['id']}/speech-segments/"
        f"{case['segment']['id']}/worker-result",
        data={
            "generation_revision": str(
                case["context"]["generation_revision"],
            ),
            "source_hash": case["context"]["source_hash"],
            "provider_request_id": "",
            "media_type": "audio/wav",
        },
        files={
            "audio": (
                "provider.wav",
                case["wav"].read_bytes(),
                "audio/wav",
            ),
        },
        headers={
            "X-WMS-Worker-Token": "test-worker-token-at-least-32-chars",
            "X-Content-Job-Id": str(case["job"]["id"]),
        },
    )

    assert response.status_code == 409
    assert response.headers["X-WMS-Retryable"] == "false"

    async def persisted_asset_count():
        async with SessionLocal() as session:
            assets = await session.scalar(
                select(func.count(CreativeAsset.id)),
            )
            metadata = await session.scalar(
                select(func.count(TextVideoSpeechAsset.id)),
            )
            return assets, metadata

    assert asyncio.new_event_loop().run_until_complete(
        persisted_asset_count(),
    ) == (1, 1)
    assert len(list(case["uploads"].glob("*.mp3"))) == 1


def test_worker_result_preserves_file_when_durability_check_is_unavailable(
    client,
    monkeypatch,
    tmp_path,
):
    case = _prepare_speech_worker_result(
        client,
        monkeypatch,
        tmp_path,
        "unknown commit state",
    )
    router_module = case["router"]
    original_save = router_module.save_text_video_audio_asset

    async def save_then_fail_commit(db, *args, **kwargs):
        saved = await original_save(db, *args, **kwargs)

        async def connection_lost_before_ack():
            raise ConnectionError("database state unavailable")

        db.commit = connection_lost_before_ack
        return saved

    class UnavailableVerificationSession:
        async def __aenter__(self):
            raise ConnectionError("verification database unavailable")

        async def __aexit__(self, *_args):
            return False

    def unavailable_sessionmaker(*_args, **_kwargs):
        return UnavailableVerificationSession

    monkeypatch.setattr(
        router_module,
        "save_text_video_audio_asset",
        save_then_fail_commit,
    )
    monkeypatch.setattr(
        router_module,
        "async_sessionmaker",
        unavailable_sessionmaker,
    )
    with pytest.raises(ConnectionError, match="database state unavailable"):
        client.post(
            f"/api/text-videos/{case['project']['id']}/speech-segments/"
            f"{case['segment']['id']}/worker-result",
            data={
                "generation_revision": str(
                    case["context"]["generation_revision"],
                ),
                "source_hash": case["context"]["source_hash"],
                "provider_request_id": "",
                "media_type": "audio/wav",
            },
            files={
                "audio": (
                    "provider.wav",
                    case["wav"].read_bytes(),
                    "audio/wav",
                ),
            },
            headers={
                "X-WMS-Worker-Token": (
                    "test-worker-token-at-least-32-chars"
                ),
                "X-Content-Job-Id": str(case["job"]["id"]),
            },
        )

    assert len(list(case["uploads"].glob("*.mp3"))) == 1


def test_worker_result_preserves_file_when_commit_and_rollback_fail(
    client,
    monkeypatch,
    tmp_path,
):
    from database import SessionLocal

    case = _prepare_speech_worker_result(
        client,
        monkeypatch,
        tmp_path,
        "commit and rollback unavailable",
    )
    router_module = case["router"]
    original_save = router_module.save_text_video_audio_asset

    async def save_then_break_transaction(db, *args, **kwargs):
        saved = await original_save(db, *args, **kwargs)

        async def fail_commit():
            raise ConnectionError("commit connection unavailable")

        async def fail_rollback():
            raise ConnectionError("rollback connection unavailable")

        db.commit = fail_commit
        db.rollback = fail_rollback
        return saved

    monkeypatch.setattr(
        router_module,
        "save_text_video_audio_asset",
        save_then_break_transaction,
    )

    async def run():
        async with SessionLocal() as session:
            with pytest.raises(
                ConnectionError,
                match="commit connection unavailable",
            ):
                await _submit_prepared_speech_worker_result(case, session)

    asyncio.new_event_loop().run_until_complete(run())
    assert len(list(case["uploads"].glob("*.mp3"))) == 1


def test_worker_result_commit_deadline_is_bounded_and_preserves_file(
    client,
    monkeypatch,
    tmp_path,
):
    from database import SessionLocal

    case = _prepare_speech_worker_result(
        client,
        monkeypatch,
        tmp_path,
        "commit deadline",
    )
    router_module = case["router"]
    original_save = router_module.save_text_video_audio_asset
    release_commit = asyncio.Event()
    commit_cancelled = asyncio.Event()

    async def save_then_hang_commit(db, *args, **kwargs):
        saved = await original_save(db, *args, **kwargs)

        async def hang_commit():
            try:
                await release_commit.wait()
            except asyncio.CancelledError:
                commit_cancelled.set()
                raise

        db.commit = hang_commit
        return saved

    monkeypatch.setattr(
        router_module,
        "save_text_video_audio_asset",
        save_then_hang_commit,
    )
    monkeypatch.setattr(
        router_module,
        "SPEECH_DB_OPERATION_TIMEOUT_SECONDS",
        0.02,
        raising=False,
    )
    monkeypatch.setattr(
        router_module,
        "SPEECH_DB_CANCEL_GRACE_SECONDS",
        0.02,
        raising=False,
    )

    async def run():
        async with SessionLocal() as session:
            request = asyncio.create_task(
                _submit_prepared_speech_worker_result(case, session),
            )
            done, _ = await asyncio.wait({request}, timeout=0.3)
            finished_in_time = request in done
            if not finished_in_time:
                release_commit.set()
                request.cancel()
            try:
                await request
            except BaseException as error:
                failure = error
            else:
                failure = None
            pending_helpers = [
                task
                for task in asyncio.all_tasks()
                if task is not asyncio.current_task()
                and task.get_name().startswith("text-video-speech-")
                and not task.done()
            ]
            return finished_in_time, failure, pending_helpers

    (
        finished_in_time,
        error,
        pending_helpers,
    ) = asyncio.new_event_loop().run_until_complete(run())
    assert finished_in_time is True
    assert isinstance(error, TimeoutError)
    assert pending_helpers == []
    assert commit_cancelled.is_set()
    assert len(list(case["uploads"].glob("*.mp3"))) == 1


def test_worker_result_commit_deadline_rejects_caught_cancellation(
    client,
    monkeypatch,
    tmp_path,
):
    from database import SessionLocal

    case = _prepare_speech_worker_result(
        client,
        monkeypatch,
        tmp_path,
        "caught commit cancellation",
    )
    router_module = case["router"]
    original_save = router_module.save_text_video_audio_asset
    commit_cancelled = asyncio.Event()

    async def save_then_catch_commit_cancellation(db, *args, **kwargs):
        saved = await original_save(db, *args, **kwargs)

        async def catch_commit_cancellation():
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                commit_cancelled.set()
                return

        db.commit = catch_commit_cancellation
        return saved

    monkeypatch.setattr(
        router_module,
        "save_text_video_audio_asset",
        save_then_catch_commit_cancellation,
    )
    monkeypatch.setattr(
        router_module,
        "SPEECH_DB_OPERATION_TIMEOUT_SECONDS",
        0.02,
        raising=False,
    )
    monkeypatch.setattr(
        router_module,
        "SPEECH_DB_CANCEL_GRACE_SECONDS",
        0.02,
        raising=False,
    )

    async def run():
        async with SessionLocal() as session:
            try:
                await _submit_prepared_speech_worker_result(case, session)
            except BaseException as error:
                failure = error
            else:
                failure = None
            pending_helpers = [
                task
                for task in asyncio.all_tasks()
                if task is not asyncio.current_task()
                and task.get_name().startswith("text-video-speech-")
                and not task.done()
            ]
            return failure, pending_helpers

    error, pending_helpers = asyncio.new_event_loop().run_until_complete(
        run(),
    )
    assert isinstance(error, TimeoutError)
    assert commit_cancelled.is_set()
    assert pending_helpers == []
    assert len(list(case["uploads"].glob("*.mp3"))) == 1


def test_worker_result_durable_commit_deadline_still_times_out(
    client,
    monkeypatch,
    tmp_path,
):
    from database import SessionLocal
    from models import (
        CreativeAsset,
        TextVideoProject,
        TextVideoSpeechAsset,
    )
    from sqlalchemy import func, select

    case = _prepare_speech_worker_result(
        client,
        monkeypatch,
        tmp_path,
        "durable caught commit cancellation",
    )
    router_module = case["router"]
    original_save = router_module.save_text_video_audio_asset
    commit_cancelled = asyncio.Event()

    async def save_then_delay_commit_ack(db, *args, **kwargs):
        saved = await original_save(db, *args, **kwargs)
        original_commit = db.commit

        async def durable_then_catch_cancellation():
            await original_commit()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                commit_cancelled.set()
                return

        db.commit = durable_then_catch_cancellation
        return saved

    monkeypatch.setattr(
        router_module,
        "save_text_video_audio_asset",
        save_then_delay_commit_ack,
    )
    monkeypatch.setattr(
        router_module,
        "SPEECH_DB_OPERATION_TIMEOUT_SECONDS",
        0.02,
        raising=False,
    )
    monkeypatch.setattr(
        router_module,
        "SPEECH_DB_CANCEL_GRACE_SECONDS",
        0.02,
        raising=False,
    )

    async def run():
        async with SessionLocal() as session:
            try:
                await _submit_prepared_speech_worker_result(case, session)
            except BaseException as error:
                failure = error
            else:
                failure = None
            pending_helpers = [
                task
                for task in asyncio.all_tasks()
                if task is not asyncio.current_task()
                and task.get_name().startswith("text-video-speech-")
                and not task.done()
            ]
        async with SessionLocal() as verification:
            project = await verification.get(
                TextVideoProject,
                case["project"]["id"],
            )
            asset_count = await verification.scalar(
                select(func.count(CreativeAsset.id)),
            )
            metadata_count = await verification.scalar(
                select(func.count(TextVideoSpeechAsset.id)),
            )
        return (
            failure,
            pending_helpers,
            project,
            asset_count,
            metadata_count,
        )

    (
        error,
        pending_helpers,
        project,
        asset_count,
        metadata_count,
    ) = asyncio.new_event_loop().run_until_complete(run())
    assert isinstance(error, TimeoutError)
    assert commit_cancelled.is_set()
    assert pending_helpers == []
    assert project.paragraphs[0]["status"] == "ready"
    assert asset_count == 1
    assert metadata_count == 1
    assert len(list(case["uploads"].glob("*.mp3"))) == 1


def test_worker_result_rollback_deadline_is_bounded_and_preserves_file(
    client,
    monkeypatch,
    tmp_path,
):
    from database import SessionLocal

    case = _prepare_speech_worker_result(
        client,
        monkeypatch,
        tmp_path,
        "rollback deadline",
    )
    router_module = case["router"]
    original_save = router_module.save_text_video_audio_asset
    release_rollback = asyncio.Event()
    rollback_cancelled = asyncio.Event()

    async def save_then_hang_rollback(db, *args, **kwargs):
        saved = await original_save(db, *args, **kwargs)

        async def fail_commit():
            raise ConnectionError("commit connection unavailable")

        async def hang_rollback():
            try:
                await release_rollback.wait()
            except asyncio.CancelledError:
                rollback_cancelled.set()
                raise

        db.commit = fail_commit
        db.rollback = hang_rollback
        return saved

    monkeypatch.setattr(
        router_module,
        "save_text_video_audio_asset",
        save_then_hang_rollback,
    )
    monkeypatch.setattr(
        router_module,
        "SPEECH_DB_OPERATION_TIMEOUT_SECONDS",
        0.02,
        raising=False,
    )
    monkeypatch.setattr(
        router_module,
        "SPEECH_DB_CANCEL_GRACE_SECONDS",
        0.02,
        raising=False,
    )

    async def run():
        async with SessionLocal() as session:
            request = asyncio.create_task(
                _submit_prepared_speech_worker_result(case, session),
            )
            done, _ = await asyncio.wait({request}, timeout=0.3)
            finished_in_time = request in done
            if not finished_in_time:
                release_rollback.set()
                request.cancel()
            try:
                await request
            except BaseException as error:
                failure = error
            else:
                failure = None
            pending_helpers = [
                task
                for task in asyncio.all_tasks()
                if task is not asyncio.current_task()
                and task.get_name().startswith("text-video-speech-")
                and not task.done()
            ]
            return finished_in_time, failure, pending_helpers

    (
        finished_in_time,
        error,
        pending_helpers,
    ) = asyncio.new_event_loop().run_until_complete(run())
    assert finished_in_time is True
    assert isinstance(error, ConnectionError)
    assert pending_helpers == []
    assert rollback_cancelled.is_set()
    assert len(list(case["uploads"].glob("*.mp3"))) == 1


def test_durability_verifier_preserves_contradictory_project_reference(
    client,
):
    from database import SessionLocal

    project = _speech_project(client)
    segment = project["paragraphs"][0]
    source_hash = "a" * 64
    audio_url = "/api/uploads/contradictory-reference.mp3"

    async def verify():
        async with SessionLocal() as session:
            stored = await session.get(
                __import__("models").TextVideoProject,
                project["id"],
            )
            paragraphs = list(stored.paragraphs)
            paragraphs[0] = {
                **paragraphs[0],
                "status": "ready",
                "audio_url": audio_url,
                "source_hash": source_hash,
                "job_id": None,
            }
            stored.paragraphs = paragraphs
            await session.commit()

        import routers.text_videos as router_module

        async with SessionLocal() as session:
            return await router_module._verify_saved_speech_result(
                session,
                {
                    "asset_id": 2_147_483_647,
                    "audio_url": audio_url,
                },
                source_hash=source_hash,
                project_id=project["id"],
                segment_id=segment["id"],
                generation_revision=segment["generation_revision"],
                require_project_reference=True,
            )

    assert asyncio.new_event_loop().run_until_complete(verify()) is None


@pytest.mark.parametrize(
    ("database_kind", "bind_shape"),
    [
        ("memory", "engine"),
        ("memory", "connection"),
        ("file", "connection"),
    ],
)
def test_commit_verification_requires_independent_engine(
    client,
    monkeypatch,
    tmp_path,
    database_kind,
    bind_shape,
):
    from database import Base
    from models import (
        CreativeAsset,
        TextVideoProject,
        TextVideoSpeechAsset,
    )
    import routers.text_videos as router_module
    from sqlalchemy import func, select
    from sqlalchemy.ext.asyncio import (
        async_sessionmaker,
        create_async_engine,
    )
    from sqlalchemy.pool import StaticPool

    uploads = tmp_path / f"{database_kind} {bind_shape}"
    uploads.mkdir(parents=True)
    monkeypatch.setattr(router_module, "UPLOADS_DIR", uploads)
    audio_url = "/api/uploads/static-pool.mp3"
    audio_path = uploads / "static-pool.mp3"
    audio_path.write_bytes(b"speech")
    source_hash = "d" * 64
    segment_id = "segment-1"
    generation_revision = 3
    saved = {
        "asset_id": 1,
        "audio_url": audio_url,
        "duration": 1.0,
        "sample_count": 44100,
        "sample_rate": 44100,
        "word_timings": [],
        "provider_request_id": "",
    }

    async def run():
        database_url = (
            "sqlite+aiosqlite:///:memory:"
            if database_kind == "memory"
            else (
                "sqlite+aiosqlite:///"
                f"{tmp_path / 'connection-bound.db'}"
            )
        )
        engine = create_async_engine(database_url)
        assert isinstance(engine.pool, StaticPool) is (
            database_kind == "memory"
        )
        connection = None
        try:
            async with engine.begin() as setup_connection:
                await setup_connection.run_sync(Base.metadata.create_all)
            if bind_shape == "connection":
                connection = await engine.connect()
                bind = connection
            else:
                bind = engine
            session_factory = async_sessionmaker(
                bind,
                expire_on_commit=False,
            )
            failure = None
            async with session_factory() as session:
                session.add_all([
                    CreativeAsset(
                        id=saved["asset_id"],
                        asset_type="media",
                        media_kind="audio",
                        title="文字视频口播配音",
                        url=audio_url,
                        media_type="audio/mpeg",
                        filename="static-pool.mp3",
                        source="generated",
                    ),
                    TextVideoSpeechAsset(
                        creative_asset_id=saved["asset_id"],
                        source_hash=source_hash,
                        duration=saved["duration"],
                        sample_count=saved["sample_count"],
                        sample_rate=saved["sample_rate"],
                        word_timings=saved["word_timings"],
                        provider_request_id=saved[
                            "provider_request_id"
                        ],
                    ),
                    TextVideoProject(
                        id=1,
                        paragraphs=[{
                            "id": segment_id,
                            "status": "ready",
                            "audio_url": audio_url,
                            "duration": saved["duration"],
                            "word_timings": saved["word_timings"],
                            "source_hash": source_hash,
                            "generation_revision": generation_revision,
                            "error": "",
                            "job_id": None,
                        }],
                    ),
                ])
                await session.flush()

                async def fail_commit():
                    raise ConnectionError("commit connection unavailable")

                async def fail_rollback():
                    raise ConnectionError("rollback connection unavailable")

                session.commit = fail_commit
                session.rollback = fail_rollback
                try:
                    await router_module._commit_saved_speech_result(
                        session,
                        saved,
                        source_hash=source_hash,
                        project_id=1,
                        segment_id=segment_id,
                        generation_revision=generation_revision,
                        require_project_reference=True,
                    )
                except BaseException as error:
                    failure = error
            if connection is not None:
                await connection.close()
                connection = None
            verification_factory = async_sessionmaker(
                engine,
                expire_on_commit=False,
            )
            async with verification_factory() as verification:
                asset_count = await verification.scalar(
                    select(func.count(CreativeAsset.id)),
                )
                metadata_count = await verification.scalar(
                    select(func.count(TextVideoSpeechAsset.id)),
                )
                project_count = await verification.scalar(
                    select(func.count(TextVideoProject.id)),
                )
            return (
                failure,
                asset_count,
                metadata_count,
                project_count,
            )
        finally:
            if connection is not None:
                await connection.close()
            await engine.dispose()

    error, asset_count, metadata_count, project_count = (
        asyncio.new_event_loop().run_until_complete(run())
    )
    assert isinstance(error, ConnectionError)
    assert str(error) == "commit connection unavailable"
    assert asset_count == 0
    assert metadata_count == 0
    assert project_count == 0
    assert audio_path.is_file()


@pytest.mark.parametrize(
    ("target", "field", "invalid_value"),
    [
        ("asset", "media_kind", "video"),
        ("asset", "title", "损坏的标题"),
        ("asset", "source", "manual"),
        ("metadata", "sample_count", 22050),
        ("metadata", "provider_request_id", "different-provider"),
        ("project", "duration", 2.0),
        ("project", "error", "stale error"),
    ],
)
def test_durability_verifier_rejects_immutable_state_mismatch(
    client,
    target,
    field,
    invalid_value,
):
    from database import SessionLocal
    from models import (
        CreativeAsset,
        TextVideoProject,
        TextVideoSpeechAsset,
    )

    project = _speech_project(client)
    segment = project["paragraphs"][0]
    source_hash = "b" * 64
    audio_url = "/api/uploads/verified-speech.mp3"
    saved = {
        "asset_id": 1,
        "audio_url": audio_url,
        "duration": 1.0,
        "sample_count": 44100,
        "sample_rate": 44100,
        "word_timings": [{
            "id": "word-1",
            "text": "需要",
            "start": 0.0,
            "end": 0.4,
        }],
        "provider_request_id": "provider-1",
    }

    async def verify():
        async with SessionLocal() as session:
            asset = CreativeAsset(
                id=saved["asset_id"],
                asset_type="media",
                media_kind="audio",
                title="文字视频口播配音",
                url=audio_url,
                media_type="audio/mpeg",
                filename="verified-speech.mp3",
                source="generated",
            )
            metadata = TextVideoSpeechAsset(
                creative_asset_id=saved["asset_id"],
                source_hash=source_hash,
                duration=1.0,
                sample_count=44100,
                sample_rate=44100,
                word_timings=saved["word_timings"],
                provider_request_id=saved["provider_request_id"],
            )
            stored_project = await session.get(
                TextVideoProject,
                project["id"],
            )
            paragraphs = list(stored_project.paragraphs)
            paragraphs[0] = {
                **paragraphs[0],
                "status": "ready",
                "audio_url": audio_url,
                "duration": saved["duration"],
                "word_timings": saved["word_timings"],
                "source_hash": source_hash,
                "generation_revision": segment["generation_revision"],
                "error": "",
                "job_id": None,
            }
            stored_project.paragraphs = paragraphs
            session.add_all([asset, metadata])
            await session.commit()

        async with SessionLocal() as session:
            if target == "asset":
                row = await session.get(
                    CreativeAsset,
                    saved["asset_id"],
                )
                setattr(row, field, invalid_value)
            elif target == "metadata":
                row = await session.scalar(
                    __import__("sqlalchemy").select(
                        TextVideoSpeechAsset,
                    ),
                )
                setattr(row, field, invalid_value)
            else:
                row = await session.get(
                    TextVideoProject,
                    project["id"],
                )
                paragraphs = list(row.paragraphs)
                paragraphs[0] = {
                    **paragraphs[0],
                    field: invalid_value,
                }
                row.paragraphs = paragraphs
            await session.commit()

        import routers.text_videos as router_module

        async with SessionLocal() as session:
            return await router_module._verify_saved_speech_result(
                session,
                saved,
                source_hash=source_hash,
                project_id=project["id"],
                segment_id=segment["id"],
                generation_revision=segment["generation_revision"],
                require_project_reference=True,
            )

    assert asyncio.new_event_loop().run_until_complete(verify()) is None


def test_durability_verifier_rejects_duplicate_segment_id(client):
    from database import SessionLocal
    from models import (
        CreativeAsset,
        TextVideoProject,
        TextVideoSpeechAsset,
    )

    project = _speech_project(client)
    segment = project["paragraphs"][0]
    source_hash = "e" * 64
    saved = {
        "asset_id": 1,
        "audio_url": "/api/uploads/duplicate-segment.mp3",
        "duration": 1.0,
        "sample_count": 44100,
        "sample_rate": 44100,
        "word_timings": [],
        "provider_request_id": "",
    }

    async def verify():
        async with SessionLocal() as session:
            session.add_all([
                CreativeAsset(
                    id=saved["asset_id"],
                    asset_type="media",
                    media_kind="audio",
                    title="文字视频口播配音",
                    url=saved["audio_url"],
                    media_type="audio/mpeg",
                    filename="duplicate-segment.mp3",
                    source="generated",
                ),
                TextVideoSpeechAsset(
                    creative_asset_id=saved["asset_id"],
                    source_hash=source_hash,
                    duration=saved["duration"],
                    sample_count=saved["sample_count"],
                    sample_rate=saved["sample_rate"],
                    word_timings=saved["word_timings"],
                    provider_request_id=saved[
                        "provider_request_id"
                    ],
                ),
            ])
            stored_project = await session.get(
                TextVideoProject,
                project["id"],
            )
            exact_reference = {
                **stored_project.paragraphs[0],
                "status": "ready",
                "audio_url": saved["audio_url"],
                "duration": saved["duration"],
                "word_timings": saved["word_timings"],
                "source_hash": source_hash,
                "generation_revision": segment["generation_revision"],
                "error": "",
                "job_id": None,
            }
            stored_project.paragraphs = [
                exact_reference,
                {
                    **exact_reference,
                    "audio_url": "/api/uploads/different.mp3",
                },
            ]
            await session.commit()

        import routers.text_videos as router_module

        async with SessionLocal() as session:
            return await router_module._verify_saved_speech_result(
                session,
                saved,
                source_hash=source_hash,
                project_id=project["id"],
                segment_id=segment["id"],
                generation_revision=segment["generation_revision"],
                require_project_reference=True,
            )

    assert asyncio.new_event_loop().run_until_complete(verify()) is None


def test_durability_verifier_rejects_duplicate_speech_metadata(client):
    from database import SessionLocal
    from models import (
        CreativeAsset,
        TextVideoProject,
        TextVideoSpeechAsset,
    )

    project = _speech_project(client)
    segment = project["paragraphs"][0]
    source_hash = "c" * 64
    saved = {
        "asset_id": 1,
        "audio_url": "/api/uploads/duplicate-metadata.mp3",
        "duration": 1.0,
        "sample_count": 44100,
        "sample_rate": 44100,
        "word_timings": [],
        "provider_request_id": "",
    }

    async def verify():
        async with SessionLocal() as session:
            session.add(CreativeAsset(
                id=saved["asset_id"],
                asset_type="media",
                media_kind="audio",
                title="文字视频口播配音",
                url=saved["audio_url"],
                media_type="audio/mpeg",
                filename="duplicate-metadata.mp3",
                source="generated",
            ))
            session.add_all([
                TextVideoSpeechAsset(
                    creative_asset_id=saved["asset_id"],
                    source_hash=source_hash,
                    duration=1.0,
                    sample_count=44100,
                    sample_rate=44100,
                ),
                TextVideoSpeechAsset(
                    creative_asset_id=saved["asset_id"],
                    source_hash=source_hash,
                    duration=1.0,
                    sample_count=44100,
                    sample_rate=44100,
                ),
            ])
            stored_project = await session.get(
                TextVideoProject,
                project["id"],
            )
            paragraphs = list(stored_project.paragraphs)
            paragraphs[0] = {
                **paragraphs[0],
                "status": "ready",
                "audio_url": saved["audio_url"],
                "duration": saved["duration"],
                "word_timings": [],
                "source_hash": source_hash,
                "error": "",
                "job_id": None,
            }
            stored_project.paragraphs = paragraphs
            await session.commit()

        import routers.text_videos as router_module

        async with SessionLocal() as session:
            return await router_module._verify_saved_speech_result(
                session,
                saved,
                source_hash=source_hash,
                project_id=project["id"],
                segment_id=segment["id"],
                generation_revision=segment["generation_revision"],
                require_project_reference=True,
            )

    assert asyncio.new_event_loop().run_until_complete(verify()) is None


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
