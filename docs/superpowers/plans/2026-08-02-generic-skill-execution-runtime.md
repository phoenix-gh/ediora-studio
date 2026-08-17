# Generic Skill Execution Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute every bundled or uploaded Skill through a generic, traceable plan, evidence, validation, and bounded-revision lifecycle.

**Architecture:** Add a provider-independent `SkillRun` domain layer, then an AI SDK adapter that creates structured plans and validations while retaining the existing tool and approval system. Integrate it behind `GENERIC_SKILL_RUNTIME=1`; legacy non-Skill chat remains unchanged until focused and live compatibility checks pass.

**Tech Stack:** Next.js 16 route handlers, AI SDK 7, TypeScript, Zod 4, Vitest, existing filesystem Skill registry and MCP tools.

## Global Constraints

- The runtime must not branch on a Skill name or content domain.
- Manual selection wins over automatic activation; restored disabled or deleted Skills fall back to automatic selection.
- Current user instructions override Skill defaults, while truthfulness, approval, and platform safety cannot be weakened by Skill or account configuration.
- References load progressively from exact registry paths; preload never counts as workflow completion by itself.
- Uploaded archives cannot register or execute arbitrary code.
- Only existing system tools may be planned or executed, and sensitive tools retain approval.
- Never force provider-incompatible research-phase `tool_choice` while thinking mode is active.
- Validation may trigger at most one automatic revision; a second failure must fail closed.
- Preserve unrelated dirty-worktree changes and stage only files named by each task.

---

### Task 1: Define the generic SkillRun contract and plan sanitizer

**Files:**
- Create: `web/lib/ai/skill-run.ts`
- Create: `web/lib/ai/skill-run.test.ts`

**Interfaces:**
- Consumes: exact reference paths from the registry and tool names from the current `ToolSet`.
- Produces: `SkillRunPlan`, `SkillRun`, `SkillRunValidation`, `sanitizeSkillRunPlan(input, context)`, and `createSkillRun(plan, activation)`.

- [ ] **Step 1: Write failing schema and sanitizer tests**

```ts
const context = {
  referencePaths: ['references/rules.md'],
  toolNames: ['search_assets'],
}
expect(sanitizeSkillRunPlan({
  goal: '完成任务',
  steps: [{ id: 'read', instruction: '读取规则', requiredReferences: ['references/rules.md'], requiredTools: [] }],
  outputRequirements: ['遵循规则'],
  verificationCriteria: ['结果满足规则'],
}, context).steps[0].status).toBe('pending')

expect(() => sanitizeSkillRunPlan({
  goal: '越权',
  steps: [{ id: 'run', instruction: '运行脚本', requiredReferences: ['scripts/run.sh'], requiredTools: ['shell'] }],
  outputRequirements: [], verificationCriteria: [],
}, context)).toThrow('Invalid Skill plan')
```

Also test duplicate step IDs, empty goals, unknown tool names, unlisted reference paths, more than 12 steps, and more than 24 combined requirements.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cd web && pnpm exec vitest run lib/ai/skill-run.test.ts`

Expected: FAIL because `skill-run.ts` does not exist.

- [ ] **Step 3: Implement strict public schemas and constructors**

```ts
export type SkillRunStep = {
  id: string
  instruction: string
  requiredReferences: string[]
  requiredTools: string[]
  status: 'pending' | 'completed' | 'failed' | 'skipped'
  evidence: string[]
}

export type SkillRunPlan = {
  goal: string
  steps: SkillRunStep[]
  outputRequirements: string[]
  verificationCriteria: string[]
}

export type SkillRunValidation = {
  passed: boolean
  violations: Array<{ requirement: string; evidence: string; correction: string }>
}
```

Use strict Zod schemas, normalize duplicates without changing order, and reject every reference or tool absent from the supplied catalogs.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `cd web && pnpm exec vitest run lib/ai/skill-run.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the domain contract**

