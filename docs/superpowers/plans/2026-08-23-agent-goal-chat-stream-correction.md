# Agent Goal and Chat Streaming Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make durable Agent success depend on the Agent's explicit evidence-backed completion declaration, keep one inline Skill in normal streaming Chat, restore foldable reasoning deltas, and coalesce duplicate trajectory tool events.

**Architecture:** Add a Harness-owned `complete_goal` control tool to the shared Agent runtime without placing it in Skill capability snapshots. Durable runners require its declaration and apply only generic evidence checks; prompt quantities and hidden rule counts never decide completion. Chat dispatches one structured invocation through `/api/chat` with authoritative parameter resolution, while two or more invocations keep the durable Pipeline route.

**Tech Stack:** TypeScript, Next.js App Router, React, AI SDK 7, Zod, Vitest, Testing Library, FastAPI-backed durable execution APIs.

**Spec:** `docs/superpowers/specs/2026-08-23-ediora-skill-pipeline-design.md`

## Global Constraints

- The Agent owns the business completion judgment; Harness code validates only declaration shape, evidence identity, run health, and persistence state.
- Do not parse prompt quantities or read `target_count`/`requested_count` to decide success.
- `complete_goal` is a Harness control tool, not a Skill package tool and not part of frozen Skill capability drift checks.
- Exactly one confirmed inline Skill uses direct streaming Chat; two or more use the existing ordered Pipeline.
- Server-side resolution owns Skill and parameter snapshots; client labels are display-only.
- Raw trajectory events remain append-only; deduplication occurs only in the read projection.
- Product-facing names use Ediora; legacy paths and table names remain unchanged.
- Preserve existing data and unrelated worktree changes.

---

## File Structure

- Create `web/lib/ai/agent-goal-completion.ts`: declaration schema, control-tool construction, generic evidence-reference validation, and completion prompt text.
- Modify `web/lib/ai/agent-runtime-types.ts`: shared declaration/evidence/result types.
- Modify `web/lib/ai/agent-runtime.ts`: inject the control tool only for required durable runs, stop on its call, issue one generic self-audit continuation, and return the accepted declaration.
- Modify `web/lib/ai/daily-creation-agent-job.ts`: remove draft-count business checks and accept only shared goal completion.
- Modify `web/lib/ai/skill-pipeline-job.ts`: require the same completion declaration before Stage success; optional Skill validation is advisory evidence, not a success authority.
- Modify `web/lib/api/chat.ts`, `web/components/features/chat/ChatWorkspaceProvider.tsx`, and `web/components/features/chat/chat-workspace-state.ts`: dispatch one invocation directly while preserving its structured message part.
- Modify `web/app/api/chat/route.ts` and `web/lib/ai/pipeline-resolver.ts`: validate and resolve one direct invocation server-side, inject its parameter snapshot, and keep the direct path streaming.
- Modify `web/components/features/chat/ChatMessageView.tsx`: render one foldable live/persisted reasoning part.
- Modify `web/lib/ai/agent-trajectory.ts`: coalesce same-turn duplicate tool events by `callId`, preferring explicit Step placement.
- Update the exact adjacent Vitest files for every changed boundary.

---

### Task 1: Shared Agent-Owned Goal Completion

**Files:**
- Create: `web/lib/ai/agent-goal-completion.ts`
- Modify: `web/lib/ai/agent-runtime-types.ts`
- Modify: `web/lib/ai/agent-runtime.ts`
- Test: `web/lib/ai/agent-runtime.test.ts`

**Interfaces:**
- Produces: `AgentGoalCompletionDeclaration`, `AgentGoalEvidenceReference`, `completeGoalInputSchema`, `createCompleteGoalTool()`, `AgentRunRequest.requireGoalCompletion`, and `AgentRunRequest.validateGoalCompletion`.
- Produces: `AgentRunResult.goalCompletion?: AgentGoalCompletionDeclaration`.
- Consumes: existing `AgentToolAudit`, `beforeToolExecute`, `onToolAudit`, AI SDK `hasToolCall`, and the shared execution step budget.

