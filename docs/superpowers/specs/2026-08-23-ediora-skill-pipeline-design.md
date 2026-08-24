# Ediora Ordered Skill Pipeline Design

## Status

Approved for implementation planning on 2026-08-23. The original four phases
have since landed on the local integration branch. This document was amended
on 2026-08-23 against local `develop` commit `bb4e9ef` to correct Chat dispatch,
streaming reasoning, and Agent-owned goal completion semantics.

The current baseline contains the shared `ChatWorkspace`, file-backed Skill
registry, durable execution-job runtime, ordered Skill Pipeline, and unified
Agent Trajectory. The amendment is part of the same Agent Harness feature and
does not create a second execution system.

## Goal

Let a user compose an ordered writing workflow directly in Chat:

```text
@资料研究 @写作方案:深度技术文章 @去AI味 @账号文风:账号A
写一篇关于本地优先 AI 工具的公众号文章
```

Every confirmed inline `@` token invokes one Skill. A single token remains a
normal streaming Chat turn with one explicitly selected Skill. Two or more
tokens create an ordered durable Pipeline: Ediora resolves their parameters,
shows a plan for a complex Chat task, runs each Skill as an independent durable
stage in written order, exposes foldable intermediate results, and returns the
final artifact as a normal assistant message.

The same pipeline engine also powers background Jobs. Multi-Skill Chat waits
for explicit plan confirmation; a Job creates its plan and begins
automatically. Zero-Skill and single-Skill Chat remain conversational turns.

## Design principles

1. A Skill is a standard, portable Agent Skills package. Ediora-specific
   bindings live outside the package.
2. One invocation is one ordered stage. Multiple Skills are never collapsed
   into one model prompt or one Agent execution.
3. PostgreSQL is the source of truth. Redis transports only durable job IDs.
4. Plans, attempts, outputs, and supersession are persisted. UI streaming is a
   cache-invalidation mechanism, not the state store.
5. Intermediate results are visible by default at a useful summary level and
   foldable when the user does not need them.
6. User confirmation approves the proposed pipeline, not arbitrary side
   effects such as publishing, deleting, or uploading to an external service.
7. Database upgrades are additive, repeatable, and data-preserving. The
   running schema must match the current application version before work is
   accepted.
8. Existing Chat, single-Skill, scheduled-job, and historical data remain
   readable during rollout.
9. The Agent, not prompt-parsing business code, decides whether its objective
   is complete. Durable work succeeds only after an explicit Agent completion
   declaration backed by real runtime evidence.

## Scope

### In scope

- Ordered, duplicate-preserving Skill invocation from structured inline Chat tokens.
- Direct streaming Chat execution for exactly one structured Skill invocation.
- Searchable parameter selection for Skills that declare one parameter kind.
- A shared persistent `SkillPipeline` for Chat and background Jobs.
- Macro pipeline plans and per-stage micro plans.
- Durable stage attempts, primary and auxiliary artifacts, retry, rerun,
  cancellation, crash recovery, and idempotent commands.
- Foldable Chat plan, stage, intermediate-result, and failure displays.
- Standard Agent Skills compatibility without requiring `SKILL.json`.
- Four first-party Skills: research, writing-plan execution, humanization, and
  account-voice transformation.
- An additive startup migration using the existing `init_db()` mechanism.
- A Pi-compatible Agent-owned completion declaration for durable Jobs and
  Pipeline Stage attempts.

### Out of scope for the first release

- Arbitrary DAGs, parallel stages, loops, and conditional branches.
- More than one structured parameter per Skill invocation.
- Automatic publishing, destructive actions, or blanket tool approval.
- Arbitrary execution of scripts shipped inside uploaded Skill packages.
- A public marketplace or remote Skill dependency resolver.
- Replacing the current `/api/jobs` public route or physically renaming the
  existing job tables.
- Making the global floating Chat refactor a release prerequisite.

## User-facing contract

### Invocation grammar

The display form is:

```text
@<Skill display name>
@<Skill display name>:<parameter display name>
```

The first release supports zero or one structured parameter per invocation.
The text form is a visual representation; execution is triggered only by a
confirmed structured token. Plain text containing an email address or an
unconfirmed `@word` never invokes a Skill.

Each token stores stable identity independent of its mutable display label:

```ts
type SubmittedSkillInvocationPart = {
  type: "skill-invocation"
  invocationId: string
  skillName: string
  skillDisplayName: string
  parameterKind: string | null
  parameterId: string | null
  parameterDisplayName: string | null
  position: number
}

type ResolvedSkillInvocation = SubmittedSkillInvocationPart & {
  skillVersion: string | null
  skillDigest: string
  skillSnapshot: JsonObject
  bindingSnapshot: JsonObject
  parameterSnapshot: JsonObject | null
  capabilitySnapshot: JsonObject
}
```

The composer and Chat message store `SubmittedSkillInvocationPart`. The Job's
pipeline input stores `ResolvedSkillInvocation`. Version, digest,
instructions, parameter content, and capability fields are server-owned values
added during transactional resolution; client-supplied snapshot values are
ignored.

Ordering is the token occurrence order in the submitted message. Duplicate
Skills are valid and remain separate invocations; Ediora does not merge or
deduplicate them.

### Composer interaction

1. Typing `@` opens the enabled Skill list and focuses search.
2. Choosing a Skill without a parameter inserts an atomic highlighted token at
   the current caret position inside the message body.
