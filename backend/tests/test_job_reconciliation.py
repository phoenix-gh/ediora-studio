import asyncio
from dataclasses import dataclass
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest


INTERRUPTION_ERROR = (
    "后台 worker 在结果确认前停止；该步骤已中断。"
    "手动重试可能再次计费。"
)


@pytest.fixture
def reconciliation_env(monkeypatch, tmp_path):
    monkeypatch.setenv(
        "WMS_DATABASE_URL",
        f"sqlite+aiosqlite:///{tmp_path / 'reconciliation.db'}",
    )
    for name in list(sys.modules):
        if name.startswith((
            "database",
            "models",
            "content_jobs",
            "job_reconciliation",
            "text_video_jobs",
            "text_video_master",
        )):
            sys.modules.pop(name, None)

    from database import Base, SessionLocal, engine
    import models
    import text_video_jobs
    import text_video_master

    uploads = tmp_path / "uploads"
    uploads.mkdir()
    monkeypatch.setattr(text_video_jobs, "UPLOADS_DIR", uploads)
    monkeypatch.setattr(text_video_master, "UPLOADS_DIR", uploads)

    async def setup():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.run(setup())
    return SimpleNamespace(
        SessionLocal=SessionLocal,
        models=models,
        uploads=uploads,
        master=text_video_master,
        engine=engine,
    )


class FakeFencedQueue:
    def __init__(self):
        self.items: list[int] = []
        self.leases: dict[int, str] = {}
        self.acquire_calls: list[tuple[int, str, int]] = []
        self.release_calls: list[tuple[int, str]] = []
        self.closed = False

    async def try_acquire_lease(
        self,
        job_id: int,
        owner: str,
        *,
        ttl_ms: int,
    ) -> bool:
        self.acquire_calls.append((job_id, owner, ttl_ms))
        if job_id in self.leases:
            return False
        self.leases[job_id] = owner
        return True

    async def release_lease(self, job_id: int, owner: str) -> bool:
        self.release_calls.append((job_id, owner))
        if self.leases.get(job_id) != owner:
            return False
        del self.leases[job_id]
        return True

    async def refresh_lease(
        self,
        job_id: int,
        owner: str,
        *,
        ttl_ms: int,
    ) -> bool:
        return self.leases.get(job_id) == owner and ttl_ms > 0

    async def enqueue_once(self, job_id: int) -> bool:
        if job_id in self.items:
            return False
        self.items.append(job_id)
        return True

    async def close(self):
        self.closed = True


async def _seed_job(
    env,
    *,
    flow: str,
    status: str,
    input_data: dict | None = None,
    step_key: str | None = None,
    step_status: str = "running",
    retryable: bool = False,
):
    async with env.SessionLocal() as db:
        job = env.models.ContentJob(
            flow=flow,
            title=flow,
            status=status,
            input_data=input_data or {},
        )
        db.add(job)
        await db.flush()
        step = None
        if step_key is not None:
            step = env.models.ContentJobStep(
                job_id=job.id,
                step_key=step_key,
                status=step_status,
                retryable=retryable,
            )
            db.add(step)
            await db.flush()
        await db.commit()
        return job.id, step.id if step else None


async def _events(env, job_id: int):
    from sqlalchemy import select

    async with env.SessionLocal() as db:
        return (
            await db.scalars(
                select(env.models.ContentJobEvent)
                .where(env.models.ContentJobEvent.job_id == job_id)
                .order_by(env.models.ContentJobEvent.id),
            )
        ).all()


