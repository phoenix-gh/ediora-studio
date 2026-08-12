# Media Asset Rename and Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add selected-media rename and delete actions to the creative-assets multimedia workspace.

**Architecture:** Keep mutation state and API calls in `AssetsClient`, where article and prompt mutations already live. Reuse `updateCreativeAsset`, `deleteCreativeAsset`, the existing shared confirmation dialog, and the existing media selection model; keep `MediaAssetGrid` presentation-only.

**Tech Stack:** Next.js 16, React, TypeScript, shadcn/ui, Vitest, Testing Library.

## Global Constraints

- Show rename and delete only for the currently visible selected multimedia asset.
- Trim names and reject an empty result with `请输入名称。`.
- Do not optimistically mutate local assets; update only after the API succeeds.
- Rename failures retain the dialog and input with `重命名失败，请重试。`.
- Delete requires confirmation with `删除这个多媒体资产？此操作无法撤销。`.
- Delete failures retain the confirmation with `删除失败，请重试。`.
- Do not add card-hover actions or change double-click preview behavior.
- Use the existing backend PATCH and DELETE endpoints; no backend or schema changes.

---

### Task 1: Selected Media Rename

**Files:**
- Modify: `wemedia-studio/app/assets/AssetsClient.test.tsx`
- Modify: `wemedia-studio/app/assets/AssetsClient.tsx`

**Interfaces:**
- Consumes: `updateCreativeAsset(id: number, body: { title: string }): Promise<CreativeAsset>` and the existing `selected` visible-asset derivation.
- Produces: toolbar action `重命名`, Dialog `重命名多媒体`, and local asset replacement after a successful response.

- [ ] **Step 1: Write failing rename interaction tests**

Add tests that select the media tab and assert:

```tsx
expect(screen.getByRole('button', { name: '重命名' })).toBeVisible()
await user.click(screen.getByRole('button', { name: '重命名' }))
const input = screen.getByLabelText('名称')
expect(input).toHaveValue('封面图')
await user.clear(input)
await user.type(input, ' 新封面 ')
await user.click(within(screen.getByRole('dialog', { name: '重命名多媒体' })).getByRole('button', { name: '保存' }))
expect(mocks.updateCreativeAsset).toHaveBeenCalledWith(3, { title: '新封面' })
expect(await screen.findByRole('button', { name: /新封面/ })).toBeVisible()
```

Add separate assertions that an all-whitespace value displays `请输入名称。` without calling the API, and that a rejected API call displays `重命名失败，请重试。` while keeping the typed value and Dialog open.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd wemedia-studio
pnpm exec vitest run app/assets/AssetsClient.test.tsx
```

Expected: FAIL because the media rename button and Dialog do not exist.

- [ ] **Step 3: Implement minimal rename state and UI**

Add a focused state type and state value:

```tsx
type MediaRenameDialogState = {
  asset: CreativeAsset
  busy: boolean
  error: string
  name: string
}

const [mediaRenameDialog, setMediaRenameDialog] = useState<MediaRenameDialogState | null>(null)
```

Add `openMediaRename()` guarded by `selected?.asset_type === 'media'`, and `saveMediaRename()` that trims the name, validates it, awaits `updateCreativeAsset(asset.id, { title: name })`, then replaces that exact ID in `assets`, updates `previewAsset` when its ID matches, and closes the Dialog. On rejection, retain state and set the specified failure message.

Render `重命名` beside `上传` only when `type === 'media' && selected?.asset_type === 'media'`. Render a `Dialog` titled `重命名多媒体` with label `名称`, an autofocus `Input`, cancel/save buttons, busy disabling, and an inline `role="alert"` error.

In `changeType`, clear `mediaRenameDialog` so an unfinished media edit cannot leak into another asset type.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
pnpm exec vitest run app/assets/AssetsClient.test.tsx
```

Expected: all `AssetsClient` tests PASS.

- [ ] **Step 5: Commit the rename slice**

```bash
git add wemedia-studio/app/assets/AssetsClient.tsx wemedia-studio/app/assets/AssetsClient.test.tsx
git commit -m "feat: rename selected media assets"
```

### Task 2: Selected Media Delete and Regression Verification

**Files:**
- Modify: `wemedia-studio/app/assets/AssetsClient.test.tsx`
- Modify: `wemedia-studio/app/assets/AssetsClient.tsx`

**Interfaces:**
- Consumes: `deleteCreativeAsset(id: number): Promise<void>`, `ConfirmationState`, `confirmDeletion()`, and current visible-media selection.
- Produces: toolbar action `删除` and confirmed media deletion with existing backend file-cleanup semantics.

- [ ] **Step 1: Write failing media deletion tests**

Add a successful flow:

```tsx
await user.click(screen.getByRole('tab', { name: '多媒体' }))
await user.click(screen.getByRole('button', { name: '删除' }))
expect(screen.getByRole('alertdialog')).toHaveTextContent('删除这个多媒体资产？此操作无法撤销。')
expect(mocks.deleteCreativeAsset).not.toHaveBeenCalled()
await user.click(screen.getByRole('button', { name: '确认' }))
expect(mocks.deleteCreativeAsset).toHaveBeenCalledWith(3)
await waitFor(() => expect(screen.queryByRole('button', { name: /封面图/ })).toBeNull())
```

Add a rejected-delete flow where `deleteCreativeAsset` rejects, then assert the alert dialog remains open and displays `删除失败，请重试。`. Also render no media assets and assert both `重命名` and `删除` are absent.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm exec vitest run app/assets/AssetsClient.test.tsx
```

Expected: FAIL because no media delete action opens the confirmation flow.

- [ ] **Step 3: Implement minimal confirmed deletion**

Add `requestMediaDelete()` guarded by a media selection:

```tsx
function requestMediaDelete() {
  if (!selected || selected.asset_type !== 'media') return
  const asset = selected
  setConfirmation({
    busy: false,
    error: '',
    message: '删除这个多媒体资产？此操作无法撤销。',
    action: async () => {
      await deleteCreativeAsset(asset.id)
      setAssets(items => items.filter(item => item.id !== asset.id))
      setPreviewAsset(value => value?.id === asset.id ? null : value)
      clearOperationError(asset.id)
      setSelectedId(null)
    },
  })
}
```

Render `删除` beside `重命名`, with `variant="destructive"`, only for the same valid media selection. Update `confirmDeletion()` to accept a per-confirmation failure message or map media deletion to `删除失败，请重试。` while preserving existing article, prompt, and directory confirmation behavior.

- [ ] **Step 4: Run focused and related regression tests**

Run:

```bash
pnpm exec vitest run app/assets/AssetsClient.test.tsx app/assets/MediaUploadDialog.test.tsx app/assets/PromptAssetWorkspace.test.tsx app/assets/assets-layout.test.ts app/assets/assets-system-directory.test.tsx lib/api/assets.test.ts
pnpm exec eslint app/assets/AssetsClient.tsx app/assets/AssetsClient.test.tsx
```

Expected: all tests PASS; ESLint exits 0 with no new warnings.

- [ ] **Step 5: Browser verification**

On `/assets`, switch to `多媒体`, select an asset, rename it, reopen its preview to verify the new title, then initiate and cancel deletion before confirming deletion on a disposable uploaded asset. Verify errors do not appear in the browser console and clean up the disposable asset.

- [ ] **Step 6: Commit the delete slice**

```bash
git add wemedia-studio/app/assets/AssetsClient.tsx wemedia-studio/app/assets/AssetsClient.test.tsx
git commit -m "feat: delete selected media assets"
```
