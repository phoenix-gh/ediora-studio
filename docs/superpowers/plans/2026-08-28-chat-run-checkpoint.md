# Durable Chat Run Checkpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Chat approvals resume the exact persisted Agent run, preserving the selected Skill, validated plan, capability contracts, tool-call/results, and created artifacts across refreshes and service restarts.

**Architecture:** PostgreSQL owns canonical `ChatRun`, step, and tool-call state; a Web-side orchestrator starts or resumes a run and projects it into one assistant message. New turns may select and plan once, while approval turns load frozen state and enter an execution-only runtime path. Provider history is rebuilt only from checkpoint rows and is rejected locally unless every non-pending tool call has exactly one result.

**Tech Stack:** FastAPI, SQLAlchemy async ORM, PostgreSQL, Next.js 16 route handlers, TypeScript, AI SDK 7, React 19, Vitest, pytest.

**Spec:** [2026-08-28-chat-run-checkpoint-design.md](../specs/2026-08-28-chat-run-checkpoint-design.md)

## Global Constraints

- Do not reconstruct executable state from `chat_messages.parts`, Agent logs, or HTTP audit logs.
- Only a new user message may select a Skill or produce a plan. Approval handling must not call either path.
- Persist a tool call before exposing its approval button; persist its result before continuing the model.
- Never automatically replay a side-effecting call whose outcome is unknown.
- Treat a persisted artifact as successful even if later model finalization or Chat projection fails.
- Keep legacy pending approvals visible but disabled; do not synthesize checkpoints for them.
- Run focused tests from `web/` with `pnpm exec vitest run <files>`. Do not use `pnpm test -- <file>`.
- Preserve unrelated dirty-worktree changes and the known baseline TypeScript failures documented outside this feature.

---

## Task 1: Add the durable checkpoint schema and idempotent migration

**Files:**

- Modify: `backend/models.py`
- Modify: `backend/database.py`
- Modify: `backend/tests/test_database_init_postgres.py`
- Create: `backend/tests/test_database_chat_run_migration.py`

**Interfaces:**

```python
class ChatRun(Base): ...
class ChatRunStep(Base): ...
class ChatRunToolCall(Base): ...

async def migrate_chat_run_checkpoint_schema(conn) -> None: ...
```

- [ ] Write a failing PostgreSQL migration test that runs `init_db()` twice and asserts the three tables, `chat_messages.run_id`, foreign keys, unique `(run_id, ordinal)`, unique `(run_id, tool_call_id)`, and unique non-null `approval_id`.

- [ ] Add a repair test that drops `chat_messages.run_id` and one checkpoint index, reruns `init_db()`, and verifies both are restored without changing existing Chat rows.

- [ ] Run the red tests:

```bash
pytest -q backend/tests/test_database_chat_run_migration.py backend/tests/test_database_init_postgres.py -k 'chat_run or capability_snapshot'
```

- [ ] Define ORM models using UUID strings for run identity, integer step IDs, JSON payloads, timezone-aware timestamps, and explicit status strings. Add nullable `run_id` to `ChatMessage`.

```python
class ChatRun(Base):
    __tablename__ = "chat_runs"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    session_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    user_message_id: Mapped[int] = mapped_column(Integer, nullable=False)
    assistant_message_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    objective: Mapped[str] = mapped_column(Text, nullable=False)
    skill_invocation: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    validated_plan: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    capability_snapshot: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    current_step: Mapped[int] = mapped_column(Integer, default=0)
    checkpoint_version: Mapped[int] = mapped_column(Integer, default=0)
    error_data: Mapped[dict | None] = mapped_column(JSON, nullable=True)
```

- [ ] Add `ChatRunStep` and `ChatRunToolCall` with the status, approval, policy, digest, idempotency, output/error, usage, and lease fields defined by the spec. Add database checks or service validation so only declared states are stored.

- [ ] Implement `migrate_chat_run_checkpoint_schema()` using the repository's idempotent migration helpers, call it after `Base.metadata.create_all`, and include `run_id` in `_add_columns(..., "chat_messages", ...)`.

