# Creative Asset WYSIWYG Paste Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Creative Assets article source editor with a single-pane visual Markdown editor that preserves pasted webpage structure and stores pasted remote images in Ediora without blocking saves when an image import fails.

**Architecture:** A Crepe/Milkdown client-only editor continues to emit standard Markdown into the existing `CreativeAsset.content` state. Pure clipboard conversion code sanitizes HTML and marks external images with stable import IDs; a small ProseMirror plugin maps asynchronous results back to the correct image nodes. A new backend service downloads public images with explicit SSRF, redirect, type, size, timeout, and proxy controls, while the assets router exposes per-item batch results.

**Tech Stack:** Next.js 16, React 19, TypeScript, Crepe/Milkdown, Turndown with GFM rules, Vitest/Testing Library, FastAPI, httpx, Pillow, pytest, PostgreSQL-backed router fixtures.

## Global Constraints

- Only replace the Creative Assets article editor; do not change the Drafts editor.
- Continue storing and saving standard Markdown through the existing Creative Asset API and database field.
- Preserve headings, paragraphs, bold, italic, strike-through, links, lists, blockquotes, fenced code, horizontal rules, tables, and images; discard webpage CSS, scripts, forms, embeds, ads, and interactive layout.
- Pasting image files, image URLs, or full webpage HTML must localize every supported remote image.
- A failed image import keeps the original remote URL, shows a retryable warning, and never blocks saving the article.
- Remote image downloads must not inherit `HTTP_PROXY`, `HTTPS_PROXY`, or other environment proxy settings.
- Remote downloads accept at most 20 URLs per request, 10 MiB per image, 3 redirects, and JPEG, PNG, GIF, or WebP content.
- Existing compact asset rows, title fallback, directory selection, source URL editing, save shortcuts, and unsaved-change behavior must remain unchanged.

---

### Task 1: Safe Remote Image Import Service

**Files:**
- Create: `backend/remote_image_import.py`
- Create: `backend/tests/test_remote_image_import.py`

**Interfaces:**
- Produces: `RemoteImageImportError(code: str, message: str)`.
- Produces: `RemoteImageImportResult(source_url: str, url: str = "", error_code: str = "", error: str = "")`.
- Produces: `async import_remote_image(source_url: str, uploads_dir: Path, client_factory: Callable[..., AsyncContextManager[httpx.AsyncClient]] = httpx.AsyncClient) -> RemoteImageImportResult`.
- Produces: `async import_remote_images(urls: list[str], uploads_dir: Path, client_factory=...) -> list[RemoteImageImportResult]`, preserving input order and converting each failure into a result instead of raising for the batch.

- [ ] **Step 1: Write failing URL-safety and direct-client tests**

Add tests that monkeypatch `socket.getaddrinfo` and inject an `httpx.MockTransport` client factory. Cover a public HTTPS URL, `localhost`, literal loopback/private/link-local/reserved addresses, credentials in a URL, unsupported schemes, and a DNS name resolving to a non-global IP. Assert the client factory receives `trust_env=False` and `follow_redirects=False`.

```python
@pytest.mark.asyncio
async def test_import_remote_image_rejects_private_dns_target(tmp_path, monkeypatch):
    monkeypatch.setattr(
        remote_image_import.socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.8", 443))],
    )

    result = await remote_image_import.import_remote_image(
        "https://images.example/private.png",
        tmp_path,
    )

    assert result.error_code == "unsafe_url"
    assert result.url == ""
```

- [ ] **Step 2: Run the safety tests and verify they fail**

Working directory: `backend`

Run: `/home/violet/miniconda3/envs/wems/bin/python -m pytest tests/test_remote_image_import.py -q`

Expected: FAIL because `remote_image_import` and its public interfaces do not exist.

- [ ] **Step 3: Implement URL validation and manual redirect fetching**

In `remote_image_import.py`, define exact limits and error codes:

```python
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_REDIRECTS = 3
ALLOWED_CONTENT_TYPES = {
    "image/jpeg": ("JPEG", ".jpg"),
    "image/png": ("PNG", ".png"),
    "image/gif": ("GIF", ".gif"),
    "image/webp": ("WEBP", ".webp"),
}
ERROR_MESSAGES = {
    "unsafe_url": "图片地址未通过安全检查",
    "unreachable": "图片地址不可访问",
    "not_image": "远程内容不是受支持的图片",
    "too_large": "图片超过 10MB 限制",
    "timeout": "图片下载超时",
}
```

