# Worth Writing Article Job Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Intelligence Center “值得写” action queue an `expanded_article` writing job and place the completed article in the Drafts page.

**Architecture:** Reuse the existing `content_response_output` durable job and worker. The frontend submits one fixed `expanded_article` output, the backend exposes output/job progress in response details, and the worker-result endpoint makes the generated article the draft destination idempotently.

**Tech Stack:** FastAPI, SQLAlchemy async, PostgreSQL/SQLite test fixtures, TypeScript AI SDK worker, Next.js React, Vitest, pytest, Playwright.

## Global Constraints

- “值得写” must generate a complete editable article and must not publish.
- “创作资产” remains the original-source-plus-AI-evaluation path.
- Repeated clicks and worker callbacks must not create duplicate jobs or drafts.
- Existing unrelated worktree changes must remain untouched.

### Task 1: Backend output-to-draft contract

**Files:**
- Modify: `backend/content_response_service.py`
- Modify: `backend/routers/responses.py`
- Test: `backend/tests/test_responses_router.py`
- Test: `backend/tests/test_content_response_handoff.py`

**Interfaces:**
- Consumes: current `ContentResponseItem`, `ContentAnalysisRun`, `ContentResponseOutput`, and `ContentJob` models.
- Produces: `expanded_article` output jobs with `decision_status='worth_writing'`; worker-result responses that include an idempotent `article_draft_id` and set the response destination.

- [x] Write a failing router test that posts `/api/responses/{id}/outputs` with `expanded_article`, asserts a durable job is created, and asserts a repeated request returns the same output/job.
- [x] Run the focused router test and confirm it fails because the current status/output detail contract is incomplete.
- [x] Write a failing worker-result test that submits generated Markdown twice and asserts one `ArticleDraft`, `draft_ready`, and response destination link.
- [x] Run that focused test and confirm it fails because the current callback does not set the response destination.
- [x] Implement the smallest backend changes: keep the queued decision as `worth_writing`, expose output/job status in detail, and make expanded-article worker-result completion update the response destination idempotently.
- [x] Run both focused backend tests and the existing content-response handoff tests.

### Task 2: Frontend “值得写” submission and status

**Files:**
- Modify: `web/lib/api/responses.ts`
- Modify: `web/app/responses/ResponsesClient.tsx`
- Modify: `web/app/responses/ResponseDestinationDialog.tsx`
- Test: `web/app/responses/ResponsesClient.test.tsx`

**Interfaces:**
- Consumes: `createResponseOutputs(id, { analysis_run_id, output_types: ['expanded_article'] })` and response detail output status.
- Produces: direct button/shortcut submission, visible writing progress, and a Drafts link after worker completion.

- [x] Replace the draft-seed UI assertion with a failing test that clicks “值得写” and expects the output API call, no seed dialog, and a writing-status message.
- [x] Add a failing test for shortcut `1` using the same output API path.
- [x] Add a failing test for a completed `expanded_article` output rendering a link to `/drafts?draft=<id>`.
- [x] Run the focused React test and confirm the current destination API/seed dialog behavior fails those expectations.
- [x] Implement the API type and direct submit handler; retain the modal only for creative assets and preserve shortcut `2`.
- [x] Render queued/running/failed/complete output states from the response detail.
- [x] Run the focused React tests and ESLint on changed frontend files.

### Task 3: End-to-end verification

**Files:**
- Test: existing response/intelligence Playwright coverage if a suitable route assertion is available.

- [x] Run the backend response router and handoff tests together.
- [x] Run the focused TypeScript output-job tests and response-client tests.
- [ ] Run the relevant Playwright intelligence-center test against a healthy local runtime.
- [x] Run `git diff --check` and inspect the final diff for unrelated changes.
- [x] Audit each acceptance criterion from `docs/superpowers/specs/2026-08-07-worth-writing-article-job-design.md` against fresh test/runtime evidence.