- [ ] Run the tests twice to prove idempotency:

```bash
pytest -q backend/tests/test_database_chat_run_migration.py backend/tests/test_database_init_postgres.py -k 'chat_run or capability_snapshot'
pytest -q backend/tests/test_database_chat_run_migration.py
```

- [ ] Commit:

```bash
git add backend/models.py backend/database.py backend/tests/test_database_init_postgres.py backend/tests/test_database_chat_run_migration.py
git commit -m "feat: add durable chat run checkpoint schema"
```

## Task 2: Implement the backend checkpoint state machine

**Files:**

- Create: `backend/services/chat_runs.py`
- Create: `backend/tests/test_chat_run_service.py`

**Interfaces:**

```python
class ChatRunConflict(Exception): ...
class ChatRunNeedsReconciliation(Exception): ...

async def create_run(..., db: AsyncSession) -> ChatRun: ...
async def freeze_preparation(run_id: str, *, skill_invocation: dict | None,
                             validated_plan: dict | None,
                             capability_snapshot: dict,
                             expected_version: int, db: AsyncSession) -> ChatRun: ...
async def append_step(run_id: str, *, assistant_content: list[dict],
                      tool_calls: list[dict], expected_version: int,
                      db: AsyncSession) -> ChatRunStep: ...
async def decide_approval(run_id: str, *, session_id: int, approval_id: str,
                          tool_call_id: str, approved: bool, reason: str | None,
                          db: AsyncSession) -> ApprovalDecisionResult: ...
async def complete_tool_call(..., db: AsyncSession) -> ChatRunToolCall: ...
async def load_checkpoint(run_id: str, *, session_id: int,
                          db: AsyncSession) -> ChatRunCheckpoint: ...
async def transition_run(..., db: AsyncSession) -> ChatRun: ...
```

- [ ] Write failing service tests for valid lifecycle transitions, one pending approval per run, approval identity/session matching, rejection termination, and terminal-state immutability.

- [ ] Add concurrency/idempotency tests: two identical approvals yield one recorded decision; opposite decisions conflict; stale `checkpoint_version` cannot enter `executing`; a second `complete_tool_call` returns the recorded result.

- [ ] Add failure-policy tests: replayable read may return to `running`; claim-backed write preserves its idempotency key; ambiguous write becomes `outcome_unknown` and moves the run to `needs_reconciliation`.

- [ ] Run the red tests:

```bash
pytest -q backend/tests/test_chat_run_service.py
```

- [ ] Implement typed dataclasses/Pydantic result objects for checkpoints and decisions. Keep all compare-and-swap transitions inside one transaction using `SELECT ... FOR UPDATE` plus `checkpoint_version` verification.

```python
@dataclass(frozen=True)
class ApprovalDecisionResult:
    run_id: str
    tool_call_id: str
    decision: Literal["approved", "rejected"]
    duplicate: bool
    run_status: str
    checkpoint_version: int
```

- [ ] Make `append_step()` atomically create the step and its tool calls, then transition to `waiting_approval` only after the pending call is durable.

- [ ] Make rejection persist a provider-compatible denied result and transition the run to `completed` without opening an execution lease.

- [ ] Run:

```bash
pytest -q backend/tests/test_chat_run_service.py
```

- [ ] Commit:

```bash
git add backend/services/chat_runs.py backend/tests/test_chat_run_service.py
git commit -m "feat: add chat run checkpoint state machine"
```

## Task 3: Expose server-internal Chat Run persistence endpoints

**Files:**

- Modify: `backend/routers/chat.py`
- Modify: `backend/tests/test_chat_router.py`

**Interfaces:**

```text
POST /api/chat/sessions/{session_id}/runs
PUT  /api/chat/sessions/{session_id}/runs/{run_id}/preparation
POST /api/chat/sessions/{session_id}/runs/{run_id}/steps
POST /api/chat/sessions/{session_id}/runs/{run_id}/approvals/{approval_id}
PUT  /api/chat/sessions/{session_id}/runs/{run_id}/tool-calls/{tool_call_id}/result
PATCH /api/chat/sessions/{session_id}/runs/{run_id}/status
GET  /api/chat/sessions/{session_id}/runs/{run_id}
```

