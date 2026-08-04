# Shared Chat and Background Agent Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run new daily creation jobs through the same tools, Skill selection, references, planning, execution, validation, and revision runtime as Chat, while automatically approving background tools and requiring real persistence evidence for completion.

**Architecture:** Extract Chat's Agent orchestration and global tool construction into reusable modules, then add a durable background adapter backed by Agent execution and tool-call records. New daily runs carry `runtime_version: "agent-v1"`; the Agent owns research, validation, and persistence through an atomic MCP tool, while the worker maps persisted evidence to terminal status.

**Tech Stack:** Next.js 16, TypeScript, AI SDK 7, Zod 4, MCP, FastAPI, SQLAlchemy async, PostgreSQL/SQLite, Redis, Vitest 4, Pytest

## Global Constraints

- Chat and scheduled tasks use one shared Agent runtime and one global tool factory.
- Background tools that require approval in Chat are automatically approved and audited.
- Rules support `skill_mode = "auto" | "manual"`; `auto` is the default and manual mode selects exactly one enabled Skill.
- One Agent run owns task interpretation, research, selection, writing, self-validation, and persistence.
- Only atomic persistence-tool evidence can produce `succeeded` or `partial`; model prose is not completion evidence.
- Every background tool call is checkpointed under `(agent_execution_id, tool_call_id)` and a completed result is replayed instead of executed again.
- An unresolved side-effecting tool call is not blindly repeated after a crash; it becomes explicit uncertain-side-effect evidence unless its application contract is idempotent.
- New runs use `runtime_version: "agent-v1"`; historical jobs retain their original execution format and are not silently migrated mid-run.
- The legacy fixed pipeline is not a fallback for a new Agent run.
- Preserve unrelated dirty-worktree changes and stage only files named in each task.

## File and Responsibility Map

- `wemedia-studio/lib/ai/agent-runtime-types.ts`: shared request, result, audit, and completion contracts.
- `wemedia-studio/lib/ai/agent-tool-policy.ts`: interactive versus automatic approval and audit wrapping.
- `wemedia-studio/lib/ai/agent-runtime.ts`: shared Skill selection and plan/execute/validate/revise orchestration.
- `backend/agent_execution_service.py`: checkpoints, optimistic versioning, and tool-call idempotency.
- `backend/routers/agent_executions.py`: worker-authenticated Agent execution API.
- `backend/daily_creation_service.py`: atomic batch persistence and evidence validation.
- `backend/mcp_server.py`: global `save_daily_creation_outputs` tool.
- `wemedia-studio/lib/ai/daily-creation-agent-job.ts`: background adapter.
- `wemedia-studio/app/daily-plan/CreationRuleDialog.tsx`: Skill configuration.
- `wemedia-studio/app/daily-plan/CreationRunsPanel.tsx`: bounded Agent audit display.

---

### Task 1: Shared Agent Tool Approval and Audit Policy

**Files:**
- Create: `wemedia-studio/lib/ai/agent-runtime-types.ts`
- Create: `wemedia-studio/lib/ai/agent-tool-policy.ts`
- Test: `wemedia-studio/lib/ai/agent-tool-policy.test.ts`
- Modify: `wemedia-studio/lib/ai/global-chat-tools.ts`
- Test: `wemedia-studio/lib/ai/global-chat-tools.test.ts`

**Interfaces:**
- Produces: `AgentApprovalPolicy`, `AgentToolAudit`, and `applyAgentToolPolicy(tools, options): ToolSet`.
- Produces: `openGlobalAgentTools(options)`; retains `openGlobalChatTools` as a compatibility alias through Task 2.
- Consumes: existing `requiresToolApproval(name)` and MCP-discovered `ToolSet`.

- [ ] **Step 1: Write failing approval-policy tests**

```typescript
import { tool } from 'ai'
import { z } from 'zod'
import { applyAgentToolPolicy } from './agent-tool-policy'

it('auto-approves a sensitive tool and records its result', async () => {
  const audits: unknown[] = []
  const tools = applyAgentToolPolicy({
    save_item: tool({
      inputSchema: z.object({ value: z.string() }),
      execute: async ({ value }) => ({ id: 7, value }),
    }),
  }, { policy: 'automatic', onAudit: event => { audits.push(event) } })
  const save = tools.save_item as {
    needsApproval?: boolean
    execute(input: unknown, options: { toolCallId: string }): Promise<unknown>
  }
  expect(save.needsApproval).toBe(false)
  await expect(save.execute({ value: 'x' }, { toolCallId: 'call-1' }))
    .resolves.toEqual({ id: 7, value: 'x' })
  expect(audits).toEqual(expect.arrayContaining([
    expect.objectContaining({
      toolName: 'save_item', toolCallId: 'call-1',
      autoApproved: true, status: 'succeeded',
    }),
  ]))
})
```

Add companion assertions that interactive `save_item` has
`needsApproval: true` and `list_items` never requires approval.

- [ ] **Step 2: Run the focused test and verify RED**

```bash
cd wemedia-studio
pnpm exec vitest run lib/ai/agent-tool-policy.test.ts
```

Expected: FAIL because the shared policy module does not exist.

- [ ] **Step 3: Define the shared contracts**

