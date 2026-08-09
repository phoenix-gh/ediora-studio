import sys
import io
import json
import asyncio
import base64
import httpx
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch, postgres_env):
    monkeypatch.setenv(
        "WMS_WORKER_TOKEN", "test-worker-token-at-least-32-chars"
    )
    monkeypatch.delenv("MKFLOW_AGENT_API_TOKEN", raising=False)

    for mod in list(sys.modules):
        if mod.startswith(("database", "models", "main", "routers", "config", "blog_client")):
            sys.modules.pop(mod, None)

    from database import engine, Base
    import models  # noqa: F401

    async def _create():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    asyncio.new_event_loop().run_until_complete(_create())

    from main import app
    # load_dotenv() in main.py may re-set the token from .env; clear it again
    monkeypatch.delenv("MKFLOW_AGENT_API_TOKEN", raising=False)
    return TestClient(app)


@pytest.fixture
def uploads_dir(client, monkeypatch, tmp_path):
    import routers.drafts as drafts_mod
    d = tmp_path / "uploads"
    d.mkdir()
    monkeypatch.setattr(drafts_mod, "_UPLOADS_DIR", str(d))
    return d


def _png_file():
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (10, 10), "blue").save(buf, format="PNG")
    buf.seek(0)
    return ("chart.png", buf, "image/png")


