# 全局主题与页面头部一致性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 统一 Ediora 全应用的语义配色、原生下拉框和页面顶部高度，并用浅色/深色渲染证据验证。

**Architecture:** 在现有 `globals.css` token 层增加控件和顶部高度契约；通过一个共享 `NativeSelect` 组件迁移所有原生 `<select>`，并调整 Base UI Select；通过 `PageHeader`/`data-slot="page-header"` 和 Sidebar 品牌区统一首行高度。旧页面只迁移中性色表面和文字，保留状态色、代码块和媒体专用色。

**Tech Stack:** Next.js 16、React 19、Tailwind CSS v4、Base UI、Vitest、Testing Library、Playwright。

## Global Constraints

- 不改动业务数据流、路由和发布流程。
- 不新增第三方依赖。
- 原生下拉框必须保留原生键盘和可访问行为。
- 颜色迁移只处理中性色表面/文字/边框，红黄绿蓝紫状态色保持语义。
- 按项目约定只运行相关定向测试，不跑全量测试。
- 每个生产改动先有会失败的测试或静态回归断言，再实现最小修复。

---

### Task 1: Extend theme tokens and layout height contract

**Files:**
- Modify: `web/app/globals.css`
- Modify: `web/components/features/Sidebar.tsx`
- Modify: `web/components/layout/PageHeader.tsx`
- Test: `web/app/design-system-tokens.test.ts`
- Test: `web/components/features/Sidebar.test.tsx`
- Test: `web/components/layout/layout-components.test.tsx`

**Interfaces:**
- Produces CSS variables `--control`, `--control-hover`, `--app-header-height` in both themes.
- Produces `data-slot="page-header"` and a 72px minimum header contract.

- [ ] **Step 1: Write failing token and layout assertions.** Assert both theme blocks contain the three variables, Sidebar brand header uses the shared height class, and `PageHeader` exposes the data slot/min-height contract.
- [ ] **Step 2: Run focused tests and confirm the new assertions fail for the missing variables/classes.**
- [ ] **Step 3: Add the variables and update Sidebar/PageHeader to use the shared 72px contract.** Keep existing compact breakpoint behavior unchanged.
- [ ] **Step 4: Run the same focused tests and confirm they pass.**
- [ ] **Step 5: Commit with `feat: establish shared theme and header tokens`.**

### Task 2: Add shared native select styling and align Base UI Select

**Files:**
- Create: `web/components/ui/native-select.tsx`
- Modify: `web/components/ui/select.tsx`
- Test: `web/components/ui/ui-primitives.test.tsx`
- Test: `web/components/ui/native-select.test.tsx`
- Modify: `web/app/globals.css`

**Interfaces:**
- `NativeSelect(props: React.ComponentProps<'select'>)` renders a native select with `data-slot="native-select"`.
- `nativeSelectClass` is reusable when a page needs to keep an inline native select element.

- [ ] **Step 1: Add failing tests for the data slot, semantic classes, option theme behavior, and Base UI trigger surface classes.**
- [ ] **Step 2: Run only the new/control tests and confirm failure.**
- [ ] **Step 3: Implement `NativeSelect`, global option color rules, and update `SelectTrigger` to use control/control-hover tokens.**
- [ ] **Step 4: Run the control test files and confirm pass.**
- [ ] **Step 5: Commit with `feat: standardize themed select controls`.**

### Task 3: Migrate all application native selects

**Files:**
- Modify: `web/app/assets/AssetsClient.tsx`
- Modify: `web/app/creation-rules/CreationRuleDialog.tsx`
- Modify: `web/app/creation-rules/TaskLogList.tsx`
- Modify: `web/app/drafts/DraftsClient.tsx`
- Modify: `web/app/drafts/WechatPublishPanel.tsx`
- Modify: `web/app/github/GithubClient.tsx`
- Modify: `web/app/responses/ResponseDestinationDialog.tsx`
- Modify: `web/app/writing-plans/WritingPlansClient.tsx`
- Modify: `web/app/x/XSubscriptionDialog.tsx`
- Test: affected existing component tests plus `web/e2e/theme-native-select.spec.ts`