```typescript
export type AgentApprovalPolicy = 'interactive' | 'automatic'
export type AgentSkillMode = 'auto' | 'manual'
export type AgentToolDecision =
  | { action: 'execute' }
  | { action: 'replay'; output: unknown }
  | { action: 'uncertain'; error: string }
export type AgentToolAudit = {
  toolName: string
  toolCallId: string
  sideEffecting: boolean
  autoApproved: boolean
  status: 'started' | 'succeeded' | 'failed' | 'uncertain'
  inputSummary: unknown
  output?: unknown
  error?: string
  occurredAt: string
}
export type AgentCompletionEvidence = {
  toolName: 'save_daily_creation_outputs'
  toolCallId: string
  runId: number
  createdCount: number
  outputIds: number[]
  usageIds: number[]
}
```

- [ ] **Step 4: Implement policy wrapping**

Preserve every tool's schema and description. Derive `sideEffecting` from the
same sensitive-tool registry used for approval. Set `needsApproval` only for
interactive sensitive tools. Wrap `execute` to emit `started`, followed by
`succeeded` or `failed`; bound serialized inputs, outputs, and errors. Read tools
use `autoApproved: false`; sensitive tools under automatic policy use
`autoApproved: true`. Before calling the underlying `execute`, await optional
`beforeToolExecute(event): Promise<AgentToolDecision>`: return replay output without
execution, throw the uncertain error without execution, or proceed only for
`execute`.

Extend the failing test first with three explicit pre-execution cases: `execute`
invokes the underlying tool once, `replay` returns the stored output without
invoking it, and `uncertain` raises the stored error without invoking it. This
locks crash recovery semantics before the wrapper implementation exists.

- [ ] **Step 5: Make the global factory policy-aware**

```typescript
export type GlobalAgentToolOptions = {
  apiBase: string
  sessionId?: number
  draftId?: number
  skillName?: string
  restoredSkillName?: string
  approvalPolicy?: AgentApprovalPolicy
  beforeToolExecute?: (event: AgentToolAudit) => Promise<AgentToolDecision>
  onToolAudit?: (event: AgentToolAudit) => void | Promise<void>
}
export async function openGlobalAgentTools(options: GlobalAgentToolOptions) {
  // Discover MCP tools, add generateImage, create the Skill runtime,
  // then apply the approval and audit policy.
}
export const openGlobalChatTools = openGlobalAgentTools
```

Default to `interactive`, preserving Chat behavior.

- [ ] **Step 6: Run focused tool tests and verify GREEN**

```bash
cd wemedia-studio
pnpm exec vitest run lib/ai/agent-tool-policy.test.ts lib/ai/global-chat-tools.test.ts
```

Expected: both files pass, including existing Skill and reference tests.

- [ ] **Step 7: Commit**

```bash
git add wemedia-studio/lib/ai/agent-runtime-types.ts wemedia-studio/lib/ai/agent-tool-policy.ts wemedia-studio/lib/ai/agent-tool-policy.test.ts wemedia-studio/lib/ai/global-chat-tools.ts wemedia-studio/lib/ai/global-chat-tools.test.ts
git diff --cached --check
git commit -m "refactor: share agent tool policy"
```

---

### Task 2: Extract the Shared Agent Runtime from Chat

**Files:**
- Create: `wemedia-studio/lib/ai/agent-runtime.ts`
- Test: `wemedia-studio/lib/ai/agent-runtime.test.ts`
- Modify: `wemedia-studio/app/api/chat/route.ts`
- Test: `wemedia-studio/app/api/chat/route.test.ts`

**Interfaces:**
- Consumes: `openGlobalAgentTools`, `selectSkillForTurn`, `executeSkillRunWithAiSdk`, and Task 1 contracts.
- Produces: `openAgentRuntime(options): Promise<AgentRuntime>` and `AgentRuntime.run(request)`.
- Preserves: Chat streaming, message persistence, approval resume, and Skill audit shape.

- [ ] **Step 1: Write failing runtime selection and parity tests**

```typescript
it('uses the same tool catalog for interactive and automatic adapters', async () => {
  const chat = await openRuntimeForTest({ approvalPolicy: 'interactive' })
  const background = await openRuntimeForTest({ approvalPolicy: 'automatic' })
  expect(Object.keys(background.tools).sort()).toEqual(Object.keys(chat.tools).sort())
})

it('fails closed when a manually selected Skill is unavailable', async () => {
  await expect(openRuntimeForTest({ skillMode: 'manual', skillName: 'disabled' }))
    .rejects.toThrow(/selected skill is unavailable/i)
})
```

Also test automatic match and automatic no-match.

- [ ] **Step 2: Run and verify RED**

```bash
cd wemedia-studio
pnpm exec vitest run lib/ai/agent-runtime.test.ts
```

Expected: FAIL because `openAgentRuntime` does not exist.

- [ ] **Step 3: Implement the runtime contract**

```typescript
export type OpenAgentRuntimeOptions = {
  apiBase: string
  model: Parameters<typeof generateText>[0]['model']
  approvalPolicy: AgentApprovalPolicy
  skillMode: AgentSkillMode
  skillName?: string
  restoredSkillName?: string
  draftId?: number
  beforeToolExecute?: (event: AgentToolAudit) => Promise<AgentToolDecision>
  onToolAudit?: (event: AgentToolAudit) => void | Promise<void>
}
export type AgentRunRequest = {
  objective: string
  modelMessages: ModelMessage[]
  selectedContext?: string
  maxSteps: number
  onStep?: (checkpoint: AgentStepCheckpoint) => void | Promise<void>
}
export type AgentRunResult = {
  text: string
  parts: Record<string, unknown>[]
  skillRun?: SkillRun
  revisionCount: 0 | 1
  selectedSkill?: { name: string; activation: SkillRunActivation }
}
```

