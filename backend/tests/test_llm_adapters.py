import json
from types import SimpleNamespace

import pytest

from llm_adapters import (
    AdapterResolutionError,
    LLMAdapterInput,
    public_adapters,
    resolve_adapter,
    save_adapter_payloads,
)


def _adapter(
    adapter_id: str,
    *,
    text: bool = True,
    image: bool = False,
    response_format: str = "base64",
    key: str = "secret",
    model: str = "model",
    endpoint: str = "https://example.com/v1",
    headers: dict[str, str] | None = None,
) -> dict:
    return {
        "id": adapter_id,
        "name": adapter_id,
        "protocol": "openai",
        "endpoint": endpoint,
        "api_key": key,
        "model": model,
        "supports_text": text,
        "supports_image": image,
        "image_response_format": response_format,
        **({"headers": headers} if headers is not None else {}),
    }


def test_resolve_information_filtering_prefers_its_adapter_over_text_default():
    cfg = {
        "llm_adapters": json.dumps([
            _adapter("default", endpoint="https://default.example/v1"),
            _adapter("filter", endpoint="https://filter.example/v1", model="filter-model"),
        ]),
        "llm_text_default_adapter_id": "default",
        "llm_information_filtering_adapter_id": "filter",
    }

    resolved = resolve_adapter(cfg, purpose="information_filtering", capability="text")

    assert resolved.adapter_id == "filter"
    assert resolved.base_url == "https://filter.example/v1"
    assert resolved.model == "filter-model"


def test_resolve_explicit_adapter_precedes_information_filtering_setting():
    cfg = {
        "llm_adapters": json.dumps([
            _adapter("default"),
            _adapter("filter"),
            _adapter("subscription"),
        ]),
        "llm_text_default_adapter_id": "default",
        "llm_information_filtering_adapter_id": "filter",
    }

    resolved = resolve_adapter(
        cfg,
        adapter_id="subscription",
        purpose="information_filtering",
        capability="text",
    )

    assert resolved.adapter_id == "subscription"


def test_resolve_text_and_image_use_separate_default_adapters():
    cfg = {
        "llm_adapters": json.dumps([
            _adapter("text", endpoint="https://text.example/v1", model="text-model"),
            _adapter(
                "image",
                endpoint="https://image.example/v1",
                model="image-model",
                text=False,
                image=True,
            ),
            _adapter(
                "filter",
                endpoint="https://filter.example/v1",
                model="filter-model",
            ),
        ]),
        "llm_text_default_adapter_id": "text",
        "llm_image_default_adapter_id": "image",
        "llm_information_filtering_adapter_id": "filter",
    }

    text = resolve_adapter(cfg, capability="text")
    image = resolve_adapter(cfg, capability="image")
    filtering = resolve_adapter(
        cfg,
        capability="text",
        purpose="information_filtering",
    )

    assert text.adapter_id == "text"
    assert image.adapter_id == "image"
    assert filtering.adapter_id == "filter"


def test_resolve_information_filtering_falls_back_to_text_default():
    cfg = {
        "llm_adapters": json.dumps([_adapter("text")]),
        "llm_text_default_adapter_id": "text",
        "llm_information_filtering_adapter_id": "",
    }

    resolved = resolve_adapter(
        cfg,
        capability="text",
        purpose="information_filtering",
    )

    assert resolved.adapter_id == "text"


def test_resolve_rejects_adapter_without_requested_capability():
    cfg = {"llm_adapters": json.dumps([_adapter("text-only", image=False)])}

    with pytest.raises(AdapterResolutionError, match="不支持 image"):
        resolve_adapter(cfg, adapter_id="text-only", capability="image")


def test_public_adapters_mask_api_keys_and_preserve_capabilities():
    [item] = public_adapters(json.dumps([_adapter(
        "one",
        image=True,
        response_format="url",
        key="secret-1234",
        headers={"X-Gateway": "tenant-a"},
    )]))

    assert item.api_key_set is True
    assert item.api_key_preview == "…1234"
    assert not hasattr(item, "api_key")
    assert item.image_response_format == "url"
    assert item.supports_image is True
    assert item.headers == {"X-Gateway": "tenant-a"}


