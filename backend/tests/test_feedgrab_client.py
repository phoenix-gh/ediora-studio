from datetime import datetime, timezone

from feedgrab_client import ParsedPost, _tweet_dict_to_parsed_post


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