Resolve manual or automatic Skill selection, open global tools once, and reuse
the planning, reference loading, execution, validation, and revision callbacks
currently embedded in Chat. The runtime does not persist Chat messages or
background checkpoints itself.

- [ ] **Step 4: Move shared helpers out of the route**

Move `planningTools`, `executionParts`, plan repair, validation repair, revision,
and `skillRunAudit` into `agent-runtime.ts`. Export
`agentSkillRunAudit(result)` for both adapters. Keep UI response conversion in
the route.

- [ ] **Step 5: Refactor Chat onto the runtime**

```typescript
const runtime = await openAgentRuntime({
  apiBase: apiBase(), model,
  approvalPolicy: 'interactive',
  skillMode: body.skillName ? 'manual' : 'auto',
  skillName: body.skillName,
  restoredSkillName,
  draftId: body.draftId,
})
```

Use `runtime.run` for an activated Skill and `runtime.tools` for the existing
general streaming path. Close it on every terminal path.

- [ ] **Step 6: Run runtime and Chat tests**

```bash
cd wemedia-studio
pnpm exec vitest run lib/ai/agent-runtime.test.ts lib/ai/global-chat-tools.test.ts app/api/chat/route.test.ts lib/ai/skill-run-ai-sdk.test.ts
```

Expected: all pass and Chat approval behavior is unchanged.

- [ ] **Step 7: Commit**

```bash
git add wemedia-studio/lib/ai/agent-runtime.ts wemedia-studio/lib/ai/agent-runtime.test.ts wemedia-studio/app/api/chat/route.ts wemedia-studio/app/api/chat/route.test.ts
git diff --cached --check
git commit -m "refactor: extract shared agent runtime"
```

---

### Task 3: Durable Agent Execution and Tool-call Storage

**Files:**
- Modify: `backend/models.py`
- Modify: `backend/database.py`
- Create: `backend/agent_execution_service.py`
- Create: `backend/routers/agent_executions.py`
- Modify: `backend/main.py`
- Test: `backend/tests/test_agent_execution_service.py`
- Test: `backend/tests/test_agent_executions_router.py`
- Modify: `backend/tests/test_database_init_sqlite.py`

**Interfaces:**
- Produces: `AgentExecution`, `AgentToolCall`, and worker-authenticated Agent APIs.
- Consumes: `ContentJob.id` and Task 1 audit contracts serialized as JSON.

- [ ] **Step 1: Write failing service and migration tests**

```python
async def test_completed_tool_call_replays_without_execution(session):
    execution = await ensure_agent_execution(
        session, job_id=44, objective="create posts",
        skill_mode="auto", skill_name=None,
    )
    await claim_agent_tool_call(
        session, execution_id=execution.id, tool_call_id="call-1",
        tool_name="save_item", input_summary={"value": "x"},
        auto_approved=True, side_effecting=True,
    )
    await complete_agent_tool_call(session, execution.id, "call-1", {"id": 7})
    replay = await claim_agent_tool_call(
        session, execution_id=execution.id, tool_call_id="call-1",
        tool_name="save_item", input_summary={"value": "x"},
        auto_approved=True, side_effecting=True,
    )
    assert replay.action == "replay"
    assert replay.output == {"id": 7}
```

Add a test that an existing `running` side-effecting call returns `uncertain`,
and a migration assertion that both Agent tables are created.

- [ ] **Step 2: Run and verify RED**

```bash
conda run -n wems python -m pytest backend/tests/test_agent_execution_service.py backend/tests/test_database_init_sqlite.py -q
```

Expected: FAIL because models and service functions are absent.

- [ ] **Step 3: Add durable models**

Add `AgentExecution` with unique `job_id`, status, objective, Skill mode/name and
activation, phase, checkpoint JSON, audit JSON, completion evidence JSON,
optimistic `version`, error, and timestamps. Add `AgentToolCall` with unique
`(execution_id, tool_call_id)`, tool name, status, approval and side-effect flags,
bounded input summary, output JSON, error, and timestamps.

- [ ] **Step 4: Implement service semantics**

Define `ToolCallClaim` as a frozen dataclass with
`action: Literal["execute", "replay", "uncertain"]`, `output: dict | None`, and
`error: str | None`. Implement
these exact async call signatures:

- `ensure_agent_execution(session, *, job_id: int, objective: str, skill_mode: str, skill_name: str | None) -> AgentExecution`
- `update_agent_checkpoint(session, *, execution_id: int, expected_version: int, phase: str, checkpoint: dict, audit: dict) -> AgentExecution`
- `claim_agent_tool_call(session, *, execution_id: int, tool_call_id: str, tool_name: str, input_summary: dict, auto_approved: bool, side_effecting: bool) -> ToolCallClaim`
- `complete_agent_tool_call(session, execution_id: int, tool_call_id: str, output: dict) -> AgentToolCall`
- `fail_agent_tool_call(session, execution_id: int, tool_call_id: str, error: str, uncertain: bool) -> AgentToolCall`
- `complete_agent_execution(session, execution_id: int, completion_evidence: dict) -> AgentExecution`

