# Draft Modifier Multi-Select Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace draft-list checkboxes with Ctrl/Cmd + click multi-selection and a selected-row background.

**Architecture:** Keep `selectedDraftIds` and every existing bulk action unchanged. Interpret the modifier key only in the existing list-row click handler: a modified click toggles selection without activating the draft; an ordinary click follows the current activation flow. The list row derives its background from active and bulk-selected state.

**Tech Stack:** Next.js 16, React 19, TypeScript, Vitest, Testing Library, Tailwind utilities.

## Global Constraints

- No checkbox or extra interactive control remains in a draft row.
- Ctrl + click toggles selection on Windows and Linux; Meta/Cmd + click does the same on macOS.
- A normal click activates the draft and must not change existing bulk selection.
- Ctrl/Cmd + click must not replace the active editor draft or trigger image loading.
- A bulk-selected row has a distinct background; the active-row left border stays intact.
- Existing bulk toolbar, select-all, filtering, deletion, cover, and illustration flows retain their current contracts.
- Modify only the draft client, its test, and this plan; do not include unrelated working-tree changes.

---

### Task 1: Test Modifier-Based Row Selection

**Files:**
- Modify: `wemedia-studio/app/drafts/DraftsClient.test.tsx`

**Interfaces:**
- Consumes: rendered `DraftsClient` list rows by their existing visible draft titles.
- Produces: regression coverage for plain click activation, Ctrl/Cmd selection, absence of checkboxes, selected-row styling, and filter reconciliation.

- [ ] **Step 1: Replace the checkbox rendering assertion with a row-only assertion**

Add this test expectation after rendering two drafts:

```tsx
expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
expect(screen.getByText('草稿 A').closest('button')).toBeVisible()
expect(screen.getByText('X 草稿').closest('button')).toBeVisible()
```

- [ ] **Step 2: Add the failing Ctrl/Cmd selection behavior test**

Use a literal click event with `ctrlKey: true`, then assert that the editor remains on A and the B row has the selection class:

```tsx
fireEvent.click(screen.getByText('草稿 B').closest('button')!, { ctrlKey: true })

expect(screen.getByText('已选 1 篇')).toBeInTheDocument()
expect(screen.getByPlaceholderText('标题…')).toHaveValue('草稿 A')
expect(screen.getByText('草稿 B').closest('button')).toHaveClass('bg-sky-50')
```

Repeat the click with `{ metaKey: true }` and assert `已选 0 篇` to protect Cmd behavior.

- [ ] **Step 3: Add the failing ordinary-click behavior test**

After Ctrl-selecting B, click B without modifiers and assert its title appears in the editor while the selected count stays one:

```tsx
fireEvent.click(screen.getByText('草稿 B').closest('button')!)

expect(screen.getByPlaceholderText('标题…')).toHaveValue('草稿 B')
expect(screen.getByText('已选 1 篇')).toBeInTheDocument()
```

- [ ] **Step 4: Update the filter reconciliation test to select via Ctrl click**

Replace checkbox interaction assertions with Ctrl-click actions and assert the hidden draft row is absent plus the visible retained row has `bg-sky-50`.

- [ ] **Step 5: Run the focused test to verify RED**

Run:

```bash
cd wemedia-studio
pnpm test app/drafts/DraftsClient.test.tsx
```

Expected: FAIL because checkbox controls still render and the row click handler ignores modifier keys.

### Task 2: Implement Row Gesture and Visual State

**Files:**
- Modify: `wemedia-studio/app/drafts/DraftsClient.tsx`
- Test: `wemedia-studio/app/drafts/DraftsClient.test.tsx`

**Interfaces:**
- Consumes: `React.MouseEvent<HTMLButtonElement>` from each draft row and the existing `toggleDraftSelection(draftId)` / `handleSelectDraft(draft)` functions.
- Produces: one button per row with normal activation or Ctrl/Cmd selection semantics.

- [ ] **Step 1: Remove the checkbox import and markup**

Delete:

```tsx
import { Checkbox } from '@/components/ui/checkbox'
```

Delete the row wrapper containing `<Checkbox ... />` so the list row contains only the existing button.

- [ ] **Step 2: Implement a modifier-aware row handler**

Add a handler before the JSX:

```tsx
function handleDraftRowClick(event: React.MouseEvent<HTMLButtonElement>, draft: Draft) {
  if (event.ctrlKey || event.metaKey) {
    toggleDraftSelection(draft.id)
    return
  }
  handleSelectDraft(draft)
}
```

Wire it to the row button with:

```tsx
onClick={event => handleDraftRowClick(event, draft)}
```

- [ ] **Step 3: Derive selected visual state on the row button**

For each mapped draft, define:

```tsx
const isBulkSelected = selectedDraftIds.has(draft.id)
```

Add `isBulkSelected && 'bg-sky-50 dark:bg-sky-950/30'` to the existing button `className`. Keep the existing active background after it so active state remains visible.

- [ ] **Step 4: Run the focused test to verify GREEN**

Run:

```bash
cd wemedia-studio
pnpm test app/drafts/DraftsClient.test.tsx
```

Expected: PASS, including existing bulk dispatch and deletion tests updated to select rows with Ctrl clicks.

- [ ] **Step 5: Run the relevant complete regression suite**

Run:

```bash
cd wemedia-studio
pnpm test app/drafts/DraftsClient.test.tsx app/drafts/BulkImageActionDialog.test.tsx app/drafts/draft-bulk-operations.test.ts
pnpm lint
git diff --check -- app/drafts/DraftsClient.tsx app/drafts/DraftsClient.test.tsx
```

Expected: focused tests pass, lint exits zero, and the scoped diff has no whitespace errors. If a full command has an unrelated existing failure, report it separately and do not call that gate passed.

- [ ] **Step 6: Commit only scoped files when Git metadata is writable**

```bash
git add app/drafts/DraftsClient.tsx app/drafts/DraftsClient.test.tsx docs/superpowers/plans/2026-08-04-draft-modifier-multiselect.md
git commit -m "feat: use modifier clicks for draft multi-select"
```

If the workspace prevents writes to `.git`, leave the scoped changes unstaged and report the exact Git failure.
