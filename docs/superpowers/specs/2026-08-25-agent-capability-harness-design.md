# Agent Capability Harness Design

## Status

Approved architecture, awaiting user review before implementation planning.

## Summary

Ediora will introduce a provider-independent Agent Capability Harness that
turns user goals into validated tool execution. The Harness will not maintain
a separate, exhaustive business-capability ontology. Instead, the registered
tool contracts are the source of truth for what the system can do, Skills
describe reusable multi-tool workflows, and the Harness provides discovery,
planning, per-step tool exposure, approval, execution, validation, replanning,
and audit.

The central rule is:

> Tool contracts describe executable capabilities; Skills describe reusable
> workflows; the Harness decides what is relevant and safe for the current
> goal.

This design applies across Ediora rather than targeting one information-source
flow. Information-source prompts, draft operations, writing plans, creative
assets, image generation, account lookup, publishing, and scheduled work are
all consumers of the same registry and execution rules.

## Problem

The current Chat runtime discovers all tools from the local MCP server and can
expose that complete set to the model. Some specialized Agent profiles narrow
the set through static allowlists, and the runtime records a capability
snapshot for audit and recovery. These are valuable pieces, but they do not yet
form a general Harness:

- the model may receive too many overlapping tools at once;
- tool descriptions vary in quality and do not consistently state selection
  boundaries;
- side effects and replay behavior are partly inferred from tool names;
- the system has no provider-independent, progressive tool-discovery layer;
- multi-step plans are not a common persisted runtime object;
- a successful tool call is not consistently distinguished from satisfying a
  step's actual objective;
- removed or changed tools can invalidate a later turn or resumed job without
  a uniform replanning rule.

A representative failure is a user asking to get an arbitrary article from an
X subscription named `github`. A flat tool list encourages the model to list a
page of IDs and choose one itself. The correct interpretation is a server-side
random sample from the complete eligible pool of that X subscription. Better
prompting cannot compensate for a missing sampling primitive or an ambiguous
tool contract.

## Goals

- Give the Agent a compact, accurate understanding of every registered tool.
- Select tools according to the user's goal rather than name similarity.
- Keep simple, low-risk operations fast without forcing a formal plan.
- Represent complex execution as a persisted, inspectable, resumable plan.
- Load only the tools needed for the current plan step.
- Enforce schemas, availability, side-effect policy, approvals, and replay
  rules outside the model.
- Validate whether tool results satisfy step and goal completion criteria.
- Replan safely when tools, contracts, evidence, or user goals change.
- Use one core design for Chat, background Jobs, and Skill pipelines.
- Measure tool selection and goal completion with regression evals.

## Non-goals

- Do not build an exhaustive ontology of every possible user phrase, resource,
  precondition, and workflow.
- Do not duplicate tool parameter documentation inside Skills.
- Do not require every user request to show or persist a multi-step plan.
- Do not make a model-generated plan an authorization boundary.
- Do not expose unavailable tools merely so the model knows they once existed.
- Do not silently substitute a semantically different tool when a contract
  changes.
- Do not require an OpenAI-specific tool-search feature; the Harness must work
  with every supported model adapter.
- Do not migrate every existing Agent workflow in the first implementation
  increment.

## Design Principles

### Tool Registry is the capability source of truth

Every MCP and application-native tool is normalized into one Tool Contract.
The Registry answers which tools exist now and what each can actually do. A
separate hand-maintained capability database would duplicate this information
and drift.

### Progressive disclosure

The model first sees namespace summaries, then compact tool summaries for the
relevant namespaces, and only then the full contracts for selected candidates.
The Agent never needs the complete schema of every tool in its initial prompt.

### Plans describe objectives before implementations

A complex plan initially records step objectives, dependencies, expected
artifacts, and candidate namespaces. A concrete tool is bound immediately
before the step runs. This limits stale bindings and allows safe replanning.

### Policy is enforced outside the model

Tool availability, allowlists, approvals, input validation, timeouts,
concurrency, and replay behavior are deterministic Harness responsibilities.
Descriptions help the model choose; they do not grant authority.

### Evidence completes work

Model text and a successful transport call are not sufficient completion
proof. Tool output must conform to its result contract and satisfy the step's
expected artifact or business predicate.

