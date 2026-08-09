import sys
import asyncio
from datetime import datetime, timezone, timedelta
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch, postgres_env):

    for mod in list(sys.modules):
        if mod.startswith(("database", "models", "main", "routers", "config",
                            "llm", "release_drafter", "schemas")):
            sys.modules.pop(mod, None)

    from database import engine, Base
    import models  # noqa: F401

    async def _create():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    asyncio.new_event_loop().run_until_complete(_create())

    from main import app
    return TestClient(app)


def _make_llm_response(types: list[str]) -> dict:
    result = {}
    for t in types:
        result[t] = {
            "title": f"[{t}] testrepo v1.0.0 发布",
            "sections": [
                {
                    "heading": "## 新特性",
                    "content": "新增了 xxx 功能。",
                    "todos": ["[TODO: 截图 - 新功能界面展示]"],
                }
            ],
        }
    return result


def test_generate_release_drafts_creates_two_drafts(client, monkeypatch):
    """generate_release_drafts creates one draft per type in release_draft_types."""
    import asyncio
    from database import SessionLocal
    import models

    async def _setup():
        async with SessionLocal() as db:
            repo = models.GithubRepo(
                id="owner/testrepo",
                owner="owner",
                repo="testrepo",
                release_draft_enabled=True,
                release_draft_types=["tech", "product"],
            )
            db.add(repo)
            release = models.GithubRelease(
                id="owner/testrepo:v1.0.0",
                repo_id="owner/testrepo",
                tag_name="v1.0.0",
                name="Version 1.0.0",
                body="- Added feature X\n- Fixed bug Y",
                html_url="https://github.com/owner/testrepo/releases/tag/v1.0.0",
                published_at=datetime.now(timezone.utc),
            )
            db.add(release)
            await db.commit()

    async def _run():
        import llm as llm_mod

        async def fake_generate(**kw):
            return _make_llm_response(["tech", "product"])

        monkeypatch.setattr(llm_mod, "generate_release_article", fake_generate)
        from release_drafter import generate_release_drafts
        async with SessionLocal() as db:
            repo = await db.get(models.GithubRepo, "owner/testrepo")
            release = await db.get(models.GithubRelease, "owner/testrepo:v1.0.0")
            return await generate_release_drafts(release, repo, db)

    loop = asyncio.new_event_loop()
    loop.run_until_complete(_setup())
    n = loop.run_until_complete(_run())
    assert n == 2


def test_generate_pending_drafts_skips_old_releases(client, monkeypatch):
    """Releases older than 30 days are skipped: draft_generated_at set, no ArticleDraft created."""
    import asyncio
    from database import SessionLocal
    import models
    from sqlalchemy import select as sa_select

    async def _setup():
        async with SessionLocal() as db:
            repo = models.GithubRepo(
                id="owner/oldrepo",
                owner="owner",
                repo="oldrepo",
                release_draft_enabled=True,
                release_draft_types=["tech"],
            )
            db.add(repo)
            old_date = datetime.now(timezone.utc) - timedelta(days=60)
            release = models.GithubRelease(
                id="owner/oldrepo:v0.1.0",
                repo_id="owner/oldrepo",
                tag_name="v0.1.0",
                name="Old version",
                body="Some old changelog",
                html_url="https://github.com/owner/oldrepo/releases/tag/v0.1.0",
                published_at=old_date,
            )
            db.add(release)
            await db.commit()

    async def _run():
        import llm as llm_mod

        async def fake_generate(**kw):
            raise AssertionError("Should not call LLM for old releases")

        monkeypatch.setattr(llm_mod, "generate_release_article", fake_generate)
        from release_drafter import generate_pending_drafts
        async with SessionLocal() as db:
            n = await generate_pending_drafts(db)

        async with SessionLocal() as db:
            release = await db.get(models.GithubRelease, "owner/oldrepo:v0.1.0")
            drafts = (await db.execute(sa_select(models.ArticleDraft))).scalars().all()
        return n, release.draft_generated_at, len(drafts)

    loop = asyncio.new_event_loop()
    loop.run_until_complete(_setup())
    n, generated_at, draft_count = loop.run_until_complete(_run())

    assert n == 0
    assert generated_at is not None
    assert draft_count == 0


