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
                tables=[models.ArticleDraft.__table__, models.DraftImage.__table__],
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
