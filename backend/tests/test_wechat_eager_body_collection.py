import asyncio
from types import SimpleNamespace

import pytest


class _Scalars:
    def __init__(self, rows): self.rows = rows
    def scalars(self): return self
    def all(self): return self.rows


class _Db:
    def __init__(self, rows):
        self.rows = {row.id: row for row in rows}

    async def get(self, _model, key): return self.rows.get(key)
    def add(self, row): self.rows[row.id] = row
    async def flush(self): return None
    async def execute(self, _query):
        return _Scalars([row for row in self.rows.values() if not row.content])
    async def commit(self): return None


@pytest.mark.asyncio
async def test_sync_fetches_new_body_and_backfills_existing_empty(monkeypatch):
    import routers.wechat as wx
    from models import WechatArticle
    import wechat_collector
    existing = WechatArticle(id="old", biz="biz", account_name="测试号", title="旧文章",
        url="https://mp.weixin.qq.com/s/old", content="")
    db = _Db([existing])
    account = SimpleNamespace(biz="biz", name="测试号", last_collected_at=None)

    async def list_articles(**_kwargs):
        return ([{"link": "https://mp.weixin.qq.com/s/new", "title": "新文章"}], 1)
    async def fetch(url, client=None):
        return "<p>new body</p>" if url.endswith("/new") else "<p>backfilled body</p>"
    monkeypatch.setattr(wx.mp, "list_articles", list_articles)
    monkeypatch.setattr(wechat_collector, "fetch_article_body", fetch)

    result = await wx._sync_account(db, account, "token", "cookie")
    assert {row.title: row.content for row in db.rows.values()} == {
        "旧文章": "<p>backfilled body</p>", "新文章": "<p>new body</p>"}
    assert result.body_fetched == 2
    assert result.body_failed == 0


@pytest.mark.asyncio
async def test_sync_continues_body_failures_with_concurrency_at_most_three(monkeypatch):
    import routers.wechat as wx
    from models import WechatArticle
    import wechat_collector
    rows = [WechatArticle(id=str(i), biz="biz", account_name="测试号", title=f"文章{i}",
        url=f"https://mp.weixin.qq.com/s/{i}", content="") for i in range(4)]
    db = _Db(rows)
    account = SimpleNamespace(biz="biz", name="测试号", last_collected_at=None)
    active = maximum = 0

    async def list_articles(**_kwargs): return ([], 0)
    async def fetch(url, client=None):
        nonlocal active, maximum
        active += 1; maximum = max(maximum, active)
        await asyncio.sleep(0); active -= 1
        if url.endswith("/2"): raise RuntimeError("blocked")
        return f"<p>{url[-1]}</p>"
    monkeypatch.setattr(wx.mp, "list_articles", list_articles)
    monkeypatch.setattr(wechat_collector, "fetch_article_body", fetch)

    result = await wx._sync_account(db, account, "token", "cookie")
    assert maximum <= 3
    assert result.body_fetched == 3
    assert result.body_failed == 1
    assert sum(bool(row.content) for row in rows) == 3


@pytest.mark.asyncio
async def test_sync_backfills_known_bodies_when_article_listing_is_rate_limited(
    monkeypatch,
):
    import routers.wechat as wx
    from models import WechatArticle
    import wechat_collector

    existing = WechatArticle(
        id="known",
        biz="biz",
        account_name="测试号",
        title="已知文章",
        url="https://mp.weixin.qq.com/s/known",
        content="",
    )
    db = _Db([existing])
    account = SimpleNamespace(
        biz="biz",
        name="测试号",
        last_collected_at=None,
    )

    async def list_articles(**_kwargs):
        wx.mp._check_ret({
            "base_resp": {"ret": 200013, "err_msg": "freq control"},
        })
        raise AssertionError("rate limit response must stop article listing")

    async def fetch(_url, client=None):
        return "<p>已有文章正文</p>"

    monkeypatch.setattr(wx.mp, "list_articles", list_articles)
    monkeypatch.setattr(wechat_collector, "fetch_article_body", fetch)

    result = await wx._sync_account(db, account, "token", "cookie")

    assert existing.content == "<p>已有文章正文</p>"
    assert result.body_fetched == 1
    assert result.body_failed == 0
    assert result.list_error
    assert account.last_collected_at is None


@pytest.mark.asyncio
async def test_sync_retries_a_transient_empty_article_body(monkeypatch):
    import routers.wechat as wx
    from models import WechatArticle
    import wechat_collector

    article = WechatArticle(
        id="transient",
        biz="biz",
        account_name="测试号",
        title="瞬时空响应",
        url="https://mp.weixin.qq.com/s/transient",
        content="",
    )
    db = _Db([article])
    account = SimpleNamespace(
        biz="biz",
        name="测试号",
        last_collected_at=None,
    )
    attempts = 0

    async def list_articles(**_kwargs):
        return [], 0

    async def fetch(_url, client=None):
        nonlocal attempts
        attempts += 1
        return "" if attempts == 1 else "<p>重试成功</p>"

    monkeypatch.setattr(wx.mp, "list_articles", list_articles)
    monkeypatch.setattr(wechat_collector, "fetch_article_body", fetch)

    result = await wx._sync_account(db, account, "token", "cookie")

    assert attempts == 2
    assert article.content == "<p>重试成功</p>"
    assert result.body_fetched == 1
    assert result.body_failed == 0
