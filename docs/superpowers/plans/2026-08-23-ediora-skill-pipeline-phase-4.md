# Ediora Skill Pipeline Phase 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the production path for the ordered Skill Pipeline so the four first-party Skills execute as independent durable stages from both Chat and automatic Jobs.

**Architecture:** Keep the existing TypeScript content worker as the production executor and reuse `openAgentRuntime` for exactly one frozen Skill per Stage. Add worker-authenticated backend transitions that atomically persist validated artifacts, Agent completion state, Stage state, final Chat projection, and the next queue handoff. Keep the existing Python runner and database model as compatibility/reconciliation code; do not introduce a second model runtime or rename physical job tables.

**Tech Stack:** Next.js 16, AI SDK 7, TypeScript, Zod 4, FastAPI, SQLAlchemy async, PostgreSQL, Redis, Vitest, pytest.

**Spec:** `docs/superpowers/specs/2026-08-23-ediora-skill-pipeline-design.md`

## Global Constraints

- Each invocation remains one ordered Stage; duplicate Skills are preserved.
- The standard `SKILL.md` package is authoritative; `SKILL.json` is optional and scripts are never implicitly executed.
- PostgreSQL remains the source of truth; Redis transports only durable Job IDs.
- Worker transitions require `X-Worker-Token` and validate Job, Stage, attempt, epoch, and Agent execution ownership.
- Automatic Jobs use only the frozen capability allowlist and never receive publication, deletion, or external-upload tools.
- Stage input uses the original objective, frozen parameter snapshot, and previous active primary artifact as untrusted data around Skill instructions.
- Artifact writes are append-only, secret-rejecting, bounded, and idempotent for a completed attempt.
- Preserve existing Chat, scheduled flows, historical Jobs, and the additive migration contract.
- Run focused tests, changed-file lint, build, and rendered/worker smoke evidence before claiming completion.

---

### Task 1: Add first-party standard Skills and capability bindings

**Files:**
- Create: `web/skills/source-research/SKILL.md`
- Create: `web/skills/writing-plan/SKILL.md`
- Create: `web/skills/humanize-writing/SKILL.md`
- Create: `web/skills/account-voice/SKILL.md`
- Modify: `web/lib/skills/bindings.ts`
- Modify: `web/lib/skills/bindings.test.ts`
- Modify: `web/lib/ai/pipeline-resolver.ts`
- Modify: `web/lib/ai/pipeline-resolver.test.ts`

**Interfaces:**
- Each package supplies standard frontmatter, a stable slug, version, and domain instructions only.
- Bindings supply display name, parameter kind, primary output, capability profile, requested tools, and profile allowlist.
- `resolvePipelineInvocations()` returns a `job` capability snapshot whose allowed names equal the three-way policy intersection.

- [x] **Step 1: Write failing package and binding tests.** Assert all four packages are discovered without `SKILL.json`; `writing-plan` requires `writing_plan`; `account-voice` requires `publish_account`; first-party output/profile/tool fields are stable; credentials and package scripts are absent from snapshots.
- [x] **Step 2: Run the focused Skill tests and verify RED.**

  ```bash
  cd web
  pnpm exec vitest run lib/skills/bindings.test.ts lib/skills/bundled-skills.test.ts lib/ai/pipeline-resolver.test.ts
  ```

- [x] **Step 3: Add the four standard `SKILL.md` packages.** `source-research` must use only read-only `web_search`/`fetch_url`; `writing-plan` must consume the frozen Writing Plan and research artifact; `humanize-writing` must preserve facts and structure; `account-voice` must consume only the sanitized account style snapshot and never publish.
- [x] **Step 4: Extend bindings and resolver capability snapshots.** Use `mode: "job"`, automatic approval, and explicit profile allowlists. Build safe static descriptors for the frozen allowed tool names while the worker later pins the live schema snapshot.
- [x] **Step 5: Run focused tests and commit.**

  ```bash
  git add web/skills/source-research web/skills/writing-plan web/skills/humanize-writing web/skills/account-voice web/lib/skills/bindings.ts web/lib/skills/bindings.test.ts web/lib/ai/pipeline-resolver.ts web/lib/ai/pipeline-resolver.test.ts
  git commit -m "feat: add first-party pipeline skills"
  ```

### Task 2: Create worker-only durable Stage transitions

**Files:**
- Modify: `backend/pipeline_service.py`
- Modify: `backend/routers/jobs.py`
- Modify: `backend/agent_execution_service.py`
- Modify: `backend/tests/test_pipeline_service.py`
- Modify: `backend/tests/test_jobs_router.py`
- Modify: `backend/tests/test_agent_execution_service.py`

**Interfaces:**
- Add `start_pipeline_stage(session, job_id, step_id, attempt, run_epoch)`.
- Add `complete_pipeline_stage(session, job_id, step_id, attempt, run_epoch, execution_id, primary, auxiliary, completion_evidence)`.
- Add `fail_pipeline_stage(session, job_id, step_id, attempt, run_epoch, error, retryable)`.
- Expose worker-authenticated routes under `/api/jobs/{job_id}/pipeline/stages/{step_id}/start|complete|fail`.

