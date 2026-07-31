from __future__ import annotations

from copy import deepcopy
import math
from typing import Any

from text_video_templates import (
    get_text_video_template,
    normalize_text_video_template_props,
)


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
SCENE_OPTIONAL_FIELDS = {"motion"}
MOTION_FIELDS = {"transition", "intensity", "chunks"}
MOTION_CHUNK_FIELDS = {
    "id",
    "fromWordId",
    "throughWordId",
    "displayText",
    "highlight",
    "motionPreset",
    "emphasis",
}
MOTION_PRESETS = {"impact", "reveal", "contrast"}
MOTION_EMPHASIS = {"normal", "punch"}
RENDER_SEGMENT_FIELDS = {
    "id",
    "start",
    "end",
    "text",
    "highlight",
    "animation",
}
RENDER_MOTION_FIELDS = {"transition", "intensity", "chunks"}
RENDER_CHUNK_FIELDS = {
    "id",
    "start",
    "end",
    "text",
    "motionPreset",
    "emphasis",
    "words",
}
RENDER_WORD_FIELDS = {"text", "start", "end", "emphasis"}
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


def _without_whitespace(value: str) -> str:
    return "".join(value.split())


def _validate_scene_motion(
    motion: Any,
    *,
    scene: dict,
    words: list[dict],
    indexes: dict[str, int],
) -> dict | None:
    if motion is None:
        return None
    if not isinstance(motion, dict) or set(motion) != MOTION_FIELDS:
        raise ValueError("动效编排字段无效")
    if motion.get("transition") != "block-wipe":
        raise ValueError("动效编排转场无效")
    intensity = motion.get("intensity")
    if (
        not _is_finite_number(intensity)
        or intensity < 0
        or intensity > 1
    ):
        raise ValueError("动效编排强度必须位于 0 到 1")

    chunks = motion.get("chunks")
    if not isinstance(chunks, list) or not chunks:
        raise ValueError("动效短句不能为空")
    parent_start = indexes[scene["fromWordId"]]
    parent_end = indexes[scene["throughWordId"]]
    cursor = parent_start
    chunk_ids: set[str] = set()
    validated_chunks: list[dict] = []
    for chunk in chunks:
        if not isinstance(chunk, dict) or set(chunk) != MOTION_CHUNK_FIELDS:
            raise ValueError("动效短句字段无效")
        chunk_id = _require_nonblank(
            chunk.get("id"),
            "动效短句 ID 不能为空",
        )
        if chunk_id in chunk_ids:
            raise ValueError("动效短句 ID 不能重复")
        chunk_ids.add(chunk_id)

        from_word_id = _require_nonblank(
            chunk.get("fromWordId"),
            "动效短句起始词 ID 不能为空",
        )
        through_word_id = _require_nonblank(
            chunk.get("throughWordId"),
            "动效短句结束词 ID 不能为空",
        )
        from_index = indexes.get(from_word_id)
        through_index = indexes.get(through_word_id)
        if (
            from_index is None
            or through_index is None
            or from_index != cursor
            or through_index < from_index
            or through_index > parent_end
        ):
            raise ValueError("动效短句词范围必须完整且连续")

        display_text = _require_nonblank(
            chunk.get("displayText"),
            "动效短句展示文字不能为空",
        )
        motion_preset = _require_nonblank(
            chunk.get("motionPreset"),
            "动效短句预设不能为空",
        )
        if motion_preset not in MOTION_PRESETS:
            raise ValueError(f"动效短句预设无效：{motion_preset}")
        emphasis = _require_nonblank(
            chunk.get("emphasis"),
            "动效短句强调不能为空",
        )
        if emphasis not in MOTION_EMPHASIS:
            raise ValueError(f"动效短句强调无效：{emphasis}")

        validated_chunks.append({
            "id": chunk_id,
            "fromWordId": from_word_id,
            "throughWordId": through_word_id,
            "displayText": display_text,
            "highlight": _validate_highlights(
                chunk.get("highlight"),
                display_text,
            ),
            "motionPreset": motion_preset,
            "emphasis": emphasis,
        })
        cursor = through_index + 1

    if cursor != parent_end + 1:
        raise ValueError("动效短句词范围必须完整且连续")
    combined_text = "".join(
        chunk["displayText"] for chunk in validated_chunks
    )
    if _without_whitespace(combined_text) != _without_whitespace(
        scene["displayText"],
    ):
        raise ValueError("动效短句必须完整覆盖分镜展示文字")
    return {
        "transition": "block-wipe",
        "intensity": float(intensity),
        "chunks": validated_chunks,
    }


