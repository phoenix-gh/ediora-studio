import asyncio
import base64
import ipaddress
import json
import sys
from io import BytesIO

import httpx
import pytest
from PIL import Image


def _png_bytes() -> bytes:
    output = BytesIO()
    Image.new("RGB", (2, 2), (32, 96, 160)).save(output, format="PNG")
    return output.getvalue()


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


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def install_image_adapter(
    monkeypatch,
    *,
    model="gpt-image-1",
    response_format="base64",
    headers=None,
):
    from llm_adapters import ResolvedLLMAdapter

    adapter = ResolvedLLMAdapter(
        adapter_id="img",
        name="Images",
        protocol="openai",
        api_key="sk-test",
        model=model,
        base_url="https://images.example/v1",
        supports_text=False,
        supports_image=True,
        image_response_format=response_format,
        headers=headers or {},
    )

    async def fake_config():
        return {}

    def fake_resolve(_cfg, **kwargs):
        assert kwargs.get("capability") == "image"
        return adapter

    monkeypatch.setattr("config.get_config", fake_config)
    monkeypatch.setattr("llm_adapters.resolve_adapter", fake_resolve)
    return adapter


def install_http(monkeypatch, handler):
    import mcp_server

    def factory(**kwargs):
        return httpx.AsyncClient(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(mcp_server, "_image_http_client", factory)


def test_generate_image_schema_uses_the_product_contract(env):
    import mcp_server

    tools = {tool.name: tool for tool in run(mcp_server.mcp.list_tools())}
    tool = tools["generateImage"]
    schema = tool.inputSchema

    assert tool.description.startswith(
        "Synchronously generate one image and save it as a CreativeAsset"
    )
    assert "临时文件" in tool.description
    assert "upload_image_from_url" in tool.description
    assert "upload_image_from_path" in tool.description
    assert schema["required"] == ["prompt"]
    assert _string_schema(schema["properties"]["prompt"])["maxLength"] == 4000
    assert _string_schema(schema["properties"]["title"])["maxLength"] == 200
    assert _string_schema(schema["properties"]["directory"])["maxLength"] == 80
    assert "title" not in schema["required"]
    assert "directory" not in schema["required"]


def test_generate_image_saves_a_b64_image_in_the_default_directory(env, monkeypatch, tmp_path):
    import mcp_server
    from database import SessionLocal
    from models import CreativeAsset, CreativeAssetDirectory
    from sqlalchemy import select

    png = _png_bytes()
    seen = []

    def handler(request: httpx.Request):
        seen.append(request)
        assert str(request.url) == "https://images.example/v1/images/generations"
        assert request.headers["authorization"] == "Bearer sk-test"
        assert request.headers["x-tenant"] == "tenant-a"
        body = json.loads(request.content)
        assert body == {
            "model": "gpt-image-1",
            "prompt": "一张湖边日落",
            "n": 1,
        }
        return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(png).decode()}]})

    install_image_adapter(monkeypatch, headers={"X-Tenant": "tenant-a"})
    install_http(monkeypatch, handler)
    monkeypatch.setattr(mcp_server, "_UPLOADS_DIR", tmp_path)

    result = run(mcp_server.generateImage(prompt="  一张湖边日落  ", title="  湖边  "))

    assert result["title"] == "湖边"
    assert result["directory"] == "临时文件"
    assert result["model"] == "gpt-image-1"
    assert result["asset_url"].startswith("/api/uploads/")
    assert (tmp_path / result["asset_url"].rsplit("/", 1)[-1]).read_bytes() == png
    assert len(seen) == 1

    async def stored():
        async with SessionLocal() as session:
            asset = await session.get(CreativeAsset, result["asset_id"])
            directory = await session.scalar(
                select(CreativeAssetDirectory).where(
                    CreativeAssetDirectory.name == "临时文件",
                    CreativeAssetDirectory.asset_type == "media",
                )
            )
            return asset, directory

    asset, directory = run(stored())
    assert asset.source == "upload"
    assert asset.media_kind == "image"
    assert asset.media_type == "image/png"
    assert asset.url == result["asset_url"]
    assert asset.directory == "临时文件"
    assert directory.system_key == "temporary_files"


def test_generate_image_downloads_a_provider_url_without_forwarding_credentials(
    env, monkeypatch, tmp_path,
):
    import mcp_server
    import remote_image_import

    png = _png_bytes()
    seen = []

    async def public_dns(*_args, **_kwargs):
        return {ipaddress.ip_address("93.184.216.34")}

    def handler(request: httpx.Request):
        seen.append(request)
        if str(request.url) == "https://images.example/v1/images/generations":
            body = json.loads(request.content)
            assert body["response_format"] == "url"
            assert body["model"] == "dall-e-3"
            return httpx.Response(200, json={"data": [{"url": "https://cdn.example/lake.png"}]})
        assert str(request.url) == "https://cdn.example/lake.png"
        assert "authorization" not in request.headers
        return httpx.Response(200, content=png, headers={"content-type": "image/png"})

    install_image_adapter(monkeypatch, model="dall-e-3", response_format="url")
    install_http(monkeypatch, handler)
    monkeypatch.setattr(mcp_server, "_UPLOADS_DIR", tmp_path)
    monkeypatch.setattr(remote_image_import, "_resolve_addresses", public_dns)

    result = run(mcp_server.generateImage(prompt="一张湖边日落"))

    assert result["title"] == "Chat 生图"
    assert result["directory"] == "临时文件"
    assert result["model"] == "dall-e-3"
    assert (tmp_path / result["asset_url"].rsplit("/", 1)[-1]).read_bytes() == png
    assert [request.url.host for request in seen] == ["images.example", "cdn.example"]