3. Choosing a parameterized Skill transitions the same popover to a searchable
   entity list.
4. Choosing the entity inserts one inline token displaying
   `@Skill:parameter`.
5. Backspace immediately after a token or Delete immediately before it removes
   the complete token. Browser selection deletion is synchronized back to the
   structured invocation list; a token is never partially editable.
6. On mobile, the same flow uses a bottom Sheet. A “view all” action may open
   a larger dialog without changing the selection contract.

The composer is a lightweight rich-text surface containing ordinary text nodes
and non-editable Skill nodes. Copying serializes a token to readable
`@Skill:parameter` text; pasted content is always plain text and never creates a
Skill invocation. API requests submit the ordered message parts and the
structured invocations separately. The execution objective contains only the
ordinary text nodes. The server validates that token IDs occur in the same order
as the invocation list and never reconstructs authoritative IDs by parsing
display text.

Persisted user messages retain the ordered text and Skill parts, so sent
messages render the same highlighted tokens as the composer. The parts reuse the
existing JSON message column; no database schema migration is required, and
historical plain-text Pipeline messages remain readable through their fallback
text.

### Parameter resolvers and snapshots

The Skill list API returns the binding's parameter kind. A paginated parameter
resolver then searches only entities the current user may use:

```http
GET /api/skills?query={text}
GET /api/skills/{skill_name}/parameters?query={text}&cursor={cursor}
```

The `writing_plan` resolver searches active Writing Plans by title, strategy,
and tag. Its frozen snapshot contains the plan ID, title, strategy,
description, genre, tags, visual-style overrides, and attached source
metadata/content needed by the Skill. Required source content is copied into
the persisted snapshot with a digest so editing the library does not alter a
running attempt.

The `publish_account` resolver searches active Publish Accounts by display
name and platform. Its frozen snapshot is the sanitized style-only object
defined in the security section. The selection response never includes
credentials.

A deleted or disabled entity can still be displayed from an old message's
snapshot, but it cannot be chosen for a new pipeline. Server resolution fails
atomically if a submitted parameter is missing, unauthorized, inactive, or of
the wrong kind.

### Chat and Job behavior

A normal Chat message with no Skill token continues through `/api/chat` and the
existing Chat path.

A Chat message with exactly one Skill token also uses `/api/chat`. The client
passes the structured invocation, and the server resolves the Skill and its
optional parameter with the same authoritative resolver used by Pipeline
creation. The persisted user message keeps the atomic highlighted token, while
the resolved parameter snapshot is supplied as untrusted turn context. The
response streams text, reasoning, and tool events as they happen; no durable
Pipeline Job or plan-confirmation card is created.

A Chat message with two or more Skill tokens creates a pipeline. The pipeline
is planned and shown in `awaiting_confirmation`; execution starts after the
user confirms the current plan version. Invocation order and duplicate Skills
remain significant.

A background Job with `flow = "skill_pipeline"` uses
`confirmation = "automatic"`: it persists the plan and starts immediately.
Automatic mode changes only the plan-confirmation step. It does not expand the
Skill's tool permissions.

This dispatch rule is based only on the number of confirmed structured tokens:
plain `@text` does not count, and a parameter such as `@写作方案:深度技术文章`
remains one invocation.

## Standard Skill compatibility

### Package authority

The standard Agent Skills package is authoritative:

```text
skill-name/
├── SKILL.md
├── scripts/       # optional; preserved but not executed arbitrarily
├── references/    # optional
└── assets/        # optional
```

`SKILL.md` frontmatter and body define identity, description, and operating
instructions. `SKILL.json` remains accepted as an optional legacy optimization
for preload or execution hints, but importing or running a Skill must not
require it.

If optional metadata is placed in standard frontmatter, new product-specific
keys use the `ediora-` namespace. Core package behavior must still make sense
to another Agent Skills host that ignores those keys.

The standard Skill `name` is a stable slug. Localized display names, parameter
sources, product capability profiles, and output declarations belong to a
separate Ediora `SkillBinding`:

```ts
type SkillBinding = {
  skillName: string
  displayName: string
  description?: string
  parameter?: {
    kind: "writing_plan" | "publish_account"
    required: boolean
  }
  primaryOutput: "research_bundle" | "article" | "generic"
  capabilityProfile: SkillCapabilityProfile
  defaultEnabled: boolean
}
```

An imported standard Skill with no binding remains usable with no structured
parameter, generic artifact output, and the default restrictive capability
profile. Newly uploaded Skills are installed disabled and require review
before they can be selected.

### Pi-compatible adapter boundary

Ediora follows Pi's stable invocation semantics rather than depending on Pi's
current harness implementation:

```ts
runSkill(skillName, additionalInstructions)
```

The adapter resolves one standard Skill, formats its invocation using the
equivalent of Pi's `formatSkillInvocation`, and lets the Agent progressively
load references and assets. The user objective, frozen parameter snapshot,
pipeline input artifact, output contract, and capability policy are supplied
as host instructions around that invocation.

At the audited Pi commit, package loading, Skill formatting, and `/skill:name
args` provide the usable compatibility surface. The public v2
`AgentHarness.skill()` source is still a scaffold, so the first release must
not depend on it. This adapter can later delegate to a completed upstream
implementation without changing the Ediora pipeline contract.

