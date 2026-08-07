import ipaddress
from io import BytesIO

import httpx
import pytest
from PIL import Image

import remote_image_import


def _png_bytes() -> bytes:
    output = BytesIO()
    Image.new("RGB", (2, 2), (32, 96, 160)).save(output, format="PNG")
    return output.getvalue()


async def _public_dns(*_args, **_kwargs):
    return {ipaddress.ip_address("93.184.216.34")}


async def _private_dns_result():
    return {ipaddress.ip_address("10.0.0.8")}


def _client_factory(handler, captured: dict):
    def factory(**kwargs):
        captured.update(kwargs)
        return httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            **kwargs,
        )

    return factory


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "url",
    [
        "ftp://images.example/a.png",
        "https://user:secret@images.example/a.png",
        "https://localhost/a.png",
        "https://127.0.0.1/a.png",
        "https://10.0.0.8/a.png",
        "https://169.254.10.1/a.png",
        "https://192.0.2.10/a.png",
    ],
)
async def test_import_remote_image_rejects_unsafe_urls(tmp_path, url):
    result = await remote_image_import.import_remote_image(url, tmp_path)

    assert result.error_code == "unsafe_url"
    assert result.error == "图片地址未通过安全检查"
    assert result.url == ""


@pytest.mark.asyncio
async def test_import_remote_image_rejects_private_dns_target(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setattr(
        remote_image_import,
        "_resolve_addresses",
        lambda *_args, **_kwargs: _private_dns_result(),
    )

    result = await remote_image_import.import_remote_image(
        "https://images.example/private.png",
        tmp_path,
    )

    assert result.error_code == "unsafe_url"
    assert result.url == ""


@pytest.mark.asyncio
async def test_import_remote_image_uses_a_direct_non_redirecting_client(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setattr(remote_image_import, "_resolve_addresses", _public_dns)
    captured: dict = {}

    def handler(request: httpx.Request):
        return httpx.Response(
            200,
            content=_png_bytes(),
            headers={"content-type": "image/png"},
            request=request,
        )

    result = await remote_image_import.import_remote_image(
        "https://images.example/a.png",
        tmp_path,
        client_factory=_client_factory(handler, captured),
    )

    assert result.error_code == ""
    assert result.url.startswith("/api/uploads/asset-image-")
    assert captured["trust_env"] is False
    assert captured["follow_redirects"] is False


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("content_type", "body"),
    [
        ("text/html", b"<html>not an image</html>"),
        ("image/png", b"not really a png"),
        ("image/jpeg", _png_bytes()),
    ],
)
async def test_import_remote_image_rejects_unsupported_or_misleading_content(
    tmp_path,
    monkeypatch,
    content_type,
    body,
):
    monkeypatch.setattr(remote_image_import, "_resolve_addresses", _public_dns)

    def handler(request: httpx.Request):
        return httpx.Response(
            200,
            content=body,
            headers={"content-type": content_type},
            request=request,
        )

    result = await remote_image_import.import_remote_image(
        "https://images.example/not-image",
        tmp_path,
        client_factory=_client_factory(handler, {}),
    )

    assert result.error_code == "not_image"
    assert list(tmp_path.iterdir()) == []


@pytest.mark.asyncio
@pytest.mark.parametrize("declare_length", [True, False])
async def test_import_remote_image_stops_oversized_responses(
    tmp_path,
    monkeypatch,
    declare_length,
):
    monkeypatch.setattr(remote_image_import, "_resolve_addresses", _public_dns)
    monkeypatch.setattr(remote_image_import, "MAX_IMAGE_BYTES", 16)
    headers = {"content-type": "image/png"}
    if declare_length:
        headers["content-length"] = "17"

    def handler(request: httpx.Request):
        return httpx.Response(
            200,
            content=b"x" * 17,
            headers=headers,
            request=request,
        )

    result = await remote_image_import.import_remote_image(
        "https://images.example/large.png",
        tmp_path,
        client_factory=_client_factory(handler, {}),
    )

    assert result.error_code == "too_large"
    assert list(tmp_path.iterdir()) == []


@pytest.mark.asyncio
async def test_import_remote_image_categorizes_timeout(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setattr(remote_image_import, "_resolve_addresses", _public_dns)

    def handler(request: httpx.Request):
        raise httpx.ReadTimeout("late", request=request)

    result = await remote_image_import.import_remote_image(
        "https://images.example/slow.png",
        tmp_path,
        client_factory=_client_factory(handler, {}),
    )

    assert result.error_code == "timeout"
    assert result.error == "图片下载超时"


@pytest.mark.asyncio
async def test_import_remote_image_revalidates_redirect_target(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setattr(remote_image_import, "_resolve_addresses", _public_dns)

    def handler(request: httpx.Request):
        return httpx.Response(
            302,
            headers={"location": "http://127.0.0.1/private.png"},
            request=request,
        )

    result = await remote_image_import.import_remote_image(
        "https://images.example/redirect.png",
        tmp_path,
        client_factory=_client_factory(handler, {}),
    )

    assert result.error_code == "unsafe_url"


@pytest.mark.asyncio
async def test_import_remote_image_limits_redirect_count(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setattr(remote_image_import, "_resolve_addresses", _public_dns)
    seen = []

    def handler(request: httpx.Request):
        seen.append(str(request.url))
        return httpx.Response(
            302,
            headers={"location": f"/redirect-{len(seen)}.png"},
            request=request,
        )

    result = await remote_image_import.import_remote_image(
        "https://images.example/start.png",
        tmp_path,
        client_factory=_client_factory(handler, {}),
    )

    assert result.error_code == "unreachable"
    assert len(seen) == remote_image_import.MAX_REDIRECTS + 1


@pytest.mark.asyncio
async def test_import_remote_images_preserves_order_and_partial_failures(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setattr(remote_image_import, "_resolve_addresses", _public_dns)

    def handler(request: httpx.Request):
        if request.url.path.endswith("missing.png"):
            return httpx.Response(404, request=request)
        return httpx.Response(
            200,
            content=_png_bytes(),
            headers={"content-type": "image/png"},
            request=request,
        )

    urls = [
        "https://images.example/a.png",
        "https://images.example/missing.png",
        "https://images.example/c.png",
    ]
    results = await remote_image_import.import_remote_images(
        urls,
        tmp_path,
        client_factory=_client_factory(handler, {}),
    )

    assert [item.source_url for item in results] == urls
    assert [item.error_code for item in results] == ["", "unreachable", ""]
    assert results[0].url == results[2].url
    assert len(list(tmp_path.glob("asset-image-*.png"))) == 1


@pytest.mark.asyncio
async def test_import_remote_image_reuses_content_hash_across_urls(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setattr(remote_image_import, "_resolve_addresses", _public_dns)

    def handler(request: httpx.Request):
        return httpx.Response(
            200,
            content=_png_bytes(),
            headers={"content-type": "image/png"},
            request=request,
        )

    results = await remote_image_import.import_remote_images(
        [
            "https://images.example/first.png",
            "https://cdn.example/second.png",
        ],
        tmp_path,
        client_factory=_client_factory(handler, {}),
    )

    assert results[0].url == results[1].url
    stored = list(tmp_path.glob("asset-image-*.png"))
    assert len(stored) == 1
    assert stored[0].read_bytes() == _png_bytes()
