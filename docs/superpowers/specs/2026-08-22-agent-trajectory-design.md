# Agent Trajectory Unification Design

## Status

Proposed design for review.

## Goal

Unify Chat and Job Agent runtime traces around a DeepSeek Harness-inspired,
append-only typed session event log and a derived Trajectory projection. Chat
and Job keep their own business lifecycle data, but they share the same Agent
event vocabulary, pairing rules, in-flight state model, and UI renderer.

## Context and current problems

The current implementation has two different concerns mixed together:

- `AgentLogEvent` is a generic event table with free-form `event_type`,
  `phase`, `status`, and JSON payload fields.
- Chat writes model callbacks, tool audits, session markers, and assistant
  messages into that table, then renders each row as an expandable JSON block.
- Job writes the same generic events while also maintaining
  `AgentExecution`, `AgentMessageLog`, and `AgentToolCall`. Its API returns
  model messages and tool calls as separate collections, while the UI renders
  the generic event stream separately.
- `ContentJob`/`ContentJobStep` lifecycle events and Agent model steps are
  both presented as execution history even though they have different
  meanings.

This loses the relationships that matter for an Agent trace: turn and step
boundaries, source of user/context input, ordered assistant blocks, reasoning
and text, raw streaming prefixes, tool call/result pairing, nested subtools,
request metadata, usage, timing, interruption, and typed terminal reasons.

## Design principles

1. The Agent session event log is the trace source of truth. Human-facing
   messages, Conversation nodes, and Trajectory cells are projections.
2. Events are append-only, versioned, JSON-safe, and assigned a stable
   sequence and timestamp by the persistence boundary.
3. Raw stream chunks remain available for replay and in-flight UI fidelity;
   completed assistant messages carry the assembled blocks plus timing and
   usage.
4. Tool calls and results are paired by `callId`. The projection owns the
   call tree, including nested subtools and unfinished calls.
5. Business lifecycle state is not Agent conversation state. Job status,
   Job steps, retry attempts, and durable execution checkpoints remain
   separate from the Agent Trajectory.
6. The Trajectory UI is a derived turn-aware ledger, not a dump of raw event
   payloads. Details are shown in a local inspector for the selected record.
7. New polling updates are incremental and keyed by stable event/record
   identity. A refresh must not replace the entire DOM tree or lose selection,
   folding, or the current scroll position.
8. Canonical event persistence is part of the Agent run boundary. A failure to
   append a canonical event fails the run or leaves it explicitly recoverable;
   it must not be silently swallowed. Secondary audit/compatibility writes may
   remain best-effort.

## Scope and non-goals

### In scope

- A shared typed Agent session event contract for Chat and Job.
- Canonical event emission for model requests, streaming output, assistant
  messages, tools, user/context input, turn/step boundaries, and terminal
  reasons.
- A read API that supports a full tail load and sequence-cursor incremental
  updates.
- A frontend projection from canonical events to turn/group/cell records,
  including partial assistant output and running tool calls.
- A shared Trajectory component used by Chat and Job dialogs.
- A compatibility projection for existing generic events so historical traces
  remain inspectable after the new path is introduced.
- Focused tests for the event contract, projection, incremental merge, and
  Chat/Job integration boundaries.

### Out of scope

- Directly embedding DeepSeek Harness runtime packages into WeMediaStudio.
- Replacing the existing Chat human transcript API in this change.
- Replacing `ContentJob` or `ContentJobStep` business state machines.
- Rebuilding the scheduler or job retry system.
- Adding a full virtualized history browser or server-side archival paging.
- Showing hidden system prompts or sensitive request fields by default.

## Layered architecture

```text
Job / Chat business shell
  Job: ContentJob -> ContentJobStep -> AgentExecution / attempt
  Chat: ChatSession -> user interaction / approval request
                     |
                     v
              Agent Session Event Log
                     |
          Conversation / Trajectory projection
                     |
             Shared Trajectory renderer
```

### Business shell