### Runtime isolation

Each stage activates exactly one Skill. The Agent runtime receives only that
Skill's package, the allowed tools, the frozen stage input, and system policy.
It does not receive all selected Skills in one context window.

A Skill package's `scripts/` directory is retained for portability but is not
an implicit shell-execution capability. A trusted script must first be exposed
as a schema-validated, auditable Ediora tool.

## Agent-owned goal completion

### Pi-compatible loop semantics

Ediora separates an Agent run ending from a durable objective succeeding. The
execution loop follows Pi's core semantics: tool results return to the model,
the model continues while it has more tool work, and an ordinary assistant
`stop` with no queued steering or follow-up ends the current run. A run ending
is only a lifecycle boundary; it is not sufficient evidence that a scheduled
Job or Pipeline Stage achieved its business objective.

Chat turns without a durable Job may finish on a normal non-empty assistant
response. Durable Jobs and Pipeline Stage attempts additionally require the
Agent to call a Harness-owned `complete_goal` tool after auditing the original
objective and actual runtime results.

### Completion declaration

`complete_goal` is always available to durable Agent runs and is not shipped
inside any Skill package:

```ts
type CompleteGoalInput = {
  status: "completed" | "blocked"
  summary: string
  evidence: Array<{
    kind: "tool_call" | "artifact"
    id: string
    claim: string
  }>
  remainingWork?: string[]
}
```

The Agent must call it alone in its final tool turn. `completed` means the
Agent has compared the original objective with the real tool results and
believes every material requirement is satisfied. `blocked` means it has
exhausted safe in-scope progress and records the unmet work and reason.

The Harness validates only generic integrity:

- referenced tool calls and artifacts exist in the current execution scope;
- referenced side-effecting tool calls completed successfully and are not
  uncertain;
- the declaration is well formed and belongs to the active run epoch;
- no model, tool, cancellation, lease, or persistence error remains open.

Evidence may be empty only when the declaration summary itself is the complete
requested deliverable and the objective required no durable artifact or tool
side effect. The Harness persists that summary as the final assistant output.

The Harness does not parse the prompt for quantities, compare a rule's
`target_count` with saved drafts, infer required artifact types from business
phrasing, or replace the Agent's completion judgment with hidden structured
fields. Skill requirements and the editable objective remain the business
source of truth.

A valid `completed` declaration persists its evidence and terminates the run
without an unnecessary additional model turn, equivalent to Pi's terminating
tool-result hint. A `blocked` declaration closes the attempt as failed with
structured remaining work; it never becomes `succeeded`.

Persisted `agent_run` completion evidence is valid only when it contains this
well-formed declaration. The Harness does not infer completion from legacy
evidence fields, a succeeded execution status, or an already persisted primary
artifact; those records cannot complete a Job or Pipeline Stage.
Planning, Skill verification criteria, and an optional review/revision pass
may give the Agent additional feedback before this declaration. They are not a
second authority: a hidden validator cannot mark the Job successful, and a
passing validation response without `complete_goal` is still incomplete. The
Agent receives any violations in its own execution context, decides whether to
continue, and makes the final declaration itself.

### Premature stop and limits

If a durable Agent returns a normal `stop` without a completion declaration,
the Harness injects one generic follow-up that contains the unchanged original
objective and asks the Agent to audit it against the actual trace. The Agent
then either continues using tools, declares `completed`, or declares
`blocked`. This follow-up never mentions an expected draft count or another
business-specific interpretation.

The shared turn, token, time, and cancellation limits remain safety boundaries,
not completion criteria. Reaching a limit without a valid declaration closes
the attempt as incomplete/failed and preserves the trace; it must never mark
the Job successful. A process restart resumes from durable messages, tool
results, run epoch, and any accepted completion declaration rather than
replaying proven side effects.

## Pipeline model

### Terminology

| Term | Meaning |
| --- | --- |
| Pipeline | One durable ordered workflow created by Chat or a Job. |
| Pipeline plan | User-visible macro plan describing stages and expected outputs. |
| Stage | One resolved Skill invocation at one immutable sequence position. |
| Attempt | One execution of a Stage; retry and rerun create a new attempt. |
| Micro plan | The Agent's 1–12 operational steps inside one Stage attempt. |
| Artifact | Append-only stage output, classified as primary or auxiliary. |
| Primary output | The single artifact passed to the next Stage. |
| Superseded | Historical output retained but no longer active after rerun. |

### Layered architecture

```text
Chat composer / Job creator
          |
          v
Pipeline command service ---- Skill registry + SkillBinding resolvers
          |
          v
ExecutionJob + ordered ExecutionJobSteps + immutable snapshots
          |
          v
Redis queue (job ID only) -> worker holds job lease
          |
          v
Pipeline runner -> Stage attempt -> single-Skill Agent runtime
          |                              |
          |                              v
          |                       Agent Trajectory events
          v
Execution artifacts + job events -> Job API -> Chat pipeline projection
```

The new domain names are `ExecutionJob`, `ExecutionJobStep`, and
`ExecutionJobEvent`, with the module name `execution_jobs.py`. Existing code
may retain transitional aliases during rollout. The public route remains
`/api/jobs`, and the physical database tables remain `content_jobs`,
`content_job_steps`, and `content_job_events` in this release.

Existing storage is allocated as follows:

