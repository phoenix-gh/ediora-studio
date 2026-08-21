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
    headers: dict[str, str] | None = None,
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
        **({"headers": headers} if headers is not None else {}),
    }


def _runtime_headers() -> dict[str, str]:
    return {"X-Worker-Token": WORKER_TOKEN}


def test_settings_persist_multiple_adapters_and_mask_keys(client):
    response = client.put("/api/settings", json={
        "llm_adapters": [_adapter("filter", key="filter-secret")],
        "llm_text_default_adapter_id": "filter",
        "llm_information_filtering_adapter_id": "filter",
    })

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["llm_adapters"][0]["api_key_set"] is True
    assert body["llm_adapters"][0]["api_key_preview"] == "…cret"
    assert "filter-secret" not in response.text
    assert body["llm_text_default_adapter_id"] == "filter"
    assert body["llm_image_default_adapter_id"] == ""
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
        "llm_text_default_adapter_id": "default",
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


def test_settings_persist_adapter_headers_and_expose_them_to_worker(client):
    headers = {
        "X-Tenant": "tenant-a",
        "X-Trace": "trace-123",
    }
    response = client.put("/api/settings", json={
        "llm_adapters": [_adapter("one", headers=headers)],
        "llm_text_default_adapter_id": "one",
    })

    assert response.status_code == 200, response.text
    assert response.json()["llm_adapters"][0]["headers"] == headers
    fetched = client.get("/api/settings")
    assert fetched.json()["llm_adapters"][0]["headers"] == headers

    runtime = client.get(
        "/api/settings/ai-runtime?adapter_id=one&capability=text",
        headers=_runtime_headers(),
    )
    assert runtime.status_code == 200, runtime.text
    assert runtime.json()["headers"] == headers
    assert runtime.json()["image"]["headers"] == {}


def test_ai_runtime_uses_separate_text_and_image_defaults(client):
    response = client.put("/api/settings", json={
        "llm_adapters": [
            _adapter("text", endpoint="https://text.example/v1"),
            _adapter(
                "image",
                endpoint="https://image.example/v1",
                text=False,
                image=True,
            ),
        ],
        "llm_text_default_adapter_id": "text",
        "llm_image_default_adapter_id": "image",
    })
    assert response.status_code == 200, response.text

    text_runtime = client.get(
        "/api/settings/ai-runtime?capability=text",
        headers=_runtime_headers(),
    )
    image_runtime = client.get(
        "/api/settings/ai-runtime?capability=image",
        headers=_runtime_headers(),
    )

    assert text_runtime.status_code == 200, text_runtime.text
    assert image_runtime.status_code == 200, image_runtime.text
    assert text_runtime.json()["adapter_id"] == "text"
    assert image_runtime.json()["adapter_id"] == "image"
    assert image_runtime.json()["image"]["adapter_id"] == "image"


def test_ai_runtime_does_not_fall_back_to_legacy_image_adapter(client):
    response = client.put("/api/settings", json={
        "llm_adapters": [
            _adapter("text"),
            _adapter("image", key="", text=False, image=True),
        ],
        "llm_text_default_adapter_id": "text",
        "llm_image_default_adapter_id": "image",
        "image_api_key": "legacy-image-secret",
    })
    assert response.status_code == 200, response.text

    runtime = client.get(
        "/api/settings/ai-runtime?capability=text",
        headers=_runtime_headers(),
    )

    assert runtime.status_code == 422, runtime.text
    assert "image" in runtime.text
    assert "legacy-image-secret" not in runtime.text


def test_adapter_connection_test_uses_draft_and_saved_key(client, monkeypatch):
    from routers import settings as settings_router

    saved = _adapter("one", key="saved-secret")
    assert client.put("/api/settings", json={"llm_adapters": [saved]}).status_code == 200

    seen = []

    async def fake_test(adapter):
        seen.append(adapter)
        return "连接成功"

    monkeypatch.setattr(settings_router, "_test_openai_adapter", fake_test, raising=False)
    draft = _adapter("one", key="")
    draft["model"] = "draft-model"
    response = client.post("/api/settings/test-adapter", json={"adapter": draft})

    assert response.status_code == 200, response.text
    assert response.json() == {"ok": True, "response": "连接成功"}
    assert seen[0].api_key == "saved-secret"
    assert seen[0].model == "draft-model"


def test_adapter_connection_test_uses_draft_headers(client, monkeypatch):
    from routers import settings as settings_router

    seen = []

    async def fake_test(adapter):
        seen.append(adapter)
        return "连接成功"

    monkeypatch.setattr(settings_router, "_test_openai_adapter", fake_test, raising=False)
    draft = _adapter("one", headers={"X-Tenant": "tenant-a"})
    response = client.post("/api/settings/test-adapter", json={"adapter": draft})

    assert response.status_code == 200, response.text
    assert seen[0].headers == {"X-Tenant": "tenant-a"}


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
