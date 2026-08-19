# Agent Capability Snapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture deterministic, JSON-safe Skill and Tool capability snapshots for Chat turns and durable Agent Job checkpoints without changing existing runtime behavior.

**Architecture:** Add a pure TypeScript capability module that derives snapshots from the final visible Tool set, current approval policy, and the active Skill context. Extend the existing Agent runtime with an audit-only snapshot method, persist Chat snapshots in a nullable JSON column, and persist Job snapshots inside the existing AgentExecution audit/checkpoint JSON. Existing Skill selection, Tool filtering, approval, replay, and uncertain handling remain authoritative and unchanged.

**Tech Stack:** TypeScript, Vercel AI SDK ToolSet, Node `crypto` SHA-256, Vitest, Python FastAPI/Pydantic, SQLAlchemy async models, PostgreSQL JSON columns.

**Spec:** `docs/superpowers/specs/2026-08-19-agent-capability-snapshot-design.md`

## Global Constraints

- The snapshot is audit evidence only; it must never grant Tool permission or alter current execution behavior.
- Preserve the scheduled-Agent boundary: `list_drafts` and `get_draft` remain visible; only existing remote-image-upload restrictions remain filtered.
- Do not serialize Tool execute functions, Skill instruction bodies, reference bodies, secrets, or full Tool outputs.
- Keep Skill references lazy: listed references are not marked loaded until the existing preload/read path has content.
- Use SHA-256 only for stable text/JSON that can be serialized; record `null` when a Tool schema cannot be represented stably.
- Run frontend tests from `web/` with `pnpm exec vitest run <exact files>` and backend tests with `/home/violet/miniconda3/envs/wems/bin/python -m pytest <exact files> -q`.

---

### Task 1: Add the pure capability contract and snapshot builders

**Files:**
- Create: `web/lib/ai/agent-capabilities.ts`
- Test: `web/lib/ai/agent-capabilities.test.ts`
- Read-only reference: `web/lib/ai/agent-tool-policy.ts`

**Interfaces:**
- `AgentRuntimeMode = 'chat' | 'job'`
- `SkillCapabilitySnapshot`, `ToolCapabilityDescriptor`, `AgentCapabilityPolicySnapshot`, and `AgentCapabilitySnapshot` match the field names and bounds in the approved spec.
- `buildSkillCapabilitySnapshot(input)` accepts a `RegisteredSkill`, activation source, listed references, and loaded reference contents; it returns sorted reference evidence with SHA-256 digests and no bodies.
- `buildToolCapabilityDescriptors(tools)` accepts a `ToolSet`; it returns descriptors sorted by tool name, using the current `requiresToolApproval(name)` result for `sideEffecting`, the Tool's `needsApproval` value for approval evidence, and `null` for unsupported schema serialization.
- `buildAgentCapabilitySnapshot(input)` combines mode, optional Skill input, visible ToolSet, approval policy, and optional allow-list into one JSON-safe snapshot.

- [ ] **Step 1: Write failing tests for deterministic Skill and Tool snapshots**

```ts
it('sorts references and tools while omitting content bodies', () => {
  const snapshot = buildAgentCapabilitySnapshot({
    mode: 'job',
    skill: {
      skill: uploadedSkill,
      activation: 'automatic',
      references: [
        { path: 'z.md', bytes: 4 },
        { path: 'a.md', bytes: 3 },
      ],
      loadedReferences: [{ path: 'z.md', bytes: 4, content: 'secret rules' }],
    },
    tools: {
      update_draft: { description: 'Update', inputSchema: { type: 'object' }, needsApproval: true },
      search_drafts: { description: 'Search', inputSchema: { type: 'object' }, needsApproval: false },
    } as ToolSet,
    approvalPolicy: 'automatic',
    allowedToolNames: ['update_draft', 'search_drafts'],
  })

  expect(snapshot.tools.map(tool => tool.name)).toEqual(['search_drafts', 'update_draft'])
  expect(snapshot.skill?.references).toEqual([
    expect.objectContaining({ path: 'a.md', loaded: false, contentDigest: null }),
    expect.objectContaining({ path: 'z.md', loaded: true }),
  ])
  expect(JSON.stringify(snapshot)).not.toContain('secret rules')
})
```

