# Unified Markdown Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the draft editor with the asset article editor and leave one shared Milkdown Markdown editor for both workflows.

**Architecture:** Move the existing asset-side `AssetVisualMarkdownEditor` into `components/MarkdownEditor.tsx`, expose a small imperative `insert(markdown)` handle, and update both consumers to use the shared contract. Keep draft-specific title/status/AI/publish/image-library state in `DraftsClient`; only the body editing surface becomes shared.

**Tech Stack:** Next.js 16, React 19, TypeScript, Milkdown Crepe, Vitest, Testing Library, ESLint, Playwright.

## Global Constraints

- Use the Milkdown editor already used by the asset article editor; do not introduce a second Markdown editing implementation.
- Preserve draft image-library insertion, and route it through `MarkdownEditorHandle.insert`.
- Preserve remote-image import and local image upload behavior from the asset editor.
- Keep the editor keyed by `documentKey` so switching documents cannot retain the previous document state.
- Run only focused unit tests, scoped lint/type checks, and the targeted rendered UI check; do not run the full test suite.
- Do not modify unrelated dirty-worktree changes.

---

### Task 1: Define the shared editor contract with failing tests

**Files:**
- Create: `wemedia-studio/components/MarkdownEditor.test.tsx`
- Modify: `wemedia-studio/app/assets/AssetsClient.test.tsx`
- Modify: `wemedia-studio/app/drafts/DraftsClient.test.tsx`

**Interfaces:**
- Produces the shared test contract for `MarkdownEditor`:

```ts
export interface MarkdownEditorHandle {
  insert(markdown: string): void
}
```

- The consumer mocks must import the shared component from `@/components/MarkdownEditor` and expose `documentKey` so the tests can prove both consumers pass the active document id.

- [ ] **Step 1: Move the asset editor behavior tests into the shared contract test**

Copy the existing cases from `app/assets/AssetVisualMarkdownEditor.test.tsx` into `components/MarkdownEditor.test.tsx`, change the import to `@/components/MarkdownEditor`, and add this failing behavior test:

```tsx
it('inserts Markdown through its imperative handle', async () => {
  const ref = createRef<MarkdownEditorHandle>()
  render(<MarkdownEditor ref={ref} documentKey={7} onChange={vi.fn()} value="正文" />)

  await waitFor(() => expect(mocks.create).toHaveBeenCalled())
  act(() => { ref.current?.insert('![图片](/api/uploads/library.png)') })

  expect(mocks.insertions).toContain('![图片](/api/uploads/library.png)')
})
```

Import `act` and `createRef` from React/testing-library as needed. Keep the existing image import, retry, document-change cancellation, and marker-cleaning assertions.

- [ ] **Step 2: Update consumer mocks before changing production imports**

Change the `AssetsClient` mock from `./AssetVisualMarkdownEditor` to `@/components/MarkdownEditor`, and make it render `data-document-key={documentKey}`. Change the `DraftsClient` mock from `./MarkdownEditor` to `@/components/MarkdownEditor`, expose the same `data-document-key`, and expose an `insert` method on its forwarded ref.

- [ ] **Step 3: Run the focused tests and verify the RED phase**

Run from `wemedia-studio`:

```bash
pnpm exec vitest run components/MarkdownEditor.test.tsx app/assets/AssetsClient.test.tsx app/drafts/DraftsClient.test.tsx
```

Expected result: failure because `@/components/MarkdownEditor` does not exist yet and the consumer production files still point at the old editor paths. Do not implement production code until this failure is observed.

### Task 2: Extract the Milkdown editor and migrate the asset workspace

**Files:**
- Create: `wemedia-studio/components/MarkdownEditor.tsx`
- Modify: `wemedia-studio/app/assets/ArticleAssetWorkspace.tsx`
- Delete: `wemedia-studio/app/assets/AssetVisualMarkdownEditor.tsx`
- Delete: `wemedia-studio/app/assets/AssetVisualMarkdownEditor.test.tsx`

**Interfaces:**
- `MarkdownEditor` accepts `value`, `onChange`, and `documentKey: string | number`.
- `MarkdownEditor` forwards `MarkdownEditorHandle` with `insert(markdown: string): void`.

- [ ] **Step 1: Move the existing asset editor implementation into the shared file**

Use the current `AssetVisualMarkdownEditor` implementation as the source behavior, but export `MarkdownEditor` from the new shared file. Wrap the component with `forwardRef`, import `useImperativeHandle`, and expose:

```tsx
useImperativeHandle(ref, () => ({ insert: insertMarkdown }), [insertMarkdown])
```

Keep the existing dynamic Milkdown initialization, image-block upload configuration, remote-image import plugin, marker stripping, retry UI, and document lifecycle cleanup unchanged apart from the new component name and ref.

- [ ] **Step 2: Update the asset article workspace to the shared import**

