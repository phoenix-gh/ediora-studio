# Draft Bulk Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add visible-result multi-selection to the draft inbox with reliable bulk group deletion, cover generation, and illustration generation.

**Architecture:** Keep backend contracts unchanged and orchestrate existing per-draft APIs in the frontend. Put bounded concurrency and group semantics in a pure tested module, keep account/style form state in a dedicated dialog, and let `DraftsClient` own only visible selection, progress, and result presentation.

**Tech Stack:** Next.js 16, React 19, TypeScript, Vitest, Testing Library, existing shadcn/Base UI components, Sonner, existing Python API contracts.

## Global Constraints

- Selection is group-based and never includes groups hidden by the current filters.
- Cover and illustration jobs target only a group's `draft_type === "article"` draft.
- One account and parameter set is shared by every item in a bulk image run.
- Bulk operations run no more than three group operations concurrently.
- Successful groups leave the selection; failed groups remain selected when still present.
- Group deletion removes variants before the root and refreshes server truth after completion.
- No backend batch endpoint, schema migration, parent job type, or unrelated refactor.
- Do not stage or modify the existing unrelated backend, text-video, assets, or X changes in the working tree.

---

### Task 1: Tested Bulk Operation Primitives

**Files:**
- Create: `web/app/drafts/draft-bulk-operations.ts`
- Create: `web/app/drafts/draft-bulk-operations.test.ts`

**Interfaces:**
- Consumes: `Draft` from `@/lib/api/drafts` and an injected `(id: number) => Promise<void>` delete function.
- Produces: `DraftGroup`, `articleDraftForGroup(group)`, `deleteDraftGroup(group, remove)`, and `runBulkOperations(groups, operation, onProgress?, concurrency?)`.

- [ ] **Step 1: Write failing tests for group target and deletion semantics**

Add real `Draft` fixtures and tests equivalent to:

```ts
it('resolves only the article draft in a group', () => {
  const group = { root: article(1), variants: [platform(2, 'x', 1)] }
  expect(articleDraftForGroup(group)?.id).toBe(1)
  expect(articleDraftForGroup({ root: platform(3, 'x', 99), variants: [] })).toBeNull()
})

it('deletes variants before the group root', async () => {
  const calls: number[] = []
  await deleteDraftGroup(
    { root: article(1), variants: [platform(2, 'x', 1), platform(3, 'mp', 1)] },
    async id => { calls.push(id) },
  )
  expect(calls).toEqual([2, 3, 1])
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd web
pnpm test app/drafts/draft-bulk-operations.test.ts
```

Expected: FAIL because `draft-bulk-operations.ts` and its exports do not exist.

- [ ] **Step 3: Implement the group contract and deletion helper**

Create the module with these exact public shapes:

```ts
import type { Draft } from '@/lib/api/drafts'

export interface DraftGroup {
  root: Draft
  variants: Draft[]
}

export function articleDraftForGroup(group: DraftGroup): Draft | null {
  return [group.root, ...group.variants].find(draft => draft.draft_type === 'article') ?? null
}

export async function deleteDraftGroup(
  group: DraftGroup,
  remove: (id: number) => Promise<void>,
): Promise<void> {
  for (const variant of group.variants) await remove(variant.id)
  await remove(group.root.id)
}
```

- [ ] **Step 4: Verify the target and deletion tests pass**

Run the focused test again. Expected: PASS.

- [ ] **Step 5: Write a failing bounded-concurrency test**

Use deferred promises to assert that only three operations start before any resolves, all items eventually settle in input order, rejections do not stop other groups, and progress advances once per settled group:

```ts
const pending = groups.map(() => deferred<void>())
let active = 0
let maximumActive = 0
const progress: Array<[number, number]> = []
const resultPromise = runBulkOperations(groups, async (_, index) => {
  active += 1
  maximumActive = Math.max(maximumActive, active)
  await pending[index].promise
  active -= 1
}, (completed, total) => progress.push([completed, total]))

expect(maximumActive).toBe(3)
```

- [ ] **Step 6: Run the focused test and verify RED**

Expected: FAIL because `runBulkOperations` is not implemented.

- [ ] **Step 7: Implement the bounded worker pool**

Use these result types and behavior:

