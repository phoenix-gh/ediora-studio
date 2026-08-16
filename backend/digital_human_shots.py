"""Talking-video shot list validation for the ComfyUI path."""

from __future__ import annotations

import json
import re
import uuid
from typing import Any

from digital_human_service import InvalidTalkingVideo


CHARS_PER_SECOND = 5
_SPLIT_CHARS = "。！？；…\n，、"
DEFAULT_DELIVERY = (
    "calm tutorial host; warm assured emotion; "
    "medium conversational speaking rate; clear Mandarin"
)
DEFAULT_PRESENCE = (
    "seated upright facing camera, torso still, "
    "slight head nods on clause ends, "
    "one-hand open-palm beat on key words, eyes on lens"
)
_MAX_DELIVERY_LEN = 240


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


_FRAMING_LABEL = {
    "wide": "wide shot",
    "medium": "medium shot",
    "close": "close-up",
}


def normalize_delivery(raw: Any, fallback: str = "") -> str:
    text = re.sub(r"\s+", " ", str(raw or "")).strip()
    if not text:
        text = re.sub(r"\s+", " ", str(fallback or "")).strip()
    return text[:_MAX_DELIVERY_LEN]


def effective_delivery(shot_delivery: str = "", base_delivery: str = "") -> str:
    return (
        normalize_delivery(shot_delivery)
        or normalize_delivery(base_delivery)
        or DEFAULT_DELIVERY
    )


def dialogue_language_tag(text: str) -> str:
    return "Chinese" if re.search(r"[\u4e00-\u9fff]", text) else "English"


def build_shot_prompt(
    framing: str,
    spoken_text: str,
    motion_prompt: str = "",
    delivery: str = "",
    base_delivery: str = "",
    presence: str = "",
    has_first_frame_reference: bool = False,
    has_pose_reference: bool = False,
) -> str:
    framing_label = _FRAMING_LABEL.get(framing, "medium shot")
    spoken = spoken_text.strip()
    motion = motion_prompt.strip()
    tone = effective_delivery(delivery, base_delivery)
    performance = normalize_delivery(presence) or DEFAULT_PRESENCE
    camera = (
        "Very slow push-in. Eye-level. No shake."
        if framing == "close"
        else "Static locked-off camera. Eye-level. No pan, tilt, or zoom."
    )
    action = f"{motion} " if motion else ""
    lang = dialogue_language_tag(spoken)
    has_first_frame = has_first_frame_reference or has_pose_reference
    subjects = [
        "<Subject 1> is the person in <Picture 1>, same face, hair, clothing, and body proportions.",
    ]
    if has_first_frame:
        subjects.append(
            "<Picture 3> is the last frame of the previous clip and the first frame of this shot."
        )
    opening = (
        (
            "At 0.00 seconds, <Picture 3> is fully referenced as the first frame. "
            f"<Subject 1> faces the camera in <Background 1>, matching that opening pose. "
            f"{action}"
            f"<Subject 1> (S1) uses a {tone} delivery. "
            "Emotion, cadence, and speaking rate come from this prompt, not from <Audio 1>."
        )
        if has_first_frame
        else (
            f"<Subject 1> faces the camera in <Background 1> and is already speaking. "
            f"{action}"
            f"<Subject 1> (S1) uses a {tone} delivery. "
            "Emotion, cadence, and speaking rate come from this prompt, not from <Audio 1>."
        )
    )
    onset = (
        "Start speaking from that exact pose; the first syllable begins immediately "
        "after the opening frame, with no long still hold."
        if has_first_frame
        else "Already talking at the first frame; no silent intro and no fade-in from a still pose."
    )
    return "\n".join(
        [
            "Video Description:",
            opening,
            (
                f'<Subject 1> (S1) says ONLY this quoted line and then stops: '
                f'<d>[{lang}] {spoken}</d>'
            ),
            (
                f"Performance: {performance}. "
                "Gestures stay small and speech-synced: a slight head nod or one-hand "
                "open-palm beat on stressed words; shoulders stay settled; "
                "no standing up, walking, or waving."
            ),
            onset,
            "No extra words, no filler, no humming, and no invented syllables after the line ends.",
            "Exactly as the last word ends, lips meet, the jaw stops, and the talking pose holds in silence.",
            (
                "Uses <Audio 1> only as voice timbre. "
                "Do not copy words, emotion, rhythm, or pace from <Audio 1>. "
                "No music. No on-screen text, captions, logos, or subtitles."
            ),
            "",
            "Camera Movement:",
            camera,
            "",
            "Shot Type:",
            f"{framing_label}, 16:9.",
            "",
            "Style:",
            "Clean studio presentation. Soft key from camera-left, natural skin texture.",
            "",
            "Subjects:",
            *subjects,
            "",
            "Background:",
            "<Background 1> is the environment in <Picture 2>, unchanged lighting and set dressing.",
        ]
    )


