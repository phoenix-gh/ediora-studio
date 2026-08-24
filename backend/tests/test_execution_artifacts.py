import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


@pytest.fixture
async def db(postgres_database_url):
    from database import Base
    import models  # noqa: F401

    engine = create_async_engine(postgres_database_url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    async with sessions() as session:
        yield session
    await engine.dispose()


async def _seed_job_and_steps(db):
    from models import ContentJob, ContentJobStep

    job = ContentJob(flow="skill_pipeline", title="artifacts", input_data={})
    other_job = ContentJob(flow="skill_pipeline", title="other", input_data={})
    db.add_all([job, other_job])
    await db.flush()
    step = ContentJobStep(job_id=job.id, step_key="write", attempt=1)
    retry_step = ContentJobStep(job_id=job.id, step_key="write", attempt=2)
    other_step = ContentJobStep(job_id=other_job.id, step_key="write", attempt=1)
    db.add_all([step, retry_step, other_step])
    await db.commit()
    await db.refresh(step)
    await db.refresh(retry_step)
    await db.refresh(other_step)
    return job, other_job, step, retry_step, other_step


@pytest.mark.asyncio
async def test_append_and_list_artifacts_preserve_order_and_digest(db):
    from execution_artifacts import append_execution_artifact, list_execution_artifacts
    from models import ExecutionArtifact

    job, _other_job, step, _retry_step, _other_step = await _seed_job_and_steps(db)
    primary = await append_execution_artifact(
        db,
        job_id=job.id,
        step_id=step.id,
        attempt=1,
        kind="article",
        role="primary",
        title="Draft",
        text_content="# Draft\n\nBody",
    )
    auxiliary = await append_execution_artifact(
        db,
        job_id=job.id,
        step_id=step.id,
        attempt=1,
        kind="validation_report",
        role="auxiliary",
        title="Validation",
        structured_content={"valid": True},
    )

    assert primary.status == "active"
    assert primary.digest != auxiliary.digest
    assert [item.id for item in await list_execution_artifacts(
        db, job_id=job.id,
    )] == [primary.id, auxiliary.id]
    assert await db.scalar(select(func.count()).select_from(ExecutionArtifact)) == 2
    assert db.in_transaction()

    await db.commit()
    assert await db.scalar(select(func.count()).select_from(ExecutionArtifact)) == 2


@pytest.mark.asyncio
async def test_append_rejects_invalid_content_scope_and_duplicate_primary(db):
    from execution_artifacts import (
        ExecutionArtifactError,
        append_execution_artifact,
    )

    job, other_job, step, retry_step, other_step = await _seed_job_and_steps(db)

    invalid_cases = [
        {"kind": "article", "role": "auxiliary", "title": "No content"},
        {"kind": "", "role": "auxiliary", "title": "Title", "text_content": "x"},
        {"kind": "article", "role": "auxiliary", "title": " ", "text_content": "x"},
        {
            "kind": "article", "role": "auxiliary", "title": "Bad JSON",
            "structured_content": object(),
        },
    ]
    for values in invalid_cases:
        with pytest.raises(ExecutionArtifactError):
            await append_execution_artifact(
                db,
                job_id=job.id,
                step_id=step.id,
                attempt=1,
                **values,
            )

    with pytest.raises(ExecutionArtifactError, match="belongs to job"):
        await append_execution_artifact(
            db,
            job_id=job.id,
            step_id=other_step.id,
            attempt=1,
            kind="article",
            role="auxiliary",
            title="Wrong job",
            text_content="x",
        )
    with pytest.raises(ExecutionArtifactError, match="attempt"):
        await append_execution_artifact(
            db,
            job_id=job.id,
            step_id=retry_step.id,
            attempt=1,
            kind="article",
            role="auxiliary",
            title="Wrong attempt",
            text_content="x",
        )
    with pytest.raises(ExecutionArtifactError, match="job"):
        await append_execution_artifact(
            db,
            job_id=999999,
            step_id=step.id,
            attempt=1,
            kind="article",
            role="auxiliary",
            title="Missing job",
            text_content="x",
        )

    await append_execution_artifact(
        db,
        job_id=job.id,
        step_id=step.id,
        attempt=1,
        kind="article",
        role="primary",
        title="First",
        text_content="first",
    )
    with pytest.raises(ExecutionArtifactError, match="primary"):
        await append_execution_artifact(
            db,
            job_id=job.id,
            step_id=step.id,
            attempt=1,
            kind="article",
            role="primary",
            title="Second",
            text_content="second",
        )

    # The failed duplicate must leave the caller's transaction usable.
    auxiliary = await append_execution_artifact(
        db,
        job_id=job.id,
        step_id=step.id,
        attempt=1,
        kind="validation_report",
        role="auxiliary",
        title="Still usable",
        structured_content={"ok": True},
    )
    assert auxiliary.id > 0
    await db.commit()
    assert other_job.id > 0


@pytest.mark.asyncio
async def test_supersede_is_scoped_append_only_and_filters_active_rows(db):
    from execution_artifacts import (
        append_execution_artifact,
        list_execution_artifacts,
        supersede_execution_artifacts,
    )

    job, other_job, step, retry_step, other_step = await _seed_job_and_steps(db)
    active = await append_execution_artifact(
        db,
        job_id=job.id,
        step_id=step.id,
        attempt=1,
        kind="article",
        role="primary",
        title="Active",
        text_content="keep history",
    )
    auxiliary = await append_execution_artifact(
        db,
        job_id=job.id,
        step_id=step.id,
        attempt=1,
        kind="sources",
        role="auxiliary",
        title="Sources",
        structured_content=["source-1"],
    )
    other_step_artifact = await append_execution_artifact(
        db,
        job_id=job.id,
        step_id=retry_step.id,
        attempt=2,
        kind="article",
        role="primary",
        title="Retry",
        text_content="retry",
    )
    unrelated = await append_execution_artifact(
        db,
        job_id=other_job.id,
        step_id=other_step.id,
        attempt=1,
        kind="article",
        role="primary",
        title="Other job",
        text_content="untouched",
    )
    await db.commit()

    assert await supersede_execution_artifacts(
        db, job_id=job.id, step_ids=[step.id, step.id]
    ) == 2
    assert await supersede_execution_artifacts(
        db, job_id=job.id, step_ids=[]
    ) == 0
    await db.commit()

    all_rows = await list_execution_artifacts(db, job_id=job.id)
    assert [item.id for item in all_rows] == [
        active.id, auxiliary.id, other_step_artifact.id,
    ]
    assert [item.status for item in all_rows] == [
        "superseded", "superseded", "active",
    ]
    assert all_rows[0].digest == active.digest
    assert all_rows[0].text_content == "keep history"
    assert [item.id for item in await list_execution_artifacts(
        db, job_id=job.id, include_superseded=False,
    )] == [other_step_artifact.id]
    unrelated_rows = await list_execution_artifacts(db, job_id=other_job.id)
    assert [(item.id, item.status, item.text_content) for item in unrelated_rows] == [
        (unrelated.id, "active", "untouched"),
    ]
