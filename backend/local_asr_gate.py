"""Cross-process renewable lease for the single local ASR GPU."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager, suppress
import time
from typing import AsyncIterator

from job_queue import RedisJobQueue


LOCAL_ASR_LEASE_KEY = "wms:local-asr:gpu"


class LocalAsrBusyError(RuntimeError):
    retryable = True


class LocalAsrLeaseLostError(RuntimeError):
    retryable = True


@asynccontextmanager
async def local_asr_gate(
    *,
    owner: str,
    queue: RedisJobQueue | None = None,
    wait_seconds: float = 300,
    ttl_ms: int = 120_000,
) -> AsyncIterator[None]:
    if not owner:
        raise ValueError("local ASR lease owner cannot be empty")
    if wait_seconds < 0:
        raise ValueError("local ASR lease wait cannot be negative")
    if ttl_ms <= 0:
        raise ValueError("local ASR lease ttl must be positive")

    active_queue = queue or RedisJobQueue()
    owns_queue = queue is None
    acquired = False
    deadline = time.monotonic() + wait_seconds
    try:
        while True:
            acquired = await active_queue.try_acquire_named_lease(
                LOCAL_ASR_LEASE_KEY,
                owner,
                ttl_ms=ttl_ms,
            )
            if acquired:
                break
            if time.monotonic() >= deadline:
                raise LocalAsrBusyError("本地转写服务正在处理其他任务")
            await asyncio.sleep(
                min(0.25, max(0.01, deadline - time.monotonic())),
            )

        lease_lost = asyncio.Event()
        owner_task = asyncio.current_task()

        async def renew() -> None:
            interval = max(0.005, ttl_ms / 3000)
            while True:
                await asyncio.sleep(interval)
                refreshed = await active_queue.refresh_named_lease(
                    LOCAL_ASR_LEASE_KEY,
                    owner,
                    ttl_ms=ttl_ms,
                )
                if refreshed:
                    continue
                lease_lost.set()
                if owner_task is not None:
                    owner_task.cancel()
                return

        renewal = asyncio.create_task(renew())
        try:
            yield
        except asyncio.CancelledError as error:
            if lease_lost.is_set():
                raise LocalAsrLeaseLostError(
                    "本地转写 GPU 租约已丢失",
                ) from error
            raise
        finally:
            renewal.cancel()
            with suppress(asyncio.CancelledError):
                await renewal
            await active_queue.release_named_lease(
                LOCAL_ASR_LEASE_KEY,
                owner,
            )
    finally:
        if owns_queue:
            await active_queue.close()