- [ ] **Step 2: Run the new test and verify the expected RED failure**

Run: `pnpm exec vitest run lib/ai/agent-capabilities.test.ts`

Expected: FAIL because `web/lib/ai/agent-capabilities.ts` and its builders do not exist yet.

- [ ] **Step 3: Implement stable serialization, digest helpers, types, and builders**

Implement the smallest pure module with these rules:

```ts
export function buildAgentCapabilitySnapshot(input: {
  mode: AgentRuntimeMode
  skill?: SkillCapabilityInput
  tools: ToolSet
  approvalPolicy: AgentApprovalPolicy
  allowedToolNames?: readonly string[]
}): AgentCapabilitySnapshot
```

Stable JSON must sort object keys recursively, preserve array order, reject functions/symbols/circular values, and return `null` for an unsupported schema. Hash instruction/reference text with `createHash('sha256')`. Derive `replayPolicy` as `uncertain-on-interruption` for the current side-effecting audit class and `replayable` otherwise. Never include `execute` or other function-valued fields in descriptors.

- [ ] **Step 4: Run the pure tests and verify GREEN**

Run: `pnpm exec vitest run lib/ai/agent-capabilities.test.ts`

Expected: all capability builder tests pass with no warnings.

- [ ] **Step 5: Run the existing policy regression alongside the new tests**

Run: `pnpm exec vitest run lib/ai/agent-capabilities.test.ts lib/ai/global-chat-tools.test.ts`

Expected: existing approval and scheduled Tool visibility tests remain green.

### Task 2: Capture capabilities from the shared Agent runtime

**Files:**
- Modify: `web/lib/ai/global-chat-tools.ts`
- Modify: `web/lib/ai/agent-runtime.ts`
- Modify: `web/lib/ai/agent-runtime.test.ts`
- Modify: `web/lib/ai/global-chat-tools.test.ts`
- Modify: `web/lib/ai/daily-creation-agent-integration.test.ts`

**Interfaces:**
- `ChatSkillRuntime` gains an optional `capabilityContext()` returning the active Skill, listed references, activation source, and loaded reference contents. Existing `snapshot()` remains unchanged for compatibility.
- `OpenAgentRuntimeOptions` gains optional `mode?: AgentRuntimeMode`, defaulting to `'chat'` for existing callers; production Job adapters pass `'job'` explicitly.
- `AgentRuntime` gains `capabilitySnapshot(): AgentCapabilitySnapshot`.

- [ ] **Step 1: Write failing runtime tests**

Add tests proving:

```ts
const snapshot = runtime.capabilitySnapshot()
expect(snapshot.mode).toBe('job')
expect(snapshot.tools.map(tool => tool.name)).toEqual(['save_draft', 'search_assets'])
expect(snapshot.policy.approvalPolicy).toBe('automatic')
```

Also add a Skill-runtime test proving a preloaded or explicitly read reference is marked loaded in capability evidence while the existing `readReferenceCount` behavior remains unchanged.

- [ ] **Step 2: Run runtime tests and verify RED**

Run: `pnpm exec vitest run lib/ai/agent-runtime.test.ts lib/ai/global-chat-tools.test.ts`

Expected: FAIL because `capabilitySnapshot()` and the loaded-reference context are not implemented.

- [ ] **Step 3: Track loaded reference contents without changing lazy reads**

In `createChatSkillRuntime`, keep a private map of loaded `SkillReferenceContent` values. Seed it only with preload references during activation and update it only after the existing reference reader returns content. Expose the metadata through optional `capabilityContext()` without exposing bodies to the snapshot builder.

