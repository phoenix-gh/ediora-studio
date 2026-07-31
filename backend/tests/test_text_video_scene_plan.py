import math

import pytest

import text_video_scene_plan
from text_video_scene_plan import (
    canonicalize_motion_generation_proposal,
    canonicalize_scene_generation_proposal,
    resolve_scene_seconds,
    validate_canonical_scene_result,
    validate_render_input_projection,
    validate_scene_partition,
    validate_template_configuration,
)
from text_video_templates import get_text_video_template


MANIFEST = get_text_video_template("tech-text-v1", 1)
KINETIC_MANIFEST = {
    **MANIFEST,
    "id": "kinetic-punch-v2",
    "composition_id": "kinetic-punch-v2",
    "animations": ["impact", "reveal", "contrast"],
    "transitions": ["block-wipe"],
}
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


def _motion_scene(**overrides):
    scene = {
        "id": "motion-scene",
        "fromWordId": "word-1",
        "throughWordId": "word-4",
        "displayText": "甲乙丙丁",
        "highlight": ["丙丁"],
        "animation": "reveal",
        "motion": {
            "transition": "block-wipe",
            "intensity": 0.8,
            "chunks": [
                {
                    "id": "motion-chunk-1",
                    "fromWordId": "word-1",
                    "throughWordId": "word-2",
                    "displayText": "甲乙",
                    "highlight": [],
                    "motionPreset": "reveal",
                    "emphasis": "normal",
                },
                {
                    "id": "motion-chunk-2",
                    "fromWordId": "word-3",
                    "throughWordId": "word-4",
                    "displayText": "丙丁",
                    "highlight": ["丙丁"],
                    "motionPreset": "impact",
                    "emphasis": "punch",
                },
            ],
        },
    }
    return scene | overrides


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
        "template_props": {
            "color": {"type": "enum", "values": ["cyan", "violet"]},
        },
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


def test_template_configuration_fills_legacy_template_props_with_defaults():
    composition, template_props = validate_template_configuration(
        manifest=MANIFEST,
        composition=MANIFEST["default_composition"],
        template_props={
            "theme": "tech-blue",
            "font": "source-han-sans",
            "background": "dark-grid",
            "transition": "soft-push",
            "textDensity": "standard",
        },
    )

    assert composition == MANIFEST["default_composition"]
    assert template_props["brandTitle"] == "EDIORA"
    assert template_props["showSceneNumber"] is True


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


def test_scene_motion_projects_word_ids_to_render_seconds():
    scene = _motion_scene()

    assert validate_scene_partition(
        proposals=[scene],
        words=WORDS,
        manifest=KINETIC_MANIFEST,
    ) == [scene]

    resolved = resolve_scene_seconds(
        proposals=[scene],
        words=WORDS,
        master_duration=4.2,
        manifest=KINETIC_MANIFEST,
    )

    assert resolved == [{
        "id": "motion-scene",
        "start": 0.0,
        "end": 4.2,
        "text": "甲乙丙丁",
        "highlight": ["丙丁"],
        "animation": "reveal",
        "transition": "block-wipe",
        "intensity": 0.8,
        "chunks": [
            {
                "id": "motion-chunk-1",
                "start": 0.0,
                "end": 2.2,
                "text": "甲乙",
                "motionPreset": "reveal",
                "emphasis": "normal",
                "words": [
                    {
                        "text": "甲",
                        "start": 0.2,
                        "end": 0.5,
                        "emphasis": "normal",
                    },
                    {
                        "text": "乙",
                        "start": 0.7,
                        "end": 1.0,
                        "emphasis": "normal",
                    },
                ],
            },
            {
                "id": "motion-chunk-2",
                "start": 2.2,
                "end": 4.2,
                "text": "丙丁",
                "motionPreset": "impact",
                "emphasis": "punch",
                "words": [
                    {
                        "text": "丙",
                        "start": 2.2,
                        "end": 2.5,
                        "emphasis": "highlight",
                    },
                    {
                        "text": "丁",
                        "start": 3.2,
                        "end": 3.5,
                        "emphasis": "highlight",
                    },
                ],
            },
        ],
    }]