```python
class ChatRunCreate(BaseModel):
    user_message_id: int
    objective: str

class ChatRunApprovalDecision(BaseModel):
    tool_call_id: str
    approved: bool
    reason: str | None = None
```

- [ ] Add failing router tests that cover create/freeze/load, append step, approval and result persistence, session ownership, missing worker token, stale version (`409`), legacy/missing run (`409`), and invalid transitions (`422`).

- [ ] Add a projection-link test showing that an assistant message may be patched with `run_id`, and that `ChatMessageOut` returns `run_id` without altering historical messages.

- [ ] Run the red tests:

```bash
pytest -q backend/tests/test_chat_router.py -k 'chat_run or run_id or approval'
```

- [ ] Add strict Pydantic request/response models with `extra="forbid"`, maximum payload sizes, declared status literals, and worker-token protection matching existing internal Chat mutations.

- [ ] Delegate every transition to `backend/services/chat_runs.py`; the router must not duplicate state rules or accept client-supplied tool inputs during approval.

- [ ] Run:

```bash
pytest -q backend/tests/test_chat_router.py backend/tests/test_chat_run_service.py
```

- [ ] Commit:

```bash
git add backend/routers/chat.py backend/tests/test_chat_router.py
git commit -m "feat: expose internal chat run checkpoint api"
```

## Task 4: Add the Web checkpoint client and canonical history validator

**Files:**

- Create: `web/lib/ai/chat-run-types.ts`
- Create: `web/lib/ai/chat-run-history.ts`
- Create: `web/lib/ai/chat-run-history.test.ts`
- Create: `web/lib/api/chat-runs.ts`
- Create: `web/lib/api/chat-runs.test.ts`
- Modify: `web/lib/api/chat.ts`
- Modify: `web/lib/api/chat.test.ts`

**Interfaces:**

```ts
export type ChatRunCheckpoint = {
  id: string
  sessionId: number
  status: ChatRunStatus
  objective: string
  skillInvocation?: FrozenSkillInvocation
  validatedPlan?: SkillRunPlan
  capabilitySnapshot?: AgentCapabilitySnapshot
  checkpointVersion: number
  steps: ChatRunStepCheckpoint[]
}

export function buildCanonicalModelMessages(
  checkpoint: ChatRunCheckpoint,
): ModelMessage[]

export function validateCanonicalToolHistory(
  checkpoint: ChatRunCheckpoint,
): void
```

- [ ] Write failing history tests for exact call/result pairing, duplicate IDs, orphaned results, succeeded-as-pending, rejected-call synthetic result, reasoning attachment, and the session-107 sequence with two `save_draft` calls and two distinct results.

- [ ] Add a failing DeepSeek regression asserting that the reconstructed assistant message retains reasoning beside its tool call and is accepted by the current provider serializer.

- [ ] Run the red tests:

```bash
cd web && pnpm exec vitest run lib/ai/chat-run-history.test.ts lib/ai/deepseek-reasoning-compat.test.ts
```

- [ ] Implement provider-neutral checkpoint types and a validator that throws `ChatRunHistoryError` before any provider request. Permit one missing result only for the current pending call while the run is `waiting_approval`.

```ts
export class ChatRunHistoryError extends Error {
  constructor(readonly code: 'duplicate_tool_call' | 'orphan_result' |
    'missing_result' | 'invalid_pending_call', message: string) {
    super(message)
  }
}
```

- [ ] Implement the internal backend client with worker-token forwarding and typed `409` conflict handling. Change browser approval input to `{sessionId, runId, approvalId, toolCallId, approved, reason?}` and remove `messageId` as execution identity.

- [ ] Run:

```bash
cd web && pnpm exec vitest run lib/ai/chat-run-history.test.ts lib/api/chat-runs.test.ts lib/api/chat.test.ts lib/ai/deepseek-reasoning-compat.test.ts
```

