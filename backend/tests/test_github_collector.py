import sys
import asyncio
from datetime import datetime, timezone
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch, tmp_path):
    db_file = tmp_path / "test.db"
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{db_file}")
    monkeypatch.setenv("WMS_DISABLE_SCHEDULER", "1")

    for mod in list(sys.modules):
        if mod.startswith(("database", "models", "main", "routers", "config",
                            "llm", "github_collector", "schemas")):
            sys.modules.pop(mod, None)

    from database import engine, Base
    import models  # noqa: F401

    async def _create():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    asyncio.new_event_loop().run_until_complete(_create())

    from main import app
    return TestClient(app)


class _FakeResp:
    def __init__(self, payload):
        self._payload = payload
        self.status_code = 200
        self.headers = {"X-RateLimit-Remaining": "99"}

    def raise_for_status(self):
        pass

    def json(self):
        return self._payload


class _FakeAsyncClient:
    """Stands in for httpx.AsyncClient; serves the releases endpoint."""
    def __init__(self, payload):
        self._payload = payload

    def __call__(self, *a, **kw):
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def get(self, url, **kw):
        return _FakeResp(self._payload)


def _release(tag="v1.0.0"):
    return {
        "tag_name": tag,
        "name": tag,
        "body": "notes",
        "prerelease": False,
        "draft": False,
        "html_url": f"https://github.com/o/r/releases/{tag}",
        "published_at": "2026-06-10T00:00:00Z",
    }


def _add_repo(rid="o/r", last_collected_at=None):
    from database import SessionLocal
    import models

    async def _run():
        async with SessionLocal() as db:
            owner, repo = rid.split("/")
            db.add(models.GithubRepo(id=rid, owner=owner, repo=repo, stars=0,
                                     last_collected_at=last_collected_at))
            await db.commit()
        return rid
    return asyncio.new_event_loop().run_until_complete(_run())


def test_releases_collect_refreshes_meta_and_timestamp(client, monkeypatch):
    # issues 抓取停用后，meta 刷新和 last_collected_at 必须由 releases 路径负责，
    # 否则仓库永远处于"到期"状态、空耗 API 配额。
    import github_collector as gc
    from database import SessionLocal
    import models

    _add_repo()
    monkeypatch.setattr(gc.httpx, "AsyncClient", _FakeAsyncClient([_release()]))

    async def _fake_meta(owner, repo, token=""):
        return {"stargazers_count": 42, "description": "desc", "language": "Py"}
    monkeypatch.setattr(gc, "fetch_repo_meta", _fake_meta)

    async def _run():
        async with SessionLocal() as db:
            repo = await db.get(models.GithubRepo, "o/r")
            n = await gc.collect_repo_releases(repo, db)
        async with SessionLocal() as db:
            return n, await db.get(models.GithubRepo, "o/r")

    n, repo = asyncio.new_event_loop().run_until_complete(_run())
    assert n == 1
    assert repo.stars == 42
    assert repo.last_collected_at is not None


def test_collect_all_repos_skips_issues(client, monkeypatch):
    # issues 暂时不抓：collect_all_repos 只走 releases 路径。
    import github_collector as gc
    from database import SessionLocal

    _add_repo()
    monkeypatch.setattr(gc.httpx, "AsyncClient", _FakeAsyncClient([_release()]))

    async def _fake_meta(owner, repo, token=""):
        return {}
    monkeypatch.setattr(gc, "fetch_repo_meta", _fake_meta)

    async def _boom(*a, **kw):
        raise AssertionError("collect_repo_issues should not be called")
    monkeypatch.setattr(gc, "collect_repo_issues", _boom)

    async def _run():
        async with SessionLocal() as db:
            return await gc.collect_all_repos(db)

    results = asyncio.new_event_loop().run_until_complete(_run())
    assert len(results) == 1
    assert results[0]["error"] is None
    assert results[0]["new_releases"] == 1


def test_collect_all_repos_oldest_first(client, monkeypatch):
    # 配额耗尽时迭代靠后的库会被跳过，所以必须最久未采的优先：
    # 从未采集(NULL) → 最旧 → 较新。
    from datetime import timedelta
    import github_collector as gc
    from database import SessionLocal

    now = datetime.now(timezone.utc)
    _add_repo("o/recent", last_collected_at=now - timedelta(hours=2))
    _add_repo("o/never", last_collected_at=None)
    _add_repo("o/oldest", last_collected_at=now - timedelta(hours=9))

    monkeypatch.setattr(gc.httpx, "AsyncClient", _FakeAsyncClient([]))

    async def _fake_meta(owner, repo, token=""):
        return {}
    monkeypatch.setattr(gc, "fetch_repo_meta", _fake_meta)

    async def _run():
        async with SessionLocal() as db:
            return await gc.collect_all_repos(db)

    results = asyncio.new_event_loop().run_until_complete(_run())
    assert [r["repo_id"] for r in results] == ["o/never", "o/oldest", "o/recent"]
