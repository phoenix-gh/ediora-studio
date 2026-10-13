"""Saved ComfyUI workflows.

Each workflow is a name, a type, and the API-format JSON. Text-to-image also
records which node inputs receive the prompt, width, and height. The JSON
keeps ComfyUI's own values; those inputs are overwritten only when a run
starts. The tool uses the most recently added workflow of that type.
"""

from __future__ import annotations

import copy
import json
import re
import uuid
from typing import Any

SETTING_KEY = "comfyui_workflows"
TEXT_TO_IMAGE_TYPE = "text_to_image"
_TYPE_ALIASES = {
    "text_to_image": TEXT_TO_IMAGE_TYPE,
    "文生图": TEXT_TO_IMAGE_TYPE,
}
_MAX_WORKFLOWS = 20
_MAX_NAME_LENGTH = 40
_MAX_JSON_BYTES = 200_000
_MAX_PROMPT_LENGTH = 8000
_MIN_IMAGE_EDGE = 64
_MAX_IMAGE_EDGE = 4096
_SIZE_PATTERN = re.compile(r"^(\d+)\s*[xX×*]\s*(\d+)$")
_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_TEXT_TO_IMAGE_INPUTS = (
    ("prompt", "提示词节点"),
    ("width", "宽度节点"),
    ("height", "高度节点"),
)


def load_workflows(raw: str | None) -> list[dict[str, Any]]:
    """Return the saved list. An empty setting is an empty list."""
    text = str(raw or "").strip()
    if not text:
        return []
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError("已保存的工作流无法读取") from exc
    if not isinstance(payload, list):
        raise ValueError("已保存的工作流无法读取")
    return [_stored_workflow(item) for item in payload]


def add_workflow(workflows: list[dict[str, Any]], payload: Any) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Append one workflow and return the new list plus the created item."""
    if len(workflows) >= _MAX_WORKFLOWS:
        raise ValueError(f"最多保存 {_MAX_WORKFLOWS} 个工作流")
    created = normalize_workflow(payload)
    return [*workflows, created], created


def update_workflow(
    workflows: list[dict[str, Any]],
    workflow_id: str,
    payload: Any,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Replace one workflow in place. Missing ids raise KeyError."""
    index = next(
        (position for position, item in enumerate(workflows) if item["id"] == workflow_id),
        None,
    )
    if index is None:
        raise KeyError(workflow_id)
    updated = normalize_workflow(payload, workflow_id=workflow_id)
    replaced = list(workflows)
    replaced[index] = updated
    return replaced, updated


def delete_workflow(workflows: list[dict[str, Any]], workflow_id: str) -> list[dict[str, Any]]:
    """Remove one workflow by id. Missing ids raise KeyError."""
    kept = [item for item in workflows if item["id"] != workflow_id]
    if len(kept) == len(workflows):
        raise KeyError(workflow_id)
    return kept


def normalize_workflow(payload: Any, *, workflow_id: str | None = None) -> dict[str, Any]:
    """Return one canonical workflow or raise ValueError."""
    if not isinstance(payload, dict):
        raise ValueError("工作流必须是对象")
    name = str(payload.get("name") or "").strip()
    if not name:
        raise ValueError("请填写工作流名字")
    if len(name) > _MAX_NAME_LENGTH:
        raise ValueError("工作流名字过长")
    workflow_type = _TYPE_ALIASES.get(str(payload.get("type") or "").strip())
    if workflow_type is None:
        raise ValueError("工作流类型只支持文生图")
    graph = _workflow_object(payload.get("workflow"))
    inputs = (
        _text_to_image_inputs(payload.get("inputs"), graph)
        if workflow_type == TEXT_TO_IMAGE_TYPE
        else {}
    )
    return {
        "id": workflow_id or uuid.uuid4().hex,
        "name": name,
        "type": workflow_type,
        "workflow": graph,
        "inputs": inputs,
    }


