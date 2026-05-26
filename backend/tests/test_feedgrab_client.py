import pytest
from unittest.mock import patch, MagicMock
from datetime import datetime, timezone

from feedgrab_client import ParsedPost, _tweet_dict_to_parsed_post


def _tweet_dict(tid="111"):
    """Real-shape feedgrab tweet dict — flat format from extract_tweet_data."""
    return {
        "id": tid,
        "text": f"post {tid}",
        "author": "foo",
        "author_name": "Foo",
        "created_at": "Wed May 20 10:00:00 +0000 2026",
        "likes": 5,
        "retweets": 1,
        "replies": 2,
        "views": 100,
    }


# Real feedgrab tweet dict shape (from extract_tweet_data return value):
#   id, text, author (screen_name), author_name (display name),
#   created_at (Twitter classic "Wed May 20 14:30:00 +0000 2026"),
#   likes, retweets, replies, views (all flat keys, not nested)
#   URL is constructed as https://x.com/{author}/status/{id}
SAMPLE_TWEET = {
    "id": "1234567890123456789",
    "text": "Mars by 2030 or bust.",
    "author": "elonmusk",
    "author_name": "Elon Musk",
    "created_at": "Wed May 20 14:30:00 +0000 2026",
    "replies": 100,
    "retweets": 500,
    "likes": 3000,
    "views": "200000",
    "bookmarks": 50,
}


def test_parses_basic_tweet():
    p = _tweet_dict_to_parsed_post(SAMPLE_TWEET)
    assert isinstance(p, ParsedPost)
    assert p.tweet_id == "1234567890123456789"
    assert p.username == "elonmusk"
    assert p.display_name == "Elon Musk"
    assert p.content == "Mars by 2030 or bust."
    assert p.url == "https://x.com/elonmusk/status/1234567890123456789"
    assert p.published_at == datetime(2026, 5, 20, 14, 30, tzinfo=timezone.utc)
    assert p.replies == 100
    assert p.reposts == 500
    assert p.likes == 3000
    assert p.views == 200000
    # raw_markdown is the formatter's deterministic output
    assert "@elonmusk" in p.raw_markdown
    assert "Mars by 2030" in p.raw_markdown


def test_missing_id_returns_none():
    assert _tweet_dict_to_parsed_post({"text": "hi"}) is None


def test_missing_user_falls_back_gracefully():
    p = _tweet_dict_to_parsed_post({
        "id": "111", "text": "hi", "created_at": "Wed May 20 10:00:00 +0000 2026"
    })
    assert p is not None
    assert p.tweet_id == "111"
    assert p.username == ""
    assert p.display_name == ""


# --- grab_timeline ---

@pytest.mark.asyncio
async def test_grab_timeline_returns_parsed_posts():
    from feedgrab_client import grab_timeline

    with patch("feedgrab_client._fetch_timeline_raw",
               return_value=[_tweet_dict("111"), _tweet_dict("222")]):
        posts = await grab_timeline("https://x.com/foo")

    assert {p.tweet_id for p in posts} == {"111", "222"}


@pytest.mark.asyncio
async def test_grab_timeline_skips_unparseable():
    from feedgrab_client import grab_timeline

    with patch("feedgrab_client._fetch_timeline_raw",
               return_value=[{"no_id_field": True}, _tweet_dict("111")]):
        posts = await grab_timeline("https://x.com/foo")

    assert len(posts) == 1
    assert posts[0].tweet_id == "111"


# --- search_x ---

@pytest.mark.asyncio
async def test_search_x_returns_parsed_posts():
    from feedgrab_client import search_x

    with patch("feedgrab_client._fetch_search_raw",
               return_value=[_tweet_dict("111")]):
        posts = await search_x("hello")

    assert len(posts) == 1
    assert posts[0].tweet_id == "111"


# --- auth_status ---

def test_auth_status_env_vars(monkeypatch):
    from feedgrab_client import auth_status
    monkeypatch.setenv("X_AUTH_TOKEN", "a")
    monkeypatch.setenv("X_CT0", "b")
    s = auth_status()
    assert s["ready"] is True
    assert "env vars" in s["hint"].lower()


def test_auth_status_no_creds(monkeypatch, tmp_path):
    from feedgrab_client import auth_status
    monkeypatch.delenv("X_AUTH_TOKEN", raising=False)
    monkeypatch.delenv("X_CT0", raising=False)
    monkeypatch.chdir(tmp_path)  # no sessions/twitter.json or sessions/x.json
    monkeypatch.setenv("HOME", str(tmp_path))  # no ~/.feedgrab/...
    s = auth_status()
    assert s["ready"] is False
    assert "feedgrab login twitter" in s["hint"]


# --- auth guard inside fetch helpers ---

def test_fetch_timeline_raw_raises_without_cookies():
    """Without cookies, fail loudly so the UI surfaces a real error
    instead of silently returning 0 posts."""
    from feedgrab_client import _fetch_timeline_raw

    with patch("feedgrab.fetchers.twitter_cookies.load_twitter_cookies",
               return_value={}):
        with pytest.raises(RuntimeError, match="未登录"):
            _fetch_timeline_raw("https://x.com/foo")


def test_fetch_search_raw_raises_without_cookies():
    from feedgrab_client import _fetch_search_raw

    with patch("feedgrab.fetchers.twitter_cookies.load_twitter_cookies",
               return_value={}):
        with pytest.raises(RuntimeError, match="未登录"):
            _fetch_search_raw("hello")