| Record | Pipeline use |
| --- | --- |
| `content_jobs.input_data` | Objective, ordered resolved invocations, confirmation mode, and pipeline-level snapshots. |
| `content_jobs.plan_version` | Optimistic concurrency token for plan revision and confirmation. |
| `content_jobs.run_epoch` | Monotonic epoch incremented by an explicit retry/rerun continuation. |
| `content_job_steps.input_data` | Immutable Stage/attempt input and Skill, parameter, artifact, and capability snapshots. |
| `content_job_steps.output_data` | Compact outcome and artifact IDs; large output lives in artifacts. |
| `content_job_events` | Append-only business transitions and command outcomes. |
| `chat_messages.parts` | Structured invocation parts and assistant `pipeline-ref`; no new Chat table is needed. |

`plan_version`, `run_epoch`, and an `updated_at` timestamp are additive
columns on `content_jobs`; the other listed payload columns already exist.

### Planning

The pipeline command service creates a deterministic macro plan from the
ordered invocations. Planning may enrich stage descriptions and validation
criteria with a model, but it cannot reorder, add, remove, or silently merge
the user's Skill invocations.

The macro plan is stored as an `ExecutionJobStep` with
`step_key = "pipeline_plan"`. Skill stages use stable keys such as:

```text
skill:01:source-research
skill:02:writing-plan
skill:03:humanize-writing
skill:04:account-voice
```

Each Stage attempt creates its own 1–12-step micro plan. The micro plan is
shown inside the Stage and recorded in the Agent Trajectory, but it does not
become a second top-level pipeline.

Chat plan revision may change descriptive instructions and approved execution
details. Changing the Skill order or parameter identity requires a new
pipeline submission so the message's structured intent remains auditable.

### Frozen Stage input

Before an attempt enters the queue, Ediora persists:

- Skill name, package version if present, content digest, and instruction
  snapshot.
- SkillBinding snapshot, including output declaration and capability profile.
- Parameter kind, stable ID, display label, and approved field snapshot.
- Original user objective and non-Skill message content.
- The active primary artifact ID from the immediately preceding Stage, if any.
- Effective model/tool capability snapshot.
- Plan version, Stage position, and attempt number.

The runtime does not re-resolve mutable account or Skill records midway
through an attempt. A later retry may explicitly choose either the frozen
snapshot or a newly resolved snapshot; the UI and event log must state which.

### Stage input and output

Every Stage receives:

1. The original user objective.
2. Its own parameter snapshot, if any.
3. The previous active `primary_output`, if any.
4. The Stage's declared output and validation contract.

A successful Stage must produce exactly one active primary artifact of the
declared kind and a valid Agent completion declaration that cites it. It may
also produce auxiliary artifacts such as source lists, outlines, validation
reports, or discarded alternatives. The persistence boundary may reject a
missing artifact, malformed artifact schema, invalid reference, or failed tool
call, but it does not reinterpret the natural-language objective to decide
whether the artifact is substantively sufficient. Without both the artifact
and Agent declaration, later stages do not start.

## Lifecycle and state transitions

### Pipeline states

```text
queued -> planning
             | Chat
             v
   awaiting_confirmation -> running -> succeeded
             |                |  \
             |                |   -> failed
             |                -> cancelled
             -> cancelled

planning -> running           # automatic Job mode
planning -> failed
```

`failed`, `cancelled`, and `succeeded` close the current pipeline run epoch;
none resumes automatically. An explicitly authorized retry or rerun starts a
new epoch, records a new Stage attempt, and moves the job back to `running`
through an idempotent command. It never edits the closed attempt.

### Stage states

```text
pending -> preparing -> running -> declaring -> succeeded
              |           |           |
              +-----------+-----------+-> failed
                          |
                          -> uncertain
                          -> cancelled
```

`uncertain` means an external side effect may have occurred but its result
cannot be proven. The pipeline pauses and requires explicit user resolution;
the worker never auto-replays that operation.

### Retry and rerun semantics

- **Retry failed Stage** creates a new attempt for the failed Stage. The user
  may add a correction. Earlier successful stages stay active.
- **Rerun successful Stage** creates a new attempt for that Stage and marks
  all active artifacts and successful attempts downstream as superseded.
  Downstream stages then execute again in order.
- Superseded attempts, artifacts, logs, and events remain queryable.
- Cancellation changes state and stops future scheduling. It does not delete
  artifacts or execution history.

## Persistence design

### Agent execution attempts

The current one-execution-per-job relation becomes one execution per Stage
attempt:

```text
agent_executions
  job_id       required
  step_id      nullable for historical job-only rows
  attempt      integer, default 1
```

The global unique constraint on `job_id` is replaced by:

- A partial unique index for legacy rows where `step_id IS NULL`, preserving
  the previous one-execution-per-job invariant.
- A unique index on `(job_id, step_id, attempt)` where `step_id IS NOT NULL`.

Historical rows keep `step_id = NULL`; the migration does not invent Stage
associations that cannot be proven.

### Execution artifacts

Add the append-only `execution_artifacts` table:

| Column | Contract |
| --- | --- |
| `id` | Stable artifact ID. |
| `job_id` | Owning pipeline/job. |
| `step_id` | Owning Skill Stage. |
| `attempt` | Producing attempt number. |
| `kind` | Semantic type such as `article` or `research_bundle`. |
| `role` | `primary` or `auxiliary`. |
| `title` | Human-readable label. |
| `text_content` | Optional textual payload. |
| `structured_content` | Optional JSON payload. |
| `digest` | Content digest for integrity and replay checks. |
| `status` | `active` or `superseded`. |
| `created_at` | Persisted creation time. |

