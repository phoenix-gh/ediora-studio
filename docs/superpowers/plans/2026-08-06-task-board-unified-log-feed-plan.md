# 任务看板统一日志列表 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将任务看板的重复“运行日志/全部任务”合并为唯一的 ContentJob 日志列表，并支持筛选、游标分页和滚动加载。

**Architecture:** 后端 `/jobs` 提供稳定游标分页和定时任务关联摘要；前端由 `TaskLogList` 负责筛选、分页、轮询合并和滚动 sentinel，任务详情统一复用 `JobLogDialog`。规则安排和顶部仪表盘继续由现有 creation dashboard 提供。

**Tech Stack:** FastAPI、SQLAlchemy、Next.js、React、TypeScript、Vitest、Testing Library、Playwright。

## Global Constraints

- 任务列表以 `ContentJob` 作为唯一展示实体，不同时渲染 `DailyCreationRun` 日志列表。
- 详情继续使用对话框，不新增抽屉。
- 完整 Agent 消息只在详情打开时加载，不放进列表响应。
- 游标由后端生成，前端不解析游标内容。
- 保留规则配置、运行、取消、重试和 Agent 执行语义。

### Task 1: Define the paginated Job API contract

**Files:**
- Modify: `backend/routers/jobs.py`
- Modify: `wemedia-studio/lib/api/jobs.ts`
- Test: `backend/tests/test_jobs_router.py`
- Test: `wemedia-studio/lib/api/jobs.test.ts`

**Interfaces:**
- `GET /api/jobs?limit=30&cursor=<opaque>&kind=scheduled|manual&status=<status>` returns `{ jobs: ContentJob[], next_cursor: string | null, has_more: boolean }`.
- `listJobs(options?: { limit?: number; cursor?: string; kind?: 'scheduled' | 'manual'; status?: JobStatus })` returns the paginated response.
- Each job payload may include `schedule?: { run_id: number; rule_name: string; trigger_kind: string; scheduled_for: string } | null`.

- [ ] **Step 1: Write failing backend tests** for first-page response, cursor response, status/kind filters, stable ordering, and scheduled metadata.
- [ ] **Step 2: Run the focused backend tests** with `/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_jobs_router.py -q`; confirm the response contract is currently missing.
- [ ] **Step 3: Implement opaque cursor encoding/decoding** using the `(created_at, id)` ordering boundary; reject malformed cursors with HTTP 400 and clamp `limit` to 1–100.
- [ ] **Step 4: Join scheduled jobs to their creation run/rule snapshot** only for list metadata; keep Agent message/tool payloads out of the list response.
- [ ] **Step 5: Update the TypeScript API types and query builder** while keeping existing callers able to request the first page.
- [ ] **Step 6: Run backend and API client tests** and confirm the new response is green.

### Task 2: Build the unified scrollable task log list

**Files:**
- Create: `wemedia-studio/app/creation-rules/TaskLogList.tsx`
- Test: `wemedia-studio/app/creation-rules/TaskLogList.test.tsx`
- Modify: `wemedia-studio/app/creation-rules/CreationRulesClient.tsx`
- Modify: `wemedia-studio/app/creation-rules/CreationJobPanel.tsx`

**Interfaces:**
- `TaskLogList({ refreshToken, onRetry, onCancel }: { refreshToken: number; onRetry: (jobId: number, stepKey: string) => void; onCancel: (jobId: number) => void })` owns list state and renders `JobLogDialog`.
- `TaskLogList` uses `listJobs` with `limit=30`, filters, and opaque `next_cursor`; it exposes no raw Agent logs in row data.

- [ ] **Step 1: Write failing component tests** for first load, empty state, filter query, append loading, duplicate Job ID merging, end-of-list state, and clicking “查看日志” to open the dialog.
- [ ] **Step 2: Run the focused Vitest test** and confirm the new component behavior is absent.
- [ ] **Step 3: Implement local state for filters, jobs, cursor, `hasMore`, initial/append errors, and selected Job.** Use a `Map<number, ContentJob>` merge so refreshes cannot duplicate rows.
- [ ] **Step 4: Implement the scroll container and `IntersectionObserver` sentinel** with a visible “加载更多/重试加载” fallback button and no concurrent append requests.
- [ ] **Step 5: Add status polling** that refreshes the first page when queued/running jobs exist and merges updates by Job ID without discarding older pages.
- [ ] **Step 6: Replace the two current log sections** in `CreationRulesClient` with one `TaskLogList`; keep `CreationRulesPanel` and the dashboard cards unchanged.
- [ ] **Step 7: Run the component tests** and confirm detail loading still uses the existing `JobLogDialog`.

### Task 3: Remove duplicate log presentation and preserve actions

**Files:**
- Modify: `wemedia-studio/app/creation-rules/CreationRulesClient.tsx`
- Modify: `wemedia-studio/app/creation-rules/CreationJobPanel.tsx` or remove it after reference checks
- Modify/Delete: `wemedia-studio/app/creation-rules/CreationRunLog.tsx` and its test if no longer referenced
- Modify: `wemedia-studio/app/creation-rules/CreationRulesClient.test.tsx`
- Modify: `wemedia-studio/app/creation-rules/CreationRunLog.test.tsx` if the component is removed

**Interfaces:**
- The page renders exactly one heading for the task log list: `任务日志`.
- Rule runs remain available to `CreationRulesPanel` for active-rule state but are not rendered as a second log list.
- `JobLogDialog` remains the only task detail dialog and continues to fetch `/jobs/{job_id}/agent-log` on open.

- [ ] **Step 1: Add a failing page-level assertion** that the task board has one task log section and no “运行日志”/“全部任务” duplicate sections.
- [ ] **Step 2: Remove the old `CreationRunLog` rendering and the parent-owned full Job list state.** Keep dashboard refresh and mutation callbacks.
- [ ] **Step 3: Pass a refresh token to `TaskLogList` after cancel/retry and ensure the first page reloads without duplicate rows.
- [ ] **Step 4: Update or remove obsolete tests** that mock both list sources and assert the old headings.
- [ ] **Step 5: Run the page-level tests** and confirm rule editing, manual run, cancel, retry, and details remain connected.

### Task 4: Validate rendered desktop/mobile behavior

**Files:**
- Modify: `wemedia-studio/app/creation-rules/TaskLogList.tsx` only if visual QA exposes layout issues.
- Test: existing Playwright/e2e surface if available; otherwise use a temporary `/tmp` Playwright script.

- [ ] **Step 1: Start/check the local app at `http://127.0.0.1:3000/creation-rules`.**
- [ ] **Step 2: Verify page identity, nonblank content, no framework error overlay, and console health.**
- [ ] **Step 3: Verify the task list scroll container loads another page at the sentinel, shows the loading/end state, and does not duplicate Job IDs.**
- [ ] **Step 4: Verify filters reset the list and clicking a row opens the existing dialog with Agent log content or the empty-state message.**
- [ ] **Step 5: Verify desktop and a mobile-sized viewport for clipping, nested scroll behavior, and accessible fallback buttons.**

### Task 5: Final regression and handoff

- [ ] **Step 1: Run focused backend tests for jobs and creation rules.**
- [ ] **Step 2: Run focused frontend Vitest tests for the task board, dialog, and API client.**
- [ ] **Step 3: Run ESLint, `git diff --check`, and the relevant TypeScript check; report unrelated pre-existing errors separately.**
- [ ] **Step 4: Re-check service status and restart API/Worker/Web if source changes require reload.**
- [ ] **Step 5: Summarize the unified list, pagination behavior, tests, and any remaining validation limits.**
