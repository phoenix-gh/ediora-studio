# Chat Skill Activation and Reference Loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support both manual and automatic Chat Skill activation and guarantee a reference-reading preflight before an active Skill can produce task output.

**Architecture:** Add one response-local Skill runtime that owns activation, catalog exposure, scoped reference reads, and audit state. Skills may declare bounded preload paths in `WMS_SKILL.json`; manual selection injects them before model execution and automatic `loadSkill` returns them in its tool result. Other references remain on demand, and the final tool-free answer remains reserved.

**Tech Stack:** Next.js 16 route handlers, AI SDK 7 `streamText`/`tool`/`prepareStep`, TypeScript, Vitest, existing filesystem Skill registry.

## Global Constraints

- Explicit `skillName` selection always wins over automatic activation.
- Without explicit selection, at most one enabled primary Skill may activate per response.
- Disabled Skills cannot be discovered, loaded, selected, or used for reference reads.
- Keep progressive disclosure: discovery loads metadata, activation loads `SKILL.md` plus only explicitly declared preloads, and other references load through `readSkillReference`.
- Never concatenate every reference into the base prompt.
- Declared preload references must load successfully before an active Skill can produce task output.
- Preserve current registry byte limits, per-response reference caching, tool approvals, persisted tool parts, and the final-answer fallback.
- Do not touch unrelated dirty-worktree files or address X weighted-character counting in this change.

---

## Approved Compatibility Revision

Live smoke testing found that the configured provider's thinking mode rejects forced AI SDK `tool_choice`. This revision supersedes Task 2 and Task 3 steps that require `{ type: 'tool', toolName: 'readSkillReference' }`.

- Add `loadSkillPreloadContext(name)` to `lib/skills/registry.ts` and test safe `WMS_SKILL.json` parsing.
- Seed the response-local runtime with declared preload contents and return them from automatic `loadSkill`.
- Inject declared preload contents into manually selected context before `streamText`.
- Keep `prepareStep` only for the final tool-free answer; never force provider tool choice.
- Add `WMS_SKILL.json` to `human-social-copy` with all eight curated references.
- Re-run both live smokes and confirm no `Thinking mode does not support this tool_choice` error.

---

### Task 1: Response-local Skill activation runtime

**Files:**
- Modify: `wemedia-studio/lib/ai/global-chat-tools.ts`
- Modify: `wemedia-studio/lib/ai/global-chat-tools.test.ts`

**Interfaces:**
- Consumes: `listEnabledSkills`, `getEnabledSkill`, `listSkillReferences`, `readSkillReference` from `lib/skills/registry`.
- Produces: `createChatSkillRuntime(options): Promise<ChatSkillRuntime>`, `ChatSkillRuntime.tools`, `ChatSkillRuntime.catalogContext`, `ChatSkillRuntime.snapshot()`, and `ChatSkillRuntime.close()`.

- [ ] **Step 1: Write failing runtime tests**

Add real registry-backed tests proving:

```ts
const runtime = await createChatSkillRuntime({ apiBase, selectedSkillName: 'Alpha' })
expect(runtime.snapshot()).toMatchObject({ source: 'manual', activeSkillName: 'Alpha', referenceCount: 1, readReferenceCount: 0 })
expect(runtime.catalogContext).toContain('Selected skill: Alpha')
```

For automatic mode, execute the real `loadSkill` tool and assert it returns `SKILL.md` plus the reference catalog, activates exactly one enabled Skill, rejects a second different name with `conflict`, and excludes a disabled Skill. Execute `readSkillReference` before activation and assert `not_found`; after activation, assert the returned content belongs only to the active Skill and increments `readReferenceCount` once even when cached.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd wemedia-studio
pnpm test lib/ai/global-chat-tools.test.ts
```

Expected: FAIL because `createChatSkillRuntime` and automatic `loadSkill` do not exist.

- [ ] **Step 3: Implement the response-local runtime**

Add these public types:

```ts
export type ChatSkillActivationSource = 'manual' | 'automatic'

export type ChatSkillSnapshot = {
  source?: ChatSkillActivationSource
  activeSkillName?: string
  referenceCount: number
  readReferenceCount: number
}

export type ChatSkillRuntime = {
  tools: ToolSet
  catalogContext: string
  snapshot(): ChatSkillSnapshot
  close(): Promise<void>
}
```

`createChatSkillRuntime` must build the MCP/global tools once, initialize manual state through `getEnabledSkill`, or expose enabled metadata and `loadSkill` through `listEnabledSkills`. Always define `readSkillReference`, but make its executor fail until a Skill is active. Reuse `createSkillReferenceReader` after activation and retain its byte accounting/cache. `loadSkill` returns `{ name, description, version, instructions, references }` and refuses to replace an already active different Skill.

- [ ] **Step 4: Run the focused test and verify GREEN**

```bash
cd wemedia-studio
pnpm test lib/ai/global-chat-tools.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the runtime**

