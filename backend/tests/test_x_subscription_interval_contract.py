import sys


def test_x_subscription_declares_collection_interval(monkeypatch, postgres_env):
    for module in list(sys.modules):
        if module.startswith(("database", "models")):
            sys.modules.pop(module, None)

    from models import XSubscription

    assert XSubscription.collect_interval_minutes.property.columns[0].default.arg == 15
