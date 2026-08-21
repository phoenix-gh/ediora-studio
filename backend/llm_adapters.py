"""Validation, persistence, and runtime resolution for LLM adapters."""

from __future__ import annotations

import json
from typing import Any, Literal
from urllib.parse import urlsplit
from uuid import uuid4

from pydantic import BaseModel, Field, model_validator


ImageResponseFormat = Literal["url", "base64"]
AdapterCapability = Literal["text", "image"]
AdapterProtocol = Literal["openai", "openai-responses"]


class AdapterResolutionError(ValueError):
    """Raised when an adapter cannot satisfy a runtime request."""


def _normalize_headers(headers: dict[str, str] | None) -> dict[str, str]:
    normalized: dict[str, str] = {}
    seen_names: set[str] = set()
    for raw_name, raw_value in (headers or {}).items():
        name = raw_name.strip()
        if not name:
            raise ValueError("自定义 Header 名称不能为空")
        name_key = name.casefold()
        if name_key in seen_names:
            raise ValueError(f"自定义 Header 名称重复：{name}")
        if any(char in name for char in "\r\n"):
            raise ValueError("自定义 Header 名称不能包含换行")
        value = raw_value.strip()
        if any(char in value for char in "\r\n"):
            raise ValueError(f"自定义 Header「{name}」值不能包含换行")
        seen_names.add(name_key)
        normalized[name] = value
    return normalized


class LLMAdapterInput(BaseModel):
    id: str | None = None
    name: str
    protocol: AdapterProtocol = "openai"
    endpoint: str
    model: str
    supports_text: bool = False
    supports_image: bool = False
    image_response_format: ImageResponseFormat = "base64"
    api_key: str | None = None
    clear_api_key: bool = False
    headers: dict[str, str] | None = None

    @model_validator(mode="after")
    def validate_adapter(self) -> "LLMAdapterInput":
        if not self.name.strip():
            raise ValueError("Adapter 名称不能为空")
        if not self.model.strip():
            raise ValueError("Adapter 模型不能为空")
        if not self.supports_text and not self.supports_image:
            raise ValueError("Adapter 至少需要支持文本或图片")
        endpoint = self.endpoint.strip().rstrip("/")
        parsed = urlsplit(endpoint)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("Adapter Endpoint 必须是 HTTP(S) URL")
        self.endpoint = endpoint
        self.name = self.name.strip()
        self.model = self.model.strip()
        if self.id is not None:
            self.id = self.id.strip() or None
        if self.headers is not None:
            self.headers = _normalize_headers(self.headers)
        return self


class LLMAdapterPublic(BaseModel):
    id: str
    name: str
    protocol: AdapterProtocol
    endpoint: str
    model: str
    supports_text: bool
    supports_image: bool
    image_response_format: ImageResponseFormat
    api_key_set: bool
    api_key_preview: str
    headers: dict[str, str] = Field(default_factory=dict)


class ResolvedLLMAdapter(BaseModel):
    adapter_id: str
    name: str
    protocol: AdapterProtocol
    api_key: str
    model: str
    base_url: str
    supports_text: bool
    supports_image: bool
    image_response_format: ImageResponseFormat
    headers: dict[str, str] = Field(default_factory=dict)