Validate `http`/`https`, host presence, no credentials, and every address returned by `socket.getaddrinfo`; require `ipaddress.ip_address(...).is_global`. Create `httpx.AsyncClient(trust_env=False, follow_redirects=False, timeout=httpx.Timeout(20, connect=5))`. Follow only 301/302/303/307/308 responses, resolve relative `Location` with `urljoin`, and repeat the full URL/DNS validation before each request.

- [ ] **Step 4: Write failing stream, type, redirect, and deduplication tests**

Add tests for a valid in-memory PNG, misleading `Content-Type`, invalid image bytes, declared or streamed content over 10 MiB, timeout, missing/unsafe redirect targets, more than three redirects, partial batch failure, stable input ordering, and two different URLs returning identical bytes. Use Pillow to generate the PNG fixture. Assert identical bytes return the same `/api/uploads/asset-image-<sha256>.png` URL and only one file exists.

- [ ] **Step 5: Implement bounded streaming, verification, and content-hash storage**

Stream with `client.stream`, reject an oversized `Content-Length` before reading, stop as soon as accumulated bytes exceed the limit, then verify the bytes with `PIL.Image.open(BytesIO(data)).verify()`. Require the detected Pillow format to match `ALLOWED_CONTENT_TYPES`. Store as `asset-image-{sha256(data).hexdigest()}{extension}` under `uploads_dir`; if that exact file already exists, reuse it. Return only `/api/uploads/<filename>` and categorized Chinese errors; never expose paths or raw exceptions.

- [ ] **Step 6: Run the service tests**

Working directory: `backend`

Run: `/home/violet/miniconda3/envs/wems/bin/python -m pytest tests/test_remote_image_import.py -q`

Expected: PASS.

- [ ] **Step 7: Commit the service**

```bash
git add backend/remote_image_import.py backend/tests/test_remote_image_import.py
git commit -m "feat: safely import remote asset images"
```

---

### Task 2: Creative Asset Image Import API

**Files:**
- Modify: `backend/routers/assets.py`
- Create: `backend/tests/test_asset_image_import_router.py`

**Interfaces:**
- Consumes: `import_remote_images(urls, Path(_UPLOADS_DIR))` from Task 1.
- Produces: `POST /api/assets/images/import` with request `{ "urls": string[] }` and response `{ "items": RemoteImageImportItem[] }`.
- Produces: each item as `{ "source_url": str, "url": str, "error_code": str, "error": str }` in request order.

- [ ] **Step 1: Write failing API contract tests**

Create a router fixture matching `test_asset_directories_router.py`, monkeypatch `routers.assets.import_remote_images`, and verify:

```python
response = client.post("/api/assets/images/import", json={
    "urls": ["https://img.example/a.png", "https://img.example/b.png"],
})
assert response.status_code == 200
assert response.json() == {"items": [
    {"source_url": "https://img.example/a.png", "url": "/api/uploads/a.png", "error_code": "", "error": ""},
    {"source_url": "https://img.example/b.png", "url": "", "error_code": "timeout", "error": "图片下载超时"},
]}
```

Also assert an empty list and more than 20 URLs return 422 and that the endpoint does not create `CreativeAsset` rows.

- [ ] **Step 2: Run the router tests and verify they fail**

Working directory: `backend`

Run: `/home/violet/miniconda3/envs/wems/bin/python -m pytest tests/test_asset_image_import_router.py -q`

Expected: FAIL with 404 because the route is absent.

- [ ] **Step 3: Add request/response models and route**

Add these models near the existing asset request models:

```python
class RemoteImageImportBody(BaseModel):
    urls: list[str] = Field(min_length=1, max_length=20)

class RemoteImageImportItem(BaseModel):
    source_url: str
    url: str = ""
    error_code: str = ""
    error: str = ""

class RemoteImageImportOut(BaseModel):
    items: list[RemoteImageImportItem]
```

The route delegates to `import_remote_images(body.urls, Path(_UPLOADS_DIR))` and returns serialized dataclass results. Do not add database writes or delete behavior for inline article images.

