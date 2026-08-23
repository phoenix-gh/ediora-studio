# Ediora Skill Pipeline Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Add the Ediora Chat experience for ordered `@技能` pipelines: structured multi-Skill chips, server-resolved parameters, confirmation, foldable durable progress, recovery controls, reconnect, and final assistant output.

**Architecture:** The browser stores only submitted Skill identities and parameter IDs. Next.js server routes resolve enabled Skill packages and authorized Writing Plans/Publish Accounts, sanitize parameter snapshots, and call the existing trusted FastAPI Chat Pipeline endpoint with the worker token. Chat renders the durable Job projection from `GET /api/jobs/{id}`; polling/refetch is only a transport concern, while PostgreSQL Job state remains authoritative.

**Tech Stack:** Next.js App Router, React, TypeScript, Base UI/shadcn primitives already present in `web/components/ui`, Vitest + Testing Library, existing FastAPI pipeline service/runner, PostgreSQL-backed Chat messages and Jobs.

**Spec:** `docs/superpowers/specs/2026-08-23-ediora-skill-pipeline-design.md`

## Global Constraints

- Work only on `feat/skill-pipeline-design` in `/tmp/WeMediaStudio-skill-pipeline-design`; do not edit `develop` or `main` directly.
- Keep the existing plain `/api/chat` flow and legacy single-Skill context selector working when no pipeline chip is submitted.
- Chip order is the submitted order; duplicate Skill selections are valid and must remain separate invocations.
- The browser must never receive or submit `SKILL.md` instructions, Skill directories, worker tokens, Publish Account credentials, or raw provider payloads.
- Parameter selection must use active server data; the server resolves and snapshots the entity in the same transaction as Chat Pipeline creation.
- All pipeline command request IDs are generated client-side per user action and sent through the existing idempotent Job commands.
- Use `cd web && pnpm exec vitest run <exact files>` for focused frontend tests; use the project’s existing Playwright workflow only after static tests pass.
- The fail-closed runtime remains an explicit limitation: without the Phase 4 Skill runtime adapter, a started Job may visibly fail with a retryable/non-retryable Stage state rather than fabricate content.

---

### Task 1: Expose server-owned Skill bindings and parameter options

**Files:**
- Modify: `web/app/api/chat/skills/route.ts`
- Create: `web/app/api/chat/pipeline-options/route.ts`
- Create: `web/app/api/chat/sessions/[sessionId]/pipelines/route.ts`
- Create: `web/lib/ai/pipeline-resolver.ts`
- Create: `web/app/api/chat/pipeline-options/route.test.ts`
- Create: `web/app/api/chat/sessions/[sessionId]/pipelines/route.test.ts`

**Interfaces:**

```ts
type SubmittedSkillInvocation = {
  invocationId: string
  skillName: string
  skillDisplayName: string
  parameterKind?: 'writing_plan' | 'publish_account'
  parameterId?: string
  parameterDisplayName?: string
}

type PipelineParameterOption = {
  id: string
  displayName: string
  kind: 'writing_plan' | 'publish_account'
  summary: string
  metadata: Record<string, unknown>
}

async function resolvePipelineInvocations(
  invocations: SubmittedSkillInvocation[],
): Promise<ResolvedSkillInvocationPayload[]>
```

- [ ] **Step 1: Write failing route tests.** Assert the options route returns only safe Writing Plan/Publish Account fields, filters inactive entities, and never returns `app_id`, `app_secret`, `token`, or Skill instructions. Assert the pipeline POST route rejects a missing/disabled Skill or wrong parameter kind before calling FastAPI, and sends a trusted worker request with server-generated snapshots for a valid ordered invocation list.
- [ ] **Step 2: Run the route tests to verify the expected missing-module/route failures.**

  ```bash
  cd web
  pnpm exec vitest run app/api/chat/pipeline-options/route.test.ts app/api/chat/sessions/[sessionId]/pipelines/route.test.ts
  ```

