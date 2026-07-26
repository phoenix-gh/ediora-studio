import asyncio
import sys

import pytest


@pytest.fixture
def session_factory(monkeypatch, tmp_path):
    monkeypatch.setenv(
        "WMS_DATABASE_URL",
        f"sqlite+aiosqlite:///{tmp_path / 'digital-human.db'}",
    )
    for module in list(sys.modules):
        if module.startswith(
            ("database", "models", "content_jobs", "digital_human_service")
        ):
            sys.modules.pop(module, None)

    from database import Base, SessionLocal, engine
    import models  # noqa: F401

    async def setup():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.new_event_loop().run_until_complete(setup())
    return SessionLocal


async def _create_media_assets(session):
    from models import CreativeAsset

    portrait = CreativeAsset(
        asset_type="media",
        media_kind="image",
        title="正面照",
        url="/api/uploads/portrait.png",
        media_type="image/png",
        filename="portrait.png",
    )
    voice = CreativeAsset(
        asset_type="media",
        media_kind="audio",
        title="声音样本",
        url="/api/uploads/voice.wav",
        media_type="audio/wav",
        filename="voice.wav",
    )
    environment = CreativeAsset(
        asset_type="media",
        media_kind="image",
        title="默认环境",
        url="/api/uploads/environment.jpg",
        media_type="image/jpeg",
        filename="environment.jpg",
    )
    session.add_all([portrait, voice, environment])
    await session.commit()
    await session.refresh(portrait)
    await session.refresh(voice)
    await session.refresh(environment)
    return portrait, voice, environment


def test_create_role_and_setup_job_are_committed_together(session_factory):
    async def run():
        from digital_human_service import create_digital_human

        async with session_factory() as session:
            portrait, voice, environment = await _create_media_assets(session)
            role, job = await create_digital_human(
                session,
                name="林晓",
                portrait_asset_id=portrait.id,
                voice_sample_asset_id=voice.id,
                default_environment_asset_id=environment.id,
            )

            assert role.status == "processing"
            assert role.setup_job_id == job.id
            assert job.flow == "digital_human_setup"
            assert job.input_data == {"digital_human_id": role.id}
            assert job.idempotency_key == f"digital-human-setup:{role.id}:1"

    asyncio.new_event_loop().run_until_complete(run())


def test_render_freezes_inputs_and_increments_version(session_factory):
    async def run():
        from digital_human_service import (
            create_digital_human,
            create_render,
            create_talking_project,
        )

        async with session_factory() as session:
            portrait, voice, environment = await _create_media_assets(session)
            role, _ = await create_digital_human(
                session,
                name="林晓",
                portrait_asset_id=portrait.id,
                voice_sample_asset_id=voice.id,
                default_environment_asset_id=environment.id,
            )
            role.status = "ready"
            role.heygen_avatar_id = "avatar-1"
            role.heygen_avatar_group_id = "group-1"
            role.heygen_voice_id = "voice-1"
            await session.commit()

            project = await create_talking_project(
                session,
                title="新品介绍",
                digital_human_id=role.id,
            )
            project.script = "第一版脚本"
            await session.commit()
            first, first_job = await create_render(session, project_id=project.id)

            project.script = "第二版脚本"
            await session.commit()
            second, second_job = await create_render(session, project_id=project.id)

            assert (first.version, first.script_snapshot) == (1, "第一版脚本")
            assert (second.version, second.script_snapshot) == (2, "第二版脚本")
            assert first.digital_human_snapshot == {
                "id": role.id,
                "name": "林晓",
                "heygen_avatar_group_id": "group-1",
                "heygen_avatar_id": "avatar-1",
                "heygen_voice_id": "voice-1",
            }
            assert first.environment_asset_id == environment.id
            assert first.job_id == first_job.id
            assert second.job_id == second_job.id
            assert first_job.input_data == {"render_id": first.id}
            assert second_job.input_data == {"render_id": second.id}

    asyncio.new_event_loop().run_until_complete(run())


def test_role_with_projects_is_archived_instead_of_deleted(session_factory):
    async def run():
        from digital_human_service import (
            DigitalHumanInUse,
            archive_digital_human,
            create_digital_human,
            create_talking_project,
            delete_digital_human,
        )

        async with session_factory() as session:
            portrait, voice, environment = await _create_media_assets(session)
            role, _ = await create_digital_human(
                session,
                name="林晓",
                portrait_asset_id=portrait.id,
                voice_sample_asset_id=voice.id,
                default_environment_asset_id=environment.id,
            )
            role.status = "ready"
            await session.commit()
            await create_talking_project(
                session,
                title="被引用作品",
                digital_human_id=role.id,
            )

            with pytest.raises(DigitalHumanInUse):
                await delete_digital_human(session, role.id)

            archived = await archive_digital_human(session, role.id)
            assert archived.status == "archived"
            assert archived.archived_at is not None

    asyncio.new_event_loop().run_until_complete(run())


def test_only_a_successful_render_from_the_same_project_can_be_selected(
    session_factory,
):
    async def run():
        from digital_human_service import (
            InvalidTalkingVideo,
            create_digital_human,
            create_render,
            create_talking_project,
            select_render,
        )

        async with session_factory() as session:
            portrait, voice, environment = await _create_media_assets(session)
            role, _ = await create_digital_human(
                session,
                name="林晓",
                portrait_asset_id=portrait.id,
                voice_sample_asset_id=voice.id,
                default_environment_asset_id=environment.id,
            )
            role.status = "ready"
            role.heygen_avatar_id = "avatar-1"
            role.heygen_voice_id = "voice-1"
            project = await create_talking_project(
                session,
                title="作品 A",
                digital_human_id=role.id,
            )
            project.script = "准备生成"
            await session.commit()
            render, _ = await create_render(session, project_id=project.id)

            with pytest.raises(InvalidTalkingVideo):
                await select_render(session, project.id, render.id)

            render.status = "succeeded"
            await session.commit()
            selected = await select_render(session, project.id, render.id)
            assert selected.current_render_id == render.id

    asyncio.new_event_loop().run_until_complete(run())
