# Chat Skill Runtime and Stale Session Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make automatic Skill runs execute their validated tool steps reliably and prevent deleted or unavailable Chat sessions from displaying an endless running indicator.

**Architecture:** Keep the existing generic SkillRun pipeline, but pass the validated plan into the execution prompt and preserve step-scoped tool evidence so the model knows exactly what must be executed. Treat a missing Chat session as terminal client state, removing its local running marker and selecting a surviving session instead of retrying forever.

**Tech Stack:** TypeScript, Next.js, AI SDK, Vitest, React Testing Library.

**Spec:** Runtime evidence from Chat session 57 on 2026-08-23: the plan required source tools, the execution model stopped with zero tool calls, the evidence gate blocked the result, and the browser repeatedly polled deleted session 56 with HTTP 404.

## Global Constraints

- Do not weaken evidence validation: a dependency-backed Skill step is complete only after its required evidence exists.
- Do not make `allowed-tools` frontmatter the source of runtime tool availability; use the host tool catalog already passed to the planner.
- Do not mutate `develop`; implementation stays on `fix/chat-skill-runtime`.
- Preserve existing Chat session messages and only clear client-side state for a session confirmed unavailable.
- Run focused frontend tests from `web` with `pnpm exec vitest run`.

---

### Task 1: Make the validated Skill plan visible to execution

**Files:**
- Modify: `web/lib/ai/skill-run-ai-sdk.ts`
- Test: `web/lib/ai/skill-run-ai-sdk.test.ts`

**Interfaces:**
- `executionPrompt` consumes the sanitized plan steps and produces an execution instruction containing each step id, instruction, references, and exact required tool names.
- `executeSkillRunWithAiSdk` passes the sanitized plan to `executionPrompt` without changing the public runtime result shape.

- [ ] **Step 1: Write the failing prompt contract test**

  Capture the prompt passed to `execute` in the existing generic SkillRun test. Assert that it contains the step id, step instruction, and required tool name. The current implementation must fail because the prompt only includes output requirements and verification criteria.

- [ ] **Step 2: Run the focused test and verify the expected failure**

  Run:

  ```bash
  cd web && pnpm exec vitest run lib/ai/skill-run-ai-sdk.test.ts
  ```

  Expected result: the new prompt assertion fails because the execution prompt omits the validated step plan.

- [ ] **Step 3: Implement the smallest prompt change**

  Extend `executionPrompt` to render:

  ```text
  Validated execution plan:
  - step-id: instruction
    required references: ...
    required tools: ...

  Execute steps in order. For every required tool, call the exact named tool and wait for its result before continuing. Do not produce the final deliverable while a required step is incomplete.
  ```

  Pass `plan.steps` from `executeSkillRunWithAiSdk`.

- [ ] **Step 4: Run the focused test and verify it passes**

  Run the same Vitest command and confirm the new test and existing SkillRun tests pass.

- [ ] **Step 5: Commit the isolated change**

  ```bash
  git add web/lib/ai/skill-run-ai-sdk.ts web/lib/ai/skill-run-ai-sdk.test.ts
  git commit -m "fix: expose validated skill plan during execution"
  ```

### Task 2: Preserve step-level dependency evidence

**Files:**
- Modify: `web/lib/ai/skill-run.ts`
- Modify: `web/lib/ai/skill-run-evidence.ts`
- Modify: `web/lib/ai/agent-runtime.ts`
- Test: `web/lib/ai/skill-run-evidence.test.ts`
- Test: `web/lib/ai/agent-runtime.test.ts`

**Interfaces:**
- Tool evidence carries the plan step that produced it.
- Evidence refresh checks a step's own tool evidence rather than a global deduplicated tool-name set.
- Existing audit serialization remains backward-compatible for old runs without `stepId`.

- [ ] **Step 1: Write the failing duplicate-step evidence test**

  Add a plan with two steps that both require `search_assets`. Apply one successful tool result to the first step only and assert that the first step is completed while the second remains pending. The current global evidence lookup must incorrectly complete both or cannot distinguish them.

- [ ] **Step 2: Run the focused evidence test and verify it fails for the expected reason**

  ```bash
  cd web && pnpm exec vitest run lib/ai/skill-run-evidence.test.ts
  ```

- [ ] **Step 3: Implement step-scoped evidence**

  Add an optional `stepId` to `SkillToolEvidence`, retain tool-call identity, and make `applyToolEvidence` associate each dynamic tool part with the current plan step. Avoid globally deduplicating requirements when two steps use the same tool. Update `executionParts`/runtime checkpoints only as needed to carry the plan step without changing the UI tool-part contract.