def test_generate_pending_drafts_skips_disabled_repos(client, monkeypatch):
    """Repos with release_draft_enabled=False are not processed."""
    import asyncio
    from database import SessionLocal
    import models

    async def _setup():
        async with SessionLocal() as db:
            repo = models.GithubRepo(
                id="owner/disabledrepo",
                owner="owner",
                repo="disabledrepo",
                release_draft_enabled=False,
                release_draft_types=["tech"],
            )
            db.add(repo)
            release = models.GithubRelease(
                id="owner/disabledrepo:v1.0.0",
                repo_id="owner/disabledrepo",
                tag_name="v1.0.0",
                name="v1.0.0",
                body="changelog",
                html_url="https://github.com/owner/disabledrepo/releases/tag/v1.0.0",
                published_at=datetime.now(timezone.utc),
            )
            db.add(release)
            await db.commit()

    async def _run():
        import llm as llm_mod

        async def fake_generate(**kw):
            raise AssertionError("Should not call LLM for disabled repos")

        monkeypatch.setattr(llm_mod, "generate_release_article", fake_generate)
        from release_drafter import generate_pending_drafts
        async with SessionLocal() as db:
            return await generate_pending_drafts(db)

    loop = asyncio.new_event_loop()
    loop.run_until_complete(_setup())
    n = loop.run_until_complete(_run())
    assert n == 0


def test_generate_release_drafts_idempotent(client, monkeypatch):
    """Calling generate_release_drafts with same title twice does not create duplicate drafts."""
    import asyncio
    from database import SessionLocal
    import models
    from sqlalchemy import select as sa_select

    async def _setup():
        async with SessionLocal() as db:
            repo = models.GithubRepo(
                id="owner/idrepo",
                owner="owner",
                repo="idrepo",
                release_draft_enabled=True,
                release_draft_types=["tech"],
            )
            db.add(repo)
            release = models.GithubRelease(
                id="owner/idrepo:v2.0.0",
                repo_id="owner/idrepo",
                tag_name="v2.0.0",
                name="v2.0.0",
                body="- New thing",
                html_url="https://github.com/owner/idrepo/releases/tag/v2.0.0",
                published_at=datetime.now(timezone.utc),
            )
            db.add(release)
            await db.commit()

    async def _run_twice():
        import llm as llm_mod

        async def fake_generate(**kw):
            return _make_llm_response(["tech"])

        monkeypatch.setattr(llm_mod, "generate_release_article", fake_generate)
        from release_drafter import generate_release_drafts

        # First call
        async with SessionLocal() as db:
            repo = await db.get(models.GithubRepo, "owner/idrepo")
            release = await db.get(models.GithubRelease, "owner/idrepo:v2.0.0")
            await generate_release_drafts(release, repo, db)

        # Reset draft_generated_at to simulate second call
        async with SessionLocal() as db:
            release = await db.get(models.GithubRelease, "owner/idrepo:v2.0.0")
            release.draft_generated_at = None
            await db.commit()

        # Second call — should not create duplicate
        async with SessionLocal() as db:
            repo = await db.get(models.GithubRepo, "owner/idrepo")
            release = await db.get(models.GithubRelease, "owner/idrepo:v2.0.0")
            await generate_release_drafts(release, repo, db)

        async with SessionLocal() as db:
            drafts = (await db.execute(sa_select(models.ArticleDraft))).scalars().all()
        return len(drafts)

    loop = asyncio.new_event_loop()
    loop.run_until_complete(_setup())
    count = loop.run_until_complete(_run_twice())
    assert count == 1