An artifact has text content, structured content, or both. The persistence
boundary validates its declared kind and computes its digest. Primary-output
activation, Stage success, and downstream input selection occur in one
transaction.

### Checkpoints and events

Each attempt records durable checkpoints for:

```text
prepared -> plan_saved -> tools_completed -> primary_saved -> goal_declared
```

The Agent Trajectory remains the detailed model/tool trace. Execution Job
events record business transitions, commands, retries, supersession, and
reconciliation. These are related but not interchangeable logs.

## API contract

### Create from Chat

```http
POST /api/chat/sessions/{session_id}/pipelines
Idempotency-Key: chat:{session_id}:{client_message_id}
```

One backend transaction:

1. Validates the ordered structured invocation parts.
2. Resolves enabled Skill packages and bindings.
3. Captures Skill, parameter, account-style, and capability snapshots.
4. Saves the user message with its structured Skill parts.
5. Creates `flow = "skill_pipeline"` job and ordered stages.
6. Saves an assistant message part
   `{ "type": "pipeline-ref", "jobId": "..." }`.
7. Appends the initial job event.

Only after commit does the service enqueue the durable job ID for planning.
Repeating the request with the same idempotency key returns the same message
and job.

### Create from Jobs

Existing `POST /api/jobs` accepts:

```json
{
  "flow": "skill_pipeline",
  "confirmation": "automatic",
  "objective": "...",
  "invocations": []
}
```

It uses the same resolver, snapshots, stage representation, runner, and
artifacts as Chat.

### Commands and reads

```http
POST /api/jobs/{id}/confirm
POST /api/jobs/{id}/plan/revise
POST /api/jobs/{id}/cancel
POST /api/jobs/{id}/stages/{stage_key}/retry
POST /api/jobs/{id}/stages/{stage_key}/rerun
GET  /api/jobs/{id}
GET  /api/jobs/{id}/events?after={event_id}
```

`confirm` includes the observed `plan_version`; a stale version returns a
conflict with the current plan. Every mutating command includes a `request_id`
and is idempotent. Authorization is checked against both the Chat session or
Job owner and the effective tool policy.

### Final Chat projection

The Job database remains authoritative for the pipeline card. Event streaming
only tells the client to refetch records after a cursor. Reload and reconnect
rebuild the card from `GET /api/jobs/{id}`.

When the final active artifact and its `complete_goal(status="completed")`
declaration are ready, Ediora activates it, marks the Job successful, and
appends the final normal assistant message transactionally. Artifact presence
or a natural model stop alone cannot make the Job successful.
If a process crash splits an unavoidable compatibility write, a reconciler
repairs the missing final Chat projection idempotently.

## Chat presentation

### Direct Chat streaming

Zero-Skill and exactly-one-Skill Chat turns use the same live UI-message
stream. The client consumes `reasoning-start`, `reasoning-delta`, and
`reasoning-end` in addition to text and tool events. Reasoning deltas update a
foldable “思考过程” block while the response is running; the block collapses
by default when reasoning ends and remains available for inspection according
to the configured reasoning-visibility policy.

The selected Skill path must not replace this live response with a completed
`generateText` result wrapped in a synthetic stream. Planning or validation
that is useful for a direct single-Skill turn occurs inside the same streaming
Agent loop. Persisted assistant parts and the live display use the same part
types so a reload does not erase or duplicate reasoning and tool activity.

### Plan card

While planning, the assistant pipeline message shows progress. In
`awaiting_confirmation`, it displays:

- The original objective.
- Ordered Stage names and parameter labels.
- Expected output from each Stage.
- Material tool/capability notices.
- `Start`, `Adjust plan`, and `Cancel` actions.

`Adjust plan` edits descriptive execution instructions and regenerates a new
`plan_version`. It does not mutate the submitted token sequence.

### Running pipeline card

The pipeline stays inside one assistant message. It contains foldable Stage
cards:

- Current Stage starts expanded.
- Completed Stages collapse automatically to a result summary.
- Failed or uncertain Stages remain expanded with evidence and available
  recovery actions.
- Pending Stages use a compact single-line representation.
- Research material, outline, draft, and validation report are visible as
  named foldable artifacts.

Detailed prompts, raw provider payloads, full reasoning provenance, and tool
request/result data remain in the developer Agent Trajectory. Direct Chat may
show its configured foldable reasoning stream, while the pipeline card
presents product-level progress rather than duplicating the debugger.

The final article or other final primary artifact appears as a normal
assistant message after the card. It is never hidden only inside a collapsed
Stage.

### Recovery controls

A failed Stage offers `Retry` and an optional correction field. A prior
successful Stage offers `Rerun from here`, with a confirmation explaining
that later active results will be superseded and regenerated. Historical
attempts remain viewable under the Stage.

### Floating Chat integration

The shared `ChatWorkspace` is the single integration point for the full-page
and floating Chat surfaces. Dispatch, structured invocation persistence,
stream consumption, reasoning folding, and Pipeline projection live in shared
workspace components; this amendment must not reintroduce behavior that exists
only in `ChatClient` or create a second global Chat shell.