- [ ] **Step 4: Run evidence and runtime tests**

  ```bash
  cd web && pnpm exec vitest run lib/ai/skill-run-evidence.test.ts lib/ai/agent-runtime.test.ts
  ```

  Confirm duplicate requirements remain independently pending/completed and existing audit tests remain green.

- [ ] **Step 5: Commit the isolated change**

  ```bash
  git add web/lib/ai/skill-run.ts web/lib/ai/skill-run-evidence.ts web/lib/ai/agent-runtime.ts web/lib/ai/skill-run-evidence.test.ts web/lib/ai/agent-runtime.test.ts
  git commit -m "fix: track skill evidence per execution step"
  ```

### Task 3: Clear stale Chat state after a missing session

**Files:**
- Modify: `web/components/features/chat/ChatWorkspaceProvider.tsx`
- Test: `web/components/features/chat/ChatWorkspaceProvider.test.tsx`

**Interfaces:**
- A 404 from `getChatSession` removes the unavailable session from client state, clears its running/loading/error entries, and selects the first surviving session when the unavailable session was active.
- Non-404 failures retain the current error/retry behavior.

- [ ] **Step 1: Write the failing 404 polling test**

  Start a session with `is_running: true`, make the next refresh reject with `ApiError` status 404, advance the polling timer, and assert that the running indicator disappears and the deleted session is no longer active.

- [ ] **Step 2: Run the focused provider test and verify it fails**

  ```bash
  cd web && pnpm exec vitest run components/features/chat/ChatWorkspaceProvider.test.tsx
  ```

- [ ] **Step 3: Implement terminal missing-session cleanup**

  Add a small state helper for forgetting a session. In the running-session refresh catch, detect `ApiError.status === 404`, call the helper, and stop retrying that id. Keep transient errors unchanged.

- [ ] **Step 4: Run the provider test and the related ChatClient tests**

  ```bash
  cd web && pnpm exec vitest run components/features/chat/ChatWorkspaceProvider.test.tsx app/chat/ChatClient.test.tsx
  ```

- [ ] **Step 5: Commit the isolated change**

  ```bash
  git add web/components/features/chat/ChatWorkspaceProvider.tsx web/components/features/chat/ChatWorkspaceProvider.test.tsx
  git commit -m "fix: clear stale chat state after session removal"
  ```

### Task 4: Resolve long-session turn association

**Files:**
- Modify: `backend/agent_log_service.py`
- Test: `backend/tests/test_agent_log_service.py`

**Interfaces:**
- Canonical event persistence resolves missing turn/step values from the current `turn_id`/`step_id` scope, ordered newest-first, instead of the stream's first 500 rows.

- [ ] **Step 1: Write the failing long-stream regression test**

  Append more than 500 events for an old turn, then append a new turn start and turn end. Assert that the new turn end is persisted with the current turn number. The current first-page lookup must produce a missing or stale turn.

- [ ] **Step 2: Run the focused backend test and verify it fails**

  ```bash
  /home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_agent_log_service.py::test_append_canonical_turn_end_resolves_current_turn_after_long_stream -q
  ```

- [ ] **Step 3: Query only the current scope newest-first**

  Add a private query helper filtering by `stream_key` plus `turn_id` or `step_id`, ordered by descending event id. Prefer explicit payload turn/step values before querying the scope.

- [ ] **Step 4: Run the focused backend test and verify it passes**

  Run the same command and confirm one passing test.

- [ ] **Step 5: Commit the isolated change**

  ```bash
  git add backend/agent_log_service.py backend/tests/test_agent_log_service.py
  git commit -m "fix: resolve agent turns within the current log scope"
  ```

### Task 5: Full focused verification and handoff

**Files:**
- Review: all files changed by Tasks 1-3
- Review: `docs/superpowers/plans/2026-08-23-chat-skill-runtime-fix.md`

- [ ] **Step 1: Run the complete affected frontend test set**

  ```bash
  cd web && pnpm exec vitest run lib/ai/skill-run-ai-sdk.test.ts lib/ai/skill-run-evidence.test.ts lib/ai/agent-runtime.test.ts components/features/chat/ChatWorkspaceProvider.test.tsx app/chat/ChatClient.test.tsx
  ```

- [ ] **Step 2: Run TypeScript validation used by the web project**

  Use the repository's existing web typecheck command from `web/package.json` and record its exit status.

- [ ] **Step 3: Review the final diff and branch boundary**

  ```bash
  git diff --check
  git status --short --branch
  git diff develop...HEAD --stat
  git log --oneline develop..HEAD
  ```

- [ ] **Step 4: Report evidence and remaining limitations**

  Include exact test counts, any pre-existing failures, commit names, and the isolated worktree path. Do not claim the live Chat 57 task was re-run unless a new live request is explicitly authorized.
