import asyncio
import sys

import pytest


@pytest.fixture
def session_factory(monkeypatch, postgres_env):
    for module in list(sys.modules):
        if module.startswith(
            ("database", "models", "digital_human_assets")
        ):
            sys.modules.pop(module, None)

    from database import Base, SessionLocal, engine
    import models  # noqa: F401

    async def setup():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.new_event_loop().run_until_complete(setup())
    return SessionLocal


def test_ensure_directory_upgrades_same_name_and_is_idempotent(
    session_factory,
):
    async def run():
        from digital_human_assets import (
            ensure_digital_human_asset_directory,
        )
        from models import CreativeAssetDirectory
        from sqlalchemy import select

        async with session_factory() as session:
            existing = CreativeAssetDirectory(
                name="数字人资产",
                asset_type="media",
                parent_id=None,
            )
            session.add(existing)
            await session.commit()
            existing_id = existing.id

            first = await ensure_digital_human_asset_directory(session)
            second = await ensure_digital_human_asset_directory(session)
            await session.commit()

            rows = (
                await session.execute(
                    select(CreativeAssetDirectory).where(
                        CreativeAssetDirectory.system_key
                        == "digital_human_assets"
                    )
                )
            ).scalars().all()
            assert first.id == existing_id == second.id
            assert first.system_key == "digital_human_assets"
            assert len(rows) == 1

    asyncio.new_event_loop().run_until_complete(run())


def test_backfill_archives_existing_digital_human_assets(session_factory):
    async def run():
        from digital_human_assets import backfill_digital_human_assets
        from models import (
            CreativeAsset,
            DigitalHuman,
            TalkingVideoProject,
            TalkingVideoRender,
        )
        from sqlalchemy import select

        def media(
            title: str,
            kind: str = "image",
            media_type: str = "image/png",
        ):
            return CreativeAsset(
                asset_type="media",
                media_kind=kind,
                title=title,
                url=f"/api/uploads/{title}",
                media_type=media_type,
                filename=title,
            )

        async with session_factory() as session:
            portrait = media("portrait.png")
            voice = media("voice.wav", "audio", "audio/wav")
            default_environment = media("default.png")
            override_environment = media("override.png")
            render_environment = media("render.png")
            video = media("result.mp4", "video", "video/mp4")
            unrelated = media("unrelated.png")
            session.add_all(
                [
                    portrait,
                    voice,
                    default_environment,
                    override_environment,
                    render_environment,
                    video,
                    unrelated,
                ]
            )
            await session.flush()
            role = DigitalHuman(
                name="林晓",
                status="ready",
                portrait_asset_id=portrait.id,
                voice_sample_asset_id=voice.id,
                default_environment_asset_id=default_environment.id,
            )
            session.add(role)
            await session.flush()
            project = TalkingVideoProject(
                title="测试作品",
                digital_human_id=role.id,
                environment_asset_id=override_environment.id,
            )
            session.add(project)
            await session.flush()
            session.add(
                TalkingVideoRender(
                    project_id=project.id,
                    version=1,
                    status="succeeded",
                    script_snapshot="测试脚本",
                    environment_asset_id=render_environment.id,
                    video_asset_id=video.id,
                )
            )
            await session.commit()

            await backfill_digital_human_assets(session)
            await session.commit()

            archived_ids = {
                portrait.id,
                voice.id,
                default_environment.id,
                override_environment.id,
                render_environment.id,
                video.id,
            }
            archived = (
                await session.execute(
                    select(CreativeAsset).where(
                        CreativeAsset.id.in_(archived_ids)
                    )
                )
            ).scalars().all()
            untouched = await session.get(CreativeAsset, unrelated.id)
            assert {
                asset.directory for asset in archived
            } == {"数字人资产"}
            assert untouched is not None
            assert untouched.directory == ""

    asyncio.new_event_loop().run_until_complete(run())
