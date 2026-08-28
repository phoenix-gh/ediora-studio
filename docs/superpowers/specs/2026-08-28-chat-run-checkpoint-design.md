# Chat Run Checkpoint Design

## Goal

Make interactive Chat tool approvals resume the exact Agent run that requested approval. A resumed run must retain its manually selected Skill, parameter snapshot, validated plan, capability set, completed tool evidence, and provider-neutral model history across page refreshes and service restarts.

The design replaces message-derived recovery with a durable execution state machine. `chat_messages` remains a user-facing projection; it is no longer the source of truth for resuming tools or reconstructing model history.

## Problem statement

The current Chat route handles every approval request like a new Chat request. It reloads display messages, runs Skill preparation again, and reconstructs model history by filtering UI parts. This causes three coupled failures:

- A manually selected Skill can be replaced by an automatically selected Skill after approval.
- One logical run is split across multiple assistant messages, so a tool call and its later result can be separated.
- History filtering can retain an approved tool call while dropping its completed result, producing provider-invalid messages and risking repeated writes.

The observed failure in session 107 followed this sequence: manual `writing-plan` execution requested `save_draft`; the first approved call returned `saved:false`; approval recovery automatically switched to `human-social-copy`; a second approved call created draft 862; the following provider request contained two `save_draft` calls but only one tool result and failed. The created draft remained valid even though Chat reported failure.

## Scope

- Add durable Chat Run, step, and tool-call state.
- Freeze Skill selection, direct-invocation parameters, validated plan, and capability contracts for the lifetime of a run.
- Resume approvals without invoking Skill selection or planning again.
- Reconstruct provider-neutral model messages exclusively from canonical run state.
- Make approval decisions and side-effect execution idempotent.
- Project run progress into Chat messages without using those messages for recovery.
- Surface persisted artifacts, including saved drafts, even when later model summarization fails.
- Notify an open Drafts workspace when a draft is created.
- Reject legacy pending approvals that do not have a durable run checkpoint.

## Non-goals

- Reducing the volume of per-chunk Agent log events.
- Redesigning general Skill selection for new user turns.
- Changing novelty policy or automatically bypassing an uncertain novelty result.
- Retrying non-idempotent writes whose outcome is unknown.
- Migrating completed historical Chat sessions into Chat Runs.
- Unifying background jobs and interactive Chat under one execution table in this change.

## Authority boundaries

Each representation has one responsibility:

- `chat_runs`, `chat_run_steps`, and `chat_run_tool_calls` are authoritative execution state.
- `agent_log_events` is append-only diagnostic and audit evidence.
- `chat_messages` is a user-facing projection and can be rebuilt or patched without changing execution state.
- Provider HTTP audit records remain diagnostic wire evidence and are never replayed.
- Draft and other business tables remain authoritative for completed side effects.

No recovery path may infer executable state from Chat display parts, reasoning text, HTTP audit payloads, or Agent trajectory events.

## Data model

### `chat_runs`

One row represents one user objective and its complete Agent lifecycle.

| Field | Purpose |
| --- | --- |
| `id` | Stable UUID used by approval and resume requests. |
| `session_id` | Owning Chat session. |
| `user_message_id` | Original persisted user message. |
| `assistant_message_id` | Nullable ID of the current Chat projection. |
| `status` | `preparing`, `running`, `waiting_approval`, `resuming`, `completed`, `failed`, or `needs_reconciliation`. |
| `objective` | Frozen user request text. |
| `skill_invocation` | Frozen selected Skill identity, activation, version, instruction digest, and direct parameter snapshot. |
| `validated_plan` | Frozen planner output and output requirements. |
| `capability_snapshot` | Frozen tool names, namespaces, contract digests, versions, and policies. |
| `current_step` | Latest canonical model step ordinal. |
| `checkpoint_version` | Monotonic optimistic-lock version. |
| `error_data` | Structured terminal or reconciliation error. |
| timestamps | Creation, update, completion, and lease timestamps. |

The frozen capability snapshot does not serialize executable functions. On resume, the registry resolves each named tool and verifies its version and contract digest. A missing or changed contract moves the run to `needs_reconciliation` instead of silently executing new behavior.

### `chat_run_steps`

Each row stores one provider-neutral model step in execution order.

| Field | Purpose |
| --- | --- |
| `id` | Stable step identity. |
| `run_id` | Owning Chat Run. |
| `ordinal` | Unique, increasing step number within the run. |
| `status` | `running`, `waiting_approval`, `completed`, or `failed`. |
| `assistant_content` | Canonical text and reasoning parts emitted by the model, excluding tool results. |
| `finish_reason` and usage | Provider-neutral completion metadata. |
| timestamps | Step lifecycle evidence. |

`assistant_content` preserves standard AI SDK reasoning parts. Provider adapters remain responsible for converting those parts to provider-specific fields such as DeepSeek `reasoning_content`.

