# Creative Asset Media Batch Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a media-only upload button and a batch upload Dialog that accepts multiple selected, dropped, or pasted image/video/audio files and uploads them into the captured creative-asset directory with per-item status and retry.

**Architecture:** Extend the existing single-file API wrapper with an optional directory argument while retaining current callers. Put file admission, deduplication, queue state, bounded concurrency, paste/drop handling, and close confirmation in a focused `MediaUploadDialog`; keep `AssetsClient` responsible only for opening it with a captured directory and registering successfully created assets.

**Tech Stack:** Next.js 16, React 19, TypeScript, Base UI Dialog/AlertDialog, Vitest, Testing Library, existing FastAPI `/api/assets/upload` endpoint.

## Global Constraints

- The entry appears only in “创作资产 → 多媒体”.
- Accept multiple image, video, and audio files from file selection, drag-and-drop, or clipboard paste.
- Do not download pasted text or URLs.
- Capture the active media directory when the Dialog opens; every item in that queue uses that directory.
- Upload at most 3 files concurrently, with independent success and failure states.
- Reuse the existing backend upload endpoint; do not add a backend batch endpoint or change asset/directory models.
- Do not change the compact media grid or double-click preview behavior.
- Preserve unrelated dirty-worktree changes and run only focused frontend/API regressions plus the existing focused backend upload tests.

## File Structure

- Modify `web/lib/api/assets.ts`: add the optional upload directory query parameter.
- Modify `web/lib/api/assets.test.ts`: verify directory encoding and multipart preservation.
- Create `web/app/assets/MediaUploadDialog.tsx`: own accepted-file parsing, queue UI, paste/drop listeners, concurrency, retry, close confirmation, and object-URL cleanup.
- Create `web/app/assets/MediaUploadDialog.test.tsx`: exercise the Dialog as a user and verify queue/upload behavior.
- Modify `web/app/assets/AssetsClient.tsx`: expose the media upload action, snapshot the directory, and register successful assets.
- Modify `web/app/assets/AssetsClient.test.tsx`: verify scope, directory snapshot, and immediate grid refresh.

---

### Task 1: Directory-aware single-file upload API

**Files:**
- Modify: `web/lib/api/assets.ts`
- Test: `web/lib/api/assets.test.ts`

**Interfaces:**
- Consumes: existing backend `POST /api/assets/upload?media_kind=<kind>&directory=<name>`.
- Produces: `uploadCreativeAsset(mediaKind: 'image' | 'video' | 'audio', file: File, directory?: string): Promise<CreativeAsset>`.

- [ ] **Step 1: Write the failing API contract test**

Import `uploadCreativeAsset` in `lib/api/assets.test.ts` and add:

```ts
it('uploads media into an encoded creative-asset directory', async () => {
  const asset = {
    id: 91, asset_type: 'media', media_kind: 'image', title: '街拍.png',
    content: '', url: '/api/uploads/street.png', media_type: 'image/png',
    filename: '街拍.png', directory: '人物 参考', tags: [], source: 'upload',
    created_at: '', updated_at: '',
  }
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(asset), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  }))
  vi.stubGlobal('fetch', fetchMock)
  const file = new File(['image'], '街拍.png', { type: 'image/png' })

  await uploadCreativeAsset('image', file, '人物 参考')

  const [url, init] = fetchMock.mock.calls[0]
  expect(url).toBe('http://localhost:8000/api/assets/upload?media_kind=image&directory=%E4%BA%BA%E7%89%A9%20%E5%8F%82%E8%80%83')
  expect((init.body as FormData).get('file')).toBe(file)
  expect(init.headers).toEqual({})
})
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
cd web
pnpm test lib/api/assets.test.ts
```

Expected: FAIL because `uploadCreativeAsset` ignores its third argument and omits `directory`.

- [ ] **Step 3: Add the optional directory parameter**

Replace the one-line wrapper with a readable implementation:

```ts
export async function uploadCreativeAsset(
  mediaKind: 'image' | 'video' | 'audio',
  file: File,
  directory = '',
) {
  const body = new FormData()
  body.append('file', file)
  const query = new URLSearchParams({ media_kind: mediaKind })
  if (directory) query.set('directory', directory)
  return apiFetch<CreativeAsset>(`/assets/upload?${query.toString()}`, {
    method: 'POST',
    body,
    headers: {},
  })
}
```