`claim_agent_tool_call` returns `execute`, `replay`, or `uncertain`. A stale
unfinished read call may be reclaimed because it has no side effect; a stale
unfinished side-effecting call returns `uncertain`. Checkpoint JSON stores the
ordered model/tool parts needed to reconstruct history, and version conflicts
never overwrite newer state.

- [ ] **Step 5: Add worker-authenticated routes**

```text
POST /api/agent-executions
GET  /api/agent-executions/by-job/{job_id}
PATCH /api/agent-executions/{execution_id}/checkpoint
POST /api/agent-executions/{execution_id}/tool-calls/{tool_call_id}/claim
POST /api/agent-executions/{execution_id}/tool-calls/{tool_call_id}/succeed
POST /api/agent-executions/{execution_id}/tool-calls/{tool_call_id}/fail
POST /api/agent-executions/{execution_id}/complete
```

Every mutation requires `require_worker_token`; version conflicts return 409.

- [ ] **Step 6: Run service, route, and migration tests**

```bash
conda run -n wems python -m pytest backend/tests/test_agent_execution_service.py backend/tests/test_agent_executions_router.py backend/tests/test_database_init_sqlite.py -q
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add backend/models.py backend/database.py backend/agent_execution_service.py backend/routers/agent_executions.py backend/main.py backend/tests/test_agent_execution_service.py backend/tests/test_agent_executions_router.py backend/tests/test_database_init_sqlite.py
git diff --cached --check
git commit -m "feat: persist durable agent executions"
```

---

### Task 4: Daily Rule Skill Configuration and Immutable Snapshots

**Files:**
- Modify: `backend/models.py`
- Modify: `backend/database.py`
- Modify: `backend/routers/daily_plan.py`
- Modify: `backend/daily_creation_service.py`
- Test: `backend/tests/test_daily_creation_rule_schema.py`
- Test: `backend/tests/test_daily_creation_rules_router.py`
- Test: `backend/tests/test_daily_creation_service.py`
- Modify: `wemedia-studio/lib/api/daily-plan.ts`
- Modify: `wemedia-studio/app/daily-plan/DailyPlanClient.tsx`
- Modify: `wemedia-studio/app/daily-plan/CreationRuleDialog.tsx`
- Modify: `wemedia-studio/app/daily-plan/CreationRulesPanel.tsx`
- Test: `wemedia-studio/app/daily-plan/DailyPlanClient.test.tsx`
- Test: `wemedia-studio/app/daily-plan/CreationRuleDialog.test.tsx`
- Test: `wemedia-studio/app/daily-plan/CreationRulesPanel.test.tsx`

**Interfaces:**
- Produces: rule fields `skill_mode: "auto" | "manual"` and `skill_name: string | null`.
- Consumes: enabled Skill list from `/api/chat/skills` through the existing
  `listChatSkills()` API client.
- Preserves: every existing rule defaults to automatic selection.

- [ ] **Step 1: Write failing backend schema and snapshot tests**

```python
def test_manual_skill_requires_a_name():
    with pytest.raises(ValidationError):
        CreationRuleIn(**base_rule(skill_mode="manual", skill_name=None))

def test_snapshot_keeps_skill_selection(rule):
    rule.skill_mode = "manual"
    rule.skill_name = "human-social-copy"
    assert snapshot_creation_rule(rule)["skill_name"] == "human-social-copy"
```

Router tests assert `auto` defaults and manual round trips. Filesystem Skill
availability remains authoritative in the Next.js runtime, not Python.

- [ ] **Step 2: Run backend tests and verify RED**

```bash
conda run -n wems python -m pytest backend/tests/test_daily_creation_rule_schema.py backend/tests/test_daily_creation_rules_router.py backend/tests/test_daily_creation_service.py -q
```

Expected: new assertions fail because fields are absent.

- [ ] **Step 3: Add model, migration, API, and snapshot fields**

```python
skill_mode: Mapped[str] = mapped_column(String, nullable=False, default="auto")
skill_name: Mapped[str | None] = mapped_column(String, nullable=True)
```

Use `_add_columns` with `skill_mode` defaulting to `auto`. Pydantic validation:

```python
if self.skill_mode == "manual" and not (self.skill_name or "").strip():
    raise ValueError("skill_name is required in manual mode")
if self.skill_mode == "auto":
    self.skill_name = None
```

Include both values in `_rule_out` and `snapshot_creation_rule`.

- [ ] **Step 4: Write failing UI tests**

```typescript
expect(screen.getByRole('radio', { name: '自动匹配' })).toBeChecked()
fireEvent.click(screen.getByRole('radio', { name: '手动指定' }))
fireEvent.change(screen.getByLabelText('指定 Skill'), {
  target: { value: 'human-social-copy' },
})
fireEvent.click(screen.getByRole('button', { name: '保存规则' }))
expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
  skill_mode: 'manual', skill_name: 'human-social-copy',
}))
```

In `DailyPlanClient.test.tsx`, mock `listChatSkills()` with one enabled Skill,
open the new-rule dialog, and assert the Skill name is offered. This test must
fail until the page loads and passes the Skill list.

- [ ] **Step 5: Implement typed UI controls**

