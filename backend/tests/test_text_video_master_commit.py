import asyncio

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from tests.test_text_video_master_routes import (
    _assemble,
    _build,
    _seed_confirmed_project,
    master_client,
)


def _saved(asset_id: int = 1):
    return {
        "asset_id": asset_id,
        "audio_url": "/api/uploads/master.mp3",
        "sample_rate": 44100,
        "sample_count": 44100,
        "source_hash": "a" * 64,
        "segment_offsets": [{
            "segment_id": "a",
            "asset_id": 7,
            "source_hash": "b" * 64,
            "sample_offset": 0,
            "sample_count": 44100,
            "sample_rate": 44100,
        }],
        "owns_asset": True,
        "job_id": 10,
        "repair_generation": 0,
    }


@pytest.mark.parametrize("bind_shape", ["static-pool", "connection"])
def test_master_durability_verification_requires_independent_engine(
    tmp_path,
    bind_shape,
):
    from models import Base, CreativeAsset, TextVideoProject
    from text_video_domain import empty_master_audio
    from text_video_master import _durable_master_matches

    async def run():
        url = (
            "sqlite+aiosqlite:///:memory:"
            if bind_shape == "static-pool"
            else f"sqlite+aiosqlite:///{tmp_path / 'connection.db'}"
        )
        engine = create_async_engine(url)
        connection = None
        try:
            async with engine.begin() as setup:
                await setup.run_sync(Base.metadata.create_all)
            saved = _saved()
            master = empty_master_audio() | {
                **saved,
                "status": "ready",
            }
            factory = async_sessionmaker(engine, expire_on_commit=False)
            async with factory() as setup_session:
                setup_session.add_all([
                    CreativeAsset(
                        id=saved["asset_id"],
                        asset_type="media",
                        media_kind="audio",
                        title="文字视频主音频",
                        url=saved["audio_url"],
                        media_type="audio/mpeg",
                        filename="master.mp3",
                        source="generated",
                    ),
                    TextVideoProject(
                        title="verify",
                        master_audio=master,
                    ),
                ])
                await setup_session.commit()
            if bind_shape == "connection":
                connection = await engine.connect()
                bind = connection
            else:
                bind = engine
            verification_factory = async_sessionmaker(
                bind,
                expire_on_commit=False,
            )
            async with verification_factory() as session:
                project = await session.scalar(
                    __import__("sqlalchemy").select(TextVideoProject),
                )
                return await _durable_master_matches(
                    session,
                    project_id=project.id,
                    saved=saved,
                )
        finally:
            if connection is not None:
                await connection.close()
            await engine.dispose()

    assert asyncio.run(run()) is None


def test_master_verifier_returns_false_for_confirmed_rollback_shape(
    tmp_path,
):
    from models import Base, TextVideoProject
    from text_video_master import _durable_master_matches

    async def run():
        engine = create_async_engine(
            f"sqlite+aiosqlite:///{tmp_path / 'independent.db'}",
        )
        try:
            async with engine.begin() as setup:
                await setup.run_sync(Base.metadata.create_all)
            factory = async_sessionmaker(engine, expire_on_commit=False)
            async with factory() as setup_session:
                project = TextVideoProject(title="verify")
                setup_session.add(project)
                await setup_session.commit()
                project_id = project.id
            async with factory() as session:
                return await _durable_master_matches(
                    session,
                    project_id=project_id,
                    saved=_saved(),
                )
        finally:
            await engine.dispose()

    assert asyncio.run(run()) is False


