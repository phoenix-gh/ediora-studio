# 公众号发布功能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 草稿页一键将 markdown 渲染为公众号排版（多主题可选）、预览并存入微信公众号草稿箱。

**Architecture:** 前端用 `@wenyan-md/core`（已安装，v3.0.10）在浏览器内把 md 渲染成内联样式 HTML，发布对话框内 iframe 预览；后端新增 `wechat_api_client.py` 走微信官方 API（token → uploadimg 替换正文图片 → add_material 封面 → draft/add 存草稿箱）。凭证存于 `publish_accounts` 表新增的 `app_id`/`app_secret` 列。

**Tech Stack:** FastAPI + SQLAlchemy(async) + httpx + Pillow；Next.js + shadcn/ui + @wenyan-md/core。

**Spec:** `docs/superpowers/specs/2026-06-10-wechat-mp-publish-design.md`

**事实备忘（已验证）：**
- 后端草稿模型叫 `ArticleDraft`（不是 Draft），drafts router 前缀 `/write`，挂在 `/api` 下
- `@wenyan-md/core` 浏览器 API：`createWenyanCore({isWechat:true})` → `{renderMarkdown, applyStylesWithTheme}`；`registerAllBuiltInThemes()` / `registerBuiltInHlThemes()` / `getAllGzhThemes(): Theme[]`（`theme.meta.{id,name,description}`）
- 内置公众号主题 ID：`default, lapis, maize, orangeheart, phycat, pie, purple, rainbow`；高亮主题含 `solarized-light, github, atom-one-light` 等
- 后端环境：conda env `wems`（命令一律 `conda run -n wems` 前缀）；Pillow 10.4.0、httpx 已装
- 测试 fixture 模式照抄 `tests/test_x_router.py`（重导入 + sqlite tmp db + TestClient）；`asyncio_mode = "auto"`
- main 上已有既存失败测试（writing_plans 相关），不计入本功能
- 所有 Bash 命令先 `source ~/.zshrc`

---

### Task 1: PublishAccount 模型/Schema 加 app_id、app_secret

**Files:**
- Modify: `backend/models.py`（class PublishAccount, ~L40 `is_active` 之前）
- Modify: `backend/schemas.py`（PublishAccountCreate L6 / PublishAccountOut L23 / PublishAccountUpdate L43）
- Test: `backend/tests/test_wechat_publish.py`（新建）

- [ ] **Step 1: 写失败测试**

新建 `backend/tests/test_wechat_publish.py`：

```python
import sys
import asyncio
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch, tmp_path):
    db_file = tmp_path / "test.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite+aiosqlite:///{db_file}")
    monkeypatch.setenv("DISABLE_SCHEDULER", "1")

    for mod in list(sys.modules):
        if mod.startswith(("database", "models", "main", "routers", "config")):
            sys.modules.pop(mod, None)

    from database import engine, Base
    import models  # noqa: F401

    async def _create():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    asyncio.new_event_loop().run_until_complete(_create())

    from main import app
    return TestClient(app)


def test_publish_account_credentials_roundtrip(client):
    r = client.post("/api/publish-accounts", json={
        "id": "gzh_main", "name": "主号", "platform": "wechat",
        "app_id": "wx123", "app_secret": "sec456",
    })
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["app_id"] == "wx123"
    assert body["app_secret"] == "sec456"

    r2 = client.patch("/api/publish-accounts/gzh_main", json={"app_secret": "sec789"})
    assert r2.status_code == 200
    assert r2.json()["app_secret"] == "sec789"
```

- [ ] **Step 2: 跑测试确认失败**

```bash
source ~/.zshrc && cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_wechat_publish.py -v
```
预期：FAIL（响应里没有 `app_id` 字段，KeyError 或断言失败）。

- [ ] **Step 3: 实现**

`backend/models.py` 的 `PublishAccount`，在 `is_active` 行之前加：

```python
    app_id: Mapped[str] = mapped_column(String, default="")       # 公众号开发者 AppID
    app_secret: Mapped[str] = mapped_column(String, default="")   # 仅用于发布到草稿箱
```

`backend/schemas.py`：
- `PublishAccountCreate` 加 `app_id: str = ""` 与 `app_secret: str = ""`
- `PublishAccountOut` 加 `app_id: str` 与 `app_secret: str`
- `PublishAccountUpdate` 加 `app_id: Optional[str] = None` 与 `app_secret: Optional[str] = None`