- [ ] **Step 1: Write failing runtime tests**

Add tests proving all of these behaviors:

```ts
it('requires a complete_goal declaration for durable runs and generically follows up once', async () => {
  // First model response is a normal stop without tools.
  // Second response calls complete_goal with status completed.
  // Assert the second request contains the unchanged objective and no draft-count wording.
  // Assert result.goalCompletion.status === 'completed'.
})

it('does not expose complete_goal in capability snapshots or Skill planning tools', async () => {
  expect(runtime.capabilitySnapshot().tools.map(tool => tool.name)).not.toContain('complete_goal')
  expect(planningTools(runtime.tools).map(tool => tool.name)).not.toContain('complete_goal')
})

it('returns blocked without reporting durable completion', async () => {
  // Model calls complete_goal({status:'blocked', summary:'...', remainingWork:['...'], evidence:[]}).
  expect(result.goalCompletion?.status).toBe('blocked')
})

it('fails when the step budget ends without a completion declaration', async () => {
  await expect(runtime.run({ ...request, requireGoalCompletion: true, maxSteps: 2 }))
    .rejects.toThrow('Agent ended without declaring goal completion')
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run from `web`:

```bash
pnpm exec vitest run lib/ai/agent-runtime.test.ts
```

Expected: FAIL because the goal types, tool, request flag, and result field do not exist.

- [ ] **Step 3: Implement the completion module and runtime loop**

Define the strict schema and constructor:

```ts
export const completeGoalInputSchema = z.object({
  status: z.enum(['completed', 'blocked']),
  summary: z.string().trim().min(1).max(50_000),
  evidence: z.array(z.object({
    kind: z.enum(['tool_call', 'artifact']),
    id: z.string().trim().min(1).max(300),
    claim: z.string().trim().min(1).max(1_000),
  }).strict()).max(100),
  remainingWork: z.array(z.string().trim().min(1).max(1_000)).max(100).optional(),
}).strict()

export function createCompleteGoalTool(
  accept: (input: AgentGoalCompletionDeclaration) => void | Promise<void>,
) {
  return tool({
    description: COMPLETE_GOAL_DESCRIPTION,
    inputSchema: completeGoalInputSchema,
    execute: async input => {
      await accept(input)
      return { accepted: true, declaration: input }
    },
  })
}
```

Wrap only this control tool with `applyAgentToolPolicy` so durable claim/replay and audits remain intact. Merge it into execution tools after capability snapshots are built and exclude it in `planningTools`. Use a custom AI SDK stop condition that returns true only after the declaration callback has accepted a valid or replayed `complete_goal` result; an invalid tool call must return its error to the Agent instead of stopping the loop. Capture accepted or replayed declarations from the successful audit output.

When `requireGoalCompletion` is true, append generic instructions that preserve the original objective and require the Agent to audit actual tool results before calling `complete_goal` alone. On the first natural stop without a declaration, append one generic user follow-up. If another natural stop or the shared step limit occurs without a declaration, throw `Agent ended without declaring goal completion`.

- [ ] **Step 4: Run the runtime test and verify GREEN**

Run:

```bash
pnpm exec vitest run lib/ai/agent-runtime.test.ts
```

Expected: all tests pass, including existing plan/reference/tool-loop coverage.

- [ ] **Step 5: Commit the shared runtime boundary**

```bash
git add web/lib/ai/agent-goal-completion.ts web/lib/ai/agent-runtime-types.ts web/lib/ai/agent-runtime.ts web/lib/ai/agent-runtime.test.ts
git commit -m "feat: let agents declare durable goal completion"
```

---

### Task 2: Durable Daily and Pipeline Completion

**Files:**
- Modify: `web/lib/ai/daily-creation-agent-job.ts`
- Modify: `web/lib/ai/daily-creation-agent-job.test.ts`
- Modify: `web/lib/ai/daily-creation-agent-integration.test.ts`
- Modify: `web/lib/ai/skill-pipeline-job.ts`
- Modify: `web/lib/ai/skill-pipeline-job.test.ts`

**Interfaces:**
- Consumes: `AgentRunRequest.requireGoalCompletion`, `AgentRunRequest.validateGoalCompletion`, and `AgentRunResult.goalCompletion` from Task 1.
- Produces: durable `AgentCompletionEvidence.kind = 'agent_run'` whose `finalText` comes from the accepted declaration summary and whose audit/checkpoint contains the declaration.

- [ ] **Step 1: Replace quantity-oriented tests with Agent-declaration tests**

Delete tests for `draftCountFromPrompt`, required draft counts, partial count failures, and count-derived summaries. Add:

```ts
it('does not reinterpret prompt or rule counts when the Agent declares completion', async () => {
  // prompt says 3, requested_count and target_count say 12, one real save_draft audit exists.
  // Runtime returns goalCompletion.status completed and cites that tool call.
  await expect(runDailyCreationAgentJob(19, deps)).resolves.toMatchObject({
    kind: 'agent_run', finalText: '既定目标已经完成',
  })
  expect(runtimeRun).toHaveBeenCalledWith(expect.objectContaining({ requireGoalCompletion: true }))
})

