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
