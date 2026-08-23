# Agent Goal Evidence and Chat Trajectory Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make durable goal-completion evidence actionable and prevent completed multi-turn Chat trajectories from stopping after the first event page.

**Architecture:** Keep exact provider tool-call IDs as the authority for `tool_call` evidence, document that contract in the control-tool schema and instructions, and return the available successful IDs when validation fails. Treat model-response logging as best-effort by safely reading AI SDK getters. In the trajectory panel, separate historical pagination state from live-run state: drain every page while `has_more` is true, then poll only while the session is running.

**Tech Stack:** TypeScript, Next.js, React, AI SDK 7, Zod, Vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-23-ediora-skill-pipeline-design.md`

## Global Constraints

- Do not accept tool names, business IDs, or comma-separated IDs as `tool_call` evidence.
- One `tool_call` evidence item references one exact provider-generated `toolCallId`.
- Artifact evidence remains unchanged in this correction.
- Observability failures must not turn successful Agent work into a failed Job.
- Chat trajectory events remain append-only and scoped by the existing session ID.
- Historical pagination must finish even when the full session is no longer running.
- Preserve existing data and unrelated worktree changes.

---

### Task 1: Clarify and Diagnose Goal Evidence References

**Files:**
- Modify: `web/lib/ai/agent-goal-completion.ts`
- Create: `web/lib/ai/agent-goal-completion.test.ts`

**Interfaces:**
- Consumes: `AgentGoalCompletionDeclaration` and `GoalEvidenceToolCall[]`.
- Produces: exact evidence instructions and a validation error that lists successful `toolCallId (toolName)` choices.

- [x] **Step 1: Write a failing evidence-validation test**

Add a test that passes `get_creative_asset` as a `tool_call` evidence ID while the successful call is `call_asset_1`. Assert that validation rejects the tool name and includes `call_asset_1 (get_creative_asset)` in the error. The production change that makes this test pass is an actionable validator error rather than an opaque rejection.

- [x] **Step 2: Run the test and verify RED**

Run from `web`:

```bash
pnpm exec vitest run lib/ai/agent-goal-completion.test.ts
```

Expected: FAIL because the current error omits the valid call catalog.

- [x] **Step 3: Implement the minimal evidence contract**

Describe `evidence[].id` as one exact provider-generated `toolCallId`, add the same rule to durable completion instructions, and format successful calls as `call_id (tool_name)` in the rejection. Keep exact ID matching and exclude `complete_goal` itself.

- [x] **Step 4: Run the test and verify GREEN**

Run the same command and expect PASS.

---

### Task 2: Keep Missing Structured Output Out of Job Failure

**Files:**
- Modify: `web/lib/ai/agent-runtime.ts`
- Modify: `web/lib/ai/agent-runtime.test.ts`

**Interfaces:**
- Consumes: an AI SDK model result whose `output` getter may throw `NoOutputGeneratedError`.
- Produces: a successful `AgentRunResult` and best-effort model-response log without an `output` field.

- [x] **Step 1: Write a failing runtime regression test**

Return a successful `complete_goal` tool result from the fake generator and define `output` as a getter that throws `No output generated`. Assert that `runtime.run()` resolves with the accepted completion declaration and does not emit `model_error`. The production change that makes this test pass is safe response-field access.

- [x] **Step 2: Run the test and verify RED**

Run:

```bash
pnpm exec vitest run lib/ai/agent-runtime.test.ts
```

Expected: FAIL with `No output generated` from `modelResponsePayload`.

- [x] **Step 3: Implement safe model-response field reads**

Read each optional response field through a helper that catches throwing getters and returns `undefined`; keep existing JSON-safe conversion and message logging behavior for fields that are available.

- [x] **Step 4: Run the test and verify GREEN**

Run the same command and expect PASS.

---

### Task 3: Drain Completed Multi-Turn Chat Trajectory Pages

**Files:**
- Modify: `web/components/features/agent/AgentTrajectoryPanel.tsx`
- Modify: `web/components/features/agent/AgentTrajectoryPanel.test.tsx`

**Interfaces:**
- Consumes: `AgentTrajectoryPage.has_more`, `next_sequence`, and `is_running`.
- Produces: merged Turn 1 and Turn 2+ cells across pages, with continued live polling only after historical pages are exhausted.

- [x] **Step 1: Write a failing pagination regression test**

Mock page one as completed with `has_more: true` and only Turn 1, then page two as completed with `has_more: false` and Turn 2. Advance the refresh timer and assert both turns render and the second request uses page one's cursor. The production change that makes this test pass is separating `has_more` from `is_running` in refresh scheduling.

- [x] **Step 2: Run the test and verify RED**

Run:

```bash
pnpm exec vitest run components/features/agent/AgentTrajectoryPanel.test.tsx
```

Expected: FAIL because the panel stops after the completed first page.

- [x] **Step 3: Implement the minimal pagination state machine**

Track `has_more` in a ref, reset it when the scope opens, update it on every page, and schedule another fetch while either more historical pages exist or the trajectory is running. Preserve cursor merging, close cleanup, unsupported-format handling, and the existing two-second refresh interval.

- [x] **Step 4: Run the test and verify GREEN**

Run the same command and expect PASS.

---

### Task 4: Focused Regression and Commit

**Files:**
- Verify all files modified in Tasks 1–3.

- [ ] **Step 1: Run focused tests**

```bash
pnpm exec vitest run lib/ai/agent-goal-completion.test.ts lib/ai/agent-runtime.test.ts components/features/agent/AgentTrajectoryPanel.test.tsx
```

- [ ] **Step 2: Run targeted lint and diff checks**

```bash
pnpm exec eslint lib/ai/agent-goal-completion.ts lib/ai/agent-goal-completion.test.ts lib/ai/agent-runtime.ts lib/ai/agent-runtime.test.ts components/features/agent/AgentTrajectoryPanel.tsx components/features/agent/AgentTrajectoryPanel.test.tsx
git diff --check
```

- [ ] **Step 3: Review branch scope and commit**

```bash
git diff --stat
git status --short
git add docs/superpowers/plans/2026-08-23-agent-goal-evidence-and-chat-trajectory-pagination.md web/lib/ai/agent-goal-completion.ts web/lib/ai/agent-goal-completion.test.ts web/lib/ai/agent-runtime.ts web/lib/ai/agent-runtime.test.ts web/components/features/agent/AgentTrajectoryPanel.tsx web/components/features/agent/AgentTrajectoryPanel.test.tsx
git commit -m "fix: preserve goal completion and multi-turn traces"
```
