"""Explicit, secret-safe health probe for one X credential pair."""

from dataclasses import dataclass

import httpx

from x_credential_store import CredentialPair


X_ACCOUNT_SETTINGS_URL = "https://x.com/i/api/1.1/account/settings.json"


@dataclass(frozen=True)
class CredentialProbeResult:
    status: str
    error: str


async def probe_x_credentials(
    pair: CredentialPair,
    *,
    client: httpx.AsyncClient | None = None,
) -> CredentialProbeResult:
    try:
        from feedgrab.fetchers.twitter_cookies import BEARER_TOKEN, DEFAULT_USER_AGENT
    except ImportError:
        return CredentialProbeResult("failed", "feedgrab 未安装，无法测试 X 凭据")

    headers = {
        "authorization": f"Bearer {BEARER_TOKEN}",
        "cookie": f"auth_token={pair.auth_token}; ct0={pair.ct0}",
        "x-csrf-token": pair.ct0,
        "x-twitter-active-user": "yes",
        "user-agent": DEFAULT_USER_AGENT,
    }
    try:
        if client is None:
            async with httpx.AsyncClient(timeout=15.0) as owned_client:
                response = await owned_client.get(
                    X_ACCOUNT_SETTINGS_URL,
                    headers=headers,
                )
        else:
            response = await client.get(X_ACCOUNT_SETTINGS_URL, headers=headers)
    except httpx.RequestError:
        return CredentialProbeResult("failed", "连接 X 失败")

    if response.status_code == 429:
        return CredentialProbeResult("rate_limited", "X 账号当前被限流")
    if response.status_code in {401, 403}:
        return CredentialProbeResult("expired", "X 凭据已失效或无权限")
    if not 200 <= response.status_code < 300:
        return CredentialProbeResult("failed", f"X 返回 HTTP {response.status_code}")
    try:
        payload = response.json()
    except ValueError:
        return CredentialProbeResult("failed", "X 返回了无效 JSON")
    if not isinstance(payload, dict):
        return CredentialProbeResult("failed", "X 返回结构不符合预期")
    return CredentialProbeResult("available", "")
