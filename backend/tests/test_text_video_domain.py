from tests.text_video_factories import (
    make_master_audio,
    make_scene_plan,
    make_speech_segment,
    make_text_video_project,
)
from text_video_domain import (
    merge_editable_project,
    normalize_speech_segments,
    speech_source_hash,
    video_stage_ready,
)


def test_normalization_keeps_a_new_script_as_one_lossless_segment():
    segments = normalize_speech_segments("第一句。\n第二句。", [])

    assert len(segments) == 1
    assert segments[0]["text"] == "第一句。\n第二句。"
    assert "".join(segment["text"] for segment in segments) == "第一句。\n第二句。"


def test_normalization_collapses_non_contiguous_legacy_paragraphs():
    segments = normalize_speech_segments(
        "第一句。\n第二句。",
        [
            make_speech_segment("a", "第一句。", status="confirmed"),
            make_speech_segment("b", "第二句。", status="confirmed"),
        ],
    )

    assert [(segment["id"], segment["text"], segment["status"]) for segment in segments] == [
        (segments[0]["id"], "第一句。\n第二句。", "draft"),
    ]


def test_source_hash_is_canonical_and_changes_with_generation_settings():
    first = speech_source_hash(
        "同一段",
        {"speed": 1, "voice_id": "mimo_default"},
        "mimo-v2.5-tts",
    )
    reordered = speech_source_hash(
        "同一段",
        {"voice_id": "mimo_default", "speed": 1},
        "mimo-v2.5-tts",
    )
    changed = speech_source_hash(
        "同一段",
        {"voice_id": "mimo_default", "speed": 1.2},
        "mimo-v2.5-tts",
    )

    assert first == reordered
    assert first != changed
    assert len(first) == 64


def test_editing_one_segment_invalidates_only_that_speech_and_all_downstream_timing():
    project = make_text_video_project(
        script="甲。乙。",
        paragraphs=[
            make_speech_segment("a", "甲。", status="confirmed"),
            make_speech_segment("b", "乙。", status="confirmed"),
        ],
        speech_split_mode="manual",
        master_audio=make_master_audio(status="ready", timeline_status="ready"),
        scene_plan=make_scene_plan(status="ready"),
    )

    merge_editable_project(
        project,
        {
            "script": "甲改。乙。",
            "paragraphs": [
                {"id": "a", "text": "甲改。"},
                {"id": "b", "text": "乙。"},
            ],
        },
        speech_model="mimo-v2.5-tts",
    )

    assert project.paragraphs[0]["status"] == "draft"
    assert project.paragraphs[0]["generation_revision"] == 1
    assert project.paragraphs[1]["status"] == "confirmed"
    assert project.master_audio["status"] == "stale"
    assert project.master_audio["timeline_status"] == "stale"
    assert project.scene_plan["status"] == "stale"
    assert "".join(segment["text"] for segment in project.paragraphs) == project.script


def test_browser_cannot_claim_generated_segment_fields():
    project = make_text_video_project(script="待生成", paragraphs=[
        make_speech_segment("a", "待生成"),
    ])

    merge_editable_project(
        project,
        {
            "paragraphs": [{
                "id": "a",
                "text": "待生成",
                "status": "confirmed",
                "audio_url": "/api/uploads/forged.mp3",
                "duration": 99,
                "word_timings": [{"id": "forged"}],
            }],
        },
        speech_model="mimo-v2.5-tts",
    )

    assert project.paragraphs[0]["status"] == "draft"
    assert project.paragraphs[0]["audio_url"] == ""
    assert project.paragraphs[0]["duration"] == 0
    assert project.paragraphs[0]["word_timings"] == []


def test_generated_speech_is_invalidated_when_its_source_hash_no_longer_matches():
    generated_hash = speech_source_hash(
        "同一段",
        {
            "voice_id": "mimo_default",
            "model": "mimo-v2.5-tts",
            "speed": 1,
            "volume": 1,
            "pitch": 0,
        },
        "mimo-v2.5-tts",
    )
    project = make_text_video_project(
        script="同一段",
        voice_settings={
            "voice_id": "mimo_default",
            "model": "mimo-v2.5-tts",
            "speed": 1.2,
            "volume": 1,
            "pitch": 0,
        },
        paragraphs=[make_speech_segment(
            "a",
            "同一段",
            status="confirmed",
            source_hash=generated_hash,
        )],
    )

    merge_editable_project(
        project,
        {"paragraphs": [{"id": "a", "text": "同一段"}]},
        speech_model="mimo-v2.5-tts",
    )

    assert project.paragraphs[0]["status"] == "draft"
    assert project.paragraphs[0]["source_hash"] == ""
    assert project.paragraphs[0]["generation_revision"] == 1


def test_video_stage_requires_confirmed_speech_and_ready_master_timeline():
    project = make_text_video_project(
        script="完成",
        paragraphs=[make_speech_segment("a", "完成", status="confirmed")],
        master_audio=make_master_audio(
            status="ready",
            timeline_status="ready",
            audio_url="/api/uploads/master.mp3",
        ),
        render_input={
            **make_text_video_project().render_input,
            "audio": "/api/uploads/master.mp3",
        },
    )
    assert video_stage_ready(project) is True

    project.master_audio = make_master_audio(
        status="ready",
        timeline_status="missing",
        audio_url="/api/uploads/master.mp3",
    )
    assert video_stage_ready(project) is False