def _highlighted_word_positions(
    words: list[dict],
    highlights: list[str],
    *,
    fallback_to_final: bool,
) -> set[int]:
    normalized_words = [_without_whitespace(str(word["text"])) for word in words]
    joined = "".join(normalized_words)
    spans: list[tuple[int, int]] = []
    cursor = 0
    for text in normalized_words:
        spans.append((cursor, cursor + len(text)))
        cursor += len(text)

    positions: set[int] = set()
    for highlight in highlights:
        needle = _without_whitespace(highlight)
        if not needle:
            continue
        start = joined.find(needle)
        while start >= 0:
            end = start + len(needle)
            positions.update(
                index
                for index, (word_start, word_end) in enumerate(spans)
                if word_start < end and word_end > start
            )
            start = joined.find(needle, start + 1)
    if fallback_to_final and highlights and not positions and words:
        positions.add(len(words) - 1)
    return positions


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


def validate_word_timeline(
    words: list[dict],
    master_duration: float,
) -> list[dict]:
    _validate_word_timeline(words, master_duration)
    return deepcopy(words)


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

    template_props = normalize_text_video_template_props(
        manifest,
        template_props,
        fill_missing=True,
    )
    return deepcopy(composition), template_props


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
        if (
            not isinstance(scene, dict)
            or not SCENE_FIELDS.issubset(scene)
            or set(scene) - SCENE_FIELDS - SCENE_OPTIONAL_FIELDS
        ):
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

        validated_scene = {
            "id": scene_id,
            "fromWordId": from_word_id,
            "throughWordId": through_word_id,
            "displayText": display_text,
            "highlight": _validate_highlights(
                scene.get("highlight"),
                display_text,
            ),
            "animation": animation,
        }
        motion = _validate_scene_motion(
            scene.get("motion"),
            scene=validated_scene,
            words=words,
            indexes=indexes,
        )
        if motion is not None:
            validated_scene["motion"] = motion
        validated.append(validated_scene)
        cursor = through_index + 1

    if cursor != len(words):
        raise ValueError("分镜词范围必须完整且连续")
    return validated


def canonicalize_scene_generation_proposal(
    *,
    proposals: list[dict],
    words: list[dict],
    manifest: dict,
    scope: str,
    selected_scene_id: str,
    existing_scenes: list[dict],
) -> list[dict]:
    if scope == "all":
        return validate_scene_partition(proposals, words, manifest)
    if scope != "selected":
        raise ValueError("AI 分镜生成范围无效")

    existing = validate_scene_partition(
        existing_scenes,
        words,
        manifest,
    )
    if not selected_scene_id or len(proposals) != 1:
        raise ValueError("选中分镜生成必须只返回一个分镜")
    selected_index = next(
        (
            index
            for index, scene in enumerate(existing)
            if scene["id"] == selected_scene_id
        ),
        None,
    )
    if selected_index is None:
        raise ValueError("目标分镜不存在")
    proposal = proposals[0]
    selected = existing[selected_index]
    if (
        not isinstance(proposal, dict)
        or proposal.get("id") != selected["id"]
        or proposal.get("fromWordId") != selected["fromWordId"]
        or proposal.get("throughWordId") != selected["throughWordId"]
    ):
        raise ValueError("目标分镜 ID 与词边界不能改变")
    merged = deepcopy(existing)
    merged[selected_index] = deepcopy(proposal)
    return validate_scene_partition(merged, words, manifest)


def _motion_scene_with_frozen_visuals(
    proposal: dict,
    frozen: dict,
) -> dict:
    if not isinstance(proposal, dict):
        raise ValueError("AI 动效分镜格式无效")
    frozen_visuals = {
        key: deepcopy(frozen.get(key))
        for key in (
            "id",
            "fromWordId",
            "throughWordId",
            "displayText",
            "highlight",
            "animation",
        )
    }
    proposal_visuals = {
        key: deepcopy(proposal.get(key))
        for key in frozen_visuals
    }
    if proposal_visuals != frozen_visuals:
        raise ValueError("AI 动效不能改变分镜文字、词边界或视觉字段")
    if proposal.get("motion") is None:
        raise ValueError("AI 动效结果缺少 motion")
    return deepcopy(proposal)


