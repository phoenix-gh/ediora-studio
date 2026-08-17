# Shared Chat and Background Agent Runtime Design

## Summary

Daily creation tasks must run with the same Agent capabilities as Chat. The
background worker must not maintain a separate fixed
`select -> generate -> validate -> persist` content pipeline. Instead, Chat and
scheduled tasks will become two adapters around one shared Agent runtime.

The shared runtime owns tool discovery, Skill activation, Skill references,
Skill workflow planning, tool execution, validation, revision, durable evidence,
and completion reporting. A scheduled Agent decides how to interpret the task,
select material, detect reuse, write content, validate its result, and persist
the final output through tools.

## Goals

- Give scheduled tasks the same global tools available to Chat.
- Support automatic Skill selection and one manually selected Skill, with
  automatic selection as the default.
- Load the same `SKILL.md`, preloaded references, and on-demand references as
  Chat.
- Execute one continuous Agent run across task interpretation, research,
  selection, writing, self-validation, and persistence.
- Automatically approve background tool calls while preserving an audit record.
- Let the Agent own content validation and persistence decisions.
- Require real tool evidence before a background run can claim completion.
- Resume interrupted runs without repeating successful side effects.

## Non-goals

- Keeping the existing fixed daily-creation phase orchestration as a fallback.
- Requiring a human approval interaction for background tool calls.
- Having the scheduler judge writing quality or replace Skill validation.
- Rewriting historical run records into the new execution format.
- Supporting multiple simultaneously active Skills in one run. This design
  matches Chat's current selection of at most one active Skill.

## Confirmed Product Decisions

- Chat and scheduled tasks share one Agent runtime implementation.
- A scheduled task uses one Agent across its entire lifecycle.
- Background tools that would require approval in Chat are automatically
  approved and executed.
- Rules support `auto` Skill selection and `manual` selection of one enabled
  Skill; `auto` is the default.
- The Agent performs its own validation and persists its own final output using
  tools.
- The system marks completion only from successful persistence-tool evidence,
  not from a model's textual claim.

## Architecture

### Shared Agent Runtime

Extract the reusable orchestration currently embedded in the Chat route into an
entrypoint-independent `AgentRuntime`.

```text
Chat request adapter -----------+
                                +--> AgentRuntime
Scheduled-task adapter ---------+      |- global tool registry
                                       |- Skill selection
                                       |- Skill instructions and references
                                       |- Skill plan/execute/validate/revise
                                       |- multi-step tool loop
                                       |- approval policy
                                       |- durable evidence and completion
```

The runtime accepts an execution request containing:

- the user objective;
- persisted conversation or task context;
- Skill mode and optional manual Skill name;
- the tool approval policy;
- a durable execution identifier;
- step and revision limits;
- the completion-evidence contract;
- callbacks for checkpoints, audit events, and user-facing output.

The runtime returns a terminal result or a resumable checkpoint. It does not
know whether the caller is an HTTP Chat request or a worker job.

### Chat Adapter

The Chat route remains responsible for:

- validating and persisting UI messages;
- streaming UI response parts;
- presenting approval requests and resuming approved calls;
- mapping Chat session history into the runtime request;
- rendering the runtime result back into a Chat response.

Chat retains its current approval behavior.

### Background Adapter

The scheduled-task worker is responsible for:

- loading the immutable rule snapshot and run metadata;
- constructing the task objective;
- invoking the shared runtime with automatic tool approval;
- persisting checkpoints and audit events;
- resuming incomplete executions;
- evaluating completion from persistence-tool evidence;
- mapping the result to `succeeded`, `partial`, or `failed`.

The adapter does not prescribe selection, generation, validation, or persistence
steps. Those actions belong to the Agent and its active Skill.

## Task Definition

The existing structured rule fields remain useful constraints:

- source asset type and directories;
- target output type and count;
- deduplication lookback window;
- schedule and timezone;
- destination/account constraints;
- user instructions.

Rules add:

- `skill_mode`: `auto` or `manual`, defaulting to `auto`;
- `skill_name`: required only when `skill_mode` is `manual`.

The background adapter renders the immutable snapshot into a complete objective,
for example:

```text
Read material from the selected source directories. Create 10 Chinese X short
posts. Consider the last 7 days of global use and decide whether reuse is
meaningfully different. Select and apply the configured Skill, use any relevant
tools and references, validate the final content yourself, and persist the
accepted posts as drafts.
```

The objective includes exact rule values and available completion tools. It does
not specify an internal sequence of Agent steps.

## Skill Behavior

### Automatic Selection

Automatic mode uses the same enabled-Skill catalog and selection implementation
as Chat. The Agent selects at most one Skill. When none clearly matches, the run
may proceed without a Skill, matching Chat behavior.

### Manual Selection

Manual mode loads the named Skill before execution. A missing, disabled, or
renamed Skill causes an explicit run failure; the runtime must not silently fall
back to automatic selection or no Skill.

### Instructions and References

The runtime uses the same Skill registry and limits as Chat:

- full `SKILL.md` instructions;
- `SKILL.json` preload references;
- the visible reference catalog;
- on-demand `readSkillReference` calls;
- byte, path, extension, and archive safety checks.

Loaded reference paths and their byte counts are part of the execution audit.
Reference content is never fabricated when a read fails.

### Skill Workflow

The scheduled Agent uses the same plan, execute, validate, and maximum-one-
revision workflow as Chat. Skill-required tools and references must produce the
same evidence records. The workflow spans the complete scheduled task instead of
being restarted for each legacy phase.

## Tool Behavior

