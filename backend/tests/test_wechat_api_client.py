import io
import os

import httpx
import pytest
from PIL import Image

import wechat_api_client as wx
from wechat_api_client import extract_image_srcs, replace_image_srcs, prepare_image_bytes


def _img_bytes(fmt: str, size=(10, 10)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, "red").save(buf, format=fmt)
    return buf.getvalue()


def test_extract_image_srcs_dedup_and_order():
    html = ('<p><img src="http://a/1.png"></p>'
            '<img style="width:100%" src="http://a/2.png" alt="x">'
            '<img src="http://a/1.png">')
    assert extract_image_srcs(html) == ["http://a/1.png", "http://a/2.png"]


def test_extract_image_srcs_empty():
    assert extract_image_srcs("<p>no images</p>") == []


def test_replace_image_srcs_only_mapped():
    html = '<img src="http://a/1.png"><img src="http://a/2.png">'
    out = replace_image_srcs(html, {"http://a/1.png": "https://mmbiz.qpic.cn/x"})
    assert out == '<img src="https://mmbiz.qpic.cn/x"><img src="http://a/2.png">'


def test_prepare_small_png_passthrough():
    data = _img_bytes("PNG")
    out, ext, mime = prepare_image_bytes(data, "image/png")
    assert out == data and ext == "png" and mime == "image/png"


def test_prepare_webp_converted_to_jpeg():
    out, ext, mime = prepare_image_bytes(_img_bytes("WEBP"), "image/webp")
    assert mime == "image/jpeg" and ext == "jpg"
    assert Image.open(io.BytesIO(out)).format == "JPEG"


def test_prepare_oversized_compressed_under_1mb():
    raw = Image.frombytes("RGB", (1500, 1500), os.urandom(1500 * 1500 * 3))
    buf = io.BytesIO()
    raw.save(buf, format="PNG")
    big = buf.getvalue()
    assert len(big) > 1024 * 1024
    out, ext, mime = prepare_image_bytes(big, "image/png")
    assert len(out) <= 1024 * 1024 and mime == "image/jpeg"


# ── token 缓存与官方 API 调用 ─────────────────────────────────────────────────

def _mock_client(handler):
    """替换 wx._client，让所有请求走 MockTransport。"""
    return lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.fixture(autouse=True)
def _clear_token_cache(monkeypatch):
    async def _disabled_tunnel_config():
        return {"wechat_tunnel_enabled": "0"}

    wx._token_cache.clear()
    monkeypatch.setattr(wx, "get_config", _disabled_tunnel_config)
    yield
    wx._token_cache.clear()


async def test_access_token_cached(monkeypatch):
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/cgi-bin/token"
        calls["n"] += 1
        return httpx.Response(200, json={"access_token": f"T{calls['n']}", "expires_in": 7200})

    monkeypatch.setattr(wx, "_client", _mock_client(handler))
    assert await wx.get_access_token("app1", "sec") == "T1"
    assert await wx.get_access_token("app1", "sec") == "T1"   # 命中缓存
    assert calls["n"] == 1
    assert await wx.get_access_token("app1", "sec", force=True) == "T2"  # 强刷


async def test_token_error_raises(monkeypatch):
    def handler(request):
        return httpx.Response(200, json={"errcode": 40013, "errmsg": "invalid appid"})

    monkeypatch.setattr(wx, "_client", _mock_client(handler))
    with pytest.raises(wx.WechatApiError) as ei:
        await wx.get_access_token("bad", "sec")
    assert "AppID" in str(ei.value)


async def test_upload_retries_on_expired_token(monkeypatch):
    state = {"token_calls": 0, "upload_calls": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/cgi-bin/token":
            state["token_calls"] += 1
            return httpx.Response(200, json={"access_token": f"T{state['token_calls']}", "expires_in": 7200})
        if request.url.path == "/cgi-bin/media/uploadimg":
            state["upload_calls"] += 1
            if state["upload_calls"] == 1:
                return httpx.Response(200, json={"errcode": 42001, "errmsg": "access_token expired"})
            return httpx.Response(200, json={"url": "https://mmbiz.qpic.cn/ok"})
        raise AssertionError(request.url.path)

    monkeypatch.setattr(wx, "_client", _mock_client(handler))
    url = await wx.upload_content_image("app1", "sec", b"xx", "img.jpg", "image/jpeg")
    assert url == "https://mmbiz.qpic.cn/ok"
    assert state["token_calls"] == 2 and state["upload_calls"] == 2


async def test_ip_whitelist_error_friendly(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/cgi-bin/token":
            return httpx.Response(200, json={"access_token": "T", "expires_in": 7200})
        return httpx.Response(200, json={"errcode": 40164, "errmsg": "invalid ip 1.2.3.4, not in whitelist"})

    monkeypatch.setattr(wx, "_client", _mock_client(handler))
    with pytest.raises(wx.WechatApiError) as ei:
        await wx.upload_content_image("app1", "sec", b"xx", "img.jpg", "image/jpeg")
    msg = str(ei.value)
    assert "IP 白名单" in msg and "1.2.3.4" in msg


async def test_add_draft_returns_media_id(monkeypatch):
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/cgi-bin/token":
            return httpx.Response(200, json={"access_token": "T", "expires_in": 7200})
        if request.url.path == "/cgi-bin/draft/add":
            captured["body"] = request.content
            return httpx.Response(200, json={"media_id": "MEDIA_1"})
        raise AssertionError(request.url.path)

    monkeypatch.setattr(wx, "_client", _mock_client(handler))
    media_id = await wx.add_draft("app1", "sec", {"title": "标题", "content": "<p>正文</p>", "thumb_media_id": "TH"})
    assert media_id == "MEDIA_1"
    # 中文按 UTF-8 原样发送（不经 ensure_ascii 转义）
    assert "标题".encode("utf-8") in captured["body"]


def test_tunnel_command_uses_noninteractive_ssh():
    cmd, local_host, local_port, remote_host = wx._tunnel_command({
        "wechat_tunnel_ssh_host": "jump.example.com",
        "wechat_tunnel_ssh_user": "ubuntu",
        "wechat_tunnel_ssh_port": "2222",
        "wechat_tunnel_ssh_key_path": "/home/u/.ssh/id_ed25519",
        "wechat_tunnel_local_host": "127.0.0.1",
        "wechat_tunnel_local_port": "18443",
        "wechat_tunnel_remote_host": "api.weixin.qq.com",
        "wechat_tunnel_remote_port": "443",
    })
    assert cmd[:4] == ["ssh", "-N", "-T", "-L"]
    assert "127.0.0.1:18443:api.weixin.qq.com:443" in cmd
    assert "BatchMode=yes" in cmd
    assert "ConnectTimeout=10" in cmd
    assert local_host == "127.0.0.1"
    assert local_port == 18443
    assert remote_host == "api.weixin.qq.com"