### `chat_run_tool_calls`

Each tool call is stored once and belongs to one step.

| Field | Purpose |
| --- | --- |
| `run_id`, `step_id`, `tool_call_id` | Unique identity and owning step. |
| `tool_name`, `input_data` | Frozen invocation. |
| `status` | `pending_approval`, `approved`, `rejected`, `executing`, `succeeded`, `failed`, or `outcome_unknown`. |
| `approval_id` | Unique approval identity when approval is required. |
| `approval_decision` | Nullable approved/rejected decision and reason. |
| `output_data`, `error_data` | Canonical tool result or error. |
| policy fields | Side-effecting, replay, concurrency, idempotency, tool version, and contract digest. |
| `idempotency_key` | Stable run/tool-call identity supplied to tools that support claims. |
| timestamps | Approval and execution lifecycle evidence. |

Unique constraints cover `(run_id, tool_call_id)` and non-null `approval_id`. These constraints, plus run version transitions, prevent duplicate approvals and duplicate tool execution.

## Run state machine

```text
preparing -> running -> completed
                    -> failed
                    -> waiting_approval

waiting_approval --approve--> resuming -> running
                                |        -> waiting_approval
                                |        -> completed
                                |        -> failed
                                `--------> needs_reconciliation

waiting_approval --reject-----> completed
```

Only a new user message creates a new run and permits Skill selection and planning. Approval requests always address an existing `run_id` and never enter `preparing`.

An approval transition uses a compare-and-swap on `status`, `approval_id`, and `checkpoint_version`. Concurrent or repeated decisions return the already recorded decision and result. They do not execute the tool again.

## Initial execution

1. Persist the user message and create a `chat_runs` row in `preparing`.
2. Resolve any structured Skill invocation, including its parameter snapshot.
3. Select a Skill only when the user did not select one manually.
4. Validate the execution plan and capability set.
5. Persist the frozen Skill invocation, plan, and capability snapshot before executing model steps.
6. Execute steps through the Chat Run orchestrator.
7. Persist assistant content and tool calls before exposing an approval button.
8. When approval is required, mark the tool call and run `waiting_approval`, then update the Chat projection.

The run becomes resumable only after the checkpoint transaction commits. A projection or streaming failure after that commit cannot lose the pending approval.

## Approval and resume flow

The client submits only `runId`, `approvalId`, `toolCallId`, `approved`, and an optional reason. It does not resubmit Skill names, plans, model history, or tool inputs.

The server performs these steps:

1. Load and lock the run and matching pending tool call.
2. Return the recorded outcome when the same decision was already processed.
3. Reject mismatched, stale, cross-session, or legacy approvals.
4. Record the decision and atomically transition the run to `resuming`.
5. Resolve the frozen tool contract and verify its digest.
6. Execute only the approved tool call. A rejection persists a synthetic result and terminates the run without another tool or model call.
7. Persist the result against the same tool call and step.
8. Rebuild canonical model messages from the original user message plus ordered run steps and paired tool results.
9. Continue with the frozen Skill, plan, and tool set through an execution-only runtime entry point.
10. Persist a terminal result or the next pending approval and update the Chat projection.

Steps 8 through 10 apply only to approved calls. A rejected call stops after its synthetic result and terminal Chat projection. The Skill selector and planner are not callable from this path.

## Canonical model-message reconstruction

Provider messages are derived in strict step order:

1. Frozen system/Skill execution instructions.
2. Original user objective.
3. Each step's assistant text, reasoning, and tool calls.
4. A tool result for every completed or rejected tool call before the next assistant step.
5. At most the current pending tool call without a result, and only while the run is `waiting_approval`.

Before any provider request, a validator enforces:

- every non-pending assistant tool call has exactly one matching result;
- no tool result is orphaned;
- tool-call IDs are unique within the run;
- no succeeded tool is sent as pending;
- reasoning remains attached to the assistant step that produced its tool calls.

Validation failure is an internal checkpoint error. It must stop before the provider request and preserve a concise, actionable error in the run.

## Orchestrator and runtime changes

Introduce a focused `chat-run-orchestrator` with three public operations:

- `startRun(input)` performs selection, planning, freezing, and initial execution.
- `resumeRun(runId, approval)` loads a checkpoint and continues without preparation.
- `projectRun(runId)` writes or patches the user-facing assistant message.

Split the current Agent Runtime preparation and execution responsibilities:

- `prepare(objective)` remains responsible for selection and plan validation on new runs.
- `executePrepared(preparedRun, history)` executes a frozen plan and tool set.

The orchestrator owns state transitions and persistence. Provider adapters own provider serialization. Tools own business side effects. The Chat route validates HTTP input, invokes the orchestrator, and streams projections; it no longer reconstructs executable history itself.

## Chat projection and artifacts

One Chat Run owns one assistant projection identified by `assistant_message_id`. The projector patches that message as the run gains reasoning, tool results, approvals, text, and terminal status. Additional display messages are not interpreted as new execution history.

When a tool result contains a persisted artifact such as `{saved: true, id: 862}`, the projector emits an artifact card immediately with its durable ID and URL. A later model failure cannot replace that card with a generic save failure. The run may report both facts: the draft was saved, and the follow-up summary failed.

Draft creation also emits a same-window event and a small `BroadcastChannel` notification. An open Drafts workspace reloads its first page while preserving the currently edited draft and unsaved editor state. The artifact link remains the fallback and opens `/drafts?draft=<id>`.

## Failure, replay, and reconciliation

- Read-only, replayable tools may be retried after a confirmed pre-result interruption.
- Claim-backed writes reuse the stable idempotency key and first reconcile the existing claim.
- A write that may have committed but has no durable result becomes `outcome_unknown`; the run moves to `needs_reconciliation` and does not automatically replay it.
- A verified successful write remains successful even if projection or later model generation fails.
- Rejected approvals persist a provider-compatible execution-denied tool result and terminate the run without another tool or model call.
- A lease permits recovery from a process that died while `resuming`. Lease expiry never overrides replay policy.
- Tool contract drift, missing Skill versions, corrupt checkpoints, and invalid message pairing all stop locally before a provider request.

## API contract

Backend Chat Run endpoints are server-internal persistence boundaries:

- create a run and its frozen preparation;
- append or complete one step;
- register tool calls and results;
- atomically decide an approval;
- load a complete checkpoint;
- transition terminal or reconciliation status.

The browser continues calling the Next Chat route. Approval requests change from message-derived identifiers to the durable run contract:

```ts
type ChatApprovalRequest = {
  sessionId: number
  runId: string
  approvalId: string
  toolCallId: string
  approved: boolean
  reason?: string
}
```

Every request verifies that the run belongs to the supplied session. The server never trusts client-supplied tool input, Skill metadata, or capability state.

## Legacy behavior and migration

Database migration creates the three Chat Run tables and adds a nullable `run_id` to Chat assistant messages for projection lookup. Existing completed and failed messages remain unchanged.

Pending approval parts without a `run_id` are legacy and cannot be resumed safely because their Skill, plan, and complete tool history were not checkpointed. The UI disables those buttons and explains that the task must be started again. Existing business artifacts are retained.

There is no automatic conversion from HTTP audit or message parts into authoritative runs. New user turns use Chat Runs immediately after deployment.

## Verification

### State and persistence tests

- A manual `writing-plan` invocation remains manual through multiple approvals.
- An automatic Skill is selected once and reused through the run.
- A frozen direct parameter snapshot survives page and process restart.
- Double approval returns one recorded decision and executes the tool once.
- Cross-session, stale, mismatched, and legacy approvals are rejected.
- Optimistic version conflicts do not execute tools.

### Tool-history tests

- A first `save_draft` returning `saved:false` can produce a second approved call with an override token.
- Both calls retain exactly one matching result in canonical history.
- Completed tool payloads from unrelated old runs remain excluded.
- Rejected tools create one execution-denied result.
- Every provider request passes the tool-call/result pairing validator.
- Reasoning remains attached to the assistant step that emitted the call for OpenAI and DeepSeek serialization.

### Failure and recovery tests

- Restarting between approval request and decision resumes the same run.
- Restarting after a claim-backed write reconciles instead of duplicating it.
- Unknown write outcome enters `needs_reconciliation` without replay.
- A saved draft remains visibly successful when later model generation fails.
- Tool contract drift blocks resume before execution.

### UI and integration tests

- Approval buttons disappear after a decision and cannot be submitted twice.
- The trajectory retains one Skill identity for the run.
- A saved draft card links to the created draft.
- An open Drafts workspace refreshes without overwriting unsaved editor content.
- A new user message creates a new run and may perform a new Skill selection.
- A live DeepSeek run reproducing session 107 completes without Skill switching, duplicate draft creation, orphaned tool calls, or provider HTTP errors.

## Delivery order

1. Add backend schema, persistence operations, state-transition tests, and migration coverage.
2. Add canonical checkpoint and model-message validation in the Web runtime.
3. Split runtime preparation from prepared execution and add the orchestrator.
4. Route new turns and approval resumes through Chat Runs.
5. Add projection, artifact cards, legacy approval handling, and Drafts refresh notification.
6. Run focused backend, Web, provider, approval, trajectory, and UI regressions.
7. Perform one live multi-approval DeepSeek verification and inspect the persisted run, tool outcomes, draft row, and raw provider request.

## Acceptance criteria

The change is complete when a manually selected Skill can create a multi-step draft through two approvals, survive a service restart between approvals, execute each approved write at most once, send only valid paired tool history to the configured provider, preserve a successful artifact when later generation fails, and expose that artifact immediately in Chat and Drafts.
