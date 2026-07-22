"""Queue abstraction; Redis is transport, Postgres remains the job authority."""

from __future__ import annotations

import asyncio

from runtime_config import get_runtime_settings


class InMemoryJobQueue:
    def __init__(self) -> None:
        self._queue: asyncio.Queue[int] = asyncio.Queue()

    async def enqueue(self, job_id: int) -> None:
        await self._queue.put(job_id)

    async def dequeue(self) -> int:
        return await self._queue.get()


class RedisJobQueue:
    def __init__(self) -> None:
        settings = get_runtime_settings()
        try:
            from redis import asyncio as redis_asyncio
        except ImportError as exc:  # pragma: no cover - only production image needs Redis
            raise RuntimeError("Redis worker dependency is not installed") from exc
        self._client = redis_asyncio.from_url(settings.redis_url, decode_responses=True)
        self._queue = settings.worker_queue

    async def enqueue(self, job_id: int) -> None:
        await self._client.rpush(self._queue, str(job_id))

    async def dequeue(self) -> int:
        item = await self._client.blpop(self._queue, timeout=0)
        assert item is not None
        return int(item[1])


async def enqueue_job(job_id: int) -> None:
    await RedisJobQueue().enqueue(job_id)
