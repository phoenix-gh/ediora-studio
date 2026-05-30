import sys, asyncio, pytest
from unittest.mock import patch, AsyncMock


@pytest.fixture
def env(monkeypatch, tmp_path):
    db_file = tmp_path / "t.db"
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{db_file}")
    for mod in list(sys.modules):
        if mod.startswith(("database", "models", "config", "scheduler", "logger")):
            sys.modules.pop(mod, None)
    from database import engine, Base
    import models  # noqa
    async def _setup():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    asyncio.new_event_loop().run_until_complete(_setup())


def test_ref_collect_job_registered(env):
    import scheduler
    class FakeSched:
        def __init__(self): self.jobs = []
        def add_job(self, func, **kw): self.jobs.append(kw.get("id"))
    fs = FakeSched()
    scheduler.register_jobs(fs, {})
    assert "ref_collect_daily" in fs.jobs


def test_scheduled_ref_collect_runs(env):
    import scheduler
    with patch("ref_collector.collect_all",
               new=AsyncMock(return_value={"checked": 1, "new_materials": 2, "failed": []})):
        asyncio.new_event_loop().run_until_complete(scheduler.scheduled_ref_collect())
    # 不抛异常即通过