Extend `DailyCreationRule` and `DailyCreationRuleInput`. Pass enabled Skills into
the dialog; render auto/manual radios and one select. Show `自动 Skill` or the
manual name in the rule card. Preserve an unavailable saved name as
`名称（不可用）` so editing exposes the error source.

In `DailyPlanClient.tsx`, import `ChatSkill` and `listChatSkills` from
`@/lib/api/chat`, add `skills` state, include `listChatSkills()` in
`refreshCreation()`, and pass `skills={skills}` to `CreationRuleDialog`. A Skill
list failure follows the existing creation-data load error path instead of
silently presenting an empty manual selector.

- [ ] **Step 6: Run backend and frontend rule tests**

```bash
conda run -n wems python -m pytest backend/tests/test_daily_creation_rule_schema.py backend/tests/test_daily_creation_rules_router.py backend/tests/test_daily_creation_service.py -q
cd wemedia-studio
pnpm exec vitest run app/daily-plan/DailyPlanClient.test.tsx app/daily-plan/CreationRuleDialog.test.tsx app/daily-plan/CreationRulesPanel.test.tsx
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add backend/models.py backend/database.py backend/routers/daily_plan.py backend/daily_creation_service.py backend/tests/test_daily_creation_rule_schema.py backend/tests/test_daily_creation_rules_router.py backend/tests/test_daily_creation_service.py wemedia-studio/lib/api/daily-plan.ts wemedia-studio/app/daily-plan/DailyPlanClient.tsx wemedia-studio/app/daily-plan/CreationRuleDialog.tsx wemedia-studio/app/daily-plan/CreationRulesPanel.tsx wemedia-studio/app/daily-plan/DailyPlanClient.test.tsx wemedia-studio/app/daily-plan/CreationRuleDialog.test.tsx wemedia-studio/app/daily-plan/CreationRulesPanel.test.tsx
git diff --cached --check
git commit -m "feat: configure skills for daily agents"
```

---

### Task 5: Atomic Agent-owned Daily Output Persistence Tool

**Files:**
- Modify: `backend/models.py`
- Modify: `backend/daily_creation_service.py`
- Modify: `backend/mcp_server.py`
- Test: `backend/tests/test_daily_creation_service.py`
- Test: `backend/tests/test_mcp_daily_creation_tools.py`

**Interfaces:**
- Produces: MCP tool `save_daily_creation_outputs`.
- Produces: `persist_daily_creation_output_batch(session, *, execution_id, run_id, idempotency_key, posts, self_validation) -> dict`.
- Consumes: `AgentExecution`, successful `AgentToolCall` evidence, the rule snapshot, and existing persistence helpers.

- [ ] **Step 1: Write failing atomicity, evidence, and replay tests**

```python
async def test_batch_persistence_is_atomic_and_idempotent(
    session, agent_execution, run,
):
    await record_observed_asset_ids(session, agent_execution.id, [381, 379])
    first = await persist_daily_creation_output_batch(
        session,
        execution_id=agent_execution.id,
        run_id=run.id,
        idempotency_key="final-call-1",
        posts=[post(381), post(379)],
        self_validation={"passed": True, "summary": "checked"},
    )
    replay = await persist_daily_creation_output_batch(
        session,
        execution_id=agent_execution.id,
        run_id=run.id,
        idempotency_key="final-call-1",
        posts=[post(381), post(379)],
        self_validation={"passed": True, "summary": "checked"},
    )
    assert replay == first
    assert len(first["output_ids"]) == 2
```

Also assert one invalid or unobserved asset rolls back every new output.

- [ ] **Step 2: Run and verify RED**

```bash
conda run -n wems python -m pytest backend/tests/test_daily_creation_service.py backend/tests/test_mcp_daily_creation_tools.py -q
```

Expected: FAIL because batch service and tool are absent.

- [ ] **Step 3: Add one idempotent batch record**

Add `DailyCreationOutputBatch` with unique `(run_id, idempotency_key)`, Agent
execution ID, self-validation JSON, output IDs, usage IDs, created count, and
timestamp. Lock `DailyCreationRun` during first persistence so one run cannot
commit competing final batches.

- [ ] **Step 4: Implement atomic persistence and evidence validation**

```python
class AgentCreationPost(TypedDict):
    source_asset_ids: list[int]
    title: str | None
    text: str
    reuse_decision: Literal["fresh", "reuse_allowed"]
    reuse_explanation: str
    compared_usage_ids: list[int]
    metadata: dict[str, str]
```

Inside one transaction: lock the run; replay an existing key; derive observed
asset and usage IDs from successful candidate/usage tool-call outputs; reject
invented evidence, empty source lists, and excess output count; persist all
drafts or plan items and usage rows; create
the batch; set run status from actual count; attach self-validation; return
`created_count`, `output_ids`, `draft_ids`, `plan_item_ids`, and `usage_ids`.
Keep `metadata` optional at the MCP schema boundary and bounded; never require
legacy phase fields such as `topic` or `angle` when the active Skill does not
use them.

- [ ] **Step 5: Expose the global MCP tool**

```python
@mcp.tool()
async def save_daily_creation_outputs(
    execution_id: int,
    run_id: int,
    idempotency_key: str,
    posts: list[dict],
    self_validation: dict,
) -> dict:
    """Atomically persist the Agent's final validated daily outputs."""
```

