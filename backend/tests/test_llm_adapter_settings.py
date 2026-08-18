import asyncio
import sys

import pytest
from fastapi.testclient import TestClient


WORKER_TOKEN = "test-worker-token-at-least-32-chars"


@pytest.fixture
def client(monkeypatch, postgres_env):
    monkeypatch.setenv("WORKER_TOKEN", WORKER_TOKEN)
    for module in list(sys.modules):
        if module.startswith((
            "database",
            "models",
            "main",
            "routers",
            "config",
            "llm_adapters",
            "blog_client",
        )):
            sys.modules.pop(module, None)

    from database import Base, engine
    import models  # noqa: F401

    async def create_schema():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.new_event_loop().run_until_complete(create_schema())

    from main import app

    return TestClient(app)


def _adapter(
    adapter_id: str,
    *,
    key: str = "secret",
    endpoint: str = "https://example.com/v1",
    text: bool = True,
    image: bool = False,
    response_format: str = "base64",
) -> dict:
    return {
        "id": adapter_id,
        "name": adapter_id,
        "protocol": "openai",
        "endpoint": endpoint,
        "api_key": key,
        "model": f"{adapter_id}-model",
        "supports_text": text,
        "supports_image": image,
        "image_response_format": response_format,
    }


def _runtime_headers() -> dict[str, str]:
    return {"X-Worker-Token": WORKER_TOKEN}


def test_settings_persist_multiple_adapters_and_mask_keys(client):
    response = client.put("/api/settings", json={
        "llm_adapters": [_adapter("filter", key="filter-secret")],
        "llm_default_adapter_id": "filter",
        "llm_information_filtering_adapter_id": "filter",
    })

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["llm_adapters"][0]["api_key_set"] is True
    assert body["llm_adapters"][0]["api_key_preview"] == "…cret"
    assert "filter-secret" not in response.text
    assert body["llm_default_adapter_id"] == "filter"
    assert body["llm_information_filtering_adapter_id"] == "filter"

    fetched = client.get("/api/settings")
    assert fetched.status_code == 200
    assert fetched.json()["llm_adapters"][0]["model"] == "filter-model"
    assert "filter-secret" not in fetched.text


def test_blank_adapter_key_preserves_existing_secret_and_clear_removes_it(client):
    client.put("/api/settings", json={"llm_adapters": [_adapter("one", key="keep-me")]})

    preserved = dict(_adapter("one"))
    preserved.pop("api_key")
    response = client.put("/api/settings", json={"llm_adapters": [preserved]})
    assert response.status_code == 200, response.text

    runtime = client.get(
        "/api/settings/ai-runtime?adapter_id=one&capability=text",
        headers=_runtime_headers(),
    )
    assert runtime.status_code == 200, runtime.text
    assert runtime.json()["api_key"] == "keep-me"

    cleared = dict(preserved)
    cleared["clear_api_key"] = True
    response = client.put("/api/settings", json={"llm_adapters": [cleared]})
    assert response.status_code == 200, response.text
    assert client.get(
        "/api/settings/ai-runtime?adapter_id=one&capability=text",
        headers=_runtime_headers(),
    ).status_code == 422


def test_ai_runtime_uses_information_filtering_adapter(client):
    response = client.put("/api/settings", json={
        "llm_adapters": [
            _adapter("default", endpoint="https://default.example/v1"),
            _adapter("filter", endpoint="https://filter.example/v1"),
        ],
        "llm_default_adapter_id": "default",
        "llm_information_filtering_adapter_id": "filter",
    })
    assert response.status_code == 200, response.text

    runtime = client.get(
        "/api/settings/ai-runtime?capability=text&purpose=information_filtering",
        headers=_runtime_headers(),
    )
    assert runtime.status_code == 200, runtime.text
    assert runtime.json()["adapter_id"] == "filter"
    assert runtime.json()["model"] == "filter-model"


def test_settings_reject_invalid_adapter_protocol_endpoint_and_capabilities(client):
    for payload in (
        {**_adapter("bad-protocol"), "protocol": "anthropic"},
        {**_adapter("bad-endpoint"), "endpoint": "not-a-url"},
        {**_adapter("no-capability"), "supports_text": False},
    ):
        response = client.put("/api/settings", json={"llm_adapters": [payload]})
        assert response.status_code == 422, response.text


def test_ai_runtime_is_worker_only(client):
    assert client.get("/api/settings/ai-runtime").status_code == 403
    assert client.get(
        "/api/settings/ai-runtime",
        headers={"X-Worker-Token": "wrong-token"},
    ).status_code == 403
