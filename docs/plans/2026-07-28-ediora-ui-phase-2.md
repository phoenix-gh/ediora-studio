# Ediora UI Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` or
> `superpowers:executing-plans` task-by-task. Every behavior change follows
> RED → GREEN → focused review → full verification.

**Goal:** 将草稿箱、草稿素材与发布、写作模板、AI 助手、数字人口播、创作任务和待响应迁移到 Phase 1 建立的 Ediora 设计体系，同时冻结并验证所有现有创作、发布、任务和关联数据契约。

**Architecture:** 继续使用 `AppShell` 作为唯一应用 `<main>` 和滚动边界；创作型页面复用 `PageHeader`、`WorkspaceToolbar`、`SplitWorkspace`、`Dialog`、`AlertDialog` 与语义表单组件。页面可以保留各自必要的双栏或三栏业务结构，但临时任务不得通过常驻抽屉改变编辑区宽度。所有迁移先用行为测试锁定 API payload、当前选择和失败恢复，再替换布局与视觉实现。

**Tech Stack:** Next.js 16.2.4 App Router、React 19.2.4、Tailwind CSS 4、Base UI / shadcn、next-themes、Vitest 4、Testing Library、Playwright Chromium。

## Frozen Phase 1 Interfaces

Phase 2 consumes these interfaces without changing their public contracts:

- `AppShell`
- `PageHeader`
- `WorkspaceToolbar`
- `SplitWorkspace`
- `FormSection`
- `AsyncState`
- `StatusBadge`
- shared `Button`, `Input`, `Textarea`, `Select`, `Switch`, `Tabs`,
  `Dialog`, and `AlertDialog`
- Dialog sizes `sm | md | lg`
- semantic tokens `primary`, `data`, `ai`, `success`, `warning`, `danger`,
  `info`, `surface`, `surface-muted`, `foreground`, `muted-foreground`,
  `foreground-subtle`, and `border`

If a page needs a new shared abstraction, add the smallest page-neutral
interface in its own task and obtain an independent review before reusing it.

## Global Constraints

- 视觉方向继续固定为“A · 智性靛蓝”。
- 一级侧栏仍为桌面 224px、1024px 紧凑 72px；页面不得自行增加侧栏偏移。
- 每条路由只能存在 `AppShell` 提供的一个 `<main>`。
- 桌面端业务配置、素材选择、AI 临时任务、工作流和发布统一使用 Dialog，不使用业务侧边抽屉。
- 删除与不可逆操作使用 `AlertDialog`；禁止浏览器原生 `prompt`、`confirm`、`alert`。
- 禁止迁移文件继续使用原生 `select`、`textarea` 或硬编码
  `zinc` / `indigo` / `sky` / `violet` 作为业务语义。
- 不修改路由 IA、后端接口、数据库、队列、job 生命周期或发布实现。
- 不重新引入 publication records 或本地发布历史管理。
- WeChat 与 Blog 的真实发布调用必须保留；X 仍保持当前剪贴板流程，除非另有产品需求。
- `generateImage` 保持 prompt-only；不得给共享图片工具隐式增加 draft、cover、style、skill 或 title 参数。
- 数字人口播必须保留角色资产、脚本来源、草稿关联、环境 override、autosave flush 和 render snapshot。
- 当前活跃 `/responses` 的 `pending | adopted | later | rejected` 状态和精确 output payload 原样保留；旧 `/x-responses` redirect 不恢复为第二套 UI。
- “待响应”不扩展为通用 Todo，不增加期限、子任务、项目或标签。
- 多媒体资产继续使用紧凑网格和双击 Dialog，不改为右侧常驻预览。
- Phase 2 implementation baseline: `64fd00f`, which includes the hardened
  Phase 1 browser gate `702aa56` and reviewed response-race fix `21732bf`;
  exact frontend suite is 70 files / 320 tests. The full-repository ESLint
  diagnostic has 35 deferred errors; Phase 2 may reduce but must not exceed
  that ceiling.
- `docs/superpowers` 不进入 Git；计划和设计文档保存在 `docs/plans` 与 `docs/design`。

## Execution Convention and Dependencies

- All `pnpm` commands run from `wemedia-studio/`.
- All backend `pytest` commands run from `backend/` with the `wems` conda
  environment.
- All `git add` and `git commit` commands run from the repository root.
- Treat each fenced command block as having the working directory stated
  above; do not depend on a `cd` from an earlier block.
- Every commit command below is preceded by a scoped `git add`; never use
  `git add .`.
- Task dependency graph:
  `T1 → T2…T9`, `T2 → T3`, `T4 → T5`, and `T2…T9 → T10`.
- Tasks 4 and 5 both modify `WritingPlansClient.tsx` and therefore must not run
  concurrently.

## Phase Boundary

Phase 2 covers:

1. behavior-contract safety net;
2. draft workspace;
3. draft assets and publishing Dialogs;
4. writing-plan workspace;
5. writing-plan operation Dialogs;
6. AI assistant;
7. digital-human studio;
8. creation jobs;
9. response inbox;
10. Phase 2 policy and browser verification.

Information-source pages remain Phase 3.

---

### Task 1: Freeze Creation and Publishing Contracts

**Files:**

- Create: `wemedia-studio/app/drafts/DraftsClient.contract.test.tsx`
- Create: `wemedia-studio/app/drafts/PublishDialog.contract.test.tsx`
- Create: `wemedia-studio/app/chat/ChatClient.contract.test.tsx`
- Create: `wemedia-studio/app/writing-plans/WritingPlansClient.contract.test.tsx`
- Create: `wemedia-studio/app/jobs/JobsClient.contract.test.tsx`
- Modify: `wemedia-studio/app/digital-humans/talking-video-editor.test.tsx`
- Modify: `wemedia-studio/app/responses/ResponsesClient.test.tsx`
- Modify: `wemedia-studio/lib/ai/global-chat-tools.test.ts`

**Contracts to freeze:**