```ts
export interface BulkOperationResult {
  groupId: number
  title: string
  status: 'fulfilled' | 'rejected'
  reason?: string
}

export async function runBulkOperations(
  groups: DraftGroup[],
  operation: (group: DraftGroup, index: number) => Promise<void>,
  onProgress: (completed: number, total: number) => void = () => {},
  concurrency = 3,
): Promise<BulkOperationResult[]> {
  const results = new Array<BulkOperationResult>(groups.length)
  let cursor = 0
  let completed = 0

  async function worker() {
    while (cursor < groups.length) {
      const index = cursor++
      const group = groups[index]
      try {
        await operation(group, index)
        results[index] = { groupId: group.root.id, title: group.root.title, status: 'fulfilled' }
      } catch (error) {
        results[index] = {
          groupId: group.root.id,
          title: group.root.title,
          status: 'rejected',
          reason: error instanceof Error ? error.message : '操作失败',
        }
      } finally {
        completed += 1
        onProgress(completed, groups.length)
      }
    }
  }

  const workerCount = Math.min(Math.max(1, concurrency), groups.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}
```

- [ ] **Step 8: Run focused tests and commit**

Run:

```bash
pnpm test app/drafts/draft-bulk-operations.test.ts
git add web/app/drafts/draft-bulk-operations.ts web/app/drafts/draft-bulk-operations.test.ts
git commit -m "feat: add draft bulk operation runner"
```

Expected: all focused tests PASS and only the two task files are committed.

### Task 2: Bulk Image Action Dialog

**Files:**
- Create: `web/app/drafts/BulkImageActionDialog.tsx`
- Create: `web/app/drafts/BulkImageActionDialog.test.tsx`

**Interfaces:**
- Consumes: `listPublishAccounts`, `CoverStyleEditor`, and `buildCoverStyleFromEditor`.
- Produces: `BulkImageMode = 'cover' | 'illustrations'`, `BulkImageOptions`, and `BulkImageActionDialog`.

- [ ] **Step 1: Write failing dialog behavior tests**

Mock only the publish-account API and cover-style editor. Cover these behaviors:

```tsx
render(<BulkImageActionDialog
  open mode="illustrations" selectedCount={2}
  running={false} progress={{ completed: 0, total: 2 }} failures={[]}
  onClose={onClose} onSubmit={onSubmit}
/>)

expect(await screen.findByText('账号 A')).toBeTruthy()
fireEvent.change(screen.getByLabelText('发布账号'), { target: { value: 'account-a' } })
fireEvent.change(screen.getByLabelText('每篇最多插图'), { target: { value: '4' } })
fireEvent.click(screen.getByRole('button', { name: '开始批量插图' }))
expect(onSubmit).toHaveBeenCalledWith({ mode: 'illustrations', accountId: 'account-a', note: '', maxImages: 4 })
```

Also assert that cover mode adopts the chosen account's `cover_style`, applies the shared style builder before submit, displays `3 / 12` while running, disables close/submit while running, and lists failed titles and reasons.

- [ ] **Step 2: Run the dialog test and verify RED**

Run:

```bash
pnpm test app/drafts/BulkImageActionDialog.test.tsx
```

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the minimal typed dialog**

Use these public contracts:

```ts
export type BulkImageMode = 'cover' | 'illustrations'

export type BulkImageOptions =
  | { mode: 'cover'; accountId: string; note: string; coverStyle?: CoverStyle }
  | { mode: 'illustrations'; accountId: string; note: string; maxImages: number }

interface Props {
  open: boolean
  mode: BulkImageMode
  selectedCount: number
  running: boolean
  progress: { completed: number; total: number }
  failures: Array<{ title: string; reason?: string }>
  onClose: () => void
  onSubmit: (options: BulkImageOptions) => void
}
```

Implementation requirements:

- Load and retain only active accounts when the dialog opens.
- Use a labeled `<select>` for account choice in both modes.
- On account change, copy its cover-style values into local state.
- In cover mode, render `CoverStyleEditor` inside a `<details>` section and submit the non-empty built style.
- In illustration mode, clamp `maxImages` to 1-4 both on input and submission.
- Keep dialog open during execution and prevent closing through overlay, escape, cancel, or submit.
- Render exact progress and a compact failure list after execution.
- Do not call image job APIs from this component.

- [ ] **Step 4: Verify dialog tests and refactor without changing behavior**

Run the focused test. Expected: PASS with no React act warnings or console errors.

- [ ] **Step 5: Commit the dialog**

