from __future__ import annotations

from copy import deepcopy
import re
from typing import Any


_HEX_COLOR = re.compile(r"^#[0-9A-Fa-f]{6}$")


TEXT_VIDEO_TEMPLATES: dict[tuple[str, int], dict[str, Any]] = {
    ("tech-text-v1", 1): {
        "id": "tech-text-v1",
        "version": 1,
        "composition_id": "tech-text-v1",
        "default_composition": {"width": 1080, "height": 1920, "fps": 30},
        "aspect_ratios": ["9:16", "16:9", "1:1"],
        "animations": ["fade-up", "scale"],
        "transitions": ["soft-push"],
        "template_props": {
            "theme": {"type": "literal", "value": "tech-blue"},
            "font": {"type": "literal", "value": "source-han-sans"},
            "background": {
                "type": "enum",
                "values": ["dark-grid", "deep-space", "clean-gradient"],
            },
            "transition": {"type": "literal", "value": "soft-push"},
            "textDensity": {
                "type": "enum",
                "values": ["compact", "standard", "spacious"],
            },
            "brandTitle": {"type": "string", "maxLength": 32},
            "brandSubtitle": {"type": "string", "maxLength": 32},
            "showBrand": {"type": "boolean"},
            "accentColor": {"type": "color"},
            "showProgress": {"type": "boolean"},
            "showSceneNumber": {"type": "boolean"},
        },
        "defaults": {
            "theme": "tech-blue",
            "font": "source-han-sans",
            "background": "dark-grid",
            "transition": "soft-push",
            "textDensity": "standard",
            "brandTitle": "EDIORA",
            "brandSubtitle": "述策",
            "showBrand": True,
            "accentColor": "#69F6FF",
            "showProgress": True,
            "showSceneNumber": True,
        },
    },
    ("kinetic-punch-v1", 1): {
        "id": "kinetic-punch-v1",
        "version": 1,
        "composition_id": "kinetic-punch-v1",
        "default_composition": {"width": 1080, "height": 1920, "fps": 30},
        "aspect_ratios": ["9:16", "16:9", "1:1"],
        "animations": ["scale", "fade-up"],
        "transitions": ["cut"],
        "template_props": {
            "style": {"type": "literal", "value": "kinetic-punch"},
            "palette": {
                "type": "enum",
                "values": ["night", "light", "warm"],
            },
            "brandTitle": {"type": "string", "maxLength": 32},
            "showBrand": {"type": "boolean"},
            "accentColor": {"type": "color"},
            "showProgress": {"type": "boolean"},
        },
        "defaults": {
            "style": "kinetic-punch",
            "palette": "night",
            "brandTitle": "EDIORA",
            "showBrand": True,
            "accentColor": "#D8FF3E",
            "showProgress": True,
        },
    },
    ("caption-focus-v1", 1): {
        "id": "caption-focus-v1",
        "version": 1,
        "composition_id": "caption-focus-v1",
        "default_composition": {"width": 1080, "height": 1920, "fps": 30},
        "aspect_ratios": ["9:16", "16:9", "1:1"],
        "animations": ["fade-up", "scale"],
        "transitions": ["cut"],
        "template_props": {
            "style": {"type": "literal", "value": "caption-focus"},
            "palette": {
                "type": "enum",
                "values": ["night", "light", "warm"],
            },
            "brandTitle": {"type": "string", "maxLength": 32},
            "showBrand": {"type": "boolean"},
            "accentColor": {"type": "color"},
            "showProgress": {"type": "boolean"},
        },
        "defaults": {
            "style": "caption-focus",
            "palette": "night",
            "brandTitle": "EDIORA",
            "showBrand": True,
            "accentColor": "#FF4D8D",
            "showProgress": True,
        },
    },
    ("editorial-card-v1", 1): {
        "id": "editorial-card-v1",
        "version": 1,
        "composition_id": "editorial-card-v1",
        "default_composition": {"width": 1080, "height": 1920, "fps": 30},
        "aspect_ratios": ["9:16", "16:9", "1:1"],
        "animations": ["fade-up", "scale"],
        "transitions": ["cut"],
        "template_props": {
            "style": {"type": "literal", "value": "editorial-card"},
            "palette": {
                "type": "enum",
                "values": ["night", "light", "warm"],
            },
            "brandTitle": {"type": "string", "maxLength": 32},
            "showBrand": {"type": "boolean"},
            "accentColor": {"type": "color"},
            "showProgress": {"type": "boolean"},
        },
        "defaults": {
            "style": "editorial-card",
            "palette": "light",
            "brandTitle": "EDIORA JOURNAL",
            "showBrand": True,
            "accentColor": "#D14B32",
            "showProgress": True,
        },
    },
    ("voice-pulse-v1", 1): {
        "id": "voice-pulse-v1",
        "version": 1,
        "composition_id": "voice-pulse-v1",
        "default_composition": {"width": 1080, "height": 1920, "fps": 30},
        "aspect_ratios": ["9:16", "16:9", "1:1"],
        "animations": ["scale", "fade-up"],
        "transitions": ["cut"],
        "template_props": {
            "style": {"type": "literal", "value": "voice-pulse"},
            "palette": {
                "type": "enum",
                "values": ["night", "light", "warm"],
            },
            "brandTitle": {"type": "string", "maxLength": 32},
            "showBrand": {"type": "boolean"},
            "accentColor": {"type": "color"},
            "showProgress": {"type": "boolean"},
        },
        "defaults": {
            "style": "voice-pulse",
            "palette": "warm",
            "brandTitle": "EDIORA VOICE",
            "showBrand": True,
            "accentColor": "#7C5CFF",
            "showProgress": True,
        },
    },
}