- [ ] **Step 3: Implement `pipeline-resolver.ts`.** Load `getEnabledSkill`, its references/preload context, and `resolveSkillBinding`; build a capability snapshot with `buildAgentCapabilitySnapshot` in Chat mode and a fail-closed empty effective tool set. Fetch the selected Writing Plan or Publish Account through the server-only `apiGet` + `workerHeaders`, require active status, and copy only the approved style/source fields. Build binding, Skill, parameter, and capability snapshots without exposing secrets to the response.
- [ ] **Step 4: Implement both Next routes.** Enrich `/api/chat/skills` with `parameterKind`, `parameterRequired`, display/binding output, and digest while omitting instructions. Implement query-based option search. POST `/api/chat/sessions/[sessionId]/pipelines` must validate the submitted shape, generate/use `client_message_id`, resolve every invocation in order, and call FastAPI `/chat/sessions/{id}/pipelines` with `workerHeaders()`.
- [ ] **Step 5: Run the route tests to verify they pass and commit.**

  ```bash
  git add web/app/api/chat/skills/route.ts web/app/api/chat/pipeline-options web/app/api/chat/sessions web/lib/ai/pipeline-resolver.ts
  git commit -m "feat: resolve chat pipeline skills server-side"
  ```

### Task 2: Add typed Chat and Job Pipeline clients

**Files:**
- Modify: `web/lib/api/chat.ts`
- Modify: `web/lib/api/jobs.ts`
- Modify: `web/lib/api/chat.test.ts`
- Modify: `web/lib/api/jobs.test.ts`

**Interfaces:**

```ts
createChatPipeline(sessionId: number, input: {
  clientMessageId: string
  objective: string
  title: string
  invocations: SubmittedSkillInvocation[]
}): Promise<{ job: ContentJob; userMessageId: number; assistantMessageId: number }>

confirmPipeline(jobId: number, planVersion: number, requestId: string): Promise<ContentJob>
revisePipeline(jobId: number, planVersion: number, requestId: string, stageInstructions: Record<string, string>): Promise<ContentJob>
cancelPipeline(jobId: number, requestId: string): Promise<ContentJob>
retryPipelineStage(jobId: number, stageKey: string, requestId: string): Promise<ContentJob>
rerunPipelineStage(jobId: number, stageKey: string, requestId: string): Promise<ContentJob>
```

- [ ] **Step 1: Add failing client tests.** Assert structured invocation order and duplicate entries are serialized unchanged, command paths carry request IDs, and a pipeline response exposes plan version, run epoch, stages, artifacts, and event cursor fields.
- [ ] **Step 2: Run the exact client tests and verify failures.**
- [ ] **Step 3: Add shared types and minimal API functions.** Extend `ChatSkill`, `ContentJob`, and `JobStatus` without changing legacy response consumers; keep browser-facing calls same-origin for Next BFF routes and use existing `apiFetch` for trusted backend Job reads/commands.
- [ ] **Step 4: Run the exact client tests and commit.**

  ```bash
  cd web
  pnpm exec vitest run lib/api/chat.test.ts lib/api/jobs.test.ts
  git add web/lib/api/chat.ts web/lib/api/chat.test.ts web/lib/api/jobs.ts web/lib/api/jobs.test.ts
  git commit -m "feat: add chat pipeline API clients"
  ```

### Task 3: Build the structured `@技能` composer and parameter picker

**Files:**
- Create: `web/components/features/chat/ChatSkillPipelinePicker.tsx`
- Create: `web/components/features/chat/ChatSkillPipelinePicker.test.tsx`
- Modify: `web/app/chat/ChatClient.tsx`
- Modify: `web/app/chat/ChatClient.test.tsx`
- Modify: `web/components/features/chat/ChatContextPicker.tsx` only where needed to preserve the existing draft/context behavior

**Interfaces:**

```tsx
<ChatSkillPipelinePicker
  skills={skills}
  invocations={invocations}
  open={skillPickerOpen}
  disabled={sending}
  onOpenChange={setSkillPickerOpen}
  onChange={setInvocations}
  onRemoveLast={removeLastInvocation}
/>
```