- Draft save, create-variant, `linked_draft_id`, `writing_plan_id`, sources,
  image relations, deep-link selection and dirty-switch behavior.
- WeChat publish request fields, Blog review request fields, and X clipboard
  output.
- Writing-plan dispatch `{ account_id, angle, draft_type }` and draft creation
  with `writing_plan_id`.
- Chat SSE message ownership, context payload, approval flow and prompt-only
  image job consumption.
- The real prompt-only job producer in `global-chat-tools.ts`: top-level job
  title is allowed, while `input` must equal `{ prompt }` exactly.
- Digital-human autosave, project-switch flush, script-source transitions,
  source-draft association and render snapshot.
- Jobs active polling, `cancelJob(id)`, `retryJobStep(id, key)`, refresh, steps
  and events.
- Response actions and output creation remain bound to the visible response
  detail, including the reviewed `21732bf` race.

**Known defects intentionally not characterized as correct behavior:**

- Draft asset delete clears preview before the request succeeds.
- Chat send/create-session failures can clear composer text or context.
- Digital-human environment generation currently adds `input.title` to the
  prompt-only image input.
- Jobs cancel/retry lacks per-action busy state and cancel confirmation.

The owning tasks below must write expected RED recovery tests before fixing
these defects. Task 1 freezes correct payload ownership and success semantics
only.

- [ ] **Step 1: Add missing behavior tests against the current implementation**

Mock only network boundaries. Do not assert old Tailwind strings or DOM
structure. Tests should name the business outcome and exact payload. Parse the
real `global-chat-tools.ts` POST body and assert `flow: 'standalone_image'`, the
top-level job title, and `input` deeply equal to `{ prompt }` with no
draft/category/style/skill or `input.title`.

- [ ] **Step 2: Run the contract suite**

```bash
pnpm exec vitest run \
  app/drafts/DraftsClient.contract.test.tsx \
  app/drafts/PublishDialog.contract.test.tsx \
  app/chat/ChatClient.contract.test.tsx \
  app/writing-plans/WritingPlansClient.contract.test.tsx \
  app/jobs/JobsClient.contract.test.tsx \
  app/digital-humans/talking-video-editor.test.tsx \
  app/responses/ResponsesClient.test.tsx \
  lib/ai/global-chat-tools.test.ts
```

Expected: existing business behavior is characterized and passes. If a test
reveals an actual product race or payload drift, isolate it into a separate
fix commit before UI migration.

- [ ] **Step 3: Run the full baseline**

```bash
pnpm test
pnpm exec tsc --noEmit --incremental false
```

- [ ] **Step 4: Commit**

```bash
git add \
  wemedia-studio/app/drafts/DraftsClient.contract.test.tsx \
  wemedia-studio/app/drafts/PublishDialog.contract.test.tsx \
  wemedia-studio/app/chat/ChatClient.contract.test.tsx \
  wemedia-studio/app/writing-plans/WritingPlansClient.contract.test.tsx \
  wemedia-studio/app/jobs/JobsClient.contract.test.tsx \
  wemedia-studio/app/digital-humans/talking-video-editor.test.tsx \
  wemedia-studio/app/responses/ResponsesClient.test.tsx \
  wemedia-studio/lib/ai/global-chat-tools.test.ts
git commit -m "test: freeze Phase 2 creation contracts"
```

---

### Task 2: Draft List and Markdown Workspace

**Files:**

- Create: `wemedia-studio/app/drafts/DraftsClient.workspace.test.tsx`
- Create: `wemedia-studio/app/drafts/DraftWorkspace.tsx`
- Modify: `wemedia-studio/app/drafts/DraftsClient.tsx`
- Modify: `wemedia-studio/app/drafts/page.tsx`

**Interfaces:**

- Consume `PageHeader`, `WorkspaceToolbar`, `SplitWorkspace`, `AsyncState`,
  shared form controls and the existing `MarkdownEditor`.
- Preserve all draft API calls and query parameters.
- Replace the permanent AI right column with an `lg` Dialog so opening AI
  assistance does not resize the editor.

- [ ] **Step 1: Write failing workspace behavior tests**

Cover:

1. the client component contains no nested `main`;
2. named draft-list and draft-editor regions;
3. selecting a draft updates the editor;
4. a dirty draft switch uses application confirmation and retains input when
   cancelled;
5. draft deletion uses a distinct `AlertDialog`, passes the exact visible draft
   ID, locks only that destructive action, selects the correct next draft after
   success, and retains the draft/list/editor plus an error after failure;
6. synchronizing from the article main version uses a distinct `AlertDialog`
   when it would overwrite non-empty local content; cancel retains local
   title/Markdown and confirm copies the main version;
7. status, topic and writing-plan controls use accessible shared controls;
8. AI assistance opens a Dialog and the editor bounds do not change;
9. saving and variant creation preserve the Task 1 payloads;
10. failed save/create retains title, Markdown, selected draft and filters.

Component tests assert that opening AI assistance preserves editor state and
renders a Dialog. Exact editor bounds and the single application `main` belong
to Task 10 Playwright because jsdom has no layout.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
pnpm exec vitest run app/drafts/DraftsClient.workspace.test.tsx
```

- [ ] **Step 3: Implement the shared workspace**

- Use `h-full min-h-0 overflow-hidden` under `AppShell`.
- Keep the draft list between 280px and 360px.
- Enforce that range at the three specified Phase 2 browser viewports without
  changing the frozen public contract of `SplitWorkspace`.
- Give the list and Markdown editor independent scrolling.
- Use semantic tokens only.
- Keep `?draft=` and `?chat=1` deep links.
- Replace native `select` and `textarea`.
- Use separate typed pending targets for dirty-switch, exact draft deletion and
  main-version overwrite; render each destructive flow through `AlertDialog`
  rather than the current generic confirmation `Dialog`.

- [ ] **Step 4: Verify**

```bash
pnpm exec vitest run app/drafts
pnpm exec tsc --noEmit --incremental false
pnpm exec eslint app/drafts
```

- [ ] **Step 5: Commit**

```bash
git add \
  wemedia-studio/app/drafts/DraftsClient.workspace.test.tsx \
  wemedia-studio/app/drafts/DraftWorkspace.tsx \
  wemedia-studio/app/drafts/DraftsClient.tsx \
  wemedia-studio/app/drafts/page.tsx
