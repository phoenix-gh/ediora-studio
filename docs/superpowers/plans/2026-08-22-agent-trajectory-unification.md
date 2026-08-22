# Agent Trajectory Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Chat and Job Agent traces use one typed session-event source and one turn/step/tool trajectory projection with incremental Dialog updates.

**Architecture:** Reuse `agent_log_events` as the durable append-only store, but validate new Agent events against a canonical event contract and expose a scoped trajectory read API. The frontend folds canonical events into stable Turn/Message/Step/Tool cells; Chat and Job retain their separate business lifecycle views and only provide the trajectory scope. Existing generic events remain readable through a legacy adapter.

**Tech Stack:** FastAPI, SQLAlchemy async, Pydantic v2, Next.js 16, React 19, AI SDK 7 `streamText.onChunk`, Vitest, pytest.

**Spec:** `docs/superpowers/specs/2026-08-22-agent-trajectory-design.md`

## Global Constraints

- `agent_log_events` remains the single physical append-only store for new Agent session events; do not add a parallel event table.
- Canonical event persistence failures must not be silently swallowed; compatibility audit writes may remain best-effort.
- `ContentJob`/`ContentJobStep` business lifecycle and `AgentExecution` recovery/idempotency state remain separate from Agent trajectory cells.
- The normal trajectory ledger must not render raw JSON by default or expose hidden request data without the existing redaction/developer-mode boundary.
- Polling runs only while the Dialog is open and merges by stable sequence/record identity.
- Use focused frontend Vitest and backend pytest commands; do not run full repository suites.

## File Map

- Create `web/lib/ai/agent-trajectory.ts`: canonical TypeScript event types, event normalization, incremental event merge, and pure Turn/Step/Message/Tool projection.
- Create `web/lib/ai/agent-trajectory.test.ts`: pure projection and stable-identity tests.
- Create `backend/agent_trajectory.py`: Pydantic validation, canonical event construction, legacy adaptation, and scoped running/error derivation.
- Modify `backend/agent_log_service.py`: canonical append/list/payload helpers while preserving legacy helpers.
- Modify `backend/routers/agent_logs.py`: canonical event validation on ingestion and scoped `/trajectory` read endpoint.
- Modify `backend/routers/chat.py`: derive `is_running` from canonical trajectory state with legacy fallback.
- Create `backend/tests/test_agent_trajectory.py`: canonical validation, adapter, cursor, pairing, and running-state tests.
- Modify `web/lib/ai/agent-log-client.ts`: canonical event input and scoped trajectory client types/functions.
- Modify `web/lib/ai/agent-runtime-types.ts` and `web/lib/ai/agent-runtime.ts`: attach model step identity and tool audit step identity.
- Modify `web/app/api/chat/route.ts`: emit canonical turn/step/user/assistant/chunk/tool events and typed terminal reasons.
- Modify `web/lib/ai/content-response-output-job.ts`: emit the same canonical Agent events for Job runs while retaining durable execution records.
- Create `web/components/features/agent/AgentTrajectoryPanel.tsx`: shared polling, keyed projection, ledger, and local inspector.
- Modify `web/app/chat/ChatAgentLogDialog.tsx`: use the shared panel with Chat scope.
- Modify `web/app/creation-rules/JobLogDialog.tsx` and `web/app/creation-rules/CreationRunLog.tsx`: use the shared panel with Job scope.
- Create `web/components/features/agent/AgentTrajectoryPanel.test.tsx`: polling scope, closed-dialog behavior, selection persistence, and rendered projection tests.
- Modify focused existing route/runtime tests where event names or payload contracts change.

### Task 1: Canonical event contract and pure trajectory projection

**Files:**
- Create: `web/lib/ai/agent-trajectory.ts`
- Test: `web/lib/ai/agent-trajectory.test.ts`

**Interfaces:**
- `AgentSessionEvent`: `{ seq, time, type, turn, step, data, legacy? }`.
- `mergeAgentSessionEvents(previous, incoming): AgentSessionEvent[]`.
- `deriveAgentTrajectory(events): AgentTrajectorySnapshot`.
- `trajectoryRecordId(cell): string`.

- [ ] **Step 1: Write failing tests** for:
  - a user message, assistant text/reasoning blocks, a tool-call block, and its tool result folding into one turn with `Message` and `Step 1` groups;
  - a `tool/call` without a result remaining in `runningCalls` with `timeSeconds: null`;
  - raw assistant chunks folding into one partial assistant record and disappearing when `assistant/message` arrives;
  - an error `turn/end` producing `isRunning: false` and `lastError`;
  - incoming events merging by `seq` without duplicating existing rows and preserving record IDs by source sequence/call ID.
- [ ] **Step 2: Run the exact Vitest file and confirm it fails** because the module/functions do not exist.
- [ ] **Step 3: Implement the minimal typed event union and projection** using maps for call/result lookup, stable source/call IDs, and separate `Message`/`Step N` groups.
- [ ] **Step 4: Run the exact Vitest file and confirm all projection tests pass.**
- [ ] **Step 5: Refactor only after green** to keep event parsing, grouping, and cell formatting separate; rerun the same file.

### Task 2: Canonical backend storage and trajectory API

**Files:**
- Create: `backend/agent_trajectory.py`
- Test: `backend/tests/test_agent_trajectory.py`
- Modify: `backend/agent_log_service.py`
- Modify: `backend/routers/agent_logs.py`
- Modify: `backend/routers/chat.py`

**Interfaces:**
- `validate_agent_session_event(event_type, data) -> dict`.
- `append_agent_session_event(db, ..., event_type, data) -> AgentLogEvent`.
- `agent_session_event_payload(event) -> dict`.
- `GET /api/agent-logs/trajectory?session_id=...|job_id=...|execution_id=...` returning `{session_key, events, next_sequence, has_more, is_running, last_error}`.

