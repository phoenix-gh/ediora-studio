"""微信公众号官方 API 客户端 — 发布草稿到公众号草稿箱。

与 wechat_mp_client.py（mp.weixin.qq.com 网页扫码通道，只读采集）无关。
本模块走 api.weixin.qq.com 官方接口：token → uploadimg（正文图片）→
add_material（封面）→ draft/add。要求运行机器出口 IP 在公众号后台白名单内。
"""

from __future__ import annotations
import io
import json
import re
import time
from typing import Any, Awaitable, Callable

import httpx

WX_API_BASE = "https://api.weixin.qq.com"

# uploadimg 硬限制：jpg/png 且 1MB 以内
_CONTENT_IMG_MAX = 1024 * 1024

_IMG_SRC_RE = re.compile(r'<img[^>]*?\ssrc="([^"]+)"', re.IGNORECASE)


# ── 纯函数：HTML 图片处理 ─────────────────────────────────────────────────────

def extract_image_srcs(html: str) -> list[str]:
    """按出现顺序提取去重后的 <img src> 列表。"""
    seen: set[str] = set()
    out: list[str] = []
    for m in _IMG_SRC_RE.finditer(html):
        src = m.group(1)
        if src not in seen:
            seen.add(src)
            out.append(src)
    return out


def replace_image_srcs(html: str, mapping: dict[str, str]) -> str:
    """把 mapping 中出现的 src 替换为对应值，其余原样保留。
    只动 src 属性值本身，HTML 其余字节不变（微信编辑器对内联样式敏感）。"""
    def _sub(m: re.Match) -> str:
        full, src = m.group(0), m.group(1)
        new = mapping.get(src)
        if new is None:
            return full
        start = m.start(1) - m.start(0)
        end = m.end(1) - m.start(0)
        return full[:start] + new + full[end:]
    return _IMG_SRC_RE.sub(_sub, html)


def prepare_image_bytes(data: bytes, mime: str) -> tuple[bytes, str, str]:
    """把图片整理成 uploadimg 可接受的形态（jpg/png、≤1MB）。
    返回 (bytes, 扩展名, mime)。非 jpg/png 一律转 JPEG；超限逐级降质/缩边。"""
    if mime in ("image/jpeg", "image/png") and len(data) <= _CONTENT_IMG_MAX:
        return data, ("jpg" if mime == "image/jpeg" else "png"), mime

    from PIL import Image
    img = Image.open(io.BytesIO(data))
    if img.mode != "RGB":
        img = img.convert("RGB")
    quality = 85
    while True:
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=quality)
        out = buf.getvalue()
        if len(out) <= _CONTENT_IMG_MAX:
            return out, "jpg", "image/jpeg"
        if quality > 50:
            quality -= 10
        else:
            w, h = img.size
            img = img.resize((max(w // 2, 1), max(h // 2, 1)))


# ── 官方 API：token / 上传 / 草稿 ─────────────────────────────────────────────

class WechatApiError(RuntimeError):
    """微信接口 errcode != 0。message 已转成面向用户的中文说明。"""

    def __init__(self, errcode: int, errmsg: str):
        self.errcode = errcode
        self.errmsg = errmsg
        super().__init__(self._friendly())

    def _friendly(self) -> str:
        if self.errcode == 40164:
            return (
                f"服务器 IP 不在公众号 IP 白名单（{self.errmsg}）。"
                "请到公众号后台「设置与开发 → 安全中心 → IP 白名单」添加后重试。"
            )
        if self.errcode in (40013, 40125, 41004):
            return f"AppID 或 AppSecret 不正确（errcode={self.errcode}: {self.errmsg}）"
        return f"微信接口错误 errcode={self.errcode}: {self.errmsg}"


# app_id -> (token, 失效时刻)。微信 token 有效期 7200s，提前 5 分钟视为过期。
_token_cache: dict[str, tuple[str, float]] = {}


def _client() -> httpx.AsyncClient:
    """测试通过 monkeypatch 本函数注入 MockTransport。"""
    return httpx.AsyncClient(timeout=30)


async def get_access_token(app_id: str, app_secret: str, force: bool = False) -> str:
    now = time.time()
    if not force:
        cached = _token_cache.get(app_id)
        if cached and cached[1] > now:
            return cached[0]
    async with _client() as client:
        resp = await client.get(f"{WX_API_BASE}/cgi-bin/token", params={
            "grant_type": "client_credential", "appid": app_id, "secret": app_secret,
        })
        resp.raise_for_status()
        data = resp.json()
    if "access_token" not in data:
        raise WechatApiError(data.get("errcode", -1), data.get("errmsg", str(data)))
    _token_cache[app_id] = (data["access_token"], now + int(data.get("expires_in", 7200)) - 300)
    return data["access_token"]


def _check(data: dict[str, Any]) -> None:
    if data.get("errcode", 0) != 0:
        raise WechatApiError(data["errcode"], data.get("errmsg", ""))


async def _with_token_retry(
    app_id: str, app_secret: str,
    do: Callable[[str], Awaitable[dict[str, Any]]],
) -> dict[str, Any]:
    """token 失效（40001/42001）时强刷重试一次，其余错误直接抛。"""
    token = await get_access_token(app_id, app_secret)
    data = await do(token)
    if data.get("errcode") in (40001, 42001):
        token = await get_access_token(app_id, app_secret, force=True)
        data = await do(token)
    _check(data)
    return data


async def upload_content_image(app_id: str, app_secret: str,
                               data: bytes, filename: str, mime: str) -> str:
    """正文图片 → 微信图床 URL（mmbiz.qpic.cn）。外域图片微信会剥离，必须走这里。"""
    async def do(token: str) -> dict[str, Any]:
        async with _client() as client:
            resp = await client.post(
                f"{WX_API_BASE}/cgi-bin/media/uploadimg",
                params={"access_token": token},
                files={"media": (filename, data, mime)},
            )
            resp.raise_for_status()
            return resp.json()
    return (await _with_token_retry(app_id, app_secret, do))["url"]


async def add_thumb_material(app_id: str, app_secret: str,
                             data: bytes, filename: str, mime: str) -> str:
    """封面图存为永久素材，返回 thumb_media_id。"""
    async def do(token: str) -> dict[str, Any]:
        async with _client() as client:
            resp = await client.post(
                f"{WX_API_BASE}/cgi-bin/material/add_material",
                params={"access_token": token, "type": "image"},
                files={"media": (filename, data, mime)},
            )
            resp.raise_for_status()
            return resp.json()
    return (await _with_token_retry(app_id, app_secret, do))["media_id"]


async def add_draft(app_id: str, app_secret: str, article: dict[str, Any]) -> str:
    """新增图文到公众号草稿箱，返回草稿 media_id。中文须按 UTF-8 原样发送。"""
    payload = json.dumps({"articles": [article]}, ensure_ascii=False).encode("utf-8")

    async def do(token: str) -> dict[str, Any]:
        async with _client() as client:
            resp = await client.post(
                f"{WX_API_BASE}/cgi-bin/draft/add",
                params={"access_token": token},
                content=payload,
                headers={"Content-Type": "application/json; charset=utf-8"},
            )
            resp.raise_for_status()
            return resp.json()
    return (await _with_token_retry(app_id, app_secret, do))["media_id"]
