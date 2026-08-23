from __future__ import annotations

import sys

import pytest
from pydantic import ValidationError
from sqlalchemy import func, select


@pytest.fixture
async def pipeline_db(postgres_database_url):
    for module in list(sys.modules):
        if module in {"database", "models", "pipeline_contracts", "pipeline_service"}:
            sys.modules.pop(module, None)
    from database import Base
    import models  # noqa: F401
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    engine = create_async_engine(postgres_database_url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    async with sessions() as session:
        yield session
    await engine.dispose()


def _invocation(
    invocation_id: str,
    skill_name: str,
    *,
    parameter_kind: str | None = None,
    parameter_id: str | None = None,
    parameter_display_name: str | None = None,
    parameter_snapshot: dict | None = None,
    allowed_tools: list[str] | None = None,
) -> dict:
    tools = allowed_tools or ["read_context"]
    return {
        "invocation_id": invocation_id,
        "skill_name": skill_name,
        "skill_display_name": skill_name,
        "parameter_kind": parameter_kind,
        "parameter_id": parameter_id,
        "parameter_display_name": parameter_display_name,
        "skill_snapshot": {
            "name": skill_name,
            "version": "1.0.0",
            "digest": "a" * 64,
            "source": "builtin",
        },
        "binding_snapshot": {
            "primaryOutput": "article",
            "capabilityProfile": "writing",
            "requestedAllowedTools": tools,
            "profileAllowedTools": tools,
        },
        "parameter_snapshot": parameter_snapshot,
        "capability_snapshot": {
            "schemaVersion": 1,
            "mode": "job",
            "skill": {"name": skill_name},
            "tools": [],
            "policy": {
                "approvalPolicy": "automatic",
                "allowedToolNames": tools,
            },
        },
    }


def _model(payload: dict):
    from pipeline_contracts import ResolvedSkillInvocation

    return ResolvedSkillInvocation.model_validate(payload)


def test_pipeline_contract_preserves_order_and_duplicate_skills():
    from pipeline_contracts import normalize_invocations

    invocations = [
        _model(_invocation("one", "source-research")),
        _model(_invocation("two", "humanize-writing")),
        _model(_invocation("three", "humanize-writing")),
    ]

    normalized = normalize_invocations(invocations)

    assert [item["invocation_id"] for item in normalized] == [
        "one", "two", "three",
    ]
    assert [item["skill_name"] for item in normalized] == [
        "source-research", "humanize-writing", "humanize-writing",
    ]
    normalized[0]["skill_snapshot"]["name"] = "changed"
    assert invocations[0].skill_snapshot["name"] == "source-research"


def test_pipeline_contract_rejects_mismatched_parameter_fields():
    payload = _invocation(
        "plan",
        "writing-plan",
        parameter_kind="writing_plan",
        parameter_id=None,
    )

    with pytest.raises(ValidationError):
        _model(payload)


def test_pipeline_contract_rejects_parameter_snapshot_without_parameter():
    payload = _invocation(
        "unbound",
        "portable-skill",
        parameter_snapshot={"id": 7},
    )

    with pytest.raises(ValidationError):
        _model(payload)


def test_pipeline_contract_rejects_credentials_inside_snapshots():
    from pipeline_contracts import PipelineContractError, normalize_invocations

    payload = _invocation("unsafe", "portable-skill")
    payload["parameter_snapshot"] = None
    payload["skill_snapshot"]["metadata"] = {
        "nested": {"access_token": "must never persist"},
    }

    with pytest.raises(PipelineContractError, match="credential"):
        normalize_invocations([_model(payload)])


def test_effective_tools_are_the_stable_three_way_intersection():
    from pipeline_contracts import effective_tool_names

    assert effective_tool_names(
        ["fetch", "read_context", "fetch", "write_artifact"],
        ["read_context", "fetch", "write_artifact"],
        ["fetch", "read_context"],
    ) == ["fetch", "read_context"]


def test_macro_plan_is_deterministic_and_preserves_duplicate_order():
    from pipeline_contracts import build_macro_plan, normalize_invocations

    invocations = normalize_invocations([
        _model(_invocation("one", "source-research", allowed_tools=["fetch"])),
        _model(_invocation(
            "two",
            "writing-plan",
            parameter_kind="writing_plan",
            parameter_id="7",
            parameter_display_name="深度技术文章",
            parameter_snapshot={"plan_id": 7, "title": "深度技术文章"},
        )),
        _model(_invocation("three", "humanize-writing")),
    ])

    plan = build_macro_plan("Write an article", invocations)

    assert plan == {
        "version": 1,
        "objective": "Write an article",
        "stages": [
            {
                "position": 1,
                "step_key": "skill:01:source-research",
                "invocation_id": "one",
                "skill_name": "source-research",
                "display_name": "source-research",
                "expected_output": "article",
                "capability_profile": "writing",
                "parameter_display_name": None,
                "instruction": "Execute source-research for the original objective.",
            },
            {
                "position": 2,
                "step_key": "skill:02:writing-plan",
                "invocation_id": "two",
                "skill_name": "writing-plan",
                "display_name": "writing-plan",
                "expected_output": "article",
                "capability_profile": "writing",
                "parameter_display_name": "深度技术文章",
                "instruction": "Execute writing-plan for the original objective.",
            },
            {
                "position": 3,
                "step_key": "skill:03:humanize-writing",
                "invocation_id": "three",
                "skill_name": "humanize-writing",
                "display_name": "humanize-writing",
                "expected_output": "article",
                "capability_profile": "writing",
                "parameter_display_name": None,
                "instruction": "Execute humanize-writing for the original objective.",
            },
        ],
    }


@pytest.mark.asyncio
async def test_create_pipeline_job_persists_ordered_frozen_stage_snapshots(pipeline_db):
    from pipeline_contracts import PipelineCreateInput
    from pipeline_service import create_pipeline_job, pipeline_job_payload
    from models import ContentJobEvent, ContentJobStep

    request = PipelineCreateInput(
        objective="Write an article",
        title="Local-first AI",
        confirmation="interactive",
        idempotency_key="chat:1:message-1",
        invocations=[
            _model(_invocation("one", "source-research")),
            _model(_invocation(
                "two",
                "writing-plan",
                parameter_kind="writing_plan",
                parameter_id="7",
                parameter_display_name="深度技术文章",
                parameter_snapshot={"plan_id": 7, "title": "深度技术文章"},
            )),
            _model(_invocation("three", "humanize-writing")),
        ],
    )

    job = await create_pipeline_job(pipeline_db, request)
    stages = list((await pipeline_db.execute(
        select(ContentJobStep)
        .where(ContentJobStep.job_id == job.id)
        .order_by(ContentJobStep.id)
    )).scalars().all())

    assert job.flow == "skill_pipeline"
    assert job.status == "awaiting_confirmation"
    assert (job.plan_version, job.run_epoch) == (1, 1)
    assert job.input_data["objective"] == "Write an article"
    assert [stage.step_key for stage in stages] == [
        "pipeline_plan",
        "skill:01:source-research",
        "skill:02:writing-plan",
        "skill:03:humanize-writing",
    ]
    assert stages[0].status == "succeeded"
    assert [stage.status for stage in stages[1:]] == ["queued", "queued", "queued"]
    assert stages[1].input_data["previous_primary_artifact_id"] is None
    assert stages[2].input_data["parameter_snapshot"]["plan_id"] == 7
    assert stages[3].input_data["invocation"]["skill_name"] == "humanize-writing"
    assert stages[0].output_data["stages"][0]["step_key"] == "skill:01:source-research"

    payload = await pipeline_job_payload(pipeline_db, job.id)
    assert payload["pipeline"]["plan"]["stages"][1]["skill_name"] == "writing-plan"
    assert payload["pipeline"]["stages"][0]["input"]["invocation"]["skill_name"] == "source-research"
    assert "instructions" not in payload["pipeline"]["stages"][0]["input"]["invocation"]
    assert "api_key" not in repr(payload)

    event_count = await pipeline_db.scalar(
        select(func.count(ContentJobEvent.id)).where(ContentJobEvent.job_id == job.id)
    )
    assert event_count == 2


@pytest.mark.asyncio
async def test_create_pipeline_job_idempotency_does_not_duplicate_rows(pipeline_db):
    from pipeline_contracts import PipelineCreateInput
    from pipeline_service import create_pipeline_job
    from models import ContentJobEvent, ContentJobStep

    request = PipelineCreateInput(
        objective="Write twice",
        title="Idempotent",
        idempotency_key="job:duplicate",
        invocations=[_model(_invocation("one", "source-research"))],
    )

    first = await create_pipeline_job(pipeline_db, request)
    second = await create_pipeline_job(pipeline_db, request)

    assert second.id == first.id
    assert await pipeline_db.scalar(
        select(func.count(ContentJobStep.id)).where(ContentJobStep.job_id == first.id)
    ) == 2
    assert await pipeline_db.scalar(
        select(func.count(ContentJobEvent.id)).where(ContentJobEvent.job_id == first.id)
    ) == 2