```bash
git add web/app/drafts/BulkImageActionDialog.tsx web/app/drafts/BulkImageActionDialog.test.tsx
git commit -m "feat: add draft bulk image dialog"
```

### Task 3: Visible Selection and Bulk Image Dispatch

**Files:**
- Modify: `web/app/drafts/DraftsClient.tsx:17-50, 130-170, 296-304, 631-748, 1052-1102`
- Modify: `web/app/drafts/DraftsClient.test.tsx`

**Interfaces:**
- Consumes: Task 1's `DraftGroup`, `articleDraftForGroup`, `runBulkOperations`; Task 2's dialog and `BulkImageOptions`; existing `regenerateCover` and `illustrateBody` APIs.
- Produces: visible-only group selection, batch toolbar, cover and illustration dispatch, progress, and settled-result selection updates.

- [ ] **Step 1: Extend test mocks before changing production code**

Add controllable mocks for `regenerateCover`, `illustrateBody`, and `BulkImageActionDialog`. The dialog mock must expose buttons that call `onSubmit` with deterministic cover and illustration options so the client test exercises real page orchestration rather than the dialog form twice.

- [ ] **Step 2: Write failing selection behavior tests**

Add tests that assert:

```ts
fireEvent.click(screen.getByRole('checkbox', { name: '选择草稿 A' }))
expect(screen.getByText('已选 1 组')).toBeTruthy()
expect(screen.getByPlaceholderText('标题…')).toHaveValue('草稿 A')

fireEvent.click(screen.getByRole('button', { name: '全选当前结果' }))
expect(screen.getByText('已选 2 组')).toBeTruthy()
```

Then change the status filter so one selected group becomes hidden and assert the count is intersected with visible results. Add one draft with a different status for this test.

- [ ] **Step 3: Run the client test and verify RED**

Run:

```bash
pnpm test app/drafts/DraftsClient.test.tsx
```

Expected: FAIL because selection checkboxes and the bulk toolbar are absent.

- [ ] **Step 4: Implement visible selection state and toolbar**

Make these focused changes:

- Import `DraftGroup` instead of declaring a duplicate local interface.
- Store `selectedGroupIds` as `Set<number>` and update it with functional `setState` calls.
- Memoize `groups` from `drafts`, `filteredGroups` from groups plus both filters, and `visibleGroupIds` from `filteredGroups` so selection changes do not recreate those collections.
- In an effect keyed by the memoized `visibleGroupIds`, intersect the prior selection with visible IDs and return the prior `Set` when its membership did not change.
- Place a checkbox beside, not inside, the existing row `<button>` to avoid nested interactive controls.
- Wrap each row in a flex container; keep the existing row button responsible for draft activation.
- Render the toolbar under filters with accessible action names and disable actions when no group is selected or a bulk run is active.

- [ ] **Step 5: Verify selection tests pass**

Run the focused client test. Expected: selection tests PASS and existing async identity tests remain PASS.

- [ ] **Step 6: Write failing cover and illustration dispatch tests**

Create a root article with an X variant and a second article group. Select both groups and submit each mocked dialog mode. Assert exactly one request per article target and shared parameters:

```ts
expect(regenerateCover).toHaveBeenCalledWith({
  draft_id: 1,
  account_id: 'account-a',
  note: '冷色调',
  cover_style: { palette: 'cool' },
})

expect(illustrateBody).toHaveBeenCalledWith({
  draft_id: 4,
  account_id: 'account-a',
  note: '解释结构',
  max_images: 3,
})
```

Add an orphan platform-only group and assert it makes no image API call, appears as a failed result, and remains selected while successful groups are cleared.

- [ ] **Step 7: Run the focused client test and verify RED**

Expected: FAIL because image dispatch is not wired.

- [ ] **Step 8: Implement bulk image orchestration**

Add `bulkMode`, `bulkRunning`, `bulkProgress`, and `bulkFailures` state. On submit:

1. Snapshot selected visible groups.
2. Reset failures, set progress total, and mark running.
3. Call `runBulkOperations` with concurrency `3`.
4. Resolve `articleDraftForGroup`; throw `new Error('缺少文章主版本')` before any API call when absent.
5. Call `regenerateCover` or `illustrateBody` using the submitted discriminated union.
6. Remove fulfilled group IDs from selection and retain rejected visible IDs.
7. Display `批量任务已提交：成功 X，失败 Y` or the all-success/all-failure equivalent through Sonner.
8. Keep the dialog open on failures; close it after complete success.

