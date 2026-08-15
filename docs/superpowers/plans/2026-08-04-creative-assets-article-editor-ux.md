# Creative Assets Article Editor UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show compact article rows with update times, default Creative Assets Markdown editing to edit-only mode, and save the selected article with Ctrl/Cmd+S.

**Architecture:** Extend the shared `MarkdownEditor` with an optional preview-mode input whose existing default remains `live`, then opt only the Creative Assets workspace into `edit`. Keep list formatting local to `ArticleAssetWorkspace`, and connect the keyboard shortcut in `AssetsClient` to its existing save function so persistence and error handling stay unchanged.

**Tech Stack:** Next.js 16, React 19, TypeScript, Vitest, Testing Library, `@uiw/react-md-editor`.

## Global Constraints

- Format article rows as `更新于 YYYY-MM-DD HH:mm` in the browser's local time zone.
- Do not show misleading update text for an invalid or missing timestamp.
- Do not display article body excerpts or the redundant `文章` label in article rows.
- For an empty saved title, use the first non-empty body line after removing a leading Markdown heading marker; use `未命名文章` only if no usable line exists.
- Keep article rows compact with `px-4 py-3` spacing and preserve the current selected and hover states.
- Default only the Creative Assets Markdown editor to edit-only mode; other editor consumers retain the existing live-preview default.
- Keep the editor toolbar available for opening preview on demand.
- `Ctrl+S` and `Cmd+S` save only the currently selected existing article and prevent the browser save-page action.
- Do not submit the new-article dialog through the shortcut.
- Do not issue duplicate requests while a save is already running.
- Preserve all unrelated pre-existing worktree modifications; stage only task-specific hunks if committing.

---

### Task 1: Scope the Markdown Preview Default

**Files:**
- Modify: `web/app/drafts/MarkdownEditor.tsx`
- Test: `web/app/drafts/MarkdownEditor.test.tsx`
- Modify: `web/app/assets/ArticleAssetWorkspace.tsx`

**Interfaces:**
- Consumes: `@uiw/react-md-editor` preview values `'live' | 'edit' | 'preview'`.
- Produces: `MarkdownEditor({ previewMode?: 'live' | 'edit' | 'preview' })`, defaulting to `'live'`.

- [ ] **Step 1: Write the failing editor-mode tests**

Add a captured `preview` prop to the existing `@uiw/react-md-editor` mock, then assert that an ordinary `<MarkdownEditor>` supplies `live` and that `<ArticleAssetWorkspace>` supplies `edit` through its mocked Markdown editor.

```tsx
expect(capturedPreview).toBe('live')
expect(markdownEditorMock).toHaveBeenCalledWith(
  expect.objectContaining({ previewMode: 'edit' }),
  undefined,
)
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
pnpm test -- app/drafts/MarkdownEditor.test.tsx app/assets/AssetsClient.test.tsx
```

Expected: FAIL because `previewMode` does not exist and Creative Assets does not request edit-only mode.

- [ ] **Step 3: Add the minimal preview-mode prop**

Add the prop to the current interface:

```tsx
interface Props {
  value: string
  onChange: (v: string) => void
  minHeight?: number
  previewMode?: 'live' | 'edit' | 'preview'
}

```

Change the current function parameter list to `function MarkdownEditor({ value, onChange, minHeight = 500, previewMode = 'live' }, ref)` and replace `preview="live"` with `preview={previewMode}` on its current `MDEditor` element.

In `ArticleAssetWorkspace`, render:

```tsx
<MarkdownEditor
  minHeight={420}
  onChange={content => onChange({ ...selected, content })}
  previewMode="edit"
  value={selected.content}
/>
```

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the same focused test command and expect both files to pass.

- [ ] **Step 5: Review task-specific diff**

Run `git diff --check` and confirm no unrelated hunk was added to the already-modified Creative Assets files.

---

### Task 2: Show Article Update Times

**Files:**
- Modify: `web/app/assets/ArticleAssetWorkspace.tsx`
- Test: `web/app/assets/AssetsClient.test.tsx`

**Interfaces:**
- Consumes: `CreativeAsset.updated_at: string`.
- Produces: `formatArticleUpdatedAt(value: string): string`, returning an empty string for invalid values.

- [ ] **Step 1: Write failing list timestamp tests**

Create an asset with a fixed timestamp, render `AssetsClient`, and assert that its row contains the local-time result built with the same numeric date parts. Add an invalid timestamp case and assert that no `更新于` label is rendered for that row.

