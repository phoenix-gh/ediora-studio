# Response Creation Session Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the adopted response's creation panel usable across pending-list refreshes, then move to the latest next response only when that creation session ends.

**Architecture:** Keep `creationDetail` as the authoritative snapshot for an open creation session and add a ref containing the latest fetched list. List refreshes preserve the selected ID while it matches the active creation session; session close reconciles that ID against the latest list. Existing response/analysis identity checks remain the submission gate.

**Tech Stack:** Next.js client component, React state and refs, TypeScript, Vitest, Testing Library.

## Global Constraints

- Do not modify backend APIs or the response decision model.
- Do not weaken response ID, analysis run ID, stale-request, or duplicate-submit protections.
- A failed output creation keeps the creation session open and retryable.
- Touch only the response client, its tests, and these design/plan documents.

---

### Task 1: Preserve the creation-bound selection through list refresh

**Files:**
- Modify: `wemedia-studio/app/responses/ResponsesClient.test.tsx`
- Modify: `wemedia-studio/app/responses/ResponsesClient.tsx`

**Interfaces:**
- Consumes: existing `creationDetailRef`, `selectedIdRef`, `loadList`, and `selectResponse` state coordination.
- Produces: an `itemsRef: MutableRefObject<ResponseItem[]>` holding the latest fetched list and a `closeCreationSession()` that reconciles selection after clearing the creation session.

- [ ] **Step 1: Rewrite the regression test to express the desired behavior**

Change the current `keeps output creation gated when a list refresh selects a different response` case into a test named `keeps the adopted response creation session active until creation succeeds`. After adoption returns a pending list containing only response 39, assert that the UI still shows `将基于：Selected video`, all creation controls remain enabled, and clicking `创建任务` calls:

```ts
expect(api.createResponseOutputs).toHaveBeenCalledWith(38, {
  analysis_run_id: 380,
  publish_account_id: null,
  output_types: ['expanded_article'],
})
```

After success, assert that the creation panel closes and the heading becomes `Another video`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd wemedia-studio
pnpm test app/responses/ResponsesClient.test.tsx -t 'keeps the adopted response creation session active until creation succeeds'
```

Expected: FAIL because the existing list refresh selects response 39 and disables the creation controls.

- [ ] **Step 3: Implement list-refresh preservation and close-time reconciliation**

Initialize the latest-list ref beside the existing refs:

```ts
const itemsRef = useRef(initialItems)
```

In `loadList`, update `itemsRef.current` before React state. Preserve the current selection only when the open creation session is bound to it:

```ts
itemsRef.current = result.items
setItems(result.items)
setTotal(result.total)
const currentId = selectedIdRef.current
const creationId = creationDetailRef.current?.id ?? null
if (creationId === currentId) return
const nextId = currentId && result.items.some(item => item.id === currentId)
  ? currentId
  : result.items[0]?.id ?? null
if (nextId !== currentId) selectResponse(nextId)
```

At the end of `closeCreationSession`, reconcile selection against `itemsRef.current`:

```ts
const currentId = selectedIdRef.current
const latestItems = itemsRef.current
const nextId = currentId && latestItems.some(item => item.id === currentId)
  ? currentId
  : latestItems[0]?.id ?? null
if (nextId !== currentId) selectResponse(nextId)
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the Step 2 command. Expected: PASS; output creation targets response 38 and the UI advances to response 39 only after success.

### Task 2: Verify cancellation and surrounding response-session behavior

**Files:**
- Modify: `wemedia-studio/app/responses/ResponsesClient.test.tsx`
- Verify: `wemedia-studio/app/responses/ResponsesClient.tsx`

**Interfaces:**
- Consumes: the close-time selection reconciliation from Task 1.
- Produces: regression coverage that cancellation closes the session and selects the first row from the latest list without creating outputs.

- [ ] **Step 1: Add a cancellation regression test**

Render responses 38 and 39, configure the post-adoption list response to contain only 39, adopt 38, wait for `将基于：Selected video`, click `取消`, then assert:

```ts
expect(screen.queryByText('将基于：Selected video')).not.toBeInTheDocument()
expect(await screen.findByRole('heading', { name: 'Another video' })).toBeInTheDocument()
expect(api.createResponseOutputs).not.toHaveBeenCalled()
```

- [ ] **Step 2: Run the cancellation test and verify it passes through the Task 1 behavior**

Run:

```bash
cd wemedia-studio
pnpm test app/responses/ResponsesClient.test.tsx -t 'selects the next listed response when an adopted creation session is cancelled'
```

Expected: PASS.

- [ ] **Step 3: Run the complete response component test file**

Run:

```bash
cd wemedia-studio
pnpm test app/responses/ResponsesClient.test.tsx
```

Expected: all response interaction, stale-request, duplicate-submit, and failure-path tests pass.

### Task 3: Validate the frontend change

**Files:**
- Verify: `wemedia-studio/app/responses/ResponsesClient.tsx`
- Verify: `wemedia-studio/app/responses/ResponsesClient.test.tsx`

**Interfaces:**
- Consumes: completed response-session behavior and tests.
- Produces: lint, frontend-suite, type-check, and rendered-interaction evidence.

- [ ] **Step 1: Run lint on the changed source and test files**

```bash
cd wemedia-studio
pnpm exec eslint app/responses/ResponsesClient.tsx app/responses/ResponsesClient.test.tsx
```

Expected: exit 0 with no new findings.

- [ ] **Step 2: Run the frontend test suite**

```bash
cd wemedia-studio
pnpm test
```

Expected: all frontend tests pass. If unrelated dirty-worktree tests fail, record exact failures without modifying those files.

- [ ] **Step 3: Run TypeScript validation**

```bash
cd wemedia-studio
pnpm exec tsc --noEmit
```

Expected: no errors from changed response files. Record any existing unrelated text-video errors separately.

- [ ] **Step 4: Validate the rendered interaction in the running development app**

Use browser automation against `/responses`. Adopt one pending item, verify the creation controls remain enabled after the list count changes, cancel without creating an output task, and restore the item's decision status to pending. Confirm the next list item is selected after cancellation.

- [ ] **Step 5: Review the final diff and commit only scoped files**

```bash
git diff --check -- docs/superpowers/specs/2026-08-02-response-creation-session-selection-design.md docs/superpowers/plans/2026-08-02-response-creation-session-selection.md wemedia-studio/app/responses/ResponsesClient.tsx wemedia-studio/app/responses/ResponsesClient.test.tsx
git diff -- docs/superpowers/specs/2026-08-02-response-creation-session-selection-design.md docs/superpowers/plans/2026-08-02-response-creation-session-selection.md wemedia-studio/app/responses/ResponsesClient.tsx wemedia-studio/app/responses/ResponsesClient.test.tsx
git add docs/superpowers/specs/2026-08-02-response-creation-session-selection-design.md docs/superpowers/plans/2026-08-02-response-creation-session-selection.md wemedia-studio/app/responses/ResponsesClient.tsx wemedia-studio/app/responses/ResponsesClient.test.tsx
git commit -m "fix: keep response creation session active"
```