def canonicalize_motion_generation_proposal(
    *,
    proposals: list[dict],
    words: list[dict],
    manifest: dict,
    scope: str,
    selected_scene_id: str,
    existing_scenes: list[dict],
) -> list[dict]:
    existing = validate_scene_partition(
        existing_scenes,
        words,
        manifest,
    )
    if scope == "all":
        if len(proposals) != len(existing):
            raise ValueError("AI 动效必须保留完整分镜数量")
        merged = [
            _motion_scene_with_frozen_visuals(proposal, frozen)
            for proposal, frozen in zip(proposals, existing, strict=True)
        ]
    elif scope == "selected":
        if not selected_scene_id or len(proposals) != 1:
            raise ValueError("选中分镜动效生成必须只返回一个分镜")
        selected_index = next(
            (
                index
                for index, scene in enumerate(existing)
                if scene["id"] == selected_scene_id
            ),
            None,
        )
        if selected_index is None:
            raise ValueError("目标分镜不存在")
        merged = deepcopy(existing)
        merged[selected_index] = _motion_scene_with_frozen_visuals(
            proposals[0],
            existing[selected_index],
        )
    else:
        raise ValueError("AI 动效生成范围无效")
    return validate_scene_partition(merged, words, manifest)


def validate_canonical_motion_result(
    *,
    proposals: list[dict],
    words: list[dict],
    manifest: dict,
    scope: str,
    selected_scene_id: str,
    existing_scenes: list[dict],
) -> list[dict]:
    existing = validate_scene_partition(
        existing_scenes,
        words,
        manifest,
    )
    if len(proposals) != len(existing):
        raise ValueError("AI 动效结果必须保留完整分镜计划")
    for proposal, frozen in zip(proposals, existing, strict=True):
        if (
            scope == "selected"
            and frozen["id"] != selected_scene_id
            and proposal != frozen
        ):
            raise ValueError("非目标分镜不能改变")
        _motion_scene_with_frozen_visuals(proposal, frozen)
    if (
        scope == "selected"
        and not any(scene["id"] == selected_scene_id for scene in existing)
    ):
        raise ValueError("目标分镜不存在")
    if scope not in {"all", "selected"}:
        raise ValueError("AI 动效生成范围无效")
    return validate_scene_partition(proposals, words, manifest)


def validate_canonical_scene_result(
    *,
    proposals: list[dict],
    words: list[dict],
    manifest: dict,
    scope: str,
    selected_scene_id: str,
    existing_scenes: list[dict],
) -> list[dict]:
    if scope == "all":
        return validate_scene_partition(proposals, words, manifest)
    if scope != "selected":
        raise ValueError("AI 分镜生成范围无效")

    existing = validate_scene_partition(
        existing_scenes,
        words,
        manifest,
    )
    if len(proposals) != len(existing):
        raise ValueError("选中分镜结果必须保留完整分镜计划")
    for current, frozen in zip(proposals, existing, strict=True):
        if not isinstance(current, dict):
            raise ValueError("选中分镜结果格式无效")
        if current.get("id") != frozen["id"]:
            raise ValueError("选中分镜结果不能改变分镜顺序或 ID")
        if (
            current.get("fromWordId") != frozen["fromWordId"]
            or current.get("throughWordId") != frozen["throughWordId"]
        ):
            raise ValueError("目标分镜 ID 与词边界不能改变")
        if frozen["id"] != selected_scene_id and current != frozen:
            raise ValueError("非目标分镜不能改变")
    if not any(scene["id"] == selected_scene_id for scene in existing):
        raise ValueError("目标分镜不存在")
    return validate_scene_partition(proposals, words, manifest)


