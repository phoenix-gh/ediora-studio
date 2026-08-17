import asyncio
from pathlib import Path
import sys

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from tests.test_media_command import sine_wave


WORKER_HEADERS = {
    "X-Worker-Token": "test-worker-token-at-least-32-chars",
}


@pytest.fixture
def master_client(monkeypatch, tmp_path, postgres_env):
    monkeypatch.setenv(
        "WORKER_TOKEN",
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
            "text_video_alignment",
            "text_video_audio",
            "text_video_jobs",
            "text_video_master",
            "text_video_transcription",
        )):
            sys.modules.pop(module, None)

    from database import Base, SessionLocal, engine, get_db
    import models  # noqa: F401
    import routers.jobs as jobs_module
    import routers.text_videos as router_module
    import text_video_audio
    import text_video_jobs

    async def setup():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.run(setup())
    uploads = tmp_path / "uploads"
    monkeypatch.setattr(router_module, "UPLOADS_DIR", uploads)
    monkeypatch.setattr(text_video_audio, "UPLOADS_DIR", uploads)
    monkeypatch.setattr(text_video_jobs, "UPLOADS_DIR", uploads)

    async def ignore_enqueue(_job_id: int):
        return None

    monkeypatch.setattr(text_video_jobs, "enqueue_job", ignore_enqueue)
    monkeypatch.setattr(jobs_module, "enqueue_job", ignore_enqueue)
    if hasattr(router_module, "enqueue_job"):
        monkeypatch.setattr(router_module, "enqueue_job", ignore_enqueue)
    if "text_video_master" in sys.modules:
        monkeypatch.setattr(
            sys.modules["text_video_master"],
            "UPLOADS_DIR",
            uploads,
        )
        monkeypatch.setattr(
            sys.modules["text_video_master"],
            "enqueue_job",
            ignore_enqueue,
        )

    app = FastAPI()
    app.include_router(router_module.router, prefix="/api")
    app.include_router(jobs_module.router, prefix="/api")

    async def override_db():
        async with SessionLocal() as session:
            yield session

    app.dependency_overrides[get_db] = override_db
    return {
        "client": TestClient(app),
        "session_factory": SessionLocal,
        "uploads": uploads,
        "router": router_module,
        "monkeypatch": monkeypatch,
        "tmp_path": tmp_path,
    }


def _seed_confirmed_project(
    case,
    segments,
):
    client = case["client"]
    created = client.post("/api/text-videos", json={}).json()
    script = "".join(item["text"] for item in segments)
    updated_response = client.patch(
        f"/api/text-videos/{created['id']}",
        json={
            "revision": created["revision"],
            "script": script,
            "voice_settings": {
                "voice_id": "mimo_default",
                "model": "mimo-v2.5-tts",
                "speed": 1,
                "volume": 1,
                "pitch": 0,
            },
            "paragraphs": [
                {"id": item["id"], "text": item["text"]}
                for item in segments
            ],
        },
    )
    assert updated_response.status_code == 200, updated_response.text
    updated = updated_response.json()

    async def persist():
        from media_command import probe_audio
        from models import CreativeAsset, TextVideoProject, TextVideoSpeechAsset
        from text_video_audio import normalize_speech_audio
        from text_video_domain import speech_source_hash

        case["uploads"].mkdir(parents=True, exist_ok=True)
        records = []
        async with case["session_factory"]() as session:
            project = await session.get(TextVideoProject, updated["id"])
            assert project is not None
            paragraphs = list(project.paragraphs)
            for index, spec in enumerate(segments):
                wav = await sine_wave(
                    case["tmp_path"] / f"{spec['id']}.wav",
                    seconds=spec["seconds"],
                    frequency=330 + index * 110,
                )
                final = case["uploads"] / f"{spec['id']}.mp3"
                await normalize_speech_audio(
                    wav,
                    final,
                    speed=1,
                    volume=1,
                    pitch=0,
                )
                probe = await probe_audio(final)
                asset = CreativeAsset(
                    asset_type="media",
                    media_kind="audio",
                    title=f"segment {spec['id']}",
                    url=f"/api/uploads/{final.name}",
                    media_type="audio/mpeg",
                    filename=final.name,
                    source="generated",
                )
                session.add(asset)
                await session.flush()
                source_hash = speech_source_hash(
                    spec["text"],
                    project.voice_settings,
                    "mimo-v2.5-tts",
                )
                timings = spec.get("word_timings", [])
                session.add(TextVideoSpeechAsset(
                    creative_asset_id=asset.id,
                    source_hash=source_hash,
                    duration=probe.duration,
                    sample_count=probe.sample_count,
                    sample_rate=probe.sample_rate,
                    word_timings=timings,
                    provider_request_id=f"request-{spec['id']}",
                ))
                paragraphs[index] = {
                    **paragraphs[index],
                    "status": "confirmed",
                    "audio_url": asset.url,
                    "duration": probe.sample_count / probe.sample_rate,
                    "word_timings": timings,
                    "source_hash": source_hash,
                    "error": "",
                    "job_id": None,
                }
                records.append({
                    "asset_id": asset.id,
                    "audio_url": asset.url,
                    "path": final,
                    "source_hash": source_hash,
                    "sample_count": probe.sample_count,
                    "sample_rate": probe.sample_rate,
                })
            project.paragraphs = paragraphs
            await session.commit()
        return records

    records = asyncio.run(persist())
    return (
        client.get(f"/api/text-videos/{updated['id']}").json(),
        records,
    )


def _build(case, project):
    response = case["client"].post(
        f"/api/text-videos/{project['id']}/master-audio/build",
        json={"revision": project["revision"]},
    )
    assert response.status_code == 201, response.text
    return response.json()


def _worker_headers(job_id):
    return WORKER_HEADERS | {"X-Content-Job-Id": str(job_id)}


def _assemble(case, project_id, job_id):
    return case["client"].post(
        f"/api/text-videos/{project_id}/master-audio/worker-assemble",
        headers=_worker_headers(job_id),
    )


def _alignment_payload(case, job_id, *, claim_token=None):
    durable = case["client"].get(f"/api/jobs/{job_id}").json()
    candidates = [
        step
        for step in durable["steps"]
        if step["key"] == "align_master_timeline"
    ]
    latest = max(
        candidates,
        key=lambda step: (step["attempt"], step["id"]),
        default=None,
    )
    if latest is None or latest["status"] != "running":
        started = case["client"].post(
            f"/api/jobs/{job_id}/steps/align_master_timeline/start",
        )
        assert started.status_code == 200, started.text
        latest = started.json()
    token = claim_token or f"test-alignment-claim-{latest['id']}"
    payload = {
        "step_id": latest["id"],
        "attempt": latest["attempt"],
        "claim_token": token,
    }
    case.setdefault("alignment_claims", {})[job_id] = payload
    return payload