## Related Agent Patterns

The design combines patterns already used by mature Agent harnesses:

- Codex/OpenAI uses concise Skill descriptions with on-demand instruction
  loading, strict function schemas, namespaces or MCP servers, deferred tool
  loading, allowlists, and per-tool approval.
- Pi uses on-demand Skills, runtime active-tool selection, concise tool prompt
  snippets, active-only tool guidelines, and execution lifecycle interception.
- Hermes Agent uses a central registry, OpenAI-format tool schemas, toolsets,
  availability checks, uniform JSON results, and pre/post execution hooks.

None of these systems requires a comprehensive business ontology. Their common
foundation is a high-quality executable tool contract plus a Harness that
controls discovery and execution.

## Tool Contract

### Canonical representation

All tool providers normalize into the following conceptual contract:

```ts
type ToolContract = {
  name: string
  namespace: ToolNamespace
  version: string
  description: string
  inputSchema: JsonSchema
  outputSchema?: JsonSchema
  annotations: {
    readOnly: boolean
    destructive: boolean
    idempotent: boolean
    openWorld: boolean
    approval: 'never' | 'writes' | 'always'
  }
  execution: {
    concurrency: 'parallel-safe' | 'serialized'
    retry: 'safe' | 'claim-backed' | 'unsafe'
    timeoutSeconds: number
  }
  errorCodes?: string[]
  availability: 'available' | 'unavailable'
  unavailableReason?: string
  contractDigest: string
}
```

The exact storage and TypeScript/Python representations may differ, but the
normalized runtime values and semantics must be equivalent.

### Description standard

Descriptions are concise model-facing contracts, not marketing summaries.
Each description must make these boundaries clear:

1. what the tool does;
2. when to use it;
3. when not to use it, especially versus adjacent tools;
4. the scope of data or side effects;
5. important prerequisites or resolver steps;
6. the important result fields and what they prove.

For example:

```text
Randomly sample collected items from the complete eligible pool of one
information-source subscription. Use when the user asks for random,
arbitrary, or surprise content. Sampling is performed server-side across the
full filtered pool. Do not use for relevance ranking, keyword search, or
trending content. Resolve a subscription name to subscription_id first.
Returns selected items, pool_size, filters, and sampling_method.
```

Descriptions may be authored as one string or compiled from structured author
fields, but the model receives one compact description. The Harness must not
try to infer missing semantics from naming conventions.

### Schemas

- Input schemas are strict wherever the model/provider supports strict
  function calling.
- Enum, range, format, required-field, and mutual-exclusion constraints belong
  in the schema rather than prose.
- Output schemas are required for new tools whose results feed another plan
  step. Legacy tools may begin without an output schema but must return a
  normalized success or error envelope.
- Stable IDs, artifact types, source URLs, pool sizes, applied filters, and
  other completion evidence must be explicit result fields.
- Expected business failures use stable error codes with safe messages.

### Safety and execution annotations

New or migrated tools explicitly declare their safety and replay metadata.
Name-based classification remains only as a compatibility fallback and emits a
registry warning. A missing annotation must never make an unknown write appear
read-only.

`openWorld` means a tool reads or affects systems outside Ediora's controlled
database, such as the public web or a publishing platform. It is distinct from
`readOnly`: web search can be both read-only and open-world.

### Availability

Registration checks dependencies such as credentials, platform configuration,
or required services. Unavailable tools remain visible to administrators and
diagnostics but are excluded from the model's callable set. A plan referencing
an unavailable tool must re-resolve or fail with an actionable reason.

### Result and error envelopes

New tools return structured data equivalent to:

```json
{
  "ok": true,
  "data": {},
  "evidence": {
    "artifact_ids": [],
    "source_urls": []
  }
}
```

or:

```json
{
  "ok": false,
  "error": {
    "code": "empty_candidate_pool",
    "message": "No collected items match the requested subscription and filters.",
    "retryable": false
  }
}
```

Existing MCP result envelopes may be normalized at the Registry boundary
during migration rather than rewritten simultaneously.

## Namespaces

The initial stable namespace catalog is:

