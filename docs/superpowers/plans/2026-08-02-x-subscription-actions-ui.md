# X Subscription Actions UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the overflowing inline X subscription actions with a stable information row, visible collect button, enable switch, and accessible overflow menu.

**Architecture:** Extract a focused `XSubscriptionRow` from `XClient.tsx`; keep mutation state and API handlers in `SubscribeDialog`. Add a project-native Base UI menu wrapper so the row can expose secondary actions without duplicating popup accessibility and styling.

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind CSS, Base UI Menu, Lucide React, Vitest, Testing Library.

## Global Constraints

- `采集` is the only permanently visible action button.
- Preserve all existing subscription operations and backend contracts.
- Timeline-only actions are omitted for search subscriptions.
- Long content must not compress the fixed action cluster or create horizontal scrolling.
- Use existing Base UI, Tailwind, and Lucide conventions; do not introduce a new dependency.
- Do not modify unrelated X feed, asset, or text-video work already present in the worktree.

---

### Task 1: Accessible Menu Primitive

**Files:**
- Create: `wemedia-studio/components/ui/dropdown-menu.tsx`
- Modify: `wemedia-studio/components/ui/ui-primitives.test.tsx`

**Interfaces:**
- Consumes: `@base-ui/react/menu`, `cn()` from `@/lib/utils`.
- Produces: `DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuItem`, and `DropdownMenuSeparator` React components.

- [ ] **Step 1: Write the failing primitive test**

Add a test that renders a trigger labelled `更多操作`, opens it, verifies a menu item labelled `编辑订阅`, and verifies the destructive item receives its destructive data/style contract.

- [ ] **Step 2: Run the primitive test and confirm RED**

Run: `pnpm exec vitest run components/ui/ui-primitives.test.tsx`

Expected: FAIL because `dropdown-menu.tsx` and its exports do not exist.

- [ ] **Step 3: Implement the menu wrapper**

Wrap `Menu.Root`, `Menu.Trigger`, `Menu.Portal`, `Menu.Positioner`, `Menu.Popup`, and `Menu.Item`. Use the existing popover surface tokens, an 8rem minimum width, keyboard focus styles, disabled styles, open/closed animation data attributes, and an item `variant` prop with `default | destructive`.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm exec vitest run components/ui/ui-primitives.test.tsx`

Expected: all primitive tests PASS.

- [ ] **Step 5: Commit the primitive**

```bash
git add wemedia-studio/components/ui/dropdown-menu.tsx wemedia-studio/components/ui/ui-primitives.test.tsx
git commit -m "feat: add accessible dropdown menu primitive"
```

### Task 2: Compact Subscription Row

**Files:**
- Create: `wemedia-studio/app/x/XSubscriptionRow.tsx`
- Create: `wemedia-studio/app/x/XSubscriptionRow.test.tsx`
- Modify: `wemedia-studio/app/x/XClient.tsx`

**Interfaces:**
- Consumes: `XSubscription`, `TopicSourceRule`, `busy`, `collecting`, `screening`, and callback props for toggle, collect, edit, notification, ingestion, screening, backfill, and delete.
- Produces: `XSubscriptionRow` and an exported `XSubscriptionRowProps` type. The component performs no network requests and owns no mutation state.

- [ ] **Step 1: Write failing row hierarchy tests**

Render a timeline subscription with callback spies. Assert that `采集`, `启用订阅`, and `更多操作` are visible before opening the menu; assert that editing, instant response, asset ingestion, AI screening, backfill, and delete appear only after opening it. Assert clicking `采集` invokes only `onCollect`.

- [ ] **Step 2: Write failing subscription-kind and busy-state tests**

Render a search subscription and assert the open menu omits instant response and backfill. Render a busy subscription and assert its switch, collect button, and menu trigger are disabled. Render a screening subscription and assert the AI screening item is disabled and exposes a loading label.

- [ ] **Step 3: Run row tests and confirm RED**

Run: `pnpm exec vitest run app/x/XSubscriptionRow.test.tsx`

Expected: FAIL because `XSubscriptionRow` does not exist.

- [ ] **Step 4: Implement the presentational row**

Build a responsive row with `min-w-0 flex-1` metadata and `shrink-0` controls. Preserve the existing icon, type badge, URL/query, post count, collection timestamp, error, rule count, and disabled opacity. Label the switch `启用订阅：<name>`, use a spinner and `采集中` label for collection, use an ellipsis trigger labelled `更多操作：<name>`, and group delete below a separator.

- [ ] **Step 5: Replace the inline action block in `SubscribeDialog`**

Keep `editingId`, `editValue`, `commitEdit`, `busyId`, `screeningId`, the topic dialog, and backfill dialog in the parent. Pass callbacks into `XSubscriptionRow`; selecting edit must preserve the current timeline inline-name editor and search-form editing paths. Keep the existing confirmation copy before calling `onDelete`.

- [ ] **Step 6: Verify row and existing X tests GREEN**

Run: `pnpm exec vitest run app/x/XSubscriptionRow.test.tsx app/x/XClient.test.tsx`

Expected: all tests PASS.

- [ ] **Step 7: Commit the row redesign**

```bash
git add wemedia-studio/app/x/XSubscriptionRow.tsx wemedia-studio/app/x/XSubscriptionRow.test.tsx wemedia-studio/app/x/XClient.tsx
git commit -m "feat: compact X subscription row actions"
```

### Task 3: Responsive and Regression Verification

**Files:**
- Modify only if verification finds an issue: `wemedia-studio/app/x/XSubscriptionRow.tsx`
- Modify only if a regression assertion is missing: `wemedia-studio/app/x/XSubscriptionRow.test.tsx`

**Interfaces:**
- Consumes: the completed dropdown primitive and subscription row.
- Produces: verified desktop and narrow layouts with no horizontal overflow or clipped primary actions.

- [ ] **Step 1: Run scoped automated verification**

Run:

```bash
pnpm exec vitest run components/ui/ui-primitives.test.tsx app/x/XSubscriptionRow.test.tsx app/x/XClient.test.tsx
pnpm exec eslint components/ui/dropdown-menu.tsx app/x/XSubscriptionRow.tsx app/x/XSubscriptionRow.test.tsx app/x/XClient.tsx
```

Expected: all selected tests and ESLint PASS.

- [ ] **Step 2: Run TypeScript verification**

Run: `pnpm exec tsc --noEmit --pretty false`

Expected: no new errors in the files changed by this plan. If unrelated dirty text-video files still fail, record their exact paths separately.

- [ ] **Step 3: Verify the live dialog at desktop width**

Open `/x`, open `订阅管理`, and verify a timeline subscription shows metadata, the switch, `采集`, and the ellipsis trigger without overlap. Open the menu and exercise each secondary action through its existing dialog or handler.

- [ ] **Step 4: Verify the live dialog at narrow width**

Use a mobile or narrow laptop viewport. Confirm the row wraps only within its intended layout, no horizontal scrollbar appears, long content remains contained, and the collect and menu controls remain reachable.

- [ ] **Step 5: Capture and inspect the final render**

Capture the desktop and narrow dialog states, inspect the screenshots for alignment, typography, focus styling, destructive separation, clipping, and dark/light surface compatibility, and remove temporary QA artifacts.

- [ ] **Step 6: Commit any verification fixes**

```bash
git add wemedia-studio/app/x/XSubscriptionRow.tsx wemedia-studio/app/x/XSubscriptionRow.test.tsx
git commit -m "fix: polish responsive X subscription actions"
```
