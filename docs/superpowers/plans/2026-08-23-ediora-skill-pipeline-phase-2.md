# Ediora Skill Pipeline Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax.

**Goal:** Build the durable ordered Skill Pipeline command service, API, and runner boundary on top of the Phase 1 interfaces without changing the existing Chat, Job, or physical database contracts.

**Architecture:** FastAPI accepts a server-resolved ordered invocation snapshot, persists it in existing content_jobs.input_data and content_job_steps.input_data JSON fields, and creates a deterministic macro plan. Pipeline commands lock the Job row and use plan_version, run_epoch, and request IDs for optimistic concurrency and idempotency. A runner executes one Stage at a time through an injected PipelineStageExecutor; the worker integration fails closed until a real Skill runtime adapter is supplied.

**Tech Stack:** FastAPI, Pydantic v2, SQLAlchemy async/PostgreSQL, existing Redis Job queue, existing AgentExecution and ExecutionArtifact services, pytest with the wems Python environment.

**Spec:** docs/superpowers/specs/2026-08-23-ediora-skill-pipeline-design.md

## Global Constraints

- Work only on feat/skill-pipeline-design or a successor isolated feature branch; do not edit develop or main directly.
- Keep /api/jobs and the physical tables content_jobs, content_job_steps, and content_job_events.
- SKILL.md remains authoritative and SKILL.json remains optional; this phase consumes Phase 1 resolved snapshots and does not invent a second Skill registry.
- Submitted invocation order and duplicates are immutable; the server never reorders, merges, or deduplicates them.
- Client display labels and client-provided snapshots are not authoritative; pipeline creation is a trusted server boundary and validates resolved snapshot shape before persistence.
- PostgreSQL remains the source of truth; Redis carries only durable Job IDs.
- Every Stage receives one Skill snapshot and one independent AgentExecution identity.
- Primary artifacts are append-only, exactly one per Stage attempt, and the active primary is the only artifact passed downstream.
- Retry creates a new attempt for the failed Stage; rerun creates new attempts from the selected Stage onward and supersedes downstream active artifacts without deleting history.
- Chat confirmation approves the plan only; it never grants publish, delete, upload, or credential access.
- Automatic Job mode persists the plan and enqueues immediately; Chat mode persists awaiting_confirmation and enqueues only after confirmation.
- Every mutating pipeline command accepts a non-empty request_id and is idempotent for the same Job and command kind.
- Use /home/violet/miniconda3/envs/wems/bin/python -m pytest for backend tests. The documented origin/main baseline failures are not part of this Phase 2 gate.

## File Map

- Create backend/pipeline_contracts.py for Pydantic contracts and strict normalization.
- Create backend/pipeline_service.py for transaction-owned creation, deterministic planning, snapshots, command idempotency, and stage-attempt preparation.
- Create backend/pipeline_runner.py for ordered Stage execution, executor protocol, primary validation, checkpoints, and the fail-closed runtime boundary.
- Modify backend/routers/jobs.py for pipeline creation, plan/command/read endpoints, artifact projection, and awaiting_confirmation status filtering.
- Modify backend/routers/chat.py for the trusted Chat-to-pipeline transaction.
- Modify backend/job_worker.py for skill_pipeline dispatch while preserving existing flow runners.
- Modify backend/job_reconciliation.py for pipeline recovery without auto-confirming Chat plans.
- Create backend/tests/test_pipeline_service.py.
- Create backend/tests/test_pipeline_runner.py.
- Modify backend/tests/test_jobs_router.py, backend/tests/test_chat_router.py, backend/tests/test_job_worker.py, and backend/tests/test_job_reconciliation.py.

## Phase Boundary

This phase implements the durable backend engine and API. It does not render Chat @ chips, add parameter pickers or foldable Stage cards, add the four first-party Skill packages, resolve Writing Plans or Publish Accounts from a browser request, execute uploaded package scripts, or claim that a real model can complete a writing pipeline.

The runner exposes a dependency-injected executor for integration tests and returns an explicit configuration failure when the production adapter is absent. This keeps automatic Jobs observable and safe instead of silently producing fake content.

---

### Task 1: Define and validate resolved pipeline contracts

**Files:**
- Create backend/pipeline_contracts.py
- Create backend/tests/test_pipeline_service.py

**Interfaces:**

~~~python
class PipelineContractError(ValueError):
    pass