Keep the third parameter optional so `PromptAssetWorkspace`, `EnvironmentPickerDialog`, and `RoleEditorDialog` retain current behavior.

- [ ] **Step 4: Run focused API tests and verify GREEN**

Run:

```bash
cd web
pnpm test lib/api/assets.test.ts app/assets/PromptAssetWorkspace.test.tsx app/digital-humans/role-management.test.tsx
```

Expected: all tests pass; existing two-argument callers remain valid.

- [ ] **Step 5: Commit the API contract change**

```bash
git add web/lib/api/assets.ts web/lib/api/assets.test.ts
git commit -m "feat: upload media assets into selected directory"
```

---

### Task 2: Batch upload queue Dialog

**Files:**
- Create: `web/app/assets/MediaUploadDialog.tsx`
- Create: `web/app/assets/MediaUploadDialog.test.tsx`

**Interfaces:**
- Consumes: `uploadCreativeAsset(kind, file, directory)` from Task 1.
- Produces:

```ts
type MediaUploadDialogProps = {
  directory: string
  onAssetUploaded: (asset: CreativeAsset) => void
  onClose: () => void
  open: boolean
}
```

- [ ] **Step 1: Write failing admission tests for selection, drop, paste, rejection, and deduplication**

Create `MediaUploadDialog.test.tsx`, mock `uploadCreativeAsset`, and render the open Dialog. Add user-facing tests which:

```ts
const image = new File(['image'], 'portrait.png', {
  type: 'image/png', lastModified: 10,
})
const video = new File(['video'], 'walk.mp4', {
  type: 'video/mp4', lastModified: 11,
})

await user.upload(screen.getByLabelText('选择多媒体文件'), [image, video])
expect(screen.getByText('portrait.png')).toBeVisible()
expect(screen.getByText('walk.mp4')).toBeVisible()
expect(screen.getByRole('button', { name: '上传 2 个文件' })).toBeEnabled()
```

Use `fireEvent.drop(screen.getByTestId('media-upload-dropzone'), { dataTransfer: { files: [image] } })` for drag-and-drop. Focus an element inside the Dialog and use `fireEvent.paste(..., { clipboardData: { files: [image], items: [] } })` for paste. Assert that a duplicate file is listed once and announces `已忽略 1 个重复文件`; a `text/plain` file or clipboard URL is not queued and announces `仅支持图片、视频和音频文件`.

- [ ] **Step 2: Run admission tests and verify RED**

Run:

```bash
cd web
pnpm test app/assets/MediaUploadDialog.test.tsx
```

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement file classification and queue admission**

In `MediaUploadDialog.tsx`, define the queue contract:

```ts
type MediaKind = 'image' | 'video' | 'audio'
type UploadStatus = 'pending' | 'uploading' | 'failed'
type UploadItem = {
  error: string
  file: File
  id: string
  kind: MediaKind
  previewUrl: string
  status: UploadStatus
}

function mediaKind(file: File): MediaKind | null {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('video/')) return 'video'
  if (file.type.startsWith('audio/')) return 'audio'
  return null
}

function fileIdentity(file: File) {
  return `${file.name}\u0000${file.size}\u0000${file.type}\u0000${file.lastModified}`
}
```

Use one `addFiles(files: Iterable<File>)` path for input, drop, and paste. Create object URLs only for accepted images, revoke them when an item is removed and on unmount, and never inspect or fetch clipboard text/URLs. Attach paste handling to the Dialog content with `onPaste`, so events outside the open Dialog cannot enqueue files.

- [ ] **Step 4: Implement the queue UI**

Render:

- target text `上传到：${directory || '未分类'}`;
- a focusable `data-testid="media-upload-dropzone"` with click, drag-over, drop, and paste instructions;
- hidden `<input aria-label="选择多媒体文件" accept="image/*,video/*,audio/*" multiple>`;
- rows with filename, formatted size, type label, image preview/type icon, status, remove button, and retry button for failures;
- “清空队列”, “取消”, and `上传 ${pendingCount} 个文件` actions;
- an inline `role="status"` message for ignored/rejected files.

Keep `DialogContent size="md"`; use existing Button, Dialog, AlertDialog, Progress, and Lucide icons rather than adding a dependency.

- [ ] **Step 5: Run admission/UI tests and verify GREEN**

Run:

```bash
cd web
pnpm test app/assets/MediaUploadDialog.test.tsx
```

Expected: selection, drop, paste, rejection, dedupe, removal, and clear tests pass.