```tsx
expect(screen.getByText(`更新于 ${expectedLocalDateTime}`)).toBeVisible()
expect(screen.queryByText(/更新于/)).toBeNull()
```

- [ ] **Step 2: Run the timestamp tests and verify RED**

Run:

```bash
pnpm test -- app/assets/AssetsClient.test.tsx
```

Expected: FAIL because article rows do not render update times.

- [ ] **Step 3: Implement local timestamp formatting**

Add a small formatter using local `Date` getters and zero padding:

```ts
export function formatArticleUpdatedAt(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const two = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`
}
```

Render `更新于 ${formatted}` beneath the article title only when the formatter returns a value.

- [ ] **Step 4: Run the timestamp tests and verify GREEN**

Run the focused asset tests and expect them to pass.

- [ ] **Step 5: Review task-specific diff**

Run `git diff --check` and inspect only the article-row formatter/rendering hunks.

---

### Task 3: Save the Selected Article with Ctrl/Cmd+S

**Files:**
- Modify: `web/app/assets/AssetsClient.tsx`
- Test: `web/app/assets/AssetsClient.test.tsx`

**Interfaces:**
- Consumes: existing `saveSelectedArticle(): Promise<void>`, `articleDialog`, and `savingAssetId` state.
- Produces: a window `keydown` effect that handles the selected-article save shortcut.

- [ ] **Step 1: Write failing shortcut tests**

Add separate tests for Ctrl and Meta. Dispatch cancelable key events, verify `defaultPrevented`, and verify the existing API call payload. Add cases with an open new-article dialog and a pending save.

```tsx
const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true })
window.dispatchEvent(event)
expect(event.defaultPrevented).toBe(true)
await waitFor(() => expect(mocks.updateCreativeAsset).toHaveBeenCalledTimes(1))
```

For the dialog case, expect `defaultPrevented` to remain false and no update call. For the pending-save case, dispatch twice and expect one update call.

- [ ] **Step 2: Run the shortcut tests and verify RED**

Run:

```bash
pnpm test -- app/assets/AssetsClient.test.tsx
```

Expected: FAIL because the page has no selected-article shortcut listener.

- [ ] **Step 3: Implement the shortcut by reusing the save path**

Stabilize `saveSelectedArticle` with `useCallback` using its actual state dependencies, then add:

```tsx
useEffect(() => {
  const handleKeyDown = (event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return
    if (articleDialog || !selected || savingAssetId !== null) return
    event.preventDefault()
    void saveSelectedArticle()
  }
  window.addEventListener('keydown', handleKeyDown)
  return () => window.removeEventListener('keydown', handleKeyDown)
}, [articleDialog, saveSelectedArticle, savingAssetId, selected])
```

Keep `saveSelectedArticle` as the only function that calls `updateCreativeAsset` and reports errors.

- [ ] **Step 4: Run the shortcut tests and verify GREEN**

Run the focused asset test file and expect all cases to pass.

- [ ] **Step 5: Run complete targeted verification**

Run:

```bash
pnpm test -- app/assets/AssetsClient.test.tsx app/drafts/MarkdownEditor.test.tsx
pnpm exec tsc --noEmit
pnpm build
```

Expected: all tests pass, TypeScript exits 0, and the Next.js build exits 0.

- [ ] **Step 6: Review and hand off**

Run `git diff --check` and `git status --short`. Report the exact verification results and note that implementation files remain uncommitted because they already contained unrelated user modifications, unless task-specific hunks were safely isolated for a dedicated commit.

---

### Task 4: Compact the Article List Rows

**Files:**
- Modify: `web/app/assets/ArticleAssetWorkspace.tsx`
- Test: `web/app/assets/AssetsClient.test.tsx`

**Interfaces:**
- Consumes: `CreativeAsset.title`, `CreativeAsset.content`, and the existing formatted update time.
- Produces: a compact two-line article row containing only the visible title and optional update time.

- [ ] **Step 1: Write the failing row-content and layout tests**

Render an article whose body contains a unique marker and assert that the marker and `文章` label are absent from the list region. Render an empty-title article and assert that its list button is named with `未命名文章`, not body text. Assert the row uses `px-4 py-3`, while retaining the current selected-state classes.

```tsx
const list = screen.getByRole('region', { name: '素材列表' })
expect(within(list).queryByText('列表不可见正文')).toBeNull()
expect(within(list).queryByText('文章')).toBeNull()
const row = within(list).getByRole('button', { name: /未命名文章/ })
expect(row).toHaveClass('px-4', 'py-3', 'bg-primary/10')
expect(row).not.toHaveTextContent('列表不可见正文')
```

- [ ] **Step 2: Run the focused asset tests and verify RED**

Run:

```bash
pnpm exec vitest run app/assets/AssetsClient.test.tsx
```

Expected: FAIL because the row still renders body text, the `文章` label, body-derived title fallback, and `px-5 py-4` spacing.

- [ ] **Step 3: Implement the compact two-line row**

In `ArticleAssetWorkspace`, replace the row body with:

```tsx
<button className={cn(
  'relative block w-full px-4 py-3 text-left hover:bg-muted/70',
  selected?.id === asset.id && 'bg-primary/10 before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-primary',
)}>
  <span className="block truncate text-sm font-medium">{asset.title.trim() || '未命名文章'}</span>
  {updatedAt ? <time className="mt-1 block text-[10px] text-muted-foreground" dateTime={asset.updated_at}>更新于 {updatedAt}</time> : null}
