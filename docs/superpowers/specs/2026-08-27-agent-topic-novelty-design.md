# Agent Topic Novelty Design

## Status

Approved architecture and implementation boundary.

## Summary

Ediora will prevent an Agent from creating the same topic and core viewpoint
again within a configurable time window. The first version uses one global
history across all Agent-created drafts, with a default window of 14 days.

This is an Agent Harness constraint, not a general draft-system constraint.
Only the Agent-visible `save_draft` tool uses the novelty workflow. Manual
draft creation, imports, edits, and internal backend draft operations continue
to use the existing draft behavior without novelty checks.

The Agent may inspect novelty before writing, but the authoritative check runs
when the Agent saves a draft. A dedicated service performs the final semantic
decision, draft insert, and topic-history insert as one operation. The generic
draft service and routes do not acquire this policy.

## Goals

- Prevent an Agent from repeating the same topic and core viewpoint within a
  recent time window.
- Apply one global history to Chat Agents and scheduled Agents in version one.
- Let Chat users decide how to handle a conflict.
- Require scheduled Agents to change topic instead of silently producing a
  duplicate.
- Allow a genuinely different viewpoint on the same topic.
- Allow material new developments in an ongoing event.
- Keep manual and backend draft workflows unchanged.
- Make every decision explainable and auditable.
- Prevent an Agent from bypassing the rule by skipping the advisory check.

## Non-goals

- Do not deduplicate by publication platform, account, or creation rule in the
  first version.
- Do not block manual draft creation or editing.
- Do not treat reused wording alone as the definition of a repeated topic.
- Do not add a vector database in the first version.
- Do not reserve a topic before a draft is saved.
- Do not automatically re-evaluate topic history when a user manually edits an
  Agent-created draft.
- Do not merge topic novelty with creative-asset usage tracking.

## Definition of a Duplicate

The policy compares the proposed topic and its core claim, not only titles or
full-text similarity.

- The same topic with substantially the same core conclusion is `duplicate`.
- A changed title, structure, tone, or examples does not make a repeated core
  conclusion novel.
- The same topic with a materially different core conclusion is `novel`.
- A continuing event with material facts that occurred after the earlier work
  is `new_development` when those facts justify a new piece.
- Minor supporting examples or stylistic additions without a changed
  conclusion remain `duplicate`.
- A result that cannot be judged reliably is `uncertain`.

The first version compares all active Agent-created topic records whose
`claimed_at` falls within the applicable window. The default window is 14
days. A scheduled creation rule may configure a different positive number of
days. Chat Agent requests use the system default.

## Architecture Boundary

The generic draft subsystem remains policy-neutral:

```text
manual, import, or backend draft operation
    -> existing draft service
    -> no topic novelty check
```

Agent draft creation has a dedicated path:

```text
Chat Agent or scheduled Agent
    -> Agent-visible save_draft tool
    -> save_agent_draft_with_novelty_check service
       -> authoritative novelty decision
       -> existing draft persistence primitive
       -> topic claim persistence
    -> draft and claim committed together
```

The tool wrapper must not add novelty policy to the generic draft route. The
dedicated service may reuse low-level draft construction and validation, but
its transaction boundary owns both the draft and topic claim. If either write
fails, neither is committed.

## Topic History

Introduce an Agent-specific topic-history record, conceptually named
`content_topic_claims`. It is distinct from `content_usage_ledger`, which
records scheduled-creation asset usage.

Each topic record contains at least:

- `id`
- `draft_id`
- normalized `topic`
- `core_claim`
- structured `key_facts`
- optional `event_time`
- optional `novelty_basis` for a material new development
- optional information-source item identifiers used by the Agent
- `decision`, including `novel`, `new_development`, or an approved override
- optional conflicting topic-record identifiers
- the decision explanation
- the applied `window_days`
- `claimed_at`
- `released_at`, null while active
- Agent execution and conversation identifiers required for audit

There is no pre-claim state. A record exists only after an Agent draft is
successfully saved.

Deleting a draft releases its associated topic record by setting
`released_at`. A released record is excluded from future checks. Publication
may associate the existing claim with a publication, but it does not create a
second claim. Expiration is query-time behavior based on `claimed_at` and the
new request's window; no cleanup job is required for correctness.

Manual edits to an Agent-created draft do not change its topic record in the
first version. This preserves the boundary that ordinary backend draft edits
do not invoke model-based novelty policy.

## Novelty Input and Result

Before comparison, the Agent or novelty service produces a structured topic
candidate:

```json
{
  "topic": "the event or question being discussed",
  "core_claim": "the principal conclusion of the proposed piece",
  "key_facts": ["facts supporting the conclusion"],
  "event_time": "optional event timestamp"
}
```

The canonical decision result is:

```json
{
  "decision": "novel | duplicate | new_development | uncertain",
  "conflicts": [],
  "reason": "short, evidence-based explanation",
  "novelty_basis": "material new facts when applicable",
  "suggested_action": "continue | change_topic | ask_user"
}
```

Malformed model output, model unavailability, and timeouts resolve to
`uncertain`; they never silently resolve to `novel`.

## Semantic Decision Pipeline

The first version uses two stages:

1. Filter active topic records by the global time window and retrieve a small
   candidate set using normalized topic terms and the existing character
   n-gram/text-overlap machinery.
2. Ask the configured model to compare the new structured candidate against
   the small candidate set and return the canonical decision schema.

The model receives only the fields needed to judge topic, claim, fact timing,
and differences. The decision prompt explicitly distinguishes a different
viewpoint and a material new development from cosmetic rewriting.

A later implementation may replace the candidate-retrieval stage with vector
search without changing the public tool result or save contract.

## Agent Tools and Orchestration

### Advisory check