```bash
git add web/lib/ai/skill-run.ts web/lib/ai/skill-run.test.ts
git commit -m "feat: define generic skill run contract"
```

---

### Task 2: Build a generic plan prompt and progressive reference loader

**Files:**
- Create: `web/lib/ai/skill-run-planner.ts`
- Create: `web/lib/ai/skill-run-planner.test.ts`
- Modify: `web/lib/ai/global-chat-tools.ts`
- Modify: `web/lib/ai/global-chat-tools.test.ts`
- Modify: `web/lib/skills/registry.ts`
- Modify: `web/lib/skills/registry.test.ts`

**Interfaces:**
- Consumes: `RegisteredSkill`, `SkillReference[]`, current user text, selected context, and tool metadata.
- Produces: `buildSkillPlanPrompt(input): string`, `loadPlannedReferences(plan, reader): Promise<SkillReferenceContent[]>`, and runtime accessors for active Skill metadata without embedding every reference body.

- [ ] **Step 1: Write failing domain-neutral planning tests**

Use three synthetic Skills named `Alpha`, `Beta`, and `Gamma` representing text production, research, and media generation only through their instructions. Assert the prompt contains no known bundled Skill names and instructs the model to return exact paths/tools, applicable steps, output requirements, and verification criteria.

```ts
expect(buildSkillPlanPrompt({ skill: alpha, userRequest: '处理输入', references, tools }))
  .toContain('Use only exact reference paths and tool names from the catalogs')
expect(source).not.toMatch(/human-social-copy|baoyu-cover-image/)
```

Test `loadPlannedReferences` reads the union of plan paths once, preserves registry byte enforcement, and fails if a required read fails.

Also test optional manifest execution hints accept only:

```ts
type SkillExecutionHints = {
  planRequired?: boolean
  verificationRequired?: boolean
  maxRevisions?: 0 | 1
}
```

An absent manifest or absent `execution` field uses `{ planRequired: true, verificationRequired: true, maxRevisions: 1 }`. Unknown execution fields, values outside the bounds, and any executable path or command field are rejected without affecting standard `SKILL.md` discovery.

- [ ] **Step 2: Run tests and verify RED**

Run: `cd web && pnpm exec vitest run lib/ai/skill-run-planner.test.ts lib/ai/global-chat-tools.test.ts lib/skills/registry.test.ts`

Expected: FAIL because the planner and active Skill accessors do not exist.

- [ ] **Step 3: Implement prompt construction and progressive reads**

Return active metadata through a new runtime method:

```ts
type ActiveSkillContext = {
  skill: RegisteredSkill
  references: SkillReference[]
  activation: ChatSkillActivationSource
}

type ChatSkillRuntime = {
  // existing members
  activeContext(): ActiveSkillContext | undefined
  readReferences(paths: string[]): Promise<SkillReferenceContent[]>
}
```

Do not mark declared preloads as read evidence. Keep caching in `createSkillReferenceReader`, and make `readReferences` accept only paths listed for the active Skill.

Extend the existing strict `SKILL.json` parser with `execution?: SkillExecutionHints`. Return normalized hints from the registered Skill metadata; do not accept scripts, commands, module paths, or validator code from the archive.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `cd web && pnpm exec vitest run lib/ai/skill-run-planner.test.ts lib/ai/global-chat-tools.test.ts lib/skills/registry.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit planning and progressive loading**

```bash
git add web/lib/ai/skill-run-planner.ts web/lib/ai/skill-run-planner.test.ts web/lib/ai/global-chat-tools.ts web/lib/ai/global-chat-tools.test.ts web/lib/skills/registry.ts web/lib/skills/registry.test.ts
git commit -m "feat: plan generic skill runs"
```

---

### Task 3: Record workflow evidence without trusting model claims

**Files:**
- Create: `web/lib/ai/skill-run-evidence.ts`
- Create: `web/lib/ai/skill-run-evidence.test.ts`

**Interfaces:**
- Consumes: sanitized plan, loaded reference paths, and AI SDK UI tool parts.
- Produces: `applyReferenceEvidence(run, paths)`, `applyToolEvidence(run, parts)`, `applyOutputEvidence(run, text)`, and `incompleteRequiredSteps(run)`.

- [ ] **Step 1: Write failing evidence tests**

```ts
const updated = applyToolEvidence(run, [
  { type: 'dynamic-tool', toolName: 'search_assets', state: 'output-available', toolCallId: 'call-1', output: { result: [] } },
])
expect(updated.toolEvidence).toEqual([{ toolName: 'search_assets', toolCallId: 'call-1', state: 'succeeded' }])
expect(updated.steps[0].status).toBe('completed')
```

Assert `output-error`, `approval-requested`, `approval-responded` without completed output, plain assistant text claiming success, and unknown tool parts do not complete a step. Assert reference evidence completes only matching required paths.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cd web && pnpm exec vitest run lib/ai/skill-run-evidence.test.ts`