def test_generate_image_retries_without_response_format_when_the_provider_rejects_it(
    env, monkeypatch, tmp_path,
):
    import mcp_server

    png = _png_bytes()
    bodies = []

    def handler(request: httpx.Request):
        body = json.loads(request.content)
        bodies.append(body)
        if len(bodies) == 1:
            return httpx.Response(
                400,
                json={"error": {"message": "Unknown parameter: response_format"}},
            )
        return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(png).decode()}]})

    install_image_adapter(monkeypatch, model="dall-e-3", response_format="base64")
    install_http(monkeypatch, handler)
    monkeypatch.setattr(mcp_server, "_UPLOADS_DIR", tmp_path)

    result = run(mcp_server.generateImage(prompt="一只猫"))

    assert result["model"] == "dall-e-3"
    assert bodies[0]["response_format"] == "b64_json"
    assert "response_format" not in bodies[1]
    assert len(list(tmp_path.iterdir())) == 1


def test_generate_image_uses_an_existing_media_directory(env, monkeypatch, tmp_path):
    import mcp_server
    from database import SessionLocal
    from models import CreativeAssetDirectory

    png = _png_bytes()

    async def seed():
        async with SessionLocal() as session:
            session.add(CreativeAssetDirectory(name="人像摄影", asset_type="media"))
            await session.commit()

    run(seed())

    def handler(_request: httpx.Request):
        return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(png).decode()}]})

    install_image_adapter(monkeypatch)
    install_http(monkeypatch, handler)
    monkeypatch.setattr(mcp_server, "_UPLOADS_DIR", tmp_path)

    result = run(mcp_server.generateImage(prompt="一张人像", directory="  人像摄影  "))

    assert result["directory"] == "人像摄影"


def test_generate_image_rejects_a_missing_media_directory_before_calling_the_provider(
    env, monkeypatch, tmp_path,
):
    import mcp_server

    called = []

    def handler(_request: httpx.Request):
        called.append(True)
        raise AssertionError("provider should not be called")

    install_image_adapter(monkeypatch)
    install_http(monkeypatch, handler)
    monkeypatch.setattr(mcp_server, "_UPLOADS_DIR", tmp_path)

    with pytest.raises(ValueError, match="多媒体目录不存在：不存在的目录"):
        run(mcp_server.generateImage(prompt="一只猫", directory="不存在的目录"))

    assert called == []
    assert list(tmp_path.iterdir()) == []


def test_generate_image_requires_a_prompt_and_a_configured_image_model(env, monkeypatch, tmp_path):
    import mcp_server

    monkeypatch.setattr(mcp_server, "_UPLOADS_DIR", tmp_path)

    with pytest.raises(ValueError, match="generateImage requires a prompt"):
        run(mcp_server.generateImage(prompt="   "))
    with pytest.raises(ValueError, match="prompt is too long"):
        run(mcp_server.generateImage(prompt="猫" * 4001))
    with pytest.raises(ValueError, match="未配置图片模型 API Key"):
        run(mcp_server.generateImage(prompt="一只猫"))

    assert list(tmp_path.iterdir()) == []


def test_generate_image_hides_the_api_key_when_the_provider_fails(env, monkeypatch, tmp_path):
    import mcp_server

    def handler(_request: httpx.Request):
        return httpx.Response(503, text="upstream down")

    install_image_adapter(monkeypatch)
    install_http(monkeypatch, handler)
    monkeypatch.setattr(mcp_server, "_UPLOADS_DIR", tmp_path)

    with pytest.raises(ValueError, match="Image provider request failed \\(503\\): upstream down") as caught:
        run(mcp_server.generateImage(prompt="一只猫"))

    assert "sk-test" not in str(caught.value)
    assert list(tmp_path.iterdir()) == []


def test_generate_image_rejects_a_private_provider_image_url(env, monkeypatch, tmp_path):
    import mcp_server

    def handler(request: httpx.Request):
        if str(request.url) == "https://images.example/v1/images/generations":
            return httpx.Response(200, json={"data": [{"url": "http://127.0.0.1/secret.png"}]})
        raise AssertionError(f"unexpected request: {request.url}")

    install_image_adapter(monkeypatch, model="dall-e-3", response_format="url")
    install_http(monkeypatch, handler)
    monkeypatch.setattr(mcp_server, "_UPLOADS_DIR", tmp_path)

    with pytest.raises(ValueError, match="图片地址未通过安全检查"):
        run(mcp_server.generateImage(prompt="一只猫"))

    assert list(tmp_path.iterdir()) == []
