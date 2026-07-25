import sys, asyncio, pytest


@pytest.fixture
def db_session(monkeypatch, tmp_path):
    db_file = tmp_path / "t.db"
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{db_file}")
    for mod in list(sys.modules):
        if mod.startswith(("database", "models", "config")):
            sys.modules.pop(mod, None)
    from database import engine, Base, SessionLocal
    import models  # noqa
    async def _setup():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    asyncio.new_event_loop().run_until_complete(_setup())
    return SessionLocal


def test_new_columns_exist_with_defaults(db_session):
    from models import XSubscription, XPost
    from datetime import datetime, timezone

    async def _run():
        async with db_session() as db:
            sub = XSubscription(url=None, label="s", kind="search",
                                raw_query="min_faves:1", added_at=datetime.now(timezone.utc))
            db.add(sub); await db.commit(); await db.refresh(sub)
            assert sub.kind == "search" and sub.raw_query == "min_faves:1"
            assert sub.sort == "top" and sub.max_results == 100

            post = XPost(tweet_id="t1", subscription_id=sub.id, username="u",
                         published_at=datetime.now(timezone.utc), possibly_sensitive=True)
            db.add(post); await db.commit(); await db.refresh(post)
            assert post.possibly_sensitive is True

    asyncio.new_event_loop().run_until_complete(_run())