def test_queued_and_latest_succeeded_are_enqueued_once_across_two_passes(
    reconciliation_env,
):
    from job_reconciliation import reconcile_content_jobs

    async def run():
        queued_id, _ = await _seed_job(
            reconciliation_env,
            flow="draft",
            status="queued",
        )
        succeeded_id, _ = await _seed_job(
            reconciliation_env,
            flow="draft",
            status="running",
            step_key="draft",
            step_status="succeeded",
        )
        queue = FakeFencedQueue()

        first = await reconcile_content_jobs(
            queue,
            session_factory=reconciliation_env.SessionLocal,
        )
        second = await reconcile_content_jobs(
            queue,
            session_factory=reconciliation_env.SessionLocal,
        )

        assert first == {
            "enqueued": 2,
            "job_ids": [queued_id, succeeded_id],
        }
        assert second == {"enqueued": 0, "job_ids": []}
        assert queue.items == [queued_id, succeeded_id]
        for job_id in (queued_id, succeeded_id):
            events = await _events(reconciliation_env, job_id)
            enqueue_events = [
                event for event in events
                if event.kind == "job_reconciled"
                and event.payload.get("action") == "enqueued"
            ]
            assert len(enqueue_events) == 1

    asyncio.run(run())


def test_active_daily_agent_job_is_resumed_but_terminal_history_is_not(
    reconciliation_env,
):
    from job_reconciliation import reconcile_content_jobs

    async def run():
        queued_id, _ = await _seed_job(
            reconciliation_env,
            flow="daily_creation",
            status="queued",
            input_data={"run_id": 80},
        )
        agent_id, _ = await _seed_job(
            reconciliation_env,
            flow="daily_creation",
            status="running",
            input_data={"run_id": 81},
            step_key="agent",
            step_status="running",
        )
        legacy_id, _ = await _seed_job(
            reconciliation_env,
            flow="daily_creation",
            status="succeeded",
            input_data={"run_id": 72},
            step_key="persist",
            step_status="succeeded",
        )
        queue = FakeFencedQueue()

        result = await reconcile_content_jobs(
            queue,
            session_factory=reconciliation_env.SessionLocal,
        )

        assert result == {"enqueued": 2, "job_ids": [queued_id, agent_id]}
        assert queue.items == [queued_id, agent_id]
        assert legacy_id not in queue.items

    asyncio.run(run())


def test_active_worker_lease_skips_and_expired_lease_is_recovered(
    reconciliation_env,
):
    from job_reconciliation import reconcile_content_jobs

    async def run():
        job_id, _ = await _seed_job(
            reconciliation_env,
            flow="draft",
            status="queued",
        )
        queue = FakeFencedQueue()
        queue.leases[job_id] = "worker-owner"

        skipped = await reconcile_content_jobs(
            queue,
            session_factory=reconciliation_env.SessionLocal,
        )
        assert skipped == {"enqueued": 0, "job_ids": []}
        assert await _events(reconciliation_env, job_id) == []

        # Redis expiry removes the old owner; the next independent pass can
        # acquire the same exact key and recover the durable DB job.
        del queue.leases[job_id]
        recovered = await reconcile_content_jobs(
            queue,
            session_factory=reconciliation_env.SessionLocal,
        )
        assert recovered == {"enqueued": 1, "job_ids": [job_id]}
        assert queue.items == [job_id]

    asyncio.run(run())


def test_two_reconcilers_are_fenced_to_one_queue_item_and_one_event(
    reconciliation_env,
):
    from job_reconciliation import reconcile_content_jobs

    class YieldingQueue(FakeFencedQueue):
        async def try_acquire_lease(self, job_id, owner, *, ttl_ms):
            acquired = await super().try_acquire_lease(
                job_id,
                owner,
                ttl_ms=ttl_ms,
            )
            if acquired:
                await asyncio.sleep(0)
            return acquired

    async def run():
        job_id, _ = await _seed_job(
            reconciliation_env,
            flow="draft",
            status="queued",
        )
        queue = YieldingQueue()
        results = await asyncio.gather(*[
            reconcile_content_jobs(
                queue,
                session_factory=reconciliation_env.SessionLocal,
            )
            for _ in range(2)
        ])
        assert sum(result["enqueued"] for result in results) == 1
        assert queue.items == [job_id]
        events = await _events(reconciliation_env, job_id)
        assert [
            event.payload.get("action")
            for event in events
            if event.kind == "job_reconciled"
        ] == ["enqueued"]

    asyncio.run(run())