@pytest.mark.parametrize("asset_exists", [True, False])
def test_master_verifier_does_not_accept_replacement_job_state(
    tmp_path,
    asset_exists,
):
    from models import Base, CreativeAsset, TextVideoProject
    from text_video_domain import empty_master_audio
    from text_video_master import _durable_master_matches

    async def run():
        engine = create_async_engine(
            f"sqlite+aiosqlite:///{tmp_path / 'replacement.db'}",
        )
        try:
            async with engine.begin() as setup:
                await setup.run_sync(Base.metadata.create_all)
            saved = _saved()
            replacement = empty_master_audio() | {
                **saved,
                "status": "ready",
                "duration": 1.0,
                "job_id": saved["job_id"] + 1,
            }
            factory = async_sessionmaker(engine, expire_on_commit=False)
            async with factory() as setup_session:
                project = TextVideoProject(
                    title="replacement",
                    master_audio=replacement,
                )
                setup_session.add(project)
                if asset_exists:
                    setup_session.add(CreativeAsset(
                        id=saved["asset_id"],
                        asset_type="media",
                        media_kind="audio",
                        title="文字视频主音频",
                        url=saved["audio_url"],
                        media_type="audio/mpeg",
                        filename="master.mp3",
                        source="generated",
                    ))
                await setup_session.commit()
                project_id = project.id
            async with factory() as session:
                return await _durable_master_matches(
                    session,
                    project_id=project_id,
                    saved=saved,
                )
        finally:
            await engine.dispose()

    assert asyncio.run(run()) is None


def test_unfinished_master_commit_is_retained_and_defers_session_close(
    monkeypatch,
    tmp_path,
):
    import text_video_master

    monkeypatch.setattr(
        text_video_master,
        "MASTER_DB_OPERATION_TIMEOUT_SECONDS",
        0.02,
        raising=False,
    )
    monkeypatch.setattr(
        text_video_master,
        "MASTER_DB_CANCEL_GRACE_SECONDS",
        0.02,
        raising=False,
    )
    release = asyncio.Event()
    started = asyncio.Event()

    class StubbornSession:
        def __init__(self):
            self.info = {}
            self.bind = None

        async def commit(self):
            started.set()
            while not release.is_set():
                try:
                    await release.wait()
                except asyncio.CancelledError:
                    continue

        async def rollback(self):
            raise AssertionError("nonterminal commit must not be rolled back")

    async def run():
        session = StubbornSession()
        owned = tmp_path / "master.mp3"
        owned.write_bytes(b"master")
        request = asyncio.create_task(
            text_video_master._commit_master(
                session,
                project_id=1,
                saved=_saved(),
                owned_path=owned,
            ),
        )
        await started.wait()
        request.cancel()
        try:
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(request, timeout=1.5)
            retained = tuple(
                session.info.get("wms_deferred_session_tasks", set()),
            )
            assert len(retained) == 1
            assert not retained[0].done()
            assert owned.is_file()
        finally:
            release.set()
            commits = [
                task
                for task in asyncio.all_tasks()
                if task is not asyncio.current_task()
                and task.get_name().startswith("text-video-master-commit-")
            ]
            await asyncio.wait_for(
                asyncio.gather(*commits, return_exceptions=True),
                timeout=0.5,
            )

    asyncio.run(run())


def test_precommit_master_flush_failure_removes_owned_file(
    master_client,
    monkeypatch,
):
    from sqlalchemy.ext.asyncio import AsyncSession
    from models import CreativeAsset

    project, _records = _seed_confirmed_project(master_client, [
        {"id": "a", "text": "甲", "seconds": 1.0},
        {"id": "b", "text": "乙", "seconds": 1.0},
    ])
    launch = _build(master_client, project)
    job = launch["jobs"][0]
    original_flush = AsyncSession.flush

    async def fail_master_asset_flush(self, *args, **kwargs):
        if any(
            isinstance(item, CreativeAsset)
            and item.title == "文字视频主音频"
            for item in self.new
        ):
            raise RuntimeError("flush failed")
        return await original_flush(self, *args, **kwargs)

    monkeypatch.setattr(AsyncSession, "flush", fail_master_asset_flush)
    with pytest.raises(RuntimeError, match="flush failed"):
        _assemble(master_client, project["id"], job["id"])

    generated = [
        path
        for path in master_client["uploads"].glob("*.mp3")
        if path.name not in {"a.mp3", "b.mp3"}
    ]
    assert generated == []