git commit -m "feat: unify Ediora draft workspace"
```

---

### Task 3: Draft Assets and Real Publishing Dialogs

**Files:**

- Create: `wemedia-studio/components/features/DraftAssetsDialog.test.tsx`
- Create: `wemedia-studio/app/drafts/PublishingDialogs.test.tsx`
- Modify: `wemedia-studio/components/features/DraftAssetsDialog.tsx`
- Modify: `wemedia-studio/app/drafts/PublishDialog.tsx`
- Modify: `wemedia-studio/app/drafts/WechatPublishPanel.tsx`
- Modify: `wemedia-studio/app/drafts/XArticlePanel.tsx`
- Modify: `wemedia-studio/app/drafts/BlogPublishPanel.tsx`

**Interfaces:**

- Draft assets remain an application Dialog with the existing
  `sources | images` tabs.
- The image tab migrates from its permanent large preview pane to the accepted
  compact grid plus double-click preview Dialog.
- Delete uses `AlertDialog`.
- Publish remains a sized application Dialog.
- WeChat and Blog keep real remote calls. X keeps copy-to-clipboard behavior.
- Cover regeneration preserves
  `{ draft_id, account_id, note, cover_style }`.
- Body illustration preserves
  `{ draft_id, account_id, max_images, note }`.

- [ ] **Step 1: Write failing interaction and payload tests**

Cover:

- delete confirmation without `window.confirm`;
- failed delete retains the current tab, selected preview and error;
- image insertion and cover selection;
- compact grid single selection and double-click preview Dialog;
- exact cover-regeneration and body-illustration job payloads, successful
  refresh timing, failure recovery and duplicate-submit locking;
- publish tab keyboard navigation;
- exact WeChat and Blog request payloads;
- X copied text and success/failure feedback;
- Dialog Escape, focus return and busy-state duplicate prevention.

Render the real WeChat/Blog panel components and exercise their real API
helpers; mock only `fetch`/external transport boundaries, never the platform
panels themselves.

- [ ] **Step 2: Verify RED**

```bash
pnpm exec vitest run \
  components/features/DraftAssetsDialog.test.tsx \
  app/drafts/PublishingDialogs.test.tsx
```

- [ ] **Step 3: Migrate controls and feedback**

Use shared `Dialog`, `AlertDialog`, `Tabs`, `Select`, `Textarea`, `Input`,
`Button`, semantic alerts and inline field errors. Do not replace the publish
HTML renderer or API layer.

- [ ] **Step 4: Verify**

```bash
pnpm exec vitest run components/features/DraftAssetsDialog.test.tsx app/drafts
pnpm exec tsc --noEmit --incremental false
pnpm exec eslint components/features/DraftAssetsDialog.tsx app/drafts
(cd ../backend && WMS_DISABLE_SCHEDULER=1 conda run -n wems python -m pytest \
  tests/test_wechat_publish.py tests/test_blog_publish.py \
  -q -p no:cacheprovider)
```

The backend tests mock external platforms and must not publish real content.

- [ ] **Step 5: Commit**

```bash
git add \
  wemedia-studio/components/features/DraftAssetsDialog.tsx \
  wemedia-studio/components/features/DraftAssetsDialog.test.tsx \
  wemedia-studio/app/drafts/PublishDialog.tsx \
  wemedia-studio/app/drafts/PublishingDialogs.test.tsx \
  wemedia-studio/app/drafts/WechatPublishPanel.tsx \
  wemedia-studio/app/drafts/XArticlePanel.tsx \
  wemedia-studio/app/drafts/BlogPublishPanel.tsx
git commit -m "feat: unify draft assets and publishing dialogs"
```

---

### Task 4: Writing-Plan Workspace

**Files:**

- Modify: `wemedia-studio/app/writing-plans/WritingPlansClient.test.tsx`
- Create: `wemedia-studio/app/writing-plans/WritingPlansWorkspace.test.tsx`
- Create: `wemedia-studio/app/writing-plans/WritingPlanList.tsx`
- Create: `wemedia-studio/app/writing-plans/WritingPlanEditor.tsx`
- Modify: `wemedia-studio/app/writing-plans/WritingPlansClient.tsx`
- Modify: `wemedia-studio/app/writing-plans/page.tsx`

**Interfaces:**

- Consume `PageHeader`, `WorkspaceToolbar`, `SplitWorkspace`, `FormSection`,
  shared controls and `CoverStyleEditor`.
- Preserve plan model, tags, sources, filters, genre, strategy and draft
  associations.
- Source preview becomes a Dialog instead of a permanent right rail.
- Plan deletion and source deletion confirmations belong to Task 5; Task 4
  must not characterize their current native confirmation containers.
- `PushToStudioPopover` is shared outside writing plans. Keep it unchanged in
  Phase 2 and do not change its `enqueueStudioTask` payload.

- [ ] **Step 1: Replace source-string tests with failing behavior tests**

Cover plan selection, filters, edit behavior, source selection and association,
source preview Dialog, tag editing, strategy save and draft association. New
plan creation and plan/source deletion belong to Task 5; do not test their
confirmation UI here.

- [ ] **Step 2: Verify RED**

```bash
pnpm exec vitest run app/writing-plans/WritingPlansWorkspace.test.tsx
```

- [ ] **Step 3: Implement the workspace**

- Keep list/editor widths stable.
- Replace native controls with shared controls.
- Use semantic colors and typography.
- Preserve selected plan across local saves and failed requests.
- Do not change `CoverStyle` schema or `PushToStudioPopover` payload.

- [ ] **Step 4: Verify**

```bash
pnpm exec vitest run app/writing-plans
pnpm exec tsc --noEmit --incremental false
pnpm exec eslint app/writing-plans
```

- [ ] **Step 5: Commit**

```bash
git add \
  wemedia-studio/app/writing-plans/WritingPlansClient.test.tsx \
  wemedia-studio/app/writing-plans/WritingPlansWorkspace.test.tsx \
  wemedia-studio/app/writing-plans/WritingPlanList.tsx \
  wemedia-studio/app/writing-plans/WritingPlanEditor.tsx \
  wemedia-studio/app/writing-plans/WritingPlansClient.tsx \
  wemedia-studio/app/writing-plans/page.tsx
