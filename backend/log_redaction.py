"""Bounded secret redaction for persisted errors and Loguru messages."""

import re

from loguru import logger


AUTH_TOKEN = re.compile(r"(?i)(auth_token\s*[:=]\s*)[^;\s,]+")
CT0 = re.compile(r"(?i)(ct0\s*[:=]\s*)[^;\s,]+")
TELEGRAM_BOT_URL = re.compile(r"(?i)(api\.telegram\.org/bot)[^/\s]+")


def redact_secret_text(value: str) -> str:
    redacted = AUTH_TOKEN.sub(r"\1***", value)
    redacted = CT0.sub(r"\1***", redacted)
    return TELEGRAM_BOT_URL.sub(r"\1***", redacted)


def install_log_redaction() -> None:
    def patch(record: dict) -> None:
        record["message"] = redact_secret_text(str(record["message"]))

    logger.configure(patcher=patch)