</button>
```

Do not render `asset.content` anywhere inside the list row.

- [ ] **Step 4: Run the focused asset tests and verify GREEN**

Run the same Vitest command and expect the complete asset test file to pass.

- [ ] **Step 5: Run targeted regression and rendered checks**

Run:

```bash
pnpm exec vitest run app/assets/AssetsClient.test.tsx app/drafts/MarkdownEditor.test.tsx
pnpm exec eslint app/assets/ArticleAssetWorkspace.tsx app/assets/AssetsClient.test.tsx
```

Then reload `/assets` at a desktop viewport and verify that rows contain only the title and update time, remain selectable, and do not show a framework error overlay or relevant console errors.

- [ ] **Step 6: Review and hand off**

Run `git diff --check` and inspect the target hunks. Keep implementation changes uncommitted because the files already contain unrelated user modifications.

---

### Task 5: Derive Missing List Titles from the First Body Line

**Files:**
- Modify: `web/app/assets/ArticleAssetWorkspace.tsx`
- Test: `web/app/assets/AssetsClient.test.tsx`

**Interfaces:**
- Consumes: `CreativeAsset.title: string` and `CreativeAsset.content: string`.
- Produces: `articleListTitle(asset: Pick<CreativeAsset, 'title' | 'content'>): string`.

- [ ] **Step 1: Write failing title-priority and body-line tests**

Assert these literal behaviors through rendered list rows:

```tsx
// Saved title wins.
article(1, '保存标题', '# 正文首行')
expect(row).toHaveAccessibleName('保存标题')

// Empty lines are skipped, a Markdown heading marker is removed,
// and later lines are not rendered.
article(2, '', '\n\n### 正文首行标题\n后续正文不可见')
expect(row).toHaveAccessibleName('正文首行标题')
expect(row).not.toHaveTextContent('后续正文不可见')

// No usable title or body keeps the neutral fallback.
article(3, '   ', '\n  \n')
expect(row).toHaveAccessibleName('未命名文章')
```

- [ ] **Step 2: Run the focused asset tests and verify RED**

Run:

```bash
pnpm exec vitest run app/assets/AssetsClient.test.tsx
```

Expected: FAIL because an untitled article with body content still renders `未命名文章`.

- [ ] **Step 3: Implement the title derivation helper**

Add this helper beside the timestamp formatter:

```ts
export function articleListTitle(asset: Pick<CreativeAsset, 'title' | 'content'>) {
  const savedTitle = asset.title.trim()
  if (savedTitle) return savedTitle
  const firstBodyLine = asset.content.split(/\r?\n/).find(line => line.trim())
  const bodyTitle = firstBodyLine?.trim().replace(/^#{1,6}\s*/, '').trim()
  return bodyTitle || '未命名文章'
}
```

Use `{articleListTitle(asset)}` in the compact title span. Do not render any additional body line.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the focused asset test file and expect all tests to pass.

- [ ] **Step 5: Run regression and rendered verification**

Run the complete frontend test suite and target ESLint. Reload `/assets` with Playwright and verify that formerly unnamed rows show their first body lines without `#`, while row DOM remains limited to `SPAN` and optional `TIME` children.

- [ ] **Step 6: Review and hand off**

Run `git diff --check`. Keep implementation changes uncommitted because the target files already contain unrelated user modifications.
