import importlib


def test_runtime_settings_default_to_self_hosted_services(monkeypatch):
    monkeypatch.delenv("WMS_REDIS_URL", raising=False)
    monkeypatch.delenv("WMS_WORKER_QUEUE", raising=False)
    import runtime_config

    importlib.reload(runtime_config)
    settings = runtime_config.get_runtime_settings()

    assert settings.redis_url == "redis://redis:6379/0"
    assert settings.worker_queue == "content-jobs"