- [ ] Commit:

```bash
git add web/lib/ai/chat-run-types.ts web/lib/ai/chat-run-history.ts web/lib/ai/chat-run-history.test.ts web/lib/api/chat-runs.ts web/lib/api/chat-runs.test.ts web/lib/api/chat.ts web/lib/api/chat.test.ts
git commit -m "feat: add canonical chat run checkpoint client"
```

## Task 5: Split Skill preparation from prepared execution

**Files:**

- Modify: `web/lib/ai/skill-run-ai-sdk.ts`
- Modify: `web/lib/ai/skill-run-ai-sdk.test.ts`
- Modify: `web/lib/ai/agent-runtime.ts`
- Modify: `web/lib/ai/agent-runtime.test.ts`

**Interfaces:**

```ts
export type PreparedSkillRun = {
  skill: FrozenSkillIdentity
  activation: SkillRunActivation
  plan: SkillRunPlan
  loadedReferences: SkillReferenceContent[]
  capabilitySnapshot: AgentCapabilitySnapshot
  executionPrompt: string
}

export type AgentPreparedRun = {
  selectedSkill?: AgentSelectedSkill
  skillRun?: PreparedSkillRun
  capabilitySnapshot: AgentCapabilitySnapshot
}

prepareRun(request: AgentPrepareRequest): Promise<AgentPreparedRun>
executePrepared(request: AgentExecutePreparedRequest): Promise<AgentRunResult>
```

- [ ] Write failing tests proving `prepareRun()` selects/plans once and returns serializable frozen state, while `executePrepared()` accepts that state without invoking selection, planning, or arbitrary reference loading.

- [ ] Add an approval-resume test with spies that fail if `selectSkillForTurn`, planner generation, or Skill activation is called after the checkpoint is loaded.

- [ ] Add contract-drift tests: missing tool, version mismatch, digest mismatch, and changed Skill digest fail before tool/model execution.

- [ ] Run the red tests:

```bash
cd web && pnpm exec vitest run lib/ai/skill-run-ai-sdk.test.ts lib/ai/agent-runtime.test.ts
```

- [ ] Extract planning from `executeSkillRunWithAiSdk()` into `prepareSkillRunWithAiSdk()` and let `executePreparedSkillRunWithAiSdk()` receive the sanitized plan, loaded references, execution prompt, and frozen required tools.

- [ ] Extend `AgentRuntime` with `prepareRun()` and `executePrepared()`. Keep `run()` as a temporary compatibility wrapper that calls both for non-Chat callers; mark it unsuitable for approval recovery in its doc comment.

- [ ] Resolve executable tools from the current registry by frozen name/version/digest; never deserialize executable functions from the database.

- [ ] Ensure a prepared execution can stop at approval and return the canonical assistant content/tool calls needed by the orchestrator, without losing `finishReason`, reasoning, or usage.

- [ ] Run:

```bash
cd web && pnpm exec vitest run lib/ai/skill-run-ai-sdk.test.ts lib/ai/agent-runtime.test.ts lib/ai/chat-run-history.test.ts
```

- [ ] Commit:

```bash
git add web/lib/ai/skill-run-ai-sdk.ts web/lib/ai/skill-run-ai-sdk.test.ts web/lib/ai/agent-runtime.ts web/lib/ai/agent-runtime.test.ts
git commit -m "refactor: split agent preparation from execution"
```

## Task 6: Implement the Chat Run orchestrator and projection

**Files:**

- Create: `web/lib/ai/chat-run-orchestrator.ts`
- Create: `web/lib/ai/chat-run-orchestrator.test.ts`
- Create: `web/lib/ai/chat-run-projector.ts`
- Create: `web/lib/ai/chat-run-projector.test.ts`

**Interfaces:**

```ts
export type ChatRunOrchestrator = {
  startRun(input: StartChatRunInput): Promise<ChatRunProjection>
  resumeRun(input: ResumeChatRunInput): Promise<ChatRunProjection>
  projectRun(runId: string): Promise<ChatRunProjection>
}

export function createChatRunOrchestrator(
  dependencies: ChatRunOrchestratorDependencies,
): ChatRunOrchestrator
```

