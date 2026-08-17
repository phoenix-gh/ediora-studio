import asyncio
import json
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
                "digital_human_shots",
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


def _seed_comfyui(session_factory):
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
            look = CreativeAsset(
                asset_type="media",
                media_kind="image",
                title="look",
                url="/api/uploads/look.jpg",
                media_type="image/jpeg",
                filename="look.jpg",
            )
            session.add_all([environment, portrait, voice, look])
            await session.flush()
            role = DigitalHuman(
                name="林晓",
                status="ready",
                provider="comfyui",
                portrait_asset_id=portrait.id,
                voice_sample_asset_id=voice.id,
                default_environment_asset_id=environment.id,
                look_asset_id=look.id,
            )
            session.add(role)
            await session.commit()
            return role.id, look.id

    return asyncio.new_event_loop().run_until_complete(run())


def test_comfyui_shot_render_requires_voice_sample(api, monkeypatch):
    client, session_factory, _ = api
    monkeypatch.setenv("COMFYUI_BASE_URL", "http://127.0.0.1:8188")

    async def seed_without_voice():
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
            look = CreativeAsset(
                asset_type="media",
                media_kind="image",
                title="look",
                url="/api/uploads/look.jpg",
                media_type="image/jpeg",
                filename="look.jpg",
            )
            session.add_all([environment, portrait, look])
            await session.flush()
            role = DigitalHuman(
                name="MK",
                status="ready",
                provider="comfyui",
                portrait_asset_id=portrait.id,
                voice_sample_asset_id=None,
                default_environment_asset_id=environment.id,
                look_asset_id=look.id,
            )
            session.add(role)
            await session.commit()
            return role.id

    role_id = asyncio.new_event_loop().run_until_complete(seed_without_voice())
    created = client.post(
        "/api/talking-videos",
        json={"title": "缺声音", "digital_human_id": role_id},
    )
    assert created.status_code == 201, created.text
    assert created.json()["role"]["voice_sample_asset_id"] is None
    shot_id = created.json()["shots"][0]["id"]

    response = client.post(
        f"/api/talking-videos/{created.json()['id']}/shots/{shot_id}/render",
    )

    assert response.status_code == 409
    assert response.json()["detail"] == "请先为数字人上传 2–15 秒声音样本"


