"""Validated, immutable-at-the-boundary contracts for Skill Pipelines."""

from __future__ import annotations

from collections.abc import Sequence
from copy import deepcopy
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class PipelineContractError(ValueError):
    """Raised when a resolved pipeline snapshot cannot be trusted."""


class ResolvedSkillInvocation(BaseModel):
    invocation_id: str = Field(min_length=1, max_length=120)
    skill_name: str = Field(
        min_length=1,
        max_length=80,
        pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$",
    )
    skill_display_name: str = Field(min_length=1, max_length=200)
    parameter_kind: Literal["writing_plan", "publish_account"] | None = None
    parameter_id: str | None = Field(default=None, min_length=1, max_length=120)
    parameter_display_name: str | None = Field(
        default=None,
        min_length=1,
        max_length=200,
    )
    skill_snapshot: dict[str, Any] = Field(default_factory=dict)
    binding_snapshot: dict[str, Any] = Field(default_factory=dict)
    parameter_snapshot: dict[str, Any] | None = None
    capability_snapshot: dict[str, Any] = Field(default_factory=dict)

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_parameter_snapshot(self) -> ResolvedSkillInvocation:
        fields = (
            self.parameter_kind,
            self.parameter_id,
            self.parameter_display_name,
            self.parameter_snapshot,
        )
        if any(value is None for value in fields) and any(
            value is not None for value in fields
        ):
            raise ValueError(
                "parameter_kind, parameter_id, parameter_display_name, and "
                "parameter_snapshot must be supplied together"
            )
        return self


class PipelineCreateInput(BaseModel):
    objective: str = Field(min_length=1, max_length=20_000)
    invocations: list[ResolvedSkillInvocation] = Field(min_length=1, max_length=24)
    confirmation: Literal["interactive", "automatic"] = "interactive"
    title: str = Field(min_length=1, max_length=500)
    idempotency_key: str = Field(default="", max_length=200)

    model_config = ConfigDict(extra="forbid")


_CREDENTIAL_KEYS = {
    "api_key",
    "apikey",
    "token",
    "secret",
    "app_id",
    "appid",
    "app_secret",
    "appsecret",
    "access_token",
    "accesstoken",
    "refresh_token",
    "refreshtoken",
}


def _is_credential_key(key: str) -> bool:
    normalized = "".join(character for character in key.lower() if character.isalnum())
    return normalized in {
        "apikey",
        "token",
        "secret",
        "appid",
        "appsecret",
        "accesstoken",
        "refreshtoken",
    } or normalized.endswith("token")


def _assert_no_credentials(value: object, *, path: str) -> None:
    if isinstance(value, dict):
        for key, nested in value.items():
            if _is_credential_key(str(key)):
                raise PipelineContractError(
                    f"credential-looking field is not allowed in {path}.{key}"
                )
            _assert_no_credentials(nested, path=f"{path}.{key}")
    elif isinstance(value, list):
        for index, nested in enumerate(value):
            _assert_no_credentials(nested, path=f"{path}[{index}]")