Expected: FAIL because evidence reducers do not exist.

- [ ] **Step 3: Implement immutable evidence reducers**

Store compact identifiers and states, never full tool outputs. A step completes only when all its required references and tools have successful evidence. `applyOutputEvidence` records non-empty accepted draft evidence for steps with neither dependency; it never accepts a model-authored assertion that a tool or reference succeeded.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `cd web && pnpm exec vitest run lib/ai/skill-run-evidence.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit evidence tracking**

```bash
git add web/lib/ai/skill-run-evidence.ts web/lib/ai/skill-run-evidence.test.ts
git commit -m "feat: track skill workflow evidence"
```

---

### Task 4: Add generic validation, one revision, and fail-closed behavior

**Files:**
- Create: `web/lib/ai/skill-run-orchestrator.ts`
- Create: `web/lib/ai/skill-run-orchestrator.test.ts`

**Interfaces:**
- Consumes: `SkillRun`, loaded reference content, tool evidence, and injected `draft`, `validate`, and `revise` callbacks.
- Produces: `completeSkillRun(input): Promise<CompletedSkillRun>` with final text, validation, revision count, and delivery status.

- [ ] **Step 1: Write failing lifecycle tests**

```ts
const result = await completeSkillRun({
  run,
  draft: async () => 'bad draft',
  validate: vi.fn()
    .mockResolvedValueOnce({ passed: false, violations: [violation] })
    .mockResolvedValueOnce({ passed: true, violations: [] }),
  revise: async ({ violations }) => `fixed: ${violations[0].correction}`,
})
expect(result).toMatchObject({ delivery: 'ready', revisionCount: 1 })
```

Add tests for immediate pass, incomplete required evidence preventing draft delivery, validator error, and second validation failure returning `delivery: 'blocked'` with violations rather than the unvalidated draft.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cd web && pnpm exec vitest run lib/ai/skill-run-orchestrator.test.ts`

Expected: FAIL because the orchestrator does not exist.

- [ ] **Step 3: Implement the bounded lifecycle**

```ts
export type CompletedSkillRun = {
  text: string
  delivery: 'ready' | 'blocked'
  validation: SkillRunValidation
  revisionCount: 0 | 1
  run: SkillRun
}
```