- [ ] **Step 6: Write failing bounded-concurrency and retry tests**

Use deferred promises for four files. After clicking “上传 4 个文件”, assert only three `uploadCreativeAsset` calls occur. Resolve one request and assert the fourth begins. Verify every call includes the captured directory:

```ts
expect(mocks.uploadCreativeAsset).toHaveBeenCalledWith('image', files[0], '人物参考')
expect(mocks.uploadCreativeAsset).toHaveBeenCalledTimes(3)
first.resolve(uploadedAsset(1, files[0]))
await waitFor(() => expect(mocks.uploadCreativeAsset).toHaveBeenCalledTimes(4))
```

Reject one item and assert the row displays its error, successful assets each call `onAssetUploaded`, the Dialog remains open, and “重试” calls only the failed item. Add an all-success test that asserts the success callback for every asset, a success toast/count, and `onClose` after the final request settles.

- [ ] **Step 7: Run execution tests and verify RED**

Run the same component test command. Expected: FAIL because uploads and retries are not wired.

- [ ] **Step 8: Implement a three-worker upload runner**

On bulk submit, snapshot the IDs of `pending` and `failed` items, mark them pending for the run, and execute three async workers over a shared index:

```ts
async function uploadIds(ids: string[]) {
  let nextIndex = 0
  async function worker() {
    while (nextIndex < ids.length) {
      const id = ids[nextIndex++]
      await uploadOne(id)
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, ids.length) }, worker))
}
```

`uploadOne` must mark the item uploading, call `uploadCreativeAsset(item.kind, item.file, directory)`, call `onAssetUploaded(asset)` on success, remove/revoke the successful item, and retain a rejected item as `failed` with `error instanceof Error ? error.message : '上传失败，请重试。'`. Guard late completions with a mounted/session ref so closing never writes stale Dialog state.

- [ ] **Step 9: Write and implement close-confirmation tests**

Test these exact cases:

- empty queue: Cancel/close calls `onClose` directly;
- pending, uploading, or failed row: close opens an AlertDialog containing `还有未完成的上传，确定关闭？`;
- canceling the confirmation preserves the queue;
- confirming calls `onClose`, does not call an asset delete API, and ignores later promise completions.

Implement the nested AlertDialog and route overlay close, close icon, and Cancel through a single `requestClose()` function. Do not cancel or delete already accepted server work.

- [ ] **Step 10: Verify the complete Dialog test suite**

Run:

```bash
cd web
pnpm test app/assets/MediaUploadDialog.test.tsx
pnpm exec eslint app/assets/MediaUploadDialog.tsx app/assets/MediaUploadDialog.test.tsx
```

Expected: all component tests pass and ESLint exits 0.

- [ ] **Step 11: Commit the isolated Dialog**

```bash
git add web/app/assets/MediaUploadDialog.tsx web/app/assets/MediaUploadDialog.test.tsx
git commit -m "feat: add media batch upload dialog"
```

---

### Task 3: Wire the upload flow into creative assets

**Files:**
- Modify: `web/app/assets/AssetsClient.tsx`
- Test: `web/app/assets/AssetsClient.test.tsx`

**Interfaces:**
- Consumes: `MediaUploadDialogProps` and its `onAssetUploaded` callback from Task 2.
- Produces: a media-only toolbar action that opens a directory-snapshotted queue and immediately registers successful assets in the existing grid.

- [ ] **Step 1: Write failing integration tests**

Mock `MediaUploadDialog` as a small harness that displays its `directory` and invokes `onAssetUploaded(image)` on command. Add tests that assert:

```ts
await user.click(screen.getByRole('tab', { name: '多媒体' }))
expect(screen.getByRole('button', { name: '上传' })).toBeVisible()

await user.click(screen.getByRole('tab', { name: '文章' }))
expect(screen.queryByRole('button', { name: '上传' })).toBeNull()
```

For directory capture, load a media directory named `人物参考`, select it, open upload, and assert the mock receives `directory="人物参考"`. Change the page directory while the Dialog remains open and assert the mock value is unchanged. Trigger `onAssetUploaded` and assert the new media card appears immediately when its directory matches the active view.

- [ ] **Step 2: Run integration tests and verify RED**

Run:

```bash
cd web
pnpm test app/assets/AssetsClient.test.tsx
```

Expected: FAIL because the media toolbar has no upload action or Dialog.

- [ ] **Step 3: Add the media upload state and toolbar action**