- [ ] Write failing orchestration tests for: manual Skill freeze; automatic Skill selected once; initial pending approval; approved resume; rejected resume without tool/model call; repeated approval idempotency; and next approval within the same run.

- [ ] Add restart tests by constructing a second orchestrator instance over the same mocked persistence store. Verify the second instance loads the frozen plan and completes without relying on in-memory state.

- [ ] Add side-effect tests: result persistence occurs before the next provider call; `outcome_unknown` does not replay; contract drift enters reconciliation; a successful draft artifact survives a later finalization error.

- [ ] Run the red tests:

```bash
cd web && pnpm exec vitest run lib/ai/chat-run-orchestrator.test.ts lib/ai/chat-run-projector.test.ts
```

- [ ] Implement `startRun()` in this order: create run, prepare, freeze, execute prepared state, append checkpoint step/tool calls, then project.

- [ ] Implement `resumeRun()` in this order: load/decide approval, short-circuit duplicate or rejection, verify frozen contracts, execute exactly the stored call, persist its result, validate/rebuild history, continue prepared execution, then project.

- [ ] Implement one assistant projection per run. Add `data-chat-run`, `data-chat-run-status`, and `data-artifact` parts without making them executable state.

```ts
export type PersistedArtifact = {
  kind: 'draft'
  id: number
  title?: string
  url: string
}
```

- [ ] When continuation fails after a successful write, project both the artifact and a concise continuation error; never rewrite the artifact as failed.

- [ ] Run:

```bash
cd web && pnpm exec vitest run lib/ai/chat-run-orchestrator.test.ts lib/ai/chat-run-projector.test.ts lib/ai/chat-run-history.test.ts
```

- [ ] Commit:

```bash
git add web/lib/ai/chat-run-orchestrator.ts web/lib/ai/chat-run-orchestrator.test.ts web/lib/ai/chat-run-projector.ts web/lib/ai/chat-run-projector.test.ts
git commit -m "feat: orchestrate durable chat runs"
```

## Task 7: Route new turns and approvals through Chat Runs

**Files:**

- Modify: `web/app/api/chat/route.ts`
- Modify: `web/app/api/chat/route.test.ts`
- Modify: `web/app/api/chat/route.integration.test.ts`
- Modify: `web/lib/ai/chat-tools.ts`
- Modify: `web/lib/ai/chat-tools.test.ts`

**Interfaces:**

```ts
type ChatRouteRequest = NewTurnRequest | ApprovalResumeRequest

type ApprovalResumeRequest = {
  sessionId: number
  approval: {
    runId: string
    approvalId: string
    toolCallId: string
    approved: boolean
    reason?: string
  }
}
```

- [ ] Add a failing route regression that reproduces session 107: direct `writing-plan`, first `save_draft` returns `saved:false`, second approval saves, and final provider history contains both calls and both results without switching to `human-social-copy`.

- [ ] Add failing tests that approval payloads cannot contain/override Skill name, plan, tool input, capability snapshot, or model messages; cross-session and legacy approvals return actionable `409` responses.

- [ ] Add a failure regression showing a saved artifact response is returned even when the next model call throws the provider error formerly surfaced as `Chat response failed`.

- [ ] Run the red tests:

```bash
cd web && pnpm exec vitest run app/api/chat/route.test.ts app/api/chat/route.integration.test.ts
```

- [ ] Replace the approval branch's `persistApproval` + `modelHistoryCandidates` + `runtime.run()` recovery with `orchestrator.resumeRun()`.

- [ ] Route only genuine user turns to `orchestrator.startRun()`. Preserve existing stream format by streaming projector output, but include durable `runId` on approval and status parts.

- [ ] Restrict `modelHistoryCandidates()` to ordinary prior-conversation context; add a guard/comment that it cannot create approval-resume history.

