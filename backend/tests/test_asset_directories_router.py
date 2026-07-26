import asyncio
import sys

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture
def api(monkeypatch, tmp_path):
    monkeypatch.setenv(
        "WMS_DATABASE_URL",
        f"sqlite+aiosqlite:///{tmp_path / 'asset-directories.db'}",
    )
    for module in list(sys.modules):
        if module.startswith(
            ("database", "models", "routers.assets")
        ):
            sys.modules.pop(module, None)

    from database import Base, SessionLocal, engine, get_db
    import models  # noqa: F401
    import routers.assets as router_module

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
    return TestClient(app), SessionLocal


def _seed_directories(session_factory):
    async def run():
        from models import CreativeAssetDirectory

        async with session_factory() as session:
            system = CreativeAssetDirectory(
                name="数字人资产",
                asset_type="media",
                parent_id=None,
                system_key="digital_human_assets",
            )
            ordinary = CreativeAssetDirectory(
                name="普通目录",
                asset_type="media",
                parent_id=None,
            )
            session.add_all([system, ordinary])
            await session.commit()
            return system.id, ordinary.id

    return asyncio.new_event_loop().run_until_complete(run())


def test_directory_listing_marks_system_directory(api):
    client, session_factory = api
    system_id, ordinary_id = _seed_directories(session_factory)

    response = client.get(
        "/api/assets/directories?asset_type=media"
    )

    assert response.status_code == 200, response.text
    directories = {
        item["id"]: item for item in response.json()
    }
    assert directories[system_id]["is_system"] is True
    assert directories[ordinary_id]["is_system"] is False


def test_system_directory_cannot_be_renamed(api):
    client, session_factory = api
    system_id, _ = _seed_directories(session_factory)

    response = client.patch(
        f"/api/assets/directories/{system_id}",
        json={"name": "改名", "asset_type": "media"},
    )

    assert response.status_code == 409
    assert response.json()["detail"] == "系统目录不能重命名"


def test_system_directory_cannot_be_deleted(api):
    client, session_factory = api
    system_id, _ = _seed_directories(session_factory)

    response = client.delete(
        f"/api/assets/directories/{system_id}"
    )

    assert response.status_code == 409
    assert response.json()["detail"] == "系统目录不能删除"


def test_ordinary_directory_can_still_be_renamed_and_deleted(api):
    client, session_factory = api
    _, ordinary_id = _seed_directories(session_factory)

    renamed = client.patch(
        f"/api/assets/directories/{ordinary_id}",
        json={"name": "普通目录新名称", "asset_type": "media"},
    )
    deleted = client.delete(
        f"/api/assets/directories/{ordinary_id}"
    )

    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["name"] == "普通目录新名称"
    assert deleted.status_code == 204, deleted.text