it('does not succeed after a normal stop without a declaration', async () => {
  await expect(runDailyCreationAgentJob(19, deps)).rejects.toThrow(
    'Agent ended without declaring goal completion',
  )
  expect(deps.completeJob).not.toHaveBeenCalled()
})

it('fails a blocked declaration with preserved remaining work', async () => {
  await expect(runDailyCreationAgentJob(19, deps)).rejects.toThrow('Agent blocked:')
})
```

Add equivalent Pipeline tests proving a passing hidden validator is insufficient without `goalCompletion`, a completed declaration allows Stage persistence, and a blocked declaration cannot start the next Stage.

- [ ] **Step 2: Run durable-runner tests and verify RED**

Run:

```bash
pnpm exec vitest run lib/ai/daily-creation-agent-job.test.ts lib/ai/daily-creation-agent-integration.test.ts lib/ai/skill-pipeline-job.test.ts
```

Expected: FAIL because runners still require `save_draft`, parse quantities, and trust ordinary validated results.

- [ ] **Step 3: Remove business-count completion code**

Remove `draftCountFromPrompt`, `requiredDraftCount`, Chinese-number parsing, `persistedDraftIds`, draft-count follow-ups, count-derived summaries, and `requiredTools: ['save_draft']`. Keep generic blocking-tool and uncertain-side-effect checks.

Call the runtime with:

```ts
const result = await runtime.run({
  objective,
  modelMessages: [{ role: 'user', content: objective }],
  maxSteps: 30,
  requireGoalCompletion: true,
  validateGoalCompletion: declaration => validateCurrentExecutionEvidence(declaration, audits),
  onStep: event => checkpoint(...),
})
```

Reject missing or `blocked` declarations. For `completed`, verify every cited `tool_call` ID belongs to a successful, non-uncertain audit in the current execution. Persist the declaration in the finalizing checkpoint and completion evidence. Pipeline Stage text artifacts use the accepted declaration summary as the final deliverable when the completion turn supplies it; Skill validation remains recorded feedback but cannot mark success by itself.

Do not retain compatibility for legacy `agent_run` completion evidence that
lacks `goalCompletion`. A succeeded execution or persisted primary artifact
without the declaration must not complete a durable Job or Stage.

- [ ] **Step 4: Run durable-runner tests and verify GREEN**

Run:

```bash
pnpm exec vitest run lib/ai/daily-creation-agent-job.test.ts lib/ai/daily-creation-agent-integration.test.ts lib/ai/skill-pipeline-job.test.ts
```

Expected: all focused durable completion, recovery, capability pin, and uncertain-side-effect tests pass.

- [ ] **Step 5: Commit durable runner migration**

```bash
git add web/lib/ai/daily-creation-agent-job.ts web/lib/ai/daily-creation-agent-job.test.ts web/lib/ai/daily-creation-agent-integration.test.ts web/lib/ai/skill-pipeline-job.ts web/lib/ai/skill-pipeline-job.test.ts
git commit -m "fix: use agent declarations for durable completion"
```

---

### Task 3: One Inline Skill Uses Direct Streaming Chat

**Files:**
- Modify: `web/lib/api/chat.ts`
- Modify: `web/lib/api/chat.test.ts`
- Modify: `web/components/features/chat/ChatWorkspaceProvider.tsx`
- Modify: `web/components/features/chat/ChatWorkspaceProvider.test.tsx`
- Modify: `web/app/chat/ChatClient.test.tsx`
- Modify: `web/app/api/chat/route.ts`
- Modify: `web/app/api/chat/route.test.ts`
- Modify: `web/lib/ai/pipeline-resolver.ts`
- Modify: `web/lib/ai/pipeline-resolver.test.ts`

**Interfaces:**
- Produces: `streamChatReply({ skillInvocation?, messageParts? })` for exactly one `SubmittedSkillInvocation`.
- Consumes: `resolvePipelineInvocations([invocation], { mode: 'chat' })` and existing structured composer parts.

- [ ] **Step 1: Write failing dispatch and server-resolution tests**

Provider assertions:

```ts
expect(api.streamChatReply).toHaveBeenCalledWith(expect.objectContaining({
  skillInvocation: expect.objectContaining({ skillName: 'writing-plan', parameterId: '12' }),
  messageParts,
}))
expect(api.createChatPipeline).not.toHaveBeenCalled()
expect(current.messages[0].parts).toEqual(messageParts)
```

Add a second test with two invocations asserting `createChatPipeline` is called once in exact order and `streamChatReply` is not called.

Route tests must prove client display labels cannot override the resolved Skill/parameter snapshot and that a structured direct invocation takes the `streamText` branch rather than `agentRunUIResponse`.

- [ ] **Step 2: Run Chat dispatch tests and verify RED**

Run:

```bash
pnpm exec vitest run components/features/chat/ChatWorkspaceProvider.test.tsx app/chat/ChatClient.test.tsx app/api/chat/route.test.ts lib/ai/pipeline-resolver.test.ts lib/api/chat.test.ts
```

Expected: FAIL because any positive invocation count currently creates a Pipeline and `/api/chat` accepts no structured invocation.

- [ ] **Step 3: Implement count-based dispatch and authoritative direct resolution**

In `ChatWorkspaceProvider.submit`:

```ts
if (pipelineInvocations.length >= 2) return submitPipeline(...)