def _snapshot_value(snapshot: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in snapshot:
            return snapshot[key]
    return None


def _string_list(value: object, *, field: str) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise PipelineContractError(f"{field} must be a list of strings")
    return list(value)


def effective_tool_names(
    requested: Sequence[str],
    profile_allowed: Sequence[str],
    system_allowed: Sequence[str],
) -> list[str]:
    """Return the stable ordered intersection of all three tool policies."""
    profile = set(profile_allowed)
    system = set(system_allowed)
    result: list[str] = []
    for name in requested:
        if name in profile and name in system and name not in result:
            result.append(name)
    return result


def _validate_capability_snapshot(
    invocation: ResolvedSkillInvocation,
) -> None:
    capability = invocation.capability_snapshot
    required = ("schemaVersion", "mode", "skill", "tools", "policy")
    missing = [key for key in required if key not in capability]
    if missing:
        raise PipelineContractError(
            f"capability snapshot is missing: {', '.join(missing)}"
        )
    if capability["schemaVersion"] != 1:
        raise PipelineContractError("unsupported capability snapshot version")
    if capability["mode"] not in {"chat", "job"}:
        raise PipelineContractError("capability snapshot mode is invalid")
    if not isinstance(capability["skill"], dict):
        raise PipelineContractError("capability snapshot skill must be an object")
    if capability["skill"].get("name") not in {None, invocation.skill_name}:
        raise PipelineContractError("capability snapshot Skill does not match invocation")
    _string_list(capability["tools"], field="capability snapshot tools")
    policy = capability["policy"]
    if not isinstance(policy, dict):
        raise PipelineContractError("capability snapshot policy must be an object")
    allowed = policy.get("allowedToolNames")
    if allowed is None:
        raise PipelineContractError("capability snapshot policy must pin allowed tools")
    allowed = _string_list(allowed, field="capability snapshot allowed tools")

    requested = _string_list(
        _snapshot_value(
            invocation.binding_snapshot,
            "requestedAllowedTools",
            "requested_allowed_tools",
        ) or [],
        field="binding requested tools",
    )
    profile_allowed = _string_list(
        _snapshot_value(
            invocation.binding_snapshot,
            "profileAllowedTools",
            "profile_allowed_tools",
        ) or [],
        field="binding profile tools",
    )
    system_allowed = _string_list(
        _snapshot_value(
            capability,
            "systemAllowedToolNames",
            "system_allowed_tool_names",
        ) or allowed,
        field="system allowed tools",
    )
    expected = effective_tool_names(requested, profile_allowed, system_allowed)
    if allowed != expected:
        raise PipelineContractError(
            "capability snapshot tools do not match the three-way intersection"
        )


def normalize_invocations(
    value: Sequence[ResolvedSkillInvocation],
) -> list[dict[str, Any]]:
    """Copy and validate resolved invocations before they enter Job JSON."""
    normalized: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for index, invocation in enumerate(value, start=1):
        if invocation.invocation_id in seen_ids:
            raise PipelineContractError(
                f"duplicate invocation_id: {invocation.invocation_id}"
            )
        seen_ids.add(invocation.invocation_id)
        _assert_no_credentials(invocation.skill_snapshot, path=f"invocations[{index}].skill_snapshot")
        _assert_no_credentials(invocation.binding_snapshot, path=f"invocations[{index}].binding_snapshot")
        _assert_no_credentials(invocation.parameter_snapshot, path=f"invocations[{index}].parameter_snapshot")
        _assert_no_credentials(invocation.capability_snapshot, path=f"invocations[{index}].capability_snapshot")
        skill_snapshot = invocation.skill_snapshot
        if skill_snapshot.get("name") not in {None, invocation.skill_name}:
            raise PipelineContractError("Skill snapshot name does not match invocation")
        digest = skill_snapshot.get("digest")
        if digest is not None and (
            not isinstance(digest, str)
            or len(digest) != 64
            or any(character not in "0123456789abcdef" for character in digest)
        ):
            raise PipelineContractError("Skill snapshot digest is invalid")
        _validate_capability_snapshot(invocation)
        normalized.append(deepcopy(invocation.model_dump(mode="json")))
    return normalized


def build_macro_plan(objective: str, invocations: Sequence[dict[str, Any]]) -> dict[str, Any]:
    """Build the user-visible plan without model calls or stage reordering."""
    stages: list[dict[str, Any]] = []
    for position, invocation in enumerate(invocations, start=1):
        binding = invocation.get("binding_snapshot", {})
        primary_output = _snapshot_value(binding, "primaryOutput", "primary_output") or "generic"
        capability_profile = _snapshot_value(binding, "capabilityProfile", "capability_profile") or "restricted"
        stage_key = f"skill:{position:02d}:{invocation['skill_name']}"
        stages.append({
            "position": position,
            "step_key": stage_key,
            "invocation_id": invocation["invocation_id"],
            "skill_name": invocation["skill_name"],
            "display_name": invocation["skill_display_name"],
            "expected_output": primary_output,
            "capability_profile": capability_profile,
            "parameter_display_name": invocation.get("parameter_display_name"),
            "instruction": (
                f"Execute {invocation['skill_name']} for the original objective."
            ),
        })
    return {"version": 1, "objective": objective, "stages": stages}