class ResolvedSkillInvocation(BaseModel):
    invocation_id: str = Field(min_length=1, max_length=120)
    skill_name: str = Field(min_length=1, max_length=80, pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
    skill_display_name: str = Field(min_length=1, max_length=200)
    parameter_kind: Literal["writing_plan", "publish_account"] | None = None
    parameter_id: str | None = Field(default=None, min_length=1, max_length=120)
    parameter_display_name: str | None = Field(default=None, min_length=1, max_length=200)
    skill_snapshot: dict = Field(default_factory=dict)
    binding_snapshot: dict = Field(default_factory=dict)
    parameter_snapshot: dict | None = None
    capability_snapshot: dict = Field(default_factory=dict)

class PipelineCreateInput(BaseModel):
    objective: str = Field(min_length=1, max_length=20_000)
    invocations: list[ResolvedSkillInvocation] = Field(min_length=1, max_length=24)
    confirmation: Literal["interactive", "automatic"] = "interactive"
    title: str = Field(min_length=1, max_length=500)
    idempotency_key: str = Field(default="", max_length=200)

def normalize_invocations(value: Sequence[ResolvedSkillInvocation]) -> list[dict]:
    ...

def effective_tool_names(
    requested: Sequence[str],
    profile_allowed: Sequence[str],
    system_allowed: Sequence[str],
) -> list[str]:
    ...

def build_macro_plan(objective: str, invocations: Sequence[dict]) -> dict:
    ...
~~~

- [ ] Step 1: Write tests proving exact order and duplicate preservation, parameter fields are all-present or all-absent, macro plan keys are deterministic, normalized nested values are copied JSON rather than retaining Pydantic objects, and effective tools equal the requested/profile/system three-way intersection.
- [ ] Step 2: Run cd backend && /home/violet/miniconda3/envs/wems/bin/python -m pytest tests/test_pipeline_service.py -q and verify the expected missing-module failure.
- [ ] Step 3: Implement strict normalization. Reject duplicate invocation IDs, mismatched parameter fields, parameter snapshots without a parameter kind, non-object snapshots, recursively credential-looking keys, missing capability snapshot fields, and Skill identity/digest mismatches. Implement effective_tool_names as the stable ordered intersection of requested tools, the binding profile allowlist, and system policy; reject a supplied capability snapshot whose allowedToolNames differs from that result. Build stage keys as skill:01:name, skill:02:name, preserving input order.
- [ ] Step 4: Run the contract tests and commit:
  ~~~bash
  git add backend/pipeline_contracts.py backend/tests/test_pipeline_service.py
  git commit -m "feat: define skill pipeline contracts"
  ~~~

### Task 2: Persist pipeline Jobs and immutable Stage snapshots

**Files:**
- Create backend/pipeline_service.py
- Modify backend/tests/test_pipeline_service.py

**Interfaces:**

~~~python
async def create_pipeline_job(
    session: AsyncSession,
    request: PipelineCreateInput,
    *,
    commit: bool = True,
) -> ContentJob:
    ...

async def pipeline_job_payload(session: AsyncSession, job_id: int) -> dict:
    ...
~~~

- [ ] Step 1: Add a test creating three ordered invocations, including a duplicate and one parameterized Skill. Assert flow skill_pipeline, interactive status awaiting_confirmation, plan_version and run_epoch equal 1, pipeline_plan followed by exact ordered stage keys, queued Stage rows, and frozen parameter snapshots.
- [ ] Step 2: Run the test and verify failure because create_pipeline_job is absent.
- [ ] Step 3: Implement creation through create_or_get_job after normalization. Store objective, confirmation, invocations, and versioned plan under job.input_data.pipeline. Create a succeeded pipeline_plan step containing the macro plan. Create each Skill Stage as queued attempt 1 with only its own invocation, plan stage, objective, previous primary ID null, run epoch, and plan version. Use awaiting_confirmation for interactive and queued for automatic. Add one pipeline_created event. For non-empty idempotency keys, return the existing Job without duplicate steps or events.
- [ ] Step 4: Implement pipeline_job_payload with ordered stages, plan_version, run_epoch, redacted snapshots, events, active/all artifacts, and no raw Skill instructions or credential fields.
- [ ] Step 5: Run:
  ~~~bash
  cd backend
  /home/violet/miniconda3/envs/wems/bin/python -m pytest tests/test_pipeline_service.py tests/test_content_jobs.py tests/test_models_schema.py -q
  ~~~
- [ ] Step 6: Commit:
  ~~~bash
  git add backend/pipeline_service.py backend/tests/test_pipeline_service.py
  git commit -m "feat: persist ordered skill pipelines"
  ~~~

### Task 3: Implement idempotent plan and recovery commands

**Files:**
- Modify backend/pipeline_service.py
- Modify backend/tests/test_pipeline_service.py

**Interfaces:**

~~~python
async def confirm_pipeline(session: AsyncSession, *, job_id: int, plan_version: int, request_id: str) -> ContentJob: ...
async def revise_pipeline_plan(session: AsyncSession, *, job_id: int, plan_version: int, request_id: str, stage_instructions: dict[str, str]) -> ContentJob: ...
async def cancel_pipeline(session: AsyncSession, *, job_id: int, request_id: str) -> ContentJob: ...
async def retry_pipeline_stage(session: AsyncSession, *, job_id: int, stage_key: str, request_id: str) -> ContentJob: ...
async def rerun_pipeline_stage(session: AsyncSession, *, job_id: int, stage_key: str, request_id: str) -> ContentJob: ...
~~~

- [ ] Step 1: Add tests for confirmation, stale plan conflict, revision of descriptions only, cancellation, failed-stage retry, successful-stage rerun, duplicate request IDs, and cross-command request ID reuse.
- [ ] Step 2: Run the tests and verify command assertions fail.
- [ ] Step 3: Store command outcomes as ContentJobEvent payloads containing request_id, command, and result. Under lock_content_job_row, return the current Job for an exact command/request match and reject reuse across command kinds.
- [ ] Step 4: Implement confirm for awaiting_confirmation only, revise for awaiting_confirmation only with plan_version checking, cancel for awaiting_confirmation/queued/running, retry for a failed retryable latest Stage, and rerun from a succeeded Stage. Revision may change only instruction strings. Retry creates attempt + 1. Rerun supersedes active artifacts from the selected position onward, creates queued attempts through the end, resets the Job, and increments run_epoch once.
- [ ] Step 5: Run cd backend && /home/violet/miniconda3/envs/wems/bin/python -m pytest tests/test_pipeline_service.py -q and commit with message feat: add idempotent pipeline commands.

### Task 4: Add the ordered Stage runner and fail-closed runtime adapter

**Files:**
- Create backend/pipeline_runner.py
- Modify backend/job_worker.py
- Create backend/tests/test_pipeline_runner.py
- Modify backend/tests/test_job_worker.py

**Interfaces:**

~~~python
class PipelineStageExecutor(Protocol):
    async def execute(self, session, job, step, execution) -> PipelineStageResult:
        ...

@dataclass(frozen=True)
class PipelineStageResult:
    primary_kind: str
    primary_title: str
    primary_text: str | None = None
    primary_structured: object | None = None
    auxiliary: tuple[PipelineAuxiliaryResult, ...] = ()

async def run_skill_pipeline_job(job_id: int, *, session_factory=SessionLocal, executor=None) -> None:
    ...
~~~

- [ ] Step 1: Add fake-executor tests recording stage key and previous primary artifact ID. Assert one AgentExecution per Stage, ordered calls, primary handoff, missing-primary failure, executor failure, cancellation, duplicate runner invocation, and resume after the first Stage is already complete.
- [ ] Step 2: Run runner and worker tests and verify missing-module failure.
- [ ] Step 3: Implement one-Stage-at-a-time execution. Load and lock the Job; return for cancelled, succeeded, or awaiting_confirmation. Select the first queued or resumable running Stage. Resolve the previous active primary, call ensure_agent_execution with exact Stage ID and attempt, emit preparing/running/checkpoint events, call the injected executor, reject empty or credential-bearing output, append auxiliary then primary artifacts, update output_data with artifact IDs, and succeed the Stage. After the last Stage, succeed the Job; otherwise enqueue the same Job ID. Catch exceptions, redact them, mark retryable only for PipelineRetryableError, and pause uncertain side effects without retrying.
- [ ] Step 4: Route skill_pipeline in job_worker.py while preserving every existing flow. The default FailClosedPipelineExecutor raises PipelineRuntimeNotConfigured and never invents output.
- [ ] Step 5: Run:
  ~~~bash
  cd backend
  /home/violet/miniconda3/envs/wems/bin/python -m pytest tests/test_pipeline_runner.py tests/test_job_worker.py tests/test_execution_artifacts.py tests/test_agent_execution_service.py -q
  ~~~
- [ ] Step 6: Commit:
  ~~~bash
  git add backend/pipeline_runner.py backend/job_worker.py backend/tests/test_pipeline_runner.py backend/tests/test_job_worker.py
  git commit -m "feat: add ordered skill pipeline runner"
  ~~~

### Task 5: Expose Pipeline Job and Chat creation/command APIs

**Files:**
- Modify backend/routers/jobs.py
- Modify backend/routers/chat.py
- Modify backend/tests/test_jobs_router.py
- Modify backend/tests/test_chat_router.py

**Interfaces:**

~~~text
POST /api/jobs
POST /api/jobs/{id}/confirm
POST /api/jobs/{id}/plan/revise
POST /api/jobs/{id}/cancel
POST /api/jobs/{id}/stages/{stage_key}/retry
POST /api/jobs/{id}/stages/{stage_key}/rerun
GET  /api/jobs/{id}
GET  /api/jobs/{id}/events?after={event_id}
POST /api/chat/sessions/{session_id}/pipelines
~~~

- [ ] Step 1: Extend the current FastAPI fixtures with a complete resolved invocation payload. Test automatic versus interactive creation/enqueue behavior, confirm and stale conflict, revise/retry/rerun request IDs, ascending event cursor, snapshot privacy, and Chat idempotency.
- [ ] Step 2: Run the Job and Chat router tests and verify the new route/model failures.
- [ ] Step 3: Extend JobCreate only for flow skill_pipeline. Require the trusted worker token for resolved pipeline snapshot creation, retain legacy local flow behavior, enqueue automatic mode after commit, and map pipeline errors to 404/409/422 without changing old routes. Apply the same trusted-worker dependency to Chat pipeline creation; the normal browser Chat route will call this backend boundary with its worker token.
- [ ] Step 4: Add command request models and routes. Use pipeline_job_payload for pipeline Jobs and preserve legacy response shapes for other Jobs. Include active and historical artifact projections.
- [ ] Step 5: Implement Chat pipeline creation in one transaction: lock session, reuse chat:{session_id}:{client_message_id}, append user structured parts, create interactive Job without committing, append an assistant pipeline-ref part with jobId and planVersion, append the pipeline-created event, and commit. Do not enqueue.
- [ ] Step 6: Run:
  ~~~bash
  cd backend
  /home/violet/miniconda3/envs/wems/bin/python -m pytest tests/test_jobs_router.py tests/test_chat_router.py tests/test_agent_executions_router.py -q
  ~~~
- [ ] Step 7: Commit:
  ~~~bash
  git add backend/routers/jobs.py backend/routers/chat.py backend/tests/test_jobs_router.py backend/tests/test_chat_router.py
  git commit -m "feat: expose skill pipeline commands"
  ~~~

### Task 6: Reconcile Pipeline Jobs and close the Phase 2 backend gate

**Files:**
- Modify backend/job_reconciliation.py
- Modify backend/tests/test_job_reconciliation.py
- Modify this plan file

- [ ] Step 1: Add tests proving awaiting_confirmation is never auto-enqueued, queued/running recoverable Jobs are enqueued once, succeeded/cancelled/uncertain Jobs are not auto-enqueued, and recovery creates no new Stage attempt.
- [ ] Step 2: Run the reconciliation tests and verify failure.
- [ ] Step 3: Extend reconciliation only for flow skill_pipeline. Reuse existing lease and queue abstractions; never confirm Chat plans, replay uncertain operations, or alter historical attempts. Add an append-only pipeline/reconciled event with the reason and run epoch.
- [ ] Step 4: Run the complete Phase 2 focused backend gate:
  ~~~bash
  cd backend
  /home/violet/miniconda3/envs/wems/bin/python -m pytest tests/test_pipeline_service.py tests/test_pipeline_runner.py tests/test_jobs_router.py tests/test_chat_router.py tests/test_job_worker.py tests/test_job_reconciliation.py tests/test_execution_artifacts.py tests/test_agent_execution_service.py tests/test_agent_executions_router.py tests/test_models_schema.py tests/test_database_skill_pipeline_migration.py -q
  ~~~
- [ ] Step 5: Run static checks:
  ~~~bash
  python3 -m compileall -q backend/pipeline_contracts.py backend/pipeline_service.py backend/pipeline_runner.py
  git diff --check origin/main...HEAD
  git status --short
  rg -n "wms|wemediastudio|WeMediaStudio" backend/pipeline_contracts.py backend/pipeline_service.py backend/pipeline_runner.py
  ~~~
- [ ] Step 6: Commit:
  ~~~bash
  git add backend/job_reconciliation.py backend/tests/test_job_reconciliation.py docs/superpowers/plans/2026-08-23-ediora-skill-pipeline-phase-2.md
  git commit -m "feat: reconcile skill pipeline jobs"
  ~~~

## Phase 2 Handoff

Report commit list, exact focused commands, order/duplicate/primary-handoff/retry/rerun/idempotency evidence, whether the real runtime adapter is intentionally absent, API privacy evidence, and any baseline failures not caused by this branch.

Do not start Phase 3 Chat UI implementation until the Phase 2 focused backend gate is green and the fail-closed runtime boundary has been reviewed.

## Primary References

- docs/superpowers/specs/2026-08-23-ediora-skill-pipeline-design.md
- docs/superpowers/plans/2026-08-23-ediora-skill-pipeline-phase-1.md
- Agent Skills specification: https://agentskills.io/specification
- Pi Skill formatter at audited commit: https://github.com/earendil-works/pi/blob/a1f955e9f47fd3379b44f4aace65ab916c80519a/packages/agent/src/harness/skills.ts#L38
