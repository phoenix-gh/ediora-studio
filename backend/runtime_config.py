"""Runtime-only configuration for self-hosted content jobs."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class RuntimeSettings:
    redis_url: str
    worker_queue: str


def get_runtime_settings() -> RuntimeSettings:
    return RuntimeSettings(
        redis_url=os.getenv("WMS_REDIS_URL", "redis://redis:6379/0"),
        worker_queue=os.getenv("WMS_WORKER_QUEUE", "content-jobs"),
    )