Job owns scheduling, status, retryability, step keys, and durable execution
checkpoints. Chat owns session title, human transcript compatibility, and tool
approval interaction. These records can remain queryable for their existing
product surfaces.

For a Job, `AgentExecution` identifies the durable Agent session boundary. A
retry or resumed execution appends a new turn/attempt context to the Agent
event log; it does not turn `ContentJobStep` into an Agent `step`. A Chat
session uses the existing Chat session identity as its Agent session boundary.

### Agent session event log

Version 1 reuses the existing `agent_log_events` table as the one physical
append-only store for Agent session events. It is not a second parallel log.
The Chat and Job writers will use a strict canonical write adapter, and the
read API will expose the canonical envelope below. Existing generic rows stay
readable through the legacy adapter. The generic `phase`/`status` columns are
not the trace model; they remain optional legacy metadata and are not required
by the Trajectory projection.

The table's scoped insertion id supplies `seq`, its persisted creation time
supplies `time`, `event_type` supplies `type`, and `payload_data` supplies the
typed `data`. Canonical turn/step identity and source-event references live in
the validated event data. No new event table is introduced in this change.

Every canonical event is exposed by the API as:

```ts
type AgentSessionEvent = {
  seq: number
  time: number
  type: AgentSessionEventType
  turn: number | null
  step: number | null
  data: JsonValue
  sourceEventSeqs?: number[]
}
```

`seq` is monotonic within one Agent session. The database insertion id may be
used as the durable cursor only when the API scopes and orders it by the
session stream. `time` is the event's persisted epoch timestamp, not a UI
render timestamp.

### Canonical event vocabulary

The first version supports these events:

| Event | Required semantics |
| --- | --- |
| `turn/start` | Opens a numbered Agent turn. |
| `turn/end` | Closes a turn with a typed reason: completed, error, aborted, interrupted, max_tokens, or waiting_approval. |
| `step/start` | Opens one model request plus the tool executions it requests. |
| `step/end` | Closes that model/tool step. |
| `user/message` | User prompt or injected context, with a source discriminator and ordered content blocks. |
| `assistant/chunk` | Raw streaming text/reasoning/tool-input chunk retained for replay and live UI. |
| `assistant/message` | Assembled assistant blocks, optional usage, provider/model provenance, timing, and `interrupted` marker. |
| `tool/call` | Model-requested call with `callId`, name, and raw arguments. |
| `tool/result` | Paired result with content blocks, error state, optional error/meta, and call identity. |
| `request/header` | Redacted request config, provider/model, system-prompt digest/content policy, and tool schema snapshot. Not rendered as a normal message. |
| `agent/skill` | Product extension for skill selection/activation and loaded-reference metadata. It is inspector metadata, not a standalone trajectory cell. |

The contract must reject unknown required fields, non-JSON values, missing
pairing identities, and invalid terminal transitions at the ingestion
boundary. Product-specific extension events must be explicitly marked
ignorable or have a versioned projection handler.

### Conversation and Trajectory projection

The frontend receives canonical event pages and folds them into a keyed
snapshot:

```ts
type AgentTrajectorySnapshot = {
  sessionKey: string
  events: readonly AgentSessionEvent[]
  turns: readonly TrajectoryTurn[]
  partial: PartialAssistant | null
  runningCalls: readonly RunningToolCall[]
  requests: readonly RequestState[]
  isRunning: boolean
  lastError: AgentTurnError | null
  nextSeq: number | null
}
```

The projection groups records as `Turn -> Message/Step`, then emits cells of
kind `system`, `user`, `context`, `message`, `tool`, or `subtool`. A completed
assistant node expands its blocks in source order. A tool result owns the
paired call display and recursively projects `subCalls`. A partial assistant
or running tool remains in the same stable record identity when later polling
turns it into a completed record.

The main ledger shows a compact summary. Selecting a cell opens a local
inspector with the appropriate Input, Output, Thinking, timing, usage,
provider/model, and error data. Raw JSON is an explicit fallback/debug view,
not the default representation.

## Data flow

### Chat

