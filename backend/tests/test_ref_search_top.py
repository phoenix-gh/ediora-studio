import asyncio


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


# ── 纯函数：查询构建（无 I/O，不碰 cookies）─────────────────────────────
def test_build_top_query_operator_only():
    import feedgrab_client as fc
    q = fc._build_top_query(min_faves=1500, min_retweets=0, lang="zh", days=2, extra_terms="")
    assert "min_faves:1500" in q and "lang:zh" in q
    # -filter:replies / -filter:retweets zero out X search results — only links is kept
    assert "-filter:links" in q
    assert "-filter:replies" not in q and "-filter:retweets" not in q
    assert "since:" in q
    assert "min_retweets" not in q          # 0 → 省略


def test_build_top_query_with_seed_and_no_since():
    import feedgrab_client as fc
    q = fc._build_top_query(min_faves=0, min_retweets=50, lang="", days=0, extra_terms="哈哈")
    assert q.startswith("哈哈") and "min_retweets:50" in q
    assert "since:" not in q and "lang:" not in q


# ── search_top：query 选择 + 解析（patch 同步 fetch，绕开 cookies/事件循环）──
def test_search_top_uses_raw_query_and_parses(monkeypatch):
    import feedgrab_client as fc
    captured = {}
    def fake_fetch(query, limit, sort):
        captured.update(query=query, limit=limit, sort=sort)
        return [{"id": "1", "text": "hi", "author": "a", "likes": 9000,
                 "possibly_sensitive": True}]
    monkeypatch.setattr(fc, "_fetch_search_top_raw", fake_fetch)
    posts = _run(fc.search_top(raw_query="min_faves:9 lang:zh", sort="top", limit=20))
    assert captured["query"] == "min_faves:9 lang:zh"
    assert captured["sort"] == "top" and captured["limit"] == 20
    assert len(posts) == 1 and posts[0].tweet_id == "1" and posts[0].possibly_sensitive is True


def test_search_top_builds_query_when_no_raw(monkeypatch):
    import feedgrab_client as fc
    captured = {}
    def fake_fetch(query, limit, sort):
        captured.update(query=query)
        return []
    monkeypatch.setattr(fc, "_fetch_search_top_raw", fake_fetch)
    _run(fc.search_top(raw_query="", min_faves=1500, lang="zh", days=2, extra_terms="哈哈"))
    assert "哈哈" in captured["query"] and "min_faves:1500" in captured["query"]


# ── 透传到 feedgrab：patch cookies + search_twitter_keyword（均为模块级名）──
def test_search_top_passthrough_to_feedgrab(monkeypatch):
    import feedgrab_client as fc
    captured = {}
    async def fake_search(**kwargs):
        captured.update(kwargs)
        return {"tweets": []}
    monkeypatch.setattr(fc, "load_twitter_cookies", lambda: {"auth_token": "x", "ct0": "y"})
    monkeypatch.setattr(fc, "search_twitter_keyword", fake_search)
    _run(fc.search_top(raw_query="q1", sort="top", limit=15))
    assert captured["keyword"] == "q1" and captured["raw"] is True
    assert captured["sort"] == "top" and captured["max_results"] == 15
    assert captured["save_tweets"] is False and captured["skip_summary"] is True
