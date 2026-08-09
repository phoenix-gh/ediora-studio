"""Explicit, secret-safe health probe for one X credential pair."""

import asyncio
from dataclasses import dataclass

import httpx

from x_credential_store import CredentialPair


X_ACCOUNT_SETTINGS_URL = "https://x.com/i/api/1.1/account/settings.json"


@dataclass(frozen=True)
class CredentialProbeResult:
    status: str
    error: str


async def _probe_x_via_graphql(pair: CredentialPair) -> CredentialProbeResult:
    """Use feedgrab's live GraphQL path after X retires legacy REST probes."""
    try:
        from feedgrab.fetchers.twitter_graphql import fetch_user_by_screen_name
    except ImportError:
        return CredentialProbeResult("failed", "feedgrab 未安装，无法测试 X 凭据")

    try:
        result = await asyncio.to_thread(
            fetch_user_by_screen_name,
            "x",
            {"auth_token": pair.auth_token, "ct0": pair.ct0},
        )
    except Exception:
        return CredentialProbeResult("failed", "连接 X 失败")

    if isinstance(result, dict) and result.get("user_id"):
        return CredentialProbeResult("available", "")
    return CredentialProbeResult("expired", "X 凭据已失效或无权限")


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
    except (ImportError, RuntimeError) as exc:
        message = str(exc).lower()
        if "socksio" in message or "using socks proxy" in message:
            return CredentialProbeResult(
                "failed",
                "当前配置使用 SOCKS 代理，但未安装 socksio，请安装 httpx[socks]",
            )
        if isinstance(exc, ImportError):
            return CredentialProbeResult("failed", "X 测试依赖加载失败")
        raise
    except httpx.RequestError:
        return CredentialProbeResult("failed", "连接 X 失败")

    if response.status_code == 404:
        return await _probe_x_via_graphql(pair)
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