| Namespace | Responsibility |
|---|---|
| `information_sources` | Subscriptions, collected items, search, sampling, and item retrieval |
| `web_research` | Public web search and page retrieval |
| `writing_plans` | Writing-plan lookup, creation, updates, sources, and progress |
| `drafts` | Draft lookup, creation, and editing |
| `creative_assets` | Asset search, retrieval, upload, and draft association |
| `image_generation` | Image generation and generated-image persistence |
| `accounts` | Publishing accounts and account profiles |
| `publishing` | External publication and publication records |
| `skills` | Skill discovery, activation, and reference loading |
| `system` | Harness goal completion and runtime-control tools |

A namespace description summarizes the user-facing purpose and major resource
types. It does not enumerate detailed workflow rules. Tools with genuinely
cross-cutting behavior choose the namespace that owns their primary side
effect; aliases do not create duplicate callable tools.

Namespaces should remain small enough for accurate selection. If one grows
beyond roughly ten closely related tools, it should split by resource or
operation rather than expose an increasingly ambiguous list.

## Registry and Discovery

### Registration

The existing MCP discovery call and application-native tools feed a normalized
Registry. Registration performs:

- name and namespace validation;
- schema parsing and digesting;
- explicit annotation validation;
- availability checks;
- duplicate-name rejection;
- adjacent-tool description linting;
- stable contract-digest generation.

Registry diagnostics expose invalid, unavailable, and legacy-fallback tools to
operators without exposing them as callable tools to the model.

### Three disclosure levels

The Harness builds three model-facing views:

1. **Namespace catalog:** namespace name plus a short description.
2. **Tool summary catalog:** name plus compact description for tools in the
   selected namespaces.
3. **Callable tool set:** complete schema and current policy for the small set
   selected for one plan step.

This provider-independent flow can be implemented as separate structured model
calls. Providers with native tool search may optimize the transport later, but
the observable selection and policy semantics stay identical.

### Explicit user selections

An explicit Skill or artifact selection is trusted as user intent, not as tool
authority. It narrows discovery but does not bypass availability, schema,
approval, or side-effect rules.

## Goal Routing and Plan Compilation

### Direct versus planned execution

The Harness classifies a request before execution:

- a single-step, low-risk request with unambiguous parameters may execute
  directly;
- a request involving multiple capabilities, dependencies, writes, ambiguous
  entities, or an explicit completion standard requires a structured plan.

Direct execution still records a trajectory and applies all normal tool
policy. It simply omits the persistent multi-step plan ceremony.

### Goal route

The Goal Router receives the user request, selected conversation artifacts,
and only the namespace catalog. It returns a validated structured decision:

```ts
type GoalRoute = {
  mode: 'direct' | 'plan'
  namespaces: ToolNamespace[]
  goal: string
  constraints: string[]
  successCriteria: string[]
}
```

The Harness limits the initial route to a small set of namespaces and rejects
unknown names. A later plan step may request another namespace through
replanning.

### Plan representation

```ts
type AgentPlan = {
  id: string
  goal: string
  constraints: string[]
  successCriteria: string[]
  status: 'planned' | 'running' | 'waiting-approval' | 'completed' | 'failed' | 'cancelled'
  revision: number
  steps: AgentPlanStep[]
}

type AgentPlanStep = {
  id: string
  objective: string
  namespaces: ToolNamespace[]
  dependsOn: string[]
  expectedArtifacts: string[]
  completionPredicate: string
  selectedTool: string | null
  contractDigest: string | null
  inputBindings: Record<string, EvidenceBinding>
  status: 'pending' | 'ready' | 'running' | 'waiting-approval' | 'completed' | 'failed' | 'superseded'
  attempts: AgentPlanAttempt[]
}
```

The completion predicate is a bounded, Harness-recognized predicate or a
structured expected-result declaration, not arbitrary executable model code.
Examples include `nonempty_result`, `artifact_id_present`,
`pool_sampling_proven`, and `published_record_matches_target`.

### Just-in-time tool binding

Before a step runs, the Tool Resolver receives the step objective and the tool
summary catalog for its namespaces. It chooses a candidate and declares input
bindings to prior evidence. The Harness then:

1. verifies the tool is currently available;
2. loads and validates the full contract;
3. resolves evidence bindings;
4. validates input against the schema;
5. evaluates policy and approval;
6. records the contract digest;
7. exposes only that tool and required Harness control tools for the step.