**Interfaces:**
- Every application native `<select>` is either `NativeSelect` or explicitly has `data-slot="native-select"` and `nativeSelectClass`.

- [ ] **Step 1: Add a static migration assertion that scans application source and fails if a raw `<select` lacks the shared data slot/component usage.**
- [ ] **Step 2: Run the assertion and record the current raw-select failures.**
- [ ] **Step 3: Migrate each listed select, preserving labels, values, event handlers, widths and option content.**
- [ ] **Step 4: Run affected Vitest files and the native-select Playwright test in both color schemes.**
- [ ] **Step 5: Commit with `refactor: migrate app selects to themed control`.**

### Task 4: Migrate page shells, headers, and neutral surfaces

**Files:**
- Modify: `web/app/creation-rules/CreationRulesClient.tsx`
- Modify: `web/app/digital-humans/DigitalHumansClient.tsx`
- Modify: `web/app/responses/ResponsesClient.tsx`
- Modify: `web/app/chat/ChatClient.tsx`
- Modify: `web/app/assets/AssetsClient.tsx`
- Modify: `web/app/github/GithubClient.tsx`
- Modify: `web/app/papers/PapersClient.tsx`
- Modify: `web/app/wechat/WechatClient.tsx`
- Modify: `web/app/youtube/YoutubeClient.tsx`
- Modify: `web/app/reddit/RedditClient.tsx`
- Modify: `web/app/juejin/JuejinClient.tsx`
- Modify: `web/app/kr/KrClient.tsx`
- Modify: `web/app/producthunt/ProductHuntClient.tsx`
- Modify: `web/app/v2ex/V2exClient.tsx`
- Modify: `web/app/writing-plans/WritingPlansClient.tsx`
- Modify: `web/app/drafts/DraftsClient.tsx`
- Modify: `web/app/text-video/TextVideoWorkbench.tsx`
- Test: `web/e2e/ui-foundations.spec.ts`
- Test: focused tests for modified clients

**Interfaces:**
- Top-level page headers expose `data-slot="page-header"` or use `PageHeader`.
- Major neutral surfaces use `bg-background`, `bg-surface`, `bg-surface-muted`, `bg-muted`, `text-foreground`, `text-muted-foreground`, `text-foreground-subtle`, `border-border`.

- [ ] **Step 1: Add a static audit test for the required page-header slot and a small list of prohibited top-level legacy neutral surface classes.**
- [ ] **Step 2: Run it and capture the current page files that fail.**
- [ ] **Step 3: Update the shared workspace/page shells first, then migrate each source page header and visible neutral surface.** Do not change status colors or code/media-specific dark surfaces.
- [ ] **Step 4: Run focused client/layout tests.**
- [ ] **Step 5: Commit with `refactor: align page shells with theme tokens`.**

### Task 5: Rendered theme and responsive verification

**Files:**
- Modify: `web/e2e/ui-foundations.spec.ts`
- Create: `web/e2e/theme-consistency.spec.ts`

**Interfaces:**
- The audit covers `/`, `/assets`, `/settings`, `/github`, `/writing-plans`, `/creation-rules`, `/x`, `/wechat` at 1440px and 1024px in light and dark themes.

- [ ] **Step 1: Add failing assertions for header height, native select computed colors, no horizontal overflow, and no obvious legacy neutral backgrounds in the first viewport.**
- [ ] **Step 2: Run the Playwright audit against the local frontend and confirm the pre-fix failures.**
- [ ] **Step 3: Adjust only the styles/components needed to satisfy the measured failures.**
- [ ] **Step 4: Run the complete theme consistency audit and collect screenshots in `/tmp` only.**
- [ ] **Step 5: Run `git diff --check` and the full focused regression set.**
- [ ] **Step 6: Commit with `test: verify theme consistency across app surfaces`.**

### Task 6: Final review and handoff

- [ ] **Step 1: Re-read the design and plan, then audit every requirement against current files and fresh test output.**
- [ ] **Step 2: Run `git status --short`, `git diff --check`, focused Vitest, and Playwright commands again after the final edit.**
- [ ] **Step 3: Summarize modified files, visual evidence, passed tests, and any unrelated baseline failures.**
