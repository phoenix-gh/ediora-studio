import asyncio
import sys

import httpx
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch, postgres_env):
    monkeypatch.setenv("WORKER_TOKEN", "test-worker-token-at-least-32-chars")
    monkeypatch.delenv("COMFYUI_BASE_URL", raising=False)
    monkeypatch.delenv("COMFYUI_AUTH_TOKEN", raising=False)
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


def test_xiangongyun_settings_default_and_token_roundtrip(client):
    default = client.get("/api/settings")

    assert default.status_code == 200
    assert default.json()["comfyui_runtime_provider"] == "direct"
    assert default.json()["xiangongyun_base_url"] == "https://api.xiangongyun.com"
    assert default.json()["xiangongyun_api_token_set"] is False
    assert default.json()["xiangongyun_default_instance_id"] == ""

    saved = client.put(
        "/api/settings",
        json={
            "comfyui_runtime_provider": "xiangongyun",
            "xiangongyun_base_url": "https://xgc.example.com/",
            "xiangongyun_api_token": "xgc_secret_token",
            "xiangongyun_default_instance_id": " instance-1 ",
        },
    )

    assert saved.status_code == 200
    body = saved.json()
    assert body["comfyui_runtime_provider"] == "xiangongyun"
    assert body["xiangongyun_base_url"] == "https://xgc.example.com"
    assert body["xiangongyun_api_token_set"] is True
    assert body["xiangongyun_api_token_preview"] == "…oken"
    assert body["xiangongyun_default_instance_id"] == "instance-1"
    assert "xgc_secret_token" not in saved.text

    masked_update = client.put(
        "/api/settings",
        json={"xiangongyun_api_token": "", "xiangongyun_default_instance_id": "instance-2"},
    )
    assert masked_update.status_code == 200
    assert masked_update.json()["xiangongyun_api_token_set"] is True
    assert masked_update.json()["xiangongyun_api_token_preview"] == "…oken"
    assert masked_update.json()["xiangongyun_default_instance_id"] == "instance-2"


def test_xiangongyun_settings_validate_provider_and_base_url(client):
    unsupported_provider = client.put(
        "/api/settings",
        json={"comfyui_runtime_provider": "other"},
    )
    invalid_url = client.put(
        "/api/settings",
        json={"xiangongyun_base_url": "file:///tmp/xgc"},
    )

    assert unsupported_provider.status_code == 422
    assert invalid_url.status_code == 422


def test_xiangongyun_runtime_is_worker_only_and_returns_secret_only_there(client):
    direct_runtime = client.get(
        "/api/settings/xiangongyun-runtime",
        headers={"X-Worker-Token": "test-worker-token-at-least-32-chars"},
    )
    assert direct_runtime.json() == {
        "provider": "direct",
        "base_url": "https://api.xiangongyun.com",
        "api_token": "",
        "default_instance_id": "",
    }

    client.put(
        "/api/settings",
        json={
            "comfyui_runtime_provider": "xiangongyun",
            "xiangongyun_api_token": "xgc_secret_token",
            "xiangongyun_default_instance_id": "instance-1",
        },
    )

    missing = client.get("/api/settings/xiangongyun-runtime")
    wrong = client.get(
        "/api/settings/xiangongyun-runtime",
        headers={"X-Worker-Token": "wrong-token"},
    )
    runtime = client.get(
        "/api/settings/xiangongyun-runtime",
        headers={"X-Worker-Token": "test-worker-token-at-least-32-chars"},
    )

    assert missing.status_code == 403
    assert wrong.status_code == 403
    assert runtime.status_code == 200
    assert runtime.json() == {
        "provider": "xiangongyun",
        "base_url": "https://api.xiangongyun.com",
        "api_token": "xgc_secret_token",
        "default_instance_id": "instance-1",
    }


class FakeXiangongyunClient:
    created: list[tuple[str, str]] = []

    def __init__(self, base_url: str, api_token: str):
        self.created.append((base_url, api_token))

    async def list_instances(self):
        return {"list": [{"id": "instance-1", "status": "running"}], "total": 1}

    async def get_instance(self, instance_id: str):
        return {"id": instance_id, "status": "running"}

    async def boot_instance(self, instance_id: str):
        return {"code": 0, "msg": "ok", "success": True, "id": instance_id}

    async def shutdown_instance(self, instance_id: str):
        return {"code": 0, "msg": "ok", "success": True, "id": instance_id}


def test_xiangongyun_settings_proxy_routes(client, monkeypatch):
    client.put(
        "/api/settings",
        json={
            "xiangongyun_base_url": "https://xgc.example.com/",
            "xiangongyun_api_token": "xgc_secret_token",
        },
    )
    import routers.settings as settings_router

    FakeXiangongyunClient.created.clear()
    monkeypatch.setattr(settings_router, "XiangongyunClient", FakeXiangongyunClient)

    listed = client.get("/api/settings/xiangongyun/instances")
    detail = client.get("/api/settings/xiangongyun/instances/instance-1")
    booted = client.post("/api/settings/xiangongyun/instances/instance-1/boot")
    shut = client.post("/api/settings/xiangongyun/instances/instance-1/shutdown")

    assert listed.json()["total"] == 1
    assert detail.json()["status"] == "running"
    assert booted.json()["success"] is True
    assert shut.json()["success"] is True
    assert FakeXiangongyunClient.created == [
        ("https://xgc.example.com", "xgc_secret_token"),
    ] * 4
    assert "xgc_secret_token" not in listed.text
