from __future__ import annotations

from copy import deepcopy
import math
from typing import Any

from text_video_templates import get_text_video_template


CONTINUITY_EPSILON_SECONDS = 0.001
MAX_SAFE_INTEGER = 9_007_199_254_740_991
SCENE_FIELDS = {
    "id",
    "fromWordId",
    "throughWordId",
    "displayText",
    "highlight",
    "animation",
}
RENDER_SEGMENT_FIELDS = {
    "id",
    "start",
    "end",
    "text",
    "highlight",
    "animation",
}
RENDER_INPUT_FIELDS = {
    "templateId",
    "templateVersion",
    "composition",
    "audio",
    "segments",
    "templateProps",
}
COMPOSITION_FIELDS = {"width", "height", "fps"}


def _is_finite_number(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


def _require_nonblank(value: Any, message: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(message)
    return value


def _validate_highlights(
    highlights: Any,
    display_text: str,
) -> list[str]:
    if not isinstance(highlights, list) or not all(
        isinstance(item, str) for item in highlights
    ):
        raise ValueError("分镜高亮必须是字符串列表")
    for highlight in highlights:
        if highlight and highlight not in display_text:
            raise ValueError("分镜高亮必须出现在展示文字中")
    return deepcopy(highlights)


def _word_indexes(words: list[dict]) -> dict[str, int]:
    if not isinstance(words, list) or not words:
        raise ValueError("全局词时间轴不能为空")
    indexes: dict[str, int] = {}
    for index, word in enumerate(words):
        if not isinstance(word, dict):
            raise ValueError("全局词时间轴格式无效")
        word_id = _require_nonblank(
            word.get("id"),
            "全局词时间轴的词 ID 不能为空",
        )
        if word_id in indexes:
            raise ValueError("全局词时间轴的词 ID 不能重复")
        indexes[word_id] = index
    return indexes


def _validate_word_timeline(
    words: list[dict],
    master_duration: float,
) -> None:
    if not _is_finite_number(master_duration) or master_duration <= 0:
        raise ValueError("主音频时长必须是有限正数")
    _word_indexes(words)

    previous_start = -1.0
    previous_end = -1.0
    for word in words:
        start = word.get("start")
        end = word.get("end")
        if (
            not _is_finite_number(start)
            or not _is_finite_number(end)
            or start < 0
            or end < start
            or start < previous_start
            or end < previous_end
            or end > master_duration + CONTINUITY_EPSILON_SECONDS
        ):
            raise ValueError("全局词时间轴必须有限、有序且位于主音频内")
        previous_start = float(start)
        previous_end = float(end)


def validate_template_configuration(
    *,
    manifest: dict,
    composition: dict,
    template_props: dict,
) -> tuple[dict, dict]:
    if not isinstance(composition, dict) or set(composition) != COMPOSITION_FIELDS:
        raise ValueError("画面配置字段无效")
    for field in COMPOSITION_FIELDS:
        value = composition.get(field)
        if (
            not isinstance(value, int)
            or isinstance(value, bool)
            or value <= 0
            or value > MAX_SAFE_INTEGER
        ):
            raise ValueError("画面尺寸与帧率必须是正安全整数")

    width = composition["width"]
    height = composition["height"]
    if width == height:
        ratio = "1:1"
    elif width * 16 == height * 9:
        ratio = "9:16"
    elif width * 9 == height * 16:
        ratio = "16:9"
    else:
        raise ValueError("画面比例仅支持模板声明的比例")
    if ratio not in manifest["aspect_ratios"]:
        raise ValueError("当前模板不支持该画面比例")

    capabilities = manifest["template_props"]
    if not isinstance(template_props, dict) or set(template_props) != set(
        capabilities,
    ):
        raise ValueError("模板参数字段必须与版本化清单完全一致")
    for key, allowed_values in capabilities.items():
        value = template_props.get(key)
        if not isinstance(value, str) or value not in allowed_values:
            raise ValueError(f"当前模板不支持参数 {key}={value}")
    return deepcopy(composition), deepcopy(template_props)


def validate_scene_partition(
    proposals: list[dict],
    words: list[dict],
    manifest: dict,
) -> list[dict]:
    indexes = _word_indexes(words)
    if not isinstance(proposals, list) or not proposals:
        raise ValueError("分镜词范围必须完整且连续")

    cursor = 0
    scene_ids: set[str] = set()
    validated: list[dict] = []
    for scene in proposals:
        if not isinstance(scene, dict) or set(scene) != SCENE_FIELDS:
            raise ValueError("分镜仅允许词范围与视觉意图字段")
        scene_id = _require_nonblank(scene.get("id"), "分镜 ID 不能为空")
        if scene_id in scene_ids:
            raise ValueError("分镜 ID 不能重复")
        scene_ids.add(scene_id)

        from_word_id = _require_nonblank(
            scene.get("fromWordId"),
            "分镜起始词 ID 不能为空",
        )
        through_word_id = _require_nonblank(
            scene.get("throughWordId"),
            "分镜结束词 ID 不能为空",
        )
        from_index = indexes.get(from_word_id)
        through_index = indexes.get(through_word_id)
        if (
            from_index is None
            or through_index is None
            or from_index != cursor
            or through_index < from_index
        ):
            raise ValueError("分镜词范围必须完整且连续")

        display_text = _require_nonblank(
            scene.get("displayText"),
            "分镜展示文字不能为空",
        )
        animation = _require_nonblank(
            scene.get("animation"),
            "分镜动画不能为空",
        )
        if animation not in manifest["animations"]:
            raise ValueError(f"当前模板不支持动画：{animation}")

        validated.append({
            "id": scene_id,
            "fromWordId": from_word_id,
            "throughWordId": through_word_id,
            "displayText": display_text,
            "highlight": _validate_highlights(
                scene.get("highlight"),
                display_text,
            ),
            "animation": animation,
        })
        cursor = through_index + 1

    if cursor != len(words):
        raise ValueError("分镜词范围必须完整且连续")
    return validated


def resolve_scene_seconds(
    proposals: list[dict],
    words: list[dict],
    master_duration: float,
    manifest: dict,
) -> list[dict]:
    _validate_word_timeline(words, master_duration)
    scenes = validate_scene_partition(proposals, words, manifest)
    indexes = _word_indexes(words)

    boundaries: list[float] = [0.0]
    boundaries.extend(
        float(words[indexes[scene["fromWordId"]]]["start"])
        for scene in scenes[1:]
    )
    boundaries.append(float(master_duration))
    for index in range(len(boundaries) - 1):
        if boundaries[index + 1] <= boundaries[index]:
            raise ValueError("分镜投影后的秒数范围必须为正")

    return [
        {
            "id": scene["id"],
            "start": boundaries[index],
            "end": boundaries[index + 1],
            "text": scene["displayText"],
            "highlight": deepcopy(scene["highlight"]),
            "animation": scene["animation"],
        }
        for index, scene in enumerate(scenes)
    ]


def validate_render_input_projection(
    render_input: dict,
    *,
    master_duration: float,
) -> dict:
    if not _is_finite_number(master_duration) or master_duration <= 0:
        raise ValueError("主音频时长必须是有限正数")
    if not isinstance(render_input, dict) or set(render_input) != RENDER_INPUT_FIELDS:
        raise ValueError("渲染输入字段无效")

    template_id = _require_nonblank(
        render_input.get("templateId"),
        "模板 ID 不能为空",
    )
    version = render_input.get("templateVersion")
    if (
        not isinstance(version, int)
        or isinstance(version, bool)
        or version <= 0
        or version > MAX_SAFE_INTEGER
    ):
        raise ValueError("模板版本必须是正安全整数")
    manifest = get_text_video_template(template_id, version)
    composition, template_props = validate_template_configuration(
        manifest=manifest,
        composition=render_input.get("composition"),
        template_props=render_input.get("templateProps"),
    )
    audio = render_input.get("audio")
    if not isinstance(audio, str):
        raise ValueError("渲染音频地址无效")

    raw_segments = render_input.get("segments")
    if not isinstance(raw_segments, list) or not raw_segments:
        raise ValueError("渲染分镜不能为空")
    segments: list[dict] = []
    ids: set[str] = set()
    for raw in raw_segments:
        if not isinstance(raw, dict) or set(raw) != RENDER_SEGMENT_FIELDS:
            raise ValueError("渲染分镜字段无效")
        segment_id = _require_nonblank(raw.get("id"), "渲染分镜 ID 不能为空")
        if segment_id in ids:
            raise ValueError("渲染分镜 ID 不能重复")
        ids.add(segment_id)
        start = raw.get("start")
        end = raw.get("end")
        if (
            not _is_finite_number(start)
            or not _is_finite_number(end)
            or start < 0
            or end <= start
        ):
            raise ValueError("渲染分镜秒数必须是有限正范围")
        text = _require_nonblank(raw.get("text"), "渲染分镜文字不能为空")
        animation = _require_nonblank(
            raw.get("animation"),
            "渲染分镜动画不能为空",
        )
        if animation not in manifest["animations"]:
            raise ValueError(f"当前模板不支持动画：{animation}")
        segments.append({
            "id": segment_id,
            "start": float(start),
            "end": float(end),
            "text": text,
            "highlight": _validate_highlights(raw.get("highlight"), text),
            "animation": animation,
        })

    if abs(segments[0]["start"]) > CONTINUITY_EPSILON_SECONDS:
        raise ValueError("渲染分镜必须连续覆盖主音频")
    for index in range(1, len(segments)):
        if abs(
            segments[index]["start"] - segments[index - 1]["end"]
        ) > CONTINUITY_EPSILON_SECONDS:
            raise ValueError("渲染分镜必须连续覆盖主音频")
    if abs(segments[-1]["end"] - master_duration) > CONTINUITY_EPSILON_SECONDS:
        raise ValueError("渲染分镜必须连续覆盖主音频")

    return {
        "templateId": template_id,
        "templateVersion": version,
        "composition": composition,
        "audio": audio,
        "segments": segments,
        "templateProps": template_props,
    }
