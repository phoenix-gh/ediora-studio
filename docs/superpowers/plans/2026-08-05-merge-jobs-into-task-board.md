# Merge Creation Jobs Into Task Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 `/jobs` 的通用 Job 查看、取消、重试和日志查看功能合并到 `/creation-rules` 的“任务看板”，并用对话框展示详细日志。

**Architecture:** 继续使用现有 `/api/jobs` 接口，不新增 Job 数据模型。任务看板初次并行加载规则看板和通用 Job 列表；定时运行摘要和通用 Job 摘要留在页面内，详细步骤、事件、Agent 信息分别由对话框承载。删除独立 `/jobs` 页面和导航入口，修正现有跳转到任务看板。

**Tech Stack:** Next.js 16, React, TypeScript, Tailwind CSS, shadcn/base-ui Dialog, Vitest Testing Library, existing FastAPI jobs API.

## Global Constraints

- 不保留 `/jobs` 兼容入口；该路径删除后返回 404。
- 取消和步骤重试继续调用现有 API；只有 `retryable=true` 的失败步骤显示重试按钮。
- 详细日志使用对话框展示，不使用抽屉，不把完整 Job 输入数据展示到页面。
- 定时运行日志和通用 Job 日志均保留错误脱敏后的摘要。

---

### Task 1: Add failing tests for merged jobs and log dialogs

**Files:**
- Modify: `web/app/creation-rules/CreationRulesClient.test.tsx`
- Modify: `web/app/creation-rules/CreationRunLog.test.tsx`
- Create: `web/app/creation-rules/CreationJobPanel.test.tsx`

**Interfaces:**
- Consumes: `listJobs`, `cancelJob`, `retryJobStep`, `ContentJob`.
- Produces: test expectations for `全部任务`, dialog-based detail logs, retry and cancel actions.

- [ ] Add a dashboard fixture containing one running generic Job and assert `全部任务` plus its status appear.
- [ ] Change the scheduled run test to click `查看日志`, then assert the dialog shows Job steps and Agent tool summaries.
- [ ] Add a generic Job panel test that opens `任务日志` and exposes event payload/error plus a retry action for a retryable step.
- [ ] Run the three tests and verify they fail because the merged panel/dialog behavior is not implemented.

### Task 2: Build the generic Job panel and dialog

**Files:**
- Create: `web/app/creation-rules/CreationJobPanel.tsx`
- Create: `web/app/creation-rules/JobLogDialog.tsx`

**Interfaces:**
- `CreationJobPanel({ jobs, onCancel, onRetry })` renders Job summaries and opens `JobLogDialog`.
- `JobLogDialog({ job, open, onOpenChange })` renders steps and events in a modal dialog.
- `onRetry(jobId, stepKey)` and `onCancel(jobId)` are supplied by the page and call existing APIs.

- [ ] Render status, flow, Job ID, timestamps and current step in compact rows.
- [ ] Show cancel only for queued/running Jobs and retry only for failed retryable steps.
- [ ] Move full step errors and event payloads into a large scrollable Dialog.
- [ ] Keep Job input data out of the client payload and dialog.

### Task 3: Convert scheduled run details to dialogs

**Files:**
- Modify: `web/app/creation-rules/CreationRunLog.tsx`
- Modify: `web/app/creation-rules/CreationRunLog.test.tsx`

**Interfaces:**
- `CreationRunLog({ runs, schedulerLogs })` keeps summary rows and opens a run-detail Dialog from `查看日志`.

- [ ] Replace inline `<details>` content with a dialog trigger.
- [ ] Keep the summary row showing rule, schedule, Job ID, output count and status.
- [ ] Move Job steps/events, Agent tool summaries, outputs and scheduler logs into the dialog.
- [ ] Keep failed/partial rows visually prominent without forcing a large expanded page section.

### Task 4: Wire all Jobs into the task board and remove `/jobs`

**Files:**
- Modify: `web/app/creation-rules/CreationRulesClient.tsx`
- Modify: `web/app/creation-rules/CreationRulesClient.test.tsx`
- Modify: `web/components/features/Sidebar.tsx`
- Modify: `web/app/drafts/DraftsClient.tsx`
- Modify: `web/app/digital-humans/EnvironmentPickerDialog.tsx`
- Delete: `web/app/jobs/page.tsx`
- Delete: `web/app/jobs/JobsClient.tsx`

**Interfaces:**
- `CreationRulesClient` loads `getCreationDashboard`, directories, skills and `listJobs` in parallel.
- Mutation handlers refresh the relevant data; active generic Jobs poll every 2 seconds.

- [ ] Add a `全部任务` section below the dashboard columns.
- [ ] Wire cancel/retry to `cancelJob` and `retryJobStep`, then refresh Jobs and the dashboard.
- [ ] Remove the `/jobs` sidebar entry and delete the page implementation.
- [ ] Change existing user-facing links/errors from `/jobs` and “创作任务” to “任务看板”.

### Task 5: Verify merged behavior

**Files:**
- Verify all changed files and tests.

- [ ] Run creation-rules Vitest tests and Job/Agent tests.
- [ ] Run ESLint on changed frontend files and backend `compileall`.
- [ ] Run `git diff --check` for changed files.
- [ ] Confirm `/jobs` has no app route and document any existing unrelated type-check failures.