Reject empty draft/revision text. Validation prompts receive the current text, exact dynamic requirements, verification criteria, references, and compact tool evidence. A blocked response is generated from violations and must not contain the rejected draft as a ready-to-use result.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `cd web && pnpm exec vitest run lib/ai/skill-run-orchestrator.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the lifecycle**

```bash
git add web/lib/ai/skill-run-orchestrator.ts web/lib/ai/skill-run-orchestrator.test.ts
git commit -m "feat: validate and revise skill outputs"
```

---

### Task 5: Implement the AI SDK adapter without provider-forced tool choice

**Files:**
- Create: `web/lib/ai/skill-run-ai-sdk.ts`
- Create: `web/lib/ai/skill-run-ai-sdk.test.ts`
- Modify: `web/lib/ai/chat-loop.ts`
- Modify: `web/lib/ai/chat-loop.test.ts`

**Interfaces:**
- Consumes: AI SDK language model, messages, active runtime, plan/validation schemas, and existing tools.
- Produces: `selectSkillForTurn(options)` and `executeSkillRunWithAiSdk(options)` returning either a completed Skill result or pending approval parts.

- [ ] **Step 1: Write failing adapter tests with a simulated language model**

Assert automatic mode first returns either one exact enabled Skill name or no selection. Then assert the call sequence is `select → plan → execute/draft → validate`, or `select → plan → execute/draft → validate → revise → validate`. Assert research calls omit forced `toolChoice`, final validation uses structured output, and an approval request returns immediately without validation or revision while retaining its tool part. Manual selection bypasses `select`; restored selection is accepted only when the current request remains related according to the structured selector.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `cd web && pnpm exec vitest run lib/ai/skill-run-ai-sdk.test.ts lib/ai/chat-loop.test.ts`

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement structured planner and validator calls**

Use AI SDK structured output with the strict schemas from Task 1. `selectSkillForTurn` receives only enabled Skill names/descriptions, the current request, and restored Skill name; its output is `{ skillName?: string, continueRestored: boolean }` and is validated against the enabled catalog. Use `generateText` with existing tools and `stepCountIs(CHAT_MAX_STEPS)` for the execution phase, but do not set a research-phase `toolChoice`. Convert completed tool parts into evidence before validation.

When the result contains `approval-requested`, return `{ kind: 'approval', parts }` and persist enough compact run state to resume after approval. When no approval is pending, call `completeSkillRun` with AI-backed draft, validation, and revision callbacks.

- [ ] **Step 4: Preserve a UI message response adapter**

Use AI SDK `createUIMessageStream` and `createUIMessageStreamResponse` to emit only the accepted final text or the pending approval parts. Add a test that reads the resulting stream and proves a rejected first draft is never emitted to the client.

- [ ] **Step 5: Run adapter tests and verify GREEN**

Run: `cd web && pnpm exec vitest run lib/ai/skill-run-ai-sdk.test.ts lib/ai/chat-loop.test.ts`

Expected: PASS with no provider-specific forced tool choice in recorded calls.

- [ ] **Step 6: Commit the AI SDK adapter**

```bash
git add web/lib/ai/skill-run-ai-sdk.ts web/lib/ai/skill-run-ai-sdk.test.ts web/lib/ai/chat-loop.ts web/lib/ai/chat-loop.test.ts
git commit -m "feat: orchestrate verified skill runs"
```

---

### Task 6: Persist compact run audits and integrate the guarded route

**Files:**
- Modify: `backend/database.py`
- Modify: `backend/routers/chat.py`
- Modify: `backend/tests/test_chat_router.py`
- Modify: `web/app/api/chat/route.ts`
- Modify: `web/app/api/chat/route.test.ts`

**Interfaces:**
- Consumes: `executeSkillRunWithAiSdk`, existing persisted session messages, and `GENERIC_SKILL_RUNTIME`.
- Produces: optional `skill_run` audit metadata on assistant messages and guarded route selection between verified and legacy paths.

- [ ] **Step 1: Write failing backend audit tests**

POST an assistant message with:

```json
{
  "skill_run": {
    "skillName": "Alpha",
    "activation": "automatic",
    "steps": [{ "id": "read", "status": "completed", "evidence": ["reference:references/rules.md"] }],
    "loadedReferences": ["references/rules.md"],
    "toolEvidence": [],
    "validation": { "passed": true, "violations": [] },
    "revisionCount": 0
  }
}
```

Assert the API round-trips the compact audit, rejects unknown fields and oversized evidence, and never accepts embedded reference bodies or arbitrary executable content.

- [ ] **Step 2: Run backend tests and verify RED**

Run: `./.conda-env/bin/python -m pytest backend/tests/test_chat_router.py -q`

Expected: FAIL because assistant message audit storage is absent.

- [ ] **Step 3: Implement bounded audit persistence**

Add a nullable JSON column through the existing idempotent migration pattern. Validate maximum 12 steps, 32 evidence strings, 24 reference paths, and 24 violations; cap every string at 500 characters. Do not store reference contents or tool outputs.

- [ ] **Step 4: Write failing route-selection and persistence tests**

Assert:

```ts
process.env.GENERIC_SKILL_RUNTIME = '1'
// active Skill uses executeSkillRunWithAiSdk and persists skill_run

