from __future__ import annotations

import pytest
from pydantic import ValidationError


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