- [ ] **Step 1: Write failing component tests.** Cover typing `@` opens the Skill picker, selecting a no-parameter Skill appends one chip, selecting a parameterized Skill opens a searchable “选择写作方案” dialog, removing a chip preserves the remaining order, and selecting the same Skill twice creates two invocation IDs rather than deduplicating.
- [ ] **Step 2: Run the component tests and verify the missing picker/behavior failure.**
- [ ] **Step 3: Implement the picker.** Use the existing Popover/Dialog primitives; show chips as `@显示名` or `@显示名:参数名`; keep the popover focused for keyboard navigation; fetch parameter options on dialog open/query; use a mobile-safe Dialog layout; expose a single `onChange` array with immutable ordered entries.
- [ ] **Step 4: Integrate ChatClient.** Intercept an unmodified `@` in the textarea to open the picker, intercept Backspace on an empty input to remove the last chip, clear chips on new conversation, and preserve the current plain Chat/draft flow when the array is empty. Submit pipeline chips through `createChatPipeline` instead of `/api/chat`.
- [ ] **Step 5: Run picker and ChatClient tests, then commit.**

  ```bash
  cd web
  pnpm exec vitest run components/features/chat/ChatSkillPipelinePicker.test.tsx app/chat/ChatClient.test.tsx
  git add web/components/features/chat/ChatSkillPipelinePicker.tsx web/components/features/chat/ChatSkillPipelinePicker.test.tsx web/app/chat/ChatClient.tsx web/app/chat/ChatClient.test.tsx web/components/features/chat/ChatContextPicker.tsx
  git commit -m "feat: add ordered chat skill composer"
  ```

### Task 4: Render foldable durable Pipeline cards and recovery commands

**Files:**
- Create: `web/components/features/chat/ChatPipelineCard.tsx`
- Create: `web/components/features/chat/ChatPipelineCard.test.tsx`
- Create: `web/components/features/chat/usePipelineJob.ts`
- Create: `web/components/features/chat/usePipelineJob.test.ts`
- Modify: `web/app/chat/ChatClient.tsx`

**Interfaces:**

```tsx
<ChatPipelineCard
  initialJob={job}
  onTerminal={refreshActiveSession}
  onJobChange={setObservedJob}
/>
```

- [ ] **Step 1: Write failing card tests.** Assert awaiting-confirmation renders objective, ordered stages, parameter labels, expected outputs, and `开始执行/调整计划/取消`; current Stage is expanded; completed Stages are collapsed; failed/uncertain Stages remain expanded with evidence; pending Stages are compact; artifacts are independently foldable; retry and rerun actions call the correct command with a request ID.
- [ ] **Step 2: Run the card tests and verify the expected missing-component failure.**
- [ ] **Step 3: Implement pure projection components and command handlers.** Keep product-level summaries in the card; do not render raw prompts, provider payloads, or Agent Trajectory details. Add an instruction-only revision dialog, explicit rerun confirmation, disabled/loading states, and readable empty/error states.
- [ ] **Step 4: Implement `usePipelineJob`.** Fetch the durable Job on mount, poll active Jobs every two seconds, track `events.next_after` for reconnect/refetch, stop polling on terminal state, and expose a manual refresh. A reload must reconstruct the same card from the Job ID in the persisted `skill-pipeline-ref` part.
- [ ] **Step 5: Integrate pipeline-ref message rendering in `MessageBubble`.** Recognize both the current persisted `skill-pipeline-ref` and the contract’s `pipeline-ref` alias, load the Job by ID, render the card inside the assistant message, and refresh the Chat session after terminal success so a final normal assistant message appears.
- [ ] **Step 6: Run focused tests and commit.**

  ```bash
  cd web
  pnpm exec vitest run components/features/chat/ChatPipelineCard.test.tsx components/features/chat/usePipelineJob.test.ts app/chat/ChatClient.test.tsx
  git add web/components/features/chat/ChatPipelineCard.tsx web/components/features/chat/ChatPipelineCard.test.tsx web/components/features/chat/usePipelineJob.ts web/components/features/chat/usePipelineJob.test.ts web/app/chat/ChatClient.tsx
  git commit -m "feat: render durable chat pipeline cards"
  ```

### Task 5: Project the final primary artifact into normal Chat history

**Files:**
- Modify: `backend/pipeline_runner.py`
- Modify: `backend/tests/test_pipeline_runner.py`
- Modify: `backend/job_reconciliation.py`
- Modify: `backend/tests/test_job_reconciliation.py`

- [ ] **Step 1: Add a failing runner test.** For a Chat-created Pipeline whose final Stage succeeds, assert one normal assistant `ChatMessage` is appended with the active final primary text and a durable projection event; rerunning/re-delivering the same completed attempt must not append a duplicate.
- [ ] **Step 2: Run the focused runner test and verify it fails because no projection exists.**
- [ ] **Step 3: Implement idempotent projection.** Read the `chat_pipeline_created` event for the session/message relationship, append a normal assistant text part tied to `job_id`, `run_epoch`, and `primary_artifact_id`, and record `chat_pipeline_final_projected`. Leave old history untouched when a later explicit rerun creates a new active final artifact. Keep the projection split recoverable by reconciliation.
- [ ] **Step 4: Add reconciliation coverage for a succeeded Pipeline with a missing final Chat projection and repair it without a new Stage attempt.**
- [ ] **Step 5: Run the focused backend tests and commit.**

  ```bash
  cd backend
  /home/violet/miniconda3/envs/wems/bin/python -m pytest tests/test_pipeline_runner.py tests/test_job_reconciliation.py -q
  git add pipeline_runner.py job_reconciliation.py tests/test_pipeline_runner.py tests/test_job_reconciliation.py
  git commit -m "feat: project pipeline output into chat history"
  ```