- [ ] **Step 4: 跑测试确认通过**

```bash
source ~/.zshrc && cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_wechat_publish.py -v
```
预期：PASS

- [ ] **Step 5: 给开发库手动加列（项目无迁移框架，create_all 不改已有表）**

```bash
source ~/.zshrc && cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -c "
import asyncio
from sqlalchemy import text
from database import engine

async def main():
    async with engine.begin() as conn:
        for col in ('app_id', 'app_secret'):
            try:
                await conn.execute(text(f\"ALTER TABLE publish_accounts ADD COLUMN {col} VARCHAR DEFAULT '' NOT NULL\"))
                print('added', col)
            except Exception as e:
                print('skip', col, type(e).__name__)
asyncio.run(main())
"
```
预期：两行 `added`（重复执行则两行 `skip`，幂等）。
**线上 Postgres 需用户自行执行同样的 ALTER（写进 commit message 提醒）。**

- [ ] **Step 6: Commit**

```bash
source ~/.zshrc && cd /workspace/projects/WeMediaStudio && git add backend/models.py backend/schemas.py backend/tests/test_wechat_publish.py && git commit -m "feat(publish): publish_accounts 加 app_id/app_secret 凭证列

线上 Postgres 需手动: ALTER TABLE publish_accounts ADD COLUMN app_id VARCHAR DEFAULT '' NOT NULL; ALTER TABLE publish_accounts ADD COLUMN app_secret VARCHAR DEFAULT '' NOT NULL;

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: wechat_api_client.py 纯函数（图片提取/替换/压缩）

**Files:**
- Create: `backend/wechat_api_client.py`
- Test: `backend/tests/test_wechat_api_client.py`（新建）

- [ ] **Step 1: 写失败测试**

新建 `backend/tests/test_wechat_api_client.py`：

```python
import io
import os
from PIL import Image

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
```

- [ ] **Step 2: 跑测试确认失败**

```bash
source ~/.zshrc && cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_wechat_api_client.py -v
```
预期：FAIL，`ModuleNotFoundError: No module named 'wechat_api_client'`

- [ ] **Step 3: 实现**

新建 `backend/wechat_api_client.py`：

```python
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
```

（token/API 调用部分在 Task 3 追加到同一文件。）

- [ ] **Step 4: 跑测试确认通过**

```bash
source ~/.zshrc && cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_wechat_api_client.py -v
```
预期：6 个 PASS

- [ ] **Step 5: Commit**

```bash
source ~/.zshrc && cd /workspace/projects/WeMediaStudio && git add backend/wechat_api_client.py backend/tests/test_wechat_api_client.py && git commit -m "feat(publish): 公众号官方 API 客户端 — 图片提取/替换/压缩纯函数

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: wechat_api_client.py token 缓存 + 官方 API 调用

**Files:**
- Modify: `backend/wechat_api_client.py`（文件末尾追加）
- Test: `backend/tests/test_wechat_api_client.py`（追加）

- [ ] **Step 1: 写失败测试**

在 `tests/test_wechat_api_client.py` 顶部 import 区加 `import httpx`、`import pytest`、`import wechat_api_client as wx`，文件末尾追加：

```python
def _mock_client(handler):
    """替换 wx._client，让所有请求走 MockTransport。"""
    return lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.fixture(autouse=True)
def _clear_token_cache():
    wx._token_cache.clear()
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
```

- [ ] **Step 2: 跑测试确认失败**

```bash
source ~/.zshrc && cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_wechat_api_client.py -v
```
预期：新增用例 FAIL（`AttributeError: ... 'wx' has no attribute '_token_cache'` 等），Task 2 的 6 个仍 PASS。

- [ ] **Step 3: 实现**

`backend/wechat_api_client.py` 末尾追加：

```python
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
```

- [ ] **Step 4: 跑测试确认通过**

```bash
source ~/.zshrc && cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_wechat_api_client.py -v
```
预期：11 个全 PASS

- [ ] **Step 5: Commit**

```bash
source ~/.zshrc && cd /workspace/projects/WeMediaStudio && git add backend/wechat_api_client.py backend/tests/test_wechat_api_client.py && git commit -m "feat(publish): 公众号官方 API — token 缓存/uploadimg/add_material/draft_add

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: 发布端点 POST /write/drafts/{id}/publish/wechat

**Files:**
- Modify: `backend/routers/drafts.py`
- Test: `backend/tests/test_wechat_publish.py`（追加）

- [ ] **Step 1: 写失败测试**

`tests/test_wechat_publish.py` 顶部 import 区加 `import io`、`import httpx`，文件末尾追加：

```python
def _png_file():
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (10, 10), "blue").save(buf, format="PNG")
    buf.seek(0)
    return ("cover.png", buf, "image/png")


