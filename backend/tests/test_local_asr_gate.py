import asyncio

import pytest

from job_queue import RedisJobQueue
from local_asr_gate import (
    LOCAL_ASR_LEASE_KEY,
    LocalAsrBusyError,
    LocalAsrLeaseLostError,
    local_asr_gate,
)


class FakeRedis:
    def __init__(self):
        self.set_calls = []
        self.eval_calls = []

    async def set(self, key, value, *, px, nx):
        self.set_calls.append((key, value, px, nx))
        return True

    async def eval(self, script, count, key, *args):
        self.eval_calls.append((script, count, key, args))
        return 1

    async def aclose(self):
        return None


class FakeLeaseQueue:
    def __init__(
        self,
        *,
        acquire_results=(True,),
        refresh_results=(True,),
    ):
        self.acquire_results = list(acquire_results)
        self.refresh_results = list(refresh_results)
        self.acquired = []
        self.refreshed = []
        self.released = []

    async def try_acquire_named_lease(self, key, owner, *, ttl_ms):
        self.acquired.append((key, owner, ttl_ms))
        if self.acquire_results:
            return self.acquire_results.pop(0)
        return False

    async def refresh_named_lease(self, key, owner, *, ttl_ms):
        self.refreshed.append((key, owner, ttl_ms))
        if self.refresh_results:
            return self.refresh_results.pop(0)
        return True

    async def release_named_lease(self, key, owner):
        self.released.append((key, owner))
        return True


def test_named_lease_primitives_use_exact_key_owner_and_ttl():
    """Catches local GPU locking accidentally using a per-job key."""
    redis = FakeRedis()
    queue = RedisJobQueue(client=redis)

    async def run():
        assert await queue.try_acquire_named_lease(
            LOCAL_ASR_LEASE_KEY,
            "job-7",
            ttl_ms=120_000,
        )
        assert await queue.refresh_named_lease(
            LOCAL_ASR_LEASE_KEY,
            "job-7",
            ttl_ms=120_000,
        )
        assert await queue.release_named_lease(
            LOCAL_ASR_LEASE_KEY,
            "job-7",
        )

    asyncio.run(run())

    assert redis.set_calls == [
        (LOCAL_ASR_LEASE_KEY, "job-7", 120_000, True),
    ]
    assert [call[2:] for call in redis.eval_calls] == [
        (LOCAL_ASR_LEASE_KEY, ("job-7", "120000")),
        (LOCAL_ASR_LEASE_KEY, ("job-7",)),
    ]


def test_gate_renews_and_releases_the_owned_lease():
    """Catches long inference losing serialization before it finishes."""
    queue = FakeLeaseQueue()

    async def run():
        async with local_asr_gate(
            owner="job-8",
            queue=queue,
            wait_seconds=0.2,
            ttl_ms=30,
        ):
            await asyncio.sleep(0.025)

    asyncio.run(run())

    assert queue.acquired == [
        (LOCAL_ASR_LEASE_KEY, "job-8", 30),
    ]
    assert queue.refreshed
    assert queue.released == [
        (LOCAL_ASR_LEASE_KEY, "job-8"),
    ]


def test_gate_times_out_without_entering_inference():
    """Catches an occupied GPU lease hanging a content job forever."""
    queue = FakeLeaseQueue(acquire_results=(False,))

    async def run():
        with pytest.raises(LocalAsrBusyError) as captured:
            async with local_asr_gate(
                owner="job-9",
                queue=queue,
                wait_seconds=0,
                ttl_ms=30,
            ):
                raise AssertionError("occupied lease must not enter")
        assert captured.value.retryable is True

    asyncio.run(run())
    assert queue.released == []


def test_gate_cancels_inference_when_renewal_is_lost():
    """Catches two processes continuing inference after one loses ownership."""
    queue = FakeLeaseQueue(refresh_results=(False,))

    async def run():
        with pytest.raises(LocalAsrLeaseLostError) as captured:
            async with local_asr_gate(
                owner="job-10",
                queue=queue,
                wait_seconds=0.2,
                ttl_ms=15,
            ):
                await asyncio.sleep(1)
        assert captured.value.retryable is True

    asyncio.run(run())
    assert queue.refreshed
    assert queue.released == [
        (LOCAL_ASR_LEASE_KEY, "job-10"),
    ]

