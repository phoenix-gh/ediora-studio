"""Bounded secret redaction for persisted errors and Loguru messages."""

import copy
import re
import sys

from loguru import logger


AUTH_TOKEN = re.compile(r"(?i)(auth_token\s*[:=]\s*)[^;\s,]+")
CT0 = re.compile(r"(?i)(ct0\s*[:=]\s*)[^;\s,]+")
TELEGRAM_BOT_URL = re.compile(r"(?i)(api\.telegram\.org/bot)[^/\s]+")
SECRET_FIELDS = {"auth_token", "ct0"}
MAX_LOG_VALUE_DEPTH = 12


def redact_secret_text(value: str) -> str:
    redacted = AUTH_TOKEN.sub(r"\1***", value)
    redacted = CT0.sub(r"\1***", redacted)
    return TELEGRAM_BOT_URL.sub(r"\1***", redacted)


def _redact_log_value(
    value,
    *,
    secret_field: bool = False,
    seen: set[int] | None = None,
    depth: int = 0,
):
    if secret_field:
        return "***"
    if isinstance(value, str):
        return redact_secret_text(value)
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if depth >= MAX_LOG_VALUE_DEPTH:
        return "<max-depth>"

    if seen is None:
        seen = set()
    value_id = id(value)
    if value_id in seen:
        return "<recursive>"
    seen.add(value_id)
    try:
        if isinstance(value, dict):
            redacted = {}
            for key, nested in value.items():
                if isinstance(key, str):
                    safe_key = redact_secret_text(key)
                    nested_is_secret = key.strip().casefold() in SECRET_FIELDS
                else:
                    try:
                        safe_key = redact_secret_text(repr(key))
                    except Exception:
                        safe_key = f"<unprintable {type(key).__name__}>"
                    nested_is_secret = False
                redacted[safe_key] = _redact_log_value(
                    nested,
                    secret_field=nested_is_secret,
                    seen=seen,
                    depth=depth + 1,
                )
            return redacted
        if isinstance(value, list):
            return [
                _redact_log_value(item, seen=seen, depth=depth + 1)
                for item in value
            ]
        if isinstance(value, tuple):
            return tuple(
                _redact_log_value(item, seen=seen, depth=depth + 1)
                for item in value
            )
        if isinstance(value, (set, frozenset)):
            return [
                _redact_log_value(item, seen=seen, depth=depth + 1)
                for item in value
            ]
        try:
            return redact_secret_text(repr(value))
        except Exception:
            return f"<unprintable {type(value).__name__}>"
    finally:
        seen.remove(value_id)


def _redact_exception_value(
    error: BaseException,
    seen: set[int] | None = None,
    depth: int = 0,
):
    if depth >= MAX_LOG_VALUE_DEPTH:
        return Exception("<max-depth exception>")
    if seen is None:
        seen = set()
    error_id = id(error)
    if error_id in seen:
        return Exception("<recursive exception>")
    seen.add(error_id)
    try:
        safe_text = redact_secret_text(str(error))
        if isinstance(error, BaseExceptionGroup):
            safe_children = tuple(
                _redact_exception_value(child, seen, depth + 1)
                for child in error.exceptions
            )
            safe_message = redact_secret_text(error.message)
            try:
                if safe_message == error.message:
                    safe_error = error.derive(safe_children)
                else:
                    safe_error = type(error)(safe_message, safe_children)
            except Exception:
                safe_error = BaseExceptionGroup(safe_message, safe_children)
        else:
            try:
                safe_error = copy.copy(error)
                safe_args = _redact_log_value(error.args)
                safe_error.args = tuple(safe_args)
                if getattr(error, "__dict__", None):
                    safe_error.__dict__.update(_redact_log_value(error.__dict__))
            except Exception:
                safe_error = Exception(safe_text)

        cause = error.__cause__
        context = error.__context__
        if cause is not None:
            safe_error.__cause__ = _redact_exception_value(
                cause,
                seen,
                depth + 1,
            )
        if context is not None:
            safe_error.__context__ = _redact_exception_value(
                context,
                seen,
                depth + 1,
            )
        safe_error.__suppress_context__ = error.__suppress_context__
        if error.__traceback__ is not None:
            safe_error = safe_error.with_traceback(error.__traceback__)

        if redact_secret_text(str(safe_error)) != str(safe_error):
            fallback = Exception(safe_text)
            fallback.__cause__ = safe_error.__cause__
            fallback.__context__ = safe_error.__context__
            fallback.__suppress_context__ = safe_error.__suppress_context__
            return fallback
        return safe_error
    finally:
        seen.remove(error_id)


def install_log_redaction(*, secure_default_handler: bool = False) -> None:
    def patch(record: dict) -> None:
        record["message"] = redact_secret_text(str(record["message"]))
        record["extra"] = _redact_log_value(record["extra"])
        exception = record["exception"]
        if exception is not None:
            safe_value = _redact_exception_value(exception.value)
            record["exception"] = type(exception)(
                exception.type,
                safe_value,
                exception.traceback,
            )

    logger.configure(patcher=patch)
    if secure_default_handler:
        logger.remove()
        logger.add(
            sys.stderr,
            backtrace=False,
            diagnose=False,
        )