def test_master_commit_recovers_durable_write_after_ack_loss(tmp_path):
    from models import Base, CreativeAsset, TextVideoProject
    from text_video_domain import empty_master_audio
    from text_video_master import _commit_master

    async def run():
        engine = create_async_engine(
            f"sqlite+aiosqlite:///{tmp_path / 'ack-loss.db'}",
        )
        owned = tmp_path / "master.mp3"
        owned.write_bytes(b"master")
        try:
            async with engine.begin() as setup:
                await setup.run_sync(Base.metadata.create_all)
            factory = async_sessionmaker(engine, expire_on_commit=False)
            async with factory() as setup_session:
                project = TextVideoProject(title="ack")
                setup_session.add(project)
                await setup_session.commit()
                project_id = project.id
            async with factory() as session:
                project = await session.get(TextVideoProject, project_id)
                asset = CreativeAsset(
                    asset_type="media",
                    media_kind="audio",
                    title="文字视频主音频",
                    url="/api/uploads/master.mp3",
                    media_type="audio/mpeg",
                    filename="master.mp3",
                    source="generated",
                )
                session.add(asset)
                await session.flush()
                saved = _saved(asset.id)
                project.master_audio = empty_master_audio() | {
                    **saved,
                    "status": "ready",
                    "duration": 1.0,
                }
                original_commit = session.commit

                async def commit_then_lose_ack():
                    await original_commit()
                    raise ConnectionError("commit acknowledgement lost")

                session.commit = commit_then_lose_ack
                await _commit_master(
                    session,
                    project_id=project_id,
                    saved=saved,
                    owned_path=owned,
                )
            async with factory() as verification:
                project = await verification.get(
                    TextVideoProject,
                    project_id,
                )
                asset = await verification.get(
                    CreativeAsset,
                    saved["asset_id"],
                )
                return project, asset, owned.is_file()
        finally:
            await engine.dispose()

    project, asset, file_exists = asyncio.run(run())

    assert project.master_audio["asset_id"] == asset.id
    assert file_exists is True


def test_master_commit_deletes_owned_file_only_after_definite_rollback(
    tmp_path,
):
    from models import Base, CreativeAsset, TextVideoProject
    from text_video_domain import empty_master_audio
    from text_video_master import _commit_master

    async def run():
        engine = create_async_engine(
            f"sqlite+aiosqlite:///{tmp_path / 'rollback.db'}",
        )
        owned = tmp_path / "rolled-back.mp3"
        owned.write_bytes(b"master")
        try:
            async with engine.begin() as setup:
                await setup.run_sync(Base.metadata.create_all)
            factory = async_sessionmaker(engine, expire_on_commit=False)
            async with factory() as setup_session:
                project = TextVideoProject(title="rollback")
                setup_session.add(project)
                await setup_session.commit()
                project_id = project.id
            async with factory() as session:
                project = await session.get(TextVideoProject, project_id)
                asset = CreativeAsset(
                    asset_type="media",
                    media_kind="audio",
                    title="文字视频主音频",
                    url="/api/uploads/master.mp3",
                    media_type="audio/mpeg",
                    filename="master.mp3",
                    source="generated",
                )
                session.add(asset)
                await session.flush()
                saved = _saved(asset.id)
                project.master_audio = empty_master_audio() | {
                    **saved,
                    "status": "ready",
                    "duration": 1.0,
                }

                async def fail_before_commit():
                    raise ConnectionError("database unavailable")

                session.commit = fail_before_commit
                with pytest.raises(
                    ConnectionError,
                    match="database unavailable",
                ):
                    await _commit_master(
                        session,
                        project_id=project_id,
                        saved=saved,
                        owned_path=owned,
                    )
            return owned.exists()
        finally:
            await engine.dispose()

    assert asyncio.run(run()) is False