### Task 6: Phase 3 verification and rendered-flow gate

**Files:**
- Modify: `docs/superpowers/plans/2026-08-23-ediora-skill-pipeline-phase-3.md` with the verification result only

- [ ] **Step 1: Run the focused frontend suite.**

  ```bash
  cd web
  pnpm exec vitest run \
    app/chat/ChatClient.test.tsx \
    components/features/chat/ChatSkillPipelinePicker.test.tsx \
    components/features/chat/ChatPipelineCard.test.tsx \
    components/features/chat/usePipelineJob.test.ts \
    lib/api/chat.test.ts \
    lib/api/jobs.test.ts \
    app/api/chat/pipeline-options/route.test.ts \
    app/api/chat/sessions/[sessionId]/pipelines/route.test.ts
  ```

- [ ] **Step 2: Run changed-file ESLint/type/build checks using the repository’s existing scripts, recording unrelated baseline failures separately.**
- [ ] **Step 3: Start the current Chat shell with the project’s existing dev command and use the frontend-testing-debugging workflow.** The flow under test is: `/chat` → type `@` → select two Skills including a duplicate/parameterized one → send → inspect awaiting-confirmation card → confirm → reload/reconnect → inspect foldable Stage/artifact state → exercise failure retry/rerun where the fail-closed runtime permits.
- [ ] **Step 4: Capture desktop and narrow/mobile evidence, check page identity, non-blank DOM, no framework overlay, console health, and at least one interaction state change. Do not claim the real-model workflow passes while the Phase 4 runtime adapter is absent.
- [ ] **Step 5: Update this plan with exact commands/results, run `git diff --check origin/main...HEAD`, inspect `git status --short`, and report remaining Phase 4 limitations. Do not push or create a PR without a separate user instruction.

## Phase 3 Handoff

The handoff must distinguish:

- structured composer and server-side resolution verified;
- durable Job card/reconnect/recovery behavior verified;
- final Chat projection verified or explicitly blocked;
- rendered browser evidence and any unavailable Browser/plugin fallback;
- fail-closed runtime and missing first-party `source-research`/`writing-plan`/`humanize-writing`/`account-voice` packages, which remain Phase 4 work.

## Verification record

- Focused frontend suite: `8 passed`, `29 passed` with the Chat client, ordered Skill picker, pipeline card, Job hook, API clients, and both pipeline routes.
- Focused backend suite: `36 passed` for `tests/test_pipeline_runner.py tests/test_job_reconciliation.py` using `/home/violet/miniconda3/envs/wems/bin/python`.
- Changed-file ESLint: passed for every changed `web` TypeScript/TSX file.
- `web/pnpm exec tsc --noEmit`: the repository baseline still reports errors in `e2e/extension-auto-schedule.spec.ts`, `lib/ai/daily-creation-agent-job.test.ts`, `lib/ai/global-chat-tools.test.ts`, `lib/text-video/scene-plan.test.ts`, and `remotion/contract.test.ts`; no Phase 3 changed file was reported.
- `web/pnpm build`: passed on Next.js 16.2.4. The existing dynamic file-tracing warning from `next.config.ts`/`lib/skills/registry.ts` remains, but did not fail the build.
- Rendered fallback flow: Browser connector was unavailable, so Playwright 1.62 was used. With mocked BFF responses, `/chat` rendered the ordered duplicate/parameterized Skill flow, submitted the expected invocation order, displayed the awaiting-confirmation card, and had no bad responses or console errors. The current real latest session was already running, so its composer was correctly disabled; this is an environment state, not a real-model success claim. The narrow viewport also retains the existing fixed navigation shell behavior.
- Phase 3 remains fail-closed at runtime. First-party `source-research`, `writing-plan`, `humanize-writing`, and `account-voice` runtime packages are intentionally deferred to Phase 4.
