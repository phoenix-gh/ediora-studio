import asyncio
import sys

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch, postgres_env):
    monkeypatch.setenv("WORKER_TOKEN", "test-worker-token-at-least-32-chars")
    for module in list(sys.modules):
        if module.startswith(("database", "models", "main", "routers", "config")):
            sys.modules.pop(module, None)

    from database import Base, engine
    import models  # noqa: F401

    async def setup():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.new_event_loop().run_until_complete(setup())
    from main import app
    return TestClient(app)


def test_codex_model_defaults_and_roundtrips(client):
    current = client.get("/api/settings")
    assert current.status_code == 200
    assert current.json()["codex_model"] == "proxy/deepseek-v4-flash"
    assert current.json()["codex_reasoning_effort"] == "medium"

    saved = client.put("/api/settings", json={
        "codex_model": "proxy/custom-model",
        "codex_reasoning_effort": "high",
    })
    assert saved.status_code == 200, saved.text
    assert saved.json()["codex_model"] == "proxy/custom-model"
    assert saved.json()["codex_reasoning_effort"] == "high"

    again = client.get("/api/settings")
    assert again.json()["codex_model"] == "proxy/custom-model"
    assert again.json()["codex_reasoning_effort"] == "high"


def test_codex_model_rejects_blank_slash_and_unsupported_ids(client):
    for model in ("", "  ", "proxy/", "/gpt", "bad model", "a" * 201, "deepseek-flash", "proxy/deepseek-flash"):
        rejected = client.put("/api/settings", json={"codex_model": model})
        assert rejected.status_code == 422, model
    assert client.get("/api/settings").json()["codex_model"] == "proxy/deepseek-v4-flash"


def test_codex_reasoning_effort_rejects_blank_and_spaced_values(client):
    for effort in ("", "  ", "bad effort", "a" * 65):
        rejected = client.put("/api/settings", json={"codex_reasoning_effort": effort})
        assert rejected.status_code == 422, effort
    assert client.get("/api/settings").json()["codex_reasoning_effort"] == "medium"