Import `MarkdownEditor` from `@/components/MarkdownEditor`, render it with `documentKey={selected.id}`, and keep the current asset title, directory, URL, save, delete, and list behavior unchanged.

- [ ] **Step 3: Run the asset-focused tests**

Run:

```bash
pnpm exec vitest run components/MarkdownEditor.test.tsx app/assets/AssetsClient.test.tsx
```

Expected result: all shared editor and asset workspace tests pass, including the new imperative insertion case.

### Task 3: Migrate DraftsClient and remove the obsolete editor dependency

**Files:**
- Modify: `wemedia-studio/app/drafts/DraftsClient.tsx`
- Modify: `wemedia-studio/app/drafts/DraftsClient.test.tsx`
- Delete: `wemedia-studio/app/drafts/MarkdownEditor.tsx`
- Delete: `wemedia-studio/app/drafts/MarkdownEditor.test.tsx`
- Modify: `wemedia-studio/package.json`
- Modify: `wemedia-studio/pnpm-lock.yaml`

**Interfaces:**
- `DraftsClient` keeps `editorRef` typed as `MarkdownEditorHandle` imported from `@/components/MarkdownEditor`.
- Draft image-library insertion continues to call `editorRef.current.insert(markdown)`; the shared editor emits the resulting content through `onChange`, which keeps `dirty` true.

- [ ] **Step 1: Add the draft consumer contract assertion**

In `DraftsClient.test.tsx`, make the shared mock render `data-document-key={documentKey}` and add a focused assertion that an active draft with id `11` renders the editor with `data-document-key="11"`. Keep the mock ref method so existing image insertion code has a valid handle.

- [ ] **Step 2: Run the draft RED phase**

Run:

```bash
pnpm exec vitest run app/drafts/DraftsClient.test.tsx
```

Expected result: the test fails because `DraftsClient` still imports the deleted-path editor mock contract. Confirm the failure is import/contract-related before changing the production file.

- [ ] **Step 3: Switch DraftsClient to the shared editor**

Replace the local import with:

```ts
import { MarkdownEditor, type MarkdownEditorHandle } from '@/components/MarkdownEditor'
```

Remove the `@uiw/react-md-editor/markdown-editor.css` import and pass `documentKey={selected.id}` to the editor. Keep the surrounding `onChange` wrapper so edits still update `editContent` and `dirty`.

- [ ] **Step 4: Remove the old editor and dependency**

Delete the old draft editor implementation/test. Verify no source file still references `@uiw/react-md-editor` or `AssetVisualMarkdownEditor`. Remove `@uiw/react-md-editor` from the frontend package and refresh only its lockfile entries with:

```bash
pnpm remove @uiw/react-md-editor
```

- [ ] **Step 5: Run the draft-focused tests**

Run:

```bash
pnpm exec vitest run app/drafts/DraftsClient.test.tsx components/MarkdownEditor.test.tsx
```

Expected result: the shared editor and draft workflow tests pass, including document identity and existing save/image-library behavior.

### Task 4: Scoped verification and rendered editor smoke test

**Files:**
- Verify only the files changed by Tasks 1–3.

- [ ] **Step 1: Run the complete focused unit-test set**

Run:

```bash
pnpm exec vitest run components/MarkdownEditor.test.tsx app/assets/AssetsClient.test.tsx app/drafts/DraftsClient.test.tsx lib/api/assets.test.ts
```

- [ ] **Step 2: Run scoped lint and TypeScript validation**

Run:

```bash
pnpm exec eslint components/MarkdownEditor.tsx components/MarkdownEditor.test.tsx app/assets/ArticleAssetWorkspace.tsx app/assets/AssetsClient.test.tsx app/drafts/DraftsClient.tsx app/drafts/DraftsClient.test.tsx
pnpm exec tsc --noEmit
git diff --check
```

The TypeScript check is a compile check, not a full test-suite run; report unrelated pre-existing errors separately if present.

- [ ] **Step 3: Validate the rendered flow with targeted Playwright**

The flow under test is: `/assets` loads → article editor renders → `/drafts` loads → active draft body editor renders and accepts input. Since no Browser plugin is available, use the repository Playwright setup if the local app is reachable:

```bash
pnpm exec playwright test e2e/ui-foundations.spec.ts --grep "assets list/editor"
```

If the targeted existing spec cannot cover `/drafts`, use a temporary Playwright check outside the repository to verify page identity, non-blank DOM, no framework overlay, no relevant console errors, and one body-editor interaction. Do not add a test artifact to the repository.

- [ ] **Step 4: Review the final diff and report exact evidence**

Confirm `rg -n "@uiw/react-md-editor|AssetVisualMarkdownEditor|app/drafts/MarkdownEditor" wemedia-studio` returns no production references, and report focused test counts, lint/type results, rendered-flow result, and any environment limitation without claiming a full-suite pass.
