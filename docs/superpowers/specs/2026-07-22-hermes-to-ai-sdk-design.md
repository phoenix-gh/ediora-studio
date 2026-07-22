# Hermes removal and AI SDK orchestration

## Goal

Ship an open-source, self-hosted, single-user version of WeMedia Studio that
does not require Hermes, Hermes profiles, a Kanban CLI, or local agent
sessions. Preserve the existing collection, content, publishing, and data
assets, while making the runtime suitable for a later SaaS migration.

The first version has no login, tenant isolation, billing, or hosted-service
requirement. It must be deployable with Docker Compose and configured by
environment variables.

## Chosen architecture

Next.js is the product entry point. It owns the UI, AI SDK integration,
streaming progress, and the job-detail experience. Vercel AI SDK replaces the
Hermes-driven agent/tool loop for content creation.

Python remains an independent collection and content-processing service. It
continues to own source collectors, the existing SQLAlchemy/Postgres data
access, content-domain APIs, publishing-platform adapters, asset handling, and
long-running integrations. It does not execute an agent runtime.

Postgres is the source of truth for business data and jobs. Redis backs the
asynchronous work queue. Workers execute jobs outside HTTP request lifetimes.

```text
Browser
  -> Next.js: UI, AI SDK, job progress
  -> Python API: collection, content domain, publishing, assets
  -> Postgres: application and job state
  -> Redis + worker: durable asynchronous work
```

The Next.js service may invoke a narrow allowlist of Python APIs as AI tools.
The existing FastMCP endpoint is retained only during migration; it is not a
required end-user deployment surface. Business operations should have stable
HTTP APIs, with schema validation and authorization boundaries ready for a
future multi-tenant layer.

## Execution model

The system has no permanent roles such as `wms_editor`, `wms_writer`, or
`wms_illustrator`. A user action creates one persistent `content_job` with a
known flow and a sequence of deterministic steps.

Initial job states:

```text
queued -> running -> succeeded
                  -> failed
                  -> cancelled
```

Every step has its own status, timestamps, attempt count, structured input and
output summary, and safe error message. A retry creates a new attempt for the
failed step without repeating completed steps unless the user explicitly
restarts the job.

Initial content flow:

1. `brief`: produce a structured brief from a selected source, account profile,
   writing plan, and user instructions.
2. `draft`: produce and persist a draft from the brief and current prompt
   fragments.
3. `cover`: generate, upload, and link a cover asset to that draft.
4. `illustrations` (optional): generate and place inline article images.
5. `publish` (optional and explicit): invoke an existing publishing adapter;
   never publish as a side effect of a creation job.

The Vercel AI SDK uses bounded multi-step tool calls for `brief` and `draft`.
Tool schemas must be allowlisted per step and every write operation must be
idempotent with the job and step IDs. Cover and illustration work is queue
backed because it may outlive a server request.

## Component boundaries

### Next.js application

- Add the AI SDK and provider adapters.
- Provide create-job, job detail, cancel, and retry UI/API routes.
- Render streaming model text and structured step/tool events.
- Replace the Studio agent Kanban with a Jobs page: queue, running, succeeded,
  failed, duration, and retry state.
- Persist no provider key in browser code. Local self-hosting reads server-side
  environment variables; the existing settings model can be migrated later.

### Python collection/content service

- Keep collectors, source normalization, material search, drafts, publish
  accounts, publishing adapters, media upload, and existing Postgres models.
- Expose stable, typed endpoints for only the operations needed by creation
  steps. Do not expose shell, filesystem, arbitrary HTTP, or unrestricted
  database access as model tools.
- Move image-provider execution behind a service interface; remove the runtime
  dependency on the local Codex/Hermes skill path.
- Continue to run scheduled collection independently of creation jobs.

### Job/worker layer

- Add `content_jobs`, `content_job_steps`, and `content_job_events` data models.
- Run durable queued steps with a Redis-backed worker.
- Use database transactions and idempotency keys for draft/asset writes.
- Emit append-only events that the browser can poll initially; SSE can replace
  polling later without changing the storage model.

## Existing-code migration

Keep and reuse:

- collectors and scheduled collection logic;
- Postgres models for sources, materials, drafts, assets, accounts, plans and
  publishing;
- prompt fragments under `backend/prompts/`;
- content and asset APIs in the Python routers;
- MCP business-tool implementations during the transition, where they wrap
  reusable domain operations.

Refactor:

- `pipeline_template.py` into flow/step definitions and prompt builders, with
  no Hermes task text or `kanban_complete` instructions;
- the Studio UI and task timeline into a Jobs UI over persistent job/step data;
- configuration to isolate server-only model and image provider credentials.

Remove after replacement coverage exists:

- `backend/hermes_kanban_client.py`;
- Hermes subprocess code in `backend/routers/studio.py`;
- `backend/routers/retro.py` and terminal-resume UI;
- `backend/profile_manager.py`, profile routes, and profile/skill management
  UI that exist solely for Hermes;
- Hermes-specific task creation from daily planning, writing plans, GitHub,
  topic generation, and scheduler paths.

The `mcp_server.py` endpoint is evaluated separately after its tool logic has
been extracted into normal service functions. It must not be deleted merely
because Hermes is removed.

## Failure handling and safety

- Limit model tool calls and timeouts per step; model failure must mark only
  that step as failed with a retryable error.
- Validate all tool input with schemas and all domain writes on the Python
  service. The model never receives unrestricted credentials or executable
  shell access.
- Retain source URLs, prompt/version identifiers, selected model, provider
  response metadata, and cost/usage where available for job observability.
- Require explicit user action before publishing. Cancellation stops queued
  work; running external calls are best-effort aborted and must not cause a
  partial publish.
- Store provider/image configuration outside the repository. Docker Compose
  documents required values but contains no secrets.

## Verification and acceptance criteria

Automated tests must cover:

- job-state transitions, retries, cancellation, idempotent draft/asset writes,
  and safe recovery after worker restart;
- each initial flow's step construction and prompt inputs;
- Python API validation and queue handoff;
- AI SDK tool allowlists and tool input validation using mocked model calls;
- frontend rendering for queued/running/succeeded/failed jobs.

Manual acceptance:

1. A clean Docker Compose install starts the product without a Hermes binary,
   Hermes home directory, profile, Kanban board, or local Codex skill.
2. A user can collect/select a source, create a draft job, see progress, obtain
   a saved draft and cover, and retry one failed step.
3. Existing collector and explicit publishing workflows still work.
4. No source file, UI message, deployment guide, or runtime dependency requires
   Hermes for normal operation.

## Delivery sequence

1. Introduce job persistence, queue worker, and Jobs UI while leaving current
   Hermes flows untouched behind existing endpoints.
2. Implement the first AI SDK draft flow against a small, typed Python tool
   allowlist and verify output parity with the current editor/writer flow.
3. Move cover and inline-image generation to the worker and cloud-compatible
   image-provider adapter.
4. Move remaining creation entry points to jobs, then delete Hermes runtime and
   UI code once tests cover every former dispatch path.
5. Add Docker Compose documentation and a clean-environment end-to-end check.

This ordering maintains a working application throughout migration and keeps
the future SaaS seam at the job and service boundaries rather than in Hermes
profile state.
