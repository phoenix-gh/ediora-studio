import asyncio
import sys

from fastapi import FastAPI


def test_scheduler_disabled_lifespan_still_runs_reconciliation_and_closes_redis(
    monkeypatch,
    tmp_path,
):
    monkeypatch.setenv(
        "WMS_DATABASE_URL",
        f"sqlite+aiosqlite:///{tmp_path / 'lifespan.db'}",
    )
    monkeypatch.setenv("WMS_DISABLE_SCHEDULER", "1")
    for name in list(sys.modules):
        if name in {"main", "database", "models", "job_reconciliation"}:
            sys.modules.pop(name, None)

    import config
    import main

    calls: list[str] = []

    async def no_op(*_args, **_kwargs):
        return []

    class FakeSession:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def commit(self):
            return None

    class FakeReconciler:
        instance = None

        def __init__(self):
            self.started = asyncio.Event()
            self.closed = False
            FakeReconciler.instance = self

        async def run_forever(self):
            calls.append("reconciliation-started")
            self.started.set()
            await asyncio.Event().wait()

        async def close(self):
            calls.append("redis-closed")
            self.closed = True

    monkeypatch.setattr(main, "init_db", no_op)
    monkeypatch.setattr(main, "SessionLocal", FakeSession)
    monkeypatch.setattr(
        main,
        "backfill_digital_human_assets",
        no_op,
    )
    monkeypatch.setattr(
        main,
        "reconcile_x_credential_accounts",
        no_op,
    )
    monkeypatch.setattr(config, "get_config", no_op)
    monkeypatch.setattr(main, "JobReconciler", FakeReconciler)

    def scheduler_must_not_start():
        raise AssertionError("scheduler is disabled")

    monkeypatch.setattr(main.scheduler, "start", scheduler_must_not_start)

    async def run():
        async with main.lifespan(FastAPI()):
            reconciler = FakeReconciler.instance
            assert reconciler is not None
            await asyncio.wait_for(reconciler.started.wait(), timeout=1)
            assert reconciler.closed is False
        assert reconciler.closed is True

    asyncio.run(run())
    assert calls == ["reconciliation-started", "redis-closed"]
