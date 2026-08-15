import asyncio
import os
import sys
from types import SimpleNamespace

import pytest
from pydantic import ValidationError


@pytest.fixture
def settings_runtime(monkeypatch):
    monkeypatch.setenv("HTTP_PROXY", "http://startup-http:8000")
    monkeypatch.setenv("HTTPS_PROXY", "http://startup-https:8443")
    monkeypatch.delenv("FEEDGRAB_PROXY", raising=False)
    for module_name in list(sys.modules):
        if module_name in {"collection_proxy", "config", "routers.settings"}:
            sys.modules.pop(module_name, None)

    import config
    import routers.settings as settings_router

    state = dict(config.DEFAULTS)

    async def get_config():
        return dict(state)

    async def set_config(updates):
        state.update({key: str(value) for key, value in updates.items()})

    monkeypatch.setattr(settings_router, "get_config", get_config)
    monkeypatch.setattr(settings_router, "set_config", set_config)

    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace()))
    yield SimpleNamespace(state=state, router=settings_router, request=request)


def test_collection_proxy_save_persists_and_applies_immediately(settings_runtime):
    response = asyncio.run(
        settings_runtime.router.update_settings(
            settings_runtime.router.SettingsUpdate(
                collection_proxy_url="http://127.0.0.1:7890",
            ),
            settings_runtime.request,
            None,
        ),
    )

    body = response.model_dump()
    assert body["collection_proxy_url"] == "http://127.0.0.1:7890"
    assert body["collection_proxy_url_set"] is True
    assert body["collection_proxy_url_preview"] == "http://127.0.0.1:7890"
    assert os.environ["HTTP_PROXY"] == "http://startup-http:8000"
    assert os.environ["HTTPS_PROXY"] == "http://startup-https:8443"
    assert os.environ["FEEDGRAB_PROXY"] == "http://127.0.0.1:7890"
    fetched = asyncio.run(settings_runtime.router.get_settings()).model_dump()
    assert fetched["collection_proxy_url"] == "http://127.0.0.1:7890"


def test_collection_proxy_credentials_are_write_only(settings_runtime):
    response = asyncio.run(
        settings_runtime.router.update_settings(
            settings_runtime.router.SettingsUpdate(
                collection_proxy_url=(
                    "http://alice:secret@proxy.example.com:7890"
                ),
            ),
            settings_runtime.request,
            None,
        ),
    )

    body = response.model_dump()
    assert body["collection_proxy_url"] == ""
    assert body["collection_proxy_url_set"] is True
    assert body["collection_proxy_url_preview"] == (
        "http://***@proxy.example.com:7890"
    )
    serialized = response.model_dump_json()
    assert "alice" not in serialized
    assert "secret" not in serialized


def test_collection_proxy_rejects_invalid_url_without_changing_environment(
    settings_runtime,
):
    with pytest.raises(ValidationError, match="采集代理地址"):
        settings_runtime.router.SettingsUpdate(
            collection_proxy_url="file:///tmp/proxy",
        )
    assert os.environ["HTTP_PROXY"] == "http://startup-http:8000"
    assert os.environ["HTTPS_PROXY"] == "http://startup-https:8443"


def test_collection_proxy_database_failure_does_not_change_environment(
    settings_runtime,
    monkeypatch,
):
    async def fail_set_config(_updates):
        raise RuntimeError("database unavailable")

    monkeypatch.setattr(
        settings_runtime.router,
        "set_config",
        fail_set_config,
    )

    with pytest.raises(RuntimeError, match="database unavailable"):
        asyncio.run(
            settings_runtime.router.update_settings(
                settings_runtime.router.SettingsUpdate(
                    collection_proxy_url="http://next:7890",
                ),
                settings_runtime.request,
                None,
            ),
        )

    assert os.environ["HTTP_PROXY"] == "http://startup-http:8000"
    assert os.environ["HTTPS_PROXY"] == "http://startup-https:8443"


def test_collection_proxy_clear_restores_startup_environment(settings_runtime):
    asyncio.run(
        settings_runtime.router.update_settings(
            settings_runtime.router.SettingsUpdate(
                collection_proxy_url="http://127.0.0.1:7890",
            ),
            settings_runtime.request,
            None,
        ),
    )

    response = asyncio.run(
        settings_runtime.router.update_settings(
            settings_runtime.router.SettingsUpdate(collection_proxy_url=""),
            settings_runtime.request,
            None,
        ),
    )

    assert response.collection_proxy_url_set is False
    assert os.environ["HTTP_PROXY"] == "http://startup-http:8000"
    assert os.environ["HTTPS_PROXY"] == "http://startup-https:8443"
    assert "FEEDGRAB_PROXY" not in os.environ


def test_settings_get_survives_malformed_legacy_proxy_value(settings_runtime):
    settings_runtime.state["collection_proxy_url"] = "not a url"

    response = asyncio.run(settings_runtime.router.get_settings())

    assert response.collection_proxy_url == ""
    assert response.collection_proxy_url_set is False
    assert response.collection_proxy_url_preview == ""
