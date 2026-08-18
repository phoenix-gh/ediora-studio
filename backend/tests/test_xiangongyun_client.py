import asyncio
import json

import httpx
import pytest


def test_xiangongyun_client_uses_documented_requests_and_parses_payload(monkeypatch):
    seen: list[httpx.Request] = []
    token = "xgc_secret_token"

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == "/open/instances":
            return httpx.Response(
                200,
                request=request,
                json={
                    "list": [
                        {
                            "id": "instance-1",
                            "name": "ComfyUI",
                            "gpu_model": "RTX 4090",
                            "gpu_used": 1,
                            "status": "running",
                            "progress": 100,
                            "password": "instance-secret",
                            "jupyter_token": "jupyter-secret",
                        },
                    ],
                    "total": 1,
                },
            )
        if request.url.path == "/open/instance/instance-1":
            return httpx.Response(
                200,
                request=request,
                json={"id": "instance-1", "status": "running", "progress": 100},
            )
        if request.url.path == "/open/instance/boot":
            assert request.method == "POST"
            assert json.loads(request.content) == {"id": "instance-1"}
            return httpx.Response(
                200,
                request=request,
                json={"code": 0, "msg": "ok", "success": True},
            )
        if request.url.path == "/open/instance/shutdown":
            assert request.method == "POST"
            assert json.loads(request.content) == {"id": "instance-1"}
            return httpx.Response(
                200,
                request=request,
                json={"code": 0, "msg": "ok", "success": True},
            )
        return httpx.Response(404, request=request)

    transport = httpx.MockTransport(handler)
    original_client = httpx.AsyncClient
    client_kwargs: dict = {}

    def fake_client(*args, **kwargs):
        client_kwargs.update(kwargs)
        kwargs["transport"] = transport
        return original_client(*args, **kwargs)

    import xiangongyun_client as module

    monkeypatch.setattr(module.httpx, "AsyncClient", fake_client)
    client = module.XiangongyunClient("https://api.example.com/", token)

    instances = asyncio.run(client.list_instances())
    detail = asyncio.run(client.get_instance("instance-1"))
    boot = asyncio.run(client.boot_instance("instance-1"))
    shutdown = asyncio.run(client.shutdown_instance("instance-1"))

    assert instances["total"] == 1
    assert instances["list"][0]["status"] == "running"
    assert "password" not in instances["list"][0]
    assert "jupyter_token" not in instances["list"][0]
    assert detail["id"] == "instance-1"
    assert boot["success"] is True
    assert shutdown["success"] is True
    assert client_kwargs["trust_env"] is False
    assert [request.url.path for request in seen] == [
        "/open/instances",
        "/open/instance/instance-1",
        "/open/instance/boot",
        "/open/instance/shutdown",
    ]
    assert all(request.headers["authorization"] == f"Bearer {token}" for request in seen)


def test_xiangongyun_client_redacts_token_from_http_and_api_errors(monkeypatch):
    token = "xgc_secret_token"

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/open/instances":
            return httpx.Response(
                502,
                request=request,
                text=f"upstream failed with {token}",
            )
        return httpx.Response(
            200,
            request=request,
            json={"code": 1001, "msg": f"bad token {token}", "success": False},
        )

    transport = httpx.MockTransport(handler)
    original_client = httpx.AsyncClient

    def fake_client(*args, **kwargs):
        kwargs["transport"] = transport
        return original_client(*args, **kwargs)

    import xiangongyun_client as module

    monkeypatch.setattr(module.httpx, "AsyncClient", fake_client)
    client = module.XiangongyunClient("https://api.example.com", token)

    with pytest.raises(module.XiangongyunError) as http_error:
        asyncio.run(client.list_instances())
    assert token not in str(http_error.value)
    assert http_error.value.retryable is True

    with pytest.raises(module.XiangongyunError) as api_error:
        asyncio.run(client.get_instance("instance-1"))
    assert token not in str(api_error.value)
    assert api_error.value.retryable is False
    assert api_error.value.code == 1001