def _align(
    case,
    project_id,
    job_id,
    source_hash,
    *,
    claim_token=None,
):
    claim = _alignment_payload(
        case,
        job_id,
        claim_token=claim_token,
    )
    return case["client"].post(
        f"/api/text-videos/{project_id}/master-audio/worker-align",
        json={"source_hash": source_hash, **claim},
        headers=_worker_headers(job_id),
    )


def test_build_is_idempotent_and_assembly_response_loss_replays_same_asset(
    master_client,
):
    project, records = _seed_confirmed_project(master_client, [
        {"id": "a", "text": "甲", "seconds": 1.0},
        {"id": "b", "text": "乙", "seconds": 1.5},
    ])

    first_build = _build(master_client, project)
    second_build = _build(master_client, first_build["project"])

    assert first_build["jobs"] == second_build["jobs"]
    assert first_build["jobs"][0]["target_id"] == project["id"]
    assert isinstance(first_build["jobs"][0]["target_id"], int)
    assert first_build["project"]["master_audio"]["status"] == "building"
    job = first_build["jobs"][0]
    first = _assemble(master_client, project["id"], job["id"])
    assert first.status_code == 200, first.text
    replay = _assemble(master_client, project["id"], job["id"])
    assert replay.status_code == 200, replay.text
    assert replay.json() == first.json()

    assembled = first.json()
    assert assembled["asset_id"] not in {
        records[0]["asset_id"],
        records[1]["asset_id"],
    }
    assert assembled["sample_rate"] == 44100
    assert assembled["sample_count"] == 110250
    assert [
        item["sample_offset"]
        for item in assembled["segment_offsets"]
    ] == [0, 44100]
    assert [
        item["segment_id"]
        for item in assembled["segment_offsets"]
    ] == ["a", "b"]
    assert all(
        "speech_segment_id" not in item
        for item in assembled["segment_offsets"]
    )
    current = master_client["client"].get(
        f"/api/text-videos/{project['id']}",
    ).json()
    assert current["master_audio"]["asset_id"] == assembled["asset_id"]
    assert current["master_audio"]["sample_count"] == 110250
    assert current["master_audio"]["segment_offsets"] == assembled[
        "segment_offsets"
    ]
    assert (
        master_client["uploads"] / Path(assembled["audio_url"]).name
    ).is_file()


def test_single_segment_master_reuses_source_asset_without_ownership(
    master_client,
):
    project, records = _seed_confirmed_project(master_client, [
        {"id": "only", "text": "唯一", "seconds": 1.0},
    ])
    launch = _build(master_client, project)
    job = launch["jobs"][0]

    assembled = _assemble(
        master_client,
        project["id"],
        job["id"],
    ).json()

    assert assembled["asset_id"] == records[0]["asset_id"]
    assert assembled["owns_asset"] is False
    assert records[0]["path"].is_file()


def test_missing_ready_master_file_creates_deterministic_repair_job(
    master_client,
):
    project, _records = _seed_confirmed_project(master_client, [
        {"id": "a", "text": "甲", "seconds": 1.0},
        {"id": "b", "text": "乙", "seconds": 1.0},
    ])
    launch = _build(master_client, project)
    job = launch["jobs"][0]
    assembled = _assemble(
        master_client,
        project["id"],
        job["id"],
    ).json()
    start = master_client["client"].post(
        f"/api/jobs/{job['id']}/steps/assemble_master_audio/start",
    ).json()
    master_client["client"].post(
        f"/api/jobs/{job['id']}/steps/{start['id']}/succeed",
        json={"output": assembled},
    )
    master_client["client"].post(f"/api/jobs/{job['id']}/succeed")
    (
        master_client["uploads"] / Path(assembled["audio_url"]).name
    ).unlink()

    current = master_client["client"].get(
        f"/api/text-videos/{project['id']}",
    ).json()
    repaired = _build(master_client, current)

    assert repaired["jobs"][0]["id"] != job["id"]
    assert repaired["project"]["master_audio"]["repair_generation"] == 1
    assert repaired["project"]["master_audio"]["status"] == "building"


@pytest.mark.parametrize("problem", ["duplicate-metadata", "probe-mismatch"])
def test_build_rejects_tampered_current_speech_asset(
    master_client,
    problem,
):
    project, records = _seed_confirmed_project(master_client, [
        {"id": "a", "text": "甲", "seconds": 1.0},
    ])

    async def tamper():
        from media_command import probe_audio
        from models import TextVideoSpeechAsset
        from text_video_audio import normalize_speech_audio

        if problem == "duplicate-metadata":
            async with master_client["session_factory"]() as session:
                session.add(TextVideoSpeechAsset(
                    creative_asset_id=records[0]["asset_id"],
                    source_hash=records[0]["source_hash"],
                    duration=1,
                    sample_count=44100,
                    sample_rate=44100,
                    word_timings=[],
                    provider_request_id="duplicate",
                ))
                await session.commit()
        else:
            wav = await sine_wave(
                master_client["tmp_path"] / "tampered.wav",
                seconds=0.5,
            )
            await normalize_speech_audio(
                wav,
                records[0]["path"],
                speed=1,
                volume=1,
                pitch=0,
            )
            assert (await probe_audio(records[0]["path"])).sample_count != 44100

    asyncio.run(tamper())
    response = master_client["client"].post(
        f"/api/text-videos/{project['id']}/master-audio/build",
        json={"revision": project["revision"]},
    )

    assert response.status_code == 409
    assert "配音素材" in response.text


def test_native_alignment_uses_all_local_timings_and_persisted_offsets(
    master_client,
):
    project, _records = _seed_confirmed_project(master_client, [
        {
            "id": "a",
            "text": "甲",
            "seconds": 1.0,
            "word_timings": [{
                "id": "a-provider",
                "text": "甲",
                "start": 0.1,
                "end": 0.8,
            }],
        },
        {
            "id": "b",
            "text": "乙",
            "seconds": 1.0,
            "word_timings": [{
                "id": "b-provider",
                "text": "乙",
                "start": 0.2,
                "end": 0.9,
            }],
        },
    ])
    launch = _build(master_client, project)
    job = launch["jobs"][0]
    assembled = _assemble(
        master_client,
        project["id"],
        job["id"],
    ).json()

    async def must_not_transcribe(*_args, **_kwargs):
        raise AssertionError("native timing must not call paid transcription")

    master_client["monkeypatch"].setattr(
        master_client["router"],
        "transcribe_audio_words",
        must_not_transcribe,
    )
    response = _align(
        master_client,
        project["id"],
        job["id"],
        assembled["source_hash"],
    )

    assert response.status_code == 200, response.text
    current = response.json()
    assert current["master_audio"]["timeline_source"] == "provider"
    assert current["master_audio"]["timeline_status"] == "ready"
    assert current["render_input"]["audio"] == assembled["audio_url"]
    assert [
        item["start"]
        for item in current["master_audio"]["word_timings"]
    ] == pytest.approx([0.1, 1.2])
    assert "".join(
        item["text"] for item in current["master_audio"]["word_timings"]
    ) == project["script"]


