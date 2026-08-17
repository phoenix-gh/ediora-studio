# Generic Skill Execution Runtime

## Goal

Make every enabled Skill execute as a traceable workflow instead of treating `SKILL.md` and its references as unverified prompt context. The runtime must support bundled and uploaded Skills without business-specific branches.

## Scope

This design covers Skill activation, progressive reference loading, per-turn planning, execution evidence, validation, and one bounded revision. It applies to manually selected, automatically selected, and conversation-restored Skills.

It does not introduce a general-purpose autonomous Agent platform, execute arbitrary scripts from uploaded archives, or hard-code rules for writing, images, research, or any individual Skill.

## Principles

1. A loaded reference is evidence that content is available, not evidence that its instructions were followed.
2. A Skill run is complete only when its required steps and verification criteria have evidence.
3. Requirements come from the active Skill and current user request. The runtime supplies orchestration, not domain rules.
4. Current user instructions take precedence over Skill defaults. Truthfulness, tool approval, and platform safety cannot be weakened by a Skill or account profile.
5. Uploaded Skills may use only system-provided tools. Archive contents are data unless a future trusted execution mechanism explicitly allows otherwise.

## Runtime Model

Each Skill-guided response creates an in-memory `SkillRun`:

```ts
type SkillRun = {
  skillName: string
  activation: 'manual' | 'automatic' | 'restored'
  goal: string
  steps: SkillRunStep[]
  requiredReferences: string[]
  loadedReferences: string[]
  requiredTools: string[]
  toolEvidence: SkillToolEvidence[]
  outputRequirements: string[]
  validation: SkillRunValidation
}
```

Steps use `pending`, `completed`, `failed`, or `skipped`. A completed step must carry evidence such as a loaded reference path, successful tool result identifier, or generated output section. The runtime state is server-owned and must not trust client-supplied tool parts.

## Execution Flow

### 1. Activate

Manual selection wins. Otherwise the model may activate one clearly matching enabled Skill. A restored Skill may continue a related conversation, but a disabled or deleted Skill falls back to normal automatic selection.

### 2. Plan

After activation, the server asks the model for a structured execution plan derived from:

- the current user request;
- the complete `SKILL.md`;
- the available reference catalog;
- available system tool names and descriptions;
- relevant selected context such as a draft or account profile.

The plan identifies applicable steps, references, tools, output requirements, and verification criteria. It must use exact reference paths and tool names. Invalid or unavailable entries are rejected before execution.

### 3. Load and Execute

References are loaded progressively according to the validated plan. References declared for preload may be loaded before planning only when needed to interpret the Skill itself; preload does not complete any workflow step automatically.

The existing AI SDK tool loop performs research and actions. Successful tool results are recorded as evidence. Failed, rejected, or incomplete tool calls cannot satisfy a step. Sensitive tools retain the current approval flow.

The runtime must not force provider-incompatible `tool_choice` values during thinking mode. Server-side orchestration controls phases while normal tool calls remain model-selected within the execution phase.

### 4. Draft

The draft call receives a compact execution packet:

- current goal;
- applicable Skill instructions;
- loaded applicable references;
- collected tool evidence;
- output requirements;
- explicit instruction hierarchy.

Unrelated references and large historical tool payloads remain excluded.

### 5. Validate

Validation is a separate structured pass. It checks the draft against the run's dynamically extracted requirements and returns:

```ts
type SkillRunValidation = {
  passed: boolean
  violations: Array<{
    requirement: string
    evidence: string
    correction: string
  }>
}
```

The validator must quote concrete output evidence for every violation. Generic deterministic checks cover missing output, incomplete required steps, unloaded required references, failed required tools, and unsupported claims that an action or reference succeeded. Skill-specific content rules remain dynamic requirements extracted from the Skill rather than hard-coded runtime branches.

### 6. Revise or Fail Closed

When validation fails, the runtime performs at most one revision using the original evidence and violation list, then validates again. If the second validation fails, the response must identify the unmet requirements and must not present the result as ready to use or successfully completed.

## Optional Manifest

`SKILL.json` remains optional. Standard Skills containing only `SKILL.md` continue to work. The manifest may provide machine-readable execution hints:

```json
{
  "preloadReferences": [],
  "execution": {
    "planRequired": true,
    "verificationRequired": true,
    "maxRevisions": 1
  }
}
```

Unknown fields are rejected or ignored according to schema version policy. A manifest cannot register executable code or bypass tool approval.

## Persistence and Observability

Persist a compact Skill run audit alongside the assistant message:

- active Skill and activation source;
- plan steps and statuses;
- references requested and loaded;
- tools requested and successful evidence identifiers;
- validation result and revision count.

Do not persist full duplicated reference bodies in the audit. The user-facing UI may later expose this audit, but UI work is outside the initial runtime implementation.

## Error Handling

- Missing or disabled manual Skill: return a clear request error.
- Missing restored Skill: fall back to automatic selection.
- Invalid plan path or tool: reject the plan and retry planning once.
- Required reference read failure: mark the run failed; do not claim compliance.
- Required sensitive tool awaiting approval: preserve the pending state and resume the same run after approval.
- Provider or validator failure: return a transparent incomplete-result message rather than an unvalidated draft.

## Testing

Tests must cover:

1. Plan extraction for different synthetic Skill domains without name-based branches.
2. Exact-path reference validation and progressive loading.
3. Required tool success, failure, and approval resumption.
4. Dynamic output requirements reaching draft and validation phases.
5. Failed validation causing one revision and a second validation.
6. Second validation failure producing a fail-closed response.
7. Manual, automatic, restored, disabled, and deleted Skill behavior.
8. Uploaded Skill archives being unable to register or execute arbitrary code.
9. Provider compatibility without forced research-phase `tool_choice`.
10. Existing non-Skill chat behavior remaining unchanged.

## Rollout

Implement behind an internal runtime switch. First exercise it with synthetic Skills representing writing, research, and image workflows. Then enable it for bundled Skills, followed by uploaded Skills after compatibility tests pass. Remove the old preload-equals-read behavior only after the new run ledger is active.