git commit -m "feat: rebuild Ediora writing-plan workspace"
```

---

### Task 5: Writing-Plan Operation Dialogs

**Files:**

- Create: `wemedia-studio/app/writing-plans/WritingPlanDialogs.test.tsx`
- Create: `wemedia-studio/app/writing-plans/dialogs/CandidateDialog.tsx`
- Create: `wemedia-studio/app/writing-plans/dialogs/AnalysisDialog.tsx`
- Create: `wemedia-studio/app/writing-plans/dialogs/ReanalysisDialog.tsx`
- Create: `wemedia-studio/app/writing-plans/dialogs/PromptDialog.tsx`
- Create: `wemedia-studio/app/writing-plans/dialogs/DispatchDialog.tsx`
- Create: `wemedia-studio/app/writing-plans/dialogs/NewPlanDialog.tsx`
- Modify: `wemedia-studio/app/writing-plans/WritingPlansClient.tsx`

**Interfaces:**

- Candidate, analysis, re-analysis, prompt, dispatch and new-plan flows use
  shared Dialogs.
- Plan delete and server-side source delete (`deletePlanSource`) use separate
  `AlertDialog` instances with separate pending targets.
- Dispatch preserves `{ account_id, angle, draft_type }`.
- Dispatch first saves the modal strategy successfully and only then calls
  `dispatchPlan`; a failed strategy save must not dispatch.
- Polling, candidate events and errors preserve the current plan and inputs.
- `PushToStudioPopover` remains unchanged because it is shared by writing plans,
  WeChat, 36Kr and Juejin and uses the separate `enqueueStudioTask` contract.

- [ ] **Step 1: Write failing rendered Dialog tests**

Test all six Dialog names, focus return, Escape behavior, validation, busy
locking, retryable errors, exact dispatch payload and save-before-dispatch
ordering. Test plan delete and source delete independently: exact target ID,
duplicate-submit lock, success refresh and failure retention with inline error.
Use fake timers for candidate polling, including timeout cleanup on close and
unmount.

- [ ] **Step 2: Verify RED**

```bash
pnpm exec vitest run app/writing-plans/WritingPlanDialogs.test.tsx
```

- [ ] **Step 3: Extract Dialog components**

Do not leave handwritten fixed overlays. Use only the frozen `md` or `lg`
sizes based on content. Long forms scroll inside `DialogContent`, not the
document.

- [ ] **Step 4: Verify**

```bash
pnpm exec vitest run app/writing-plans
pnpm exec tsc --noEmit --incremental false
pnpm exec eslint app/writing-plans
```

- [ ] **Step 5: Commit**

```bash
git add \
  wemedia-studio/app/writing-plans/WritingPlanDialogs.test.tsx \
  wemedia-studio/app/writing-plans/dialogs/CandidateDialog.tsx \
  wemedia-studio/app/writing-plans/dialogs/AnalysisDialog.tsx \
  wemedia-studio/app/writing-plans/dialogs/ReanalysisDialog.tsx \
  wemedia-studio/app/writing-plans/dialogs/PromptDialog.tsx \
  wemedia-studio/app/writing-plans/dialogs/DispatchDialog.tsx \
  wemedia-studio/app/writing-plans/dialogs/NewPlanDialog.tsx \
  wemedia-studio/app/writing-plans/WritingPlansClient.tsx
git commit -m "feat: standardize writing-plan dialogs"
```

---

### Task 6: AI Assistant Workspace

**Files:**

- Create: `wemedia-studio/app/chat/ChatClient.test.tsx`
- Modify: `wemedia-studio/app/chat/ChatClient.tsx`
- Modify: `wemedia-studio/app/chat/chat-layout.test.ts`
- Modify: `wemedia-studio/app/chat/chat-composer.test.ts`
- Modify: `wemedia-studio/components/features/chat/ChatContextPicker.tsx`
- Modify: `wemedia-studio/components/features/chat/ChatMarkdown.tsx`

**Interfaces:**

- Stable 280px conversation list plus chat surface.
- Delete uses `AlertDialog`.
- Composer uses shared `Textarea`.
- Image preview uses `DialogContent size="lg"`.
- Preserve SSE, lazy session creation, context, approval and prompt-only durable
  image jobs.

- [ ] **Step 1: Write failing session and composer behavior tests**

Cover lazy create, switch, rename, delete confirmation, failed delete recovery,
SSE append, Enter/Shift+Enter, draft/skill context, approval and generated
image preview. Add explicit recovery cases for:

- create-session failure retains composer text plus selected skill/draft
  context and creates no ghost assistant message;
- stream failure retains or restores the submitted text and context, exposes a
  retryable error and creates no empty assistant message;
- durable image-job polling reaches a terminal state and opens the generated
  image preview.

The prompt-only producer contract is owned by Task 1
`lib/ai/global-chat-tools.test.ts`; do not duplicate or weaken it here.

- [ ] **Step 2: Verify RED**

```bash
pnpm exec vitest run app/chat/ChatClient.test.tsx app/chat/chat-composer.test.ts
```

- [ ] **Step 3: Migrate layout and controls**

Use `PageHeader` and a stable workspace. Do not add a permanent AI drawer; the
chat route is itself the AI workspace. Use `ai` only for AI capability markers,
not every control.

- [ ] **Step 4: Verify**

```bash
pnpm exec vitest run app/chat components/features/chat lib/ai/global-chat-tools.test.ts
pnpm exec tsc --noEmit --incremental false
pnpm exec eslint app/chat components/features/chat
```

- [ ] **Step 5: Commit**

```bash
git add \
  wemedia-studio/app/chat/ChatClient.test.tsx \
  wemedia-studio/app/chat/ChatClient.tsx \
  wemedia-studio/app/chat/chat-layout.test.ts \
  wemedia-studio/app/chat/chat-composer.test.ts \
  wemedia-studio/components/features/chat/ChatContextPicker.tsx \
  wemedia-studio/components/features/chat/ChatMarkdown.tsx
