from __future__ import annotations

from copy import deepcopy
import hashlib
import json
from typing import Any
from uuid import uuid4


SPEECH_STATUSES = {"draft", "generating", "ready", "confirmed", "failed"}
SEGMENT_SERVER_FIELDS = {
    "status",
    "audio_url",
    "duration",
    "word_timings",
    "source_hash",
    "generation_revision",
    "error",
    "job_id",
}
VOICE_SETTING_FIELDS = {"voice_id", "model", "speed", "volume", "pitch"}


def empty_master_audio() -> dict:
    return {
        "status": "missing",
        "timeline_status": "missing",
        "asset_id": None,
        "audio_url": "",
        "duration": 0.0,
        "sample_count": 0,
        "sample_rate": 0,
        "source_hash": "",
        "segment_offsets": [],
        "owns_asset": False,
        "word_timings": [],
        "timeline_source": "",
        "error": "",
        "timeline_error": "",
        "timeline_retryable": False,
        "job_id": None,
        "repair_generation": 0,
        "alignment_step_id": None,
        "alignment_attempt": 0,
        "alignment_claim_token": "",
        "alignment_claim_expires_at": 0.0,
    }


def empty_scene_plan() -> dict:
    return {
        "status": "missing",
        "generation_revision": 0,
        "master_source_hash": "",
        "scenes": [],
        "job_id": None,
        "error": "",
    }


def default_speech_segment(text: str, segment_id: str | None = None) -> dict:
    return {
        "id": segment_id or f"segment-{uuid4().hex}",
        "text": text,
        "status": "draft",
        "audio_url": "",
        "duration": 0.0,
        "word_timings": [],
        "source_hash": "",
        "generation_revision": 0,
        "error": "",
        "job_id": None,
    }


def _normalized_segment(raw: dict[str, Any], *, fallback_id: str | None = None) -> dict:
    segment = default_speech_segment(
        str(raw.get("text") or ""),
        segment_id=str(raw.get("id") or fallback_id or f"segment-{uuid4().hex}"),
    )
    for field in SEGMENT_SERVER_FIELDS:
        if field in raw:
            segment[field] = deepcopy(raw[field])
    if segment["status"] not in SPEECH_STATUSES:
        segment["status"] = "draft"
    segment["duration"] = max(0.0, float(segment["duration"] or 0))
    segment["generation_revision"] = max(
        0,
        int(segment["generation_revision"] or 0),
    )
    if not isinstance(segment["word_timings"], list):
        segment["word_timings"] = []
    return segment


def normalize_speech_segments(script: str, paragraphs: list[dict] | None) -> list[dict]:
    """Return exact, contiguous speech slices or one safe lossless slice."""
    script = str(script or "")
    raw_segments = [
        item for item in (paragraphs or [])
        if isinstance(item, dict)
    ]
    if raw_segments and "".join(str(item.get("text") or "") for item in raw_segments) == script:
        seen_ids: set[str] = set()
        normalized: list[dict] = []
        for item in raw_segments:
            segment = _normalized_segment(item)
            if segment["id"] in seen_ids:
                segment["id"] = f"segment-{uuid4().hex}"
            seen_ids.add(segment["id"])
            normalized.append(segment)
        return normalized

    fallback_id = None
    if len(raw_segments) == 1 and raw_segments[0].get("id"):
        fallback_id = str(raw_segments[0]["id"])
    return [default_speech_segment(script, segment_id=fallback_id)]