def test_worker_align_rejects_browser_or_node_supplied_offsets(
    master_client,
):
    project, _records = _seed_confirmed_project(master_client, [{
        "id": "a",
        "text": "甲",
        "seconds": 1.0,
        "word_timings": [{
            "id": "a-provider",
            "text": "甲",
            "start": 0.1,
            "end": 0.8,
        }],
    }])
    launch = _build(master_client, project)
    job = launch["jobs"][0]
    assembled = _assemble(
        master_client,
        project["id"],
        job["id"],
    ).json()

    response = master_client["client"].post(
        f"/api/text-videos/{project['id']}/master-audio/worker-align",
        json={
            "source_hash": assembled["source_hash"],
            **_alignment_payload(master_client, job["id"]),
            "offsets": {"a": 999999},
        },
        headers=_worker_headers(job["id"]),
    )

    assert response.status_code == 422


@pytest.mark.parametrize(
    "invalid_claim",
    [
        {"step_id": True, "attempt": 1, "claim_token": "valid-claim-token"},
        {"step_id": 1, "attempt": False, "claim_token": "valid-claim-token"},
        {"step_id": 1, "attempt": 1, "claim_token": "short"},
    ],
)
def test_worker_align_rejects_non_strict_claim_identity(
    master_client,
    invalid_claim,
):
    response = master_client["client"].post(
        "/api/text-videos/1/master-audio/worker-align",
        json={"source_hash": "a" * 64, **invalid_claim},
        headers=_worker_headers(1),
    )

    assert response.status_code == 422


def test_alignment_failure_endpoint_requires_and_validates_current_claim(
    master_client,
):
    project, _records = _seed_confirmed_project(master_client, [{
        "id": "a",
        "text": "甲",
        "seconds": 1.0,
    }])
    launch = _build(master_client, project)
    job = launch["jobs"][0]
    assembled = _assemble(
        master_client,
        project["id"],
        job["id"],
    ).json()
    claim = _alignment_payload(master_client, job["id"])

    async def persist_claim():
        from text_video_master import begin_master_alignment

        async with master_client["session_factory"]() as session:
            await begin_master_alignment(
                session,
                project_id=project["id"],
                job_id=job["id"],
                source_hash=assembled["source_hash"],
                **claim,
            )

    asyncio.run(persist_claim())
    failure_url = (
        f"/api/text-videos/{project['id']}/master-audio/worker-failure"
    )
    missing = master_client["client"].post(
        failure_url,
        json={
            "source_hash": assembled["source_hash"],
            "phase": "align_master_timeline",
            "error": "provider unavailable",
        },
        headers=_worker_headers(job["id"]),
    )
    stale = master_client["client"].post(
        failure_url,
        json={
            "source_hash": assembled["source_hash"],
            "phase": "align_master_timeline",
            "error": "provider unavailable",
            **claim,
            "claim_token": "different-claim-token",
        },
        headers=_worker_headers(job["id"]),
    )
    acknowledged_unknown = master_client["client"].post(
        failure_url,
        json={
            "source_hash": assembled["source_hash"],
            "phase": "align_master_timeline",
            "error": "transport outcome unknown",
            **claim,
        },
        headers=_worker_headers(job["id"]),
    )
    current = master_client["client"].get(
        f"/api/text-videos/{project['id']}",
    ).json()

    assert missing.status_code == 422
    assert stale.status_code == 409
    assert stale.headers["X-Retryable"] == "false"
    assert acknowledged_unknown.status_code == 200
    assert acknowledged_unknown.json()["failure_applied"] is False
    assert current["master_audio"]["timeline_status"] == "aligning"
    assert current["master_audio"]["timeline_error"] == ""


def test_competing_worker_cannot_retry_paid_work_after_owner_domain_failure(
    master_client,
):
    from fastapi import HTTPException

    project, _records = _seed_confirmed_project(master_client, [{
        "id": "a",
        "text": "甲",
        "seconds": 1.0,
    }])
    launch = _build(master_client, project)
    job = launch["jobs"][0]
    assembled = _assemble(
        master_client,
        project["id"],
        job["id"],
    ).json()
    owner = _alignment_payload(
        master_client,
        job["id"],
        claim_token="domain-failure-owner",
    )
    transcriptions = 0

    async def must_not_transcribe(*_args, **_kwargs):
        nonlocal transcriptions
        transcriptions += 1
        raise AssertionError("non-owner must not repeat paid work")

    master_client["monkeypatch"].setattr(
        master_client["router"],
        "transcribe_audio_words",
        must_not_transcribe,
    )

    async def run():
        from content_jobs import fail_step
        from text_video_master import (
            begin_master_alignment,
            fail_master_audio,
        )

        async with master_client["session_factory"]() as session:
            await begin_master_alignment(
                session,
                project_id=project["id"],
                job_id=job["id"],
                source_hash=assembled["source_hash"],
                **owner,
            )
        async with master_client["session_factory"]() as session:
            await fail_master_audio(
                session,
                project_id=project["id"],
                job_id=job["id"],
                source_hash=assembled["source_hash"],
                phase="align_master_timeline",
                error="provider unavailable",
                retryable=True,
                **owner,
            )
        owner_replay = master_client["router"].MasterAlignRequest(
            source_hash=assembled["source_hash"],
            **owner,
        )
        async with master_client["session_factory"]() as session:
            with pytest.raises(HTTPException) as replayed:
                await master_client["router"]._worker_align_master_audio(
                    project["id"],
                    owner_replay,
                    job["id"],
                    session,
                )
        assert replayed.value.status_code == 422
        assert replayed.value.headers["X-Retryable"] == "true"
        competitor = master_client["router"].MasterAlignRequest(
            source_hash=assembled["source_hash"],
            step_id=owner["step_id"],
            attempt=owner["attempt"],
            claim_token="competing-worker-token",
        )

        async def request():
            async with master_client["session_factory"]() as session:
                return await master_client["router"]._worker_align_master_audio(
                    project["id"],
                    competitor,
                    job["id"],
                    session,
                )

        pending = asyncio.create_task(request())
        await asyncio.sleep(0.1)
        assert not pending.done()
        async with master_client["session_factory"]() as session:
            await fail_step(
                session,
                owner["step_id"],
                "provider unavailable",
                retryable=True,
            )
        with pytest.raises(HTTPException) as raised:
            await asyncio.wait_for(pending, timeout=2)
        return raised.value

    error = asyncio.run(run())
    assert error.status_code == 409
    assert transcriptions == 0