def new_blank_shot(duration_sec: int) -> dict[str, Any]:
    return {
        "id": str(uuid.uuid4()),
        "duration_sec": duration_sec,
        "framing": "medium",
        "spoken_text": "",
        "motion_prompt": "",
        "delivery": "",
        "render_prompt": "",
        "first_frame_asset_id": None,
        "clip_asset_id": None,
        "status": "draft",
        "job_id": None,
        "error": "",
        "workflow_version": "",
        "seed": None,
        "provider_state": {},
    }


def shot_requires_previous_clip(shots: list[dict[str, Any]], shot_id: str) -> bool:
    for index, item in enumerate(shots):
        if item.get("id") == shot_id:
            return index > 0
    return False


def previous_succeeded_clip_id(shots: list[dict[str, Any]], shot_id: str) -> int | None:
    for index, item in enumerate(shots):
        if item.get("id") != shot_id:
            continue
        for prior in reversed(shots[:index]):
            clip_id = prior.get("clip_asset_id")
            if prior.get("status") == "succeeded" and isinstance(clip_id, int):
                return clip_id
        return None
    return None


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


def _visible_len(text: str) -> int:
    return sum(1 for char in text if not char.isspace())


def estimate_shot_seconds(text: str, min_seconds: int, max_seconds: int) -> int:
    chars = _visible_len(text)
    if chars <= 0:
        return min_seconds
    guessed = max(min_seconds, (chars + CHARS_PER_SECOND - 1) // CHARS_PER_SECOND)
    return min(max_seconds, guessed)


def split_overlong_text(text: str, max_seconds: int) -> list[str]:
    max_chars = max(1, max_seconds * CHARS_PER_SECOND)
    if _visible_len(text) <= max_chars:
        return [text] if text else []
    pieces: list[str] = []
    start = 0
    visible = 0
    last_break: int | None = None
    for index, char in enumerate(text):
        if not char.isspace():
            visible += 1
        if char in _SPLIT_CHARS:
            last_break = index + 1
        if visible >= max_chars and index + 1 > start:
            cut = last_break if last_break and last_break > start else index + 1
            piece = text[start:cut]
            if piece:
                pieces.append(piece)
            start = cut
            visible = _visible_len(text[start:index + 1])
            last_break = None
    if start < len(text):
        pieces.append(text[start:])
    return pieces or [text]


def parse_shot_plan_segments(raw: str) -> list[dict[str, Any]]:
    text = raw.strip()
    match = re.search(r"\[[\s\S]*\]", text)
    if not match:
        raise InvalidTalkingVideo("模型未返回有效的镜头 JSON")
    try:
        payload = json.loads(match.group(0))
    except json.JSONDecodeError as exc:
        raise InvalidTalkingVideo("模型返回的镜头 JSON 无法解析") from exc
    if not isinstance(payload, list) or not payload:
        raise InvalidTalkingVideo("模型未返回镜头列表")
    segments: list[dict[str, Any]] = []
    for item in payload:
        if not isinstance(item, dict):
            raise InvalidTalkingVideo("镜头格式无效")
        spoken = str(item.get("text") or "")
        if not spoken:
            raise InvalidTalkingVideo("镜头对白不能为空")
        framing = str(item.get("framing") or "medium").strip()
        if framing not in FRAMINGS:
            framing = "medium"
        segments.append({
            "text": spoken,
            "framing": framing,
            "delivery": normalize_delivery(item.get("delivery")),
        })
    return segments


def parse_piece_voice(raw: str) -> tuple[str, str]:
    text = raw.strip()
    match = re.search(r"\{[\s\S]*\}", text)
    if not match:
        return "", ""
    try:
        payload = json.loads(match.group(0))
    except json.JSONDecodeError:
        return "", ""
    if not isinstance(payload, dict):
        return "", ""
    delivery = normalize_delivery(
        payload.get("delivery")
        or payload.get("tone")
        or payload.get("语气")
    )
    presence = normalize_delivery(
        payload.get("presence")
        or payload.get("state")
        or payload.get("状态")
    )
    return delivery, presence


def parse_shot_plan_document(raw: str) -> dict[str, Any]:
    text = raw.strip()
    object_match = re.search(r"\{[\s\S]*\}", text)
    if object_match:
        try:
            payload = json.loads(object_match.group(0))
        except json.JSONDecodeError:
            payload = None
        if isinstance(payload, dict) and isinstance(payload.get("shots"), list):
            wrapped = json.dumps(payload["shots"])
            delivery, presence = parse_piece_voice(object_match.group(0))
            return {
                "delivery": delivery,
                "presence": presence,
                "shots": parse_shot_plan_segments(wrapped),
            }
    return {
        "delivery": "",
        "presence": "",
        "shots": parse_shot_plan_segments(raw),
    }


def fallback_plan_segments(script: str, max_seconds: int) -> list[dict[str, Any]]:
    max_chars = max(1, max_seconds * CHARS_PER_SECOND)
    pieces = re.split(r"(?<=[。！？；…\n])", script)
    chunks: list[str] = []
    buf = ""
    for piece in pieces:
        if not piece:
            continue
        candidate = buf + piece
        if buf and _visible_len(candidate) > max_chars:
            chunks.append(buf)
            buf = piece
        else:
            buf = candidate
    if buf:
        chunks.append(buf)
    if not chunks:
        chunks = [script]
    segments: list[dict[str, Any]] = []
    for chunk in chunks:
        for piece in split_overlong_text(chunk, max_seconds):
            if piece:
                segments.append({"text": piece, "framing": "medium"})
    if not segments or "".join(item["text"] for item in segments) != script:
        return [{"text": script, "framing": "medium"}]
    return segments


def apply_planned_segments(
    script: str,
    segments: list[dict[str, Any]],
    min_seconds: int,
    max_seconds: int,
    base_delivery: str = "",
    presence: str = "",
) -> list[dict[str, Any]]:
    source = script
    if not source:
        raise InvalidTalkingVideo("请先填写全文口播")
    if not segments:
        raise InvalidTalkingVideo("至少需要一个镜头")
    joined = "".join(str(item.get("text") or "") for item in segments)
    if joined != source:
        raise InvalidTalkingVideo("分段必须无损还原全文")
    shots: list[dict[str, Any]] = []
    for item in segments:
        framing = str(item.get("framing") or "medium")
        if framing not in FRAMINGS:
            framing = "medium"
        delivery = effective_delivery(str(item.get("delivery") or ""), base_delivery)
        for piece in split_overlong_text(str(item.get("text") or ""), max_seconds):
            shot = new_blank_shot(estimate_shot_seconds(piece, min_seconds, max_seconds))
            shot["spoken_text"] = piece
            shot["framing"] = framing
            shot["delivery"] = delivery
            shot["render_prompt"] = build_shot_prompt(
                framing, piece, delivery=delivery, presence=presence
            )
            shots.append(shot)
    if not shots:
        raise InvalidTalkingVideo("至少需要一个镜头")
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
        "delivery": normalize_delivery(raw.get("delivery")),
        "render_prompt": str(raw.get("render_prompt") or ""),
        "first_frame_asset_id": first_frame if isinstance(first_frame, int) else None,
        "clip_asset_id": clip if isinstance(clip, int) else None,
        "status": status,
        "job_id": job_id if isinstance(job_id, int) else None,
        "error": str(raw.get("error") or "")[:500],
        "workflow_version": str(raw.get("workflow_version") or ""),
        "seed": seed if isinstance(seed, int) else None,
        "provider_state": provider_state if isinstance(provider_state, dict) else {},
    }