git commit -m "feat: unify Ediora AI assistant workspace"
```

---

### Task 7: Digital-Human Studio Shell

**Files:**

- Create: `wemedia-studio/app/digital-humans/DigitalHumansClient.test.tsx`
- Create: `wemedia-studio/app/digital-humans/EnvironmentPickerDialog.test.tsx`
- Modify: `wemedia-studio/app/digital-humans/DigitalHumansClient.tsx`
- Modify: `wemedia-studio/app/digital-humans/RoleLibrary.tsx`
- Modify: `wemedia-studio/app/digital-humans/RoleEditorDialog.tsx`
- Modify: `wemedia-studio/app/digital-humans/EnvironmentPickerDialog.tsx`
- Modify: `wemedia-studio/app/digital-humans/TalkingProjectList.tsx`
- Modify: `wemedia-studio/app/digital-humans/TalkingVideoEditor.tsx`
- Modify: `wemedia-studio/app/digital-humans/ScriptAssistantDialog.tsx`
- Modify: `wemedia-studio/app/digital-humans/RenderVersionsPanel.tsx`

**Interfaces:**

- Preserve the proven project editor proportions: 200px configuration,
  flexible script editor and 280px render history where space allows.
- At 1024px, compact or stack secondary panels without horizontal document
  overflow.
- Replace nested `<main>` with semantic sections.
- Keep role, portrait, voice, environment, script-source, draft-source,
  autosave and render-version contracts.

- [ ] **Step 1: Write failing shell and association tests**

Cover no nested client `<main>`, role/project Tabs, role asset labels, project
switch flush, manual script source reset, AI/draft source association,
environment override, render confirmation and historical versions. Task 10
Playwright owns the assertion that the complete application has exactly one
`main`.

Add separate `AlertDialog` behavior tests for:

- role deletion when `project_count === 0` and role archival when
  `project_count > 0`;
- deletion of failed or cancelled renders.

Each case asserts the exact role/project/render ID, per-item busy locking,
success refresh, and failure retention of the visible object plus an error.

- [ ] **Step 2: Add a prompt-only environment-generation regression**

In `EnvironmentPickerDialog.test.tsx`, require the environment generation
request to preserve the required top-level job title while removing only the
hidden `input.title`:

```ts
{
  flow: 'standalone_image',
  title: `生成数字人口播环境图 · ${trimmedPrompt.slice(0, 30)}`,
  input: { prompt: trimmedPrompt },
  idempotency_key: expect.stringMatching(/^talking-environment:/),
}
```

Make this an explicit behavior fix with its own RED evidence rather than
hiding it inside restyling.

- [ ] **Step 3: Verify RED**

```bash
pnpm exec vitest run app/digital-humans
```

- [ ] **Step 4: Migrate the shell and semantic controls**

Reuse current Dialogs and shared controls. Do not force the specialized
three-column editor into generic 25/75 `SplitWorkspace`.

- [ ] **Step 5: Verify**

```bash
pnpm exec vitest run app/digital-humans
pnpm exec tsc --noEmit --incremental false
pnpm exec eslint app/digital-humans
```

- [ ] **Step 6: Commit**

```bash
git add \
  wemedia-studio/app/digital-humans/DigitalHumansClient.test.tsx \
  wemedia-studio/app/digital-humans/EnvironmentPickerDialog.test.tsx \
  wemedia-studio/app/digital-humans/DigitalHumansClient.tsx \
  wemedia-studio/app/digital-humans/RoleLibrary.tsx \
  wemedia-studio/app/digital-humans/RoleEditorDialog.tsx \
  wemedia-studio/app/digital-humans/EnvironmentPickerDialog.tsx \
  wemedia-studio/app/digital-humans/TalkingProjectList.tsx \
  wemedia-studio/app/digital-humans/TalkingVideoEditor.tsx \
  wemedia-studio/app/digital-humans/ScriptAssistantDialog.tsx \
  wemedia-studio/app/digital-humans/RenderVersionsPanel.tsx
git commit -m "feat: unify Ediora digital-human studio"
```

---

### Task 8: Creation Jobs

**Files:**

- Create: `wemedia-studio/app/jobs/JobsClient.test.tsx`
- Modify: `wemedia-studio/app/jobs/JobsClient.tsx`
- Modify: `wemedia-studio/app/jobs/page.tsx`

**Interfaces:**

- Consume `PageHeader`, `AsyncState`, `StatusBadge`, semantic `Alert` and
  shared `Button`.
- Preserve job polling, step keys, attempts, events, retryable flags and retry
  API calls.
- Canceling an active job requires `AlertDialog`; retry remains a direct,
  reversible action with its own busy state.

- [ ] **Step 1: Write failing job behavior tests**

Cover loading, empty, running, failed/retryable, non-retryable, retry busy
locking, retry failure and event disclosure accessibility. Also cover:

- cancel confirmation and exact `cancelJob(id)` target;
- per-job/per-action busy locking rather than disabling unrelated jobs;
- successful cancel/retry refresh;
- failed cancel/retry retains the job, steps and events and shows the error;
- polling continues while any job is `queued` or `running`, stops when every
  job is terminal, and cleans its timer on unmount.

- [ ] **Step 2: Verify RED**

```bash
pnpm exec vitest run app/jobs/JobsClient.test.tsx
```

- [ ] **Step 3: Remove the legacy root layout**

Remove nested `main`, `ml-56`, `min-h-screen` and hard-coded colors. Keep the
page as a normal `AppShell` child. Use one accessible disclosure per event
history and preserve logs.

- [ ] **Step 4: Verify**

```bash
pnpm exec vitest run app/jobs
pnpm exec tsc --noEmit --incremental false
pnpm exec eslint app/jobs
```

- [ ] **Step 5: Commit**

```bash
git add \
  wemedia-studio/app/jobs/JobsClient.test.tsx \
  wemedia-studio/app/jobs/JobsClient.tsx \
  wemedia-studio/app/jobs/page.tsx