def _wx_handler(request: httpx.Request) -> httpx.Response:
    p = request.url.path
    if p == "/cgi-bin/token":
        return httpx.Response(200, json={"access_token": "T", "expires_in": 7200})
    if p == "/cgi-bin/media/uploadimg":
        return httpx.Response(200, json={"url": "https://mmbiz.qpic.cn/content1"})
    if p == "/cgi-bin/material/add_material":
        return httpx.Response(200, json={"media_id": "THUMB1", "url": "https://mmbiz.qpic.cn/cover"})
    if p == "/cgi-bin/draft/add":
        return httpx.Response(200, json={"media_id": "DRAFT_MEDIA_1"})
    raise AssertionError(p)


@pytest.fixture
def wx_mock(monkeypatch, tmp_path):
    import wechat_api_client as wx
    wx._token_cache.clear()
    monkeypatch.setattr(
        wx, "_client",
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(_wx_handler)),
    )
    yield wx
    wx._token_cache.clear()


@pytest.fixture
def uploads_dir(client, monkeypatch, tmp_path):
    """client fixture 重导入 routers.drafts 后，把上传目录指到 tmp。"""
    import routers.drafts as drafts_mod
    d = tmp_path / "uploads"
    d.mkdir()
    monkeypatch.setattr(drafts_mod, "_UPLOADS_DIR", str(d))
    return d


def _setup_draft_with_image(client):
    acc = client.post("/api/publish-accounts", json={
        "id": "gzh", "name": "号", "platform": "wechat",
        "app_id": "wx1", "app_secret": "s1",
    })
    assert acc.status_code == 201
    draft = client.post("/api/write/drafts", json={"title": "测试文章", "content": "# hi"}).json()
    img = client.post(f"/api/write/drafts/{draft['id']}/images", files={"file": _png_file()}).json()
    return draft, img


def test_publish_happy_path(client, uploads_dir, wx_mock):
    draft, img = _setup_draft_with_image(client)
    html = f'<section><p style="color:#333">正文</p><img src="{img["url"]}"></section>'
    r = client.post(f"/api/write/drafts/{draft['id']}/publish/wechat", json={
        "account_id": "gzh", "title": "测试文章", "digest": "摘要",
        "html": html, "cover_image_id": img["id"],
    })
    assert r.status_code == 200, r.text
    assert r.json()["media_id"] == "DRAFT_MEDIA_1"


def test_publish_account_without_credentials(client, uploads_dir, wx_mock):
    client.post("/api/publish-accounts", json={"id": "nocred", "name": "无凭证", "platform": "wechat"})
    draft = client.post("/api/write/drafts", json={"title": "t", "content": "c"}).json()
    img = client.post(f"/api/write/drafts/{draft['id']}/images", files={"file": _png_file()}).json()
    r = client.post(f"/api/write/drafts/{draft['id']}/publish/wechat", json={
        "account_id": "nocred", "title": "t", "digest": "",
        "html": "<p>x</p>", "cover_image_id": img["id"],
    })
    assert r.status_code == 400
    assert "AppID" in r.json()["detail"]


def test_publish_missing_cover(client, uploads_dir, wx_mock):
    draft, img = _setup_draft_with_image(client)
    r = client.post(f"/api/write/drafts/{draft['id']}/publish/wechat", json={
        "account_id": "gzh", "title": "t", "digest": "",
        "html": "<p>x</p>", "cover_image_id": 99999,
    })
    assert r.status_code == 404