@pytest.mark.parametrize("interruption", ["timeout", "cancel"])
def test_durable_master_commit_never_hides_timeout_or_caller_cancellation(
    tmp_path,
    monkeypatch,
    interruption,
):
    from models import Base, CreativeAsset, TextVideoProject
    from text_video_domain import empty_master_audio
    import text_video_master

    monkeypatch.setattr(
        text_video_master,
        "MASTER_DB_OPERATION_TIMEOUT_SECONDS",
        0.02,
    )
    monkeypatch.setattr(
        text_video_master,
        "MASTER_DB_CANCEL_GRACE_SECONDS",
        0.2,
    )

    async def run():
        engine = create_async_engine(
            f"sqlite+aiosqlite:///{tmp_path / f'{interruption}.db'}",
        )
        owned = tmp_path / f"{interruption}.mp3"
        owned.write_bytes(b"master")
        durable = asyncio.Event()
        try:
            async with engine.begin() as setup:
                await setup.run_sync(Base.metadata.create_all)
            factory = async_sessionmaker(engine, expire_on_commit=False)
            async with factory() as setup_session:
                project = TextVideoProject(title=interruption)
                setup_session.add(project)
                await setup_session.commit()
                project_id = project.id
            async with factory() as session:
                project = await session.get(TextVideoProject, project_id)
                asset = CreativeAsset(
                    asset_type="media",
                    media_kind="audio",
                    title="文字视频主音频",
                    url=f"/api/uploads/{interruption}.mp3",
                    media_type="audio/mpeg",
                    filename=f"{interruption}.mp3",
                    source="generated",
                )
                session.add(asset)
                await session.flush()
                saved = {
                    **_saved(asset.id),
                    "audio_url": asset.url,
                }
                project.master_audio = empty_master_audio() | {
                    **saved,
                    "status": "ready",
                    "duration": 1.0,
                }
                original_commit = session.commit

                async def durable_then_wait():
                    await original_commit()
                    durable.set()
                    try:
                        await asyncio.sleep(60)
                    except asyncio.CancelledError:
                        return

                session.commit = durable_then_wait
                request = asyncio.create_task(
                    text_video_master._commit_master(
                        session,
                        project_id=project_id,
                        saved=saved,
                        owned_path=owned,
                    ),
                )
                if interruption == "cancel":
                    await durable.wait()
                    request.cancel()
                    with pytest.raises(asyncio.CancelledError):
                        await request
                else:
                    with pytest.raises(TimeoutError):
                        await request
            return owned.is_file()
        finally:
            await engine.dispose()

    assert asyncio.run(run()) is True


def test_unknown_master_commit_state_preserves_owned_file(
    tmp_path,
):
    from models import Base, CreativeAsset, TextVideoProject
    from text_video_domain import empty_master_audio
    from text_video_master import _commit_master

    async def run():
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        owned = tmp_path / "unknown.mp3"
        owned.write_bytes(b"master")
        try:
            async with engine.begin() as setup:
                await setup.run_sync(Base.metadata.create_all)
            factory = async_sessionmaker(engine, expire_on_commit=False)
            async with factory() as setup_session:
                project = TextVideoProject(title="unknown")
                setup_session.add(project)
                await setup_session.commit()
                project_id = project.id
            async with factory() as session:
                project = await session.get(TextVideoProject, project_id)
                asset = CreativeAsset(
                    asset_type="media",
                    media_kind="audio",
                    title="文字视频主音频",
                    url="/api/uploads/unknown.mp3",
                    media_type="audio/mpeg",
                    filename="unknown.mp3",
                    source="generated",
                )
                session.add(asset)
                await session.flush()
                saved = {
                    **_saved(asset.id),
                    "audio_url": asset.url,
                }
                project.master_audio = empty_master_audio() | {
                    **saved,
                    "status": "ready",
                    "duration": 1.0,
                }

                async def fail_before_commit():
                    raise ConnectionError("unknown")

                session.commit = fail_before_commit
                with pytest.raises(ConnectionError, match="unknown"):
                    await _commit_master(
                        session,
                        project_id=project_id,
                        saved=saved,
                        owned_path=owned,
                    )
            return owned.is_file()
        finally:
            await engine.dispose()

    assert asyncio.run(run()) is True