git commit -m "feat: restyle Ediora creation jobs"
```

---

### Task 9: Response Inbox Workspace

**Files:**

- Modify: `wemedia-studio/app/responses/ResponsesClient.test.tsx`
- Create: `wemedia-studio/app/responses/ResponsesWorkspace.test.tsx`
- Create: `wemedia-studio/app/responses/ResponseOutputDialog.tsx`
- Modify: `wemedia-studio/app/responses/ResponsesClient.tsx`
- Modify: `wemedia-studio/app/responses/page.tsx`

**Interfaces:**

- Preserve active status semantics `pending | adopted | later | rejected`.
- Preserve actions `adopt | later | not_valuable | reset`.
- Preserve exact output payload
  `{ analysis_run_id, publish_account_id, output_types }`.
- Preserve the reviewed visible-detail race fix `21732bf`.
- Keep `/x-responses` as a redirect; do not revive a second inbox.

- [ ] **Step 1: Write failing workspace behavior tests**

Cover filters/search, named list/detail regions, transcript/history loading,
decision actions, the race where the current pending item leaves the filtered
list while the next detail is still loading, output Dialog payload, busy
locking, failed output recovery and current-detail preservation. Actions and
output creation remain bound to the visible `detail.id`, never merely the new
list selection.

- [ ] **Step 2: Verify RED**

```bash
pnpm exec vitest run app/responses
```

- [ ] **Step 3: Migrate the workspace**

- Remove `h-screen`, `calc(100vh...)` and nested `<main>`.
- Use stable filter/list/detail regions under `AppShell`.
- Replace native select with shared `Select`.
- Move the bottom creation form into a Dialog so detail width does not change.
- Replace hard-coded colors with semantic tokens.
- Do not add Todo concepts.

- [ ] **Step 4: Verify**

```bash
pnpm exec vitest run app/responses
pnpm exec tsc --noEmit --incremental false
pnpm exec eslint app/responses
```

- [ ] **Step 5: Commit**

```bash
git add \
  wemedia-studio/app/responses/ResponsesClient.test.tsx \
  wemedia-studio/app/responses/ResponsesWorkspace.test.tsx \
  wemedia-studio/app/responses/ResponseOutputDialog.tsx \
  wemedia-studio/app/responses/ResponsesClient.tsx \
  wemedia-studio/app/responses/page.tsx