Validate bounded strings and at most 50 posts. MCP discovery makes the tool
available to both Chat and background runtimes.

- [ ] **Step 6: Run persistence and MCP tests**

```bash
conda run -n wems python -m pytest backend/tests/test_daily_creation_service.py backend/tests/test_mcp_daily_creation_tools.py -q
```

Expected: all pass, including rollback and replay assertions.

- [ ] **Step 7: Commit**

```bash
git add backend/models.py backend/daily_creation_service.py backend/mcp_server.py backend/tests/test_daily_creation_service.py backend/tests/test_mcp_daily_creation_tools.py
git diff --cached --check
git commit -m "feat: persist agent creation outputs atomically"
```

---

### Task 6: Durable Background Agent Adapter

**Files:**
- Create: `wemedia-studio/lib/ai/agent-execution-client.ts`
- Test: `wemedia-studio/lib/ai/agent-execution-client.test.ts`
- Create: `wemedia-studio/lib/ai/daily-creation-agent-job.ts`
- Test: `wemedia-studio/lib/ai/daily-creation-agent-job.test.ts`
- Modify: `wemedia-studio/lib/ai/job-client.ts`

**Interfaces:**
- Consumes: Tasks 2-5 shared runtime, Agent APIs, atomic persistence tool, and immutable rule snapshots.
- Produces: `runDailyCreationAgentJob(jobId: number): Promise<AgentCompletionEvidence>`.
- Produces: `buildDailyCreationAgentObjective(context): string`.

- [ ] **Step 1: Write failing objective and completion tests**

```typescript
it('gives one Agent the full task and persistence evidence contract', () => {
  const objective = buildDailyCreationAgentObjective(context)
  expect(objective).toContain('搞钱副业')
  expect(objective).toContain('10 条中文 X 短帖')
  expect(objective).toContain('最近 7 天')
  expect(objective).toContain('save_daily_creation_outputs')
  expect(objective).toContain('只有该工具返回的真实 ID 才表示完成')
  expect(objective).not.toContain('select → generate → validate')
})
```

Use a fake runtime to prove prose without persistence evidence fails, while a
successful save-tool result completes the job.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
cd wemedia-studio
pnpm exec vitest run lib/ai/agent-execution-client.test.ts lib/ai/daily-creation-agent-job.test.ts
```

Expected: FAIL because the client and runner do not exist.

- [ ] **Step 3: Implement the typed durable client**

```typescript
ensureAgentExecution(jobId, request)
getAgentExecutionByJob(jobId)
checkpointAgentExecution(id, expectedVersion, state)
claimAgentToolCall(id, event)
completeAgentToolCall(id, toolCallId, output)
failAgentToolCall(id, toolCallId, error, uncertain)
completeAgentExecution(id, evidence)
```

Use `workerHeaders(jobId)` on every call. Preserve HTTP 409 as a non-retryable
concurrency error.

- [ ] **Step 4: Build the complete task objective**

Serialize exact rule constraints, require candidate and recent-usage tools,
permit every other global tool, require Agent self-validation, and name the final
persistence tool. Include immutable `run_id` and `execution_id`; do not prescribe
an internal phase sequence.

- [ ] **Step 5: Implement checkpointed automatic tool execution**

```typescript
const runtime = await openAgentRuntime({
  apiBase: apiRoot(),
  model,
  approvalPolicy: 'automatic',
  skillMode: context.rule.skill_mode,
  skillName: context.rule.skill_name ?? undefined,
  beforeToolExecute: claimOrReplayToolCall,
  onToolAudit: auditToolCall,
})
```

`claimOrReplayToolCall` claims each call before execution and returns the Task 1
decision. It returns recorded output for `replay`, returns an explicit uncertain
decision for an unresolved side effect, and permits only a new `execute` claim.
`auditToolCall` records the terminal result. Save model/tool parts and current
Skill audit after each AI SDK step through the checkpoint API.

- [ ] **Step 6: Derive terminal state only from save-tool output**

Find a successful `save_daily_creation_outputs` result in recorded calls, parse
its snake_case MCP wire shape with strict Zod, map it to the canonical camelCase
`AgentCompletionEvidence`, verify run ID and count, complete the Agent execution, then
complete the content job. Without valid evidence, fail the single `agent` job
step and leave the creation run status consistent with any committed batch.

- [ ] **Step 7: Run adapter tests**

```bash
cd wemedia-studio
pnpm exec vitest run lib/ai/agent-execution-client.test.ts lib/ai/daily-creation-agent-job.test.ts lib/ai/agent-runtime.test.ts
```

Expected: prose-only failure, manual unavailable Skill, automatic no-Skill,
tool replay, and completion evidence tests all pass.

- [ ] **Step 8: Commit**

```bash
git add wemedia-studio/lib/ai/agent-execution-client.ts wemedia-studio/lib/ai/agent-execution-client.test.ts wemedia-studio/lib/ai/daily-creation-agent-job.ts wemedia-studio/lib/ai/daily-creation-agent-job.test.ts wemedia-studio/lib/ai/job-client.ts
git diff --cached --check
git commit -m "feat: run daily creation through shared agent"
```

---

### Task 7: Cut Over New Runs and Preserve Historical Formats

**Files:**
- Modify: `backend/daily_creation_service.py`
- Test: `backend/tests/test_daily_creation_service.py`
- Modify: `wemedia-studio/scripts/content-worker.ts`
- Test: `wemedia-studio/scripts/content-worker.test.ts`
- Modify: `backend/job_reconciliation.py`
- Test: `backend/tests/test_job_reconciliation.py`

**Interfaces:**
- Consumes: `runDailyCreationAgentJob` and existing `runDailyCreationJob`.
- Produces: explicit routing by `job.input.runtime_version`.
- Preserves: historical jobs retry with their original runner.

- [ ] **Step 1: Write failing dispatch tests**

```python
assert job.input_data == {
    "run_id": creation_run.id,
    "runtime_version": "agent-v1",
}
```

```typescript
expect(resolveContentJobRunner('daily_creation', { runtimeVersion: 'agent-v1' }))
  .toBe(runDailyCreationAgentJob)
