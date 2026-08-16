from digital_human_service import InvalidTalkingVideo
from digital_human_shots import (
    DEFAULT_DELIVERY,
    DEFAULT_PRESENCE,
    apply_planned_segments,
    build_shot_prompt,
    effective_shot_duration_bounds,
    estimate_shot_seconds,
    fallback_plan_segments,
    new_blank_shot,
    normalize_shots,
    parse_shot_plan_document,
    parse_shot_plan_segments,
    script_from_shots,
)
import pytest


def test_effective_bounds_intersect_settings_and_workflow():
    assert effective_shot_duration_bounds(4, 5, 4, 15) == (4, 5)
    assert effective_shot_duration_bounds(1, 8, 4, 6) == (4, 6)
    with pytest.raises(InvalidTalkingVideo):
        effective_shot_duration_bounds(10, 12, 4, 5)


def test_normalize_shots_rewrites_script_and_rejects_overlong():
    shots = normalize_shots(
        [
            {
                "spoken_text": "第一句",
                "duration_sec": 4,
                "framing": "medium",
            },
            {
                "id": "shot-2",
                "spoken_text": "第二句",
                "duration_sec": 5,
                "framing": "close",
            },
        ],
        4,
        5,
    )
    assert shots[0]["spoken_text"] == "第一句"
    assert shots[1]["id"] == "shot-2"
    assert script_from_shots(shots) == "第一句\n\n第二句"
    with pytest.raises(InvalidTalkingVideo, match="4–5"):
        normalize_shots(
            [new_blank_shot(8)],
            4,
            5,
        )


def test_estimate_shot_seconds_uses_settings_bounds():
    assert estimate_shot_seconds("短", 4, 5) == 4
    assert estimate_shot_seconds("这是一段大约二十个汉字的口播内容用于估时", 4, 5) == 4
    sixty = "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十"
    assert len(sixty) == 50
    assert estimate_shot_seconds(sixty, 4, 15) == 10
    assert estimate_shot_seconds(sixty + "一二三四五六七八九十", 4, 15) == 12


def test_build_shot_prompt_keeps_chinese_dialogue_and_six_sections():
    prompt = build_shot_prompt("close", "今天只讲一件事。", "slight nod")
    assert "Video Description:" in prompt
    assert "Camera Movement:" in prompt
    assert "Shot Type:" in prompt
    assert "Style:" in prompt
    assert "Subjects:" in prompt
    assert "Background:" in prompt
    assert "今天只讲一件事。" in prompt
    assert "slight nod" in prompt
    assert "close-up" in prompt
    assert "Uses <Audio 1> only as voice timbre." in prompt
    assert "<d>[Chinese] 今天只讲一件事。</d>" in prompt
    assert "<Subject 1> (S1)" in prompt
    assert "Already talking at the first frame" in prompt
    assert DEFAULT_DELIVERY in prompt
    assert DEFAULT_PRESENCE in prompt
    assert "says ONLY this quoted line" in prompt
    assert "No extra words" in prompt
    assert "speaking rate come from this prompt" in prompt


def test_build_shot_prompt_uses_shot_delivery_over_base():
    prompt = build_shot_prompt(
        "medium",
        "下一句",
        delivery="slower, emphasizes the caution",
        base_delivery="calm tutorial host, medium pace",
    )
    assert "slower, emphasizes the caution" in prompt
    assert "calm tutorial host, medium pace" not in prompt


def test_build_shot_prompt_uses_previous_last_frame_as_first_frame():
    prompt = build_shot_prompt(
        "medium",
        "下一句",
        has_first_frame_reference=True,
    )
    assert "At 0.00 seconds, <Picture 3> is fully referenced as the first frame." in prompt
    assert "last frame of the previous clip" in prompt
    assert "Already talking at the first frame" not in prompt


def test_previous_succeeded_clip_id_skips_failed_neighbors():
    from digital_human_shots import (
        previous_succeeded_clip_id,
        shot_requires_previous_clip,
    )

    shots = [
        {"id": "a", "status": "succeeded", "clip_asset_id": 11},
        {"id": "b", "status": "failed", "clip_asset_id": None},
        {"id": "c", "status": "draft", "clip_asset_id": None},
    ]
    assert previous_succeeded_clip_id(shots, "c") == 11
    assert previous_succeeded_clip_id(shots, "a") is None
    assert shot_requires_previous_clip(shots, "a") is False
    assert shot_requires_previous_clip(shots, "c") is True