`check_content_novelty` is a read-only Agent tool. It accepts a structured
topic candidate and `window_days`, then returns the canonical decision plus
compact conflict records. It helps the Agent avoid spending time writing a
known duplicate, but calling it is not sufficient proof that a later draft is
safe.

### Authoritative save

The Agent-visible `save_draft` tool invokes the dedicated
`save_agent_draft_with_novelty_check` service. The service repeats the novelty
check using the actual content being saved. An advisory result is evidence,
not authorization, because history may change between calls.

The Agent tool contract must describe that:

- topic novelty is global and time-limited;
- topic and core claim are judged semantically;
- manual/backend draft behavior is unrelated;
- `duplicate` and `uncertain` may prevent an Agent save;
- Chat overrides require Harness-issued evidence;
- scheduled Agents cannot override.

### Chat Agent behavior

On `duplicate` or `uncertain`, Chat shows the user the conflicting works,
dates, and reason. The user may change the topic, change the core viewpoint, or
explicitly continue.

An explicit continuation is represented by a short-lived, one-time override
token issued by the Harness for the exact conversation, candidate digest, and
conflict decision. The Agent cannot bypass policy with a plain boolean such as
`force=true`. The dedicated save service consumes and records the valid token.

### Scheduled Agent behavior

Scheduled Agents cannot override. They remove `duplicate` and `uncertain`
candidates and choose a different topic. If an authoritative save detects a
new conflict, the Agent selects another candidate and regenerates.

Retries are bounded, with three topic changes as the initial default. When no
novel candidate remains, the job fails explicitly with a reason equivalent to
"no sufficiently novel topic was available in the configured time window."
It must not save a duplicate or report false success.

## Concurrency

There is no topic reservation before draft save. Two Agents may therefore
generate the same topic concurrently. The system accepts that one generation
may be wasted, but it must prevent both saves from succeeding.

The dedicated save service serializes the authoritative check-and-write
critical section for Agent topic novelty. The implementation may use a
database advisory lock or an equivalent database-backed global lock. An
in-process lock is insufficient because API and worker processes are distinct.

Inside the serialized transaction, the service:

1. re-reads the current eligible topic history;
2. performs the authoritative decision;
3. validates a Chat override when required;
4. saves the draft through the existing persistence primitive;
5. inserts the topic claim;
6. commits both writes.

## Deletion and Publication

Draft deletion remains available through existing backend behavior. As a
small lifecycle hook, deletion releases a topic record when one exists for the
draft. A normal draft has no record, so the hook is a no-op.

Publishing an Agent-created draft retains the draft and its topic claim, so no
separate publication linkage is required in version one. The claim remains
eligible until the request's time window excludes it.

## Observability

Persist enough evidence to explain each advisory and authoritative decision:

- normalized candidate fields;
- applied window and retrieval inputs;
- retrieved topic-record identifiers and similarity scores;
- model request correlation ID and structured response;
- final decision and reason;
- new-development evidence;
- Chat override identity and consumption;
- Agent execution, tool call, draft, and topic-record identifiers;
- retry count and terminal scheduled-job reason.

Raw model HTTP auditing follows the existing sanitized model-audit mechanism;
the novelty subsystem stores correlations and structured business evidence
rather than another unsanitized copy of provider payloads.

## Error Handling

- Candidate retrieval failure returns a typed novelty-check failure.
- Model timeout, invalid schema, or ambiguous evidence becomes `uncertain`.
- Chat asks the user on `uncertain`; scheduled Agents change topic.
- An invalid, expired, reused, or mismatched override is rejected.
- A draft write or topic-claim write failure rolls back the complete Agent save.
- A concurrent conflict returns structured conflict evidence so the scheduled
  Agent can change topic and the Chat Agent can explain the result.
- Exhausted scheduled retries fail the job with an actionable reason.

## Testing

### Semantic policy

- The same topic and core claim inside 14 days is `duplicate`.
- A changed title or structure with the same conclusion remains `duplicate`.
- The same topic with a materially different conclusion is `novel`.
- Material facts occurring after the historical work produce
  `new_development` with a non-empty basis.
- Minor examples without a changed conclusion remain `duplicate`.
- A record outside the requested window is ignored.
- Model errors and invalid structured output produce `uncertain`.

### Boundary and persistence

- The Agent `save_draft` tool invokes the dedicated novelty service.
- Manual, imported, and backend draft creation does not invoke novelty checks.
- A successful Agent save creates one draft and one topic claim atomically.
- A failed claim insert leaves no draft.
- Deleting an Agent draft releases its claim.
- Deleting a normal draft is unaffected.
- Manual editing does not trigger a novelty re-check or rewrite the claim.

### Chat and scheduled behavior

- Chat receives understandable conflict evidence.
- A valid one-time Chat override permits exactly its bound save.
- Forged, expired, mismatched, or replayed overrides fail.
- Scheduled Agents cannot use overrides.
- Scheduled Agents change topic after advisory or save-time conflict.
- Retry exhaustion marks the job failed instead of completed.

### Concurrency

- Two simultaneous Agent saves of the same topic cannot both succeed.
- The losing operation receives a structured conflict result.
- The database-backed serialization works across API and worker processes.

## Delivery Boundaries

Implementation planning should preserve these increments:

1. Topic-history schema, retrieval, semantic decision service, and tests.
2. Dedicated Agent draft-save service with atomic persistence and concurrency
   control.
3. Agent tool contracts, Chat conflict/override flow, and audit evidence.
4. Scheduled-Agent candidate filtering, bounded topic changes, and terminal
   failure behavior.
5. Draft deletion/publication lifecycle hooks and end-to-end regressions.

Platform/account/rule scopes and vector retrieval remain future extensions.