def test_enqueue_failure_leaves_db_job_discoverable_on_next_pass(
    reconciliation_env,
):
    from job_reconciliation import reconcile_content_jobs

    class OneFailureQueue(FakeFencedQueue):
        def __init__(self):
            super().__init__()
            self.fail_next = True

        async def enqueue_once(self, job_id):
            if self.fail_next:
                self.fail_next = False
                raise ConnectionError("redis temporarily unavailable")
            return await super().enqueue_once(job_id)

    async def run():
        job_id, _ = await _seed_job(
            reconciliation_env,
            flow="draft",
            status="queued",
        )
        queue = OneFailureQueue()
        assert await reconcile_content_jobs(
            queue,
            session_factory=reconciliation_env.SessionLocal,
        ) == {"enqueued": 0, "job_ids": []}
        assert queue.items == []
        assert await reconcile_content_jobs(
            queue,
            session_factory=reconciliation_env.SessionLocal,
        ) == {"enqueued": 1, "job_ids": [job_id]}
        assert queue.items == [job_id]

    asyncio.run(run())


def test_worker_winning_the_atomic_lease_window_prevents_db_mutation(
    reconciliation_env,
):
    from job_reconciliation import reconcile_content_jobs

    class WorkerWinsQueue(FakeFencedQueue):
        async def try_acquire_lease(self, job_id, owner, *, ttl_ms):
            self.acquire_calls.append((job_id, owner, ttl_ms))
            self.leases[job_id] = "worker-won-between-check-and-set"
            return False

    async def run():
        job_id, step_id = await _seed_job(
            reconciliation_env,
            flow="text_video_speech",
            status="running",
            input_data={
                "project_id": 999,
                "segment_id": "segment-1",
                "generation_revision": 0,
                "source_hash": "a" * 64,
            },
            step_key="generate_speech",
        )
        queue = WorkerWinsQueue()
        await reconcile_content_jobs(
            queue,
            session_factory=reconciliation_env.SessionLocal,
        )

        async with reconciliation_env.SessionLocal() as db:
            job = await db.get(reconciliation_env.models.ContentJob, job_id)
            step = await db.get(
                reconciliation_env.models.ContentJobStep,
                step_id,
            )
            assert job.status == "running"
            assert step.status == "running"
        assert await _events(reconciliation_env, job_id) == []
        assert queue.items == []

    asyncio.run(run())


def test_lease_owner_change_after_evidence_prevents_recovery_commit(
    reconciliation_env,
):
    from job_reconciliation import reconcile_content_jobs

    class LeaseExpiresBeforeCommitQueue(FakeFencedQueue):
        async def refresh_lease(
            self,
            job_id,
            owner,
            *,
            ttl_ms,
        ):
            assert self.leases.get(job_id) == owner
            self.leases[job_id] = "worker-owner-after-expiry"
            return False

    async def run():
        job_id, step_id, _ = await _seed_exact_speech_result(
            reconciliation_env,
        )
        queue = LeaseExpiresBeforeCommitQueue()
        await reconcile_content_jobs(
            queue,
            session_factory=reconciliation_env.SessionLocal,
        )
        async with reconciliation_env.SessionLocal() as db:
            job = await db.get(reconciliation_env.models.ContentJob, job_id)
            step = await db.get(
                reconciliation_env.models.ContentJobStep,
                step_id,
            )
            assert job.status == "running"
            assert step.status == "running"
        assert queue.items == []

    asyncio.run(run())


