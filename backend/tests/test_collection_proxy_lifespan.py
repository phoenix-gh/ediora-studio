import asyncio
import sys

from fastapi import FastAPI


def _load_main(monkeypatch, *, scheduler_disabled: bool):
    if scheduler_disabled:
        monkeypatch.setenv("DISABLE_SCHEDULER", "1")
    else:
        monkeypatch.delenv("DISABLE_SCHEDULER", raising=False)
    for module_name in ("main", "database", "models", "job_reconciliation"):
        sys.modules.pop(module_name, None)

    import config
    import main

    return config, main


def _install_lifespan_fakes(monkeypatch, config, main, calls):
    async def init_db():
        calls.append("init-db")

    async def get_config():
        calls.append("get-config")
        return {"collection_proxy_url": "http://127.0.0.1:7890"}

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
        async def run_forever(self):
            await asyncio.Event().wait()

        async def close(self):
            calls.append("reconciler-close")

    def apply_proxy(value):
        calls.append(f"proxy:{value}")

    def register_jobs(_scheduler, cfg):
        assert cfg["collection_proxy_url"] == "http://127.0.0.1:7890"
        calls.append("register-jobs")

    monkeypatch.setattr(main, "init_db", init_db)
    monkeypatch.setattr(main, "SessionLocal", FakeSession)
    monkeypatch.setattr(main, "backfill_digital_human_assets", no_op)
    monkeypatch.setattr(main, "ensure_temporary_asset_directory", no_op)
    monkeypatch.setattr(main, "reconcile_x_credential_accounts", no_op)
    monkeypatch.setattr(config, "get_config", get_config)
    monkeypatch.setattr(main, "JobReconciler", FakeReconciler)
    monkeypatch.setattr(main, "apply_collection_proxy", apply_proxy, raising=False)
    monkeypatch.setattr(main.job_registry, "register_jobs", register_jobs)
    monkeypatch.setattr(main.scheduler, "start", lambda: calls.append("scheduler-start"))
    monkeypatch.setattr(
        main.scheduler,
        "shutdown",
        lambda: calls.append("scheduler-shutdown"),
    )


def test_lifespan_applies_proxy_before_registering_scheduled_collection(
    monkeypatch,
    postgres_env,
):
    config, main = _load_main(
        monkeypatch,
        scheduler_disabled=False,
    )
    calls = []
    _install_lifespan_fakes(monkeypatch, config, main, calls)

    async def run_lifespan():
        async with main.lifespan(FastAPI()):
            calls.append("yield")

    asyncio.run(run_lifespan())

    assert calls.index("init-db") < calls.index("get-config")
    assert calls.index("get-config") < calls.index(
        "proxy:http://127.0.0.1:7890",
    )
    assert calls.index("proxy:http://127.0.0.1:7890") < calls.index(
        "register-jobs",
    )
    assert calls.index("register-jobs") < calls.index("scheduler-start")


def test_lifespan_applies_proxy_when_scheduler_is_disabled(
    monkeypatch,
    postgres_env,
):
    config, main = _load_main(
        monkeypatch,
        scheduler_disabled=True,
    )
    calls = []
    _install_lifespan_fakes(monkeypatch, config, main, calls)

    async def run_lifespan():
        async with main.lifespan(FastAPI()):
            calls.append("yield")

    asyncio.run(run_lifespan())

    assert "get-config" in calls
    assert "proxy:http://127.0.0.1:7890" in calls
    assert "register-jobs" not in calls
    assert "scheduler-start" not in calls
