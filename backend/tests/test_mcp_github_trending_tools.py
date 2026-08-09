import asyncio
import sys

import pytest


@pytest.fixture
def env(monkeypatch, postgres_env):
    for module_name in list(sys.modules):
        if module_name.startswith(("database", "models", "mcp_server")):
            sys.modules.pop(module_name, None)
    from database import Base, engine
    import models  # noqa: F401

    async def setup():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.run(setup())
    yield
    asyncio.run(engine.dispose())


def run(coroutine):
    return asyncio.run(coroutine)


def test_mcp_exposes_latest_daily_snapshot_with_rank_changes(env):
    from database import SessionLocal
    from models import GithubTrendingRepo

    async def seed():
        async with SessionLocal() as session:
            session.add_all([
                GithubTrendingRepo(
                    id="acme/alpha:2026-08-09",
                    owner="acme", repo="alpha", description="自动化工作流",
                    language="Python", stars=12000, stars_gained=800, forks=300,
                    period="daily", position=1, trending_date="2026-08-09",
                    url="https://github.com/acme/alpha",
                ),
                GithubTrendingRepo(
                    id="acme/beta:2026-08-09",
                    owner="acme", repo="beta", description="开发者工具",
                    language="TypeScript", stars=9000, stars_gained=500, forks=200,
                    period="daily", position=2, trending_date="2026-08-09",
                    url="https://github.com/acme/beta",
                ),
                GithubTrendingRepo(
                    id="acme/gamma:2026-08-09",
                    owner="acme", repo="gamma", description="新项目",
                    language="Rust", stars=3000, stars_gained=300, forks=40,
                    period="daily", position=3, trending_date="2026-08-09",
                    url="https://github.com/acme/gamma",
                ),
                GithubTrendingRepo(
                    id="acme/alpha:2026-08-08",
                    owner="acme", repo="alpha", description="自动化工作流",
                    language="Python", stars=11200, stars_gained=400, forks=280,
                    period="daily", position=2, trending_date="2026-08-08",
                    url="https://github.com/acme/alpha",
                ),
                GithubTrendingRepo(
                    id="acme/beta:2026-08-08",
                    owner="acme", repo="beta", description="开发者工具",
                    language="TypeScript", stars=8500, stars_gained=300, forks=180,
                    period="daily", position=4, trending_date="2026-08-08",
                    url="https://github.com/acme/beta",
                ),
                GithubTrendingRepo(
                    id="acme/old:2026-08-08",
                    owner="acme", repo="old", description="昨日项目",
                    language="Go", stars=7000, stars_gained=200, forks=100,
                    period="daily", position=1, trending_date="2026-08-08",
                    url="https://github.com/acme/old",
                ),
                GithubTrendingRepo(
                    id="acme/weekly:2026-08-10",
                    owner="acme", repo="weekly", description="周榜项目",
                    language="Java", stars=99999, stars_gained=9999, forks=999,
                    period="weekly", position=1, trending_date="2026-08-10",
                    url="https://github.com/acme/weekly",
                ),
            ])
            await session.commit()

    run(seed())
    import mcp_server

    result = run(mcp_server.get_github_daily_trending())

    assert result["period"] == "daily"
    assert result["trending_date"] == "2026-08-09"
    assert result["previous_trending_date"] == "2026-08-08"
    assert [item["full_name"] for item in result["items"]] == [
        "acme/alpha", "acme/beta", "acme/gamma",
    ]
    assert result["items"][0]["rank_delta"] == 1
    assert result["items"][1]["rank_delta"] == 2
    assert result["items"][2]["is_new"] is True
    assert result["summary"]["new_count"] == 1


def test_github_trending_tool_has_no_free_form_period_argument(env):
    import mcp_server

    schema = mcp_server.mcp._tool_manager._tools[
        "get_github_daily_trending"
    ].parameters

    assert schema["properties"] == {}
    assert schema.get("required", []) == []