def test_motion_projection_marks_repeated_highlights_and_gates_fallback():
    words = [
        {"id": "w1", "text": "AI", "start": 0.0, "end": 0.5},
        {"id": "w2", "text": "AI", "start": 0.5, "end": 1.0},
        {"id": "w3", "text": "结论", "start": 1.0, "end": 1.5},
    ]
    scene = {
        "id": "repeat",
        "fromWordId": "w1",
        "throughWordId": "w3",
        "displayText": "AI AI，结论",
        "highlight": ["AI"],
        "animation": "reveal",
        "motion": {
            "transition": "block-wipe",
            "intensity": 0.5,
            "chunks": [{
                "id": "repeat-chunk",
                "fromWordId": "w1",
                "throughWordId": "w3",
                "displayText": "AI AI，结论",
                "highlight": ["AI"],
                "motionPreset": "reveal",
                "emphasis": "normal",
            }],
        },
    }

    segment = resolve_scene_seconds(
        proposals=[scene],
        words=words,
        master_duration=1.5,
        manifest=KINETIC_MANIFEST,
    )[0]

    assert [word["emphasis"] for word in segment["chunks"][0]["words"]] == [
        "highlight",
        "highlight",
        "normal",
    ]

    scene["motion"]["chunks"][0]["highlight"] = ["AI AI"]
    scene["motion"]["chunks"][0]["displayText"] = "AI AI，结论"
    words[0]["text"] = "A"
    words[1]["text"] = "I"
    segment = resolve_scene_seconds(
        proposals=[scene],
        words=words,
        master_duration=1.5,
        manifest=KINETIC_MANIFEST,
    )[0]
    assert segment["chunks"][0]["words"][-1]["emphasis"] == "normal"

    scene["motion"]["chunks"][0]["emphasis"] = "punch"
    segment = resolve_scene_seconds(
        proposals=[scene],
        words=words,
        master_duration=1.5,
        manifest=KINETIC_MANIFEST,
    )[0]
    assert segment["chunks"][0]["words"][-1]["emphasis"] == "highlight"


def test_v1_scene_retains_motion_document_but_projects_legacy_segment():
    first = {
        **SCENES[0],
        "motion": {
            "transition": "block-wipe",
            "intensity": 0.65,
            "chunks": [{
                "id": "s1-chunk-1",
                "fromWordId": "word-1",
                "throughWordId": "word-2",
                "displayText": "甲乙",
                "highlight": ["甲"],
                "motionPreset": "reveal",
                "emphasis": "normal",
            }],
        },
    }
    scenes = [first, SCENES[1]]

    assert validate_scene_partition(
        proposals=scenes,
        words=WORDS,
        manifest=MANIFEST,
    ) == scenes
    assert resolve_scene_seconds(
        proposals=scenes,
        words=WORDS,
        master_duration=4.2,
        manifest=MANIFEST,
    )[0] == {
        "id": "s1",
        "start": 0.0,
        "end": 2.2,
        "text": "甲乙",
        "highlight": ["甲"],
        "animation": "fade-up",
    }


@pytest.mark.parametrize(
    ("mutate", "error"),
    [
        (
            lambda scene: scene["motion"].update({"intensity": 1.1}),
            "强度",
        ),
        (
            lambda scene: scene["motion"].update({"transition": "cut"}),
            "转场",
        ),
        (
            lambda scene: scene["motion"]["chunks"][0].update(
                {"throughWordId": "word-3"},
            ),
            "完整且连续",
        ),
        (
            lambda scene: scene["motion"]["chunks"][1].update(
                {"fromWordId": "missing"},
            ),
            "完整且连续",
        ),
        (
            lambda scene: scene["motion"]["chunks"][1].update(
                {"displayText": "改写", "highlight": []},
            ),
            "完整覆盖",
        ),
        (
            lambda scene: scene["motion"]["chunks"][1].update(
                {"highlight": ["不存在"]},
            ),
            "高亮",
        ),
        (
            lambda scene: scene["motion"]["chunks"][1].update(
                {"motionPreset": "spin"},
            ),
            "预设",
        ),
    ],
)
def test_scene_motion_rejects_invalid_contract(mutate, error):
    scene = _motion_scene()
    mutate(scene)

    with pytest.raises(ValueError, match=error):
        validate_scene_partition(
            proposals=[scene],
            words=WORDS,
            manifest=KINETIC_MANIFEST,
        )


def test_render_projection_accepts_v2_motion_fields(monkeypatch):
    monkeypatch.setattr(
        text_video_scene_plan,
        "get_text_video_template",
        lambda template_id, version: (
            KINETIC_MANIFEST
            if (template_id, version) == ("kinetic-punch-v2", 1)
            else get_text_video_template(template_id, version)
        ),
    )
    segments = resolve_scene_seconds(
        proposals=[_motion_scene()],
        words=WORDS,
        master_duration=4.2,
        manifest=KINETIC_MANIFEST,
    )
    render_input = {
        "templateId": "kinetic-punch-v2",
        "templateVersion": 1,
        "composition": KINETIC_MANIFEST["default_composition"],
        "audio": "/api/uploads/master.mp3",
        "segments": segments,
        "templateProps": KINETIC_MANIFEST["defaults"],
    }

    assert validate_render_input_projection(
        render_input,
        master_duration=4.2,
    )["segments"] == segments


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
    canonical = validate_render_input_projection(
        within_epsilon,
        master_duration=4.2,
    )["segments"]
    assert canonical[0]["start"] == 0.0
    assert canonical[1]["start"] == canonical[0]["end"] == 2.2
    assert canonical[-1]["end"] == 4.2

    outside_epsilon = _render_input(segments=[
        {**_render_input()["segments"][0], "start": 0.0011},
        _render_input()["segments"][1],
    ])
    with pytest.raises(ValueError, match="连续覆盖"):
        validate_render_input_projection(
            outside_epsilon,
            master_duration=4.2,
        )