- [ ] **Step 1: Write failing backend tests** for strict canonical payload validation, session/job/execution scope exclusivity, cursor pagination, tool call/result pairing state, open-turn state, typed error state, and legacy-row adaptation.
- [ ] **Step 2: Run only `test_agent_trajectory.py` and the focused agent-log router tests** and confirm failure from missing validator/API.
- [ ] **Step 3: Implement Pydantic event payload models** for `turn/start`, `turn/end`, `step/start`, `step/end`, `user/message`, `assistant/chunk`, `assistant/message`, `tool/call`, `tool/result`, `request/header`, and `agent/skill`; reject malformed required canonical data while leaving non-canonical historical rows readable.
- [ ] **Step 4: Implement canonical append and response mapping** over `agent_log_events`, preserving redaction and scoped insertion order; make `turn/start` assign the next numeric turn when the caller omits it.
- [ ] **Step 5: Add the scoped trajectory read endpoint** with `after_sequence`, tail pagination, canonical conversion, open-state/error derivation, and legacy fallback.
- [ ] **Step 6: Update Chat session `is_running`** to use the canonical trajectory state first and legacy generic events only for old sessions.
- [ ] **Step 7: Run the focused backend tests and confirm green.**

### Task 3: Emit canonical events from Chat and Job runtimes

**Files:**
- Modify: `web/lib/ai/agent-log-client.ts`
- Modify: `web/lib/ai/agent-runtime-types.ts`
- Modify: `web/lib/ai/agent-runtime.ts`
- Modify: `web/app/api/chat/route.ts`
- Modify: `web/lib/ai/content-response-output-job.ts`
- Modify: focused `web/app/api/chat/route.test.ts`, `web/lib/ai/agent-runtime.test.ts`, and Job runtime tests.

**Interfaces:**
- `appendAgentSessionEvent(input): Promise<AgentSessionEvent>`.
- `listAgentTrajectory(scope, cursor?): Promise<AgentTrajectoryPage>`.
- Model callbacks carry a numeric `step` and tool audits carry their active `step`.

- [ ] **Step 1: Add failing mapping tests** for Chat and Job turn start/end, model request/response to step/assistant events, AI SDK stream chunks to assistant chunks, tool audit to paired tool events, and provider errors to typed terminal reasons.
- [ ] **Step 2: Run the exact changed route/runtime test files and confirm the new canonical assertions fail.**
- [ ] **Step 3: Add the trajectory client and runtime step metadata** while preserving existing compatibility audit helpers.
- [ ] **Step 4: Update Chat** so each request appends canonical `turn/start`, `user/message`, `request/header`, `step/start`, `assistant/chunk`, `assistant/message`, `tool/call`, `tool/result`, `step/end`, and `turn/end`; use `streamText.onChunk` for text/reasoning/tool-input/stream error data and ensure terminal events are attempted in `finally`.
- [ ] **Step 5: Update Job** so Agent runtime callbacks emit the same canonical events scoped to `execution_id`; keep `AgentExecution`, `AgentMessageLog`, and `AgentToolCall` for recovery/idempotency and existing consumers.
- [ ] **Step 6: Run all focused changed frontend tests and confirm green.**

### Task 4: Shared Trajectory panel and Chat/Job integration

**Files:**
- Create: `web/components/features/agent/AgentTrajectoryPanel.tsx`
- Test: `web/components/features/agent/AgentTrajectoryPanel.test.tsx`
- Modify: `web/app/chat/ChatAgentLogDialog.tsx`
- Modify: `web/app/creation-rules/JobLogDialog.tsx`
- Modify: `web/app/creation-rules/CreationRunLog.tsx`

**Interfaces:**
- `AgentTrajectoryPanel({ scope, open, developerModeEnabled, title? })`.
- Scope is exactly one of `{ session_id }`, `{ job_id }`, or `{ execution_id }`.

- [ ] **Step 1: Write failing component tests** for initial load only when open, polling only while open, incremental cursor calls, rendering Turn/Message/Step/Tool hierarchy, inspector selection, partial/running state, and stable row DOM nodes after an append-only refresh.
- [ ] **Step 2: Run the exact component test and confirm failure because the panel does not exist.**
- [ ] **Step 3: Implement the shared panel** with a polling hook, `useMemo` projection, stable `recordId` keys, memoized rows, separate ledger/inspector regions, and explicit legacy event fallback.
- [ ] **Step 4: Replace Chat’s generic event timeline** with the shared panel and preserve the existing open-only Dialog behavior.
- [ ] **Step 5: Replace Job’s Agent tab and creation-run Agent section** with the shared panel while retaining Job overview and business execution timeline tabs.
- [ ] **Step 6: Run focused Chat/Job/dialog/component tests and fix any regressions.**

### Task 5: Verification and handoff

- [ ] **Step 1: Run focused backend pytest files** covering `test_agent_trajectory.py`, `test_agent_logs_router.py`, `test_chat_router.py`, and `test_agent_executions_router.py` with `/home/violet/miniconda3/envs/wems/bin/python -m pytest`.
- [ ] **Step 2: Run focused frontend Vitest files** for the new projection/panel and directly changed Chat/Job/runtime tests with `pnpm exec vitest run <exact files>` from `web`.
- [ ] **Step 3: Run changed-file lint/type checks** using the repository’s existing frontend lint command scoped to changed TypeScript files; do not run the full suite.
- [ ] **Step 4: Audit the final diff** for canonical event writes, no swallowed canonical persistence errors, open-only polling, stable keys, legacy compatibility, and untouched `develop`.
- [ ] **Step 5: Commit the implementation in logical commits and report exact test evidence.**