- [ ] **Step 4: Run focused and existing asset router tests**

Working directory: `backend`

Run: `/home/violet/miniconda3/envs/wems/bin/python -m pytest tests/test_asset_image_import_router.py tests/test_asset_directories_router.py -q`

Expected: PASS.

- [ ] **Step 5: Commit the API**

```bash
git add backend/routers/assets.py backend/tests/test_asset_image_import_router.py
git commit -m "feat: expose asset image import API"
```

---

### Task 3: Clipboard Conversion and Frontend Image APIs

**Files:**
- Modify: `web/package.json`
- Modify: `web/pnpm-lock.yaml`
- Modify: `web/lib/api/assets.ts`
- Create: `web/app/assets/asset-paste.ts`
- Create: `web/app/assets/asset-paste.test.ts`
- Create: `web/lib/api/assets.test.ts`

**Interfaces:**
- Produces: `type RemoteImageImportItem = { source_url: string; url: string; error_code: string; error: string }`.
- Produces: `importCreativeAssetImages(urls: string[]): Promise<RemoteImageImportItem[]>`.
- Produces: `uploadInlineAssetImage(file: File): Promise<string>`.
- Produces: `convertClipboardHtml(html: string): { markdown: string; images: Array<{ id: string; sourceUrl: string }> }`.
- Produces: `imageImportMarker(id: string): string` and `stripImageImportMarkers(markdown: string): string`.
- Produces: `imageUrlFromPlainText(value: string): string | null`.

- [ ] **Step 1: Add the Markdown-native editor and conversion dependencies**

Working directory: `web`

Run: `pnpm add @milkdown/crepe @milkdown/kit turndown turndown-plugin-gfm`

Run: `pnpm add -D @types/turndown`

Do not add standalone `prosemirror-*` packages; import ProseMirror APIs through `@milkdown/kit` so the editor uses one module instance.

- [ ] **Step 2: Write failing API helper tests**

Mock `fetch` and assert `importCreativeAssetImages` sends one JSON request to `/assets/images/import`, preserves item order, and returns per-item failures. Assert `uploadInlineAssetImage` sends `FormData` to `/upload/image` and returns the server-relative `/api/uploads/...` URL so persisted Markdown remains portable.

- [ ] **Step 3: Implement the API helpers**

Use the existing `apiFetch` wrapper:

```typescript
export const importCreativeAssetImages = async (urls: string[]) => (
  await apiFetch<{ items: RemoteImageImportItem[] }>('/assets/images/import', {
    method: 'POST',
    body: JSON.stringify({ urls }),
  })
).items

export async function uploadInlineAssetImage(file: File) {
  const body = new FormData()
  body.append('file', file)
  const result = await apiFetch<{ url: string }>('/upload/image', {
    method: 'POST', body, headers: {},
  })
  return result.url
}
```

- [ ] **Step 4: Write failing clipboard conversion tests**

Test HTML containing scripts, styles, iframes, headings, paragraphs, bold/italic/strike text, links, ordered/unordered lists, blockquotes, fenced code, a table, a data-URL image, and two HTTP images. Assert dangerous nodes and CSS are absent, supported structures become GFM Markdown, data URLs are discarded, every HTTP image gets a unique marker title, and the returned `images` list preserves DOM order. Test plain text image detection for HTTP(S) image paths and rejection of surrounding prose/non-HTTP schemes.

- [ ] **Step 5: Implement deterministic HTML cleanup and Turndown conversion**

Parse with `DOMParser`, remove `script, style, noscript, template, iframe, object, embed, form, input, button, svg`, remove `style`, `class`, `id`, and `on*` attributes from remaining elements, and discard non-HTTP(S) image nodes. Replace each accepted image title with `wms-import:<crypto.randomUUID()>`, recording the previous title if needed only in memory. Configure Turndown with fenced code and `turndown-plugin-gfm` tables/strike-through/task-list rules. `stripImageImportMarkers` must remove only quoted image titles beginning with `wms-import:` or `wms-import-failed:` while retaining the image URL and alt text.

- [ ] **Step 6: Run conversion and API tests**

Working directory: `web`