async def _seed_exact_speech_result(env):
    from text_video_domain import speech_source_hash

    voice = {
        "model": "speech-2.8-hd",
        "voice_id": "voice",
        "speed": 1,
        "volume": 1,
        "pitch": 0,
    }
    source_hash = speech_source_hash("甲", voice, voice["model"])
    async with env.SessionLocal() as db:
        job = env.models.ContentJob(
            flow="text_video_speech",
            title="speech",
            status="running",
            input_data={
                "project_id": 1,
                "segment_id": "segment-1",
                "generation_revision": 0,
                "source_hash": source_hash,
                "speech_model": voice["model"],
            },
        )
        db.add(job)
        await db.flush()
        step = env.models.ContentJobStep(
            job_id=job.id,
            step_key="generate_speech",
            status="running",
        )
        db.add(step)
        audio = env.uploads / "speech.mp3"
        audio.write_bytes(b"persisted-audio")
        asset = env.models.CreativeAsset(
            asset_type="media",
            media_kind="audio",
            title="文字视频口播配音",
            url="/api/uploads/speech.mp3",
            media_type="audio/mpeg",
            filename="speech.mp3",
            source="generated",
        )
        db.add(asset)
        await db.flush()
        words = [{
            "id": "word-1",
            "text": "甲",
            "start": 0.0,
            "end": 1.0,
        }]
        db.add(env.models.TextVideoSpeechAsset(
            creative_asset_id=asset.id,
            source_hash=source_hash,
            duration=1.0,
            sample_count=44_100,
            sample_rate=44_100,
            word_timings=words,
            provider_request_id="request-1",
        ))
        db.add(env.models.TextVideoProject(
            id=1,
            title="speech",
            script="甲",
            voice_settings=voice,
            paragraphs=[{
                "id": "segment-1",
                "text": "甲",
                "status": "ready",
                "audio_url": asset.url,
                "duration": 1.0,
                "word_timings": words,
                "source_hash": source_hash,
                "generation_revision": 0,
                "error": "",
                "job_id": None,
            }],
        ))
        await db.commit()
        return job.id, step.id, source_hash


def test_exact_persisted_speech_result_succeeds_step_without_provider_call(
    reconciliation_env,
):
    from job_reconciliation import reconcile_content_jobs

    async def run():
        job_id, step_id, _ = await _seed_exact_speech_result(
            reconciliation_env,
        )
        queue = FakeFencedQueue()
        await reconcile_content_jobs(
            queue,
            session_factory=reconciliation_env.SessionLocal,
        )

        async with reconciliation_env.SessionLocal() as db:
            step = await db.get(
                reconciliation_env.models.ContentJobStep,
                step_id,
            )
            assert step.status == "succeeded"
            assert step.output_data == {
                "asset_id": 1,
                "audio_url": "/api/uploads/speech.mp3",
                "duration": 1.0,
                "sample_count": 44_100,
                "sample_rate": 44_100,
                "word_timings": [{
                    "id": "word-1",
                    "text": "甲",
                    "start": 0.0,
                    "end": 1.0,
                }],
                "provider_request_id": "request-1",
            }
        assert queue.items == [job_id]

    asyncio.run(run())


def test_nonexact_speech_evidence_is_failed_retryable_and_visible(
    reconciliation_env,
):
    from job_reconciliation import reconcile_content_jobs

    async def run():
        job_id, step_id, _ = await _seed_exact_speech_result(
            reconciliation_env,
        )
        async with reconciliation_env.SessionLocal() as db:
            project = await db.get(
                reconciliation_env.models.TextVideoProject,
                1,
            )
            paragraphs = list(project.paragraphs)
            paragraphs[0] = {**paragraphs[0], "duration": 2.0}
            project.paragraphs = paragraphs
            await db.commit()

        queue = FakeFencedQueue()
        await reconcile_content_jobs(
            queue,
            session_factory=reconciliation_env.SessionLocal,
        )
        async with reconciliation_env.SessionLocal() as db:
            job = await db.get(reconciliation_env.models.ContentJob, job_id)
            step = await db.get(
                reconciliation_env.models.ContentJobStep,
                step_id,
            )
            project = await db.get(
                reconciliation_env.models.TextVideoProject,
                1,
            )
            assert job.status == "failed"
            assert step.status == "failed"
            assert step.retryable is True
            assert step.error == INTERRUPTION_ERROR
            assert project.paragraphs[0]["status"] == "failed"
            assert project.paragraphs[0]["error"] == INTERRUPTION_ERROR
        assert queue.items == []

    asyncio.run(run())