delete process.env.GENERIC_SKILL_RUNTIME
// non-Skill and legacy flows retain streamText behavior
```

Cover manual, automatic, restored, unavailable-restored, approval resume, blocked validation, and non-Skill chat.

- [ ] **Step 5: Implement guarded route integration**

Resolve activation before planning. Use the generic pipeline only when the flag is enabled and a Skill is active. Persist pending approval parts without marking validation complete; after approval, resume the same compact run. Persist accepted or blocked final text with the run audit. Preserve existing fallback and runtime cleanup.

- [ ] **Step 6: Run route and backend tests and verify GREEN**

Run:

```bash
./.conda-env/bin/python -m pytest backend/tests/test_chat_router.py -q
cd web && pnpm exec vitest run app/api/chat/route.test.ts lib/ai/skill-run*.test.ts lib/ai/global-chat-tools.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit integration**

```bash
git add backend/database.py backend/routers/chat.py backend/tests/test_chat_router.py web/app/api/chat/route.ts web/app/api/chat/route.test.ts
git commit -m "feat: persist verified skill runs"
```

---

### Task 7: Verify domain independence and live compatibility

**Files:**
- Modify: `web/lib/ai/skill-run-ai-sdk.test.ts`
- Modify: `web/lib/skills/bundled-skills.test.ts`
- Modify: `docs/superpowers/specs/2026-08-02-generic-skill-execution-runtime-design.md` only if live findings require an approved compatibility note.

**Interfaces:**
- Consumes: completed generic runtime behind its switch.
- Produces: regression evidence across synthetic, bundled, uploaded, approval, and non-Skill flows.

- [ ] **Step 1: Add a name-independence regression test**

Run the same synthetic workflow under two different Skill names and assert identical plans and lifecycle decisions after excluding `skillName` from snapshots. Scan production runtime source and assert it contains no bundled Skill identifier.

- [ ] **Step 2: Run focused and full frontend verification**

```bash
cd web
pnpm exec vitest run lib/ai/skill-run*.test.ts lib/ai/global-chat-tools.test.ts app/api/chat/route.test.ts lib/skills/bundled-skills.test.ts
pnpm exec eslint lib/ai/skill-run*.ts lib/ai/global-chat-tools.ts app/api/chat/route.ts
pnpm exec tsc --noEmit
```

Expected: focused tests and scoped ESLint pass. Record pre-existing unrelated TypeScript failures separately; do not call them passing.

- [ ] **Step 3: Run three live smokes with the switch enabled**

Use temporary sessions for:

1. a writing Skill requiring references and one revision;
2. a different bundled or uploaded Skill with different output requirements;
3. a normal chat that activates no Skill.

Inspect persisted messages and assert the accepted response contains no rejected draft, audits identify exact loaded references, and server logs contain no `Thinking mode does not support this tool_choice` error.

- [ ] **Step 4: Test fail-closed behavior live**

Use a temporary synthetic Skill with an intentionally impossible verification criterion. Confirm the response reports unmet requirements and does not claim a ready result. Disable and remove only that temporary uploaded Skill through the normal API after the smoke.

- [ ] **Step 5: Commit verification coverage**

```bash
git add web/lib/ai/skill-run-ai-sdk.test.ts web/lib/skills/bundled-skills.test.ts
git commit -m "test: verify generic skill execution runtime"
```
