import pytest


@pytest.mark.asyncio
async def test_empty_article_detail_does_not_fetch_from_network(monkeypatch):
    import routers.wechat as wx
    import wechat_collector
    from models import WechatArticle
    article = WechatArticle(id="empty", biz="biz", account_name="测试号",
        title="空正文", url="https://mp.weixin.qq.com/s/empty", content="")

    class Db:
        async def get(self, _model, _key): return article

    async def forbidden(_url):
        raise AssertionError("detail must not fetch")
    monkeypatch.setattr(wechat_collector, "fetch_article_body", forbidden)

    result = await wx.get_article("empty", Db())
    assert result is article
    assert result.content == ""