def test_exact_applied_scene_plan_succeeds_step_and_enqueues(
    reconciliation_env,
):
    from job_reconciliation import reconcile_content_jobs

    async def run():
        async with reconciliation_env.SessionLocal() as db:
            project = reconciliation_env.models.TextVideoProject(
                title="scene",
                script="甲",
                master_audio={
                    "status": "ready",
                    "timeline_status": "ready",
                    "source_hash": "a" * 64,
                },
            )
            db.add(project)
            await db.flush()
            job = reconciliation_env.models.ContentJob(
                flow="text_video_scene_plan",
                title="scene",
                status="running",
                input_data={
                    "project_id": project.id,
                    "master_source_hash": "a" * 64,
                    "scene_generation_revision": 4,
                },
            )
            db.add(job)
            await db.flush()
            step = reconciliation_env.models.ContentJobStep(
                job_id=job.id,
                step_key="generate_scene_plan",
                status="running",
            )
            db.add(step)
            project.scene_plan = {
                "status": "ready",
                "generation_revision": 5,
                "master_source_hash": "a" * 64,
                "scenes": [],
                "job_id": None,
                "applied_job_id": job.id,
                "error": "",
            }
            await db.commit()
            job_id, step_id = job.id, step.id

        queue = FakeFencedQueue()
        await reconcile_content_jobs(
            queue,
            session_factory=reconciliation_env.SessionLocal,
        )
        async with reconciliation_env.SessionLocal() as db:
            step = await db.get(
                reconciliation_env.models.ContentJobStep,
                step_id,
            )
            assert step.status == "succeeded"
            assert step.output_data["project"]["id"] == 1
            assert (
                step.output_data["project"]["scene_plan"]
                ["applied_job_id"]
                == job_id
            )
        assert queue.items == [job_id]

    asyncio.run(run())


@dataclass(frozen=True)
class _Probe:
    duration: float
    sample_rate: int
    channels: int
    codec_name: str
    bit_rate: int
    sample_count: int


async def _seed_exact_master(
    env,
    *,
    job_status="running",
    step_key="assemble_master_audio",
    step_status="running",
    timeline_ready=False,
):
    from text_video_master import master_source_hash

    speech_hash = "b" * 64
    async with env.SessionLocal() as db:
        audio = env.uploads / "master.mp3"
        audio.write_bytes(b"decoded-by-test-probe")
        asset = env.models.CreativeAsset(
            asset_type="media",
            media_kind="audio",
            title="speech",
            url="/api/uploads/master.mp3",
            media_type="audio/mpeg",
            filename="master.mp3",
            source="generated",
        )
        db.add(asset)
        await db.flush()
        segments = [{
            "speech_segment_id": "segment-1",
            "text": "甲",
            "asset_id": asset.id,
            "audio_url": asset.url,
            "source_hash": speech_hash,
            "sample_count": 44_100,
            "sample_rate": 44_100,
            "word_timings": [],
        }]
        source_hash = master_source_hash(segments)
        project = env.models.TextVideoProject(
            title="master",
            script="甲",
            master_audio={},
            render_input={
                "templateId": "tech-text-v1",
                "templateVersion": 1,
                "composition": {
                    "width": 1080,
                    "height": 1920,
                    "fps": 30,
                },
                "audio": asset.url if timeline_ready else "",
                "segments": [],
                "templateProps": {
                    "theme": "tech-blue",
                    "font": "source-han-sans",
                    "background": "dark-grid",
                    "transition": "soft-push",
                    "textDensity": "standard",
                },
            },
        )
        db.add(project)
        await db.flush()
        job = env.models.ContentJob(
            flow="text_video_master_audio",
            title="master",
            status=job_status,
            input_data={
                "project_id": project.id,
                "source_hash": source_hash,
                "repair_generation": 2,
                "segments": segments,
            },
        )
        db.add(job)
        await db.flush()
        step = env.models.ContentJobStep(
            job_id=job.id,
            step_key=step_key,
            status=step_status,
            retryable=job_status == "failed",
            error="lost ack" if job_status == "failed" else "",
        )
        db.add(step)
        await db.flush()
        words = [{
            "id": "word-1",
            "text": "甲",
            "start": 0.0,
            "end": 1.0,
            "speech_segment_id": "segment-1",
        }] if timeline_ready else []
        project.master_audio = {
            "status": "ready",
            "timeline_status": "ready" if timeline_ready else "missing",
            "asset_id": asset.id,
            "audio_url": asset.url,
            "duration": 1.0,
            "sample_count": 44_100,
            "sample_rate": 44_100,
            "source_hash": source_hash,
            "segment_offsets": [{
                "segment_id": "segment-1",
                "asset_id": asset.id,
                "source_hash": speech_hash,
                "sample_offset": 0,
                "sample_count": 44_100,
                "sample_rate": 44_100,
            }],
            "owns_asset": False,
            "word_timings": words,
            "timeline_source": "provider" if timeline_ready else "",
            "error": "",
            "timeline_error": "",
            "job_id": job.id,
            "repair_generation": 2,
            "alignment_step_id": step.id if timeline_ready else None,
            "alignment_attempt": 1 if timeline_ready else 0,
            "alignment_claim_token": (
                "alignment-claim-token" if timeline_ready else ""
            ),
            "alignment_claim_expires_at": 0.0,
        }
        if timeline_ready:
            project.status = "audio_ready"
        await db.commit()
        return job.id, step.id, project.id, source_hash


