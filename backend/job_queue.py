"""Queue abstraction; Redis is transport, Postgres remains the job authority."""

from __future__ import annotations

import asyncio
from typing import Any

from runtime_config import get_runtime_settings


LONG_VIDEO_FLOWS = frozenset({
    "digital_human_shot_render",
    "digital_human_stitch",
    "digital_human_render",
    "text_video_render",
})


def is_long_video_flow(flow: str) -> bool:
    return flow in LONG_VIDEO_FLOWS


def queue_name_for_flow(flow: str) -> str:
    settings = get_runtime_settings()
    if is_long_video_flow(flow):
        return settings.video_worker_queue
    return settings.worker_queue


async def lookup_job_flow(job_id: int) -> str:
    from database import SessionLocal
    from models import ContentJob

    async with SessionLocal() as session:
        job = await session.get(ContentJob, job_id)
        return job.flow if job is not None else ""


ENQUEUE_ONCE_SCRIPT = """
local existing = redis.call('LPOS', KEYS[1], ARGV[1])
if existing then
  return 0
end
redis.call('RPUSH', KEYS[1], ARGV[1])
return 1
""".strip()

COMPARE_DELETE_SCRIPT = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
""".strip()

COMPARE_PEXPIRE_SCRIPT = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
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

    @property
    def name(self) -> str:
        return self._queue

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

    async def try_acquire_lease(
        self,
        job_id: int,
        owner: str,
        *,
        ttl_ms: int,
    ) -> bool:
        if not owner:
            raise ValueError("lease owner cannot be empty")
        if ttl_ms <= 0:
            raise ValueError("lease ttl must be positive")
        acquired = await self._client.set(
            content_job_lease_key(self._queue, job_id),
            owner,
            px=ttl_ms,
            nx=True,
        )
        return acquired == "OK" or acquired is True

    async def release_lease(self, job_id: int, owner: str) -> bool:
        released = await self._client.eval(
            COMPARE_DELETE_SCRIPT,
            1,
            content_job_lease_key(self._queue, job_id),
            owner,
        )
        return bool(released)

    async def refresh_lease(
        self,
        job_id: int,
        owner: str,
        *,
        ttl_ms: int,
    ) -> bool:
        refreshed = await self._client.eval(
            COMPARE_PEXPIRE_SCRIPT,
            1,
            content_job_lease_key(self._queue, job_id),
            owner,
            str(ttl_ms),
        )
        return bool(refreshed)

    @staticmethod
    def _validate_named_lease(
        key: str,
        owner: str,
        ttl_ms: int | None = None,
    ) -> None:
        if not key or not owner:
            raise ValueError("named lease key and owner cannot be empty")
        if ttl_ms is not None and ttl_ms <= 0:
            raise ValueError("named lease ttl must be positive")

    async def try_acquire_named_lease(
        self,
        key: str,
        owner: str,
        *,
        ttl_ms: int,
    ) -> bool:
        self._validate_named_lease(key, owner, ttl_ms)
        acquired = await self._client.set(
            key,
            owner,
            px=ttl_ms,
            nx=True,
        )
        return acquired == "OK" or acquired is True

    async def release_named_lease(
        self,
        key: str,
        owner: str,
    ) -> bool:
        self._validate_named_lease(key, owner)
        released = await self._client.eval(
            COMPARE_DELETE_SCRIPT,
            1,
            key,
            owner,
        )
        return bool(released)

    async def refresh_named_lease(
        self,
        key: str,
        owner: str,
        *,
        ttl_ms: int,
    ) -> bool:
        self._validate_named_lease(key, owner, ttl_ms)
        refreshed = await self._client.eval(
            COMPARE_PEXPIRE_SCRIPT,
            1,
            key,
            owner,
            str(ttl_ms),
        )
        return bool(refreshed)

    async def close(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> RedisJobQueue:
        return self

    async def __aexit__(self, *_args: object) -> None:
        await self.close()


async def enqueue_job(job_id: int, *, flow: str | None = None) -> None:
    resolved = flow if flow is not None else await lookup_job_flow(job_id)
    async with RedisJobQueue(queue_name=queue_name_for_flow(resolved)) as queue:
        await queue.enqueue_once(job_id)