def _resolve_motion_chunks(
    scene: dict,
    words: list[dict],
    indexes: dict[str, int],
    *,
    scene_start: float,
    scene_end: float,
) -> list[dict]:
    motion = scene["motion"]
    chunks = motion["chunks"]
    resolved: list[dict] = []
    for index, chunk in enumerate(chunks):
        from_index = indexes[chunk["fromWordId"]]
        through_index = indexes[chunk["throughWordId"]]
        source_words = words[from_index:through_index + 1]
        highlighted = _highlighted_word_positions(
            source_words,
            chunk["highlight"],
            fallback_to_final=chunk["emphasis"] == "punch",
        )
        following = chunks[index + 1] if index + 1 < len(chunks) else None
        chunk_start = (
            scene_start
            if index == 0
            else float(words[from_index]["start"])
        )
        chunk_end = (
            float(words[indexes[following["fromWordId"]]]["start"])
            if following is not None
            else scene_end
        )
        resolved.append({
            "id": chunk["id"],
            "start": chunk_start,
            "end": chunk_end,
            "text": chunk["displayText"],
            "motionPreset": chunk["motionPreset"],
            "emphasis": chunk["emphasis"],
            "words": [
                {
                    "text": str(word["text"]),
                    "start": float(word["start"]),
                    "end": float(word["end"]),
                    "emphasis": (
                        "highlight"
                        if word_index in highlighted
                        else "normal"
                    ),
                }
                for word_index, word in enumerate(source_words)
            ],
        })
    return resolved


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

    segments: list[dict] = []
    for index, scene in enumerate(scenes):
        segment = {
            "id": scene["id"],
            "start": boundaries[index],
            "end": boundaries[index + 1],
            "text": scene["displayText"],
            "highlight": deepcopy(scene["highlight"]),
            "animation": scene["animation"],
        }
        if (
            manifest["id"] == "kinetic-punch-v2"
            and manifest["version"] == 1
            and scene.get("motion") is not None
        ):
            segment.update({
                "transition": scene["motion"]["transition"],
                "intensity": scene["motion"]["intensity"],
                "chunks": _resolve_motion_chunks(
                    scene,
                    words,
                    indexes,
                    scene_start=boundaries[index],
                    scene_end=boundaries[index + 1],
                ),
            })
        segments.append(segment)
    return segments


def _validate_render_words(
    words: Any,
    *,
    chunk_start: float,
    chunk_end: float,
) -> list[dict]:
    if not isinstance(words, list):
        raise ValueError("渲染动效词时间格式无效")
    validated: list[dict] = []
    previous_start = chunk_start
    previous_end = chunk_start
    for word in words:
        if not isinstance(word, dict) or set(word) != RENDER_WORD_FIELDS:
            raise ValueError("渲染动效词时间字段无效")
        text = _require_nonblank(
            word.get("text"),
            "渲染动效词文字不能为空",
        )
        start = word.get("start")
        end = word.get("end")
        emphasis = word.get("emphasis")
        if (
            not _is_finite_number(start)
            or not _is_finite_number(end)
            or start < chunk_start - CONTINUITY_EPSILON_SECONDS
            or end < start
            or end > chunk_end + CONTINUITY_EPSILON_SECONDS
            or start < previous_start
            or end < previous_end
        ):
            raise ValueError("渲染动效词时间必须有序且位于短句内")
        if emphasis not in {"normal", "highlight"}:
            raise ValueError("渲染动效词强调无效")
        validated.append({
            "text": text,
            "start": float(start),
            "end": float(end),
            "emphasis": emphasis,
        })
        previous_start = float(start)
        previous_end = float(end)
    return validated


