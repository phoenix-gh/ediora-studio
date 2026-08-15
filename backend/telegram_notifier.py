"""Direct Telegram Bot API adapter for generic notifications."""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

import httpx

from log_redaction import redact_secret_text


class TelegramSendError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        retryable: bool,
        message_ids: list[int] | None = None,
        delivery_unknown: bool = False,
    ):
        super().__init__(message)
        self.retryable = retryable
        self.message_ids = list(message_ids or [])
        self.delivery_unknown = delivery_unknown


def render_test_message(tested_at: datetime) -> str:
    shanghai = tested_at.astimezone(ZoneInfo("Asia/Shanghai"))
    stamp = shanghai.strftime("%Y-%m-%d %H:%M:%S")
    return (
        "✅ <b>Ediora Telegram 连接测试成功</b>\n"
        f"测试时间：{stamp}（Asia/Shanghai）"
    )


async def send_html_messages(
    token: str,
    chat_id: str,
    messages: list[str],
    *,
    client: httpx.AsyncClient | None = None,
) -> list[int]:
    if not token or not chat_id:
        raise TelegramSendError("Telegram Bot Token 或 Chat ID 未配置", retryable=False)
    owned_client = client is None
    active_client = client or httpx.AsyncClient()
    message_ids: list[int] = []
    try:
        for message in messages:
            request_failure: TelegramSendError | None = None
            try:
                response = await active_client.post(
                    f"https://api.telegram.org/bot{token}/sendMessage",
                    json={
                        "chat_id": chat_id,
                        "text": message,
                        "parse_mode": "HTML",
                        "link_preview_options": {"is_disabled": True},
                    },
                    timeout=15,
                )
            except httpx.RequestError as exc:
                safe_detail = redact_secret_text(str(exc))
                if token:
                    safe_detail = safe_detail.replace(token, "***")
                request_failure = TelegramSendError(
                    safe_detail or "Telegram 网络请求失败，投递状态未知",
                    retryable=False,
                    message_ids=message_ids,
                    delivery_unknown=True,
                )
            if request_failure is not None:
                raise request_failure from None
            try:
                payload = response.json()
            except ValueError:
                payload = {}
            if response.status_code >= 400 or not payload.get("ok"):
                detail = str(payload.get("description") or f"HTTP {response.status_code}")
                detail = redact_secret_text(detail)
                if token:
                    detail = detail.replace(token, "***")
                raise TelegramSendError(
                    detail,
                    retryable=response.status_code == 429 or response.status_code >= 500,
                    message_ids=message_ids,
                )
            message_ids.append(int(payload["result"]["message_id"]))
    finally:
        if owned_client:
            await active_client.aclose()
    return message_ids