- [ ] Ensure route errors distinguish persistence conflict, reconciliation required, provider failure after artifact success, and generic failure.

- [ ] Run:

```bash
cd web && pnpm exec vitest run app/api/chat/route.test.ts app/api/chat/route.integration.test.ts lib/ai/chat-tools.test.ts lib/ai/deepseek-reasoning-compat.test.ts
```

- [ ] Commit:

```bash
git add web/app/api/chat/route.ts web/app/api/chat/route.test.ts web/app/api/chat/route.integration.test.ts web/lib/ai/chat-tools.ts web/lib/ai/chat-tools.test.ts
git commit -m "fix: resume chat approvals from checkpoints"
```

## Task 8: Make approval and artifact state unambiguous in the UI

**Files:**

- Modify: `web/components/features/chat/chat-workspace-types.ts`
- Modify: `web/components/features/chat/chat-workspace-state.ts`
- Modify: `web/components/features/chat/chat-workspace-state.test.ts`
- Modify: `web/components/features/chat/ChatWorkspaceProvider.tsx`
- Modify: `web/components/features/chat/ChatWorkspaceProvider.test.tsx`
- Modify: `web/components/features/chat/ChatMessageView.tsx`
- Modify: `web/components/features/chat/ChatMessageView.test.tsx`
- Create: `web/lib/events/draft-artifacts.ts`
- Create: `web/lib/events/draft-artifacts.test.ts`
- Modify: `web/app/drafts/DraftsClient.tsx`
- Modify: `web/app/drafts/DraftsClient.test.tsx`

**Interfaces:**

```ts
export type ChatApprovalArgs = {
  sessionId: number
  runId: string
  toolCallId: string
  approvalId: string
  approved: boolean
  reason?: string
}

export const DRAFT_ARTIFACT_EVENT = 'ediora:draft-artifact-created'
export function publishDraftArtifact(artifact: PersistedArtifact): void
export function subscribeToDraftArtifacts(
  listener: (artifact: PersistedArtifact) => void,
): () => void
```

- [ ] Write failing UI tests: buttons disappear immediately after decision; duplicate clicks submit once; the same assistant projection is patched; legacy approvals without `runId` are disabled with “该任务需要重新开始”; and a draft artifact card links to `/drafts?draft=<id>`.

- [ ] Write failing Drafts tests proving same-window and `BroadcastChannel` notifications reload page one, add the new draft, retain the selected draft, and do not replace dirty editor title/content.

- [ ] Run the red tests:

```bash
cd web && pnpm exec vitest run components/features/chat/chat-workspace-state.test.ts components/features/chat/ChatWorkspaceProvider.test.tsx components/features/chat/ChatMessageView.test.tsx app/drafts/DraftsClient.test.tsx lib/events/draft-artifacts.test.ts
```

- [ ] Remove `approvalResumeMessage()` and stop appending a synthetic assistant message on approval. Optimistically mark the matching tool part decided, submit the durable identifiers, then replace/patch from the server projection.

- [ ] Render persisted approval states (`approved`, `rejected`, `executing`, result) rather than keeping active buttons. On errors, restore buttons only when the authoritative checkpoint remains `waiting_approval` and undecided.

- [ ] Add artifact cards to `ChatMessageView` and publish draft notifications when a new artifact part arrives. Deduplicate events by `kind:id`.

- [ ] In `DraftsClient`, merge the refreshed page into server state while holding dirty editor fields in a separate local snapshot; select the artifact only when the user is not actively editing another draft.

- [ ] Run:

```bash
cd web && pnpm exec vitest run components/features/chat/chat-workspace-state.test.ts components/features/chat/ChatWorkspaceProvider.test.tsx components/features/chat/ChatMessageView.test.tsx app/drafts/DraftsClient.test.tsx lib/events/draft-artifacts.test.ts
```

- [ ] Commit:

