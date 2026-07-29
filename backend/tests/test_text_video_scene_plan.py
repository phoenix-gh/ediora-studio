import math

import pytest

from text_video_scene_plan import (
    resolve_scene_seconds,
    validate_render_input_projection,
    validate_scene_partition,
    validate_template_configuration,
)
from text_video_templates import get_text_video_template


MANIFEST = get_text_video_template("tech-text-v1", 1)
WORDS = [
    {"id": "word-1", "text": "甲", "start": 0.2, "end": 0.5},
    {"id": "word-2", "text": "乙", "start": 0.7, "end": 1.0},
    {"id": "word-3", "text": "丙", "start": 2.2, "end": 2.5},
    {"id": "word-4", "text": "丁", "start": 3.2, "end": 3.5},
]
SCENES = [
    {
        "id": "s1",
        "fromWordId": "word-1",
        "throughWordId": "word-2",
        "displayText": "甲乙",
        "highlight": ["甲"],
        "animation": "fade-up",
    },
    {
        "id": "s2",
        "fromWordId": "word-3",
        "throughWordId": "word-4",
        "displayText": "丙丁",
        "highlight": ["丁"],
        "animation": "scale",
    },
]


def test_template_manifest_is_versioned_json_safe_and_fails_closed():
    assert MANIFEST == {
        "id": "tech-text-v1",
        "version": 1,
        "composition_id": "tech-text-v1",
        "default_composition": {"width": 1080, "height": 1920, "fps": 30},
        "aspect_ratios": ["9:16", "16:9", "1:1"],
        "animations": ["fade-up", "scale"],
        "transitions": ["soft-push"],
        "template_props": {
            "theme": ["tech-blue"],
            "font": ["source-han-sans"],
            "background": ["dark-grid"],
            "transition": ["soft-push"],
            "textDensity": ["compact", "standard", "spacious"],
        },
        "defaults": {
            "theme": "tech-blue",
            "font": "source-han-sans",
            "background": "dark-grid",
            "transition": "soft-push",
            "textDensity": "standard",
        },
    }
    with pytest.raises(ValueError, match=r"tech-text-v1@2"):
        get_text_video_template("tech-text-v1", 2)
    with pytest.raises(ValueError, match=r"tech-text-v1@True"):
        get_text_video_template("tech-text-v1", True)


def test_template_configuration_does_not_assume_a_transition_prop():
    manifest = {
        "id": "horizontal-color-v1",
        "version": 1,
        "composition_id": "horizontal-color-v1",
        "default_composition": {"width": 1920, "height": 1080, "fps": 24},
        "aspect_ratios": ["16:9"],
        "animations": ["fade-up"],
        "transitions": ["crossfade"],
        "template_props": {"color": ["cyan", "violet"]},
        "defaults": {"color": "cyan"},
    }

    assert validate_template_configuration(
        manifest=manifest,
        composition=manifest["default_composition"],
        template_props=manifest["defaults"],
    ) == (
        {"width": 1920, "height": 1080, "fps": 24},
        {"color": "cyan"},
    )


def test_scene_word_partition_resolves_to_continuous_master_seconds():
    validated = validate_scene_partition(
        proposals=SCENES,
        words=WORDS,
        manifest=MANIFEST,
    )
    assert validated == SCENES

    resolved = resolve_scene_seconds(
        proposals=SCENES,
        words=WORDS,
        master_duration=4.2,
        manifest=MANIFEST,
    )
    assert resolved == [
        {
            "id": "s1",
            "start": 0.0,
            "end": 2.2,
            "text": "甲乙",
            "highlight": ["甲"],
            "animation": "fade-up",
        },
        {
            "id": "s2",
            "start": 2.2,
            "end": 4.2,
            "text": "丙丁",
            "highlight": ["丁"],
            "animation": "scale",
        },
    ]
    assert resolved[0]["end"] is resolved[1]["start"]


@pytest.mark.parametrize(
    "scenes",
    [
        [{**SCENES[0], "fromWordId": "word-2"}, SCENES[1]],
        [SCENES[0], {**SCENES[1], "fromWordId": "word-4"}],
        [{**SCENES[0], "throughWordId": "word-3"}, SCENES[1]],
        [SCENES[0]],
        [SCENES[1], SCENES[0]],
        [{**SCENES[0], "throughWordId": "missing"}, SCENES[1]],
    ],
)
def test_scene_partition_rejects_gap_overlap_reverse_unknown_or_incomplete_ranges(
    scenes,
):
    with pytest.raises(ValueError, match="完整且连续"):
        validate_scene_partition(
            proposals=scenes,
            words=WORDS,
            manifest=MANIFEST,
        )


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("start", 0),
        ("end", 1),
        ("seconds", {"start": 0}),
        ("duration", 1),
        ("offset", 0),
    ],
)
def test_scene_intent_rejects_browser_timing_fields(field, value):
    with pytest.raises(ValueError, match="仅允许词范围"):
        validate_scene_partition(
            proposals=[{**SCENES[0], field: value}, SCENES[1]],
            words=WORDS,
            manifest=MANIFEST,
        )