- [x] **Step 1: Write failing backend transition tests.** Cover start idempotence and ordering, stale attempt/epoch rejection, completion with one primary and auxiliary artifacts, secret rejection, duplicate completion without duplicate artifacts, non-final queue handoff, final Chat projection, and failure state.
- [x] **Step 2: Run the focused backend tests and verify RED.**

  ```bash
  cd backend
  /home/violet/miniconda3/envs/wems/bin/python -m pytest tests/test_pipeline_service.py tests/test_jobs_router.py tests/test_agent_execution_service.py -q
  ```

- [x] **Step 3: Implement locked transitions.** Validate the Stage belongs to the Job and current run epoch, enforce previous primary success, use `append_execution_artifact`, update the matching AgentExecution, and append business events in the same transaction. On a non-final success set the Job to `queued` and enqueue once; on final success call the existing idempotent Chat projection repair path.
- [x] **Step 4: Add strict worker request schemas and route dependencies.** Limit artifact sizes and auxiliary count, reject credential-looking structured fields and secret patterns, return redacted pipeline payloads, and never expose Skill instructions through public Job reads.
- [x] **Step 5: Run focused backend tests and commit.**

  ```bash
  git add backend/pipeline_service.py backend/routers/jobs.py backend/agent_execution_service.py backend/tests/test_pipeline_service.py backend/tests/test_jobs_router.py backend/tests/test_agent_execution_service.py
  git commit -m "feat: persist pipeline stages from worker"
  ```

### Task 3: Implement the production TypeScript Skill Pipeline worker

**Files:**
- Create: `web/lib/ai/skill-pipeline-job.ts`
- Create: `web/lib/ai/skill-pipeline-job.test.ts`
- Modify: `web/scripts/content-worker.ts`
- Modify: `web/lib/ai/job-client.ts`
- Modify: `web/lib/ai/agent-execution-client.ts`
- Modify: `web/lib/ai/daily-creation-agent-job.ts` only if shared helper extraction is required

**Interfaces:**
- `runSkillPipelineJob(jobId, dependencies?)` loads one durable Job, runs at most one Stage attempt, and relies on backend completion to enqueue the next Stage.
- The runtime uses `openAgentRuntime({ mode: "job", skillMode: "manual", automaticSelection: false })` with the Stage Skill name and frozen tool allowlist.
- `resolveContentJobRunner("skill_pipeline")` returns `runSkillPipelineJob`.

- [x] **Step 1: Write failing worker tests.** Use injected API/runtime/model dependencies to assert ordered Stage selection, duplicate-preserving stage identity, previous primary transfer, exact frozen Skill selection, capability allowlist enforcement, accepted validation output, blocked validation failure, and no invocation for terminal/awaiting-confirmation Jobs.
- [x] **Step 2: Run the focused worker tests and verify RED.**

  ```bash
  cd web
  pnpm exec vitest run lib/ai/skill-pipeline-job.test.ts scripts/content-worker.test.ts
  ```

- [x] **Step 3: Add worker API clients and extend Agent execution identity.** Pass `stepId` and `attempt` to `ensureAgentExecution`; add start/complete/fail Stage calls with worker headers and typed artifact payloads.
- [x] **Step 4: Implement one-Stage execution.** Load the local standard Skill by name, verify the frozen digest/version, build untrusted stage context from the original objective, parameter snapshot, and previous artifact, open the existing runtime with `policyProfile: "scheduled"` plus the frozen allowlist, persist Agent messages/tool audits/checkpoints, and reject approval-pending or validation-failed output for automatic Jobs.
- [x] **Step 5: Persist primary and auxiliary artifacts through the backend transition.** Store the accepted text as the binding's declared primary kind and a compact Skill-run audit as auxiliary evidence; never store raw provider payloads or reasoning in the product artifact.
- [x] **Step 6: Wire the worker dispatch and run focused tests.**

  ```bash
  git add web/lib/ai/skill-pipeline-job.ts web/lib/ai/skill-pipeline-job.test.ts web/scripts/content-worker.ts web/scripts/content-worker.test.ts web/lib/ai/job-client.ts web/lib/ai/agent-execution-client.ts
  git commit -m "feat: execute skill pipelines in content worker"
  ```

### Task 4: Make recovery and automatic Job behavior production-safe

**Files:**
- Modify: `backend/job_reconciliation.py`
- Modify: `backend/pipeline_runner.py`
- Modify: `backend/tests/test_job_reconciliation.py`
- Modify: `web/lib/ai/skill-pipeline-job.ts`
- Modify: `web/lib/ai/skill-pipeline-job.test.ts`
- Modify: `docs/superpowers/specs/2026-08-23-ediora-skill-pipeline-design.md` only for verified compatibility notes