def parse_image_size(size: str) -> tuple[int, int]:
    """Parse a size such as 1024x1024 into width and height."""
    match = _SIZE_PATTERN.match(str(size or "").strip())
    if match is None:
        raise ValueError("生图大小格式应为 1024x1024")
    width = int(match.group(1))
    height = int(match.group(2))
    if (
        width < _MIN_IMAGE_EDGE
        or height < _MIN_IMAGE_EDGE
        or width > _MAX_IMAGE_EDGE
        or height > _MAX_IMAGE_EDGE
    ):
        raise ValueError(
            f"生图大小的宽和高需在 {_MIN_IMAGE_EDGE} 到 {_MAX_IMAGE_EDGE} 之间"
        )
    return width, height


def apply_text_to_image(workflow: dict[str, Any], *, prompt: str, size: str) -> dict[str, Any]:
    """Write the prompt and size into the configured nodes of a saved graph."""
    text = prompt.strip()
    if not text:
        raise ValueError("提示词不能为空")
    if len(text) > _MAX_PROMPT_LENGTH:
        raise ValueError("提示词过长")
    width, height = parse_image_size(size)
    graph = workflow.get("workflow")
    if not isinstance(graph, dict):
        raise ValueError("工作流 JSON 必须是对象")
    inputs = workflow.get("inputs")
    if not isinstance(inputs, dict):
        raise ValueError("请填写提示词、宽度和高度节点")
    filled = copy.deepcopy(graph)
    values = {"prompt": text, "width": width, "height": height}
    for key, label in _TEXT_TO_IMAGE_INPUTS:
        _write_input(filled, str(inputs.get(key) or ""), values[key], label)
    return filled


def _stored_workflow(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("已保存的工作流无法读取")
    workflow_id = str(payload.get("id") or "").strip()
    if _ID_PATTERN.fullmatch(workflow_id) is None:
        raise ValueError("已保存的工作流无法读取")
    return normalize_workflow(payload, workflow_id=workflow_id)


def _workflow_object(value: Any) -> dict[str, Any]:
    if isinstance(value, str):
        text = value.strip()
        if not text:
            raise ValueError("请填写工作流 JSON")
        try:
            value = json.loads(text)
        except json.JSONDecodeError as exc:
            raise ValueError("工作流 JSON 无法解析") from exc
    if not isinstance(value, dict) or not value:
        raise ValueError("工作流 JSON 必须是对象")
    encoded = json.dumps(value, ensure_ascii=False)
    if len(encoded.encode("utf-8")) > _MAX_JSON_BYTES:
        raise ValueError("工作流 JSON 过大")
    return copy.deepcopy(value)


def _text_to_image_inputs(value: Any, graph: dict[str, Any]) -> dict[str, str]:
    if not isinstance(value, dict):
        raise ValueError("请填写提示词、宽度和高度节点")
    inputs: dict[str, str] = {}
    for key, label in _TEXT_TO_IMAGE_INPUTS:
        mapping = str(value.get(key) or "").strip()
        _mapping_target(mapping, graph, label)
        inputs[key] = mapping
    return inputs


def _write_input(graph: dict[str, Any], mapping: str, value: Any, label: str) -> None:
    node_id, input_name = _mapping_target(mapping, graph, label)
    graph[node_id]["inputs"][input_name] = value


def _mapping_target(mapping: str, graph: dict[str, Any], label: str) -> tuple[str, str]:
    node_id, separator, input_name = mapping.partition(":")
    if not separator or not node_id or not input_name:
        raise ValueError(f"{label}格式是“节点:输入名”")
    node = graph.get(node_id)
    inputs = node.get("inputs") if isinstance(node, dict) else None
    if not isinstance(inputs, dict) or input_name not in inputs:
        raise ValueError(f"{label} {mapping} 不存在")
    if isinstance(inputs[input_name], (list, dict)):
        raise ValueError(f"{label} {mapping} 是连线，不能写入")
    return node_id, input_name
