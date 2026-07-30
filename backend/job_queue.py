"""Queue abstraction; Redis is transport, Postgres remains the job authority."""

from __future__ import annotations

import asyncio
from typing import Any

from runtime_config import get_runtime_settings


ENQUEUE_ONCE_SCRIPT = """
local existing = redis.call('LPOS', KEYS[1], ARGV[1])
if existing then
  return 0
end
redis.call('RPUSH', KEYS[1], ARGV[1])
return 1
""".strip()


def content_job_lease_key(queue_name: str, job_id: int) -> str:
    return f"wms:content-job-lease:{queue_name}:{job_id}"


class InMemoryJobQueue:
    def __init__(self) -> None:
        self._queue: asyncio.Queue[int] = asyncio.Queue()

    async def enqueue(self, job_id: int) -> None:
        await self._queue.put(job_id)

    async def dequeue(self) -> int:
        return await self._queue.get()


class RedisJobQueue:
    def __init__(
        self,
        *,
        client: Any | None = None,
        queue_name: str | None = None,
    ) -> None:
        settings = get_runtime_settings()
        if client is None:
            try:
                from redis import asyncio as redis_asyncio
            except ImportError as exc:  # pragma: no cover - production dependency
                raise RuntimeError(
                    "Redis worker dependency is not installed",
                ) from exc
            client = redis_asyncio.from_url(
                settings.redis_url,
                decode_responses=True,
            )
        self._client = client
        self._queue = queue_name or settings.worker_queue

    async def enqueue(self, job_id: int) -> None:
        await self.enqueue_once(job_id)

    async def enqueue_once(self, job_id: int) -> bool:
        inserted = await self._client.eval(
            ENQUEUE_ONCE_SCRIPT,
            1,
            self._queue,
            str(job_id),
        )
        return bool(inserted)

    async def dequeue(self) -> int:
        item = await self._client.blpop(self._queue, timeout=0)
        assert item is not None
        return int(item[1])

    async def has_active_lease(self, job_id: int) -> bool:
        owner = await self._client.get(
            content_job_lease_key(self._queue, job_id),
        )
        return bool(owner)

    async def close(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> RedisJobQueue:
        return self

    async def __aexit__(self, *_args: object) -> None:
        await self.close()


async def enqueue_job(job_id: int) -> None:
    async with RedisJobQueue() as queue:
        await queue.enqueue_once(job_id)