def test_exact_decoded_master_assembly_succeeds_step_and_enqueues(
    reconciliation_env,
    monkeypatch,
):
    from job_reconciliation import reconcile_content_jobs

    async def run():
        job_id, step_id, _, _ = await _seed_exact_master(
            reconciliation_env,
        )

        async def probe(_path: Path):
            return _Probe(1.0, 44_100, 1, "mp3", 128_000, 44_100)

        monkeypatch.setattr(reconciliation_env.master, "probe_audio", probe)
        queue = FakeFencedQueue()
        await reconcile_content_jobs(
            queue,
            session_factory=reconciliation_env.SessionLocal,
        )
        async with reconciliation_env.SessionLocal() as db:
            step = await db.get(
                reconciliation_env.models.ContentJobStep,
                step_id,
            )
            assert step.status == "succeeded"
            assert step.output_data["source_hash"]
            assert step.output_data["sample_count"] == 44_100
        assert queue.items == [job_id]

    asyncio.run(run())


def test_exact_ready_alignment_succeeds_with_serialized_project(
    reconciliation_env,
    monkeypatch,
):
    from job_reconciliation import reconcile_content_jobs

    async def run():
        job_id, step_id, project_id, _ = await _seed_exact_master(
            reconciliation_env,
            step_key="align_master_timeline",
            timeline_ready=True,
        )

        async def probe(_path: Path):
            return _Probe(1.0, 44_100, 1, "mp3", 128_000, 44_100)

        monkeypatch.setattr(reconciliation_env.master, "probe_audio", probe)
        queue = FakeFencedQueue()
        await reconcile_content_jobs(
            queue,
            session_factory=reconciliation_env.SessionLocal,
        )
        async with reconciliation_env.SessionLocal() as db:
            step = await db.get(
                reconciliation_env.models.ContentJobStep,
                step_id,
            )
            assert step.status == "succeeded"
            assert step.output_data["id"] == project_id
            assert (
                step.output_data["master_audio"]
                ["timeline_status"]
                == "ready"
            )
        assert queue.items == [job_id]

    asyncio.run(run())