expect(resolveContentJobRunner('daily_creation', { runtimeVersion: undefined }))
  .toBe(runDailyCreationJob)
```

- [ ] **Step 2: Run and verify RED**

```bash
conda run -n wems python -m pytest backend/tests/test_daily_creation_service.py backend/tests/test_job_reconciliation.py -q
cd wemedia-studio
pnpm exec vitest run scripts/content-worker.test.ts
```

Expected: new jobs lack the version and worker routing cannot select the new runner.

- [ ] **Step 3: Version every new daily job**

Set `runtime_version: "agent-v1"` in `create_daily_creation_run`. Do not update
historical `ContentJob.input_data` rows.

- [ ] **Step 4: Route after loading the job**

Pass the loaded job input into runner resolution. Route `agent-v1` to the new
runner and absent values to the legacy runner. Unknown non-empty versions fail
non-retryably with `unsupported daily creation runtime version`. Preserve the
existing content-job lease/claim guard so a live worker prevents concurrent
execution of the same Agent run.

- [ ] **Step 5: Reconcile incomplete Agent executions**

Enqueue queued/running `agent-v1` jobs. Do not enqueue terminal historical jobs.
Startup catch-up creates versioned new jobs without modifying existing jobs.

- [ ] **Step 6: Run dispatch and reconciliation tests**

```bash
conda run -n wems python -m pytest backend/tests/test_daily_creation_service.py backend/tests/test_job_reconciliation.py backend/tests/test_daily_creation_scheduler.py -q
cd wemedia-studio
pnpm exec vitest run scripts/content-worker.test.ts lib/ai/daily-creation-agent-job.test.ts
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add backend/daily_creation_service.py backend/tests/test_daily_creation_service.py backend/job_reconciliation.py backend/tests/test_job_reconciliation.py wemedia-studio/scripts/content-worker.ts wemedia-studio/scripts/content-worker.test.ts
git diff --cached --check
git commit -m "feat: cut daily runs over to agent runtime"
```

---

### Task 8: Agent Run Audit UI

**Files:**
- Modify: `backend/routers/daily_plan.py`
- Test: `backend/tests/test_daily_creation_rules_router.py`
- Modify: `wemedia-studio/lib/api/daily-plan.ts`
- Modify: `wemedia-studio/app/daily-plan/CreationRunsPanel.tsx`
- Test: `wemedia-studio/app/daily-plan/CreationRunsPanel.test.tsx`

**Interfaces:**
- Consumes: Agent execution and tool-call audit records.
- Produces: bounded `DailyCreationRun.agent_execution` details.

- [ ] **Step 1: Write failing API and UI tests**

```typescript
expect(screen.getByText('human-social-copy')).toBeInTheDocument()
expect(screen.getByText('自动触发')).toBeInTheDocument()
expect(screen.getByText('references/finance-writing.md')).toBeInTheDocument()
expect(screen.getByText(/save_daily_creation_outputs/)).toBeInTheDocument()
expect(screen.getByRole('link', { name: '草稿 #192' })).toBeInTheDocument()
```

Also test an `自动批准` badge and uncertain-side-effect failure text.

- [ ] **Step 2: Run and verify RED**

```bash
conda run -n wems python -m pytest backend/tests/test_daily_creation_rules_router.py -q
cd wemedia-studio
pnpm exec vitest run app/daily-plan/CreationRunsPanel.test.tsx
```

Expected: Agent audit fields are absent.

- [ ] **Step 3: Add a bounded run-detail projection**

```typescript
type AgentExecutionSummary = {
  status: string
  phase: string
  skill_name: string | null
  skill_activation: 'manual' | 'automatic' | ''
  loaded_references: Array<{ path: string; bytes: number }>
  tools: Array<{
    tool_name: string
    status: string
    auto_approved: boolean
    occurred_at: string
    error: string
  }>
  self_validation: Record<string, unknown>
  completion: AgentCompletionEvidence | null
}
```

Limit tools to the latest 100 and errors to 500 characters. Never expose model
keys, full tool inputs, full reference content, or worker tokens.

- [ ] **Step 4: Render progressive audit details**

Keep the run list compact. An expandable section shows Skill activation,
reference paths, tool timeline, self-validation, completion count, and clickable
output IDs. Legacy runs continue to render existing step/detail data.

- [ ] **Step 5: Run API and UI tests**

```bash
conda run -n wems python -m pytest backend/tests/test_daily_creation_rules_router.py -q
cd wemedia-studio
pnpm exec vitest run app/daily-plan/CreationRunsPanel.test.tsx app/daily-plan/DailyPlanClient.test.tsx
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add backend/routers/daily_plan.py backend/tests/test_daily_creation_rules_router.py wemedia-studio/lib/api/daily-plan.ts wemedia-studio/app/daily-plan/CreationRunsPanel.tsx wemedia-studio/app/daily-plan/CreationRunsPanel.test.tsx
git diff --cached --check
git commit -m "feat: show daily agent execution audit"
```

---

### Task 9: Integration, Failure Recovery, and Release Verification

**Files:**
- Create: `wemedia-studio/lib/ai/daily-creation-agent-integration.test.ts`
- Modify: `backend/tests/test_job_reconciliation.py`
- Modify: `backend/tests/test_mcp_daily_creation_tools.py`
- Modify: `docs/superpowers/specs/2026-08-04-shared-chat-background-agent-runtime-design.md` only when verified behavior requires clarification.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: release evidence for capability parity, persistence, restart safety, and failures.

- [ ] **Step 1: Add a fake-model integration test**

The fake model automatically selects a fixture Skill, plans a reference and
candidate/usage tools, reads the reference, calls research tools, self-validates
ten posts, calls `save_daily_creation_outputs`, and returns a final summary.
Assert recorded Skill activation, reference, tools, automatic approvals, ten
real output IDs, and evidence-based `succeeded` status.

- [ ] **Step 2: Add crash-window tests**

Cover these exact cases:

- restart after a completed read tool replays its output;
- restart after completed atomic persistence returns the same batch without duplicate drafts;
- unresolved non-idempotent write fails with uncertain-side-effect evidence instead of rerunning;
- startup reconciliation resumes a queued `agent-v1` job.
- a live content-job lease prevents a second worker from entering the same Agent
  execution.

- [ ] **Step 3: Run focused cross-stack suites**

```bash
conda run -n wems python -m pytest backend/tests/test_agent_execution_service.py backend/tests/test_agent_executions_router.py backend/tests/test_daily_creation_service.py backend/tests/test_mcp_daily_creation_tools.py backend/tests/test_job_reconciliation.py backend/tests/test_daily_creation_scheduler.py -q
cd wemedia-studio
pnpm exec vitest run lib/ai/agent-runtime.test.ts lib/ai/agent-tool-policy.test.ts lib/ai/daily-creation-agent-job.test.ts lib/ai/daily-creation-agent-integration.test.ts app/api/chat/route.test.ts app/daily-plan/CreationRuleDialog.test.tsx app/daily-plan/CreationRunsPanel.test.tsx scripts/content-worker.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 4: Run complete backend and frontend tests**

