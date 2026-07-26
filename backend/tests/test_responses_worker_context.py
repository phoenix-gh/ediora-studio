import asyncio
import sys
from datetime import datetime, timezone

from fastapi.testclient import TestClient


def test_worker_context_uses_its_job_run_before_a_current_analysis_exists(
    monkeypatch,
    tmp_path,
):
    monkeypatch.setenv(
        "WMS_DATABASE_URL",
        f"sqlite+aiosqlite:///{tmp_path / 'responses-worker.db'}",
    )
    monkeypatch.setenv("WMS_DISABLE_SCHEDULER", "1")
    monkeypatch.setenv(
        "WMS_WORKER_TOKEN",
        "test-worker-token-at-least-32-chars",
    )
    for name in list(sys.modules):
        if name.startswith(
            ("database", "models", "main", "routers", "content_response")
        ):
            sys.modules.pop(name, None)

    from content_response_service import create_analysis_run, ensure_response_item
    from database import Base, SessionLocal, engine
    from models import YoutubeChannel, YoutubeVideo

    async def setup():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with SessionLocal() as db:
            db.add(YoutubeChannel(id="channel", name="Channel"))
            db.add(YoutubeVideo(
                id="video",
                channel_id="channel",
                channel_name="Channel",
                title="Video",
                url="https://www.youtube.com/watch?v=video",
                published_at=datetime.now(timezone.utc),
            ))
            await db.commit()
            item, _ = await ensure_response_item(db, "youtube_video", "video")
            run, job, _ = await create_analysis_run(db, item)
            assert item.current_analysis_run_id is None
            return item.id, run.id, job.id

    item_id, run_id, job_id = asyncio.run(setup())
    from main import app

    client = TestClient(app)
    response = client.get(
        f"/api/responses/{item_id}/worker-context",
        headers={
            "X-WMS-Worker-Token": "test-worker-token-at-least-32-chars",
            "X-Content-Job-Id": str(job_id),
        },
    )

    assert response.status_code == 200, response.text
    assert response.json()["item"]["analysis"]["id"] == run_id