def test_publish_wechat_error_surfaces_as_502(client, uploads_dir, monkeypatch):
    import wechat_api_client as wx
    wx._token_cache.clear()

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/cgi-bin/token":
            return httpx.Response(200, json={"access_token": "T", "expires_in": 7200})
        return httpx.Response(200, json={"errcode": 40164, "errmsg": "invalid ip 9.9.9.9, not in whitelist"})

    monkeypatch.setattr(wx, "_client", lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    draft, img = _setup_draft_with_image(client)
    r = client.post(f"/api/write/drafts/{draft['id']}/publish/wechat", json={
        "account_id": "gzh", "title": "t", "digest": "",
        "html": "<p>x</p>", "cover_image_id": img["id"],
    })
    assert r.status_code == 502
    assert "IP 白名单" in r.json()["detail"]
    wx._token_cache.clear()
```

- [ ] **Step 2: 跑测试确认失败**

```bash
source ~/.zshrc && cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_wechat_publish.py -v
```
预期：新增 4 个 FAIL（404 Not Found，端点不存在）；Task 1 用例仍 PASS。

- [ ] **Step 3: 实现**

`backend/routers/drafts.py`：

顶部 import 区追加：

```python
import mimetypes
import httpx
import wechat_api_client as wx
from models import ArticleDraft, ArticleSeries, DraftImage, PublishAccount
```
（`from models import ...` 一行是替换原有 L10。）

在 `class DraftChatResponse` 之后追加：

```python
class WechatPublishRequest(BaseModel):
    account_id: str
    title: str
    digest: str = ""
    html: str               # 前端 wenyan 渲染好的内联样式 HTML
    cover_image_id: int


class WechatPublishResponse(BaseModel):
    media_id: str
```

在 `delete_draft` 之前追加：

```python
# ── 发布到公众号 ──────────────────────────────────────────────────────────────

async def _load_image_bytes(src: str) -> tuple[bytes, str]:
    """把 <img src> 解析成字节。本站 uploads 直接读盘，其余按外链下载。"""
    if "/api/uploads/" in src:
        filename = src.rsplit("/", 1)[-1].split("?")[0]
        path = os.path.join(_UPLOADS_DIR, filename)
        if not os.path.isfile(path):
            raise HTTPException(404, f"图片文件缺失: {filename}")
        mime = mimetypes.guess_type(filename)[0] or "image/jpeg"
        with open(path, "rb") as f:
            return f.read(), mime
    if src.startswith(("http://", "https://")):
        async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
            resp = await client.get(src)
            if resp.status_code != 200:
                raise HTTPException(502, f"外链图片下载失败({resp.status_code}): {src}")
            return resp.content, (resp.headers.get("content-type") or "image/jpeg").split(";")[0]
    raise HTTPException(400, f"无法解析图片地址: {src}")


@router.post("/drafts/{draft_id}/publish/wechat", response_model=WechatPublishResponse)
async def publish_draft_to_wechat(
    draft_id: int, body: WechatPublishRequest, db: AsyncSession = Depends(get_db),
):
    draft = await db.get(ArticleDraft, draft_id)
    if not draft:
        raise HTTPException(404, "Draft not found")
    account = await db.get(PublishAccount, body.account_id)
    if not account:
        raise HTTPException(404, "发布账号不存在")
    if not account.app_id or not account.app_secret:
        raise HTTPException(400, "该账号未配置 AppID/AppSecret，请到设置页补全")

    root_id = await _resolve_root_id(draft_id, db)
    cover = await db.get(DraftImage, body.cover_image_id)
    if not cover or cover.root_draft_id != root_id:
        raise HTTPException(404, "封面图不存在")
    cover_path = os.path.join(_UPLOADS_DIR, cover.filename)
    if not os.path.isfile(cover_path):
        raise HTTPException(404, "封面图文件缺失")

    html = body.html
    try:
        # 正文图片逐张传微信图床并替换 src —— 外域图片微信会剥离
        mapping: dict[str, str] = {}
        for src in wx.extract_image_srcs(html):
            data, mime = await _load_image_bytes(src)
            prepared, ext, p_mime = wx.prepare_image_bytes(data, mime)
            mapping[src] = await wx.upload_content_image(
                account.app_id, account.app_secret, prepared, f"img.{ext}", p_mime)
        html = wx.replace_image_srcs(html, mapping)

        with open(cover_path, "rb") as f:
            cover_data = f.read()
        c_data, c_ext, c_mime = wx.prepare_image_bytes(cover_data, cover.mime_type)
        thumb_media_id = await wx.add_thumb_material(
            account.app_id, account.app_secret, c_data, f"cover.{c_ext}", c_mime)

        media_id = await wx.add_draft(account.app_id, account.app_secret, {
            "title": body.title[:64],
            "digest": body.digest[:120],
            "content": html,
            "thumb_media_id": thumb_media_id,
            "need_open_comment": 1,
            "only_fans_can_comment": 0,
        })
    except wx.WechatApiError as e:
        raise HTTPException(502, str(e))
    except httpx.HTTPError as e:
        raise HTTPException(502, f"微信接口网络请求失败: {e}")
    return WechatPublishResponse(media_id=media_id)
```

- [ ] **Step 4: 跑测试确认通过**

```bash
source ~/.zshrc && cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_wechat_publish.py tests/test_wechat_api_client.py -v
```
预期：全 PASS

- [ ] **Step 5: 全量回归（允许 main 既存失败）**

```bash
source ~/.zshrc && cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/ -q 2>&1 | tail -5
```
预期：除 main 既存失败（writing_plans 相关）外无新增失败。

- [ ] **Step 6: Commit**

```bash
source ~/.zshrc && cd /workspace/projects/WeMediaStudio && git add backend/routers/drafts.py backend/tests/test_wechat_publish.py && git commit -m "feat(publish): 草稿发布到公众号草稿箱端点

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: 前端 API 封装 + 依赖入库

**Files:**
- Modify: `web/lib/api/publish-accounts.ts`（interface PublishAccount, L14）
- Modify: `web/lib/api/drafts.ts`（文件末尾）
- Modify: `web/package.json` + `pnpm-lock.yaml`（`@wenyan-md/core` 已装好，本 task 入库）

- [ ] **Step 1: PublishAccount 接口加字段**

`lib/api/publish-accounts.ts` 的 `interface PublishAccount` 内（`is_active` 之前）加：

```ts
  app_id: string
  app_secret: string
```
（`PublishAccountInput = Omit<PublishAccount, 'created_at'>` 自动随之扩展，无需改。）

- [ ] **Step 2: drafts.ts 加发布函数**

`lib/api/drafts.ts` 文件末尾追加：

```ts
export interface WechatPublishRequest {
  account_id: string
  title: string
  digest: string
  html: string
  cover_image_id: number
}

export async function publishDraftToWechat(
  draftId: number, body: WechatPublishRequest,
): Promise<{ media_id: string }> {
  return apiFetch(`/write/drafts/${draftId}/publish/wechat`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}
```

- [ ] **Step 3: 验证编译**

```bash
source ~/.zshrc && cd /workspace/projects/WeMediaStudio/web && pnpm lint 2>&1 | tail -5
```
预期：无新增 error（warning 不阻塞）。

- [ ] **Step 4: Commit**

```bash
source ~/.zshrc && cd /workspace/projects/WeMediaStudio && git add web/lib/api/publish-accounts.ts web/lib/api/drafts.ts web/package.json web/pnpm-lock.yaml && git commit -m "feat(publish): 前端公众号发布 API 封装 + @wenyan-md/core 依赖

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: 设置页发布账号表单加 AppID/AppSecret

**Files:**
- Modify: `web/app/settings/sections/PublishAccountsSection.tsx`

- [ ] **Step 1: EditState 与转换函数**

`interface EditState`（L22）加两个字段（`is_active` 之前）：

```ts
  app_id: string
  app_secret: string
```

`EMPTY_EDIT`（L54）加：

```ts
  app_id: '',
  app_secret: '',
```

`accountToEdit`（L73）加：

```ts
    app_id: p.app_id ?? '',
    app_secret: p.app_secret ?? '',
```

`editToInput` 的返回对象（L107）加：

```ts
    app_id: form.app_id.trim(),
    app_secret: form.app_secret.trim(),
```

- [ ] **Step 2: 表单 UI**

`AccountForm` 中，平台选择那个 `grid grid-cols-3` 块（L336-368）之后、「定位（positioning）」块之前，插入：

```tsx
      {form.platform === 'wechat' && (
        <div className="space-y-1">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">AppID（开发者ID）</Label>
              <Input
                value={form.app_id}
                onChange={e => setForm({ ...form, app_id: e.target.value })}
                placeholder="wx1234567890abcdef"
                className="h-8 text-sm font-mono"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">AppSecret</Label>
              <Input
                type="password"
                value={form.app_secret}
                onChange={e => setForm({ ...form, app_secret: e.target.value })}
                placeholder="开发者密码"
                className="h-8 text-sm font-mono"
              />
            </div>
          </div>
          <p className="text-[11px] text-zinc-400">
            用于「存入公众号草稿箱」。需在公众号后台开启开发者模式，并把运行后端的服务器出口 IP 加入 IP 白名单。
          </p>
        </div>
      )}
```

- [ ] **Step 3: 验证**

```bash
source ~/.zshrc && cd /workspace/projects/WeMediaStudio/web && pnpm lint 2>&1 | tail -5
```
预期：无新增 error。

- [ ] **Step 4: Commit**

```bash
source ~/.zshrc && cd /workspace/projects/WeMediaStudio && git add web/app/settings/sections/PublishAccountsSection.tsx && git commit -m "feat(publish): 设置页公众号账号表单加 AppID/AppSecret

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: WechatPublishDialog 发布对话框

**Files:**
- Create: `web/app/drafts/WechatPublishDialog.tsx`

布局（设计已确认）：左侧 390px 手机宽 iframe 预览，右侧账号/主题/标题/摘要/封面/按钮。

- [ ] **Step 1: 创建组件**

新建 `web/app/drafts/WechatPublishDialog.tsx`：

```tsx
'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import { Loader2, Copy, Send, ImageOff } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { DraftImage, publishDraftToWechat } from '@/lib/api/drafts'
import { PublishAccount, listPublishAccounts } from '@/lib/api/publish-accounts'

type WenyanModule = typeof import('@wenyan-md/core')
type WenyanInstance = Awaited<ReturnType<WenyanModule['createWenyanCore']>>

const THEME_STORAGE_KEY = 'wms-wechat-theme'
const HL_THEME_ID = 'solarized-light'

interface ThemeOption {
  id: string
  name: string
  description: string
}

/** markdown → 纯文本摘录，用作摘要默认值 */
function mdToPlainExcerpt(md: string, limit: number): string {
  return md
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[#>\-*+\s]+/gm, '')
    .replace(/[*`~_]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}