def _validate_render_motion(
    raw: dict,
    *,
    segment_start: float,
    segment_end: float,
    manifest: dict,
) -> dict:
    if manifest["id"] != "kinetic-punch-v2" or manifest["version"] != 1:
        raise ValueError("当前模板不支持动效短句")
    if raw.get("transition") not in manifest["transitions"]:
        raise ValueError("当前模板不支持渲染转场")
    intensity = raw.get("intensity")
    if (
        not _is_finite_number(intensity)
        or intensity < 0
        or intensity > 1
    ):
        raise ValueError("渲染动效强度必须位于 0 到 1")
    raw_chunks = raw.get("chunks")
    if not isinstance(raw_chunks, list) or not raw_chunks:
        raise ValueError("渲染动效短句不能为空")

    chunks: list[dict] = []
    ids: set[str] = set()
    previous_end = segment_start
    for chunk in raw_chunks:
        if not isinstance(chunk, dict) or set(chunk) != RENDER_CHUNK_FIELDS:
            raise ValueError("渲染动效短句字段无效")
        chunk_id = _require_nonblank(
            chunk.get("id"),
            "渲染动效短句 ID 不能为空",
        )
        if chunk_id in ids:
            raise ValueError("渲染动效短句 ID 不能重复")
        ids.add(chunk_id)
        start = chunk.get("start")
        end = chunk.get("end")
        if (
            not _is_finite_number(start)
            or not _is_finite_number(end)
            or abs(float(start) - previous_end) > CONTINUITY_EPSILON_SECONDS
            or end <= start
            or end > segment_end + CONTINUITY_EPSILON_SECONDS
        ):
            raise ValueError("渲染动效短句必须连续覆盖分镜")
        text = _require_nonblank(
            chunk.get("text"),
            "渲染动效短句文字不能为空",
        )
        motion_preset = chunk.get("motionPreset")
        if motion_preset not in manifest["animations"]:
            raise ValueError("当前模板不支持动效短句预设")
        emphasis = chunk.get("emphasis")
        if emphasis not in MOTION_EMPHASIS:
            raise ValueError("渲染动效短句强调无效")
        chunks.append({
            "id": chunk_id,
            "start": float(start),
            "end": float(end),
            "text": text,
            "motionPreset": motion_preset,
            "emphasis": emphasis,
            "words": _validate_render_words(
                chunk.get("words"),
                chunk_start=float(start),
                chunk_end=float(end),
            ),
        })
        previous_end = float(end)
    if abs(previous_end - segment_end) > CONTINUITY_EPSILON_SECONDS:
        raise ValueError("渲染动效短句必须连续覆盖分镜")
    chunks[0]["start"] = segment_start
    chunks[-1]["end"] = segment_end
    return {
        "transition": raw["transition"],
        "intensity": float(intensity),
        "chunks": chunks,
    }


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
        if (
            not isinstance(raw, dict)
            or not RENDER_SEGMENT_FIELDS.issubset(raw)
            or set(raw) - RENDER_SEGMENT_FIELDS - RENDER_MOTION_FIELDS
        ):
            raise ValueError("渲染分镜字段无效")
        has_motion = bool(set(raw) & RENDER_MOTION_FIELDS)
        if has_motion and not RENDER_MOTION_FIELDS.issubset(raw):
            raise ValueError("渲染分镜动效字段不完整")
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
        segment = {
            "id": segment_id,
            "start": float(start),
            "end": float(end),
            "text": text,
            "highlight": _validate_highlights(raw.get("highlight"), text),
            "animation": animation,
        }
        if has_motion:
            segment.update(_validate_render_motion(
                raw,
                segment_start=float(start),
                segment_end=float(end),
                manifest=manifest,
            ))
        segments.append(segment)

    if abs(segments[0]["start"]) > CONTINUITY_EPSILON_SECONDS:
        raise ValueError("渲染分镜必须连续覆盖主音频")
    for index in range(1, len(segments)):
        if abs(
            segments[index]["start"] - segments[index - 1]["end"]
        ) > CONTINUITY_EPSILON_SECONDS:
            raise ValueError("渲染分镜必须连续覆盖主音频")
    if abs(segments[-1]["end"] - master_duration) > CONTINUITY_EPSILON_SECONDS:
        raise ValueError("渲染分镜必须连续覆盖主音频")

    segments[0]["start"] = 0.0
    for index in range(1, len(segments)):
        segments[index]["start"] = segments[index - 1]["end"]
    segments[-1]["end"] = float(master_duration)
    if any(
        segment["end"] <= segment["start"]
        for segment in segments
    ):
        raise ValueError("渲染分镜必须连续覆盖主音频")
    fps = composition["fps"]
    if any(
        math.ceil(segment["start"] * fps)
        > math.ceil(segment["end"] * fps) - 1
        for segment in segments
    ):
        raise ValueError("渲染分镜在当前帧率下必须至少包含一个安全帧")

    return {
        "templateId": template_id,
        "templateVersion": version,
        "composition": composition,
        "audio": audio,
        "segments": segments,
        "templateProps": template_props,
    }
