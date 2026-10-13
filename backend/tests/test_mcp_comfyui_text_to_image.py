import asyncio
import json
import sys
from io import BytesIO

import pytest
from PIL import Image


def _png_bytes() -> bytes:
    output = BytesIO()
    Image.new("RGB", (2, 2), (32, 96, 160)).save(output, format="PNG")
    return output.getvalue()


def _graph():
    return {
        "6": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": "原提示词", "clip": ["4", 1]},
        },
        "5": {
            "class_type": "EmptyLatentImage",
            "inputs": {"width": 512, "height": 512, "batch_size": 1},
        },
    }


def _workflow(name):
    return {
        "name": name,
        "type": "text_to_image",
        "workflow": _graph(),
        "inputs": {"prompt": "6:text", "width": "5:width", "height": "5:height"},
    }


def _string_schema(node):
    if not isinstance(node, dict):
        return {}
    if node.get("type") == "string" or "maxLength" in node:
        return node
    for item in node.get("anyOf", []):
        found = _string_schema(item)
        if found:
            return found
    return {}


@pytest.fixture
def env(monkeypatch, postgres_env):
    for module in list(sys.modules):
        if module.startswith(("database", "models", "config", "mcp_server")):
            sys.modules.pop(module, None)
    from database import Base, engine
    import models  # noqa: F401

    async def setup():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.new_event_loop().run_until_complete(setup())


def run(coroutine):
    return asyncio.new_event_loop().run_until_complete(coroutine)


def test_comfyui_text_to_image_schema_uses_prompt_and_size(env):
    import mcp_server

    tools = {tool.name: tool for tool in run(mcp_server.mcp.list_tools())}
    tool = tools["comfyui_text_to_image"]
    schema = tool.inputSchema

    assert "多媒体" in tool.description
    assert "临时文件" in tool.description
    assert "prompt node" in tool.description
    assert "{{prompt}}" not in tool.description
    assert schema["required"] == ["prompt", "size"]
    assert _string_schema(schema["properties"]["prompt"])["maxLength"] == 8000
    assert _string_schema(schema["properties"]["size"])["maxLength"] == 32


def test_comfyui_text_to_image_saves_the_latest_workflow_image(env, monkeypatch, tmp_path):
    import mcp_server
    from comfyui_workflows import SETTING_KEY, add_workflow
    from config import set_config
    from database import SessionLocal
    from models import CreativeAsset

    png = _png_bytes()
    workflows, _first = add_workflow([], _workflow("旧流程"))
    workflows, _second = add_workflow(workflows, _workflow("新流程"))
    run(set_config({
        "comfyui_base_url": "http://comfy.example:8188",
        "comfyui_auth_token": "secret-token",
        SETTING_KEY: json.dumps(workflows),
    }))
    seen = {}

    async def fake_download(*, base_url, auth_token, graph):
        seen["base_url"] = base_url
        seen["auth_token"] = auth_token
        seen["graph"] = graph
        return png

    monkeypatch.setattr("comfyui_client.download_comfyui_image", fake_download)
    monkeypatch.setattr(mcp_server, "_UPLOADS_DIR", tmp_path)

    result = run(mcp_server.comfyui_text_to_image(
        prompt="  窗边逆光的女生  ",
        size="1024X768",
    ))

    assert result["workflow_name"] == "新流程"
    assert result["directory"] == "临时文件"
    assert result["size"] == "1024x768"
    assert result["title"] == "窗边逆光的女生"
    assert result["asset_url"].startswith("/api/uploads/")
    assert seen["base_url"] == "http://comfy.example:8188"
    assert seen["auth_token"] == "secret-token"
    assert seen["graph"]["6"]["inputs"]["text"] == "窗边逆光的女生"
    assert seen["graph"]["6"]["inputs"]["clip"] == ["4", 1]
    assert seen["graph"]["5"]["inputs"]["width"] == 1024
    assert seen["graph"]["5"]["inputs"]["height"] == 768
    assert seen["graph"]["5"]["inputs"]["batch_size"] == 1
    assert (tmp_path / result["asset_url"].rsplit("/", 1)[-1]).read_bytes() == png

    async def stored():
        async with SessionLocal() as session:
            return await session.get(CreativeAsset, result["asset_id"])

    asset = run(stored())
    assert asset.asset_type == "media"
    assert asset.media_kind == "image"
    assert asset.directory == "临时文件"
    assert asset.content == ""
    assert asset.source == "upload"


def test_comfyui_text_to_image_stops_before_comfyui_when_setup_is_missing(env, monkeypatch):
    import mcp_server
    from comfyui_workflows import SETTING_KEY, add_workflow
    from config import set_config

    async def fail_download(**_kwargs):
        raise AssertionError("ComfyUI should not be called")

    monkeypatch.setattr("comfyui_client.download_comfyui_image", fail_download)

    with pytest.raises(ValueError, match="还没有文生图工作流"):
        run(mcp_server.comfyui_text_to_image(prompt="一只猫", size="1024x1024"))

    workflows, _created = add_workflow([], _workflow("街拍"))
    run(set_config({
        SETTING_KEY: json.dumps(workflows),
        "comfyui_base_url": "",
    }))
    with pytest.raises(ValueError, match="请先在设置里填写 ComfyUI 地址"):
        run(mcp_server.comfyui_text_to_image(prompt="一只猫", size="1024x1024"))

    with pytest.raises(ValueError, match="生图大小格式应为 1024x1024"):
        run(mcp_server.comfyui_text_to_image(prompt="一只猫", size="很大"))