def _template_prop_error(field: str, value: object) -> ValueError:
    return ValueError(f"当前模板不支持参数 {field}={value}")


def _normalize_text_video_template_prop(
    field: str,
    descriptor: object,
    value: object,
) -> Any:
    if not isinstance(descriptor, dict):
        raise ValueError(f"模板参数定义无效：{field}")
    descriptor_type = descriptor.get("type")
    if descriptor_type == "literal":
        if value != descriptor.get("value"):
            raise _template_prop_error(field, value)
        return deepcopy(value)
    if descriptor_type == "enum":
        allowed_values = descriptor.get("values")
        if (
            not isinstance(value, str)
            or not isinstance(allowed_values, list)
            or value not in allowed_values
        ):
            raise _template_prop_error(field, value)
        return value
    if descriptor_type == "string":
        max_length = descriptor.get("maxLength")
        if (
            not isinstance(value, str)
            or not isinstance(max_length, int)
            or isinstance(max_length, bool)
        ):
            raise _template_prop_error(field, value)
        normalized = value.strip()
        if len(normalized) > max_length:
            raise _template_prop_error(field, value)
        return normalized
    if descriptor_type == "boolean":
        if not isinstance(value, bool):
            raise _template_prop_error(field, value)
        return value
    if descriptor_type == "color":
        if not isinstance(value, str) or _HEX_COLOR.fullmatch(value) is None:
            raise _template_prop_error(field, value)
        return value.upper()
    raise ValueError(f"模板参数定义无效：{field}")


def normalize_text_video_template_props(
    manifest: dict[str, Any],
    value: object,
    *,
    fill_missing: bool,
) -> dict[str, Any]:
    """Validate a template prop snapshot and return it in manifest order."""
    capabilities = manifest.get("template_props")
    defaults = manifest.get("defaults")
    if not isinstance(capabilities, dict) or not isinstance(defaults, dict):
        raise ValueError("模板参数定义无效")
    if not isinstance(value, dict):
        raise ValueError("模板参数必须是对象")

    unknown_fields = set(value) - set(capabilities)
    if unknown_fields:
        raise ValueError(f"未知模板参数：{next(iter(unknown_fields))}")

    normalized: dict[str, Any] = {}
    for field, descriptor in capabilities.items():
        if field in value:
            current_value = value[field]
        elif fill_missing and field in defaults:
            current_value = defaults[field]
        else:
            raise ValueError(f"模板参数缺少字段：{field}")
        normalized[field] = _normalize_text_video_template_prop(
            field,
            descriptor,
            current_value,
        )
    return normalized


def text_video_template_defaults(manifest: dict[str, Any]) -> dict[str, Any]:
    return normalize_text_video_template_props(
        manifest,
        manifest.get("defaults"),
        fill_missing=False,
    )


def normalize_text_video_template_default_map(value: object) -> dict[str, dict]:
    manifests = {
        f"{template_id}@{version}": manifest
        for (template_id, version), manifest in TEXT_VIDEO_TEMPLATES.items()
    }
    if value is None:
        value = {}
    if not isinstance(value, dict):
        raise ValueError("文字视频模板默认值必须是对象")

    unknown_template_keys = set(value) - set(manifests)
    if unknown_template_keys:
        raise ValueError(
            f"未知文字视频模板：{next(iter(unknown_template_keys))}",
        )
    return {
        template_key: normalize_text_video_template_props(
            manifest,
            value.get(template_key, {}),
            fill_missing=True,
        )
        for template_key, manifest in manifests.items()
    }


def get_text_video_template(template_id: str, version: int) -> dict[str, Any]:
    if (
        not isinstance(template_id, str)
        or not template_id.strip()
        or not isinstance(version, int)
        or isinstance(version, bool)
        or version <= 0
        or version > 9_007_199_254_740_991
    ):
        raise ValueError(f"未知文字视频模板：{template_id}@{version}")
    key = (template_id, version)
    manifest = TEXT_VIDEO_TEMPLATES.get(key)
    if manifest is None:
        raise ValueError(f"未知文字视频模板：{template_id}@{version}")
    return deepcopy(manifest)