def _as_list(raw: str | list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    if isinstance(raw, list):
        return [item for item in raw if isinstance(item, dict)]
    if not raw:
        return []
    try:
        value = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return []
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def parse_stored_adapters(raw: str | list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """Return normalized internal adapter dictionaries, including API keys."""
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in _as_list(raw):
        try:
            parsed = LLMAdapterInput.model_validate(item)
        except ValueError:
            continue
        adapter_id = parsed.id or uuid4().hex
        if adapter_id in seen:
            continue
        seen.add(adapter_id)
        result.append({
            "id": adapter_id,
            "name": parsed.name,
            "protocol": parsed.protocol,
            "endpoint": parsed.endpoint,
            "api_key": str(item.get("api_key") or "").strip(),
            "model": parsed.model,
            "supports_text": parsed.supports_text,
            "supports_image": parsed.supports_image,
            "image_response_format": parsed.image_response_format,
            "headers": parsed.headers or {},
        })
    return result


def _preview(api_key: str) -> str:
    return f"…{api_key[-4:]}" if len(api_key) >= 4 else ""


def public_adapters(raw: str | list[dict[str, Any]] | None) -> list[LLMAdapterPublic]:
    return [LLMAdapterPublic(
        id=item["id"],
        name=item["name"],
        protocol=item["protocol"],
        endpoint=item["endpoint"],
        model=item["model"],
        supports_text=item["supports_text"],
        supports_image=item["supports_image"],
        image_response_format=item["image_response_format"],
        api_key_set=bool(item.get("api_key")),
        api_key_preview=_preview(item.get("api_key", "")),
        headers=dict(item.get("headers") or {}),
    ) for item in parse_stored_adapters(raw)]


def save_adapter_payloads(
    payloads: list[LLMAdapterInput | dict[str, Any]],
    existing: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    existing_by_id = {
        item["id"]: item
        for item in parse_stored_adapters(existing or [])
    }
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for payload in payloads:
        parsed = payload if isinstance(payload, LLMAdapterInput) else LLMAdapterInput.model_validate(payload)
        adapter_id = parsed.id or uuid4().hex
        if adapter_id in seen:
            raise ValueError(f"Adapter ID 重复：{adapter_id}")
        seen.add(adapter_id)
        old = existing_by_id.get(adapter_id, {})
        key = (parsed.api_key or "").strip()
        if parsed.clear_api_key:
            key = ""
        elif not key:
            key = str(old.get("api_key") or "").strip()
        headers = (
            dict(old.get("headers") or {})
            if parsed.headers is None
            else dict(parsed.headers)
        )
        result.append({
            "id": adapter_id,
            "name": parsed.name,
            "protocol": parsed.protocol,
            "endpoint": parsed.endpoint,
            "api_key": key,
            "model": parsed.model,
            "supports_text": parsed.supports_text,
            "supports_image": parsed.supports_image,
            "image_response_format": parsed.image_response_format,
            "headers": headers,
        })
    return result


def configured_default_adapter_id(
    cfg: dict[str, str],
    capability: AdapterCapability,
) -> str:
    """Return the configured default for one capability.

    The old single ``llm_default_adapter_id`` is only read as a migration
    fallback. New settings always use separate text and image defaults.
    """
    key = (
        "llm_image_default_adapter_id"
        if capability == "image"
        else "llm_text_default_adapter_id"
    )
    configured = str(cfg.get(key, "")).strip()
    if configured:
        return configured
    return str(cfg.get("llm_default_adapter_id", "")).strip()


def resolve_test_adapter(
    cfg: dict[str, str],
    payload: LLMAdapterInput,
) -> ResolvedLLMAdapter:
    """Resolve a draft Adapter for a non-persistent settings test."""
    stored_by_id = {
        item["id"]: item
        for item in parse_stored_adapters(cfg.get("llm_adapters"))
    }
    adapter_id = (payload.id or "draft").strip() or "draft"
    stored = stored_by_id.get(adapter_id, {})
    api_key = (payload.api_key or "").strip()
    if payload.clear_api_key:
        api_key = ""
    elif not api_key:
        api_key = str(stored.get("api_key") or "").strip()
    headers = (
        dict(stored.get("headers") or {})
        if payload.headers is None
        else dict(payload.headers)
    )
    if not api_key:
        raise AdapterResolutionError(f"Adapter「{payload.name}」未配置 API Key")
    return ResolvedLLMAdapter(
        adapter_id=adapter_id,
        name=payload.name,
        protocol=payload.protocol,
        api_key=api_key,
        model=payload.model,
        base_url=payload.endpoint,
        supports_text=payload.supports_text,
        supports_image=payload.supports_image,
        image_response_format=payload.image_response_format,
        headers=headers,
    )


def _legacy_adapter(cfg: dict[str, str], capability: AdapterCapability) -> ResolvedLLMAdapter:
    from config import effective_base_url, effective_model

    if capability == "text":
        api_key = str(cfg.get("llm_api_key", "")).strip()
        model = effective_model(cfg)
        base_url = effective_base_url(cfg).strip().rstrip("/")
        adapter_id = "legacy-text"
        name = "旧文本模型配置"
    else:
        api_key = str(cfg.get("image_api_key", "")).strip()
        model = str(cfg.get("image_model", "gpt-image-1")).strip() or "gpt-image-1"
        base_url = str(cfg.get("image_base_url", "")).strip().rstrip("/")
        if not base_url:
            base_url = "https://api.openai.com/v1"
        adapter_id = "legacy-image"
        name = "旧图片模型配置"
    if not api_key:
        capability_label = "文本" if capability == "text" else "图片"
        raise AdapterResolutionError(f"未配置{capability_label}模型 API Key")
    if not model:
        raise AdapterResolutionError("未配置模型")
    return ResolvedLLMAdapter(
        adapter_id=adapter_id,
        name=name,
        protocol="openai",
        api_key=api_key,
        model=model,
        base_url=base_url,
        supports_text=capability == "text",
        supports_image=capability == "image",
        image_response_format="base64",
        headers={},
    )


def resolve_adapter(
    cfg: dict[str, str],
    *,
    adapter_id: str | None = None,
    capability: AdapterCapability,
    purpose: str | None = None,
) -> ResolvedLLMAdapter:
    adapters = parse_stored_adapters(cfg.get("llm_adapters"))
    if not adapters:
        return _legacy_adapter(cfg, capability)

    selected_id = (adapter_id or "").strip()
    if not selected_id and purpose == "information_filtering":
        selected_id = str(cfg.get("llm_information_filtering_adapter_id", "")).strip()
        if not selected_id:
            selected_id = configured_default_adapter_id(cfg, "text")
    if not selected_id:
        selected_id = configured_default_adapter_id(cfg, capability)
    if not selected_id and len(adapters) == 1:
        selected_id = adapters[0]["id"]
    if not selected_id:
        capability_label = "图片" if capability == "image" else "文本"
        raise AdapterResolutionError(f"未配置{capability_label}默认 Adapter")

    selected = next((item for item in adapters if item["id"] == selected_id), None)
    if selected is None:
        raise AdapterResolutionError(f"Adapter 不存在：{selected_id}")
    if not selected.get("api_key"):
        raise AdapterResolutionError(f"Adapter「{selected['name']}」未配置 API Key")
    if capability == "text" and not selected["supports_text"]:
        raise AdapterResolutionError(f"Adapter「{selected['name']}」不支持 text")
    if capability == "image" and not selected["supports_image"]:
        raise AdapterResolutionError(f"Adapter「{selected['name']}」不支持 image")
    return ResolvedLLMAdapter(
        adapter_id=selected["id"],
        name=selected["name"],
        protocol=selected["protocol"],
        api_key=selected["api_key"],
        model=selected["model"],
        base_url=selected["endpoint"],
        supports_text=selected["supports_text"],
        supports_image=selected["supports_image"],
        image_response_format=selected["image_response_format"],
        headers=dict(selected.get("headers") or {}),
    )