- [x] **Step 1: Add recovery tests.** Prove duplicate queue delivery does not create another attempt, a completed Stage with an incomplete AgentExecution is repaired, a queued next Stage is re-enqueued, an uncertain tool outcome fails closed, and final Chat projection is repaired without rerunning a Stage.
- [x] **Step 2: Run the focused recovery tests and verify RED.**
- [x] **Step 3: Implement reconciliation and worker restart handling.** Treat backend transition state as authoritative; resume only queued/running safe work, never replay an uncertain side effect, and keep the Python runner compatible for existing direct callers.
- [x] **Step 4: Run focused backend and worker tests and commit.**

### Task 5: Complete the four-Stage vertical smoke and documentation gate

**Files:**
- Create or modify: focused Chat/Job vertical test fixtures under `web/lib/ai/` and `backend/tests/`
- Modify: `docs/superpowers/plans/2026-08-23-ediora-skill-pipeline-phase-4.md`
- Modify: `docs/superpowers/specs/2026-08-23-ediora-skill-pipeline-design.md` only if evidence changes an approved boundary

- [x] **Step 1: Add a deterministic mocked vertical test.** Execute `source-research -> writing-plan:<id> -> humanize-writing -> account-voice:<id>` from automatic Job mode; assert four independent executions, source artifacts, primary transfer, frozen plan/account snapshots, no credential fields, one final normal assistant message, and retained foldable intermediate artifacts.
- [x] **Step 2: Add Chat mode coverage.** Assert confirmation is required before the first Stage, reload reconstructs the card, confirm enqueues the Job, and terminal projection appears in normal Chat history.
- [x] **Step 3: Run the migration/data-preservation regression suite.** Re-run the populated PostgreSQL fixture twice and the Phase 1-3 focused suites; do not use a green narrow test as proof of the entire release.
- [x] **Step 4: Run changed-file ESLint, TypeScript/build, worker smoke, and rendered Chat fallback evidence.** Record unrelated baseline failures separately and do not claim a real-model smoke without configured model credentials.
- [x] **Step 5: Update this plan with exact results, run `git diff --check origin/main...HEAD`, inspect `git status --short`, and commit the verification record. Do not push or create a PR without user instruction.**

## Phase 4 Verification Record

- First-party package/binding gate: `cd web && pnpm exec vitest run lib/skills/bindings.test.ts lib/skills/bundled-skills.test.ts lib/ai/pipeline-resolver.test.ts` — 3 files, 14 tests passed. All four packages are standard `SKILL.md` directories without executable files or required `SKILL.json`.
- Worker/API gate: `cd web && pnpm exec vitest run lib/ai/skill-pipeline-job.test.ts lib/ai/agent-execution-client.test.ts scripts/content-worker.test.ts` — 3 files, 34 tests passed. The production resolver now dispatches `skill_pipeline` to the TypeScript worker.
- Chat/Job frontend vertical gate: the Phase 1–4 focused set covering ChatClient, Skill picker, Pipeline card, Job hook, API routes/clients, first-party bindings, worker, and pipeline worker — 10 files, 60 tests passed.
- Backend pipeline/recovery gate: `tests/test_pipeline_service.py` — 16 passed; `tests/test_jobs_router.py` — 19 passed; `tests/test_pipeline_runner.py tests/test_agent_execution_pipeline.py tests/test_execution_artifacts.py` — 14 passed. The final combined migration/service/runner/reconciliation/router run passed 73 tests.
- Final worker-stage route coverage includes worker authentication, stale epoch rejection, ordered handoff, one-time queueing, failure idempotence, credential rejection, final Chat projection, and completion response-loss recovery without duplicate artifacts.
- Migration/data preservation: `tests/test_database_skill_pipeline_migration.py tests/test_database_init_postgres.py` — 10 passed, including two idempotent startup upgrades with populated legacy rows and preserved snapshots/counts.
- Changed-file ESLint passed for all changed frontend files. Python changed files compile with `compileall`.
- `pnpm build` passed on Next.js 16.2.4. The existing dynamic file-tracing warning from `next.config.ts`/`lib/skills/registry.ts` remains non-fatal.
- `pnpm exec tsc --noEmit` still reports only the repository baseline files `e2e/extension-auto-schedule.spec.ts`, `lib/ai/daily-creation-agent-job.test.ts`, `lib/ai/global-chat-tools.test.ts`, `lib/text-video/scene-plan.test.ts`, and `remotion/contract.test.ts`; no Phase 4 production file is reported. Next production build type checking passed.
- Rendered Chat fallback evidence remains the Phase 3 Playwright 1.62 mocked-BFF run because the Browser connector is unavailable. It rendered the ordered duplicate/parameterized flow, awaiting-confirmation card, and no bad responses/console errors. No real-model success is claimed without model credentials. The existing fixed navigation behavior at narrow width remains unrelated baseline behavior.
- `git diff --check origin/main...HEAD` passed. No push or PR was created.

## Phase 4 Handoff

Completion requires evidence for both production entry modes, the four independent first-party Skills, durable artifacts and Agent audits, no credential leakage, migration preservation, automatic queue handoff, Chat confirmation/projection, recovery, and the existing Phase 1-3 gates.
