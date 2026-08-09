import json

import pytest


class _Response:
    status_code = 200
    content = b"x" * 300
    headers = {"content-type": "image/jpeg"}
    text = "<div id='js_content'><p>正文</p></div>"

    def raise_for_status(self):
        return None

    def json(self):
        return {
            "base_resp": {"ret": 0},
            "publish_page": json.dumps({"total_count": 0, "publish_list": []}),
        }


class _Client:
    def __init__(self, captured, **kwargs):
        captured.update(kwargs)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def aclose(self):
        return None

    async def get(self, *_args, **_kwargs):
        return _Response()


@pytest.mark.asyncio
async def test_mp_article_listing_ignores_environment_proxy(monkeypatch):
    import wechat_mp_client as mp
    captured = {}
    monkeypatch.setattr(mp.httpx, "AsyncClient", lambda **kw: _Client(captured, **kw))
    await mp.list_articles("biz", "token", "cookie")
    assert captured["trust_env"] is False


@pytest.mark.asyncio
async def test_article_body_fetch_ignores_environment_proxy(monkeypatch):
    import wechat_collector as collector
    captured = {}
    monkeypatch.setattr(collector.httpx, "AsyncClient", lambda **kw: _Client(captured, **kw))
    assert "正文" in await collector.fetch_article_body("https://mp.weixin.qq.com/s/x")
    assert captured["trust_env"] is False


@pytest.mark.asyncio
async def test_image_fetch_ignores_environment_proxy(monkeypatch, tmp_path):
    import wechat_img_cache as images
    captured = {}
    monkeypatch.setattr(images, "IMG_DIR", tmp_path)
    monkeypatch.setattr(images.httpx, "AsyncClient", lambda **kw: _Client(captured, **kw))
    assert await images.fetch_and_cache("https://mmbiz.qpic.cn/x") is not None
    assert captured["trust_env"] is False