def test_failed_assembly_with_exact_master_creates_new_attempt_and_enqueues(
    reconciliation_env,
    monkeypatch,
):
    from job_reconciliation import reconcile_content_jobs
    from sqlalchemy import select

    async def run():
        job_id, old_step_id, _, _ = await _seed_exact_master(
            reconciliation_env,
            job_status="failed",
            step_status="failed",
        )

        async def probe(_path: Path):
            return _Probe(1.0, 44_100, 1, "mp3", 128_000, 44_100)

        monkeypatch.setattr(reconciliation_env.master, "probe_audio", probe)
        queue = FakeFencedQueue()
        await reconcile_content_jobs(
            queue,
            session_factory=reconciliation_env.SessionLocal,
        )
        async with reconciliation_env.SessionLocal() as db:
            job = await db.get(reconciliation_env.models.ContentJob, job_id)
            steps = (
                await db.scalars(
                    select(reconciliation_env.models.ContentJobStep)
                    .where(
                        reconciliation_env.models.ContentJobStep.job_id
                        == job_id,
                    )
                    .order_by(
                        reconciliation_env.models.ContentJobStep.attempt,
                    ),
                )
            ).all()
            assert job.status == "queued"
            assert [(step.id, step.attempt, step.status) for step in steps] == [
                (old_step_id, 1, "failed"),
                (steps[1].id, 2, "queued"),
            ]
        assert queue.items == [job_id]

    asyncio.run(run())


def test_failed_assembly_is_not_retried_when_file_probe_disagrees(
    reconciliation_env,
    monkeypatch,
):
    from job_reconciliation import reconcile_content_jobs
    from sqlalchemy import select

    async def run():
        job_id, old_step_id, _, _ = await _seed_exact_master(
            reconciliation_env,
            job_status="failed",
            step_status="failed",
        )

        async def mismatched_probe(_path: Path):
            return _Probe(0.5, 44_100, 1, "mp3", 128_000, 22_050)

        monkeypatch.setattr(
            reconciliation_env.master,
            "probe_audio",
            mismatched_probe,
        )
        queue = FakeFencedQueue()
        await reconcile_content_jobs(
            queue,
            session_factory=reconciliation_env.SessionLocal,
        )
        async with reconciliation_env.SessionLocal() as db:
            job = await db.get(reconciliation_env.models.ContentJob, job_id)
            steps = (
                await db.scalars(
                    select(reconciliation_env.models.ContentJobStep)
                    .where(
                        reconciliation_env.models.ContentJobStep.job_id
                        == job_id,
                    ),
                )
            ).all()
            assert job.status == "failed"
            assert [(step.id, step.status) for step in steps] == [
                (old_step_id, "failed"),
            ]
        assert queue.items == []

    asyncio.run(run())


def test_running_assembly_without_ready_result_is_safe_to_enqueue_directly(
    reconciliation_env,
):
    from job_reconciliation import reconcile_content_jobs

    async def run():
        job_id, _ = await _seed_job(
            reconciliation_env,
            flow="text_video_master_audio",
            status="running",
            input_data={
                "project_id": 1,
                "source_hash": "a" * 64,
            },
            step_key="assemble_master_audio",
        )
        queue = FakeFencedQueue()
        await reconcile_content_jobs(
            queue,
            session_factory=reconciliation_env.SessionLocal,
        )
        assert queue.items == [job_id]

    asyncio.run(run())