def test_resolve_legacy_text_configuration_when_no_adapters_are_saved():
    resolved = resolve_adapter({
        "llm_provider": "openai",
        "llm_model": "legacy-model",
        "llm_base_url": "https://legacy.example/v1",
        "llm_api_key": "legacy-key",
    }, capability="text")

    assert resolved.adapter_id == "legacy-text"
    assert resolved.model == "legacy-model"
    assert resolved.base_url == "https://legacy.example/v1"
    assert resolved.api_key == "legacy-key"


def test_save_adapter_payloads_preserves_blank_key_and_supports_explicit_clear():
    existing = [_adapter("one", key="keep-me")]

    preserved = save_adapter_payloads([LLMAdapterInput(
        id="one",
        name="更新名称",
        endpoint="https://example.com/v1/",
        model="updated-model",
        supports_text=True,
    )], existing)
    assert preserved[0]["api_key"] == "keep-me"
    assert preserved[0]["endpoint"] == "https://example.com/v1"

    cleared = save_adapter_payloads([LLMAdapterInput(
        id="one",
        name="更新名称",
        endpoint="https://example.com/v1",
        model="updated-model",
        supports_text=True,
        clear_api_key=True,
    )], preserved)
    assert cleared[0]["api_key"] == ""


def test_adapter_headers_are_normalized_persisted_and_resolved():
    payload = LLMAdapterInput(
        id="one",
        name="带 Header 的 Adapter",
        endpoint="https://example.com/v1",
        model="updated-model",
        supports_text=True,
        api_key="secret",
        headers={" X-Tenant ": " tenant-a ", "X-Trace": "trace-123"},
    )

    saved = save_adapter_payloads([payload])
    assert saved[0]["headers"] == {
        "X-Tenant": "tenant-a",
        "X-Trace": "trace-123",
    }

    resolved = resolve_adapter(
        {"llm_adapters": json.dumps(saved)},
        adapter_id="one",
        capability="text",
    )
    assert resolved.headers == saved[0]["headers"]


@pytest.mark.asyncio
async def test_adapter_connection_passes_custom_headers_to_openai_client(monkeypatch):
    from routers import settings as settings_router
    from llm_adapters import ResolvedLLMAdapter

    seen: dict[str, object] = {}

    class FakeCompletions:
        async def create(self, **kwargs):
            seen["request"] = kwargs
            return SimpleNamespace(
                choices=[SimpleNamespace(message=SimpleNamespace(content="OK"))],
            )

    class FakeClient:
        def __init__(self, **kwargs):
            seen["client"] = kwargs
            self.chat = SimpleNamespace(completions=FakeCompletions())

    monkeypatch.setattr("openai.AsyncOpenAI", FakeClient)
    adapter = ResolvedLLMAdapter(
        adapter_id="one",
        name="one",
        protocol="openai",
        api_key="secret",
        model="model",
        base_url="https://example.com/v1",
        supports_text=True,
        supports_image=False,
        image_response_format="base64",
        headers={"X-Tenant": "tenant-a"},
    )

    assert await settings_router._test_openai_adapter(adapter) == "OK"
    assert seen["client"] == {
        "api_key": "secret",
        "base_url": "https://example.com/v1",
        "default_headers": {"X-Tenant": "tenant-a"},
    }


@pytest.mark.asyncio
async def test_image_adapter_connection_passes_custom_headers_to_model_listing(monkeypatch):
    from routers import settings as settings_router
    from llm_adapters import ResolvedLLMAdapter

    seen: dict[str, object] = {}

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {"data": [{"id": "image-model"}]}

    class FakeClient:
        def __init__(self, **kwargs):
            seen["client"] = kwargs

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        async def get(self, url, *, headers):
            seen["request"] = {"url": url, "headers": headers}
            return FakeResponse()

    monkeypatch.setattr(settings_router.httpx, "AsyncClient", FakeClient)
    adapter = ResolvedLLMAdapter(
        adapter_id="images",
        name="images",
        protocol="openai",
        api_key="secret",
        model="image-model",
        base_url="https://example.com/v1",
        supports_text=False,
        supports_image=True,
        image_response_format="base64",
        headers={"X-Tenant": "tenant-a"},
    )

    assert await settings_router._test_openai_adapter(adapter) == "图片接口连接成功"
    assert seen["request"] == {
        "url": "https://example.com/v1/models",
        "headers": {
            "Authorization": "Bearer secret",
            "X-Tenant": "tenant-a",
        },
    }