## Reliability and recovery

### Queue and lease

PostgreSQL owns status, stage attempts, checkpoints, artifacts, and events.
Redis messages contain only the job ID. A worker acquires the existing
job-level lease; ordered execution means no additional Stage lease is needed
in the first release.

The worker loads the next runnable Stage from PostgreSQL, not from queue
payload state. Duplicate queue delivery, lease expiry, or process restart is
therefore resolved against persisted checkpoints and command IDs.

### Replay rules

- Completed auditable tool calls with persisted results are replayed from the
  result and are not invoked again.
- Pure model work may be rerun from the last safe checkpoint.
- An idempotent internal draft/artifact write uses its request ID and may be
  retried.
- An accepted goal declaration is replayed from the durable checkpoint and is
  not regenerated after a worker restart.
- An external side effect without a proven idempotency/result record becomes
  `uncertain`; it is never automatically replayed.
- Generic evidence-integrity validation is deterministic and rerunnable from
  the saved trace. Business sufficiency remains the Agent's judgment.

### Reconciliation

The existing reconciliation loop additionally repairs:

- Queued/running pipelines with an expired lease.
- A succeeded attempt whose Stage activation event was not projected.
- A succeeded final Stage missing its final Chat assistant projection.
- Superseded downstream stages that were accidentally left runnable.

Every repair is append-only and idempotent.

### Trajectory projection

Durable tool-audit events and canonical runtime events may describe the same
tool call. Raw append-only events remain untouched, but the read projection
coalesces records by run scope, turn, and `callId`. When one copy has no Step
and another has an explicit Step, the explicit-Step record owns the displayed
cell and receives any missing timing, arguments, result, and source sequence
metadata from the other copy. One real tool execution therefore appears once
in the user-visible trajectory without weakening the audit trail.

## Security model

### Trust hierarchy

The runtime applies this strict precedence:

```text
system policy
  > pipeline and output contract
  > reviewed enabled Skill
  > user objective
  > parameter snapshots, earlier artifacts, and fetched web content
```

Fetched pages, quoted sources, account samples, and prior artifacts are data,
never instructions. The runtime marks them as untrusted context and does not
allow them to alter tool policy or the output contract.

### Capability profiles

A Stage's tools are the intersection of:

```text
Skill request ∩ Ediora capability profile ∩ system policy
```

`complete_goal` is a Harness control tool outside this business capability
intersection. It cannot read external data or mutate content; it can only
record the active Agent's completion declaration after generic evidence checks.
Skills neither request nor bundle it, preserving standard package portability.

The first release defines:

| Profile | Intended access |
| --- | --- |
| `restricted` | Read submitted context and write generic artifacts; no network or side effects. |
| `research` | Search/fetch and source extraction; no publication. |
| `writing` | Read artifacts, perform read-only source search/fetch, and write new artifacts. |
| `draft-writing` | Writing plus idempotent save to an internal draft. |
| `transform` | Read the previous primary artifact and write a replacement. |
| `interactive` | Request a separately approved user/tool interaction. |

Chat pipeline confirmation does not approve publish, delete, external upload,
or account mutation. Automatic Jobs may save internal artifacts and drafts
through idempotent tools, but publishing and deletion are excluded from the
automatic allowlist.

### Parameter privacy

For `publish_account`, the frozen parameter includes only writing-relevant
fields:

- positioning, audience, tone, and topic focus;
- taboo topics and word range;
- voice samples and style rules.

Application credentials, access tokens, `app_id`, `app_secret`, and unrelated
account configuration are never placed in the Skill context or artifact.

## First-party Skills

The first release ships four independently invocable standard Skill packages:

| Standard name | Display name | Parameter | Primary output | Profile |
| --- | --- | --- | --- | --- |
| `source-research` | 资料研究 | None | `research_bundle` | `research` |
| `writing-plan` | 写作方案 | Required `writing_plan` | `article` | `writing` |
| `humanize-writing` | 去 AI 味 | None | `article` | `transform` |
| `account-voice` | 账号文风 | Required `publish_account` | `article` | `transform` |

`source-research` gathers attributable material and produces a structured
source bundle plus concise findings. `writing-plan` is the actual drafting
Skill: it applies the selected writing-plan entity to the original objective
and any research bundle, then emits the article. A writing-plan parameter is
product data, not another hidden Skill.

`humanize-writing` removes generic model phrasing and improves natural rhythm
without changing supported facts. It may reuse the established human-copy
rule reference, but it remains a separate Skill and does not implicitly invoke
account voice.

`account-voice` transforms the previous article according to the sanitized
Publish Account style snapshot. It must preserve factual claims and required
structure unless the account rules explicitly request a compatible change.

This separation makes every user-visible token correspond to one durable Stage
and allows either transform to be omitted, repeated, or reordered explicitly.

## Schema migration and compatibility

### Migration policy

Use the existing idempotent `backend.database.init_db()` startup migration
path. This release does not introduce a second migration framework.

The upgrade is additive and non-destructive:

Implement these statements in one focused, idempotent
`migrate_skill_pipeline_schema()` helper called by `init_db()`:

1. Add nullable `step_id` and non-null `attempt` with a safe default to
   `agent_executions`.
2. Build replacement partial/compound indexes before removing the obsolete
   global uniqueness rule.
