"""Small async client for the Xiangongyun instance lifecycle API."""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

import httpx

from log_redaction import redact_secret_text


_SENSITIVE_INSTANCE_FIELDS = {
    "ssh_key",
    "password",
    "jupyter_token",
    "xgcos_token",
}


class XiangongyunError(RuntimeError):
    """Safe, classified error from the Xiangongyun API."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        code: int | str | None = None,
        retryable: bool = False,
    ) -> None:
        self.message = message
        self.status_code = status_code
        self.code = code
        self.retryable = retryable
        super().__init__(message)


class XiangongyunClient:
    """Client for the documented open instance endpoints."""

    def __init__(
        self,
        base_url: str,
        api_token: str,
        *,
        timeout: float = 15,
    ) -> None:
        self.base_url = base_url.strip().rstrip("/")
        self.api_token = api_token.strip()
        self.timeout = timeout

    def _safe_message(self, message: str) -> str:
        safe = redact_secret_text(str(message))
        if self.api_token:
            safe = safe.replace(self.api_token, "***")
        return safe[:500]

    def _error(
        self,
        message: str,
        *,
        status_code: int | None = None,
        code: int | str | None = None,
        retryable: bool = False,
    ) -> XiangongyunError:
        return XiangongyunError(
            self._safe_message(message),
            status_code=status_code,
            code=code,
            retryable=retryable,
        )

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if not self.api_token:
            raise self._error("仙宫云 API Token 未配置")
        if not self.base_url:
            raise self._error("仙宫云 API 地址未配置")

        try:
            async with httpx.AsyncClient(
                timeout=self.timeout,
                trust_env=False,
            ) as client:
                response = await client.request(
                    method,
                    f"{self.base_url}{path}",
                    headers={"Authorization": f"Bearer {self.api_token}"},
                    json=json,
                )
        except httpx.TimeoutException as exc:
            raise self._error(
                "仙宫云请求超时",
                retryable=True,
            ) from exc
        except httpx.RequestError as exc:
            raise self._error(
                f"无法连接到仙宫云：{exc}",
                retryable=True,
            ) from exc

        if response.status_code < 200 or response.status_code >= 300:
            retryable = response.status_code == 429 or response.status_code >= 500
            raise self._error(
                f"仙宫云 HTTP {response.status_code}: {response.text[:200]}",
                status_code=response.status_code,
                retryable=retryable,
            )

        try:
            payload = response.json()
        except ValueError as exc:
            raise self._error("仙宫云响应不是有效 JSON") from exc
        if not isinstance(payload, dict):
            raise self._error("仙宫云响应格式异常")

        success = payload.get("success")
        code = payload.get("code")
        if success is False or (
            isinstance(code, (int, float))
            and not isinstance(code, bool)
            and code != 0
        ):
            raise self._error(
                f"仙宫云操作失败：{payload.get('msg') or payload.get('message') or '未知错误'}",
                code=code,
                retryable=False,
            )
        return payload

    async def list_instances(self) -> dict[str, Any]:
        payload = await self._request("GET", "/open/instances")
        instances = payload.get("list")
        if isinstance(instances, list):
            payload["list"] = [
                {
                    key: value
                    for key, value in item.items()
                    if key not in _SENSITIVE_INSTANCE_FIELDS
                }
                if isinstance(item, dict)
                else item
                for item in instances
            ]
        return payload

    async def get_instance(self, instance_id: str) -> dict[str, Any]:
        encoded_id = quote(instance_id.strip(), safe="")
        payload = await self._request("GET", f"/open/instance/{encoded_id}")
        return {
            key: value
            for key, value in payload.items()
            if key not in _SENSITIVE_INSTANCE_FIELDS
        }

    async def boot_instance(self, instance_id: str) -> dict[str, Any]:
        return await self._request(
            "POST",
            "/open/instance/boot",
            json={"id": instance_id.strip()},
        )

    async def shutdown_instance(self, instance_id: str) -> dict[str, Any]:
        return await self._request(
            "POST",
            "/open/instance/shutdown",
            json={"id": instance_id.strip()},
        )