git commit -m "feat: unify Ediora response inbox"
```

---

### Task 10: Phase 2 Policy and Browser Verification

**Files:**

- Create: `wemedia-studio/lib/ui/ui-policy-phase2.test.ts`
- Create: `wemedia-studio/e2e/creation-workspaces.spec.ts`
- Create: `wemedia-studio/e2e/fixtures/creation-workspaces.ts`
- Create: `wemedia-studio/e2e/phase2-global-teardown.ts`
- Create: `wemedia-studio/playwright.creation.config.ts`
- Create: `backend/scripts/phase2_e2e_db.py`
- Create: `backend/tests/test_phase2_e2e_db.py`
- Create: `docker-compose.phase2-e2e.yml`

**Policy scope:**

- Native-control, layout, typography and general palette rules scan Phase 2
  page roots plus directly migrated feature components only.
- `PushToStudioPopover.tsx` is outside that migrated set and is scanned solely
  by a dedicated legacy-palette assertion containing the exact temporary
  entries below; do not apply typography/native/layout rules to it or modify
  the shared component in this phase.
- Forbid native `prompt`, `confirm`, `alert`, `select`, and `textarea`.
- Forbid `ml-56`, nested `<main>` and page-owned viewport height:
  `h-screen`, `min-h-screen`, `h-dvh`, `min-h-dvh`, or non-`max-h`
  arbitrary utilities containing `100vh`/`100dvh` such as the current
  `h-[calc(100vh-73px)]`. Bounded `DialogContent` may use a reviewed
  `max-h-[calc(100dvh-…)]`; route workspaces use `h-full min-h-0`.
- Forbid hard-coded palette utilities from `slate`, `gray`, `zinc`, `neutral`,
  `stone`, `white`, `black`, `red`, `orange`, `amber`, `yellow`, `lime`,
  `green`, `emerald`, `teal`, `cyan`, `sky`, `blue`, `indigo`, `violet`,
  `purple`, `fuchsia`, `pink` and `rose` where semantic tokens exist.
- Code renderers use semantic `surface-muted`/`muted` styling rather than
  receiving a blanket exemption. Platform identity marks may retain only the
  exact small-area brand token they require.
- Every allow-list item has exact `{ file, class_or_token, reason }`; no
  directory or whole-file exemption is accepted.
- Typography follows the tracked five-level scale: ordinary body/helper/error
  copy is at least 14px (`text-sm`) and metadata is at least 12px
  (`text-xs`). Forbid `text-[9px]` and `text-[10px]` throughout the migrated
  scope. Forbid `text-[11px]` except the exact
  `font-mono text-[11px]` event-JSON renderer in `app/jobs/JobsClient.tsx`;
  any additional narrow badge/code exception requires its own exact
  occurrence fingerprint and independent review.
- Because `PushToStudioPopover` is intentionally unchanged and shared outside
  this phase, its only temporary legacy entries are:

  | file | exact class/token | reason |
  | --- | --- | --- |
  | `components/features/PushToStudioPopover.tsx` | `text-zinc-400` | deferred shared popover used by four source surfaces |
  | `components/features/PushToStudioPopover.tsx` | `text-zinc-500` | deferred shared popover used by four source surfaces |
  | `components/features/PushToStudioPopover.tsx` | `border-zinc-200` | deferred shared popover used by four source surfaces |
  | `components/features/PushToStudioPopover.tsx` | `dark:border-zinc-800` | deferred shared popover used by four source surfaces |
  | `components/features/PushToStudioPopover.tsx` | `hover:bg-zinc-100` | deferred shared popover used by four source surfaces |
  | `components/features/PushToStudioPopover.tsx` | `dark:hover:bg-zinc-800` | deferred shared popover used by four source surfaces |
  | `components/features/PushToStudioPopover.tsx` | `hover:text-emerald-500` | deferred shared popover success affordance |
  | `components/features/PushToStudioPopover.tsx` | `text-emerald-500` | deferred shared popover success affordance |
  | `components/features/PushToStudioPopover.tsx` | `bg-emerald-50` | deferred shared popover selected account |
  | `components/features/PushToStudioPopover.tsx` | `dark:bg-emerald-950/40` | deferred shared popover selected account |
  | `components/features/PushToStudioPopover.tsx` | `text-emerald-700` | deferred shared popover selected account |
  | `components/features/PushToStudioPopover.tsx` | `dark:text-emerald-300` | deferred shared popover selected account |

  The only black/white exceptions are occurrence-specific visual/platform
  contrast, not general surface styling:

  | file | exact class/token occurrence | reason |
  | --- | --- | --- |
  | `components/features/DraftAssetsDialog.tsx` | `from-black/60` in the image-card gradient | image legibility overlay |
  | `components/features/DraftAssetsDialog.tsx` | `bg-white/20 hover:bg-white/30 text-white` on the image-overlay action | image legibility overlay |
  | `components/features/DraftAssetsDialog.tsx` | `bg-black/60 … text-white` on the image-overlay delete action | image legibility overlay |
  | `app/drafts/WechatPublishPanel.tsx` | `w-full h-full bg-white` on the rendered WeChat HTML preview frame | platform canvas must remain white |
  | `app/drafts/XArticlePanel.tsx` | `dark ? 'bg-black …' : 'bg-white …'` on the X article preview | platform preview identity |

  All other `bg-white`, `text-white`, `bg-black` and overlay occurrences in
  migrated files must use semantic surfaces/foregrounds or the shared Dialog
  overlay. The policy implementation must match the occurrence fingerprint
  above, not exempt the token for the whole file. Every occurrence allow-list
  entry must match exactly once; zero or multiple matches fail the policy test.

- [ ] **Step 1: Write policy tests and verify RED**

```bash
pnpm exec vitest run lib/ui/ui-policy-phase2.test.ts
```

- [ ] **Step 2: Fix only Phase 2 policy findings**

Do not broaden cleanup into information-source pages.

- [ ] **Step 3: Build an isolated deterministic browser runtime**

`page.route()` cannot intercept Next server-component fetches. Do not point
browser verification at the developer database or the normal ports.

1. `docker-compose.phase2-e2e.yml` defines only a disposable
   `postgres:16-alpine` service named through the exact Compose project
   `ediora-phase2-e2e`, bound to `127.0.0.1:55432`. Store Postgres data on a
   container `tmpfs`, not a named volume, and add `pg_isready` health checking.
   It must not join, inspect or mutate the normal `main-runtime` Compose
   project. Run
   `docker compose -p ediora-phase2-e2e -f ../docker-compose.phase2-e2e.yml
   config -q` before `up`.
2. `backend/scripts/phase2_e2e_db.py seed` refuses every database URL except
   the exact dedicated test URL
   `postgresql+asyncpg://ediora_e2e:ediora_e2e@127.0.0.1:55432/ediora_phase2_e2e`,
   imports `models` before invoking the existing `init_db`, and inserts
   deterministic fixtures. The script also exposes an equally guarded `reset`
   command that truncates only this dedicated database, resets identities and
   re-seeds the same IDs. This is test-only data setup, not a production schema
   migration. Do not modify `backend/database.py` or add an SQLite
   compatibility path in this phase.
   `backend/tests/test_phase2_e2e_db.py` must prove exact acceptance plus
   near-miss rejection for database, user, host, port, scheme and password,
   and prove rejection happens before engine creation or any mutation.
3. Seed at minimum:
   - drafts, sources, images and publish accounts;
   - writing plan, associated source and candidate state;
   - chat session with messages and context;
   - digital-human role, project, failed/cancelled render and associations;
   - queued, running, succeeded and retryable-failed jobs with steps/events;
   - two pending response-analysis records that reproduce the visible-detail
     selection race.
4. The backend `webServer` command first runs
   `docker compose -p ediora-phase2-e2e -f ../docker-compose.phase2-e2e.yml
   up -d --wait`, then runs the guarded seed, then starts the isolated backend
   on `127.0.0.1:8100` with `WMS_DISABLE_SCHEDULER=1`, the exact dedicated
   Postgres URL, and
   `WMS_CORS_ORIGINS=http://127.0.0.1:3100,http://localhost:3100` plus
   `WMS_BASE_URL=http://127.0.0.1:8100`; the backend
   entry waits for `http://127.0.0.1:8100/health`. A second entry starts Next
   with the explicit command
   `pnpm dev --hostname 127.0.0.1 --port 3100`, setting both `WMS_API_URL` and
   `NEXT_PUBLIC_API_URL` to
   `http://127.0.0.1:8100/api`, and uses that port as Playwright `baseURL`.
   Set `workers: 1` and `fullyParallel: false`, and use
   `reuseExistingServer: false` for both entries, so reset/mutation cases never
   overlap and a developer service cannot be mistaken for the fixture runtime.
5. Browser-side mutations may change only this isolated DB. Intercept external
   WeChat/Blog publishing POSTs and AI/provider calls at the browser boundary;
   assert their request payloads but never contact a real platform.