- [ ] **Step 4: Add runtime snapshot capture**

In `openAgentRuntime`, build the snapshot from `visibleTools()`, `registry.capabilityContext?.()`, `registry.activeContext()`, `options.approvalPolicy`, `options.mode ?? 'chat'`, and `options.allowedToolNames`. Return it through `capabilitySnapshot()`; do not alter `tools`, `run`, `prepare`, or approval wrappers.

- [ ] **Step 5: Update runtime fakes and verify GREEN**

Add the optional context or fallback behavior to existing test doubles, then run:

Run: `pnpm exec vitest run lib/ai/agent-runtime.test.ts lib/ai/global-chat-tools.test.ts lib/ai/daily-creation-agent-integration.test.ts`

Expected: all tests pass and the existing tool-name/approval assertions are unchanged.

### Task 3: Persist Chat capability snapshots

**Files:**
- Modify: `backend/models.py:158-168`
- Modify: `backend/database.py:1228-1231`
- Modify: `backend/routers/chat.py`
- Modify: `backend/tests/test_chat_router.py`
- Modify: `backend/tests/test_database_init_postgres.py`
- Modify: `web/lib/ai/chat-tools.ts`
- Modify: `web/lib/ai/chat-tools.test.ts`
- Modify: `web/app/api/chat/route.ts`

**Interfaces:**
- `ChatMessage.capability_snapshot` is nullable JSON.
- `ChatMessageCreate` and `ChatMessageOut` accept/return `capability_snapshot: AgentCapabilitySnapshot | None` with bounded nested Pydantic models and `extra='forbid'`.
- `persistMessage(sessionId, message, skillRun?, capabilitySnapshot?)` sends the new field separately from `skill_run`.

- [ ] **Step 1: Write failing backend persistence tests**

Add a Chat API test that posts a bounded snapshot and asserts it round-trips, and a rejection case for a reference body/tool output or over-limit tool list. Add a database initialization assertion that `chat_messages` contains `capability_snapshot` after `init_db()`.

- [ ] **Step 2: Run the backend tests and verify RED**

Run: `/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_chat_router.py::test_persists_capability_snapshot_without_bodies backend/tests/test_database_init_postgres.py::test_init_db_creates_chat_capability_snapshot_column -q`

Expected: FAIL because the API models and database column do not exist.

- [ ] **Step 3: Add bounded Python models and nullable JSON storage**

Add strict nested Pydantic models for the approved camelCase snapshot fields, with bounded names, descriptions, digests, reference paths, references, tools, and allow-list lengths. Add the nullable SQLAlchemy column and idempotent `_add_columns(conn, 'chat_messages', {'capability_snapshot': 'JSON'})` migration. Preserve `response_model_exclude_none=True` behavior for old messages.

- [ ] **Step 4: Wire the Chat route and run the backend RED-to-GREEN test**

Pass the field through `ChatMessageCreate` and `ChatMessageOut`, then run the two exact tests from Step 2. Expected: both pass, including rejection of bodies and oversized payloads.

- [ ] **Step 5: Wire the Next.js Chat route**

Pass `mode: 'chat'` to `openAgentRuntime`. For the generic Agent path, persist `runtime.capabilitySnapshot()` with the assistant message. For the streaming path, capture the snapshot in `onFinish` after the Tool loop and persist it with the assistant message. Do not add the snapshot to `modelHistoryCandidates` or model messages.

- [ ] **Step 6: Run Chat frontend and backend regressions**

Run: `pnpm exec vitest run lib/ai/chat-tools.test.ts lib/ai/agent-runtime.test.ts`

Run: `/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_chat_router.py backend/tests/test_database_init_postgres.py -q`

Expected: existing Chat history, approval, and database migration tests pass.

### Task 4: Persist Job capability snapshots in Agent checkpoints

