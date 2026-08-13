import asyncio
import sys

import pytest


@pytest.fixture
def env(monkeypatch, postgres_env):
    for module_name in list(sys.modules):
        if module_name.startswith(("database", "models", "config", "mcp_server")):
            sys.modules.pop(module_name, None)

    from database import Base, engine
    import models

    async def setup():
        async with engine.begin() as connection:
            await connection.run_sync(
                Base.metadata.create_all,
                tables=[
                    models.ArticleDraft.__table__,
                    models.DraftImage.__table__,
                    models.CreativeAsset.__table__,
                ],
            )

    asyncio.run(setup())
    yield
    asyncio.run(engine.dispose())


def test_mcp_registers_image_on_the_requested_draft(env):
    from database import SessionLocal
    from models import ArticleDraft, DraftImage
    import mcp_server

    async def exercise():
        async with SessionLocal() as session:
            draft = ArticleDraft(topic_id="x", title="短帖", draft_type="x")
            session.add(draft)
            await session.commit()
            await session.refresh(draft)
            draft_id = draft.id

        image_id = await mcp_server._register_draft_image(
            draft_id=draft_id,
            filename="generated.png",
            original_name="generated.png",
            url="/api/uploads/generated.png",
            size_bytes=8,
            mime_type="image/png",
        )

        async with SessionLocal() as session:
            image = await session.get(DraftImage, image_id)
            return draft_id, image

    draft_id, image = asyncio.run(exercise())
    assert image is not None
    assert image.draft_id == draft_id


def test_mcp_uploads_an_existing_local_upload_without_an_http_loopback(env, monkeypatch, tmp_path):
    import mcp_server

    uploads = tmp_path / "uploads"
    uploads.mkdir()
    (uploads / "generated.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"x" * 64)
    monkeypatch.setattr(mcp_server, "_UPLOADS_DIR", uploads)
    monkeypatch.setattr(mcp_server, "_BASE_URL", "http://localhost:8000")

    result = asyncio.run(mcp_server.upload_image_from_url(
        "http://localhost:8000/api/uploads/generated.png",
        filename_hint="generated.png",
    ))

    assert result["size_bytes"] == 72
    assert result["content_type"] == "image/png"
    assert result["hosted_url"].startswith("http://localhost:8000/api/uploads/")


def test_mcp_attaches_an_existing_creative_asset_to_a_draft_idempotently(env, monkeypatch, tmp_path):
    from database import SessionLocal
    from models import ArticleDraft, CreativeAsset, DraftImage
    import mcp_server

    uploads = tmp_path / "uploads"
    uploads.mkdir()
    (uploads / "generated.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"x" * 64)
    monkeypatch.setattr(mcp_server, "_UPLOADS_DIR", uploads)
    monkeypatch.setattr(mcp_server, "_BASE_URL", "http://localhost:8000")

    async def exercise():
        async with SessionLocal() as session:
            draft = ArticleDraft(topic_id="x", title="短帖", draft_type="x")
            asset = CreativeAsset(
                asset_type="media", media_kind="image", title="生成图",
                url="/api/uploads/generated.png", media_type="image/png",
                filename="generated.png", source="upload",
            )
            session.add_all([draft, asset])
            await session.commit()
            await session.refresh(draft)
            await session.refresh(asset)
            return draft.id, asset.id

    draft_id, asset_id = asyncio.run(exercise())
    first = asyncio.run(mcp_server.attach_creative_asset_to_draft(draft_id, asset_id))
    second = asyncio.run(mcp_server.attach_creative_asset_to_draft(draft_id, asset_id))

    assert first["draft_image_id"] == second["draft_image_id"]
    assert first["url"] == "/api/uploads/generated.png"
