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
3. Reference files remain out of the base prompt and are read through a scoped tool when required by those instructions.

References are not globally concatenated or automatically loaded in full. This keeps context bounded for Skills with large reference libraries.

## Manual Selection Flow

When `skillName` is present in the Chat request:

1. Resolve it through the enabled Skill registry.
2. Inject its `SKILL.md`, reference catalog, and activation marker into Chat instructions.
3. Expose `readSkillReference` scoped to that Skill.
4. Before task output, require a reference-reading preflight whenever the Skill has references.

An unavailable or disabled selected Skill fails clearly before model execution.

## Automatic Activation Flow

When `skillName` is absent:

1. Inject a compact catalog containing enabled Skill names and descriptions.
2. Expose a `loadSkill` tool.
3. The model either answers without a Skill or calls `loadSkill` once with the best matching Skill name.
4. `loadSkill` returns the Skill instructions and readable reference catalog and binds the active Skill for the current response.
5. The model may then call `readSkillReference`, scoped to the Skill loaded in step 4.

The tool rejects a second, different Skill activation in the same response. Automatic activation is recorded in persisted message tool parts, so behavior can be audited from session history.

## Mandatory Reference Preflight

The current failure happens because `readSkillReference` uses the default AI SDK `toolChoice: auto`; the model can ignore it and write immediately.

For an explicitly selected Skill with references, the first model step is constrained with AI SDK `prepareStep`:

- only `readSkillReference` is active;
- `toolChoice` targets `readSkillReference`;
- instructions require all references needed for the current task to be read in that step.

For an automatically activated Skill, `loadSkill` completes first. The following step applies the same reference preflight before other tools or final task output are available.

Skill instructions own reference routing. For `human-social-copy`, the routing must use mandatory language for clear cases, including:

- earnings, costs, investing, finance, or Crypto → `references/finance-writing.md`;
- X or other platform-ready output → `references/layout-playbook.md`;
- rewriting or humanizing → `references/writing-clean-rules.md`;
- account voice or profile handling → `references/voice-system.md`.

The model may issue multiple `readSkillReference` calls in the preflight step. A Skill with no references skips the preflight.

## Tool Scope and State

The response-local Skill state contains:

- activation source: `manual` or `automatic`;
- active Skill name;
- reference catalog;
- references already read during the response.

`readSkillReference` validates every requested path against the active Skill and existing registry limits. It cannot read a reference from another Skill. Cached reads do not consume the byte budget twice.

No persistent global "current Skill" is introduced. Each Chat request reconstructs state from the explicit selection and persisted tool history needed for that response, avoiding cross-session leakage.

## Step Budget

The existing Chat loop reserves a final tool-free step. The new flow must reserve enough steps for:

- manual: reference preflight → research/action tools → final answer;
- automatic: load Skill → reference preflight → research/action tools → final answer.

The implementation will define loop phases from observed tool state rather than relying only on a fixed step number. It must still terminate with a user-facing answer and preserve the existing fallback behavior.

## Error Handling

- Unknown or disabled manual Skill: return a clear client error before streaming.
- Invalid automatic Skill name: return a tool error and allow the model to answer without pretending the Skill loaded.
- Missing, invalid, or oversized reference: return the existing registry error and prohibit claims that the reference was used.
- Reference preflight produces no successful reference result: stop Skill-guided generation with a clear retry message rather than silently drafting without its rules.
- Skills without references continue normally after activation.

## Tests

Automated tests will cover:

1. Manual selection activates the requested Skill and forces reference preflight before other tools.
2. No selection exposes enabled Skill metadata and `loadSkill` but does not preload instructions.
3. Automatic activation loads only one Skill and scopes reference reads to it.
4. Disabled Skills are absent from discovery and rejected by both activation paths.
5. A Skill without references does not enter the reference-preflight phase.
6. `human-social-copy` finance/X requests receive the required reference results before final generation.
7. Final-answer reservation still prevents blank tool-only responses.
8. Persisted session parts make automatic activation and reference reads auditable.

## Out of Scope

- Automatically loading every reference file.
- Activating several Skills in parallel.
- Cross-Skill reference access.
- Reworking Skill upload, enable, disable, or delete behavior.
- Fixing X weighted-character validation; that is a separate follow-up after reference loading is reliable.