```bash
git add wemedia-studio/lib/ai/global-chat-tools.ts wemedia-studio/lib/ai/global-chat-tools.test.ts
git commit -m "feat: add chat skill activation runtime"
```

---

### Task 2: State-aware reference preflight and loop budget

**Files:**
- Modify: `wemedia-studio/lib/ai/chat-loop.ts`
- Modify: `wemedia-studio/lib/ai/chat-loop.test.ts`

**Interfaces:**
- Consumes: `ChatSkillSnapshot` from `global-chat-tools.ts`.
- Produces: `chatToolLoopStep(stepNumber, snapshot): PrepareStepResult | undefined` and updated `CHAT_MAX_STEPS`.

- [ ] **Step 1: Write failing phase-policy tests**

Cover these literal transitions:

```ts
expect(chatToolLoopStep(0, {
  source: 'manual', activeSkillName: 'Alpha', referenceCount: 2, readReferenceCount: 0,
})).toEqual({
  activeTools: ['readSkillReference'],
  toolChoice: { type: 'tool', toolName: 'readSkillReference' },
})

expect(chatToolLoopStep(1, {
  source: 'automatic', activeSkillName: 'Alpha', referenceCount: 2, readReferenceCount: 0,
})).toEqual({
  activeTools: ['readSkillReference'],
  toolChoice: { type: 'tool', toolName: 'readSkillReference' },
})
```

Also assert that an active Skill with zero references and an active Skill with one successful read use normal tools, while the last reserved step returns `{ activeTools: [], toolChoice: 'none' }`. Assert `CHAT_MAX_STEPS` permits `loadSkill → reference → research → final`.

- [ ] **Step 2: Run the focused test and verify RED**

```bash
cd wemedia-studio
pnpm test lib/ai/chat-loop.test.ts
```

Expected: FAIL because the current policy ignores Skill state.

- [ ] **Step 3: Implement the minimal state-aware policy**

Use the snapshot, not prompt keyword heuristics. Before the final reserved step, return the forced reference policy whenever `activeSkillName` exists, `referenceCount > 0`, and `readReferenceCount === 0`. Otherwise leave normal tools available. Increase the bounded step count only enough to support the four required phases.

- [ ] **Step 4: Run the focused test and verify GREEN**

```bash
cd wemedia-studio
pnpm test lib/ai/chat-loop.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the loop policy**

```bash
git add wemedia-studio/lib/ai/chat-loop.ts wemedia-studio/lib/ai/chat-loop.test.ts
git commit -m "fix: require skill reference preflight"
```

---

### Task 3: Wire manual and automatic activation into the Chat route

**Files:**
- Modify: `wemedia-studio/app/api/chat/route.ts`
- Modify: `wemedia-studio/app/api/chat/route.test.ts`
- Modify: `wemedia-studio/lib/ai/chat-instructions.ts`
- Modify: `wemedia-studio/lib/ai/chat-instructions.test.ts`

**Interfaces:**
- Consumes: `createChatSkillRuntime`, `runtime.snapshot()`, and state-aware `chatToolLoopStep`.
- Produces: one Chat request flow that supports explicit selection and metadata-only automatic discovery.

- [ ] **Step 1: Write failing route/context tests**

Test manual context contains full instructions and the reference catalog but not reference bodies. Test automatic context contains enabled `name + description`, instructs the model to call `loadSkill` only when one Skill matches, and contains no `SKILL.md` body. Test disabled Skills are absent. Add a `prepareStep` integration seam and assert the route asks `chatToolLoopStep` with the runtime snapshot after `loadSkill` and reference execution.

- [ ] **Step 2: Run the route tests and verify RED**

```bash
cd wemedia-studio
pnpm test app/api/chat/route.test.ts lib/ai/chat-instructions.test.ts
```

Expected: FAIL because unselected Chat currently exposes no Skill discovery/load path and the route uses the old fixed loop policy.

- [ ] **Step 3: Replace selected-only context with the runtime**

Create the runtime before model execution:

```ts
const runtime = await createChatSkillRuntime({
  apiBase: apiBase(),
  selectedSkillName: body.skillName,
})
```

Build instructions from `runtime.catalogContext` plus selected draft context. Pass `runtime.tools` to `streamText`. In `prepareStep`, call `chatToolLoopStep(stepNumber, runtime.snapshot())`; when the returned policy forces reference reading, append a concise instruction to read every applicable path before proceeding. Close the runtime in existing success and error cleanup paths.

- [ ] **Step 4: Make preflight failure explicit**

At the reserved final step, if an active Skill has references but no successful read, replace normal final instructions with a retry response explaining that required Skill references could not be loaded. Do not claim the Skill rules were followed.

- [ ] **Step 5: Run route tests and verify GREEN**

```bash
cd wemedia-studio
pnpm test app/api/chat/route.test.ts lib/ai/chat-instructions.test.ts lib/ai/chat-loop.test.ts lib/ai/global-chat-tools.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit route integration**