```bash
git add web/components/features/chat/chat-workspace-types.ts web/components/features/chat/chat-workspace-state.ts web/components/features/chat/chat-workspace-state.test.ts web/components/features/chat/ChatWorkspaceProvider.tsx web/components/features/chat/ChatWorkspaceProvider.test.tsx web/components/features/chat/ChatMessageView.tsx web/components/features/chat/ChatMessageView.test.tsx web/lib/events/draft-artifacts.ts web/lib/events/draft-artifacts.test.ts web/app/drafts/DraftsClient.tsx web/app/drafts/DraftsClient.test.tsx
git commit -m "fix: project durable approval and draft state"
```

## Task 9: Run focused regressions and live restart verification

**Files:**

- Modify only if evidence requires a fix: files from Tasks 1–8
- Create: `docs/superpowers/verification/2026-08-28-chat-run-checkpoint.md`

- [ ] Run the focused backend suite:

```bash
pytest -q backend/tests/test_database_chat_run_migration.py backend/tests/test_database_init_postgres.py backend/tests/test_chat_run_service.py backend/tests/test_chat_router.py
```

- [ ] Run the focused Web suite:

```bash
cd web && pnpm exec vitest run \
  lib/ai/chat-run-history.test.ts \
  lib/api/chat-runs.test.ts \
  lib/ai/skill-run-ai-sdk.test.ts \
  lib/ai/agent-runtime.test.ts \
  lib/ai/chat-run-orchestrator.test.ts \
  lib/ai/chat-run-projector.test.ts \
  app/api/chat/route.test.ts \
  app/api/chat/route.integration.test.ts \
  components/features/chat/chat-workspace-state.test.ts \
  components/features/chat/ChatWorkspaceProvider.test.tsx \
  components/features/chat/ChatMessageView.test.tsx \
  app/drafts/DraftsClient.test.tsx
```

- [ ] Run lint on touched Web files, then run the repository typecheck/build command. Record unrelated baseline failures separately instead of claiming a clean global result.

```bash
cd web && pnpm exec eslint app/api/chat/route.ts lib/ai/chat-run-*.ts lib/api/chat-runs.ts components/features/chat/ChatWorkspaceProvider.tsx components/features/chat/ChatMessageView.tsx app/drafts/DraftsClient.tsx lib/events/draft-artifacts.ts
cd web && pnpm exec tsc --noEmit
```

- [ ] Start the stack with `./dev.sh`, create a manual `writing-plan` Chat run, reach the first approval, stop and restart the stack, then approve. Repeat for the second approval and confirm the Skill identity never changes.

- [ ] Verify persisted evidence with read-only queries: one `chat_runs` row, ordered steps, one row/result per tool call, stable approval decisions, draft business row, assistant `run_id`, and no `outcome_unknown` state.

- [ ] Inspect the raw provider request/response audit and confirm every tool call has one following result and DeepSeek reasoning continuity is preserved. Confirm no provider `insufficient tool messages` error occurred.

- [ ] Verify the browser behavior: decided buttons are gone; the saved draft card opens the exact draft; an already-open Drafts page refreshes without losing dirty editor content.

- [ ] Write exact commands, IDs, observed statuses, screenshots/log references, and any known unrelated failures to `docs/superpowers/verification/2026-08-28-chat-run-checkpoint.md`.

- [ ] Run `git diff --check`, inspect `git status --short`, and review the complete feature diff against the spec.

```bash
git diff --check
git status --short
git diff --stat origin/develop...HEAD
```

- [ ] Commit verification evidence and any evidence-driven fixes:

```bash
git add docs/superpowers/verification/2026-08-28-chat-run-checkpoint.md
git commit -m "test: verify durable chat run recovery"
```

## Completion Gate

- [ ] A manual Skill and its parameter snapshot survive two approvals and a process restart.
- [ ] Each approved side effect executes at most once; ambiguous writes are not replayed.
- [ ] Every provider request passes canonical call/result validation.
- [ ] Rejection is terminal and does not invoke another tool or model call.
- [ ] Successful artifacts remain visible if later generation fails.
- [ ] Approval controls reflect persisted state and legacy approvals cannot mislead users.
- [ ] Focused backend/Web tests pass, and live evidence is recorded before merge or PR creation.