- [ ] **Step 9: Run tests and commit selection/image dispatch**

```bash
pnpm test app/drafts/DraftsClient.test.tsx app/drafts/BulkImageActionDialog.test.tsx app/drafts/draft-bulk-operations.test.ts
git add web/app/drafts/DraftsClient.tsx web/app/drafts/DraftsClient.test.tsx
git commit -m "feat: add draft multi-select image actions"
```

### Task 4: Whole-Group Bulk Delete and Full Verification

**Files:**
- Modify: `web/app/drafts/DraftsClient.tsx:431-466, 631-748, 1052-1069`
- Modify: `web/app/drafts/DraftsClient.test.tsx`

**Interfaces:**
- Consumes: Task 1's `deleteDraftGroup` and `runBulkOperations`, existing `deleteDraft`, `getDrafts`, and confirm dialog.
- Produces: confirmed whole-group deletion, server refresh, partial-failure reporting, and valid active-editor selection after refresh.

- [ ] **Step 1: Write a failing whole-group deletion test**

Select a group containing two variants plus another root group, click `批量删除`, assert the confirmation text includes `2 组`, confirm, and verify calls within the first group are ordered variant IDs before root ID. The scheduler may interleave separate groups, so assert per-group ordering rather than one global sequence.

- [ ] **Step 2: Write a failing partial-failure refresh test**

Make one group's delete reject and `getDrafts` return the surviving server state. Assert:

- Every selected group was attempted.
- `getDrafts` runs once after all deletion attempts settle.
- The failed surviving group remains selected.
- Successfully deleted groups disappear.
- The active editor moves to an existing refreshed draft if its draft was removed.
- The summary reports exact success and failure counts and does not claim full success.

- [ ] **Step 3: Run the focused client test and verify RED**

Expected: FAIL because bulk deletion is not implemented.

- [ ] **Step 4: Implement confirmed deletion and refresh reconciliation**

The confirm callback must snapshot selected visible groups, then:

```ts
const results = await runBulkOperations(
  selectedGroups,
  group => deleteDraftGroup(group, deleteDraft),
  (completed, total) => setBulkProgress({ completed, total }),
  3,
)
const fresh = await getDrafts()
setDrafts(fresh)
```

Reconcile selection against rejected group IDs that still exist in `buildGroups(fresh)`. If the active draft no longer exists, activate the first refreshed root; if it remains, activate its refreshed instance without restoring a deleted/stale draft. Clear running state in `finally` and report exact settled counts.

- [ ] **Step 5: Run all draft bulk tests**

```bash
pnpm test app/drafts/DraftsClient.test.tsx app/drafts/BulkImageActionDialog.test.tsx app/drafts/draft-bulk-operations.test.ts
```

Expected: PASS with no warnings.

- [ ] **Step 6: Run frontend regression and static gates**

```bash
pnpm test
pnpm lint
pnpm build
```

Expected: all tests pass, ESLint exits zero, and the Next.js production build succeeds. If an unrelated pre-existing failure occurs, record the exact failing test/file and prove the three focused bulk-action test files still pass; never label the full gate as passed.

- [ ] **Step 7: Review scope and diff hygiene**

Run:

```bash
git diff --check -- web/app/drafts/DraftsClient.tsx web/app/drafts/DraftsClient.test.tsx web/app/drafts/BulkImageActionDialog.tsx web/app/drafts/BulkImageActionDialog.test.tsx web/app/drafts/draft-bulk-operations.ts web/app/drafts/draft-bulk-operations.test.ts
git status --short
git diff -- web/app/drafts/DraftsClient.tsx web/app/drafts/DraftsClient.test.tsx web/app/drafts/BulkImageActionDialog.tsx web/app/drafts/BulkImageActionDialog.test.tsx web/app/drafts/draft-bulk-operations.ts web/app/drafts/draft-bulk-operations.test.ts
```

Confirm no backend, text-video, assets, X, database WAL, or other pre-existing changes are included.

- [ ] **Step 8: Commit the completed deletion integration**

```bash
git add web/app/drafts/DraftsClient.tsx web/app/drafts/DraftsClient.test.tsx
git commit -m "feat: add draft bulk group deletion"
```

- [ ] **Step 9: Apply verification-before-completion**

Re-run the exact focused suite after the final commit, inspect its fresh output, and only then report the feature complete. Include focused test counts plus the separate results of full test, lint, and build gates.