def test_comfyui_project_uses_shots_and_rejects_heygen_render(api, monkeypatch):
    client, session_factory, _ = api
    monkeypatch.setenv("COMFYUI_BASE_URL", "http://127.0.0.1:8188")
    role_id, _ = _seed_comfyui(session_factory)
    created = client.post(
        "/api/talking-videos",
        json={"title": "分镜作品", "digital_human_id": role_id},
    )
    assert created.status_code == 201, created.text
    shots = created.json()["shots"]
    assert len(shots) == 1
    assert shots[0]["duration_sec"] == 5

    heygen_render = client.post(f"/api/talking-videos/{created.json()['id']}/renders")
    assert heygen_render.status_code == 409

    saved = client.put(
        f"/api/talking-videos/{created.json()['id']}/shots",
        json={
            "shots": [
                {
                    **shots[0],
                    "spoken_text": "今天只讲一件事",
                    "duration_sec": 4,
                    "framing": "close",
                }
            ]
        },
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["script"] == "今天只讲一件事"

    queued = client.post(
        f"/api/talking-videos/{created.json()['id']}/shots/{shots[0]['id']}/render",
    )
    assert queued.status_code == 201, queued.text
    assert queued.json()["shots"][0]["status"] == "queued"

    incomplete = client.post(f"/api/talking-videos/{created.json()['id']}/stitch")
    assert incomplete.status_code == 409


def test_comfyui_stitch_requires_successful_clips(api, monkeypatch):
    client, session_factory, _ = api
    monkeypatch.setenv("COMFYUI_BASE_URL", "http://127.0.0.1:8188")
    role_id, _ = _seed_comfyui(session_factory)
    created = client.post(
        "/api/talking-videos",
        json={"title": "分镜作品", "digital_human_id": role_id},
    ).json()
    shot = created["shots"][0]
    clip_id = _create_environment(session_factory, "clip.mp4")

    async def mark_clip_video():
        from models import CreativeAsset

        async with session_factory() as session:
            asset = await session.get(CreativeAsset, clip_id)
            asset.media_kind = "video"
            asset.media_type = "video/mp4"
            await session.commit()

    asyncio.new_event_loop().run_until_complete(mark_clip_video())
    saved = client.put(
        f"/api/talking-videos/{created['id']}/shots",
        json={
            "shots": [
                {
                    **shot,
                    "spoken_text": "今天只讲一件事",
                    "status": "succeeded",
                    "clip_asset_id": clip_id,
                }
            ]
        },
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["shots"][0]["clip_asset"]["url"].endswith("clip.mp4")
    stitched = client.post(f"/api/talking-videos/{created['id']}/stitch")
    assert stitched.status_code == 201, stitched.text
    assert stitched.json()["version"] == 1
    assert stitched.json()["shots_snapshot"][0]["clip_asset_id"] == clip_id


def test_project_payload_unlocks_render_when_stitch_job_already_failed(
    api, monkeypatch,
):
    client, session_factory, _ = api
    monkeypatch.setenv("COMFYUI_BASE_URL", "http://127.0.0.1:8188")
    role_id, _ = _seed_comfyui(session_factory)
    created = client.post(
        "/api/talking-videos",
        json={"title": "分镜作品", "digital_human_id": role_id},
    ).json()
    shot = created["shots"][0]
    clip_id = _create_environment(session_factory, "clip.mp4")

    async def mark_clip_video():
        from models import CreativeAsset

        async with session_factory() as session:
            asset = await session.get(CreativeAsset, clip_id)
            asset.media_kind = "video"
            asset.media_type = "video/mp4"
            await session.commit()

    asyncio.new_event_loop().run_until_complete(mark_clip_video())
    saved = client.put(
        f"/api/talking-videos/{created['id']}/shots",
        json={
            "shots": [
                {
                    **shot,
                    "spoken_text": "今天只讲一件事",
                    "status": "succeeded",
                    "clip_asset_id": clip_id,
                }
            ]
        },
    )
    assert saved.status_code == 200, saved.text
    stitched = client.post(f"/api/talking-videos/{created['id']}/stitch")
    assert stitched.status_code == 201, stitched.text
    render_id = stitched.json()["id"]
    job_id = stitched.json()["job_id"]

    async def fail_job():
        from models import ContentJob, TalkingVideoRender

        async with session_factory() as session:
            job = await session.get(ContentJob, job_id)
            job.status = "failed"
            render = await session.get(TalkingVideoRender, render_id)
            render.status = "running"
            await session.commit()

    asyncio.new_event_loop().run_until_complete(fail_job())
    detail = client.get(f"/api/talking-videos/{created['id']}").json()
    render = next(item for item in detail["renders"] if item["id"] == render_id)
    assert render["status"] == "failed"
    assert render["error"]


def test_comfyui_plan_replaces_shots_and_keeps_full_script(api, monkeypatch):
    client, session_factory, _ = api
    monkeypatch.setenv("COMFYUI_BASE_URL", "http://127.0.0.1:8188")
    role_id, _ = _seed_comfyui(session_factory)
    created = client.post(
        "/api/talking-videos",
        json={"title": "分镜作品", "digital_human_id": role_id},
    ).json()
    script = "今天讲本地部署。然后看环境准备。"
    old_shot_id = created["shots"][0]["id"]

    async def fake_call(prompt, max_tokens=2048):
        if "口播语气提炼器" in prompt:
            return json.dumps({
                "delivery": "calm tutorial host, medium pace",
                "presence": "seated, relaxed, explaining to camera",
            })
        return json.dumps([
            {
                "text": "今天讲本地部署。",
                "framing": "close",
                "delivery": "slightly brighter hook",
                "presence": "forward lean, brighter eyes, one-hand beat",
            },
            {
                "text": "然后看环境准备。",
                "framing": "wide",
                "delivery": "measured tutorial pace",
                "presence": "upright, slower nods, hands count the step",
            },
        ])

    monkeypatch.setattr("llm._call", fake_call)

    planned = client.post(
        f"/api/talking-videos/{created['id']}/shots/plan",
        json={"script": script},
    )

    assert planned.status_code == 200, planned.text
    body = planned.json()
    assert body["script"] == script
    assert [shot["spoken_text"] for shot in body["shots"]] == [
        "今天讲本地部署。",
        "然后看环境准备。",
    ]
    assert [shot["framing"] for shot in body["shots"]] == ["close", "wide"]
    assert [shot["delivery"] for shot in body["shots"]] == [
        "slightly brighter hook",
        "measured tutorial pace",
    ]
    assert [shot["presence"] for shot in body["shots"]] == [
        "forward lean, brighter eyes, one-hand beat",
        "upright, slower nods, hands count the step",
    ]
    assert body["delivery"] == "calm tutorial host, medium pace"
    assert body["presence"] == "seated, relaxed, explaining to camera"
    assert "slightly brighter hook" in body["shots"][0]["render_prompt"]
    assert "forward lean, brighter eyes, one-hand beat" in body["shots"][0]["render_prompt"]
    assert "measured tutorial pace" in body["shots"][1]["render_prompt"]
    assert "upright, slower nods, hands count the step" in body["shots"][1]["render_prompt"]
    assert "seated, relaxed, explaining to camera" not in body["shots"][0]["render_prompt"]
    assert all(shot["status"] == "draft" for shot in body["shots"])
    assert all(shot["clip_asset_id"] is None for shot in body["shots"])
    assert old_shot_id not in {shot["id"] for shot in body["shots"]}
    assert all(4 <= shot["duration_sec"] <= 5 for shot in body["shots"])
    assert all(shot["seed"] is None for shot in body["shots"])
    assert body["min_shot_seconds"] == 4
    assert body["max_shot_seconds"] == 5


def test_comfyui_plan_falls_back_when_model_rewrites_and_rejects_busy(api, monkeypatch):
    client, session_factory, _ = api
    monkeypatch.setenv("COMFYUI_BASE_URL", "http://127.0.0.1:8188")
    role_id, _ = _seed_comfyui(session_factory)
    created = client.post(
        "/api/talking-videos",
        json={"title": "分镜作品", "digital_human_id": role_id},
    ).json()

    async def rewritten(prompt, max_tokens=2048):
        return '[{"text":"改写后的口播","framing":"medium"}]'

    monkeypatch.setattr("llm._call", rewritten)
    rewritten_resp = client.post(
        f"/api/talking-videos/{created['id']}/shots/plan",
        json={"script": "原文一字不改"},
    )
    assert rewritten_resp.status_code == 200, rewritten_resp.text
    assert rewritten_resp.json()["script"] == "原文一字不改"
    assert "".join(
        shot["spoken_text"] for shot in rewritten_resp.json()["shots"]
    ) == "原文一字不改"

    empty = client.post(
        f"/api/talking-videos/{created['id']}/shots/plan",
        json={"script": "   "},
    )
    assert empty.status_code == 422

    saved = client.put(
        f"/api/talking-videos/{created['id']}/shots",
        json={
            "shots": [
                {
                    **created["shots"][0],
                    "spoken_text": "进行中",
                    "status": "running",
                }
            ]
        },
    )
    assert saved.status_code == 200, saved.text
    busy = client.post(
        f"/api/talking-videos/{created['id']}/shots/plan",
        json={"script": "原文一字不改"},
    )
    assert busy.status_code == 409
    assert "正在生成" in busy.json()["detail"]


def test_comfyui_plan_does_not_hold_row_lock_during_llm(api, monkeypatch):
    client, session_factory, _ = api
    monkeypatch.setenv("COMFYUI_BASE_URL", "http://127.0.0.1:8188")
    role_id, _ = _seed_comfyui(session_factory)
    created = client.post(
        "/api/talking-videos",
        json={"title": "分镜作品", "digital_human_id": role_id},
    ).json()
    project_id = created["id"]
    seen = {"unlocked": False}

    async def fake_call(prompt, max_tokens=2048):
        from sqlalchemy import select
        from models import TalkingVideoProject

        async with session_factory() as session:
            row = await session.scalar(
                select(TalkingVideoProject)
                .where(TalkingVideoProject.id == project_id)
                .with_for_update(nowait=True)
            )
            seen["unlocked"] = row is not None
            await session.rollback()
        return '[{"text":"今天讲本地部署。","framing":"close"}]'

    monkeypatch.setattr("llm._call", fake_call)
    planned = client.post(
        f"/api/talking-videos/{project_id}/shots/plan",
        json={"script": "今天讲本地部署。"},
    )
    assert planned.status_code == 200, planned.text
    assert seen["unlocked"] is True


def test_comfyui_render_pending_enqueues_draft_and_failed_shots(api, monkeypatch):
    client, session_factory, _ = api
    monkeypatch.setenv("COMFYUI_BASE_URL", "http://127.0.0.1:8188")
    role_id, _ = _seed_comfyui(session_factory)
    created = client.post(
        "/api/talking-videos",
        json={"title": "分镜作品", "digital_human_id": role_id},
    ).json()
    first = created["shots"][0]
    saved = client.put(
        f"/api/talking-videos/{created['id']}/shots",
        json={
            "shots": [
                {**first, "spoken_text": "第一镜", "status": "draft"},
                {
                    "id": "shot-failed",
                    "duration_sec": 4,
                    "framing": "medium",
                    "spoken_text": "第二镜",
                    "motion_prompt": "",
                    "first_frame_asset_id": None,
                    "clip_asset_id": None,
                    "status": "failed",
                    "job_id": None,
                    "error": "上次失败",
                    "workflow_version": "",
                    "seed": None,
                    "provider_state": {},
                },
                {
                    "id": "shot-ok",
                    "duration_sec": 4,
                    "framing": "medium",
                    "spoken_text": "第三镜",
                    "motion_prompt": "",
                    "first_frame_asset_id": None,
                    "clip_asset_id": 99,
                    "status": "succeeded",
                    "job_id": None,
                    "error": "",
                    "workflow_version": "",
                    "seed": None,
                    "provider_state": {},
                },
            ]
        },
    )
    assert saved.status_code == 200, saved.text

    queued = client.post(
        f"/api/talking-videos/{created['id']}/shots/render-pending",
    )
    assert queued.status_code == 201, queued.text
    by_text = {shot["spoken_text"]: shot for shot in queued.json()["shots"]}
    assert by_text["第一镜"]["status"] == "queued"
    assert by_text["第二镜"]["status"] == "queued"
    assert by_text["第二镜"]["job_id"] is not None
    assert not by_text["第二镜"]["provider_state"].get("auto_queue")
    assert by_text["第三镜"]["status"] == "succeeded"


def test_comfyui_single_shot_success_does_not_start_following_draft(api, monkeypatch):
    client, session_factory, _ = api
    monkeypatch.setenv("COMFYUI_BASE_URL", "http://127.0.0.1:8188")
    role_id, _ = _seed_comfyui(session_factory)
    created = client.post(
        "/api/talking-videos",
        json={"title": "分镜作品", "digital_human_id": role_id},
    ).json()
    first = created["shots"][0]
    saved = client.put(
        f"/api/talking-videos/{created['id']}/shots",
        json={
            "shots": [
                {**first, "spoken_text": "第一镜", "status": "draft"},
                {
                    "id": "shot-two",
                    "duration_sec": 4,
                    "framing": "medium",
                    "spoken_text": "第二镜",
                    "motion_prompt": "",
                    "first_frame_asset_id": None,
                    "clip_asset_id": None,
                    "status": "draft",
                    "job_id": None,
                    "error": "",
                    "workflow_version": "",
                    "seed": None,
                    "provider_state": {},
                },
            ]
        },
    )
    assert saved.status_code == 200, saved.text
    queued = client.post(
        f"/api/talking-videos/{created['id']}/shots/{first['id']}/render",
    )
    assert queued.status_code == 201, queued.text
    shot = queued.json()["shots"][0]
    progressed = client.post(
        f"/api/talking-videos/{created['id']}/shots/{shot['id']}/worker-progress",
        json={"status": "succeeded", "clip_asset_id": 99, "provider_state": {}},
        headers={"X-Content-Job-Id": str(shot["job_id"])},
    )
    assert progressed.status_code == 200, progressed.text
    shots = progressed.json()["shots"]
    assert shots[0]["status"] == "succeeded"
    assert shots[1]["status"] == "draft"
    assert not shots[1]["provider_state"].get("auto_queue")


def test_comfyui_render_enqueues_later_shot_without_previous_clip(api, monkeypatch):
    client, session_factory, _ = api
    monkeypatch.setenv("COMFYUI_BASE_URL", "http://127.0.0.1:8188")
    role_id, _ = _seed_comfyui(session_factory)
    created = client.post(
        "/api/talking-videos",
        json={"title": "分镜作品", "digital_human_id": role_id},
    ).json()
    first = created["shots"][0]
    saved = client.put(
        f"/api/talking-videos/{created['id']}/shots",
        json={
            "shots": [
                {**first, "spoken_text": "第一镜", "status": "draft"},
                {
                    "id": "shot-two",
                    "duration_sec": 4,
                    "framing": "medium",
                    "spoken_text": "第二镜",
                    "motion_prompt": "",
                    "first_frame_asset_id": None,
                    "clip_asset_id": None,
                    "status": "draft",
                    "job_id": None,
                    "error": "",
                    "workflow_version": "",
                    "seed": None,
                    "provider_state": {},
                },
            ]
        },
    )
    assert saved.status_code == 200, saved.text

    queued = client.post(
        f"/api/talking-videos/{created['id']}/shots/shot-two/render",
    )
    assert queued.status_code == 201, queued.text
    shots = queued.json()["shots"]
    assert shots[0]["status"] == "draft"
    assert shots[1]["status"] == "queued"
    assert shots[1]["job_id"] is not None


def test_comfyui_rerender_clears_prompt_id_and_rejects_in_flight(api, monkeypatch):
    client, session_factory, _ = api
    monkeypatch.setenv("COMFYUI_BASE_URL", "http://127.0.0.1:8188")
    role_id, _ = _seed_comfyui(session_factory)
    created = client.post(
        "/api/talking-videos",
        json={"title": "分镜作品", "digital_human_id": role_id},
    ).json()
    shot = created["shots"][0]
    saved = client.put(
        f"/api/talking-videos/{created['id']}/shots",
        json={
            "shots": [
                {
                    **shot,
                    "spoken_text": "今天只讲一件事",
                    "status": "succeeded",
                    "clip_asset_id": 99,
                    "seed": 42,
                    "provider_state": {"prompt_id": "prompt-old", "keep": 1},
                }
            ]
        },
    )
    assert saved.status_code == 200, saved.text

    rerendered = client.post(
        f"/api/talking-videos/{created['id']}/shots/{shot['id']}/render",
    )
    assert rerendered.status_code == 201, rerendered.text
    next_shot = rerendered.json()["shots"][0]
    assert next_shot["status"] == "queued"
    assert next_shot["seed"] == 42
    assert next_shot["provider_state"].get("seed") == 42
    assert next_shot["provider_state"].get("prompt_id") is None
    assert next_shot["provider_state"].get("keep") == 1

    again = client.post(
        f"/api/talking-videos/{created['id']}/shots/{shot['id']}/render",
    )
    assert again.status_code == 409
    assert again.json()["detail"] == "该镜头正在生成"


def test_comfyui_render_shares_seed_across_shots(api, monkeypatch):
    client, session_factory, _ = api
    monkeypatch.setenv("COMFYUI_BASE_URL", "http://127.0.0.1:8188")
    role_id, _ = _seed_comfyui(session_factory)
    created = client.post(
        "/api/talking-videos",
        json={"title": "分镜作品", "digital_human_id": role_id},
    ).json()
    first = created["shots"][0]
    saved = client.put(
        f"/api/talking-videos/{created['id']}/shots",
        json={
            "shots": [
                {**first, "spoken_text": "第一镜", "status": "draft"},
                {
                    "id": "shot-two",
                    "duration_sec": 4,
                    "framing": "medium",
                    "spoken_text": "第二镜",
                    "motion_prompt": "",
                    "first_frame_asset_id": None,
                    "clip_asset_id": None,
                    "status": "draft",
                    "job_id": None,
                    "error": "",
                    "workflow_version": "",
                    "seed": None,
                    "provider_state": {},
                },
            ]
        },
    )
    assert saved.status_code == 200, saved.text

    queued = client.post(
        f"/api/talking-videos/{created['id']}/shots/{first['id']}/render",
    )
    assert queued.status_code == 201, queued.text
    shots = queued.json()["shots"]
    assert shots[0]["seed"] is not None
    assert shots[0]["seed"] == shots[1]["seed"]
    assert shots[1]["provider_state"].get("seed") == shots[0]["seed"]


def test_comfyui_plan_assigns_distinct_performance_when_model_omits_them(api, monkeypatch):
    client, session_factory, _ = api
    monkeypatch.setenv("COMFYUI_BASE_URL", "http://127.0.0.1:8188")
    role_id, _ = _seed_comfyui(session_factory)
    created = client.post(
        "/api/talking-videos",
        json={"title": "分镜作品", "digital_human_id": role_id},
    ).json()
    script = "今天讲本地部署。然后看环境准备。"

    async def fake_call(prompt, max_tokens=2048):
        if "口播语气提炼器" in prompt:
            return json.dumps({
                "delivery": "calm tutorial host, medium pace",
                "presence": "seated, relaxed, explaining to camera",
            })
        if "镜头表演导演" in prompt:
            return json.dumps({
                "shots": [
                    {
                        "delivery": "brighter hook, quicker on-set",
                        "presence": "forward lean, brighter eyes",
                    },
                    {
                        "delivery": "measured tutorial pace",
                        "presence": "upright, slower nods",
                    },
                ]
            })
        return json.dumps({
            "delivery": "calm tutorial host, medium pace",
            "presence": "seated, relaxed, explaining to camera",
            "shots": [
                {"text": "今天讲本地部署。", "framing": "close"},
                {"text": "然后看环境准备。", "framing": "wide"},
            ],
        })

    monkeypatch.setattr("llm._call", fake_call)
    planned = client.post(
        f"/api/talking-videos/{created['id']}/shots/plan",
        json={"script": script},
    )
    assert planned.status_code == 200, planned.text
    shots = planned.json()["shots"]
    assert [shot["delivery"] for shot in shots] == [
        "brighter hook, quicker on-set",
        "measured tutorial pace",
    ]
    assert [shot["presence"] for shot in shots] == [
        "forward lean, brighter eyes",
        "upright, slower nods",
    ]
    assert shots[0]["render_prompt"] != shots[1]["render_prompt"]
    assert "talks with this exact emotion and cadence: brighter hook, quicker on-set" in shots[0]["render_prompt"]


def test_comfyui_plan_resets_seed(api, monkeypatch):
    client, session_factory, _ = api
    monkeypatch.setenv("COMFYUI_BASE_URL", "http://127.0.0.1:8188")
    role_id, _ = _seed_comfyui(session_factory)
    created = client.post(
        "/api/talking-videos",
        json={"title": "分镜作品", "digital_human_id": role_id},
    ).json()
    shot = created["shots"][0]
    saved = client.put(
        f"/api/talking-videos/{created['id']}/shots",
        json={
            "shots": [{
                **shot,
                "spoken_text": "今天讲本地部署。",
                "seed": 42,
                "provider_state": {"seed": 42},
            }]
        },
    )
    assert saved.status_code == 200, saved.text

    async def fake_call(prompt, max_tokens=2048):
        if "口播语气提炼器" in prompt:
            return json.dumps({
                "delivery": "calm tutorial host, medium pace",
                "presence": "seated, relaxed, explaining to camera",
            })
        return json.dumps([{"text": "今天讲本地部署。", "framing": "medium"}])

    monkeypatch.setattr("llm._call", fake_call)
    planned = client.post(
        f"/api/talking-videos/{created['id']}/shots/plan",
        json={"script": "今天讲本地部署。"},
    )
    assert planned.status_code == 200, planned.text
    assert all(item["seed"] is None for item in planned.json()["shots"])
    assert all(
        not (item.get("provider_state") or {}).get("seed")
        for item in planned.json()["shots"]
    )