The model's explanation is audit context, not proof that the selection is
valid.

## Execution, Validation, and Replanning

### Execution

The executor applies per-step allowlists, approval rules, timeouts,
serialization, retry policy, and audit hooks. Independent read-only steps may
run in parallel when every selected contract is marked parallel-safe. Writes
default to serialized execution.

Approval is evaluated for the concrete tool call and arguments. A previous
approval does not grant future turns a permanent capability and does not cover
new arguments or a broader side effect.

### Three-level validation

A step completes only after:

1. **Call validation:** execution returned a successful result envelope.
2. **Contract validation:** output satisfies its declared schema.
3. **Objective validation:** evidence satisfies the step's completion
   predicate.

For example, successfully returning an empty subscription list does not
complete a step whose objective is to resolve a named subscription.

The final goal completes only when every required step is complete and the
plan's success criteria can be traced to stored evidence.

### Replanning triggers

The Harness replans when:

- a selected tool is absent or unavailable;
- its contract digest changed;
- required parameters cannot be resolved from evidence;
- a tool returns an empty result or a non-retryable business error;
- retries cannot change the outcome;
- tool output disproves a plan assumption;
- the user changes the goal or constraints;
- a required approval is rejected.

Replanning preserves verified completed artifacts, user constraints, approval
records, failure evidence, and attempt history. It does not preserve stale tool
permissions, unverified inferences, obsolete parameters, or pending steps that
no longer serve the revised goal.

### Tool removal and contract drift

Every new Chat turn rebuilds the callable Registry view. A later turn may use a
tool that was not active in the preceding turn if it is currently registered
and relevant. Conversely, a removed tool is not callable merely because it
appears in conversation history.

Persisted plans pin the contract digest used by each attempt. On resume:

- an unchanged contract may continue according to replay policy;
- a missing contract triggers replanning;
- a changed digest triggers compatibility validation and normally replanning;
- the Harness must not silently replace the tool with a semantically different
  one.

## Skills

Skills remain progressively loaded workflow packages. Their responsibilities
are:

- specialized sequencing and quality rules;
- reference material and templates;
- expected inputs and outputs for a reusable workflow;
- requesting a bounded set of tools or namespaces.

Skills must not duplicate complete tool schemas or grant tool authority. A
Skill's requested tools are intersected with runtime policy and current
availability. Explicitly selected multiple Skills may later compile into
ordered plan stages, but that pipeline remains a separate consumer of this
Harness rather than a special tool-discovery implementation.

## Persistence and User Experience

### Persistence

Complex Chat plans and Job plans use the same conceptual model. Chat associates
a plan with the conversation turn and active artifact lineage. Jobs associate
it with the durable Job and Agent execution.

Persisted state includes:

- plan and revision history;
- step attempts and statuses;
- contract digests;
- input bindings and sanitized arguments;
- result evidence and artifact IDs;
- approval records;
- replanning reasons;
- token, timing, and error summaries where available.

Tool permissions are recomputed and are never persisted as reusable authority.

### User-visible projection

The UI presents a concise projection rather than the complete internal plan:

- current objective;
- completed steps;
- current action;
- waiting approval or clarification;
- recoverable failure and retry state;
- final produced artifacts.

Detailed contracts, raw reasoning, and internal routing prompts are not shown.
Existing trajectory and Job Log surfaces remain the diagnostic view.

## Existing Component Integration

The design evolves existing components rather than replacing them wholesale:

- `global-chat-tools.ts` continues to discover MCP and native tools, then
  registers them through the normalized Registry instead of directly exposing
  the complete set.
- `agent-tool-policy.ts` consumes explicit contract annotations; its name-based
  predicates become a warning-producing legacy fallback.
- `agent-runtime.ts` continues to apply allowlists and approvals, but the
  allowlist is resolved per plan step or direct action.
- `agent-capabilities.ts` remains the runtime capability snapshot and gains
  namespace, version, availability, output-contract, and contract-digest
  fields as required. It is an audit snapshot, not the discovery index itself.
- `pipeline-resolver.ts` continues to intersect Skill requests with profile
  policy and current Registry availability.