@pytest.mark.parametrize(
    ("flow", "step_key", "domain"),
    [
        ("text_video_split_preview", "propose_boundaries", "job"),
        ("text_video_speech", "generate_speech", "speech"),
        ("text_video_scene_plan", "generate_scene_plan", "scene"),
        (
            "text_video_master_audio",
            "align_master_timeline",
            "alignment",
        ),
    ],
)
def test_unsafe_running_paid_steps_without_exact_evidence_fail_retryable(
    reconciliation_env,
    flow,
    step_key,
    domain,
):
    from job_reconciliation import reconcile_content_jobs

    async def run():
        input_data = {}
        project_id = None
        if domain in {"speech", "scene", "alignment"}:
            async with reconciliation_env.SessionLocal() as db:
                project = reconciliation_env.models.TextVideoProject(
                    title=domain,
                    script="甲",
                    paragraphs=[{
                        "id": "segment-1",
                        "text": "甲",
                        "status": "generating",
                        "audio_url": "",
                        "duration": 0.0,
                        "word_timings": [],
                        "source_hash": "a" * 64,
                        "generation_revision": 0,
                        "error": "",
                        "job_id": None,
                    }],
                    master_audio={
                        "status": "ready",
                        "timeline_status": "aligning",
                        "source_hash": "a" * 64,
                        "job_id": None,
                        "repair_generation": 0,
                    },
                    scene_plan={
                        "status": "generating",
                        "generation_revision": 0,
                        "master_source_hash": "a" * 64,
                        "scenes": [],
                        "job_id": None,
                        "applied_job_id": None,
                        "error": "",
                    },
                )
                db.add(project)
                await db.commit()
                project_id = project.id
            input_data = {
                "project_id": project_id,
                "source_hash": "a" * 64,
                "segment_id": "segment-1",
                "generation_revision": 0,
                "scene_generation_revision": 0,
                "existing_scenes": [],
                "master_source_hash": "a" * 64,
                "repair_generation": 0,
            }
        job_id, step_id = await _seed_job(
            reconciliation_env,
            flow=flow,
            status="running",
            input_data=input_data,
            step_key=step_key,
        )
        if project_id is not None:
            async with reconciliation_env.SessionLocal() as db:
                project = await db.get(
                    reconciliation_env.models.TextVideoProject,
                    project_id,
                )
                if domain == "speech":
                    paragraphs = list(project.paragraphs)
                    paragraphs[0] = {
                        **paragraphs[0],
                        "job_id": job_id,
                    }
                    project.paragraphs = paragraphs
                elif domain == "scene":
                    plan = dict(project.scene_plan)
                    plan["job_id"] = job_id
                    project.scene_plan = plan
                else:
                    master = dict(project.master_audio)
                    master["job_id"] = job_id
                    project.master_audio = master
                await db.commit()

        queue = FakeFencedQueue()
        await reconcile_content_jobs(
            queue,
            session_factory=reconciliation_env.SessionLocal,
        )
        async with reconciliation_env.SessionLocal() as db:
            job = await db.get(reconciliation_env.models.ContentJob, job_id)
            step = await db.get(
                reconciliation_env.models.ContentJobStep,
                step_id,
            )
            assert job.status == "failed"
            assert step.status == "failed"
            assert step.retryable is True
            assert step.error == INTERRUPTION_ERROR
            if project_id is not None:
                project = await db.get(
                    reconciliation_env.models.TextVideoProject,
                    project_id,
                )
                if domain == "speech":
                    assert project.paragraphs[0]["status"] == "failed"
                elif domain == "scene":
                    assert project.scene_plan["status"] == "failed"
                else:
                    assert (
                        project.master_audio["timeline_status"]
                        == "failed"
                    )
        assert queue.items == []

    asyncio.run(run())


def test_interrupted_motion_generation_restores_last_ready_scene_plan():
    from types import SimpleNamespace

    from job_reconciliation import _fail_scene_domain, INTERRUPTION_ERROR

    scenes = [{"id": "scene-1", "motion": {"chunks": []}}]
    project = SimpleNamespace(scene_plan={
        "status": "generating",
        "generation_revision": 4,
        "scenes": scenes,
        "job_id": 91,
        "error": "",
    })
    job = SimpleNamespace(
        id=91,
        input_data={
            "generation_mode": "motion",
            "scene_generation_revision": 4,
            "existing_scenes": scenes,
        },
    )

    _fail_scene_domain(project, job)

    assert project.scene_plan["status"] == "ready"
    assert project.scene_plan["job_id"] is None
    assert project.scene_plan["scenes"] == scenes
    assert project.scene_plan["error"] == INTERRUPTION_ERROR


@pytest.mark.parametrize("status", ["succeeded", "cancelled"])
def test_terminal_jobs_are_noops(reconciliation_env, status):
    from job_reconciliation import reconcile_content_jobs

    async def run():
        job_id, _ = await _seed_job(
            reconciliation_env,
            flow="draft",
            status=status,
        )
        queue = FakeFencedQueue()
        assert await reconcile_content_jobs(
            queue,
            session_factory=reconciliation_env.SessionLocal,
        ) == {"enqueued": 0, "job_ids": []}
        assert queue.acquire_calls == []
        assert queue.items == []
        assert await _events(reconciliation_env, job_id) == []

    asyncio.run(run())