@pytest.mark.parametrize("local_timings", [[], [{
    "id": "only-one",
    "text": "甲",
    "start": 0,
    "end": 0.4,
}]])
def test_any_missing_or_low_coverage_local_timing_forces_one_master_request(
    master_client,
    local_timings,
):
    from text_video_transcription import TranscriptionResult

    project, _records = _seed_confirmed_project(master_client, [
        {
            "id": "a",
            "text": "甲乙",
            "seconds": 1.0,
            "word_timings": local_timings,
        },
        {
            "id": "b",
            "text": "丙",
            "seconds": 1.0,
            "word_timings": [{
                "id": "b-provider",
                "text": "丙",
                "start": 0.1,
                "end": 0.8,
            }],
        },
    ])
    launch = _build(master_client, project)
    job = launch["jobs"][0]
    assembled = _assemble(
        master_client,
        project["id"],
        job["id"],
    ).json()
    calls = 0

    async def transcribe(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        return TranscriptionResult(
            words=(
                {"text": "甲乙", "start": 0.0, "end": 1.0},
                {"text": "丙", "start": 1.0, "end": 1.8},
            ),
            text="甲乙丙",
            language="zh",
            request_id="forced-1",
        )

    master_client["monkeypatch"].setattr(
        master_client["router"],
        "transcribe_audio_words",
        transcribe,
    )
    response = _align(
        master_client,
        project["id"],
        job["id"],
        assembled["source_hash"],
    )

    assert response.status_code == 200, response.text
    assert calls == 1
    assert response.json()["master_audio"]["timeline_source"] == (
        "forced-alignment"
    )


def test_alignment_failure_preserves_ready_master_and_confirmed_segments(
    master_client,
):
    from text_video_transcription import TranscriptionResult

    project, _records = _seed_confirmed_project(master_client, [
        {"id": "a", "text": "甲乙", "seconds": 1.0},
    ])
    launch = _build(master_client, project)
    job = launch["jobs"][0]
    assembled = _assemble(
        master_client,
        project["id"],
        job["id"],
    ).json()

    async def transcribe(*_args, **_kwargs):
        return TranscriptionResult(
            words=({"text": "完全不同", "start": 0, "end": 0.8},),
            text="完全不同",
            language="zh",
            request_id="forced-bad",
        )

    master_client["monkeypatch"].setattr(
        master_client["router"],
        "transcribe_audio_words",
        transcribe,
    )
    response = _align(
        master_client,
        project["id"],
        job["id"],
        assembled["source_hash"],
    )

    assert response.status_code == 422
    current = master_client["client"].get(
        f"/api/text-videos/{project['id']}",
    ).json()
    assert current["master_audio"]["status"] == "ready"
    assert current["master_audio"]["audio_url"] == assembled["audio_url"]
    assert current["master_audio"]["timeline_status"] == "failed"
    assert current["render_input"]["audio"] == ""
    assert [item["status"] for item in current["paragraphs"]] == [
        "confirmed",
    ]


def test_master_failure_is_phase_aware_and_late_failure_is_idempotent(
    master_client,
):
    project, _records = _seed_confirmed_project(master_client, [
        {
            "id": "a",
            "text": "甲",
            "seconds": 1.0,
            "word_timings": [{
                "id": "a-provider",
                "text": "甲",
                "start": 0.1,
                "end": 0.8,
            }],
        },
    ])
    launch = _build(master_client, project)
    job = launch["jobs"][0]
    failure_url = (
        f"/api/text-videos/{project['id']}/master-audio/worker-failure"
    )
    failed = master_client["client"].post(
        failure_url,
        json={
            "source_hash": launch["project"]["master_audio"]["source_hash"],
            "phase": "assemble_master_audio",
            "error": "拼接失败",
        },
        headers=_worker_headers(job["id"]),
    )
    assert failed.status_code == 200, failed.text
    assert failed.json()["failure_applied"] is True
    assert failed.json()["master_audio"]["status"] == "failed"

    retried = _build(master_client, failed.json())
    retry_job = retried["jobs"][0]
    assembled = _assemble(
        master_client,
        project["id"],
        retry_job["id"],
    ).json()
    aligned = _align(
        master_client,
        project["id"],
        retry_job["id"],
        assembled["source_hash"],
    )
    assert aligned.status_code == 200, aligned.text
    late = master_client["client"].post(
        failure_url,
        json={
            "source_hash": assembled["source_hash"],
            "phase": "align_master_timeline",
            "error": "迟到的失败",
            **master_client["alignment_claims"][retry_job["id"]],
        },
        headers=_worker_headers(retry_job["id"]),
    )
    assert late.status_code == 200, late.text
    assert late.json()["failure_applied"] is False
    assert late.json()["master_audio"]["status"] == "ready"
    assert late.json()["master_audio"]["timeline_status"] == "ready"
    assert late.json()["render_input"]["audio"] == assembled["audio_url"]


def test_concurrent_master_builds_create_one_job(master_client):
    project, _records = _seed_confirmed_project(master_client, [{
        "id": "a",
        "text": "甲",
        "seconds": 1.0,
    }])

    async def run():
        from models import ContentJob
        from text_video_master import launch_master_audio

        async def launch():
            async with master_client["session_factory"]() as session:
                return await launch_master_audio(
                    session,
                    project["id"],
                    expected_revision=project["revision"],
                )

        first, second = await asyncio.gather(launch(), launch())
        async with master_client["session_factory"]() as session:
            count = await session.scalar(
                select(func.count(ContentJob.id)).where(
                    ContentJob.flow == "text_video_master_audio",
                ),
            )
        return first.jobs[0].id, second.jobs[0].id, count

    first_id, second_id, count = asyncio.run(run())

    assert first_id == second_id
    assert count == 1


def test_master_build_never_probes_media_inside_database_transaction(
    master_client,
):
    import text_video_master

    project, _records = _seed_confirmed_project(master_client, [{
        "id": "a",
        "text": "甲",
        "seconds": 1.0,
    }])
    original_probe = text_video_master.probe_audio

    async def run():
        async with master_client["session_factory"]() as session:
            calls = 0

            async def checked_probe(path):
                nonlocal calls
                calls += 1
                assert session.in_transaction() is False
                return await original_probe(path)

            master_client["monkeypatch"].setattr(
                text_video_master,
                "probe_audio",
                checked_probe,
            )
            result = await text_video_master.launch_master_audio(
                session,
                project["id"],
                expected_revision=project["revision"],
            )
            return result, calls

    result, calls = asyncio.run(run())

    assert result.jobs
    assert calls >= 1


def test_enqueue_failure_reuses_and_reenqueues_committed_job(
    master_client,
):
    import text_video_master

    project, _records = _seed_confirmed_project(master_client, [{
        "id": "a",
        "text": "甲",
        "seconds": 1.0,
    }])
    calls: list[int] = []

    async def flaky_enqueue(job_id: int):
        calls.append(job_id)
        if len(calls) == 1:
            raise RuntimeError("queue temporarily unavailable")

    master_client["monkeypatch"].setattr(
        text_video_master,
        "enqueue_job",
        flaky_enqueue,
    )

    with pytest.raises(RuntimeError, match="queue temporarily unavailable"):
        master_client["client"].post(
            f"/api/text-videos/{project['id']}/master-audio/build",
            json={"revision": project["revision"]},
        )
    current = master_client["client"].get(
        f"/api/text-videos/{project['id']}",
    ).json()
    replay = _build(master_client, current)

    async def count_jobs():
        from models import ContentJob

        async with master_client["session_factory"]() as session:
            return await session.scalar(
                select(func.count(ContentJob.id)).where(
                    ContentJob.flow == "text_video_master_audio",
                ),
            )

    assert calls == [replay["jobs"][0]["id"], replay["jobs"][0]["id"]]
    assert asyncio.run(count_jobs()) == 1


def test_tampered_ready_offsets_force_a_repair_job(master_client):
    project, _records = _seed_confirmed_project(master_client, [
        {"id": "a", "text": "甲", "seconds": 1.0},
        {"id": "b", "text": "乙", "seconds": 1.0},
    ])
    launch = _build(master_client, project)
    job = launch["jobs"][0]
    assembled = _assemble(
        master_client,
        project["id"],
        job["id"],
    ).json()

    async def tamper():
        from copy import deepcopy
        from models import ContentJob, TextVideoProject

        async with master_client["session_factory"]() as session:
            current_job = await session.get(ContentJob, job["id"])
            current_job.status = "succeeded"
            current = await session.get(TextVideoProject, project["id"])
            master = deepcopy(current.master_audio)
            master["timeline_status"] = "ready"
            master["timeline_source"] = "provider"
            master["word_timings"] = [
                {"id": "word-0-1", "text": "甲", "start": 0, "end": 0.8},
                {"id": "word-1-2", "text": "乙", "start": 1, "end": 1.8},
            ]
            master["segment_offsets"][1]["sample_offset"] = 1
            current.master_audio = master
            render_input = deepcopy(current.render_input)
            render_input["audio"] = assembled["audio_url"]
            current.render_input = render_input
            await session.commit()

    asyncio.run(tamper())
    current = master_client["client"].get(
        f"/api/text-videos/{project['id']}",
    ).json()
    repaired = _build(master_client, current)

    assert repaired["jobs"]
    assert repaired["jobs"][0]["id"] != job["id"]
    assert repaired["project"]["master_audio"]["repair_generation"] == 1


def test_ready_master_validation_rejects_duration_and_ownership_tampering(
    master_client,
):
    project, _records = _seed_confirmed_project(master_client, [
        {"id": "a", "text": "甲", "seconds": 1.0},
        {"id": "b", "text": "乙", "seconds": 1.0},
    ])
    launch = _build(master_client, project)
    job = launch["jobs"][0]
    _assemble(master_client, project["id"], job["id"])

    async def validate():
        from copy import deepcopy
        from models import ContentJob, TextVideoProject
        from text_video_master import _master_asset_valid

        async with master_client["session_factory"]() as session:
            current = await session.get(TextVideoProject, project["id"])
            current_job = await session.get(ContentJob, job["id"])
            snapshot = current_job.input_data["segments"]
            master = deepcopy(current.master_audio)
            bad_duration = deepcopy(master)
            bad_duration["duration"] = master["duration"] + 0.1
            bad_ownership = deepcopy(master)
            bad_ownership["owns_asset"] = False
            bad_boolean_offset = deepcopy(master)
            bad_boolean_offset["segment_offsets"][0]["sample_offset"] = False
            return (
                await _master_asset_valid(
                    session,
                    bad_duration,
                    source_hash=master["source_hash"],
                    snapshot=snapshot,
                ),
                await _master_asset_valid(
                    session,
                    bad_ownership,
                    source_hash=master["source_hash"],
                    snapshot=snapshot,
                ),
                await _master_asset_valid(
                    session,
                    bad_boolean_offset,
                    source_hash=master["source_hash"],
                    snapshot=snapshot,
                ),
            )

    assert asyncio.run(validate()) == (False, False, False)


def test_stale_job_id_cannot_persist_a_new_master_asset(master_client):
    project, _records = _seed_confirmed_project(master_client, [
        {"id": "a", "text": "甲", "seconds": 1.0},
        {"id": "b", "text": "乙", "seconds": 1.0},
    ])
    launch = _build(master_client, project)
    job = launch["jobs"][0]

    async def make_stale():
        from copy import deepcopy
        from models import CreativeAsset, TextVideoProject

        async with master_client["session_factory"]() as session:
            current = await session.get(TextVideoProject, project["id"])
            master = deepcopy(current.master_audio)
            master["job_id"] = job["id"] + 999
            current.master_audio = master
            before = await session.scalar(
                select(func.count(CreativeAsset.id)),
            )
            await session.commit()
            return before

    before = asyncio.run(make_stale())
    response = _assemble(master_client, project["id"], job["id"])

    async def asset_count():
        from models import CreativeAsset

        async with master_client["session_factory"]() as session:
            return await session.scalar(select(func.count(CreativeAsset.id)))

    assert response.status_code == 409
    assert response.headers["X-Retryable"] == "false"
    assert asyncio.run(asset_count()) == before


def test_failed_job_late_assembly_cannot_mutate_master(master_client):
    project, _records = _seed_confirmed_project(master_client, [{
        "id": "a",
        "text": "甲",
        "seconds": 1.0,
    }])
    launch = _build(master_client, project)
    job = launch["jobs"][0]
    step = master_client["client"].post(
        f"/api/jobs/{job['id']}/steps/assemble_master_audio/start",
    ).json()
    failed = master_client["client"].post(
        f"/api/jobs/{job['id']}/steps/{step['id']}/fail",
        json={"error": "worker failed", "retryable": True},
    )
    assert failed.status_code == 200, failed.text

    response = _assemble(master_client, project["id"], job["id"])
    current = master_client["client"].get(
        f"/api/text-videos/{project['id']}",
    ).json()

    assert response.status_code == 409
    assert response.headers["X-Retryable"] == "false"
    assert current["master_audio"]["status"] == "building"
    assert current["master_audio"]["asset_id"] is None


def test_stale_ordered_asset_snapshot_cannot_complete_assembly(
    master_client,
):
    project, records = _seed_confirmed_project(master_client, [
        {"id": "a", "text": "甲", "seconds": 1.0},
        {"id": "b", "text": "乙", "seconds": 1.0},
    ])
    launch = _build(master_client, project)
    job = launch["jobs"][0]

    async def swap_current_asset():
        from copy import deepcopy
        from models import TextVideoProject

        async with master_client["session_factory"]() as session:
            current = await session.get(TextVideoProject, project["id"])
            paragraphs = deepcopy(current.paragraphs)
            paragraphs[0] = {
                **paragraphs[0],
                "audio_url": records[1]["audio_url"],
                "source_hash": records[1]["source_hash"],
            }
            current.paragraphs = paragraphs
            await session.commit()

    asyncio.run(swap_current_asset())
    response = _assemble(master_client, project["id"], job["id"])

    assert response.status_code == 409
    assert response.headers["X-Retryable"] == "false"


def test_begin_alignment_rejects_a_second_live_claim(master_client):
    project, _records = _seed_confirmed_project(master_client, [{
        "id": "a",
        "text": "甲",
        "seconds": 1.0,
    }])
    launch = _build(master_client, project)
    job = launch["jobs"][0]
    assembled = _assemble(
        master_client,
        project["id"],
        job["id"],
    ).json()
    started = master_client["client"].post(
        f"/api/jobs/{job['id']}/steps/align_master_timeline/start",
    ).json()

    async def begin_twice():
        from text_video_master import MasterBusyError, begin_master_alignment

        async with master_client["session_factory"]() as session:
            first = await begin_master_alignment(
                session,
                project_id=project["id"],
                job_id=job["id"],
                source_hash=assembled["source_hash"],
                step_id=started["id"],
                attempt=started["attempt"],
                claim_token="first-live-claim-token",
            )
        async with master_client["session_factory"]() as session:
            with pytest.raises(MasterBusyError):
                await begin_master_alignment(
                    session,
                    project_id=project["id"],
                    job_id=job["id"],
                    source_hash=assembled["source_hash"],
                    step_id=started["id"],
                    attempt=started["attempt"],
                    claim_token="response-loss-retry-token",
                )
        return first

    first = asyncio.run(begin_twice())

    assert first.already_ready is False
    assert first.audio_url == assembled["audio_url"]


def test_concurrent_worker_align_requests_share_one_paid_transcription(
    master_client,
):
    from text_video_transcription import TranscriptionResult

    project, _records = _seed_confirmed_project(master_client, [{
        "id": "a",
        "text": "甲",
        "seconds": 1.0,
    }])
    launch = _build(master_client, project)
    job = launch["jobs"][0]
    assembled = _assemble(
        master_client,
        project["id"],
        job["id"],
    ).json()
    started_step = master_client["client"].post(
        f"/api/jobs/{job['id']}/steps/align_master_timeline/start",
    ).json()
    transcription_started = asyncio.Event()
    release_transcription = asyncio.Event()
    calls = 0

    async def slow_transcribe(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        transcription_started.set()
        await release_transcription.wait()
        return TranscriptionResult(
            words=({"text": "甲", "start": 0.1, "end": 0.8},),
            text="甲",
            language="zh",
            request_id="one-paid-call",
        )

    master_client["monkeypatch"].setattr(
        master_client["router"],
        "transcribe_audio_words",
        slow_transcribe,
    )

    async def run():
        first_payload = master_client["router"].MasterAlignRequest(
            source_hash=assembled["source_hash"],
            step_id=started_step["id"],
            attempt=started_step["attempt"],
            claim_token="first-concurrent-claim",
        )
        replay_payload = master_client["router"].MasterAlignRequest(
            source_hash=assembled["source_hash"],
            step_id=started_step["id"],
            attempt=started_step["attempt"],
            claim_token="first-concurrent-claim",
        )
        competing_payload = master_client["router"].MasterAlignRequest(
            source_hash=assembled["source_hash"],
            step_id=started_step["id"],
            attempt=started_step["attempt"],
            claim_token="second-concurrent-claim",
        )

        async def request(payload):
            async with master_client["session_factory"]() as session:
                # Call the inner handler to prove the database claim, rather
                # than the process-local asyncio lock, owns exclusion.
                return await master_client["router"]._worker_align_master_audio(
                    project["id"],
                    payload,
                    job["id"],
                    session,
                )

        first = asyncio.create_task(request(first_payload))
        await asyncio.wait_for(transcription_started.wait(), timeout=5)
        replay = asyncio.create_task(request(replay_payload))
        competing = asyncio.create_task(request(competing_payload))
        await asyncio.sleep(0.05)
        release_transcription.set()
        return await asyncio.gather(first, replay, competing)

    first, replay, competing = asyncio.run(run())

    assert calls == 1
    assert first["master_audio"]["timeline_status"] == "ready"
    assert replay["master_audio"] == first["master_audio"]
    assert competing["master_audio"] == first["master_audio"]


def test_simultaneous_first_claims_are_serialized_by_database_authority(
    master_client,
):
    import text_video_master
    from text_video_transcription import TranscriptionResult

    project, _records = _seed_confirmed_project(master_client, [{
        "id": "a",
        "text": "甲",
        "seconds": 1.0,
    }])
    launch = _build(master_client, project)
    job = launch["jobs"][0]
    assembled = _assemble(
        master_client,
        project["id"],
        job["id"],
    ).json()
    step = master_client["client"].post(
        f"/api/jobs/{job['id']}/steps/align_master_timeline/start",
    ).json()
    original_probe = text_video_master._probe_master_audio
    both_preflight_probes = asyncio.Event()
    probe_arrivals = 0
    transcriptions = 0

    async def synchronized_probe(master):
        nonlocal probe_arrivals
        result = await original_probe(master)
        probe_arrivals += 1
        if probe_arrivals >= 2:
            both_preflight_probes.set()
        await asyncio.wait_for(both_preflight_probes.wait(), timeout=5)
        return result

    async def transcribe(*_args, **_kwargs):
        nonlocal transcriptions
        transcriptions += 1
        return TranscriptionResult(
            words=({"text": "甲", "start": 0.1, "end": 0.8},),
            text="甲",
            language="zh",
            request_id="simultaneous-first-claim",
        )

    master_client["monkeypatch"].setattr(
        text_video_master,
        "_probe_master_audio",
        synchronized_probe,
    )
    master_client["monkeypatch"].setattr(
        master_client["router"],
        "transcribe_audio_words",
        transcribe,
    )

    async def run():
        async def request(token):
            payload = master_client["router"].MasterAlignRequest(
                source_hash=assembled["source_hash"],
                step_id=step["id"],
                attempt=step["attempt"],
                claim_token=token,
            )
            async with master_client["session_factory"]() as session:
                return await master_client["router"]._worker_align_master_audio(
                    project["id"],
                    payload,
                    job["id"],
                    session,
                )

        return await asyncio.gather(
            request("simultaneous-claim-a"),
            request("simultaneous-claim-b"),
        )

    first, second = asyncio.run(run())
    assert probe_arrivals >= 2
    assert transcriptions == 1
    assert first["master_audio"]["timeline_status"] == "ready"
    assert second["master_audio"] == first["master_audio"]


def test_old_alignment_attempt_cannot_complete_or_fail_new_claim(
    master_client,
):
    project, _records = _seed_confirmed_project(master_client, [{
        "id": "a",
        "text": "甲",
        "seconds": 1.0,
    }])
    launch = _build(master_client, project)
    job = launch["jobs"][0]
    assembled = _assemble(
        master_client,
        project["id"],
        job["id"],
    ).json()
    first_step = master_client["client"].post(
        f"/api/jobs/{job['id']}/steps/align_master_timeline/start",
    ).json()

    async def claim_first():
        from text_video_master import begin_master_alignment

        async with master_client["session_factory"]() as session:
            await begin_master_alignment(
                session,
                project_id=project["id"],
                job_id=job["id"],
                source_hash=assembled["source_hash"],
                step_id=first_step["id"],
                attempt=first_step["attempt"],
                claim_token="old-alignment-claim",
            )

    asyncio.run(claim_first())
    failed_step = master_client["client"].post(
        f"/api/jobs/{job['id']}/steps/{first_step['id']}/fail",
        json={"error": "worker lost", "retryable": True},
    )
    assert failed_step.status_code == 200, failed_step.text
    retried = master_client["client"].post(
        f"/api/jobs/{job['id']}/retry",
        json={"step_key": "align_master_timeline"},
    )
    assert retried.status_code == 200, retried.text
    second_step = master_client["client"].post(
        f"/api/jobs/{job['id']}/steps/align_master_timeline/start",
    ).json()
    assert second_step["attempt"] == first_step["attempt"] + 1

    async def exercise_stale_attempt():
        from text_video_master import (
            StaleMasterJob,
            begin_master_alignment,
            complete_master_alignment,
            fail_master_audio,
        )

        async with master_client["session_factory"]() as session:
            await begin_master_alignment(
                session,
                project_id=project["id"],
                job_id=job["id"],
                source_hash=assembled["source_hash"],
                step_id=second_step["id"],
                attempt=second_step["attempt"],
                claim_token="new-alignment-claim",
            )
        async with master_client["session_factory"]() as session:
            with pytest.raises(StaleMasterJob):
                await complete_master_alignment(
                    session,
                    project_id=project["id"],
                    job_id=job["id"],
                    source_hash=assembled["source_hash"],
                    step_id=first_step["id"],
                    attempt=first_step["attempt"],
                    claim_token="old-alignment-claim",
                    words=[{
                        "id": "word-a",
                        "text": "甲",
                        "start": 0.1,
                        "end": 0.8,
                        "speech_segment_id": "a",
                    }],
                    timeline_source="forced-alignment",
                )
        async with master_client["session_factory"]() as session:
            with pytest.raises(StaleMasterJob):
                await fail_master_audio(
                    session,
                    project_id=project["id"],
                    job_id=job["id"],
                    source_hash=assembled["source_hash"],
                    phase="align_master_timeline",
                    error="late old failure",
                    step_id=first_step["id"],
                    attempt=first_step["attempt"],
                    claim_token="old-alignment-claim",
                )
        async with master_client["session_factory"]() as session:
            from models import TextVideoProject

            current = await session.get(TextVideoProject, project["id"])
            return dict(current.master_audio)

    master = asyncio.run(exercise_stale_attempt())
    assert master["timeline_status"] == "aligning"
    assert master["alignment_step_id"] == second_step["id"]
    assert master["alignment_attempt"] == second_step["attempt"]
    assert master["alignment_claim_token"] == "new-alignment-claim"


def test_expired_alignment_claim_never_allows_same_attempt_to_repeat_paid_work(
    master_client,
):
    project, _records = _seed_confirmed_project(master_client, [{
        "id": "a",
        "text": "甲",
        "seconds": 1.0,
    }])
    launch = _build(master_client, project)
    job = launch["jobs"][0]
    assembled = _assemble(
        master_client,
        project["id"],
        job["id"],
    ).json()
    step = master_client["client"].post(
        f"/api/jobs/{job['id']}/steps/align_master_timeline/start",
    ).json()

    async def reject_expired_replacement():
        import text_video_master
        from text_video_master import (
            StaleMasterJob,
            begin_master_alignment,
        )

        clock = 1_000.0
        master_client["monkeypatch"].setattr(
            text_video_master.time,
            "time",
            lambda: clock,
        )
        async with master_client["session_factory"]() as session:
            await begin_master_alignment(
                session,
                project_id=project["id"],
                job_id=job["id"],
                source_hash=assembled["source_hash"],
                step_id=step["id"],
                attempt=step["attempt"],
                claim_token="expired-alignment-claim",
            )
        clock += text_video_master.MASTER_ALIGNMENT_LEASE_SECONDS + 1
        async with master_client["session_factory"]() as session:
            with pytest.raises(StaleMasterJob):
                await begin_master_alignment(
                    session,
                    project_id=project["id"],
                    job_id=job["id"],
                    source_hash=assembled["source_hash"],
                    step_id=step["id"],
                    attempt=step["attempt"],
                    claim_token="replacement-align-claim",
                )
        async with master_client["session_factory"]() as session:
            from models import TextVideoProject

            current = await session.get(TextVideoProject, project["id"])
            return dict(current.master_audio)

    master = asyncio.run(reject_expired_replacement())
    assert master["alignment_claim_token"] == "expired-alignment-claim"


def test_assembly_response_loss_retry_replays_same_persisted_asset(
    master_client,
):
    import text_video_master

    project, _records = _seed_confirmed_project(master_client, [
        {"id": "a", "text": "甲", "seconds": 1.0},
        {"id": "b", "text": "乙", "seconds": 1.0},
    ])
    launch = _build(master_client, project)
    job = launch["jobs"][0]
    first_step = master_client["client"].post(
        f"/api/jobs/{job['id']}/steps/assemble_master_audio/start",
    ).json()
    first = _assemble(master_client, project["id"], job["id"])
    assert first.status_code == 200, first.text
    failed = master_client["client"].post(
        f"/api/jobs/{job['id']}/steps/{first_step['id']}/fail",
        json={"error": "response lost", "retryable": True},
    )
    assert failed.status_code == 200, failed.text
    retried = master_client["client"].post(
        f"/api/jobs/{job['id']}/retry",
        json={"step_key": "assemble_master_audio"},
    )
    assert retried.status_code == 200, retried.text
    retry_step = master_client["client"].post(
        f"/api/jobs/{job['id']}/steps/assemble_master_audio/start",
    )
    assert retry_step.status_code == 200, retry_step.text

    async def must_not_reassemble(*_args, **_kwargs):
        raise AssertionError("durable master must be replayed")

    master_client["monkeypatch"].setattr(
        text_video_master,
        "assemble_master_audio",
        must_not_reassemble,
    )
    replay = _assemble(master_client, project["id"], job["id"])

    assert replay.status_code == 200, replay.text
    assert replay.json() == first.json()


def test_alignment_response_loss_retry_replays_ready_timeline(
    master_client,
):
    project, _records = _seed_confirmed_project(master_client, [{
        "id": "a",
        "text": "甲",
        "seconds": 1.0,
        "word_timings": [{
            "id": "a-provider",
            "text": "甲",
            "start": 0.1,
            "end": 0.8,
        }],
    }])
    launch = _build(master_client, project)
    job = launch["jobs"][0]
    assembly_step = master_client["client"].post(
        f"/api/jobs/{job['id']}/steps/assemble_master_audio/start",
    ).json()
    assembled = _assemble(
        master_client,
        project["id"],
        job["id"],
    ).json()
    completed_assembly = master_client["client"].post(
        f"/api/jobs/{job['id']}/steps/{assembly_step['id']}/succeed",
        json={"output": assembled},
    )
    assert completed_assembly.status_code == 200, completed_assembly.text
    align_step = master_client["client"].post(
        f"/api/jobs/{job['id']}/steps/align_master_timeline/start",
    ).json()
    first = _align(
        master_client,
        project["id"],
        job["id"],
        assembled["source_hash"],
    )
    assert first.status_code == 200, first.text
    failed = master_client["client"].post(
        f"/api/jobs/{job['id']}/steps/{align_step['id']}/fail",
        json={"error": "response lost", "retryable": True},
    )
    assert failed.status_code == 200, failed.text
    retried = master_client["client"].post(
        f"/api/jobs/{job['id']}/retry",
        json={"step_key": "align_master_timeline"},
    )
    assert retried.status_code == 200, retried.text
    retry_step = master_client["client"].post(
        f"/api/jobs/{job['id']}/steps/align_master_timeline/start",
    )
    assert retry_step.status_code == 200, retry_step.text

    async def must_not_transcribe(*_args, **_kwargs):
        raise AssertionError("ready timeline must be replayed")

    master_client["monkeypatch"].setattr(
        master_client["router"],
        "transcribe_audio_words",
        must_not_transcribe,
    )
    replay = _align(
        master_client,
        project["id"],
        job["id"],
        assembled["source_hash"],
    )

    assert replay.status_code == 200, replay.text
    assert replay.json()["master_audio"] == first.json()["master_audio"]


def test_failed_alignment_retry_attempt_can_claim_and_complete(
    master_client,
):
    from text_video_transcription import (
        TranscriptionError,
        TranscriptionResult,
    )

    project, _records = _seed_confirmed_project(master_client, [{
        "id": "a",
        "text": "甲",
        "seconds": 1.0,
    }])
    launch = _build(master_client, project)
    job = launch["jobs"][0]
    assembly_step = master_client["client"].post(
        f"/api/jobs/{job['id']}/steps/assemble_master_audio/start",
    ).json()
    assembled = _assemble(
        master_client,
        project["id"],
        job["id"],
    ).json()
    master_client["client"].post(
        f"/api/jobs/{job['id']}/steps/{assembly_step['id']}/succeed",
        json={"output": assembled},
    )
    first_step = master_client["client"].post(
        f"/api/jobs/{job['id']}/steps/align_master_timeline/start",
    ).json()
    calls = 0

    async def flaky_transcribe(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise TranscriptionError("provider timeout", retryable=True)
        return TranscriptionResult(
            words=({"text": "甲", "start": 0.1, "end": 0.8},),
            text="甲",
            language="zh",
            request_id="retry-success",
        )

    master_client["monkeypatch"].setattr(
        master_client["router"],
        "transcribe_audio_words",
        flaky_transcribe,
    )
    failed = _align(
        master_client,
        project["id"],
        job["id"],
        assembled["source_hash"],
    )
    assert failed.status_code == 422
    assert failed.headers["X-Retryable"] == "true"
    failed_step = master_client["client"].post(
        f"/api/jobs/{job['id']}/steps/{first_step['id']}/fail",
        json={"error": "provider timeout", "retryable": True},
    )
    assert failed_step.status_code == 200, failed_step.text
    retried = master_client["client"].post(
        f"/api/jobs/{job['id']}/retry",
        json={"step_key": "align_master_timeline"},
    )
    assert retried.status_code == 200, retried.text
    second_step = master_client["client"].post(
        f"/api/jobs/{job['id']}/steps/align_master_timeline/start",
    )
    assert second_step.status_code == 200, second_step.text
    assert second_step.json()["attempt"] == 2

    completed = _align(
        master_client,
        project["id"],
        job["id"],
        assembled["source_hash"],
    )

    assert completed.status_code == 200, completed.text
    assert calls == 2
    assert completed.json()["master_audio"]["timeline_status"] == "ready"


def test_alignment_failure_report_race_returns_explicit_stale_conflict(
    master_client,
):
    from text_video_transcription import TranscriptionError

    project, _records = _seed_confirmed_project(master_client, [{
        "id": "a",
        "text": "甲",
        "seconds": 1.0,
    }])
    launch = _build(master_client, project)
    job = launch["jobs"][0]
    assembled = _assemble(
        master_client,
        project["id"],
        job["id"],
    ).json()

    async def transcribe_then_replace_job(*_args, **_kwargs):
        from copy import deepcopy
        from models import TextVideoProject

        async with master_client["session_factory"]() as session:
            current = await session.get(TextVideoProject, project["id"])
            master = deepcopy(current.master_audio)
            master["job_id"] = job["id"] + 999
            current.master_audio = master
            await session.commit()
        raise TranscriptionError("provider timeout", retryable=True)

    master_client["monkeypatch"].setattr(
        master_client["router"],
        "transcribe_audio_words",
        transcribe_then_replace_job,
    )
    response = _align(
        master_client,
        project["id"],
        job["id"],
        assembled["source_hash"],
    )

    assert response.status_code == 409
    assert response.headers["X-Retryable"] == "false"
