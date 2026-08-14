"""Talking-video shot list validation for the ComfyUI path."""

from __future__ import annotations

import uuid
from typing import Any

from digital_human_service import InvalidTalkingVideo


FRAMINGS = {"wide", "medium", "close"}
SHOT_STATUSES = {"draft", "queued", "running", "succeeded", "failed"}


def effective_shot_duration_bounds(
    min_setting: int,
    max_setting: int,
    workflow_min: int = 4,
    workflow_max: int = 15,
) -> tuple[int, int]:
    minimum = max(min_setting, workflow_min)
    maximum = min(max_setting, workflow_max)
    if minimum > maximum:
        raise InvalidTalkingVideo("单镜时长配置无效，请检查设置和工作流")
    return minimum, maximum


def new_blank_shot(duration_sec: int) -> dict[str, Any]:
    return {
        "id": str(uuid.uuid4()),
        "duration_sec": duration_sec,
        "framing": "medium",
        "spoken_text": "",
        "motion_prompt": "",
        "first_frame_asset_id": None,
        "clip_asset_id": None,
        "status": "draft",
        "job_id": None,
        "error": "",
        "workflow_version": "",
        "seed": None,
        "provider_state": {},
    }


def script_from_shots(shots: list[dict[str, Any]]) -> str:
    return "\n\n".join(
        str(shot.get("spoken_text") or "").strip()
        for shot in shots
        if str(shot.get("spoken_text") or "").strip()
    )


def replace_shot(
    shots: list[dict[str, Any]],
    shot_id: str,
    updates: dict[str, Any],
) -> list[dict[str, Any]]:
    replaced = False
    next_shots: list[dict[str, Any]] = []
    for shot in shots:
        if shot.get("id") == shot_id:
            next_shots.append({**shot, **updates})
            replaced = True
        else:
            next_shots.append(dict(shot))
    if not replaced:
        raise InvalidTalkingVideo("镜头不存在")
    return next_shots


def find_shot(shots: list[dict[str, Any]], shot_id: str) -> dict[str, Any]:
    for shot in shots:
        if shot.get("id") == shot_id:
            return shot
    raise InvalidTalkingVideo("镜头不存在")


def normalize_shots(
    raw: Any,
    min_seconds: int,
    max_seconds: int,
) -> list[dict[str, Any]]:
    if not isinstance(raw, list) or not raw:
        raise InvalidTalkingVideo("至少需要一个镜头")
    shots = [
        _normalize_shot(item, min_seconds, max_seconds)
        for item in raw
    ]
    ids = [shot["id"] for shot in shots]
    if len(ids) != len(set(ids)):
        raise InvalidTalkingVideo("镜头 ID 重复")
    return shots


def _normalize_shot(
    raw: Any,
    min_seconds: int,
    max_seconds: int,
) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise InvalidTalkingVideo("镜头格式无效")
    shot_id = str(raw.get("id") or "").strip() or str(uuid.uuid4())
    try:
        duration = int(raw.get("duration_sec"))
    except (TypeError, ValueError) as exc:
        raise InvalidTalkingVideo("镜头时长无效") from exc
    if duration < min_seconds or duration > max_seconds:
        raise InvalidTalkingVideo(
            f"镜头时长必须在 {min_seconds}–{max_seconds} 秒之间"
        )
    framing = str(raw.get("framing") or "medium").strip()
    if framing not in FRAMINGS:
        raise InvalidTalkingVideo("镜头景别无效")
    status = str(raw.get("status") or "draft")
    if status not in SHOT_STATUSES:
        status = "draft"
    first_frame = raw.get("first_frame_asset_id")
    clip = raw.get("clip_asset_id")
    job_id = raw.get("job_id")
    seed = raw.get("seed")
    provider_state = raw.get("provider_state")
    return {
        "id": shot_id,
        "duration_sec": duration,
        "framing": framing,
        "spoken_text": str(raw.get("spoken_text") or ""),
        "motion_prompt": str(raw.get("motion_prompt") or ""),
        "first_frame_asset_id": first_frame if isinstance(first_frame, int) else None,
        "clip_asset_id": clip if isinstance(clip, int) else None,
        "status": status,
        "job_id": job_id if isinstance(job_id, int) else None,
        "error": str(raw.get("error") or "")[:500],
        "workflow_version": str(raw.get("workflow_version") or ""),
        "seed": seed if isinstance(seed, int) else None,
        "provider_state": provider_state if isinstance(provider_state, dict) else {},
    }
