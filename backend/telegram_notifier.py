"""Direct Telegram Bot API adapter for copyable X response suggestions."""

from __future__ import annotations

from datetime import datetime
import html
from zoneinfo import ZoneInfo

import httpx


MAX_TELEGRAM_TEXT = 4000
ACTION_LABELS = {
    "comment": "建议立即评论",
    "translate_quote": "建议立即翻译引用转发",
    "watch": "建议继续观察",
    "ignore": "建议忽略",
}


class TelegramSendError(RuntimeError):
    def __init__(self, message: str, *, retryable: bool):
        super().__init__(message)
        self.retryable = retryable


def render_test_message(tested_at: datetime) -> str:
    shanghai = tested_at.astimezone(ZoneInfo("Asia/Shanghai"))
    stamp = shanghai.strftime("%Y-%m-%d %H:%M:%S")
    return (
        "✅ <b>WeMedia Studio Telegram 连接测试成功</b>\n"
        f"测试时间：{stamp}（Asia/Shanghai）"
    )


def _draft_blocks(decision) -> str:
    blocks: list[str] = []
    if decision.comment_draft:
        blocks.append(f"<b>建议评论</b>\n<pre>{html.escape(decision.comment_draft)}</pre>")
    if decision.quote_draft:
        blocks.append(f"<b>翻译引用转发</b>\n<pre>{html.escape(decision.quote_draft)}</pre>")
    return "\n\n".join(blocks)


def render_immediate_messages(decision, post, subscription, web_url: str) -> list[str]:
    confidence = round(float(decision.confidence) * 100)
    header = (
        f"🔴 <b>{ACTION_LABELS.get(decision.action, decision.action)}</b>\n"
        f"价值 {decision.score} · 置信度 {confidence}%\n"
        f"来源：{html.escape(subscription.label or '@' + post.username)}\n"
        f"原因：{html.escape(decision.reason)}"
    )
    summary = f"<b>原帖摘要</b>\n{html.escape(decision.summary_cn)}"
    links = (
        f'<a href="{html.escape(post.url, quote=True)}">查看原帖</a>\n'
        f'<a href="{html.escape(web_url, quote=True)}">查看待响应记录</a>'
    )
    drafts = _draft_blocks(decision)
    combined = "\n\n".join(part for part in (header, summary, drafts, links) if part)
    if len(combined) <= MAX_TELEGRAM_TEXT:
        return [combined]

    first_budget = MAX_TELEGRAM_TEXT - len(header) - 40
    shortened_summary = summary[:max(0, first_budget)] + "…"
    first = f"{header}\n\n{shortened_summary}"
    second = "\n\n".join(part for part in (drafts, links) if part)
    if len(second) > MAX_TELEGRAM_TEXT:
        raise ValueError("copyable draft exceeds Telegram message limit")
    return [first, second]


def render_digest_messages(
    rows: list[tuple],
    date_label: str,
    web_url: str,
) -> list[str]:
    """Render a bounded daily digest while keeping each suggested draft copyable."""
    header = f"🟡 <b>X 即时响应 · 18:00 摘要</b>\n{html.escape(date_label)}"
    footer = f'\n\n<a href="{html.escape(web_url, quote=True)}">查看全部待响应</a>'
    messages: list[str] = []
    current = header
    for decision, post, subscription in rows:
        confidence = round(float(decision.confidence) * 100)
        block = (
            f"<b>{ACTION_LABELS.get(decision.action, decision.action)}</b>"
            f" · {decision.score}分 · {confidence}%\n"
            f"来源：{html.escape(subscription.label or '@' + post.username)}\n"
            f"{html.escape(decision.summary_cn)}\n"
            f"{_draft_blocks(decision)}\n"
            f'<a href="{html.escape(post.url, quote=True)}">查看原帖</a>'
        )
        candidate = f"{current}\n\n{block}"
        if len(candidate) + len(footer) > MAX_TELEGRAM_TEXT and current != header:
            messages.append(current + footer)
            current = f"{header}\n\n{block}"
        else:
            current = candidate
        if len(current) + len(footer) > MAX_TELEGRAM_TEXT:
            raise ValueError("digest entry exceeds Telegram message limit")
    if current != header:
        messages.append(current + footer)
    return messages


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
            try:
                payload = response.json()
            except ValueError:
                payload = {}
            if response.status_code >= 400 or not payload.get("ok"):
                detail = str(payload.get("description") or f"HTTP {response.status_code}")
                raise TelegramSendError(
                    detail,
                    retryable=response.status_code == 429 or response.status_code >= 500,
                )
            message_ids.append(int(payload["result"]["message_id"]))
    finally:
        if owned_client:
            await active_client.aclose()
    return message_ids