```bash
git add wemedia-studio/app/api/chat/route.ts wemedia-studio/app/api/chat/route.test.ts wemedia-studio/lib/ai/chat-instructions.ts wemedia-studio/lib/ai/chat-instructions.test.ts
git commit -m "feat: activate skills automatically in chat"
```

---

### Task 4: Strengthen human-social-copy reference routing

**Files:**
- Modify: `wemedia-studio/skills/human-social-copy/SKILL.md`
- Modify: `wemedia-studio/lib/skills/bundled-skills.test.ts`

**Interfaces:**
- Consumes: mandatory reference-preflight runtime.
- Produces: unambiguous reference selection instructions for the bundled Skill.

- [ ] **Step 1: Add a failing consumer-visible context test**

Extend the bundled Skill acceptance test to load the real Skill through the Chat runtime and assert a finance/X task receives instructions that route to both `references/finance-writing.md` and `references/layout-playbook.md` before drafting. Keep assertions on the generated runtime context contract, not private parsing helpers.

- [ ] **Step 2: Run the test and verify RED**

```bash
cd wemedia-studio
pnpm test lib/skills/bundled-skills.test.ts
```

Expected: FAIL because the existing wording describes references as optional rather than mandatory for clear task classes.

- [ ] **Step 3: Make routing requirements explicit**

Rewrite the routing section with `必须读取` rules for finance/earnings, platform-ready output, rewriting/humanizing, account voice, sourcing, hooks, content patterns, and sponsored briefs. Keep ordinary reference use task-scoped and do not add personal voice assumptions.

- [ ] **Step 4: Run the test and verify GREEN**

```bash
cd wemedia-studio
pnpm test lib/skills/bundled-skills.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the bundled Skill routing update**

```bash
git add wemedia-studio/skills/human-social-copy/SKILL.md wemedia-studio/lib/skills/bundled-skills.test.ts
git commit -m "fix: require social copy references"
```

---

### Task 5: Full verification and live-session audit

**Files:**
- Modify only Task 1-4 files if verification exposes a scoped defect.

**Interfaces:**
- Consumes: completed runtime, loop, route, and Skill routing.
- Produces: automated and live evidence for both activation paths.

- [ ] **Step 1: Run focused tests and lint**

```bash
cd wemedia-studio
pnpm test lib/ai/global-chat-tools.test.ts lib/ai/chat-loop.test.ts lib/ai/chat-instructions.test.ts app/api/chat/route.test.ts lib/skills/bundled-skills.test.ts lib/skills/registry.test.ts
pnpm exec eslint lib/ai/global-chat-tools.ts lib/ai/global-chat-tools.test.ts lib/ai/chat-loop.ts lib/ai/chat-loop.test.ts lib/ai/chat-instructions.ts lib/ai/chat-instructions.test.ts app/api/chat/route.ts app/api/chat/route.test.ts lib/skills/bundled-skills.test.ts
```

- [ ] **Step 2: Run the full frontend suite and TypeScript check**

```bash
cd wemedia-studio
pnpm test
pnpm exec tsc --noEmit
```

Require no new changed-file errors. Report existing unrelated dirty-worktree TypeScript errors separately.

- [ ] **Step 3: Run manual-selection live smoke**

Create a disposable Chat session, send a finance/X creation request with `skillName: human-social-copy`, and inspect persisted message parts. The first model step must contain successful `readSkillReference` calls before creative-asset search or final copy.

- [ ] **Step 4: Run automatic-activation live smoke**

Create another disposable session, send the same request without `skillName`, and inspect persisted parts. Confirm one `loadSkill` call activates `human-social-copy`, one or more scoped reference reads follow, and final text comes afterward. Do not publish or save external content.

- [ ] **Step 5: Audit and commit any final scoped corrections**

```bash
git diff --check
git status --short
```

Stage only files listed in Tasks 1-4 and this plan. Leave every unrelated user change untouched.
