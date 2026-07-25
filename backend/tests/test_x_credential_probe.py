import asyncio
import builtins

import httpx
import pytest

from x_credential_probe import CredentialProbeResult, probe_x_credentials
from x_credential_store import CredentialPair


async def run_probe(transport: httpx.AsyncBaseTransport) -> CredentialProbeResult:
    async with httpx.AsyncClient(transport=transport) as client:
        return await probe_x_credentials(
            CredentialPair("secret-auth", "secret-csrf"),
            client=client,
        )


@pytest.mark.parametrize(
    ("status_code", "payload", "expected_status", "expected_error"),
    [
        (200, {"screen_name": "example"}, "available", ""),
        (201, {}, "available", ""),
        (401, {"errors": []}, "expired", "X 凭据已失效或无权限"),
        (403, {"errors": []}, "expired", "X 凭据已失效或无权限"),
        (429, {"errors": []}, "rate_limited", "X 账号当前被限流"),
        (500, {"errors": []}, "failed", "X 返回 HTTP 500"),
    ],
)
def test_probe_maps_x_responses(
    status_code,
    payload,
    expected_status,
    expected_error,
):
    transport = httpx.MockTransport(
        lambda _request: httpx.Response(status_code, json=payload)
    )

    result = asyncio.run(run_probe(transport))

    assert result == CredentialProbeResult(expected_status, expected_error)
    assert "secret-auth" not in result.error
    assert "secret-csrf" not in result.error


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(200, json=["not", "an", "object"]),
        httpx.Response(204),
        httpx.Response(200, content=b"not-json"),
    ],
)
def test_probe_rejects_success_without_a_json_object(response):
    transport = httpx.MockTransport(lambda _request: response)

    result = asyncio.run(run_probe(transport))

    assert result.status == "failed"
    assert result.error in {
        "X 返回了无效 JSON",
        "X 返回结构不符合预期",
    }


def test_probe_maps_network_errors_without_echoing_credentials():
    def fail(request):
        raise httpx.ConnectError(
            "auth_token=secret-auth ct0=secret-csrf",
            request=request,
        )

    result = asyncio.run(run_probe(httpx.MockTransport(fail)))

    assert result == CredentialProbeResult("failed", "连接 X 失败")
    assert "secret-auth" not in result.error
    assert "secret-csrf" not in result.error


def test_probe_fails_x_operation_clearly_when_feedgrab_is_missing(monkeypatch):
    real_import = builtins.__import__

    def without_feedgrab(name, *args, **kwargs):
        if name == "feedgrab.fetchers.twitter_cookies":
            raise ModuleNotFoundError("No module named 'feedgrab'")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", without_feedgrab)

    result = asyncio.run(
        probe_x_credentials(CredentialPair("secret-auth", "secret-csrf"))
    )

    assert result == CredentialProbeResult(
        "failed",
        "feedgrab 未安装，无法测试 X 凭据",
    )
