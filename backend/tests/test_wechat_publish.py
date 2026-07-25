import sys
import io
import asyncio
import httpx
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch, tmp_path):
    db_file = tmp_path / "test.db"
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{db_file}")
    monkeypatch.setenv("WMS_DISABLE_SCHEDULER", "1")

    for mod in list(sys.modules):
        if mod.startswith((
            "database", "models", "main", "routers", "config",
            "wechat_api_client",
        )):
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


# ── 发布端点 ──────────────────────────────────────────────────────────────────

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
def wx_mock(monkeypatch):
    import routers.drafts as drafts_mod
    wx = drafts_mod.wx
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


def test_image_copy_source_reads_uploaded_image(client, uploads_dir):
    draft, img = _setup_draft_with_image(client)
    r = client.get("/api/write/image-copy-source", params={"src": img["url"]})
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("image/png")
    assert r.content.startswith(b"\x89PNG")


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
    import routers.drafts as drafts_mod
    wx = drafts_mod.wx
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


def test_publish_creates_publication_record(client, uploads_dir, wx_mock):
    draft, img = _setup_draft_with_image(client)
    html = f'<section><p>正文</p><img src="{img["url"]}"></section>'
    r = client.post(f"/api/write/drafts/{draft['id']}/publish/wechat", json={
        "account_id": "gzh", "title": "测试文章", "digest": "摘要",
        "html": html, "cover_image_id": img["id"],
    })
    assert r.status_code == 200, r.text

    pubs = client.get("/api/published-articles").json()
    assert len(pubs) == 1
    assert pubs[0]["draft_id"] == draft["id"]
    assert pubs[0]["account_id"] == "gzh"
    assert pubs[0]["external_id"] == "DRAFT_MEDIA_1"
    assert pubs[0]["status"] == "draft_box"

    # 同 draft+account 再发一次：更新而非重复建
    r2 = client.post(f"/api/write/drafts/{draft['id']}/publish/wechat", json={
        "account_id": "gzh", "title": "改了标题", "digest": "摘要",
        "html": html, "cover_image_id": img["id"],
    })
    assert r2.status_code == 200, r2.text
    pubs2 = client.get("/api/published-articles").json()
    assert len(pubs2) == 1
    assert pubs2[0]["title"] == "改了标题"


def test_publish_record_failure_is_non_fatal(client, uploads_dir, wx_mock, monkeypatch):
    """发布记录写入失败不应影响发布本身——media_id 已成功返回。"""
    import routers.drafts as drafts_mod

    class _Boom:
        def __init__(self, *a, **k):
            raise RuntimeError("boom")

    monkeypatch.setattr(drafts_mod, "Publication", _Boom)
    draft, img = _setup_draft_with_image(client)
    html = f'<section><p>x</p><img src="{img["url"]}"></section>'
    r = client.post(f"/api/write/drafts/{draft['id']}/publish/wechat", json={
        "account_id": "gzh", "title": "t", "digest": "",
        "html": html, "cover_image_id": img["id"],
    })
    assert r.status_code == 200, r.text          # 发布仍成功
    assert r.json()["media_id"] == "DRAFT_MEDIA_1"
    assert client.get("/api/published-articles").json() == []  # 记录没建成
