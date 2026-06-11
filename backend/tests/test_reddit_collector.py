from types import SimpleNamespace

import pytest

from reddit_collector import collect_subscription


class FakeDb:
    def __init__(self, existing=None):
        self.existing = existing
        self.added = []
        self.committed = False

    async def get(self, model, key):
        return self.existing

    def add(self, item):
        self.added.append(item)

    async def commit(self):
        self.committed = True


@pytest.mark.asyncio
async def test_collect_subscription_stores_structured_reddit_fields(monkeypatch):
    async def fake_fetch_sort(subreddit, sort, limit):
        if sort == "new":
            return []
        return [{
            "id": "abc",
            "title": "A post",
            "content": "rendered markdown",
            "body": "body only",
            "comments": [{"id": "c1", "body": "comment"}],
            "fetch_status": "ok",
            "url": "https://www.reddit.com/r/test/comments/abc/",
            "linked_url": "",
            "author": "alice",
            "subreddit": "test",
            "flair": "Discussion",
            "score": 12,
            "upvote_ratio": 0.8,
            "comment_count": 1,
            "is_self": True,
            "created_at": "2026-06-10T00:00:00Z",
        }]

    monkeypatch.setattr("reddit_collector._fetch_sort", fake_fetch_sort)
    sub = SimpleNamespace(id=7, subreddit="test", last_collected_at=None)
    db = FakeDb()

    new_count = await collect_subscription(sub, db)

    assert new_count == 1
    assert db.committed is True
    post = db.added[0]
    assert post.body == "body only"
    assert post.comments == [{"id": "c1", "body": "comment"}]
    assert post.fetch_status == "ok"


@pytest.mark.asyncio
async def test_collect_subscription_refreshes_existing_snapshot(monkeypatch):
    async def fake_fetch_sort(subreddit, sort, limit):
        if sort == "new":
            return []
        return [{
            "id": "abc",
            "title": "New title",
            "content": "new markdown",
            "body": "new body",
            "comments": [{"id": "c2", "body": "new comment"}],
            "fetch_status": "ok",
            "score": 20,
            "comment_count": 2,
            "upvote_ratio": 0.9,
        }]

    existing = SimpleNamespace(
        title="Old title",
        content="old markdown",
        body="old body",
        comments=[],
        fetch_status="ok",
        url="",
        linked_url="",
        author="",
        subreddit="test",
        flair="",
        score=1,
        comment_count=0,
        upvote_ratio=0.0,
        is_self=True,
        published_at=None,
    )
    monkeypatch.setattr("reddit_collector._fetch_sort", fake_fetch_sort)
    sub = SimpleNamespace(id=7, subreddit="test", last_collected_at=None)
    db = FakeDb(existing=existing)

    new_count = await collect_subscription(sub, db)

    assert new_count == 0
    assert existing.title == "New title"
    assert existing.content == "new markdown"
    assert existing.body == "new body"
    assert existing.comments == [{"id": "c2", "body": "new comment"}]
    assert existing.score == 20
