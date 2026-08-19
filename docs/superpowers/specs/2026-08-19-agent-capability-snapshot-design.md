# Agent Capability Snapshot Design

## Status

This document defines the first implementation slice for bringing DeepSeek Harness runtime lessons into WeMediaStudio without introducing a plugin framework.

## Goal

Record the exact Skill and Tool capabilities available to a Chat or Job Agent at a meaningful execution boundary, so runs are explainable and later retries can be compared against the original runtime context.

The first slice is audit-only. It must not change Skill selection, Tool visibility, approval behavior, Job transitions, or Tool retry semantics.

## Non-goals

- No Cordis-style plugin registry or plugin lifecycle.
- No new dynamic Tool permission system.
- No Job Skill pinning or drift rejection yet; that is the next phase.
- No change to the existing scheduled-Agent boundary: `list_drafts` and `get_draft` remain available, while the existing remote-image-upload restrictions remain unchanged.
- No inference that a Skill grants permission to use a Tool.

## Existing anchors

- `web/lib/ai/agent-runtime.ts` already selects Skills, filters visible Tools, and runs Skill plans.
- `web/lib/ai/global-chat-tools.ts` already discovers MCP Tools, adds `generateImage`, applies approval/audit wrappers, and exposes Skill references.
- `web/lib/ai/daily-creation-agent-job.ts` already checkpoints a durable Agent execution and persists Tool audits.
- `backend.models.AgentExecution.audit_data` and `checkpoint_data` already provide JSON storage for Job evidence.
- `backend.models.ChatMessage.skill_run` already stores bounded Skill evidence for Chat messages.

## Design

### 1. Shared capability contract

Add a pure TypeScript capability module used by both Chat and Job runtimes. The public snapshot is JSON-safe, deterministically ordered, and versioned:

```ts
type AgentCapabilitySnapshot = {
  schemaVersion: 1
  mode: 'chat' | 'job'
  skill: SkillCapabilitySnapshot | null
  tools: ToolCapabilityDescriptor[]
  policy: AgentCapabilityPolicySnapshot
}

type SkillCapabilitySnapshot = {
  name: string
  version: string
  source: 'builtin' | 'uploaded'
  activation: 'manual' | 'automatic' | 'restored'
  instructionsDigest: string
  references: Array<{
    path: string
    bytes: number
    loaded: boolean
    contentDigest: string | null
  }>
}

type ToolCapabilityDescriptor = {
  name: string
  description: string
  inputSchemaDigest: string | null
  sideEffecting: boolean
  needsApproval: boolean
  replayPolicy: 'replayable' | 'uncertain-on-interruption'
}

type AgentCapabilityPolicySnapshot = {
  approvalPolicy: 'interactive' | 'automatic'
  allowedToolNames: string[] | null
}
```

`instructionsDigest`, loaded reference `contentDigest`, and JSON-schema `inputSchemaDigest` use SHA-256 over stable UTF-8 JSON/text. If the runtime cannot obtain a stable JSON representation of a Tool schema, it records `null`; it must not fabricate a digest.

`sideEffecting`, `needsApproval`, and `replayPolicy` describe the current runtime wrapper. The snapshot is evidence, not an authorization source. In particular, this phase does not reinterpret existing exceptions such as `generateImage`.

### 2. Runtime capture

`openAgentRuntime` exposes `capabilitySnapshot()` in addition to the existing `snapshot()` method. The method builds a fresh snapshot from the currently selected Skill, loaded references, visible Tools, and the runtime approval/allow-list options.

Tool descriptors are generated from the final visible Tool set after the existing `allowedToolNames` view is applied. This preserves the Harness invariant that the recorded Tool view matches what the model can receive and what the runtime can execute.

Skill references remain lazy. Listing a reference does not mark it loaded or compute its content digest; only the existing reference-read path can do that.

### 3. Chat persistence

Add a nullable `capability_snapshot` JSON field to `chat_messages`, API request/response models, and the Chat route persistence helper. Each assistant message produced by the runtime records the snapshot for that turn. Existing `skill_run` remains unchanged and continues to carry Skill-run validation evidence.

Old messages return `capability_snapshot: null`. The new field is bounded to JSON-safe snapshot data and is not included in model history as user-visible content.

### 4. Job persistence

At the existing `prepared` checkpoint, persist the snapshot under `audit_data.capabilities`. Include the latest snapshot in later Agent checkpoints and final Skill-run evidence where the current code already records runtime state. Use the existing JSON columns; no new AgentExecution table column is needed in this phase.

On a resumed Job, the snapshot is evidence of the current attempt. It is not yet used to reject drift or select a different Skill.

### 5. Compatibility and safety

- Existing Chat and Job Tool selection remains unchanged.
- Existing approval and `beforeToolExecute` claim paths remain unchanged.
- Existing replay/uncertain handling remains unchanged.
- Snapshot serialization must omit Tool execute functions, Skill instruction bodies, reference bodies, secrets, and full Tool outputs.
- Snapshot arrays are sorted by stable identifiers so repeated captures are diffable.

## Data flow

```text
Skill registry + visible Tool set + current policy
                    |
                    v
        AgentCapabilitySnapshot (audit-only)
             /                         \
       Chat turn                  Job execution
       chat_messages             AgentExecution.audit_data
```

## Testing and acceptance

- Pure snapshot tests prove deterministic ordering, SHA-256 changes when content changes, loaded versus listed references, and `null` for unsupported Tool schemas.
- Runtime tests prove the snapshot uses the final visible Tool set and current approval policy without changing the existing Tool set.
- Chat API tests prove old messages remain readable and new snapshots round-trip through persistence without entering model history.
- Daily Agent tests prove the prepared checkpoint and later checkpoint audits contain the same JSON-safe capability snapshot.
- Database initialization tests prove the nullable Chat column is created for fresh and existing databases.
- Existing focused Chat, Agent runtime, daily Agent, and Agent execution tests remain green.

## Follow-up phases

1. Pin a Skill and capability snapshot at Job creation and detect Skill/tool drift on retry.
2. Replace ad hoc flow-specific Tool filtering with explicit `ToolPolicy` profiles while retaining the current scheduled-Agent draft-query boundary.
3. Add explicit concurrency and idempotency metadata to Tools where the runtime can enforce it.