### Shared Catalog

Chat and background runs use the same global tool factory. A parity test must
fail if their exposed tool-name sets diverge. Adding or removing a global Chat
tool therefore changes both surfaces together.

### Background Approval Policy

The background adapter automatically approves approval-gated tool calls. Every
such call records:

- `auto_approved: true`;
- tool name;
- tool-call ID;
- sanitized input summary;
- start and completion timestamps;
- success output or failure details.

Automatic approval does not bypass tool input validation, authorization checks,
or platform safety checks.

### Agent-owned Persistence

Add a global atomic persistence tool for daily creation output, exposed to both
Chat and background runs. The Agent calls it only after its own validation. The
tool accepts the final posts, source evidence, reuse decisions, and an Agent
self-validation summary.

The tool performs only application integrity checks:

- the run exists and is eligible for completion;
- referenced asset and usage IDs came from observed tool evidence;
- the output structure is valid;
- the idempotency key has not already succeeded;
- database writes complete atomically.

It does not decide whether the writing is good. On success it returns actual
draft or plan-item IDs, the created count, and usage-ledger IDs.

## Completion Contract

A background Agent cannot complete a run by emitting prose. The scheduled-task
adapter inspects recorded tool evidence:

- `succeeded`: the atomic persistence tool created the requested number of
  outputs;
- `partial`: it created at least one but fewer than requested;
- `failed`: it created none, the Agent exhausted its limits, or a required
  manual Skill was unavailable.

The final Agent summary is stored for inspection but does not override the tool
evidence.

## Durability and Idempotency

Each background Agent run has a durable execution record with ordered model
turns, Skill decisions, reference reads, tool calls, tool results, validation,
revision, and completion evidence.

Every tool invocation uses the pair `(agent_run_id, tool_call_id)` as an
idempotency key. On worker restart:

1. Load the latest checkpoint.
2. Reuse completed tool results in the reconstructed model history.
3. Resume from the first unresolved model or tool action.
4. Never invoke an already successful side-effecting call again.

Startup reconciliation queues incomplete Agent runs in the same way other
durable jobs are reconciled. A stale running lease may be recovered, but a live
lease prevents concurrent execution.

## Data Model

Daily creation rules gain `skill_mode` and nullable `skill_name`. Immutable run
snapshots include both fields so later rule edits cannot change an active run.

Add durable Agent-run storage associated with the content job and daily creation
run. It records:

- objective and limits;
- selected Skill and activation source;
- checkpoints/model turns;
- loaded references;
- tool approvals, calls, and results;
- Skill plan and validation evidence;
- final Agent summary;
- completion-tool evidence.

Historical daily creation records remain readable without migration into Agent
turns.

## User Interface

The task editor adds a Skill mode control:

- `自动匹配` (default);
- `手动指定`, followed by one enabled-Skill selector.

The run details view shows:

- selected Skill and activation mode;
- loaded references;
- Agent steps and status;
- tool calls, including automatic approvals;
- Agent self-validation;
- created draft/plan-item IDs;
- precise failure or partial-completion evidence.

The UI does not expose an approval inbox for background calls in this version.

## Error Handling

- A manually selected unavailable Skill fails before model execution.
- Automatic mode may proceed without a Skill when no enabled Skill matches.
- Reference failures are visible to the Agent and audit log; required-reference
  failure follows the Skill workflow's validation rules.
- A recoverable tool error is returned to the Agent for another decision within
  the step limit.
- Exceeding tool-loop or revision limits fails the run unless persistence
  evidence already proves partial or complete output.
- Persistence conflicts replay the prior idempotent result instead of creating
  duplicates.
- The legacy fixed pipeline is not used as a silent fallback.

## Migration

- Existing rules receive `skill_mode = auto` and `skill_name = null`.
- Their next scheduled occurrence uses the shared Agent runtime.
- Historical completed and failed runs remain unchanged.
- An already active legacy job remains represented by its original steps and is
  not automatically restarted.
- New retries after deployment use the runtime associated with their original
  execution format; they do not switch formats mid-run.

## Testing

### Unit Tests

- shared tool-catalog parity between Chat and background adapters;
- manual, automatic, restored, and no-Skill selection;
- preload and on-demand reference loading;
- automatic approval audit records;
- completion-evidence status mapping;
- idempotent replay of successful side-effecting calls;
- unavailable manual Skill failure;
- limit exhaustion and partial output.

### Integration Tests

- a fake model plans, reads a Skill reference, calls shared research tools,
  self-validates, persists outputs, and completes from returned IDs;
- a worker restart after persistence reuses the recorded result without
  duplicate drafts;
- startup reconciliation resumes an incomplete run;
- a recurring rule in automatic mode receives the same tools as Chat;
- a manually selected Skill is loaded with the same instructions and references
  as Chat.

### Release Verification

- all frontend and backend test suites pass;
- the production frontend build passes;
- a real scheduled task records Skill activation, reference reads, tool calls,
  self-validation, and the requested output IDs;
- disabling its manual Skill produces an explicit failure;
- stopping and restarting the system during a staged run does not duplicate
  output.

## Acceptance Criteria

- Daily creation no longer depends on a fixed phase-specific generation
  pipeline for new runs.
- Chat and background execution use one shared Agent runtime and one global tool
  factory.
- Background tasks can automatically or manually activate the same Skills as
  Chat and read the same references.
- Background tool approvals are automatic and auditable.
- The Agent autonomously validates and persists output.
- Success and partial status derive only from real persistence-tool evidence.
- Interrupted executions resume without repeating successful side effects.