def speech_source_hash(text: str, voice_settings: dict, model: str) -> str:
    payload = json.dumps(
        {
            "text": text,
            "voice_settings": voice_settings,
            "model": model,
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _document_with_defaults(defaults: dict, value: Any) -> dict:
    return defaults | deepcopy(value if isinstance(value, dict) else {})


def _invalidate_segment(segment_id: str, text: str, previous: dict | None) -> dict:
    segment = default_speech_segment(text, segment_id=segment_id)
    if previous is not None:
        segment["generation_revision"] = (
            int(previous.get("generation_revision") or 0) + 1
        )
    return segment


def _mark_downstream_stale(project) -> None:
    master = _document_with_defaults(empty_master_audio(), project.master_audio)
    if master["status"] != "missing":
        master["status"] = "stale"
    if master["timeline_status"] != "missing":
        master["timeline_status"] = "stale"
    master["job_id"] = None
    master["error"] = ""
    master["timeline_error"] = ""
    project.master_audio = master

    scene_plan = _document_with_defaults(empty_scene_plan(), project.scene_plan)
    if scene_plan["status"] != "missing":
        scene_plan["status"] = "stale"
    scene_plan["job_id"] = None
    scene_plan["error"] = ""
    project.scene_plan = scene_plan

    render_input = deepcopy(project.render_input or {})
    render_input["audio"] = ""
    project.render_input = render_input


def _sanitize_voice_settings(current: dict, update: dict) -> dict:
    next_settings = {
        key: deepcopy(value)
        for key, value in (current or {}).items()
        if key in VOICE_SETTING_FIELDS
    }
    next_settings.update({
        key: deepcopy(value)
        for key, value in update.items()
        if key in VOICE_SETTING_FIELDS
    })
    return next_settings


def _sanitize_render_input(current: dict, update: dict) -> dict:
    """Keep legacy visual editing while never accepting browser-owned audio."""
    result = deepcopy(current or {})
    for field in ("templateId", "templateVersion", "composition", "segments", "templateProps"):
        if field in update:
            result[field] = deepcopy(update[field])
    return result


def _sanitize_scene(scene: dict) -> dict:
    fields = {
        "id",
        "fromWordId",
        "throughWordId",
        "displayText",
        "highlight",
        "animation",
    }
    return {key: deepcopy(value) for key, value in scene.items() if key in fields}


def merge_editable_project(project, update: dict, speech_model: str) -> None:
    """Merge browser-editable intent without trusting generated media state."""
    current_script = str(project.script or "")
    current_segments = normalize_speech_segments(
        current_script,
        project.paragraphs or [],
    )
    current_voice = _sanitize_voice_settings({}, project.voice_settings or {})
    next_voice = current_voice
    if isinstance(update.get("voice_settings"), dict):
        next_voice = _sanitize_voice_settings(
            current_voice,
            update["voice_settings"],
        )
    voice_changed = next_voice != current_voice

    paragraph_edits = update.get("paragraphs")
    script_supplied = "script" in update
    next_script = str(update.get("script") or "") if script_supplied else current_script

    if paragraph_edits is not None:
        editable_segments = [
            {
                "id": str(item.get("id") or f"segment-{uuid4().hex}"),
                "text": str(item.get("text") or ""),
            }
            for item in paragraph_edits
            if isinstance(item, dict)
        ]
        reconstructed = "".join(item["text"] for item in editable_segments)
        if script_supplied and reconstructed != next_script:
            raise ValueError("口播分段必须无损还原完整稿件")
        if not script_supplied:
            next_script = reconstructed
        if not editable_segments:
            editable_segments = [{
                "id": current_segments[0]["id"] if len(current_segments) == 1 else f"segment-{uuid4().hex}",
                "text": next_script,
            }]
    elif script_supplied:
        if len(current_segments) == 1:
            editable_segments = [{
                "id": current_segments[0]["id"],
                "text": next_script,
            }]
        else:
            editable_segments = [{
                "id": current_segments[0]["id"],
                "text": next_script,
            }]
    else:
        editable_segments = [
            {"id": segment["id"], "text": segment["text"]}
            for segment in current_segments
        ]

    if "".join(item["text"] for item in editable_segments) != next_script:
        raise ValueError("口播分段必须无损还原完整稿件")

    current_by_id = {segment["id"]: segment for segment in current_segments}
    next_segments: list[dict] = []
    invalidated = False
    resolved_model = str(next_voice.get("model") or speech_model)
    for edit in editable_segments:
        previous = current_by_id.get(edit["id"])
        expected_source_hash = speech_source_hash(
            edit["text"],
            next_voice,
            resolved_model,
        )
        source_hash_matches = (
            previous is not None
            and (
                not previous.get("source_hash")
                or previous["source_hash"] == expected_source_hash
            )
        )
        unchanged = (
            previous is not None
            and previous["text"] == edit["text"]
            and not voice_changed
            and source_hash_matches
        )
        if unchanged:
            next_segments.append(deepcopy(previous))
        else:
            next_segments.append(
                _invalidate_segment(edit["id"], edit["text"], previous),
            )
            invalidated = True

    structure_changed = (
        [item["id"] for item in next_segments]
        != [item["id"] for item in current_segments]
    )
    if structure_changed:
        invalidated = True

    project.script = next_script
    project.paragraphs = next_segments
    project.voice_settings = next_voice
    requested_split_mode = update.get("speech_split_mode")
    if len(next_segments) <= 1:
        project.speech_split_mode = "single"
    elif requested_split_mode in {"auto", "manual"}:
        project.speech_split_mode = requested_split_mode
    else:
        project.speech_split_mode = (
            project.speech_split_mode
            if project.speech_split_mode == "auto" and not structure_changed
            else "manual"
        )

    if invalidated or voice_changed:
        _mark_downstream_stale(project)

    for field in ("title", "status", "stage", "cover_asset_url", "output_asset_url"):
        if field in update:
            setattr(project, field, update[field])

    if isinstance(update.get("render_input"), dict):
        project.render_input = _sanitize_render_input(
            project.render_input or {},
            update["render_input"],
        )
    if isinstance(update.get("composition"), dict):
        render_input = deepcopy(project.render_input or {})
        render_input["composition"] = deepcopy(update["composition"])
        project.render_input = render_input
    if isinstance(update.get("template"), dict):
        render_input = deepcopy(project.render_input or {})
        template = update["template"]
        if "templateId" in template:
            render_input["templateId"] = template["templateId"]
        if "templateVersion" in template:
            render_input["templateVersion"] = template["templateVersion"]
        if "templateProps" in template:
            render_input["templateProps"] = deepcopy(template["templateProps"])
        project.render_input = render_input
    if isinstance(update.get("scene_plan"), dict):
        scene_plan = _document_with_defaults(empty_scene_plan(), project.scene_plan)
        scenes = update["scene_plan"].get("scenes")
        if isinstance(scenes, list):
            scene_plan["scenes"] = [
                _sanitize_scene(scene)
                for scene in scenes
                if isinstance(scene, dict)
            ]
            scene_plan["generation_revision"] = (
                int(scene_plan["generation_revision"] or 0) + 1
            )
        project.scene_plan = scene_plan

def video_stage_ready(project) -> bool:
    segments = normalize_speech_segments(
        str(project.script or ""),
        project.paragraphs or [],
    )
    master = _document_with_defaults(empty_master_audio(), project.master_audio)
    render_input = project.render_input or {}
    return bool(
        str(project.script or "").strip()
        and segments
        and all(
            not segment["text"].strip() or segment["status"] == "confirmed"
            for segment in segments
        )
        and master["status"] == "ready"
        and master["timeline_status"] == "ready"
        and master["audio_url"]
        and render_input.get("audio")
    )