3. Create `execution_artifacts` and its foreign-key/index set.
4. Add `plan_version`, `run_epoch`, and `updated_at` to `content_jobs` with
   data-preserving defaults; existing JSON payload columns store snapshots.
5. Assert the required columns, constraints, indexes, and foreign keys before
   startup completes.

The migration performs no table rename, row deletion, fake Stage backfill, or
payload rewrite. If it fails, its transaction rolls back and that application
or worker process must not accept new work. Running it repeatedly is safe.

### Upgrade proof

A release gate uses a PostgreSQL fixture representing the previous production
schema with real-shaped rows in jobs, job steps/events, Agent executions,
messages, tool calls, logs, schedules, Chat messages, and JSON payloads. The
test:

1. Captures row counts, stable IDs, relation targets, and payload digests.
2. Runs `init_db()` for the new application version.
3. Verifies the new schema and all captured data invariants.
4. Runs `init_db()` a second time.
5. Verifies the same schema and data invariants again.

The application is considered current only after this check's equivalent
schema assertions pass. Backups and deployment rollback remain operational
requirements, not a substitute for data-preserving migration behavior.

### Runtime compatibility

- Historical `AgentExecution` rows with null `step_id` keep old semantics.
- Existing `/api/jobs` consumers continue to use the same route.
- Existing single-Skill Chat messages and plain messages remain readable.
- Existing scheduled flows continue through their current handlers.
- `SKILL.json`-enhanced packages remain supported.
- Legacy class/module names may be aliases during rollout; new domain code
  uses `ExecutionJob*` names.

## Testing strategy

### Skill and resolver tests

- Import and invoke a conforming Skill containing `SKILL.md` but no
  `SKILL.json`.
- Reject malformed packages and keep newly uploaded packages disabled.
- Resolve stable Skill and parameter IDs while display names change.
- Preserve exact invocation order and duplicate Skills.
- Exclude account credentials from parameter snapshots.
- Refuse implicit package script execution.

### Pipeline tests

- Exactly one structured Skill invocation uses direct Chat and never creates a
  Pipeline Job; two or more create a Pipeline in exact token order.
- A parameterized direct Skill is authoritatively resolved and its highlighted
  token survives persistence and reload.
- Multi-Skill Chat plan waits for confirmation; Job plan starts automatically.
- Each Stage creates an independent Agent execution and attempt.
- The active primary artifact is the next Stage's input.
- Missing or invalid primary output stops later stages.
- Retry creates a new failed-Stage attempt without changing earlier success.
- Rerun supersedes downstream active artifacts while preserving history.
- Create, confirm, revise, cancel, retry, and rerun commands are idempotent.
- Stale `plan_version` confirmation is rejected.
- A natural model stop without `complete_goal` cannot succeed and receives a
  generic self-audit continuation.
- A valid `completed` declaration with real evidence succeeds; `blocked`, an
  invalid evidence reference, or exhausted limits without a declaration does
  not.
- Scheduled execution does not parse prompt quantities or compare
  `target_count` with saved artifact counts.

### Reliability and security tests

- Worker crash at every checkpoint resumes from persisted state.
- Duplicate queue delivery does not duplicate Stage attempts or artifacts.
- Completed tool results replay without a second side effect.
- Unknown external side-effect outcome produces `uncertain` and pauses.
- Prompt injection in fetched material cannot change capability policy.
- Effective tools equal the declared three-way permission intersection.
- Automatic Jobs cannot publish, delete, or upload externally.
- Duplicate durable/canonical events for one `callId` render as one trajectory
  cell under the explicit Step while both raw events remain queryable.

### UI tests

- Keyboard and mobile Skill/parameter selection create structured inline tokens.
- Email addresses and plain unconfirmed `@` text do not invoke Skills.
- Plan actions and optimistic version conflict handling are accessible.
- Current, completed, failed, and pending Stage folding follows the contract.
- Intermediate artifacts and historical attempts remain inspectable.
- Reload/reconnect restores the card from the Job API.
- The final artifact renders as a normal assistant message.
- Direct Chat reasoning deltas render incrementally in one foldable block and
  remain available, collapsed by default, after completion.

### Migration and regression tests

- Upgrade the populated legacy PostgreSQL fixture twice with no data loss.
- Verify old single-Skill Chat, old jobs, schedules, logs, and draft creation.
- Run focused backend and frontend regressions for each implementation phase.
- Complete one real-model vertical smoke test from Chat tokens through final
  assistant output before release.

The full repository suite is not required by default when focused coverage is
adequate; any unrun coverage is stated in the implementation handoff.

## Delivery phases and gates

### Phase 1: standard compatibility and durable core

Detailed plan: [Phase 1 implementation plan](../plans/2026-08-23-ediora-skill-pipeline-phase-1.md).

Deliver the standard package loader without mandatory `SKILL.json`, external
SkillBinding registry, uploaded-Skill disabled state, new domain aliases,
schema additions, artifact persistence, and populated-fixture migration test.

Gate: importing a standard Skill and running the migration twice preserves all
legacy data and produces the expected current schema.

### Phase 2: pipeline engine and API

Deliver pipeline planning, frozen inputs, ordered Stage runner, independent
Agent attempts, artifacts, retries/reruns, idempotent commands, recovery, and
Chat/Job creation endpoints.

