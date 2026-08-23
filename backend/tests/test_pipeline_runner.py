from __future__ import annotations

import pytest
from sqlalchemy import func, select


@pytest.fixture
async def pipeline_db(postgres_database_url):
    from database import Base
    import models  # noqa: F401
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    engine = create_async_engine(postgres_database_url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    yield sessions
    await engine.dispose()


def _request(key: str, *, count: int = 3):
    from pipeline_contracts import PipelineCreateInput, ResolvedSkillInvocation

    names = ["source-research", "writing-plan", "humanize-writing"][:count]
    return PipelineCreateInput(
        objective="Write a durable article",
        title="Runner test",
        confirmation="automatic",
        idempotency_key=key,
        invocations=[
            ResolvedSkillInvocation.model_validate({
                "invocation_id": str(index),
                "skill_name": name,
                "skill_display_name": name,
                "skill_snapshot": {
                    "name": name,
                    "version": "1.0.0",
                    "digest": "a" * 64,
                    "source": "builtin",
                },
                "binding_snapshot": {
                    "primaryOutput": "article",
                    "capabilityProfile": "writing",
                    "requestedAllowedTools": ["read_context"],
                    "profileAllowedTools": ["read_context"],
                },
                "capability_snapshot": {
                    "schemaVersion": 1,
                    "mode": "job",
                    "skill": {"name": name},
                    "tools": [],
                    "policy": {
                        "approvalPolicy": "automatic",
                        "allowedToolNames": ["read_context"],
                    },
                },
            })
            for index, name in enumerate(names, start=1)
        ],
    )


class RecordingExecutor:
    def __init__(self, *, error: Exception | None = None, empty: bool = False):
        self.calls: list[tuple[str, int | None, int]] = []
        self.error = error
        self.empty = empty

    async def execute(self, _session, _job, step, execution):
        from pipeline_runner import PipelineAuxiliaryResult, PipelineStageResult

        previous_id = step.input_data.get("previous_primary_artifact_id")
        self.calls.append((step.step_key, previous_id, execution.id))
        if self.error is not None:
            raise self.error
        if self.empty:
            return PipelineStageResult(
                primary_kind="article",
                primary_title=step.step_key,
            )
        return PipelineStageResult(
            primary_kind="article",
            primary_title=step.step_key,
            primary_text=f"output for {step.step_key}",
            auxiliary=(PipelineAuxiliaryResult(
                kind="research-notes",
                title=f"Notes for {step.step_key}",
                structured_content={"source": step.step_key},
            ),),
        )


@pytest.mark.asyncio
async def test_runner_executes_one_ordered_stage_per_invocation_and_hands_off_primary(
    pipeline_db,
    monkeypatch,
):
    from models import AgentExecution, ContentJob, ContentJobStep, ExecutionArtifact
    from pipeline_runner import run_skill_pipeline_job
    from pipeline_service import create_pipeline_job

    queued: list[tuple[int, str | None]] = []

    async def fake_enqueue(job_id, *, flow=None):
        queued.append((job_id, flow))

    monkeypatch.setattr("pipeline_runner.enqueue_job", fake_enqueue)
    async with pipeline_db() as session:
        job = await create_pipeline_job(session, _request("runner-order"))
    job_id = job.id
    executor = RecordingExecutor()

    for _ in range(3):
        await run_skill_pipeline_job(
            job_id,
            session_factory=pipeline_db,
            executor=executor,
        )

    assert [call[0] for call in executor.calls] == [
        "skill:01:source-research",
        "skill:02:writing-plan",
        "skill:03:humanize-writing",
    ]
    assert executor.calls[0][1] is None
    assert executor.calls[1][1] is not None
    assert executor.calls[2][1] is not None
    assert len({call[2] for call in executor.calls}) == 3
    assert queued == [(job_id, "skill_pipeline"), (job_id, "skill_pipeline")]

    async with pipeline_db() as session:
        job = await session.get(ContentJob, job_id)
        steps = list((await session.execute(
            select(ContentJobStep)
            .where(ContentJobStep.job_id == job_id)
            .order_by(ContentJobStep.id)
        )).scalars().all())
        artifacts = list((await session.execute(
            select(ExecutionArtifact)
            .where(ExecutionArtifact.job_id == job_id)
            .order_by(ExecutionArtifact.id)
        )).scalars().all())
        executions = list((await session.execute(
            select(AgentExecution)
            .where(AgentExecution.job_id == job_id)
            .order_by(AgentExecution.id)
        )).scalars().all())

    assert job is not None
    assert job.status == "succeeded"
    assert [step.status for step in steps[1:]] == ["succeeded"] * 3
    assert [artifact.role for artifact in artifacts] == [
        "auxiliary", "primary", "auxiliary", "primary", "auxiliary", "primary",
    ]
    assert [execution.status for execution in executions] == ["succeeded"] * 3

    primary_ids = [
        artifact.id for artifact in artifacts if artifact.role == "primary"
    ]
    assert steps[2].input_data["previous_primary_artifact_id"] == primary_ids[0]
    assert steps[3].input_data["previous_primary_artifact_id"] == primary_ids[1]

    await run_skill_pipeline_job(
        job_id,
        session_factory=pipeline_db,
        executor=executor,
    )
    assert len(executor.calls) == 3


@pytest.mark.asyncio
async def test_runner_reuses_active_upstream_after_retry_increments_run_epoch(
    pipeline_db,
    monkeypatch,
):
    from models import ContentJob, ContentJobStep
    from pipeline_runner import run_skill_pipeline_job
    from pipeline_service import create_pipeline_job, retry_pipeline_stage

    async def fake_enqueue(_job_id, *, flow=None):
        return None

    monkeypatch.setattr("pipeline_runner.enqueue_job", fake_enqueue)
    async with pipeline_db() as session:
        job = await create_pipeline_job(session, _request("runner-retry-epoch", count=2))
    job_id = job.id
    executor = RecordingExecutor()

    await run_skill_pipeline_job(
        job_id,
        session_factory=pipeline_db,
        executor=executor,
    )

    async with pipeline_db() as session:
        steps = list((await session.execute(
            select(ContentJobStep)
            .where(
                ContentJobStep.job_id == job_id,
                ContentJobStep.step_key != "pipeline_plan",
            )
            .order_by(ContentJobStep.id)
        )).scalars().all())
        durable_job = await session.get(ContentJob, job_id)
        steps[1].status = "failed"
        steps[1].retryable = True
        durable_job.status = "failed"
        await session.commit()
        await retry_pipeline_stage(
            session,
            job_id=job_id,
            stage_key=steps[1].step_key,
            request_id="retry-epoch-1",
        )

    await run_skill_pipeline_job(
        job_id,
        session_factory=pipeline_db,
        executor=executor,
    )

    assert [call[0] for call in executor.calls] == [
        "skill:01:source-research",
        "skill:02:writing-plan",
    ]
    assert executor.calls[1][1] is not None


@pytest.mark.asyncio
async def test_runner_reuses_existing_succeeded_execution_and_primary_artifact(
    pipeline_db,
):
    from agent_execution_service import ensure_agent_execution
    from execution_artifacts import append_execution_artifact
    from models import AgentExecution, ContentJob, ContentJobStep, ExecutionArtifact
    from pipeline_runner import run_skill_pipeline_job
    from pipeline_service import create_pipeline_job

    async with pipeline_db() as session:
        job = await create_pipeline_job(session, _request("runner-resume-window", count=1))
        step = (await session.execute(
            select(ContentJobStep)
            .where(ContentJobStep.job_id == job.id, ContentJobStep.step_key != "pipeline_plan")
        )).scalar_one()
        step.status = "running"
        job.status = "running"
        await session.commit()
        execution = await ensure_agent_execution(
            session,
            job_id=job.id,
            step_id=step.id,
            attempt=step.attempt,
            objective="resume",
            skill_mode="job",
            skill_name="source-research",
        )
        execution.status = "succeeded"
        await append_execution_artifact(
            session,
            job_id=job.id,
            step_id=step.id,
            attempt=step.attempt,
            kind="article",
            role="primary",
            title="existing",
            text_content="already persisted",
        )
        await session.commit()
        job_id = job.id

    executor = RecordingExecutor()
    await run_skill_pipeline_job(
        job_id,
        session_factory=pipeline_db,
        executor=executor,
    )

    async with pipeline_db() as session:
        job = await session.get(ContentJob, job_id)
        step = (await session.execute(
            select(ContentJobStep)
            .where(ContentJobStep.job_id == job_id, ContentJobStep.step_key != "pipeline_plan")
        )).scalar_one()
        artifact_count = await session.scalar(
            select(func.count(ExecutionArtifact.id)).where(ExecutionArtifact.job_id == job_id)
        )
    assert executor.calls == []
    assert job is not None and job.status == "succeeded"
    assert step.status == "succeeded"
    assert artifact_count == 1


@pytest.mark.asyncio
async def test_runner_does_not_execute_cancelled_pipeline(pipeline_db):
    from pipeline_runner import run_skill_pipeline_job
    from pipeline_service import cancel_pipeline, create_pipeline_job
    from models import ContentJob

    async with pipeline_db() as session:
        job = await create_pipeline_job(session, _request("runner-cancelled", count=1))
        await cancel_pipeline(session, job_id=job.id, request_id="cancelled-1")
        job_id = job.id

    executor = RecordingExecutor()
    await run_skill_pipeline_job(
        job_id,
        session_factory=pipeline_db,
        executor=executor,
    )
    async with pipeline_db() as session:
        job = await session.get(ContentJob, job_id)
    assert executor.calls == []
    assert job is not None and job.status == "cancelled"


@pytest.mark.asyncio
async def test_runner_rejects_empty_primary_as_non_retryable_failure(pipeline_db):
    from models import AgentExecution, ContentJobStep, ExecutionArtifact
    from pipeline_runner import run_skill_pipeline_job
    from pipeline_service import create_pipeline_job

    async with pipeline_db() as session:
        job = await create_pipeline_job(session, _request("runner-empty", count=1))
    job_id = job.id
    await run_skill_pipeline_job(
        job_id,
        session_factory=pipeline_db,
        executor=RecordingExecutor(empty=True),
    )

    async with pipeline_db() as session:
        job = await session.get(type(job), job_id)
        step = (await session.execute(
            select(ContentJobStep)
            .where(ContentJobStep.job_id == job_id, ContentJobStep.step_key != "pipeline_plan")
        )).scalar_one()
        execution = (await session.execute(
            select(AgentExecution).where(AgentExecution.job_id == job_id)
        )).scalar_one()
        artifact_id = await session.scalar(
            select(ExecutionArtifact.id).where(ExecutionArtifact.job_id == job_id)
        )

    assert job is not None
    assert job.status == "failed"
    assert step.status == "failed"
    assert step.retryable is False
    assert execution.status == "failed"
    assert artifact_id is None


@pytest.mark.asyncio
async def test_runner_marks_executor_failures_retryable_and_does_not_retry_uncertain_side_effects(
    pipeline_db,
):
    from models import ContentJobStep
    from pipeline_runner import (
        PipelineRetryableError,
        PipelineUncertainError,
        run_skill_pipeline_job,
    )
    from pipeline_service import create_pipeline_job

    async with pipeline_db() as session:
        retry_job = await create_pipeline_job(session, _request("runner-retry", count=1))
    retry_job_id = retry_job.id
    await run_skill_pipeline_job(
        retry_job_id,
        session_factory=pipeline_db,
        executor=RecordingExecutor(error=PipelineRetryableError("temporary")),
    )
    async with pipeline_db() as session:
        retry_job = await session.get(type(retry_job), retry_job_id)
        retry_step = (await session.execute(
            select(ContentJobStep)
            .where(ContentJobStep.job_id == retry_job_id, ContentJobStep.step_key != "pipeline_plan")
        )).scalar_one()
    assert retry_job.status == "failed"
    assert retry_step.retryable is True

    async with pipeline_db() as session:
        uncertain_job = await create_pipeline_job(
            session,
            _request("runner-uncertain", count=1),
        )
    uncertain_job_id = uncertain_job.id
    await run_skill_pipeline_job(
        uncertain_job_id,
        session_factory=pipeline_db,
        executor=RecordingExecutor(error=PipelineUncertainError("write outcome unknown")),
    )
    async with pipeline_db() as session:
        uncertain_job = await session.get(type(uncertain_job), uncertain_job_id)
        uncertain_step = (await session.execute(
            select(ContentJobStep)
            .where(
                ContentJobStep.job_id == uncertain_job_id,
                ContentJobStep.step_key != "pipeline_plan",
            )
        )).scalar_one()
    assert uncertain_job.status == "failed"
    assert uncertain_step.retryable is False


@pytest.mark.asyncio
async def test_runner_fails_when_previous_stage_has_no_active_primary(pipeline_db):
    from models import ContentJobStep
    from pipeline_runner import run_skill_pipeline_job
    from pipeline_service import create_pipeline_job

    async with pipeline_db() as session:
        job = await create_pipeline_job(session, _request("runner-missing-primary", count=2))
        steps = list((await session.execute(
            select(ContentJobStep)
            .where(ContentJobStep.job_id == job.id, ContentJobStep.step_key != "pipeline_plan")
            .order_by(ContentJobStep.id)
        )).scalars().all())
        steps[0].status = "succeeded"
        job.status = "queued"
        await session.commit()
    job_id = job.id

    await run_skill_pipeline_job(
        job_id,
        session_factory=pipeline_db,
        executor=RecordingExecutor(),
    )
    async with pipeline_db() as session:
        job = await session.get(type(job), job_id)
        second_step = await session.get(ContentJobStep, steps[1].id)

    assert job is not None
    assert second_step is not None
    assert job.status == "failed"
    assert second_step.status == "failed"
    assert second_step.retryable is False