6. Before setup, remove only a stale exact `ediora-phase2-e2e` Compose project.
   After both pass and failure, `phase2-global-teardown.ts` runs
   `docker compose -p ediora-phase2-e2e -f ../docker-compose.phase2-e2e.yml
   down --volumes --remove-orphans` and removes only explicitly named generated
   fixture files. Never run `docker compose down` without both the exact
   project and file arguments.
7. `e2e/fixtures/creation-workspaces.ts` performs a preflight before the visual
   matrix: require 200 from `/health` and assert exact seeded IDs from
   `/api/write/drafts`, `/api/writing-plans`, `/api/chat/sessions`,
   `/api/digital-humans`, `/api/jobs` and `/api/responses`. A missing fixture
   or wrong database must fail before any screenshot case.
8. Run the guarded `reset` before every route × viewport × theme matrix case
   (36 resets for 36 screenshot cases). No destructive action, response
   decision or job transition may consume a one-shot fixture shared by a later
   case. For active-job polling, intercept only the browser GET `/api/jobs`
   sequence and return the seeded active state followed by a terminal state;
   response decisions may exercise the isolated backend, then the next case
   reset restores their exact IDs.

- [ ] **Step 4: Add the Playwright creation-workspace matrix**

Visit:

- `/drafts`
- `/writing-plans`
- `/chat`
- `/digital-humans`
- `/jobs`
- `/responses`

At 1440×1000, 1280×800 and 1024×768 in Light and Dark:

1. assert exactly one application `main`;
2. assert no horizontal document overflow;
3. assert named list/editor/detail regions;
4. assert stable editor width while applicable Dialogs open;
5. exercise one normal Dialog and one destructive `AlertDialog` per applicable
   route;
6. verify Escape, focus trap and focus return;
7. verify theme persistence across navigation;
8. preserve route-specific scroll ownership;
9. exercise seeded media/preview and publishing UI; browser routes mock the
   external publish/provider side effects and assert request payloads;
10. reproduce the response visible-detail race with the two seeded records;
11. verify active-job polling and terminal cleanup without real workers.

Store 36 route screenshots under
`test-results/creation-workspaces/`; do not commit PNGs. The existing
`.gitignore` already excludes both `test-results/` and `playwright-report/`, so
do not modify it unless this task intentionally introduces a different
artifact path.

- [ ] **Step 5: Run complete verification**

```bash
pnpm test
pnpm exec eslint \
  app/drafts app/writing-plans app/chat app/digital-humans app/jobs app/responses \
  components/features/DraftAssetsDialog.tsx \
  components/features/chat lib/ui e2e \
  --ignore-pattern e2e/ui-foundations.spec.ts
pnpm exec eslint . --quiet
pnpm exec tsc --noEmit --incremental false
pnpm build
(cd ../backend && conda run -n wems python -m pytest \
  tests/test_phase2_e2e_db.py -q -p no:cacheprovider)
(cd .. && docker compose \
  -p ediora-phase2-e2e \
  -f docker-compose.phase2-e2e.yml \
  config -q)
pnpm exec playwright test \
  --config=playwright.creation.config.ts \
  e2e/creation-workspaces.spec.ts \
  --project=chromium
```

Expected:

- all Vitest files pass;
- Phase 2 migrated scope has zero ESLint errors;
- full-repository ESLint does not regress beyond the recorded baseline and is
  reported honestly if deferred Phase 3 pages remain;
- TypeScript and production build pass;
- the exact database-URL safety guard and disposable Compose manifest pass;
- every Playwright viewport/theme case passes.

- [ ] **Step 6: Perform direct visual comparison**

The tracked
`docs/design/2026-07-28-ediora-ui-design-system.md` is the authoritative,
stable accepted-A reference. The current untracked concept artifact is
`/workspace/projects/WeMediaStudio/.superpowers/brainstorm/23503-1785202992/content/visual-directions.html`
at `[data-choice="a"]`; `/tmp/ediora-accepted-a.png` is its optional local
snapshot. These temporary artifacts may be absent in a future worktree, so do
not infer missing requirements when they are unavailable.

Use `view_image` on the latest 1440 Light/Dark screenshots for all Phase 2
routes and, when available, the optional snapshot. Inspect:

- primary/data/AI semantic color separation;
- body/helper/error copy at 14px, metadata at 12px, and no unreadable
  microcopy outside the one reviewed code-renderer exception;
- 224px app sidebar and 72px compact state;
- stable list/editor proportions;
- specialized digital-human three-column behavior;
- Dialog sizes, overlays and focus;
- Markdown/editor theme synchronization;
- no nested document scroll or clipped content.

- [ ] **Step 7: Commit**

```bash
git add \
  wemedia-studio/lib/ui/ui-policy-phase2.test.ts \
  wemedia-studio/e2e/creation-workspaces.spec.ts \
  wemedia-studio/e2e/fixtures/creation-workspaces.ts \
  wemedia-studio/e2e/phase2-global-teardown.ts \
  wemedia-studio/playwright.creation.config.ts \
  backend/scripts/phase2_e2e_db.py \
  backend/tests/test_phase2_e2e_db.py \
  docker-compose.phase2-e2e.yml
git commit -m "test: verify Ediora creation workspaces"
```

---

## Phase 2 Completion Gate

Phase 2 is complete only when:

- all ten task commits and independent reviews exist;
- Phase 1 shared interfaces remain source-compatible;
- all scoped automated gates pass;
- browser screenshots are directly compared with the accepted A concept;
- real publishing, prompt-only image generation, digital-human associations,
  job retry semantics and response-inbox state remain intact;
- no material visual mismatch remains in Phase 2 routes;
- full-repository lint debt is measured and not increased;
- `.superpowers/brainstorm/` remains untracked;
- no `docs/superpowers` files are added to Git.

After this gate, write the Phase 3 plan for information-source pages without
changing their collection or subscription semantics.
