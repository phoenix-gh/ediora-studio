"""Authentication boundary for trusted background-worker endpoints."""

from __future__ import annotations

import hmac
import os

from fastapi import Header, HTTPException


def validate_worker_token(supplied: str | None) -> None:
    expected = os.getenv("WMS_WORKER_TOKEN", "")
    if len(expected) < 32:
        raise HTTPException(503, "后台 worker 令牌未配置")
    if supplied is None or not hmac.compare_digest(supplied, expected):
        raise HTTPException(403, "后台 worker 令牌无效")


def require_worker_token(
    supplied: str | None = Header(default=None, alias="X-WMS-Worker-Token"),
) -> None:
    validate_worker_token(supplied)