Run outside restricted networking where provider tests need loopback listeners:

```bash
conda run -n wems python -m pytest backend/tests -q
cd wemedia-studio
pnpm test
```

Expected: every test passes. Report unrelated failures as failures; never call a
partial run successful.

- [ ] **Step 5: Run lint and production build**

```bash
cd wemedia-studio
pnpm exec eslint app/api/chat/route.ts app/daily-plan/CreationRuleDialog.tsx app/daily-plan/CreationRunsPanel.tsx lib/ai/agent-runtime.ts lib/ai/agent-tool-policy.ts lib/ai/agent-execution-client.ts lib/ai/daily-creation-agent-job.ts lib/ai/global-chat-tools.ts scripts/content-worker.ts
pnpm build
```

Expected: lint and production build pass. Existing unrelated Turbopack warnings
may be reported but are not test failures.

- [ ] **Step 6: Perform one controlled real run**

With explicit paid-model authorization at execution time, use an automatic Skill
rule, target count 1, and a test-only directory. Verify selected Skill and
references, parity of Chat/background tools, one real draft ID, evidence-based
success, and no duplicate after a Worker restart.

- [ ] **Step 7: Commit integration coverage**

```bash
git add wemedia-studio/lib/ai/daily-creation-agent-integration.test.ts backend/tests/test_job_reconciliation.py backend/tests/test_mcp_daily_creation_tools.py docs/superpowers/specs/2026-08-04-shared-chat-background-agent-runtime-design.md
git diff --cached --check
git commit -m "test: verify shared daily agent runtime"
```

---

## Final Verification Checklist

- [ ] New daily jobs contain `runtime_version: "agent-v1"`.
- [ ] Chat and background use `openAgentRuntime` and identical global tool catalogs.
- [ ] Background sensitive tools are auto-approved and audited.
- [ ] Automatic, manual, and no-match Skill paths work as specified.
- [ ] Manual unavailable Skills fail before model execution.
- [ ] Planned and on-demand references use the shared registry and limits.
- [ ] The Agent controls research, self-validation, and persistence.
- [ ] Only `save_daily_creation_outputs` evidence determines completion.
- [ ] Atomic persistence rejects invented IDs and rolls back invalid batches.
- [ ] Completed tool calls and output batches replay without duplicate side effects.
- [ ] Uncertain non-idempotent side effects are not blindly repeated.
- [ ] Startup reconciliation resumes incomplete `agent-v1` jobs.
- [ ] Historical daily jobs preserve their original runner on retry.
- [ ] Rule and run UIs show Skill configuration and bounded execution audit.
- [ ] Complete backend tests, complete Vitest, lint, and production build pass.