const directInvocation = pipelineInvocations.length === 1
  ? pipelineInvocations[0]
  : undefined
const userMessage = makeLocalMessage('user', messageParts)
await streamChatReply({
  sessionId,
  messages: toModelMessages([...currentMessages, userMessage]),
  skillInvocation: directInvocation,
  messageParts,
  ...
})
```

Filter `skill-invocation` display parts out of AI SDK model history while preserving them in the local and persisted user message. Extend `/api/chat` request validation with one strict submitted invocation plus ordered `messageParts`. Resolve it server-side, derive the manual Skill name from the resolved payload, inject the frozen parameter snapshot as delimited untrusted context, and persist the structured display parts. Keep the explicit structured single-Skill path on `streamText`; the existing multi-Skill route remains unchanged.

- [ ] **Step 4: Run Chat dispatch tests and verify GREEN**

Run the same five files from Step 2. Expected: all pass.

- [ ] **Step 5: Commit direct single-Skill Chat**

```bash
git add web/lib/api/chat.ts web/lib/api/chat.test.ts web/components/features/chat/ChatWorkspaceProvider.tsx web/components/features/chat/ChatWorkspaceProvider.test.tsx web/app/chat/ChatClient.test.tsx web/app/api/chat/route.ts web/app/api/chat/route.test.ts web/lib/ai/pipeline-resolver.ts web/lib/ai/pipeline-resolver.test.ts
git commit -m "fix: stream one inline skill through chat"
```

---

### Task 4: Foldable Live Reasoning

**Files:**
- Modify: `web/components/features/chat/chat-workspace-state.ts`
- Modify: `web/components/features/chat/chat-workspace-state.test.ts`
- Modify: `web/components/features/chat/ChatMessageView.tsx`
- Modify: `web/components/features/chat/ChatMessageView.test.tsx`

**Interfaces:**
- Produces Chat parts `{ type: 'reasoning', id, text, state: 'streaming' | 'complete' }`.
- Consumes AI SDK UI events `reasoning-start`, `reasoning-delta`, and `reasoning-end`.

- [ ] **Step 1: Write failing state and rendering tests**

```ts
const started = applyChatStreamEvent([assistant], id, { type: 'reasoning-start', id: 'r-1' })
const updated = applyChatStreamEvent(started, id, { type: 'reasoning-delta', id: 'r-1', delta: '先查资料' })
const ended = applyChatStreamEvent(updated, id, { type: 'reasoning-end', id: 'r-1' })
expect(ended[0].parts).toContainEqual({
  type: 'reasoning', id: 'r-1', text: '先查资料', state: 'complete',
})
```

Render the streaming state expanded with “思考中”, then rerender complete and assert a collapsed `<details>` summary “思考过程” retains the text.

- [ ] **Step 2: Run reasoning tests and verify RED**

Run:

```bash
pnpm exec vitest run components/features/chat/chat-workspace-state.test.ts components/features/chat/ChatMessageView.test.tsx
```

Expected: FAIL because reasoning events are ignored and reasoning parts are not rendered.

- [ ] **Step 3: Implement reasoning accumulation and folding**

Merge deltas by reasoning ID exactly as text deltas are merged. Render assistant reasoning before final text in a semantic `<details>` block, open while `state === 'streaming'`, closed by default after `reasoning-end`, and preserve persisted reasoning parts after reload. Do not expose an empty block when a provider emits start/end without content.

- [ ] **Step 4: Run reasoning tests and verify GREEN**

Run the same two files from Step 2. Expected: all pass.

- [ ] **Step 5: Commit reasoning streaming**

```bash
git add web/components/features/chat/chat-workspace-state.ts web/components/features/chat/chat-workspace-state.test.ts web/components/features/chat/ChatMessageView.tsx web/components/features/chat/ChatMessageView.test.tsx
git commit -m "fix: restore streaming chat reasoning"
```

---

### Task 5: Coalesce Duplicate Trajectory Tool Events

**Files:**
- Modify: `web/lib/ai/agent-trajectory.ts`
- Modify: `web/lib/ai/agent-trajectory.test.ts`

**Interfaces:**
- Produces one projected `MutableTool` per `(turn, callId)` while retaining every source event sequence.
- Consumes append-only events whose same `callId` may occur once with `step = null` and once with an explicit Step.

- [ ] **Step 1: Write the failing #2076-shaped projection test**

```ts
it('coalesces durable and canonical copies of one tool call into the explicit Step', () => {
  const snapshot = deriveAgentTrajectory([
    event(1, 'turn/start'),
    event(2, 'tool/call', { callId: 'image-1', name: 'generateImage', arguments: { prompt: 'cover' } }),
    event(3, 'tool/result', { callId: 'image-1', output: { asset_id: 1396 }, isError: false }),
    event(4, 'step/start', { step: 4 }, 1, 4),
    event(5, 'tool/call', { callId: 'image-1', name: 'generateImage', arguments: { prompt: 'cover' } }, 1, 4),
    event(6, 'tool/result', { callId: 'image-1', output: { asset_id: 1396 }, isError: false }, 1, 4),
  ])
  const tools = snapshot.turns.flatMap(turn => turn.groups.flatMap(group => group.cells)).filter(cell => cell.callId === 'image-1')
  expect(tools).toHaveLength(1)
  expect(tools[0]).toMatchObject({ step: 4, status: 'completed', sourceEventSeqs: [2, 3, 5, 6] })
})
```

- [ ] **Step 2: Run the trajectory test and verify RED**

Run:

```bash
pnpm exec vitest run lib/ai/agent-trajectory.test.ts
```

Expected: FAIL with two projected tool cells, one in Message and one in Step 4.

- [ ] **Step 3: Implement projection-only coalescing**

Key the canonical tool map by `${turn}:${callId}`. When an explicit-Step event finds a prior null-Step tool, remove the same object from the Message group, update its `step`, `recordId`, and placement, and merge source sequences, input, output, timing, and status. A later null-Step event must enrich but never move an explicitly stepped tool back to Message. Do not mutate or filter the input event list.

- [ ] **Step 4: Run the trajectory test and verify GREEN**

Run the same file from Step 2. Expected: all projection, partial, error, and cursor-merge tests pass.

- [ ] **Step 5: Commit trajectory coalescing**

```bash
git add web/lib/ai/agent-trajectory.ts web/lib/ai/agent-trajectory.test.ts
git commit -m "fix: coalesce duplicate tool trajectory events"
```

---

### Task 6: Focused Regression and Handoff

**Files:**
- Modify only if verification exposes a scoped defect in a file already listed above.

**Interfaces:**
- Consumes all outputs from Tasks 1–5.
- Produces fresh focused test, lint, and diff evidence for the feature branch.

- [ ] **Step 1: Run the complete focused frontend regression**

Run from `web`:

```bash
pnpm exec vitest run lib/ai/agent-runtime.test.ts lib/ai/daily-creation-agent-job.test.ts lib/ai/daily-creation-agent-integration.test.ts lib/ai/skill-pipeline-job.test.ts lib/ai/pipeline-resolver.test.ts lib/ai/agent-trajectory.test.ts lib/api/chat.test.ts app/api/chat/route.test.ts components/features/chat/ChatWorkspaceProvider.test.tsx components/features/chat/chat-workspace-state.test.ts components/features/chat/ChatMessageView.test.tsx app/chat/ChatClient.test.tsx
```

Expected: all listed files pass with zero failed tests.

- [ ] **Step 2: Run scoped lint and TypeScript checks**

Run from `web` using the repository's existing scripts. Record unrelated baseline failures separately; no new diagnostic may point to a changed file.

```bash
pnpm exec eslint lib/ai/agent-goal-completion.ts lib/ai/agent-runtime.ts lib/ai/daily-creation-agent-job.ts lib/ai/skill-pipeline-job.ts lib/ai/pipeline-resolver.ts lib/ai/agent-trajectory.ts lib/api/chat.ts app/api/chat/route.ts components/features/chat/ChatWorkspaceProvider.tsx components/features/chat/chat-workspace-state.ts components/features/chat/ChatMessageView.tsx
pnpm exec tsc --noEmit
```

- [ ] **Step 3: Inspect branch scope and forbidden completion logic**

Run from the worktree root:

```bash
git diff --check develop...HEAD
git diff --stat develop...HEAD
rg -n "draftCountFromPrompt|requiredDraftCount|required drafts|produced no persisted drafts" web/lib/ai
git status --short --branch
```

Expected: clean diff check; no forbidden quantity-completion implementation remains; only scoped files and commits are present.

- [ ] **Step 4: Commit any verification-only scoped correction**

If Step 1 or 2 required a correction, stage only the already listed files and commit:

```bash
git commit -m "test: cover agent harness completion corrections"
```

If no correction was required, create no empty commit.