In `AssetsClient.tsx`:

```ts
const [mediaUploadDirectory, setMediaUploadDirectory] = useState<string | null>(null)

function openMediaUpload() {
  setMediaUploadDirectory(directory)
}
```

Change `WorkspaceToolbar.actions` so media receives `<Button onClick={openMediaUpload} size="sm"><Upload />上传</Button>`, while preserving the existing article and prompt actions. Import and render:

```tsx
<MediaUploadDialog
  directory={mediaUploadDirectory ?? ''}
  onAssetUploaded={registerMediaAsset}
  onClose={() => setMediaUploadDirectory(null)}
  open={mediaUploadDirectory !== null}
/>
```

Do not bind the Dialog’s directory prop directly to live `directory`; the captured state is the required snapshot.

- [ ] **Step 4: Run integration and related workspace tests**

Run:

```bash
cd web
pnpm test app/assets/AssetsClient.test.tsx app/assets/MediaUploadDialog.test.tsx app/assets/assets-layout.test.ts app/assets/assets-system-directory.test.tsx
pnpm exec eslint app/assets/AssetsClient.tsx app/assets/AssetsClient.test.tsx
```

Expected: all tests pass; compact grid and preview regressions remain green.

- [ ] **Step 5: Commit the workspace integration**

```bash
git add web/app/assets/AssetsClient.tsx web/app/assets/AssetsClient.test.tsx
git commit -m "feat: expose media uploads in creative assets"
```

---

### Task 4: Focused end-to-end verification

**Files:**
- Verify only; no expected production changes.

**Interfaces:**
- Consumes: completed Tasks 1–3 and the existing local API/upload storage.
- Produces: evidence that selection, paste, directory assignment, upload, and immediate display work in the real application.

- [ ] **Step 1: Run all focused automated regressions**

```bash
cd web
pnpm test lib/api/assets.test.ts app/assets/MediaUploadDialog.test.tsx app/assets/AssetsClient.test.tsx app/assets/PromptAssetWorkspace.test.tsx app/assets/assets-layout.test.ts app/assets/assets-system-directory.test.tsx app/digital-humans/role-management.test.tsx
pnpm exec eslint lib/api/assets.ts lib/api/assets.test.ts app/assets/MediaUploadDialog.tsx app/assets/MediaUploadDialog.test.tsx app/assets/AssetsClient.tsx app/assets/AssetsClient.test.tsx
```

Expected: every selected test and ESLint command exits 0.

- [ ] **Step 2: Run the existing backend upload regression without changing backend code**

Run the existing directory-aware upload test with the project interpreter:

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_asset_directories_router.py::test_media_upload_can_be_assigned_to_an_existing_directory -q
```

Expected: the existing media upload endpoint tests pass. If the known sandbox/database fixture fails before assertions, report it as blocked rather than passing and proceed with browser verification against the already running local API if available.

- [ ] **Step 3: Verify the real browser workflow**

Start backend, worker only if required by the current project, and frontend with the documented host configuration (`REDIS_URL=redis://127.0.0.1:6379/0`). In a browser:

1. Open `/assets` and select “多媒体”.
2. Select or create a test media directory.
3. Click “上传”.
4. Add at least two files with the chooser and paste one clipboard image.
5. Confirm the queue shows all accepted files and the target directory.
6. Remove one item, upload the remainder, and confirm progress/status behavior.
7. Confirm successful assets appear immediately in the selected directory.
8. Double-click an uploaded image/video/audio asset and verify existing preview behavior.
9. Open another queue with a pending item and verify close confirmation.
10. Confirm no upload occurs when pasting outside the Dialog.

Use disposable test media only. Record exact observed counts and any media type not exercised; do not describe untested types as verified.

- [ ] **Step 4: Inspect the final scoped diff**

```bash
git diff --check
git status --short
git diff -- web/lib/api/assets.ts web/lib/api/assets.test.ts web/app/assets/MediaUploadDialog.tsx web/app/assets/MediaUploadDialog.test.tsx web/app/assets/AssetsClient.tsx web/app/assets/AssetsClient.test.tsx
```

Expected: no whitespace errors; only intended upload changes are reviewed, while unrelated existing worktree changes remain untouched.

- [ ] **Step 5: Record the verification result**

Summarize exact automated test counts, the backend selector result, browser-tested media types, and any validation limit. If verification exposes a behavior defect, return to the relevant task’s RED/GREEN cycle instead of patching it during this verification step.
