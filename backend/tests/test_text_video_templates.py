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

    defaults = normalize_text_video_template_default_map(None)
    assert list(defaults) == [
        "tech-text-v1@1",
        "kinetic-punch-v1@1",
        "caption-focus-v1@1",
        "editorial-card-v1@1",
        "voice-pulse-v1@1",
    ]
    assert defaults["tech-text-v1@1"] == text_video_template_defaults(manifest)

    customized = normalize_text_video_template_default_map({
        "tech-text-v1@1": {"brandTitle": "  CHANNEL ONE  "},
    })
    assert customized["tech-text-v1@1"] == (
        text_video_template_defaults(manifest)
        | {"brandTitle": "CHANNEL ONE"}
    )
    assert len(customized) == 5


@pytest.mark.parametrize(
    ("template_id", "composition_id"),
    [
        ("kinetic-punch-v1", "kinetic-punch-v1"),
        ("caption-focus-v1", "caption-focus-v1"),
        ("editorial-card-v1", "editorial-card-v1"),
        ("voice-pulse-v1", "voice-pulse-v1"),
    ],
)
def test_additional_templates_have_valid_normalizable_defaults(
    template_id,
    composition_id,
):
    manifest = get_text_video_template(template_id, 1)

    assert manifest["composition_id"] == composition_id
    assert manifest["aspect_ratios"] == ["9:16", "16:9", "1:1"]
    assert normalize_text_video_template_props(
        manifest,
        manifest["defaults"],
        fill_missing=False,
    ) == manifest["defaults"]


def test_render_facing_catalog_contract_stays_in_frontend_parity():
    catalog = [
        {
            "id": manifest["id"],
            "composition_id": manifest["composition_id"],
            "composition": manifest["default_composition"],
            "animations": manifest["animations"],
            "transitions": manifest["transitions"],
            "defaults": manifest["defaults"],
        }
        for manifest in (
            get_text_video_template("tech-text-v1", 1),
            get_text_video_template("kinetic-punch-v1", 1),
            get_text_video_template("caption-focus-v1", 1),
            get_text_video_template("editorial-card-v1", 1),
            get_text_video_template("voice-pulse-v1", 1),
        )
    ]

    assert catalog == [
        {
            "id": "tech-text-v1",
            "composition_id": "tech-text-v1",
            "composition": {"width": 1080, "height": 1920, "fps": 30},
            "animations": ["fade-up", "scale"],
            "transitions": ["soft-push"],
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
        {
            "id": "kinetic-punch-v1",
            "composition_id": "kinetic-punch-v1",
            "composition": {"width": 1080, "height": 1920, "fps": 30},
            "animations": ["scale", "fade-up"],
            "transitions": ["cut"],
            "defaults": {
                "style": "kinetic-punch",
                "palette": "night",
                "brandTitle": "EDIORA",
                "showBrand": True,
                "accentColor": "#D8FF3E",
                "showProgress": True,
            },
        },
        {
            "id": "caption-focus-v1",
            "composition_id": "caption-focus-v1",
            "composition": {"width": 1080, "height": 1920, "fps": 30},
            "animations": ["fade-up", "scale"],
            "transitions": ["cut"],
            "defaults": {
                "style": "caption-focus",
                "palette": "night",
                "brandTitle": "EDIORA",
                "showBrand": True,
                "accentColor": "#FF4D8D",
                "showProgress": True,
            },
        },
        {
            "id": "editorial-card-v1",
            "composition_id": "editorial-card-v1",
            "composition": {"width": 1080, "height": 1920, "fps": 30},
            "animations": ["fade-up", "scale"],
            "transitions": ["cut"],
            "defaults": {
                "style": "editorial-card",
                "palette": "light",
                "brandTitle": "EDIORA JOURNAL",
                "showBrand": True,
                "accentColor": "#D14B32",
                "showProgress": True,
            },
        },
        {
            "id": "voice-pulse-v1",
            "composition_id": "voice-pulse-v1",
            "composition": {"width": 1080, "height": 1920, "fps": 30},
            "animations": ["scale", "fade-up"],
            "transitions": ["cut"],
            "defaults": {
                "style": "voice-pulse",
                "palette": "warm",
                "brandTitle": "EDIORA VOICE",
                "showBrand": True,
                "accentColor": "#7C5CFF",
                "showProgress": True,
            },
        },
    ]


def test_default_map_rejects_unknown_template_key():
    with pytest.raises(ValueError, match="unknown-template@1"):
        normalize_text_video_template_default_map({
            "unknown-template@1": {},
        })