@pytest.fixture
def blog_mock(monkeypatch):
    """Mock 博客接口，记录收到的请求体。"""
    import blog_client

    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        captured["auth"] = request.headers.get("authorization", "")
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={
            "id": 123, "slug": "agent-post", "status": "review",
            "adminUrl": "/a6e95a41/collections/posts/123",
            "images": [],
        })

    monkeypatch.setattr(
        blog_client, "_client",
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    return captured


def _set_blog_token(client, token="tok_abcd"):
    r = client.put("/api/settings", json={"blog_api_token": token})
    assert r.status_code == 200, r.text
    return r.json()


# ── 设置项 ────────────────────────────────────────────────────────────────────

def test_settings_blog_fields_roundtrip(client):
    r = client.get("/api/settings")
    assert r.status_code == 200
    body = r.json()
    assert body["blog_api_base"] == "https://mkflow.dev"
    assert body["blog_api_token_set"] is False

    body = _set_blog_token(client, "tok_abcd")
    assert body["blog_api_token_set"] is True
    assert body["blog_api_token_preview"] == "…abcd"

    r = client.put("/api/settings", json={"blog_api_base": "https://blog.example.com/"})
    assert r.json()["blog_api_base"] == "https://blog.example.com"


def test_settings_image_provider_is_separate_from_text_provider(client):
    r = client.put("/api/settings", json={
        "llm_api_key": "text_key", "llm_base_url": "https://api.deepseek.com",
        "image_api_key": "image_key", "image_base_url": "https://api.openai.com/v1",
        "image_model": "gpt-image-1",
    })
    assert r.status_code == 200, r.text
    assert r.json()["image_api_key_set"] is True
    assert r.json()["image_model"] == "gpt-image-1"

    runtime = client.get(
        "/api/settings/ai-runtime",
        headers={
            "X-WMS-Worker-Token": "test-worker-token-at-least-32-chars"
        },
    )
    assert runtime.status_code == 200
    assert runtime.json()["image"] == {
        "api_key": "image_key", "base_url": "https://api.openai.com/v1", "model": "gpt-image-1",
    }


def test_blog_token_env_fallback(client, monkeypatch):
    monkeypatch.setenv("MKFLOW_AGENT_API_TOKEN", "env_tok_9999")
    r = client.get("/api/settings")
    assert r.json()["blog_api_token_set"] is True
    assert r.json()["blog_api_token_preview"] == "…9999"


# ── 发布端点 ──────────────────────────────────────────────────────────────────

def test_publish_blog_happy_path(client, uploads_dir, blog_mock):
    _set_blog_token(client)
    draft = client.post("/api/write/drafts", json={"title": "测试文章", "content": "# hi"}).json()
    img = client.post(f"/api/write/drafts/{draft['id']}/images", files={"file": _png_file()}).json()

    md = f"## 小标题\n\n正文内容。\n\n![配图]({img['url']})\n\n![外链](https://example.com/x.png)"
    r = client.post(f"/api/write/drafts/{draft['id']}/publish/blog", json={
        "title": "测试文章", "description": "摘要", "content_markdown": md,
        "series": "落地手记", "tags": ["agent", " cms ", ""],
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["slug"] == "agent-post"
    assert body["status"] == "review"
    assert body["admin_url"] == "https://mkflow.dev/a6e95a41/collections/posts/123"

    assert blog_mock["path"] == "/api/agent/posts"
    assert blog_mock["auth"] == "Bearer tok_abcd"
    sent = blog_mock["body"]
    assert sent["title"] == "测试文章"
    assert sent["contentMarkdown"] == md
    assert sent["series"] == "落地手记"
    assert sent["tags"] == ["agent", "cms"]
    assert sent["agentName"] == "wemedia-studio"
    # 未传 cover_image_id，不带 coverImage 字段
    assert "coverImage" not in sent
    # 本地 uploads 图片随稿 base64 上传，外链不带
    assert len(sent["images"]) == 1
    sent_img = sent["images"][0]
    assert sent_img["source"] == img["url"]
    assert sent_img["alt"] == "配图"
    assert base64.b64decode(sent_img["base64"]).startswith(b"\x89PNG")


def test_publish_blog_with_cover(client, uploads_dir, blog_mock):
    _set_blog_token(client)
    draft = client.post("/api/write/drafts", json={"title": "封面测试", "content": "正文"}).json()
    cover = client.post(
        f"/api/write/drafts/{draft['id']}/images",
        files={"file": ("cover.png",) + _png_file()[1:]},
    ).json()

    r = client.post(f"/api/write/drafts/{draft['id']}/publish/blog", json={
        "title": "封面测试", "description": "摘要", "content_markdown": "正文",
        "cover_image_id": cover["id"],
    })
    assert r.status_code == 200, r.text

    sent = blog_mock["body"]
    assert "coverImage" in sent
    assert sent["coverImage"]["filename"] == "cover.png"
    assert sent["coverImage"]["contentType"] == "image/png"
    assert base64.b64decode(sent["coverImage"]["base64"]).startswith(b"\x89PNG")


def test_publish_blog_cover_not_found(client, uploads_dir, blog_mock):
    _set_blog_token(client)
    draft = client.post("/api/write/drafts", json={"title": "t", "content": "c"}).json()
    r = client.post(f"/api/write/drafts/{draft['id']}/publish/blog", json={
        "title": "t", "description": "d", "content_markdown": "c",
        "cover_image_id": 99999,
    })
    assert r.status_code == 404


def test_publish_blog_without_token(client, uploads_dir, blog_mock):
    draft = client.post("/api/write/drafts", json={"title": "t", "content": "c"}).json()
    r = client.post(f"/api/write/drafts/{draft['id']}/publish/blog", json={
        "title": "t", "description": "d", "content_markdown": "c",
    })
    assert r.status_code == 400
    assert "Token" in r.json()["detail"]


def test_publish_blog_api_error_surfaces_as_502(client, uploads_dir, monkeypatch):
    import blog_client

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "Unauthorized"})

    monkeypatch.setattr(
        blog_client, "_client",
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    _set_blog_token(client, "bad_token")
    draft = client.post("/api/write/drafts", json={"title": "t", "content": "c"}).json()
    r = client.post(f"/api/write/drafts/{draft['id']}/publish/blog", json={
        "title": "t", "description": "d", "content_markdown": "c",
    })
    assert r.status_code == 502
    assert "Unauthorized" in r.json()["detail"]


def test_publish_blog_missing_fields(client, uploads_dir):
    _set_blog_token(client)
    draft = client.post("/api/write/drafts", json={"title": "t", "content": "c"}).json()
    r = client.post(f"/api/write/drafts/{draft['id']}/publish/blog", json={
        "title": "t", "description": "  ", "content_markdown": "c",
    })
    assert r.status_code == 400