1. Start a turn and append the `user/message` event with its source.
2. Append request/header and step/start before the model request.
3. Append assistant chunks as they arrive.
4. Append assistant/message when the response is assembled, including tool
   blocks, reasoning/text blocks, usage, timing, and interruption state.
5. Append tool/call and tool/result at the model/tool boundary using the same
   call id.
6. Append step/end and turn/end in `finally` with a typed reason.
7. Persist the existing `ChatMessage` compatibility projection only after the
   canonical event append succeeds; the trace API never reconstructs itself
   from generic ChatMessage rows.

### Job

1. `AgentExecution` remains the durable recovery/idempotency record.
2. The Agent run appends the same canonical turn/step/message/tool events as
   Chat, with `execution_id` as the session scope and Job metadata available
   in the envelope/inspector.
3. `AgentMessageLog` remains a compatibility/recovery read model initially;
   it is no longer the source for the Trajectory UI.
4. `AgentToolCall` remains the idempotency and side-effect safety record; its
   state is cross-checked against canonical tool/result events but does not
   replace them.
5. Job/step status events remain in the separate Job execution timeline.
6. A Job failure must append `turn/end` with `reason.kind = 'error'` (or
   `interrupted` when the process boundary prevents a provider error from
   being finalized) before the execution failure status is returned.

## API and incremental refresh

Add a scoped Agent Trajectory read API that supports:

- Chat session or Job execution scope, never an unrestricted mixed stream.
- `after_seq` cursor for append-only incremental reads.
- Initial tail load for the currently active session.
- Canonical event validation and legacy-event adaptation on the server.
- Explicit `is_running`, `lastError`, and open turn/step state derived from
  canonical events rather than “latest generic start vs latest generic end”.

The Dialog starts the initial request and polling only while open. Each poll
merges events by `seq`, then updates the projection by stable `sourceSeq` or
`callId` keys. Closing the Dialog cancels polling without clearing the local
selection state needed for reopening the same session.

## Error and recovery behavior

- Provider errors are recorded in the typed turn end reason and, when
  available, the request/step error state. They are not only a free-form
  `llm/error` row.
- A stream cancelled after visible output writes an interrupted
  `assistant/message` prefix with `interrupted: true`.
- A crash/restart can synthesize an interrupted closer for an open turn in the
  read projection, while preserving the raw log.
- Tool failures remain paired `tool/result` records with `isError` and error
  details. A side-effecting tool with unknown outcome stays visibly uncertain
  instead of being silently marked failed or succeeded.
- Legacy generic events are rendered through a compatibility adapter with
  reduced fidelity and an explicit legacy indicator.

## Security and data exposure

- Request headers, system prompts, tool schemas, tool inputs, and outputs pass
  through the existing redaction policy before persistence or response.
- The normal ledger never renders full hidden prompts or arbitrary JSON.
- The inspector only exposes fields present in the scoped event and keeps the
  existing developer-mode gate.

## Testing strategy

- Backend: canonical event validation, sequence-scoped pagination, turn/step
  open-state derivation, tool pairing, interruption/error projection, and
  legacy adaptation.
- Frontend: event merge by cursor, stable identities for partial-to-complete
  transitions, turn/step grouping, call/result/subtool projection, inspector
  selection persistence, and closed-dialog polling behavior.
- Integration: one Chat trace and one Job trace use the same projection while
  retaining their different outer lifecycle records.
- Run only directly related frontend Vitest files and backend pytest files;
  do not run the full repository suites unless focused coverage proves
  insufficient.

## Acceptance criteria

- Chat and Job show the same Trajectory vocabulary and hierarchy.
- A completed trace displays user/context input, assistant text/reasoning,
  each tool call with its result, nested subtools, timing, and usage where
  available.
- An open trace displays partial assistant output and running tools without
  fabricating completion timing.
- Provider/tool errors appear as typed terminal states and the outer Chat/Job
  status is not left running.
- Polling while a Dialog is open adds/updates keyed records without rebuilding
  the entire trace DOM or losing selection/folding.
- Existing historical generic logs remain readable through the compatibility
  adapter.