export function WechatPublishDialog({
  open, onClose, draftId, title, content, images,
}: {
  open: boolean
  onClose: () => void
  draftId: number
  title: string
  content: string
  images: DraftImage[]
}) {
  const [accounts, setAccounts] = useState<PublishAccount[]>([])
  const [accountId, setAccountId] = useState('')
  const [themes, setThemes] = useState<ThemeOption[]>([])
  const [themeId, setThemeId] = useState('default')
  const [coverId, setCoverId] = useState<number | null>(null)
  const [pubTitle, setPubTitle] = useState('')
  const [digest, setDigest] = useState('')
  const [html, setHtml] = useState('')
  const [rendering, setRendering] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const wenyanRef = useRef<WenyanInstance | null>(null)

  // 打开时：初始化表单默认值 + 加载账号 + 懒加载渲染引擎
  useEffect(() => {
    if (!open) return
    setPubTitle(title)
    setDigest(mdToPlainExcerpt(content, 120))
    setCoverId(images[0]?.id ?? null)
    setHtml('')
    listPublishAccounts()
      .then(list => {
        const usable = list.filter(a => a.platform === 'wechat' && a.app_id && a.app_secret)
        setAccounts(usable)
        setAccountId(prev => (usable.some(a => a.id === prev) ? prev : (usable[0]?.id ?? '')))
      })
      .catch(() => toast.error('加载发布账号失败'))
    ;(async () => {
      const saved = localStorage.getItem(THEME_STORAGE_KEY)
      if (saved) setThemeId(saved)
      if (wenyanRef.current) return
      const mod = await import('@wenyan-md/core')
      mod.registerAllBuiltInThemes()
      mod.registerBuiltInHlThemes()
      wenyanRef.current = await mod.createWenyanCore({ isWechat: true })
      setThemes(mod.getAllGzhThemes().map(t => ({
        id: t.meta.id, name: t.meta.name, description: t.meta.description,
      })))
    })().catch(() => toast.error('加载渲染引擎失败'))
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // 渲染：引擎就绪（themes 注册完成）或主题切换时重渲染
  useEffect(() => {
    if (!open || !wenyanRef.current) return
    let cancelled = false
    ;(async () => {
      setRendering(true)
      try {
        const wenyan = wenyanRef.current!
        const inner = await wenyan.renderMarkdown(content)
        // applyStylesWithTheme 需要挂在真实 DOM 上的元素来解析样式
        const el = document.createElement('div')
        el.style.position = 'fixed'
        el.style.left = '-99999px'
        el.innerHTML = inner
        document.body.appendChild(el)
        try {
          const styled = await wenyan.applyStylesWithTheme(el, {
            themeId,
            hlThemeId: HL_THEME_ID,
            isMacStyle: true,
            isAddFootnote: true,
          })
          if (!cancelled) setHtml(styled)
        } finally {
          el.remove()
        }
      } catch {
        if (!cancelled) toast.error('渲染失败')
      } finally {
        if (!cancelled) setRendering(false)
      }
    })()
    return () => { cancelled = true }
  }, [open, themeId, content, themes.length])

  function pickTheme(id: string) {
    setThemeId(id)
    try { localStorage.setItem(THEME_STORAGE_KEY, id) } catch {}
  }

  async function handleCopy() {
    if (!html) return
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([html], { type: 'text/plain' }),
        }),
      ])
      toast.success('已复制带样式内容，可直接粘贴到公众号编辑器')
    } catch {
      try {
        await navigator.clipboard.writeText(html)
        toast.success('已复制 HTML 源码')
      } catch {
        toast.error('复制失败')
      }
    }
  }

  async function handlePublish() {
    if (!accountId) { toast.error('请选择发布账号'); return }
    if (!coverId) { toast.error('请先在素材库上传封面图'); return }
    if (!pubTitle.trim()) { toast.error('标题不能为空'); return }
    if (!html) return
    setPublishing(true)
    try {
      await publishDraftToWechat(draftId, {
        account_id: accountId,
        title: pubTitle.trim(),
        digest,
        html,
        cover_image_id: coverId,
      })
      toast.success('已存入公众号草稿箱，请到公众号后台确认发布')
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '发布失败')
    } finally {
      setPublishing(false)
    }
  }

  const srcDoc = useMemo(
    () => `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:16px;background:#fff;}</style></head><body>${html}</body></html>`,
    [html],
  )

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-5xl h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>发布到公众号</DialogTitle>
          <DialogDescription>
            渲染排版后存入公众号草稿箱；群发请到公众号后台确认
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 flex gap-4 overflow-hidden min-h-0">
          {/* ── 预览 ── */}
          <div className="flex-1 min-w-0 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-100 dark:bg-zinc-900 flex justify-center overflow-hidden">
            {rendering || !html ? (
              <div className="flex items-center gap-2 text-zinc-400 text-sm">
                <Loader2 className="w-4 h-4 animate-spin" /> 渲染中…
              </div>
            ) : (
              <iframe
                srcDoc={srcDoc}
                sandbox=""
                title="公众号预览"
                className="w-[390px] h-full bg-white border-x border-zinc-200 dark:border-zinc-700"
              />
            )}
          </div>

          {/* ── 配置面板 ── */}
          <div className="w-72 flex-shrink-0 overflow-y-auto space-y-4 pr-1">
            <div className="space-y-1">
              <Label className="text-xs">发布账号</Label>
              {accounts.length === 0 ? (
                <p className="text-[11px] text-amber-500">
                  没有可用的公众号账号。请到「设置 → 发布账号」给 wechat 平台账号配置 AppID/AppSecret。
                </p>
              ) : (
                <select
                  value={accountId}
                  onChange={e => setAccountId(e.target.value)}
                  className="h-8 w-full rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 text-sm"
                >
                  {accounts.map(a => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              )}
            </div>

            <div className="space-y-1">
              <Label className="text-xs">排版主题</Label>
              <div className="space-y-1">
                {themes.map(t => (
                  <button
                    key={t.id}
                    onClick={() => pickTheme(t.id)}
                    className={cn(
                      'w-full text-left px-2.5 py-1.5 rounded-md border text-xs transition-colors',
                      themeId === t.id
                        ? 'border-indigo-400 bg-indigo-50 dark:bg-indigo-950/30 text-indigo-700 dark:text-indigo-300'
                        : 'border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:border-zinc-300 dark:hover:border-zinc-600',
                    )}
                  >
                    <span className="font-medium">{t.name}</span>
                    {t.description && (
                      <span className="block text-[10px] text-zinc-400 truncate">{t.description}</span>
                    )}
                  </button>
                ))}
                {themes.length === 0 && (
                  <p className="text-[11px] text-zinc-400">主题加载中…</p>
                )}
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-xs">标题（≤64 字）</Label>
              <Input
                value={pubTitle}
                maxLength={64}
                onChange={e => setPubTitle(e.target.value)}
                className="h-8 text-sm"
              />
            </div>

            <div className="space-y-1">
              <Label className="text-xs">摘要（≤120 字）</Label>
              <textarea
                value={digest}
                maxLength={120}
                onChange={e => setDigest(e.target.value)}
                rows={3}
                className="w-full resize-none rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
              />
            </div>

            <div className="space-y-1">
              <Label className="text-xs">封面（必选）</Label>
              {images.length === 0 ? (
                <div className="flex items-center gap-2 text-[11px] text-amber-500 border border-amber-200 dark:border-amber-900 rounded-md px-2.5 py-2">
                  <ImageOff className="w-3.5 h-3.5 flex-shrink-0" />
                  素材库没有图片，请先在「素材」里上传封面图
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-1.5">
                  {images.map(img => (
                    <button
                      key={img.id}
                      onClick={() => setCoverId(img.id)}
                      title={img.original_name}
                      className={cn(
                        'aspect-square rounded-md overflow-hidden border-2 transition-colors',
                        coverId === img.id ? 'border-indigo-400' : 'border-transparent hover:border-zinc-300',
                      )}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={img.hosted_url} alt={img.original_name} className="w-full h-full object-cover" />
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-2 pt-1">
              <Button
                variant="outline"
                size="sm"
                onClick={handleCopy}
                disabled={!html || rendering}
                className="w-full gap-1.5"
              >
                <Copy className="w-3.5 h-3.5" /> 复制 HTML
              </Button>
              <Button
                size="sm"
                onClick={handlePublish}
                disabled={publishing || rendering || !html || !accountId || !coverId}
                className="w-full gap-1.5"
              >
                {publishing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                存入公众号草稿箱
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: 验证**

```bash
source ~/.zshrc && cd /workspace/projects/WeMediaStudio/web && pnpm lint 2>&1 | tail -5
```
预期：无新增 error。

- [ ] **Step 3: Commit**

```bash
source ~/.zshrc && cd /workspace/projects/WeMediaStudio && git add web/app/drafts/WechatPublishDialog.tsx && git commit -m "feat(publish): 公众号发布对话框 — wenyan 渲染/主题切换/预览/封面摘要

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: DraftsClient 接线 + 构建验证

**Files:**
- Modify: `web/app/drafts/DraftsClient.tsx`

- [ ] **Step 1: 接线**

1. import 区（L25 附近）加：

```ts
import { WechatPublishDialog } from './WechatPublishDialog'
```

2. 状态区（`const [timelineOpen, setTimelineOpen] = useState(false)` 之后，L123 附近）加：

```ts
const [publishOpen, setPublishOpen] = useState(false)
```

3. 工具栏里「AI 写作」按钮之前（L742 附近）插入：

```tsx
                <Button
                  variant="outline" size="sm"
                  onClick={() => setPublishOpen(true)}
                  className="gap-1.5"
                  title="渲染排版并发布到微信公众号"
                >
                  <Send className="w-3.5 h-3.5" />
                  发布
                </Button>
```
（`Send` 已在 lucide import 里。）

4. 文件底部 `{selected && (<> ... </>)}` 块内、`<DraftAssetsDialog ... />` 之后加：

```tsx
          <WechatPublishDialog
            open={publishOpen}
            onClose={() => setPublishOpen(false)}
            draftId={selected.id}
            title={editTitle}
            content={editContent}
            images={images}
          />
```

- [ ] **Step 2: lint + 生产构建验证**

```bash
source ~/.zshrc && cd /workspace/projects/WeMediaStudio/web && pnpm lint 2>&1 | tail -5 && pnpm build 2>&1 | tail -15
```
预期：lint 无新增 error；`next build` 成功（@wenyan-md/core 为动态 import，不应进首屏 bundle）。
若 build 因 wenyan ESM 报错，按 `web/AGENTS.md` 要求查 `node_modules/next/dist/docs/` 中关于动态 import / 客户端组件的指南再修。

- [ ] **Step 3: Commit**

```bash
source ~/.zshrc && cd /workspace/projects/WeMediaStudio && git add web/app/drafts/DraftsClient.tsx && git commit -m "feat(publish): 草稿工具栏接入公众号发布对话框

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: 端到端手动验收（用户参与）

- [ ] **Step 1: 启动前后端**（按 `dev.sh` / 项目惯例）
- [ ] **Step 2: 设置页给 wechat 账号配置 AppID/AppSecret**
- [ ] **Step 3: 草稿页选一篇带图草稿 → 「发布」→ 切换主题看预览 → 「复制 HTML」粘贴到公众号编辑器验证样式**
- [ ] **Step 4: 「存入公众号草稿箱」→ 到 mp.weixin.qq.com 草稿箱确认文章/图片/封面/摘要齐全**

注意：Step 4 需要真实公众号凭证且后端出口 IP 已加白名单，由用户执行；agent 只验证到 Step 3 的渲染与复制。
