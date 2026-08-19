import json

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
    )]))

    assert item.api_key_set is True
    assert item.api_key_preview == "…1234"
    assert not hasattr(item, "api_key")
    assert item.image_response_format == "url"
    assert item.supports_image is True


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
