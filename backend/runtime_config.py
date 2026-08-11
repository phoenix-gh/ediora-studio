"""Runtime-only configuration for self-hosted content jobs."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class RuntimeSettings:
    redis_url: str
    worker_queue: str
    local_asr_url: str
    local_asr_model: str
    local_asr_device: str
    local_asr_compute_type: str


def get_runtime_settings() -> RuntimeSettings:
    return RuntimeSettings(
        redis_url=os.getenv("WMS_REDIS_URL", "redis://redis:6379/0"),
        worker_queue=os.getenv("WMS_WORKER_QUEUE", "content-jobs"),
        local_asr_url=os.getenv(
            "WMS_LOCAL_ASR_URL",
            "http://127.0.0.1:8001/v1",
        ),
        local_asr_model=os.getenv(
            "WMS_LOCAL_ASR_MODEL",
            "Systran/faster-whisper-large-v3",
        ),
        local_asr_device=os.getenv("WMS_LOCAL_ASR_DEVICE", "cuda"),
        local_asr_compute_type=os.getenv(
            "WMS_LOCAL_ASR_COMPUTE_TYPE",
            "float16",
        ),
    )
