import asyncio
import json
import sys

import pytest
from fastapi.testclient import TestClient


def _graph():
    return {
        "6": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": "原提示词", "clip": ["4", 1]},
        },
        "5": {
            "class_type": "EmptyLatentImage",
            "inputs": {"width": 1024, "height": 1024, "batch_size": 1},
        },
    }


def _inputs():
    return {"prompt": "6:text", "width": "5:width", "height": "5:height"}


def _workflow(name="街拍", workflow_type="text_to_image"):
    return {
        "name": name,
        "type": workflow_type,
        "workflow": _graph(),
        "inputs": _inputs(),
    }


def test_text_to_image_writes_prompt_and_size_into_the_configured_nodes():
    from comfyui_workflows import add_workflow, apply_text_to_image

    _, workflow = add_workflow([], _workflow(workflow_type="文生图"))
    graph = apply_text_to_image(
        workflow,
        prompt='窗边逆光，"东亚女生"',
        size="768 x 1344",
    )

    assert graph["6"]["inputs"]["text"] == '窗边逆光，"东亚女生"'
    assert graph["6"]["inputs"]["clip"] == ["4", 1]
    assert graph["5"]["inputs"]["width"] == 768
    assert graph["5"]["inputs"]["height"] == 1344
    assert graph["5"]["inputs"]["batch_size"] == 1
    assert workflow["workflow"]["6"]["inputs"]["text"] == "原提示词"
    assert workflow["workflow"]["5"]["inputs"]["width"] == 1024


def test_text_to_image_node_must_be_a_writable_input():
    from comfyui_workflows import add_workflow

    linked = _workflow()
    linked["inputs"] = {**_inputs(), "prompt": "6:clip"}
    with pytest.raises(ValueError, match="提示词节点 6:clip 是连线，不能写入"):
        add_workflow([], linked)

    missing = _workflow()
    missing["inputs"] = {**_inputs(), "width": "9:width"}
    with pytest.raises(ValueError, match="宽度节点 9:width 不存在"):
        add_workflow([], missing)


def test_workflow_list_rejects_unknown_types_and_a_full_list():
    from comfyui_workflows import add_workflow

    with pytest.raises(ValueError, match="只支持文生图"):
        add_workflow([], {
            "name": "视频",
            "type": "video",
            "workflow": _graph(),
            "inputs": _inputs(),
        })

    workflows = []
    for index in range(20):
        workflows, _created = add_workflow(workflows, _workflow(name=f"流程{index}"))
    with pytest.raises(ValueError, match="最多保存 20 个工作流"):
        add_workflow(workflows, _workflow(name="再来一个"))


@pytest.fixture
def client(monkeypatch, postgres_env):
    monkeypatch.setenv("WORKER_TOKEN", "test-worker-token-at-least-32-chars")
    for module in list(sys.modules):
        if module.startswith(("database", "models", "main", "routers", "config")):
            sys.modules.pop(module, None)

    from database import Base, engine
    import models  # noqa: F401

    async def setup():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.new_event_loop().run_until_complete(setup())
    from main import app

    return TestClient(app)


def test_workflows_can_be_added_and_deleted(client):
    fresh = client.get("/api/settings/comfyui-workflows")
    assert fresh.status_code == 200
    assert fresh.json()["workflows"] == []

    first = client.post("/api/settings/comfyui-workflows", json=_workflow())
    assert first.status_code == 200
    assert first.json()["workflow"]["name"] == "街拍"
    assert first.json()["workflow"]["type"] == "text_to_image"
    assert first.json()["workflow"]["inputs"] == _inputs()
    assert first.json()["workflow"]["workflow"]["6"]["inputs"]["text"] == "原提示词"
    first_id = first.json()["workflow"]["id"]

    second_body = _workflow(name="人像", workflow_type="文生图")
    second_body["workflow"] = json.dumps(second_body["workflow"])
    second = client.post("/api/settings/comfyui-workflows", json=second_body)
    assert second.status_code == 200
    assert [item["name"] for item in second.json()["workflows"]] == ["街拍", "人像"]

    listed = client.get("/api/settings/comfyui-workflows")
    assert [item["id"] for item in listed.json()["workflows"]] == [
        first_id,
        second.json()["workflow"]["id"],
    ]

    deleted = client.delete(f"/api/settings/comfyui-workflows/{first_id}")
    assert deleted.status_code == 200
    assert [item["name"] for item in deleted.json()["workflows"]] == ["人像"]

    missing = client.delete("/api/settings/comfyui-workflows/missing")
    assert missing.status_code == 404
    assert "工作流不存在" in missing.text


def test_workflow_edit_keeps_its_id_and_place(client):
    first = client.post("/api/settings/comfyui-workflows", json=_workflow(name="街拍"))
    second = client.post("/api/settings/comfyui-workflows", json=_workflow(name="人像"))
    first_id = first.json()["workflow"]["id"]
    second_id = second.json()["workflow"]["id"]
    edited = _workflow(name="街拍夜景")
    edited["workflow"]["6"]["inputs"]["text"] = "夜景提示词"

    response = client.put(f"/api/settings/comfyui-workflows/{first_id}", json=edited)

    assert response.status_code == 200
    assert response.json()["workflow"]["id"] == first_id
    assert response.json()["workflow"]["workflow"]["6"]["inputs"]["text"] == "夜景提示词"
    assert [item["id"] for item in response.json()["workflows"]] == [first_id, second_id]
    assert [item["name"] for item in response.json()["workflows"]] == ["街拍夜景", "人像"]

    missing = client.put("/api/settings/comfyui-workflows/missing", json=_workflow())
    assert missing.status_code == 404

    invalid = _workflow()
    invalid["inputs"] = {**_inputs(), "prompt": "9:text"}
    rejected = client.put(f"/api/settings/comfyui-workflows/{first_id}", json=invalid)
    assert rejected.status_code == 422
    listed = client.get("/api/settings/comfyui-workflows")
    assert listed.json()["workflows"][0]["name"] == "街拍夜景"


def test_workflow_create_rejects_a_missing_node(client):
    body = _workflow()
    body["inputs"] = {**_inputs(), "height": "5:missing"}
    response = client.post("/api/settings/comfyui-workflows", json=body)

    assert response.status_code == 422
    assert "高度节点 5:missing 不存在" in response.text