- the Skill registry continues progressive instruction and reference loading.
- Agent trajectory, tool-call audit, and Job persistence remain the evidence
  and recovery foundation.

## Security and Failure Handling

- Unknown annotations fail closed for possible writes.
- User content, source articles, web pages, and tool results are untrusted data,
  not instructions that can expand tool permissions.
- Tools validate inputs again at the service boundary even after Harness schema
  validation.
- External publishing, deletion, credential changes, and similarly material
  actions require explicit policy and approval.
- Tool outputs are size-bounded and sanitized before entering later model
  context.
- Availability failures identify missing configuration without revealing
  secrets.
- Retry decisions follow the contract; the model cannot declare an unsafe write
  replayable.
- A failed validator records evidence and triggers retry, replan, or a clear
  user-facing failure. It cannot be converted to success by assistant prose.

## Evaluation

Tool selection quality is maintained through a versioned corpus of real user
requests. The initial corpus should contain at least 30–50 prompts covering
paraphrases, adjacent tools, entity ambiguity, writes, follow-up turns, removed
tools, and contract drift.

Representative cases include:

| Request | Expected behavior |
|---|---|
| “随便从 X 的 github 订阅拿一篇” | Resolve the X subscription, then use server-side sampling |
| “找 github 订阅中关于 agent 的内容” | Use filtered source-item search, not sampling |
| “看看今天 GitHub 热门项目” | Use GitHub daily trending, not the X subscription |
| “把刚才结果保存为草稿” | Restore artifact context, select draft creation, request approval |
| “更新刚才的写作方案” | Select writing-plan update, not draft update |

Each case evaluates:

- direct-versus-plan classification;
- namespace selection;
- selected tool sequence;
- parameter and evidence bindings;
- unnecessary calls;
- write and approval safety;
- objective and final-goal completion;
- behavior when a tool is unavailable, removed, or changed.

Contract lint and selection evals run whenever a tool, namespace, Skill binding,
or Harness prompt changes. Production trajectories may contribute anonymized
failure cases only through an explicit product policy; automatic self-modifying
contracts are out of scope.

## Rollout Strategy

### Phase 1: Contract foundation

- inventory MCP and native tools;
- add a canonical Tool Contract normalizer and Registry diagnostics;
- assign namespaces;
- improve descriptions and schemas;
- add explicit annotations to first-party tools;
- preserve current runtime behavior while detecting contract defects.

### Phase 2: Progressive discovery

- build namespace and tool-summary catalogs;
- add provider-independent Goal Router and Tool Resolver structured outputs;
- introduce dynamic per-action allowlists in Chat;
- retain an escape path to re-resolve another namespace within the same turn;
- establish the initial selection eval corpus.

### Phase 3: Persisted planning

- add the common plan, step, attempt, evidence, and revision model;
- use it for multi-step Chat requests;
- add objective validators and replanning;
- expose concise progress in Chat while retaining detailed trajectory logs.

### Phase 4: Shared consumers

- migrate scheduled Agents and response-writing Jobs to the common Registry and
  plan semantics;
- integrate ordered Skill pipelines as plan stages;
- remove obsolete static allowlists only after equivalent policy and regression
  coverage exists.

Each phase is independently releasable. Phase 1 must not change which user
requests execute; it establishes trustworthy contracts and measurements before
the Harness changes routing behavior.

## Acceptance Criteria

- Every callable first-party tool has a valid namespace, description, input
  schema, safety annotations, availability state, and contract digest.
- New write tools cannot become callable without explicit side-effect and
  approval metadata.
- The model initially receives namespace summaries rather than every full tool
  schema.
- Simple unambiguous reads can execute without a persisted plan.
- Complex or write-bearing tasks produce a persisted plan with dependencies,
  expected artifacts, and completion predicates.
- Each plan step receives only its selected tools and Harness controls.
- Tool result validation distinguishes transport success from objective
  completion.
- Removed, unavailable, or changed tools trigger deterministic replanning or a
  clear failure.
- Follow-up turns can load newly relevant tools without inheriting prior tool
  authority.
- Chat, Jobs, and Skill pipelines can consume the same Registry and plan model.
- The initial real-prompt selection suite passes agreed namespace, tool,
  parameter, approval, and completion assertions.
