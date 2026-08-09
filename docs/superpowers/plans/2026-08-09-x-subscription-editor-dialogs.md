# X Subscription Editor Dialogs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the aggregate X subscription management dialog with a create dialog and independent per-subscription edit dialogs.

**Architecture:** Keep X feed state and API side effects in `XClient`. Extract the dialog form into `XSubscriptionDialog`, which supports `create` and `edit` modes and receives typed callbacks for persistence and collection actions. Add an edit action beside each subscription in the sidebar without changing feed selection.

**Tech Stack:** React, Next.js client components, Base UI Dialog, Tailwind CSS, Vitest Testing Library, Playwright.

## Global Constraints

- Preserve existing X subscription API contracts.
- Use dialogs, not drawers.
- Keep URL read-only for existing timeline subscriptions because the current PATCH API cannot update it.
- Run focused tests only; do not run the full test suite.

## Tasks

### Task 1: Add failing interaction coverage

**Files:**
- Modify: `wemedia-studio/app/x/XClient.test.tsx`

- [ ] Assert that the header exposes `新增订阅` and no longer exposes `订阅管理`.
- [ ] Assert that a sidebar edit button opens a single-subscription dialog.
- [ ] Assert that the dialog contains the delete action and requires an in-dialog confirmation before calling `deleteXSubscription`.
- [ ] Assert that clicking the edit button does not select the feed.

### Task 2: Implement the dialog split

**Files:**
- Create: `wemedia-studio/app/x/XSubscriptionDialog.tsx`
- Modify: `wemedia-studio/app/x/XClient.tsx`

- [ ] Add create mode for timeline/search subscriptions.
- [ ] Add edit mode with current subscription values, save, enable, frequency, intelligence, ingestion rule, collection, backfill, screening, and delete actions.
- [ ] Use one scrollable dialog and an inline delete confirmation state.
- [ ] Replace the aggregate subscription list dialog with the create/edit dialog state.
- [ ] Add sidebar edit controls with `stopPropagation`.

### Task 3: Remove obsolete aggregate row path

**Files:**
- Delete: `wemedia-studio/app/x/XSubscriptionRow.tsx`
- Delete: `wemedia-studio/app/x/XSubscriptionRow.test.tsx`

- [ ] Remove the old list-row action menu and its tests after the new editor owns those actions.

### Task 4: Focused verification

**Files:**
- No production files.

- [ ] Run `pnpm exec vitest run app/x/XClient.test.tsx app/x/XSubscriptionDialog.test.tsx lib/api/x.test.ts`.
- [ ] Run scoped ESLint over changed X files.
- [ ] Run `git diff --check`.
- [ ] Exercise `/x` in Playwright and verify create dialog, edit dialog, and feed-selection isolation.