def test_apply_planned_segments_is_lossless_and_clamps_duration():
    script = "今天讲本地部署。然后看环境准备。"
    shots = apply_planned_segments(
        script,
        [
            {"text": "今天讲本地部署。", "framing": "close"},
            {"text": "然后看环境准备。", "framing": "wide"},
        ],
        4,
        5,
    )
    assert "".join(shot["spoken_text"] for shot in shots) == script
    assert shots[0]["framing"] == "close"
    assert shots[1]["framing"] == "wide"
    assert all(4 <= shot["duration_sec"] <= 5 for shot in shots)
    assert all(shot["status"] == "draft" for shot in shots)
    assert all(shot["clip_asset_id"] is None for shot in shots)
    assert "今天讲本地部署。" in shots[0]["render_prompt"]
    assert "close-up" in shots[0]["render_prompt"]
    assert shots[0]["delivery"] == DEFAULT_DELIVERY
    assert DEFAULT_DELIVERY in shots[0]["render_prompt"]


def test_apply_planned_segments_rejects_rewritten_script():
    with pytest.raises(InvalidTalkingVideo, match="无损"):
        apply_planned_segments(
            "原文一字不改",
            [{"text": "原文可以改写", "framing": "medium"}],
            4,
            5,
        )


def test_apply_planned_segments_splits_overlong_slice():
    script = "第一句要足够长才能超过五秒上限。" * 3
    shots = apply_planned_segments(
        script,
        [{"text": script, "framing": "medium"}],
        4,
        5,
    )
    assert "".join(shot["spoken_text"] for shot in shots) == script
    assert len(shots) > 1
    assert all(4 <= shot["duration_sec"] <= 5 for shot in shots)


def test_fallback_plan_segments_is_lossless_and_respects_max():
    script = "今天讲本地部署。然后看环境准备。最后再看一次拼接。"
    segments = fallback_plan_segments(script, 5)
    assert "".join(item["text"] for item in segments) == script
    long_script = "第一句要足够长才能超过五秒上限。" * 3
    long_segments = fallback_plan_segments(long_script, 5)
    assert "".join(item["text"] for item in long_segments) == long_script
    assert len(long_segments) > 1


def test_parse_piece_voice_reads_english_and_chinese_keys():
    from digital_human_shots import parse_piece_voice

    assert parse_piece_voice(
        '{"delivery":"calm host","presence":"seated, relaxed"}'
    ) == ("calm host", "seated, relaxed")
    assert parse_piece_voice(
        '{"语气":"warm and direct","状态":"leaning in, talking to camera"}'
    ) == ("warm and direct", "leaning in, talking to camera")


def test_parse_shot_plan_document_extracts_piece_voice_and_presence():
    document = parse_shot_plan_document(
        """
        {
          "delivery": "calm tutorial host, medium pace",
          "presence": "seated, relaxed, explaining to camera",
          "shots": [
            {"text": "甲。", "framing": "close", "delivery": "slightly brighter hook"},
            {"text": "乙。", "framing": "wide"}
          ]
        }
        """
    )
    assert document["delivery"] == "calm tutorial host, medium pace"
    assert document["presence"] == "seated, relaxed, explaining to camera"
    assert document["shots"][0]["delivery"] == "slightly brighter hook"
    assert [item["text"] for item in document["shots"]] == ["甲。", "乙。"]


def test_parse_shot_plan_segments_reads_json_array():
    segments = parse_shot_plan_segments(
        '前言\n[{"text":"甲。","framing":"close","delivery":"slightly brighter hook"},'
        '{"text":"乙。","framing":"wide"}]\n'
    )
    assert segments == [
        {"text": "甲。", "framing": "close", "delivery": "slightly brighter hook"},
        {"text": "乙。", "framing": "wide", "delivery": ""},
    ]


def test_apply_planned_segments_keeps_per_shot_delivery():
    script = "今天讲本地部署。然后看环境准备。"
    shots = apply_planned_segments(
        script,
        [
            {"text": "今天讲本地部署。", "framing": "close", "delivery": "slightly brighter hook"},
            {"text": "然后看环境准备。", "framing": "wide"},
        ],
        4,
        5,
        base_delivery="calm tutorial host, medium pace",
    )
    assert shots[0]["delivery"] == "slightly brighter hook"
    assert "slightly brighter hook" in shots[0]["render_prompt"]
    assert shots[1]["delivery"] == "calm tutorial host, medium pace"
    assert "calm tutorial host, medium pace" in shots[1]["render_prompt"]
