import asyncio
import sys

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch, postgres_env):
    for module in list(sys.modules):
        if module.startswith(("database", "models", "config", "routers.settings")):
            sys.modules.pop(module, None)

    from database import Base, SessionLocal, engine, get_db
    import models  # noqa: F401
    import routers.settings as settings_router

    async def setup():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.new_event_loop().run_until_complete(setup())
    app = FastAPI()
    app.include_router(settings_router.router, prefix="/api")

    async def override_db():
        async with SessionLocal() as session:
            yield session

    app.dependency_overrides[get_db] = override_db
    return TestClient(app)


def test_prompt_generation_history_limit_defaults_to_three_and_round_trips(client):
    default = client.get("/api/settings")
    saved = client.put(
        "/api/settings",
        json={"prompt_generation_history_limit": 10},
    )
    fetched = client.get("/api/settings")

    assert default.status_code == 200, default.text
    assert default.json()["prompt_generation_history_limit"] == 3
    assert saved.status_code == 200, saved.text
    assert saved.json()["prompt_generation_history_limit"] == 10
    assert fetched.json()["prompt_generation_history_limit"] == 10


@pytest.mark.parametrize("value", [0, 21, -1])
def test_prompt_generation_history_limit_rejects_out_of_range_values(client, value):
    response = client.put(
        "/api/settings",
        json={"prompt_generation_history_limit": value},
    )

    assert response.status_code == 422
