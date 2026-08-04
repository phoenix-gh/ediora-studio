import asyncio
import sys
from datetime import datetime, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv(
        "WMS_DATABASE_URL",
        f"sqlite+aiosqlite:///{tmp_path / 'drafts-router.db'}",
    )
    for module in list(sys.modules):
        if module.startswith(("database", "models", "routers.drafts")):
            sys.modules.pop(module, None)

    from database import Base, SessionLocal, engine, get_db
    import models
    import routers.drafts as drafts_module
    monkeypatch.setattr(drafts_module, "_UPLOADS_DIR", str(tmp_path / "uploads"))

    async def setup():
        async with engine.begin() as connection:
            await connection.run_sync(
                Base.metadata.create_all,
                tables=[
                    models.ArticleDraft.__table__,
                    models.DraftImage.__table__,
                    models.DailyCreationRun.__table__,
                    models.DailyCreationOutputBatch.__table__,
                    models.ContentUsageLedger.__table__,
                ],
            )

    asyncio.new_event_loop().run_until_complete(setup())
    app = FastAPI()
    app.include_router(drafts_module.router, prefix="/api")

    async def override_db():
        async with SessionLocal() as session:
            yield session

    app.dependency_overrides[get_db] = override_db
    app.state.session_local = SessionLocal
    return TestClient(app)


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def test_draft_images_belong_only_to_the_selected_draft(client):
    article = client.post(
        "/api/write/drafts",
        json={"topic_id": "article", "title": "文章", "draft_type": "article"},
    )
    x_draft = client.post(
        "/api/write/drafts",
        json={"topic_id": "x", "title": "短帖", "draft_type": "x"},
    )

    assert article.status_code == 201
    assert x_draft.status_code == 201
    assert "linked_draft_id" not in article.json()
    assert "linked_draft_id" not in x_draft.json()

    upload = client.post(
        f"/api/write/drafts/{x_draft.json()['id']}/images",
        files={"file": ("card.png", b"\x89PNG\r\n\x1a\n", "image/png")},
    )

    assert upload.status_code == 201
    assert client.get(
        f"/api/write/drafts/{article.json()['id']}/images"
    ).json() == []
    x_images = client.get(
        f"/api/write/drafts/{x_draft.json()['id']}/images"
    ).json()
    assert [image["id"] for image in x_images] == [upload.json()["id"]]


def test_delete_daily_creation_draft_releases_only_its_draft_usage(client):
    from models import (
        ArticleDraft,
        ContentUsageLedger,
        DailyCreationOutputBatch,
        DailyCreationRun,
    )

    async def seed():
        async with client.app.state.session_local() as session:
            draft = ArticleDraft(
                topic_id="daily-creation:1",
                title="待删除短帖",
                content="短帖正文",
                draft_type="x",
            )
            run = DailyCreationRun(
                rule_id=11,
                scheduled_for=datetime(2026, 8, 4, tzinfo=timezone.utc),
                trigger_kind="scheduled",
                status="succeeded",
                requested_count=1,
                created_count=1,
            )
            session.add_all([draft, run])
            await session.flush()
            draft_usage = ContentUsageLedger(
                run_id=run.id,
                rule_id=11,
                creative_asset_id=101,
                output_type="x_short_post",
                output_kind="draft",
                output_id=draft.id,
                draft_id=draft.id,
            )
            other_kind_usage = ContentUsageLedger(
                run_id=run.id,
                rule_id=11,
                creative_asset_id=102,
                output_type="x_short_post",
                output_kind="plan_item",
                output_id=draft.id,
                draft_id=draft.id,
            )
            batch = DailyCreationOutputBatch(
                run_id=run.id,
                execution_id=21,
                idempotency_key="delete-release-test",
                input_hash="hash",
                output_ids=[draft.id],
                draft_ids=[draft.id],
                usage_ids=[],
                created_count=1,
            )
            session.add_all([draft_usage, other_kind_usage, batch])
            await session.commit()
            await session.refresh(draft_usage)
            await session.refresh(other_kind_usage)
            await session.refresh(batch)
            return (
                draft.id,
                draft_usage.id,
                other_kind_usage.id,
                run.id,
                batch.id,
            )

    draft_id, usage_id, other_usage_id, run_id, batch_id = _run(seed())

    response = client.delete(f"/api/write/drafts/{draft_id}")

    assert response.status_code == 204

    async def inspect():
        async with client.app.state.session_local() as session:
            return (
                await session.get(ArticleDraft, draft_id),
                await session.get(ContentUsageLedger, usage_id),
                await session.get(ContentUsageLedger, other_usage_id),
                await session.get(DailyCreationRun, run_id),
                await session.get(DailyCreationOutputBatch, batch_id),
            )

    draft, usage, other_usage, run, batch = _run(inspect())
    assert draft is None
    assert usage is None
    assert other_usage is not None
    assert run is not None
    assert batch is not None


def test_delete_normal_draft_preserves_unrelated_daily_creation_usage(client):
    from models import ArticleDraft, ContentUsageLedger

    async def seed():
        async with client.app.state.session_local() as session:
            normal_draft = ArticleDraft(topic_id="manual", title="普通草稿")
            generated_draft = ArticleDraft(
                topic_id="daily-creation:2",
                title="另一条任务草稿",
                draft_type="x",
            )
            session.add_all([normal_draft, generated_draft])
            await session.flush()
            usage = ContentUsageLedger(
                run_id=2,
                rule_id=12,
                creative_asset_id=201,
                output_type="x_short_post",
                output_kind="draft",
                output_id=generated_draft.id,
                draft_id=generated_draft.id,
            )
            session.add(usage)
            await session.commit()
            await session.refresh(usage)
            return normal_draft.id, usage.id

    draft_id, usage_id = _run(seed())

    response = client.delete(f"/api/write/drafts/{draft_id}")

    assert response.status_code == 204

    async def inspect():
        async with client.app.state.session_local() as session:
            return (
                await session.get(ArticleDraft, draft_id),
                await session.get(ContentUsageLedger, usage_id),
            )

    draft, usage = _run(inspect())
    assert draft is None
    assert usage is not None
