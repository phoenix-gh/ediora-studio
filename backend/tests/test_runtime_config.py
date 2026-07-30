import importlib


def test_runtime_settings_default_to_self_hosted_services(monkeypatch):
    monkeypatch.delenv("WMS_REDIS_URL", raising=False)
    monkeypatch.delenv("WMS_WORKER_QUEUE", raising=False)
    monkeypatch.delenv("WMS_LOCAL_ASR_URL", raising=False)
    monkeypatch.delenv("WMS_LOCAL_ASR_MODEL", raising=False)
    monkeypatch.delenv("WMS_LOCAL_ASR_DEVICE", raising=False)
    monkeypatch.delenv("WMS_LOCAL_ASR_COMPUTE_TYPE", raising=False)
    import runtime_config

    importlib.reload(runtime_config)
    settings = runtime_config.get_runtime_settings()

    assert settings.redis_url == "redis://redis:6379/0"
    assert settings.worker_queue == "content-jobs"
    assert settings.local_asr_url == "http://local-asr:8000/v1"
    assert settings.local_asr_model == (
        "Systran/faster-whisper-large-v3"
    )
    assert settings.local_asr_device == "cuda"
    assert settings.local_asr_compute_type == "float16"