@pytest.mark.parametrize(
    "scenes",
    [
        [SCENES[0], {**SCENES[1], "id": "s1"}],
        [{**SCENES[0], "displayText": " "}, SCENES[1]],
        [{**SCENES[0], "highlight": ["不存在"]}, SCENES[1]],
        [{**SCENES[0], "animation": "spin"}, SCENES[1]],
    ],
)
def test_scene_partition_rejects_invalid_scene_intent(scenes):
    with pytest.raises(ValueError):
        validate_scene_partition(
            proposals=scenes,
            words=WORDS,
            manifest=MANIFEST,
        )


@pytest.mark.parametrize(
    "words",
    [
        [WORDS[0], {**WORDS[1], "id": "word-1"}, *WORDS[2:]],
        [WORDS[0], {**WORDS[1], "start": 0.1}, *WORDS[2:]],
        [WORDS[0], {**WORDS[1], "end": 4.3}, *WORDS[2:]],
        [WORDS[0], {**WORDS[1], "start": math.nan}, *WORDS[2:]],
    ],
)
def test_scene_resolution_rejects_invalid_global_word_timeline(words):
    with pytest.raises(ValueError, match="全局词时间轴"):
        resolve_scene_seconds(
            proposals=SCENES,
            words=words,
            master_duration=4.2,
            manifest=MANIFEST,
        )


@pytest.mark.parametrize("duration", [0, -1, math.nan, math.inf])
def test_scene_resolution_requires_finite_positive_master_duration(duration):
    with pytest.raises(ValueError, match="主音频时长"):
        resolve_scene_seconds(
            proposals=SCENES,
            words=WORDS,
            master_duration=duration,
            manifest=MANIFEST,
        )


def _render_input(**overrides):
    value = {
        "templateId": "tech-text-v1",
        "templateVersion": 1,
        "composition": {"width": 1080, "height": 1920, "fps": 30},
        "audio": "/api/uploads/master.mp3",
        "segments": [
            {
                "id": "s1",
                "start": 0.0,
                "end": 2.2,
                "text": "甲乙",
                "highlight": ["甲"],
                "animation": "fade-up",
            },
            {
                "id": "s2",
                "start": 2.2,
                "end": 4.2,
                "text": "丙丁",
                "highlight": ["丁"],
                "animation": "scale",
            },
        ],
        "templateProps": MANIFEST["defaults"],
    }
    return value | overrides


def test_render_projection_uses_the_same_point_zero_zero_one_epsilon():
    within_epsilon = _render_input(segments=[
        {**_render_input()["segments"][0], "start": 0.0009},
        {
            **_render_input()["segments"][1],
            "start": 2.2009,
            "end": 4.2009,
        },
    ])
    assert validate_render_input_projection(
        within_epsilon,
        master_duration=4.2,
    )["segments"][-1]["end"] == 4.2009

    outside_epsilon = _render_input(segments=[
        {**_render_input()["segments"][0], "start": 0.0011},
        _render_input()["segments"][1],
    ])
    with pytest.raises(ValueError, match="连续覆盖"):
        validate_render_input_projection(
            outside_epsilon,
            master_duration=4.2,
        )


@pytest.mark.parametrize(
    "render_input",
    [
        _render_input(templateVersion=2),
        _render_input(extra=True),
        _render_input(
            composition={"width": 1200, "height": 900, "fps": 30},
        ),
        _render_input(
            templateProps={**MANIFEST["defaults"], "extra": True},
        ),
        _render_input(segments=[
            {**_render_input()["segments"][0], "animation": "spin"},
            _render_input()["segments"][1],
        ]),
        _render_input(segments=[
            {**_render_input()["segments"][0], "start": math.nan},
            _render_input()["segments"][1],
        ]),
    ],
)
def test_render_projection_fails_closed_for_invalid_contract(render_input):
    with pytest.raises(ValueError):
        validate_render_input_projection(
            render_input,
            master_duration=4.2,
        )
