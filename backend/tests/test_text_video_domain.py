from copy import deepcopy

from tests.text_video_factories import (
    make_master_audio,
    make_scene_plan,
    make_speech_segment,
    make_text_video_project,
)
from text_video_domain import (
    empty_render_state,
    merge_editable_project,
    normalize_speech_segments,
    render_source_hash,
    speech_source_hash,
    video_stage_open,
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


def test_render_source_hash_is_canonical_and_covers_visual_input():
    first_input = {
        "templateId": "tech-text-v1",
        "templateVersion": 1,
        "audio": "/api/uploads/master.mp3",
        "segments": [{"id": "scene-1", "start": 0, "end": 2.4}],
    }
    reordered_input = {
        "segments": [{"end": 2.4, "start": 0, "id": "scene-1"}],
        "audio": "/api/uploads/master.mp3",
        "templateVersion": 1,
        "templateId": "tech-text-v1",
    }
    changed_input = deepcopy(first_input)
    changed_input["segments"][0]["end"] = 3

    assert render_source_hash(first_input) == render_source_hash(reordered_input)
    assert render_source_hash(first_input) != render_source_hash(changed_input)
    assert len(render_source_hash(first_input)) == 64


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


def _make_video_ready_project():
    master_hash = "master-current"
    words = [
        {"id": "word-1", "text": "完", "start": 0.1, "end": 0.8},
        {"id": "word-2", "text": "成", "start": 1.0, "end": 1.8},
    ]
    scenes = [{
        "id": "scene-1",
        "fromWordId": "word-1",
        "throughWordId": "word-2",
        "displayText": "完成",
        "highlight": [],
        "animation": "fade-up",
    }]
    return make_text_video_project(
        script="完成",
        paragraphs=[make_speech_segment("a", "完成", status="confirmed")],
        master_audio=make_master_audio(
            status="ready",
            timeline_status="ready",
            audio_url="/api/uploads/master.mp3",
            duration=2.4,
            source_hash=master_hash,
            word_timings=words,
        ),
        scene_plan=make_scene_plan(
            status="ready",
            master_source_hash=master_hash,
            scenes=scenes,
        ),
        render_input={
            **make_text_video_project().render_input,
            "audio": "/api/uploads/master.mp3",
            "segments": [{
                "id": "scene-1",
                "start": 0.0,
                "end": 2.4,
                "text": "完成",
                "highlight": [],
                "animation": "fade-up",
            }],
        },
    )


def _visual_autosave_echo(project) -> dict:
    return {
        "composition": deepcopy(project.render_input["composition"]),
        "template": {
            "templateId": project.render_input["templateId"],
            "templateVersion": project.render_input["templateVersion"],
            "templateProps": deepcopy(project.render_input["templateProps"]),
        },
        "scene_plan": {
            "scenes": deepcopy(project.scene_plan["scenes"]),
        },
    }


def test_same_scene_echo_does_not_recalibrate_stale_narration_state():
    project = _make_video_ready_project()
    merge_editable_project(
        project,
        {
            "script": "完成修改",
            "paragraphs": [{"id": "a", "text": "完成修改"}],
        },
        speech_model="mimo-v2.5-tts",
    )
    assert project.master_audio["status"] == "stale"
    assert project.scene_plan["status"] == "stale"
    stale_master = deepcopy(project.master_audio)
    stale_scene_plan = deepcopy(project.scene_plan)

    merge_editable_project(
        project,
        {
            "title": "只修改标题",
            "script": project.script,
            "paragraphs": [
                {"id": segment["id"], "text": segment["text"]}
                for segment in project.paragraphs
            ],
            **_visual_autosave_echo(project),
        },
        speech_model="mimo-v2.5-tts",
    )

    assert project.title == "只修改标题"
    assert project.master_audio == stale_master
    assert project.scene_plan == stale_scene_plan


def test_narration_autosave_with_same_scene_echo_invalidates_without_reprojection():
    project = _make_video_ready_project()
    visual_echo = _visual_autosave_echo(project)
    previous_scenes = deepcopy(project.scene_plan["scenes"])

    merge_editable_project(
        project,
        {
            "script": "完成修改",
            "paragraphs": [{"id": "a", "text": "完成修改"}],
            **visual_echo,
        },
        speech_model="mimo-v2.5-tts",
    )

    assert project.master_audio["status"] == "stale"
    assert project.scene_plan["status"] == "stale"
    assert project.scene_plan["scenes"] == previous_scenes
    assert project.render_input["audio"] == ""


def test_same_scene_echo_preserves_inflight_scene_job():
    project = _make_video_ready_project()
    project.scene_plan = {
        **project.scene_plan,
        "status": "generating",
        "generation_revision": 7,
        "job_id": 42,
    }
    before_scene_plan = deepcopy(project.scene_plan)
    before_render_input = deepcopy(project.render_input)

    merge_editable_project(
        project,
        {
            "title": "只修改标题",
            **_visual_autosave_echo(project),
        },
        speech_model="mimo-v2.5-tts",
    )

    assert project.title == "只修改标题"
    assert project.scene_plan == before_scene_plan
    assert project.render_input == before_render_input


def test_template_change_marks_only_existing_video_output_stale():
    project = _make_video_ready_project()
    project.output_asset_url = "/api/uploads/old.mp4"
    project.render_state = {
        **empty_render_state(),
        "status": "ready",
        "source_hash": render_source_hash(project.render_input),
        "asset_id": 19,
        "progress": 100,
    }
    merge_editable_project(
        project,
        {
            "template": {
                "templateId": "tech-text-v1",
                "templateVersion": 1,
                "templateProps": (
                    project.render_input["templateProps"]
                    | {"accentColor": "#FF3366"}
                ),
            },
        },
        speech_model="mimo-v2.5-tts",
    )

    assert project.output_stale is True
    assert project.output_asset_url == "/api/uploads/old.mp4"
    assert project.render_state["status"] == "stale"
    assert project.render_state["asset_id"] == 19
    assert project.master_audio["status"] == "ready"
    assert project.scene_plan["status"] == "ready"

    project_without_output = _make_video_ready_project()
    merge_editable_project(
        project_without_output,
        {
            "template": {
                "templateId": "tech-text-v1",
                "templateVersion": 1,
                "templateProps": (
                    project_without_output.render_input["templateProps"]
                    | {"accentColor": "#FF3366"}
                ),
            },
        },
        speech_model="mimo-v2.5-tts",
    )
    assert project_without_output.output_stale is False


def test_replacing_video_output_clears_stale_state():
    project = _make_video_ready_project()
    project.output_asset_url = "/api/uploads/old.mp4"
    project.output_stale = True

    merge_editable_project(
        project,
        {"output_asset_url": "/api/uploads/new.mp4"},
        speech_model="mimo-v2.5-tts",
    )

    assert project.output_asset_url == "/api/uploads/new.mp4"
    assert project.output_stale is False


def test_normalized_template_echo_does_not_mark_video_output_stale():
    project = _make_video_ready_project()
    project.output_asset_url = "/api/uploads/old.mp4"

    merge_editable_project(
        project,
        {
            "template": {
                "templateId": "tech-text-v1",
                "templateVersion": 1,
                "templateProps": (
                    project.render_input["templateProps"]
                    | {"accentColor": "#69f6ff"}
                ),
            },
        },
        speech_model="mimo-v2.5-tts",
    )

    assert project.output_stale is False


def test_video_stage_requires_current_authoritative_projection():
    project = _make_video_ready_project()
    assert video_stage_open(project) is True
    assert video_stage_ready(project) is True

    project.master_audio = make_master_audio(
        status="ready",
        timeline_status="missing",
        audio_url="/api/uploads/master.mp3",
    )
    assert video_stage_open(project) is False
    assert video_stage_ready(project) is False


def test_video_stage_opens_with_ready_audio_before_a_scene_plan_exists():
    project = _make_video_ready_project()
    project.scene_plan = make_scene_plan()
    project.render_input["audio"] = ""

    assert video_stage_open(project) is True
    assert video_stage_ready(project) is False


def test_video_stage_rejects_render_timeline_shorter_than_master_audio():
    project = _make_video_ready_project()
    project.master_audio["duration"] = 8.0

    assert video_stage_ready(project) is False


def test_video_stage_rejects_audio_scene_hash_and_scene_status_mismatches():
    project = _make_video_ready_project()
    project.render_input["audio"] = "/api/uploads/other.mp3"
    assert video_stage_ready(project) is False

    project = _make_video_ready_project()
    project.scene_plan["master_source_hash"] = "stale-master"
    assert video_stage_ready(project) is False

    project = _make_video_ready_project()
    project.scene_plan["status"] = "stale"
    assert video_stage_ready(project) is False


def test_video_stage_rejects_missing_words_unknown_template_and_tampered_projection():
    project = _make_video_ready_project()
    project.master_audio["word_timings"] = []
    assert video_stage_ready(project) is False

    project = _make_video_ready_project()
    project.render_input["templateId"] = "legacy-template"
    assert video_stage_ready(project) is False

    project = _make_video_ready_project()
    project.render_input["segments"][0]["text"] = "非服务端投影"
    assert video_stage_ready(project) is False