**Files:**
- Modify: `web/lib/ai/daily-creation-agent-job.ts`
- Modify: `web/lib/ai/content-response-output-job.ts`
- Modify: `web/lib/ai/daily-creation-agent-job.test.ts`
- Modify: `web/lib/ai/content-response-output-job.test.ts`
- Modify: `web/lib/ai/daily-creation-agent-integration.test.ts`

**Interfaces:**
- Daily creation and content response runtime options pass `mode: 'job'`.
- The `prepared`, per-step, and `finalizing` checkpoint audit objects include `capabilities: runtime.capabilitySnapshot()` alongside existing `skill`/`skillRun` evidence.
- Existing `AgentExecution.audit_data` and checkpoint versioning remain unchanged.

- [ ] **Step 1: Write failing Job checkpoint assertions**

Update the existing Job runtime doubles with a deterministic `capabilitySnapshot()` and assert that the first prepared checkpoint contains the exact snapshot under `audit.capabilities`, and that finalizing evidence retains it.

- [ ] **Step 2: Run the Job tests and verify RED**

Run: `pnpm exec vitest run lib/ai/daily-creation-agent-job.test.ts lib/ai/content-response-output-job.test.ts lib/ai/daily-creation-agent-integration.test.ts`

Expected: FAIL because Job checkpoint audit payloads do not yet contain `capabilities` and runtime options do not yet identify Job mode.

- [ ] **Step 3: Wire Job mode and checkpoint capture**

Add `mode: 'job'` to both production Agent runtime calls and add `capabilities: runtime.capabilitySnapshot()` to prepared, step, and finalizing audit payloads. Do not change tool claims, completion evidence, failure classification, or recovery branches.

- [ ] **Step 4: Run Job tests and verify GREEN**

Run: `pnpm exec vitest run lib/ai/daily-creation-agent-job.test.ts lib/ai/content-response-output-job.test.ts lib/ai/daily-creation-agent-integration.test.ts`

Expected: all existing recovery and side-effect audit tests pass, with the new snapshot assertions green.

### Task 5: Final focused verification and handoff

**Files:**
- Verify: all files changed by Tasks 1-4
- Verify: `docs/superpowers/specs/2026-08-19-agent-capability-snapshot-design.md`

- [ ] **Step 1: Inspect the diff for scope and secret/body leakage**

Run: `git diff --check` and inspect the changed runtime, route, model, migration, and tests. Confirm no Tool execute function, Skill body, reference body, full output, or secret is placed in a snapshot.

- [ ] **Step 2: Run the complete focused frontend set**

Run from `web/`:

```bash
pnpm exec vitest run \
  lib/ai/agent-capabilities.test.ts \
  lib/ai/global-chat-tools.test.ts \
  lib/ai/agent-runtime.test.ts \
  lib/ai/chat-tools.test.ts \
  lib/ai/daily-creation-agent-job.test.ts \
  lib/ai/content-response-output-job.test.ts \
  lib/ai/daily-creation-agent-integration.test.ts
```

- [ ] **Step 3: Run the complete focused backend set**

Run from the repository root:

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  backend/tests/test_chat_router.py \
  backend/tests/test_database_init_postgres.py \
  backend/tests/test_agent_executions_router.py \
  backend/tests/test_jobs_router.py -q
```

- [ ] **Step 4: Report evidence and environment blockers separately**

Report exact test counts and failures, distinguish code failures from pre-existing TypeScript/database/environment issues, and report the known inability to write `.git/index.lock` if a commit is attempted.

---

## Plan Self-Review

- Spec coverage: pure contract, runtime capture, Chat persistence, Job persistence, safety, and focused tests each have an implementation task.
- Scope: no plugin framework, no permission redesign, no Skill pinning, and no changes to scheduled-Agent Tool filtering.
- Type consistency: the runtime snapshot method returns the same `AgentCapabilitySnapshot` used by Chat persistence and Job audit payloads; optional runtime context preserves existing test doubles.
- Placeholder scan: no unresolved placeholder or unspecified implementation step is required.
