import importlib
import logging

import pytest


def _reload_collection_proxy():
    import collection_proxy

    return importlib.reload(collection_proxy)


@pytest.mark.parametrize(
    "value",
    [
        "http://127.0.0.1:7890",
        "https://proxy.example.com:8443",
        "socks5://127.0.0.1:1080",
    ],
)
def test_normalize_collection_proxy_accepts_supported_urls(value):
    collection_proxy = _reload_collection_proxy()

    assert collection_proxy.normalize_collection_proxy_url(f"  {value}  ") == value


@pytest.mark.parametrize(
    "value",
    [
        "ftp://proxy.example.com",
        "http:///missing-host",
        "proxy.example.com:7890",
        "http://proxy.example.com/path",
    ],
)
def test_normalize_collection_proxy_rejects_invalid_urls(value):
    collection_proxy = _reload_collection_proxy()

    with pytest.raises(ValueError, match="代理地址"):
        collection_proxy.normalize_collection_proxy_url(value)


def test_browser_state_hides_proxy_credentials():
    collection_proxy = _reload_collection_proxy()

    editable, configured, preview = collection_proxy.collection_proxy_browser_state(
        "http://alice:secret@proxy.example.com:7890",
    )

    assert editable == ""
    assert configured is True
    assert preview == "http://***@proxy.example.com:7890"
    assert "alice" not in preview
    assert "secret" not in preview


def test_browser_state_keeps_credential_free_proxy_editable():
    collection_proxy = _reload_collection_proxy()

    editable, configured, preview = collection_proxy.collection_proxy_browser_state(
        "socks5://127.0.0.1:1080",
    )

    assert editable == "socks5://127.0.0.1:1080"
    assert configured is True
    assert preview == "socks5://127.0.0.1:1080"


def test_apply_collection_proxy_sets_feedgrab_only(monkeypatch):
    with monkeypatch.context() as environment:
        environment.setenv("HTTP_PROXY", "http://startup-http:8000")
        environment.setenv("HTTPS_PROXY", "http://startup-https:8443")
        environment.delenv("FEEDGRAB_PROXY", raising=False)
        collection_proxy = _reload_collection_proxy()

        collection_proxy.apply_collection_proxy("http://127.0.0.1:7890")

        assert collection_proxy.os.environ["FEEDGRAB_PROXY"] == "http://127.0.0.1:7890"
        assert collection_proxy.os.environ["HTTP_PROXY"] == "http://startup-http:8000"
        assert collection_proxy.os.environ["HTTPS_PROXY"] == "http://startup-https:8443"
    _reload_collection_proxy()


def test_clearing_restores_feedgrab_proxy_captured_at_import(monkeypatch):
    with monkeypatch.context() as environment:
        environment.setenv("HTTP_PROXY", "http://startup-http:8000")
        environment.setenv("FEEDGRAB_PROXY", "http://startup-feedgrab:8000")
        environment.delenv("HTTPS_PROXY", raising=False)
        collection_proxy = _reload_collection_proxy()
        collection_proxy.apply_collection_proxy("socks5://127.0.0.1:1080")

        collection_proxy.apply_collection_proxy("")

        assert collection_proxy.os.environ["FEEDGRAB_PROXY"] == (
            "http://startup-feedgrab:8000"
        )
        assert collection_proxy.os.environ["HTTP_PROXY"] == "http://startup-http:8000"
        assert "HTTPS_PROXY" not in collection_proxy.os.environ
    _reload_collection_proxy()


def test_collection_httpx_kwargs_are_explicit_and_ignore_env():
    collection_proxy = _reload_collection_proxy()

    enabled = collection_proxy.collection_httpx_kwargs(
        "socks5://127.0.0.1:1080",
        timeout=20,
    )
    disabled = collection_proxy.collection_httpx_kwargs("", timeout=20)

    assert enabled == {
        "timeout": 20,
        "trust_env": False,
        "proxy": "socks5://127.0.0.1:1080",
    }
    assert disabled == {"timeout": 20, "trust_env": False}


def test_apply_collection_proxy_logs_no_credentials(monkeypatch, caplog):
    with monkeypatch.context() as environment:
        environment.delenv("HTTP_PROXY", raising=False)
        environment.delenv("HTTPS_PROXY", raising=False)
        environment.delenv("FEEDGRAB_PROXY", raising=False)
        collection_proxy = _reload_collection_proxy()
        caplog.set_level(logging.INFO, logger="collection_proxy")

        collection_proxy.apply_collection_proxy(
            "http://alice:secret@proxy.example.com:7890",
        )

        assert "enabled" in caplog.text.lower()
        assert "scheme=http" in caplog.text.lower()
        assert "alice" not in caplog.text
        assert "secret" not in caplog.text
    _reload_collection_proxy()
