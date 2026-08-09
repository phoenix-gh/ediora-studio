import asyncio
import sys

import pytest


@pytest.fixture
def session_factory(monkeypatch, postgres_env):
    for module in list(sys.modules):
        if module.startswith(("database", "models", "temporary_asset_directory")):
            sys.modules.pop(module, None)

    from database import Base, SessionLocal, engine
    import models  # noqa: F401

    async def setup():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.run(setup())
    return SessionLocal


def test_ensure_temporary_directory_upgrades_same_name_and_is_idempotent(
    session_factory,
):
    async def run():
        from models import CreativeAssetDirectory
        from sqlalchemy import select
        from temporary_asset_directory import ensure_temporary_asset_directory

        async with session_factory() as session:
            existing = CreativeAssetDirectory(
                name="临时文件",
                asset_type="media",
                parent_id=None,
            )
            session.add(existing)
            await session.commit()
            existing_id = existing.id

            first = await ensure_temporary_asset_directory(session)
            second = await ensure_temporary_asset_directory(session)
            await session.commit()

            rows = (
                await session.execute(
                    select(CreativeAssetDirectory).where(
                        CreativeAssetDirectory.system_key == "temporary_files"
                    )
                )
            ).scalars().all()

            assert first.id == existing_id == second.id
            assert first.name == "临时文件"
            assert first.asset_type == "media"
            assert first.system_key == "temporary_files"
            assert len(rows) == 1

    asyncio.run(run())