Gate: backend integration tests prove order, duplicate preservation, primary
transfer, stop-on-failure, retry, supersession, crash recovery, and permission
intersection.

### Phase 3: Chat experience

Deliver the structured composer, parameter picker, plan confirmation, pipeline
message projection, foldable Stage/artifact UI, recovery controls, reconnect,
and final assistant message.

Gate: desktop keyboard, mobile Sheet, reload, failure recovery, and final
output flows pass focused browser tests against the current Chat shell.

### Phase 4: first-party Skills and Job integration

Deliver the four first-party standard Skill packages, Writing Plan and Publish
Account bindings, automatic Job entry point, compatibility cleanup, and the
real-model vertical smoke test.

Gate: the example four-Stage workflow completes from both Chat and Job modes,
with attributable research, visible intermediate artifacts, preserved account
privacy, and a normal final assistant response.

### Post-phase Harness correction

Apply the 2026-08-23 amendment as one focused Harness correction after the
original phases: direct single-Skill Chat dispatch and parameter resolution,
live reasoning consumption, Agent-owned durable completion, and trajectory
projection coalescing. Remove the later quantity-parsing completion checks
rather than preserving them as a fallback. The correction requires focused
Chat, runtime, scheduled-job, Pipeline, and trajectory regressions before it is
merged back to the integration branch.

## Alternatives considered

### Put all selected Skills into one Agent run

This is simpler to prompt but cannot provide truthful per-Skill retry,
artifacts, permissions, or ordered observability. It also makes duplicate
Skills and downstream supersession ambiguous. It is rejected.

### Model the workflow only in Chat messages

This avoids a Job abstraction but loses durable leases, retries, recovery, and
background execution. It would create separate behavior for Chat and Jobs. It
is rejected.

### Require a product-specific manifest inside every Skill

This makes parameter and output metadata convenient but breaks standard Skill
portability. External SkillBinding metadata provides the product integration
without making it a package requirement. A legacy manifest remains optional.

### Rename physical job tables now

Physical renaming adds migration and rollback risk without changing user
behavior. New domain names plus transitional aliases achieve the architecture
goal while preserving production data. Physical table renaming is deferred.

### Parse prompt quantities or reuse rule target counts

This makes the Harness a second source of business truth, breaks arbitrary
Agent prompts, and can mark valid non-draft work incomplete or silently change
an edited objective. It contradicts the prompt-first scheduled-Agent contract
and is rejected. Quantity requirements remain ordinary objective text for the
Agent to satisfy and audit.

### Treat every normal model stop as durable success

This matches the smallest possible conversational loop but conflates “the
provider stopped producing tokens” with “the business objective is complete.”
It can reproduce the observed partial-work success state. Direct Chat may end
on a normal response; durable Jobs and Stage attempts require the explicit
Agent completion declaration.

## Acceptance criteria

The feature is releasable when all of the following are true:

1. A user can select parameterized or unparameterized Skill tokens and the
   server preserves their exact order, identity, parameters, and duplicates.
2. Exactly one Skill runs as a normal streaming Chat turn; two or more create
   a confirmed durable Pipeline. Job mode begins automatically under the same
   persisted multi-Stage contract.
3. Every Pipeline invocation is an independently traceable and retriable Stage
   attempt; a direct single-Skill Chat turn remains traceable in the Chat Agent
   Trajectory without pretending to be a Pipeline Stage.
4. Intermediate outputs are visible and foldable, and the active primary
   output is passed deterministically between stages.
5. Failure, retry, rerun, cancellation, reconnect, and worker recovery preserve
   history and do not duplicate side effects.
6. A standard Skill with no product manifest works, while unreviewed uploads
   and arbitrary package scripts cannot execute.
7. Account style context excludes credentials, and plan confirmation grants no
   implicit publication or destructive permission.
8. The populated previous-version PostgreSQL fixture upgrades twice without
   losing or rewriting existing data.
9. Existing plain Chat, historical single-Skill messages, Jobs, schedules, and
   logs remain operational.
10. The four first-party Skills complete the reference workflow in Chat and
    automatic Job modes, and the final artifact appears as a normal assistant
    message.
11. Durable Jobs and Stage attempts succeed only after the Agent explicitly
    declares completion with real evidence; no prompt-count parser or hidden
    rule count decides business completion.
12. Direct Chat streams foldable reasoning again, and duplicate raw tool audit
    events project to one correctly stepped trajectory cell.

## References

- [Agent Skills specification](https://agentskills.io/specification)
- [Pi Skills documentation at audited commit](https://github.com/earendil-works/pi/blob/a1f955e9f47fd3379b44f4aace65ab916c80519a/packages/coding-agent/docs/skills.md)
- [Pi Skill invocation formatter at audited commit](https://github.com/earendil-works/pi/blob/a1f955e9f47fd3379b44f4aace65ab916c80519a/packages/agent/src/harness/skills.ts#L38)
- [Pi AgentHarness source at audited commit](https://github.com/earendil-works/pi/blob/a1f955e9f47fd3379b44f4aace65ab916c80519a/packages/agent/src/harness/agent-harness.ts#L363)
- [Pi Agent loop](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts)
- [Pi Agent core README](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md)
- [Pi run-boundary versus settled-state discussion](https://github.com/earendil-works/pi/issues/2110)
- [Agent Trajectory unification design](./2026-08-22-agent-trajectory-design.md)
