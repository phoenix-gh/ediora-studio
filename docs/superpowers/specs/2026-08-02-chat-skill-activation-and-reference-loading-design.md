# Chat Skill Activation and Reference Loading Design

## Goal

Make Chat Skills work through both explicit user selection and automatic activation while preserving progressive disclosure. Once a Skill is active, the model must read applicable references before producing task output instead of silently skipping them.

## Confirmed Behavior

- A user may explicitly select one enabled Skill.
- When no Skill is selected, Chat may automatically activate at most one enabled primary Skill.
- Explicit selection always wins and cannot be replaced by automatic activation.
- Disabled Skills cannot be selected, discovered, loaded, or used to read references.
- A second Skill is loaded only after the active Skill explicitly hands the task off. Multi-Skill orchestration is outside this change.

## Progressive Disclosure

The implementation follows the AI SDK Agent Skills model:

1. Discovery exposes only each enabled Skill's name and description.
2. Activation loads the selected Skill's complete `SKILL.md` instructions.
3. A Skill may declare a bounded preload set in `WMS_SKILL.json`; only those references load with activation. Other references remain available through a scoped tool.

References are never globally concatenated. Skills with large libraries keep progressive disclosure, while small Skills may explicitly preload the rules that must never be skipped.

## Manual Selection Flow

When `skillName` is present in the Chat request:

1. Resolve it through the enabled Skill registry.
2. Inject its `SKILL.md`, reference catalog, and activation marker into Chat instructions.
3. Expose `readSkillReference` scoped to that Skill.
4. Load references declared by that Skill before the first model call and expose other references through `readSkillReference`.

An unavailable or disabled selected Skill fails clearly before model execution.

## Automatic Activation Flow

When `skillName` is absent:

1. Inject a compact catalog containing enabled Skill names and descriptions.
2. Expose a `loadSkill` tool.
3. The model either answers without a Skill or calls `loadSkill` once with the best matching Skill name.
4. `loadSkill` returns the Skill instructions, readable reference catalog, declared preload contents, and binds the active Skill for the current response.
5. The model may then call `readSkillReference`, scoped to the Skill loaded in step 4.

The tool rejects a second, different Skill activation in the same response. Automatic activation is recorded in persisted message tool parts, so behavior can be audited from session history.

## Declared Reference Preload

The initial design used AI SDK `prepareStep` with forced `toolChoice`. Live verification showed that the configured provider's thinking mode rejects forced tool choice with `Thinking mode does not support this tool_choice`. The implementation therefore must not depend on provider-enforced tool choice.

An optional root `WMS_SKILL.json` manifest declares exact preload paths:

```json
{
  "preloadReferences": ["references/core.md"]
}
```

The registry validates the manifest, paths, file sizes, cumulative context limit, UTF-8 content, traversal protection, and symlink protection through the existing reference loader. The manifest itself is not exposed as a reference.

For explicit selection, preload contents enter the initial selected context before model execution. For automatic activation, preload contents enter the `loadSkill` tool result and therefore the following model step. A Skill without a manifest keeps normal on-demand behavior.

Skill instructions own reference routing. For `human-social-copy`, the routing must use mandatory language for clear cases, including:

- earnings, costs, investing, finance, or Crypto → `references/finance-writing.md`;
- X or other platform-ready output → `references/layout-playbook.md`;
- rewriting or humanizing → `references/writing-clean-rules.md`;
- account voice or profile handling → `references/voice-system.md`.

`human-social-copy` preloads its eight small curated references. Other Skills are unchanged unless they add their own manifest.

## Tool Scope and State

The response-local Skill state contains:

- activation source: `manual` or `automatic`;
- active Skill name;
- reference catalog;
- references preloaded or read during the response.

`readSkillReference` validates every requested path against the active Skill and existing registry limits. It cannot read a reference from another Skill. Cached reads do not consume the byte budget twice.

No persistent global "current Skill" is introduced. Each Chat request reconstructs state from the explicit selection and persisted tool history needed for that response, avoiding cross-session leakage.

## Step Budget

The existing Chat loop reserves a final tool-free step. The new flow must reserve enough steps for:

- manual: preloaded context → research/action tools → final answer;
- automatic: load Skill with preload contents → research/action tools → final answer.

The bounded loop still reserves its final step by step number. Automatic `loadSkill` state remains response-local, and the flow must terminate with a user-facing answer while preserving the existing fallback behavior.

## Error Handling

- Unknown or disabled manual Skill: return a clear client error before streaming.
- Invalid automatic Skill name: return a tool error and allow the model to answer without pretending the Skill loaded.
- Missing, invalid, or oversized reference: return the existing registry error and prohibit claims that the reference was used.
- Invalid declared preload content: fail activation clearly rather than silently drafting without required rules.
- Skills without references continue normally after activation.

## Tests

Automated tests will cover:

1. Manual selection activates the requested Skill and injects declared preload content before model execution.
2. No selection exposes enabled Skill metadata and `loadSkill` but does not preload instructions.
3. Automatic activation loads only one Skill and returns declared preload content in its tool result.
4. Disabled Skills are absent from discovery and rejected by both activation paths.
5. A Skill without a preload manifest retains on-demand reference behavior.
6. `human-social-copy` receives all eight declared reference bodies before final generation.
7. Final-answer reservation still prevents blank tool-only responses.
8. Persisted session parts make automatic activation and reference reads auditable.

## Out of Scope

- Automatically loading every reference file without an explicit bounded manifest.
- Activating several Skills in parallel.
- Cross-Skill reference access.
- Reworking Skill upload, enable, disable, or delete behavior.
- Fixing X weighted-character validation; that is a separate follow-up after reference loading is reliable.