Run: `pnpm test -- app/assets/asset-paste.test.ts lib/api/assets.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit frontend foundations**

```bash
git add web/package.json web/pnpm-lock.yaml web/lib/api/assets.ts web/lib/api/assets.test.ts web/app/assets/asset-paste.ts web/app/assets/asset-paste.test.ts
git commit -m "feat: prepare rich asset paste pipeline"
```

---

### Task 4: Visual Markdown Editor and Async Image State

**Files:**
- Create: `web/app/assets/AssetVisualMarkdownEditor.tsx`
- Create: `web/app/assets/asset-image-import-plugin.ts`
- Create: `web/app/assets/AssetVisualMarkdownEditor.test.tsx`
- Create: `web/app/assets/asset-image-import-plugin.test.ts`

**Interfaces:**
- Consumes: Task 3 conversion/API functions.
- Produces: `AssetVisualMarkdownEditor({ value, onChange, documentKey }: { value: string; onChange(markdown: string): void; documentKey: number })`.
- Produces: `createAssetImageImportPlugin(options: { onRetry(id: string): void }): Plugin`.
- Plugin metadata actions: `{ type: 'register' | 'success' | 'failure' | 'remove'; id: string; sourceUrl?: string; localUrl?: string; error?: string }`.

- [ ] **Step 1: Write failing plugin state tests**

Build a minimal GFM ProseMirror state through Milkdown kit test helpers. Insert image nodes carrying `title="wms-import:<id>"`, dispatch registration metadata, edit text before the images, then dispatch success/failure metadata. Assert mapped positions still identify the correct nodes, success changes only that node to the local URL and removes its marker, failure leaves the original URL and changes the marker to `wms-import-failed:<id>`, and retry changes it back to processing.

- [ ] **Step 2: Implement the image import plugin**

Use `Plugin`, `PluginKey`, `Decoration`, and `DecorationSet` from `@milkdown/kit/prose/*`. Store import entries by stable ID and map their positions through every transaction. Render a node decoration plus a widget immediately after each active image:

```typescript
type ImageImportEntry = {
  id: string
  pos: number
  sourceUrl: string
  status: 'processing' | 'failed'
  error: string
}
```

The processing widget says `正在保存图片`; the failed widget is a button named `图片本地化失败，重试`. Completion must verify the node at the mapped position still carries the same marker before changing attributes. If the user deleted the node, remove the entry without touching any other content.

- [ ] **Step 3: Write failing editor lifecycle and paste tests**

Mock `Crepe` with `create`, `destroy`, `on`, `getMarkdown`, and an underlying editor action/transaction adapter. Verify client-only initialization with `defaultValue`, cleanup on unmount, clean Markdown emission through `stripImageImportMarkers`, file-image paste through `uploadInlineAssetImage`, full HTML paste through `convertClipboardHtml`, URL-only paste, one batch import call for all HTML images, per-item success/failure plugin actions, non-blocking failure toast, retry of only one failed URL, cancellation/ignoring stale completions after `documentKey` changes, and an initialization error state with a working `重试加载编辑器` button.

- [ ] **Step 4: Implement the client-only Crepe editor**

Load `@milkdown/crepe` and the editor-only support code through a client-side dynamic import inside `useEffect`, then create Crepe against a `ref`, pass the initial `value` as `defaultValue`, add `createAssetImageImportPlugin`, configure ImageBlock `onUpload` to call `uploadInlineAssetImage`, and configure `proxyDomURL: creativeAssetUrl` so relative stored URLs render through the API origin. Subscribe with `crepe.on(listener => listener.markdownUpdated(...))` and emit only marker-stripped Markdown. Destroy Crepe and abort active imports on cleanup. Do not push each controlled `value` change back into Crepe; `documentKey` is the remount boundary when the selected asset changes. Catch initialization failures, preserve the source value in memory, and render an explicit retry control instead of an empty editor.

Handle `onPasteCapture` in this order:

1. image files: prevent default and upload through the Milkdown upload path;
2. HTML: sanitize/convert, insert Markdown at the current selection, register all image IDs, then batch import URLs;
3. plain image URL: insert one marked image and import it;
4. all other input: leave the native Milkdown paste behavior unchanged.

Keep a per-editor `AbortController`. Ignore all completion callbacks whose captured `documentKey` no longer matches the mounted editor.

- [ ] **Step 5: Run editor tests**

Working directory: `web`

Run: `pnpm test -- app/assets/asset-image-import-plugin.test.ts app/assets/AssetVisualMarkdownEditor.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit the editor**

```bash
git add web/app/assets/AssetVisualMarkdownEditor.tsx web/app/assets/AssetVisualMarkdownEditor.test.tsx web/app/assets/asset-image-import-plugin.ts web/app/assets/asset-image-import-plugin.test.ts
git commit -m "feat: add visual creative asset editor"
```

---

### Task 5: Asset Workspace Integration, Themes, and Regression Verification

**Files:**
- Modify: `web/app/assets/ArticleAssetWorkspace.tsx`
- Modify: `web/app/assets/AssetsClient.test.tsx`
- Modify: `web/app/globals.css`

**Interfaces:**
- Consumes: `AssetVisualMarkdownEditor` from Task 4.
- Preserves: all existing `ArticleAssetWorkspace` props and save behavior.

- [ ] **Step 1: Update the workspace test mock and write the failing integration assertion**

Replace the `@/app/drafts/MarkdownEditor` mock with an `AssetVisualMarkdownEditor` mock. Assert it receives the selected asset ID as `documentKey`, its change callback updates `CreativeAsset.content`, and selecting another asset changes both content and key. Retain every existing compact-row, title, directory, source URL, save shortcut, save-failure, and unsaved-change test.

```typescript
expect(screen.getByLabelText('可视化 Markdown 编辑器')).toHaveAttribute(
  'data-document-key',
  '1',
)
```

- [ ] **Step 2: Replace only the Creative Assets editor**

Remove the Drafts `MarkdownEditor` import and its UIW stylesheet import from `ArticleAssetWorkspace.tsx`. Render:

```tsx
<AssetVisualMarkdownEditor
  documentKey={selected.id}
  onChange={content => onChange({ ...selected, content })}
  value={selected.content}
/>
```

Use `key={selected.id}` at the editor boundary so a selection change destroys pending state before initializing the next article. Do not change list rows, title fallback, fields, buttons, or `SplitWorkspace` structure.

- [ ] **Step 3: Add scoped light/dark editor styling**

Import Crepe common styles and the light/dark frame theme from the editor module, then scope project overrides under `.asset-visual-markdown-editor`. Map Crepe background, foreground, border, muted, primary, code, table, menu, tooltip, and selection colors to existing CSS variables. Add readable processing/failed image widget styles and ensure the editor scroll container fills the existing bordered workspace without creating a second page scrollbar.

- [ ] **Step 4: Run focused frontend regressions**

Working directory: `web`

Run: `pnpm test -- app/assets/AssetsClient.test.tsx app/assets/AssetVisualMarkdownEditor.test.tsx app/assets/asset-paste.test.ts lib/api/assets.test.ts`

Expected: PASS.

- [ ] **Step 5: Run backend regressions**

Working directory: `backend`

Run: `/home/violet/miniconda3/envs/wems/bin/python -m pytest tests/test_remote_image_import.py tests/test_asset_image_import_router.py tests/test_asset_directories_router.py -q`

Expected: PASS.

- [ ] **Step 6: Run lint and production build**

Working directory: `web`

Run: `pnpm lint -- app/assets/ArticleAssetWorkspace.tsx app/assets/AssetVisualMarkdownEditor.tsx app/assets/asset-image-import-plugin.ts app/assets/asset-paste.ts lib/api/assets.ts`

Expected: no ESLint errors in changed files.

Run: `pnpm build`

Expected: Next.js production build succeeds.

- [ ] **Step 7: Perform browser acceptance against the running app**

Open `/assets` in both light and dark themes. Paste a standalone image file, a standalone HTTPS image URL, and a webpage selection containing headings, lists, links, a table, and multiple images. Confirm successful images use `/api/uploads/asset-image-*`, one forced failure retains its external URL and exposes retry, saving remains enabled, refresh preserves the Markdown, switching assets never applies a late result to the new article, and the Drafts editor remains unchanged.

- [ ] **Step 8: Commit integration**

```bash
git add web/app/assets/ArticleAssetWorkspace.tsx web/app/assets/AssetsClient.test.tsx web/app/globals.css
git commit -m "feat: enable visual editing for creative assets"
```