def test_render_projection_rejects_scene_collapsed_by_canonicalization():
    collapsed = _render_input(segments=[
        {**_render_input()["segments"][0], "end": 1.0},
        {
            **_render_input()["segments"][1],
            "start": 0.9995,
            "end": 0.9998,
        },
        {
            **_render_input()["segments"][1],
            "id": "s3",
            "start": 0.9998,
            "end": 4.2,
        },
    ])

    with pytest.raises(ValueError, match="连续覆盖"):
        validate_render_input_projection(
            collapsed,
            master_duration=4.2,
        )


def test_render_projection_rejects_positive_seconds_without_a_safe_frame():
    unsafe = _render_input(
        composition={"width": 1080, "height": 1920, "fps": 30},
        segments=[
            {
                **_render_input()["segments"][0],
                "start": 0.0,
                "end": 0.01,
            },
            {
                **_render_input()["segments"][1],
                "start": 0.01,
                "end": 0.02,
            },
            {
                **_render_input()["segments"][1],
                "id": "s3",
                "start": 0.02,
                "end": 0.04,
            },
        ],
    )

    with pytest.raises(ValueError, match="安全帧"):
        validate_render_input_projection(
            unsafe,
            master_duration=0.04,
        )


def test_template_configuration_rejects_exact_ratio_false_positive():
    with pytest.raises(ValueError, match="画面比例"):
        validate_template_configuration(
            manifest=MANIFEST,
            composition={
                "width": 5_066_549_580_791_807,
                "height": 9_007_199_254_740_991,
                "fps": 30,
            },
            template_props=MANIFEST["defaults"],
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


def test_selected_scene_generation_merges_only_visual_intent():
    selected = {
        **SCENES[0],
        "displayText": "重点甲乙",
        "highlight": ["甲"],
        "animation": "scale",
    }

    assert canonicalize_scene_generation_proposal(
        proposals=[selected],
        words=WORDS,
        manifest=MANIFEST,
        scope="selected",
        selected_scene_id="s1",
        existing_scenes=SCENES,
    ) == [selected, SCENES[1]]


def test_motion_generation_changes_only_validated_motion_document():
    frozen = _motion_scene()
    proposal = _motion_scene()
    proposal["motion"]["intensity"] = 0.65

    assert canonicalize_motion_generation_proposal(
        proposals=[proposal],
        words=WORDS,
        manifest=KINETIC_MANIFEST,
        scope="all",
        selected_scene_id="",
        existing_scenes=[frozen],
    ) == [proposal]

    changed_text = _motion_scene(displayText="篡改文字")
    with pytest.raises(ValueError, match="不能改变"):
        canonicalize_motion_generation_proposal(
            proposals=[changed_text],
            words=WORDS,
            manifest=KINETIC_MANIFEST,
            scope="all",
            selected_scene_id="",
            existing_scenes=[frozen],
        )


@pytest.mark.parametrize(
    "proposal",
    [
        [{**SCENES[0], "fromWordId": "word-2"}],
        [{**SCENES[0], "throughWordId": "word-3"}],
        [{**SCENES[0], "id": "other"}],
        [SCENES[0], SCENES[1]],
        [],
    ],
)
def test_selected_scene_generation_keeps_exact_id_and_word_boundaries(proposal):
    with pytest.raises(ValueError, match="目标分镜|一个分镜"):
        canonicalize_scene_generation_proposal(
            proposals=proposal,
            words=WORDS,
            manifest=MANIFEST,
            scope="selected",
            selected_scene_id="s1",
            existing_scenes=SCENES,
        )


def test_selected_canonical_result_rejects_changes_to_unselected_scenes():
    with pytest.raises(ValueError, match="非目标分镜"):
        validate_canonical_scene_result(
            proposals=[
                SCENES[0],
                {**SCENES[1], "displayText": "偷偷改了"},
            ],
            words=WORDS,
            manifest=MANIFEST,
            scope="selected",
            selected_scene_id="s1",
            existing_scenes=SCENES,
        )


def test_full_scene_generation_requires_one_complete_word_partition():
    assert canonicalize_scene_generation_proposal(
        proposals=SCENES,
        words=WORDS,
        manifest=MANIFEST,
        scope="all",
        selected_scene_id="",
        existing_scenes=[],
    ) == SCENES
    with pytest.raises(ValueError, match="完整且连续"):
        canonicalize_scene_generation_proposal(
            proposals=[SCENES[0]],
            words=WORDS,
            manifest=MANIFEST,
            scope="all",
            selected_scene_id="",
            existing_scenes=[],
        )
