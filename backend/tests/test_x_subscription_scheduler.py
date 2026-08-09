from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock


def _subscription(last_collected_at, interval=15):
    return SimpleNamespace(
        last_collected_at=last_collected_at,
        collect_interval_minutes=interval,
    )


def test_subscription_without_previous_collection_is_due():
    from scheduler import _is_x_subscription_due

    now = datetime(2026, 8, 6, 12, 0, tzinfo=timezone.utc)

    assert _is_x_subscription_due(_subscription(None), now) is True


def test_subscription_is_not_due_before_its_interval():
    from scheduler import _is_x_subscription_due

    now = datetime(2026, 8, 6, 12, 0, tzinfo=timezone.utc)

    assert _is_x_subscription_due(
        _subscription(now - timedelta(minutes=10)), now,
    ) is False


def test_subscription_is_due_after_its_interval_and_accepts_naive_utc():
    from scheduler import _is_x_subscription_due

    now = datetime(2026, 8, 6, 12, 0, tzinfo=timezone.utc)

    assert _is_x_subscription_due(
        _subscription((now - timedelta(minutes=20)).replace(tzinfo=None)), now,
    ) is True


def test_scheduled_x_collection_syncs_sessions_before_collecting(monkeypatch):
    import logger
    import routers.x
    import scheduler

    events = []
    subscription = SimpleNamespace(
        enabled=True,
        label="测试订阅",
        last_collected_at=None,
        collect_interval_minutes=15,
    )

    class Result:
        def scalars(self):
            return self

        def all(self):
            return [subscription]

    class FakeDb:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def execute(self, _statement):
            return Result()

    async def ensure(_db, _store=None):
        events.append("ensure")

    async def collect(_db, _subscription):
        events.append("collect")
        return 0

    monkeypatch.setattr(scheduler, "SessionLocal", lambda: FakeDb())
    monkeypatch.setattr(scheduler, "_should_run", lambda *_args: True)
    monkeypatch.setattr(scheduler.asyncio, "sleep", AsyncMock())
    monkeypatch.setattr(routers.x, "ensure_x_credential_sessions", ensure)
    monkeypatch.setattr(routers.x, "_collect_one", collect)
    monkeypatch.setattr(logger, "log", AsyncMock())

    import asyncio
    asyncio.run(scheduler.scheduled_x_collect())

    assert events == ["ensure", "collect"]
