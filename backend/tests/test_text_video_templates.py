import pytest

from text_video_templates import (
    get_text_video_template,
    normalize_text_video_template_default_map,
    normalize_text_video_template_props,
    text_video_template_defaults,
)


def test_tech_template_fills_new_brand_defaults_for_legacy_props():
    manifest = get_text_video_template("tech-text-v1", 1)

    normalized = normalize_text_video_template_props(
        manifest,
        {
            "theme": "tech-blue",
            "font": "source-han-sans",
            "background": "dark-grid",
            "transition": "soft-push",
            "textDensity": "standard",
        },
        fill_missing=True,
    )

    assert normalized["brandTitle"] == "EDIORA"
    assert normalized["brandSubtitle"] == "述策"
    assert normalized["accentColor"] == "#69F6FF"
    assert normalized["showBrand"] is True


def test_tech_template_normalizes_valid_custom_values_in_manifest_order():
    manifest = get_text_video_template("tech-text-v1", 1)

    normalized = normalize_text_video_template_props(
        manifest,
        text_video_template_defaults(manifest)
        | {
            "brandTitle": "  CHANNEL ONE  ",
            "brandSubtitle": "  深度科技  ",
            "background": "deep-space",
            "accentColor": "#ff3366",
            "showBrand": False,
            "showProgress": False,
            "showSceneNumber": False,
        },
        fill_missing=False,
    )

    assert list(normalized) == list(manifest["template_props"])
    assert normalized["brandTitle"] == "CHANNEL ONE"
    assert normalized["brandSubtitle"] == "深度科技"
    assert normalized["background"] == "deep-space"
    assert normalized["accentColor"] == "#FF3366"
    assert normalized["showBrand"] is False
    assert normalized["showProgress"] is False
    assert normalized["showSceneNumber"] is False


def test_tech_template_strips_brand_strings_without_requiring_them_to_be_nonblank():
    manifest = get_text_video_template("tech-text-v1", 1)

    normalized = normalize_text_video_template_props(
        manifest,
        text_video_template_defaults(manifest)
        | {"brandTitle": "   ", "brandSubtitle": "  "},
        fill_missing=False,
    )

    assert normalized["brandTitle"] == ""
    assert normalized["brandSubtitle"] == ""


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("accentColor", "cyan"),
        ("brandTitle", "x" * 33),
        ("background", "remote-css"),
        ("showProgress", "true"),
    ],
)
def test_tech_template_rejects_invalid_values(field, value):
    manifest = get_text_video_template("tech-text-v1", 1)
    props = text_video_template_defaults(manifest) | {field: value}

    with pytest.raises(ValueError, match=field):
        normalize_text_video_template_props(manifest, props, fill_missing=False)


@pytest.mark.parametrize(
    "value",
    [
        None,
        [],
        {"unknown": "value"},
    ],
)
def test_normalizer_rejects_non_dict_or_unknown_template_props(value):
    manifest = get_text_video_template("tech-text-v1", 1)

    with pytest.raises(ValueError):
        normalize_text_video_template_props(manifest, value, fill_missing=True)


def test_normalizer_requires_every_field_without_missing_value_filling():
    manifest = get_text_video_template("tech-text-v1", 1)
    legacy_props = text_video_template_defaults(manifest)
    legacy_props.pop("brandTitle")

    with pytest.raises(ValueError, match="brandTitle"):
        normalize_text_video_template_props(
            manifest,
            legacy_props,
            fill_missing=False,
        )


def test_default_map_uses_code_defaults_and_normalizes_known_template_entries():
    manifest = get_text_video_template("tech-text-v1", 1)

    assert normalize_text_video_template_default_map(None) == {
        "tech-text-v1@1": text_video_template_defaults(manifest),
    }
    assert normalize_text_video_template_default_map({
        "tech-text-v1@1": {"brandTitle": "  CHANNEL ONE  "},
    }) == {
        "tech-text-v1@1": text_video_template_defaults(manifest)
        | {"brandTitle": "CHANNEL ONE"},
    }


def test_default_map_rejects_unknown_template_key():
    with pytest.raises(ValueError, match="unknown-template@1"):
        normalize_text_video_template_default_map({
            "unknown-template@1": {},
        })
