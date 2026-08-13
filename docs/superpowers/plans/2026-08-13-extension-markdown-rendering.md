# Chrome 插件 Markdown 展示实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Chrome 插件以安全的 Markdown 形式展示草稿正文和图片，同时复制时保留原始 Markdown，并在支持的目标中携带富文本图片。

**Architecture:** 在独立的 Manifest V3 插件中增加无外部依赖的 DOM Markdown 渲染器。渲染器负责解析和 URL 安全检查，预览区负责挂载结果；剪贴板模块负责 `text/plain` 原文与 `text/html` 渲染结果的双格式写入，并在浏览器不支持时退回现有纯文本复制。

**Tech Stack:** Chrome Manifest V3 content script、原生 DOM API、Node `node:test`、Playwright。

## Global Constraints

- 不改后端草稿接口、Markdown 存储格式或发布流程。
- 正文中的原始 HTML 不执行、不渲染；渲染器只使用 DOM API 创建节点。
- 图片和链接只允许 `http:`、`https:`；`/api/uploads/...` 按插件当前 API 地址补全。
- 不依赖 CDN 或远程脚本，不把图片二进制写入剪贴板。
- `text/plain` 永远是未改写的原始 Markdown；富文本剪贴板失败时必须降级到纯 Markdown。
- 保持 `.sw-preview-content` 独立滚动和 `.sw-preview-footer` 固定可见。

---

### Task 1: 安全 Markdown 渲染器

**Files:**
- Create: `chrome-extension/content/markdown-renderer.js`
- Create: `chrome-extension/tests/markdown-renderer.test.js`

**Interfaces:**
- Produces `normalizeMarkdownUrl(source, apiBase): string | null`：返回通过协议检查且已补全的 URL，拒绝 `javascript:`、`data:`、空值和无效 URL。
- Produces `renderMarkdown(markdown, options): { element: HTMLElement, html: string }`，其中 `options = { document, apiBase }`；`element` 是 class 为 `sw-markdown` 的安全 DOM 根节点，`html` 是同一结果的序列化 HTML。

- [x] **Step 1: Write the failing tests**

在 `markdown-renderer.test.js` 中使用 `jsdom` 创建 document，先写这些行为断言：

```js
test('renders markdown structure and resolves local asset images', () => {
  const result = renderMarkdown(
    '# 标题\n\n正文 **重点**。\n\n- 一\n- 二\n\n![封面](/api/uploads/cover.png)',
    { document, apiBase: 'http://localhost:8000/api' },
  )

  assert.equal(result.element.querySelector('h1')?.textContent, '标题')
  assert.equal(result.element.querySelector('strong')?.textContent, '重点')
  assert.deepEqual([...result.element.querySelectorAll('li')].map(node => node.textContent), ['一', '二'])
  assert.equal(
    result.element.querySelector('img')?.getAttribute('src'),
    'http://localhost:8000/api/uploads/cover.png',
  )
  assert.match(result.html, /<img[^>]+class="sw-markdown-image"/)
})

test('does not execute raw html or unsafe image and link protocols', () => {
  const result = renderMarkdown(
    '<script>alert(1)</script> [危险](javascript:alert(1)) ![危险](data:text/html,x)',
    { document, apiBase: 'http://localhost:8000/api' },
  )

  assert.equal(result.element.querySelector('script'), null)
  assert.equal(result.element.querySelector('a'), null)
  assert.equal(result.element.querySelector('img'), null)
  assert.match(result.element.textContent, /危险/)
})
```

- [x] **Step 2: Run the renderer tests and verify the expected failure**

Run: `node --test chrome-extension/tests/markdown-renderer.test.js`

Expected: FAIL because `../content/markdown-renderer.js` does not exist yet.

- [x] **Step 3: Implement the minimal renderer**

Implement `normalizeMarkdownUrl` with `new URL(source, apiBase)`, accepting only `http:` and `https:`. For `/api/uploads/...`, resolve against `new URL(apiBase).origin` so `http://localhost:8000/api` becomes `http://localhost:8000/api/uploads/...` without duplicating `/api`.

Implement a line-based block parser that creates DOM nodes for `#`–`######` headings, fenced code blocks, blockquotes, `-`/`*`/`+` unordered lists, numeric ordered lists, `---` rules, and paragraph groups. Implement inline parsing for backtick code, `**`/`__` strong, `*`/`_` emphasis, `~~` deletion, `[label](url)`, and `![alt](url)`. Build text and attributes through `textContent`/`setAttribute`; never assign input Markdown to `innerHTML`.

For images, create `img.sw-markdown-image` with `alt`, `src`, `loading="lazy"`, and `decoding="async"`; attach an `error` listener that replaces the image with a `span.sw-markdown-image-error` containing the alt text and “图片加载失败”。For links, create `a` with `target="_blank"` and `rel="noreferrer noopener"` only after URL validation.

- [x] **Step 4: Run the renderer tests and verify they pass**

Run: `node --test chrome-extension/tests/markdown-renderer.test.js`

Expected: PASS with both tests green and no console errors.

- [x] **Step 5: Commit the isolated renderer**

```bash
git add chrome-extension/content/markdown-renderer.js chrome-extension/tests/markdown-renderer.test.js
git commit -m "feat: add safe extension markdown renderer"
```

### Task 2: Markdown 双格式剪贴板

**Files:**
- Modify: `chrome-extension/content/workbench-clipboard.js`
- Create: `chrome-extension/tests/workbench-clipboard.test.js`

**Interfaces:**
- Produces `copyMarkdown(markdown, { html, clipboard, document, clipboardItemClass, blobClass }): Promise<'rich' | 'plain'>`。
- Consumes the existing `copyText` fallback and the `renderMarkdown(...).html` output from Task 1。

- [x] **Step 1: Write the failing tests**

```js
test('copies original markdown and rendered html when rich clipboard is available', async () => {
  const writes = []
  class FakeClipboardItem {
    constructor(items) { this.items = items }
  }
  const result = await copyMarkdown('![图](/api/uploads/a.png)', {
    html: '<p><img src="http://localhost:8000/api/uploads/a.png"></p>',
    clipboard: { write: async items => writes.push(items) },
    clipboardItemClass: FakeClipboardItem,
    blobClass: Blob,
  })

  assert.equal(result, 'rich')
  assert.equal(writes.length, 1)
  assert.equal(await writes[0][0].items['text/plain'].text(), '![图](/api/uploads/a.png)')
  assert.match(await writes[0][0].items['text/html'].text(), /<img/)
})

test('falls back to copying original markdown as plain text', async () => {
  const copied = []
  const result = await copyMarkdown('正文', {
    html: '<p>正文</p>',
    clipboard: { writeText: async value => copied.push(value) },
    document: { createElement: () => ({ setAttribute() {}, style: {}, select() {}, remove() {} }), body: { appendChild() {} } },
  })

  assert.equal(result, 'plain')
  assert.deepEqual(copied, ['正文'])
})
```

- [x] **Step 2: Run the clipboard tests and verify the expected failure**

Run: `node --test chrome-extension/tests/workbench-clipboard.test.js`

Expected: FAIL because `copyMarkdown` is not exported yet.

- [x] **Step 3: Implement `copyMarkdown`**

When `clipboard.write`, `clipboardItemClass`, and `blobClass` are available, construct one item with:

```js
{
  'text/plain': new blobClass([String(markdown ?? '')], { type: 'text/plain' }),
  'text/html': new blobClass([String(html ?? '')], { type: 'text/html' }),
}
```

Call `clipboard.write([item])` and return `'rich'`. If any rich path prerequisite is missing or the write rejects, call `copyText(markdown, { clipboard, document })` and return `'plain'`; preserve `CLIPBOARD_FAILED` when both paths fail so the existing UI can show its safe error message.

- [x] **Step 4: Run the clipboard tests and the existing extension tests**

Run: `node --test chrome-extension/tests/workbench-clipboard.test.js chrome-extension/tests/workbench.test.js`

Expected: all tests PASS.

- [x] **Step 5: Commit the clipboard change**

```bash
git add chrome-extension/content/workbench-clipboard.js chrome-extension/tests/workbench-clipboard.test.js
git commit -m "feat: copy extension drafts as markdown and html"
```

### Task 3: 接入插件文章预览

**Files:**
- Modify: `chrome-extension/content/workbench-runtime.js`
- Modify: `chrome-extension/manifest.json`
- Modify: `chrome-extension/README.md`
- Modify: `chrome-extension/tests/workbench.test.js`

**Interfaces:**
- Consumes `renderMarkdown` from `content/markdown-renderer.js` and `copyMarkdown` from `content/workbench-clipboard.js`。
- Keeps `copySelected` using the normalized draft content as `text/plain` and uses `state.apiBase` for local image URLs。

- [x] **Step 1: Write the failing integration assertions**

Extend `workbench.test.js` with a source-level contract assertion that the runtime imports `renderMarkdown` and `copyMarkdown`, uses `data-role="preview-content"` as a `div` rather than a `pre`, and labels the action “复制 Markdown”。Keep the existing `syncPreviewVisibility` behavior test unchanged.

- [x] **Step 2: Run the integration test and verify it fails**

Run: `node --test chrome-extension/tests/workbench.test.js`

Expected: FAIL because the runtime still contains `<pre>`, `copyText`, and does not import the renderer.

- [x] **Step 3: Implement the preview integration**

In `workbench-runtime.js`:

1. Import `renderMarkdown` and `copyMarkdown`.
2. Replace `<pre data-role="preview-content">` with `<div data-role="preview-content"></div>`.
3. Replace the pre-only CSS with `.sw-markdown` styles for headings, paragraphs, lists, blockquotes, code, links, `.sw-markdown-image`, and `.sw-markdown-image-error`; preserve the existing overflow rules on `.sw-preview-content`.
4. In `renderPreview`, call `renderMarkdown(draft.content, { document, apiBase: state.apiBase })` and `previewContent.replaceChildren(rendered.element)`.
5. In `copySelected`, render the same Markdown to obtain `html`, call `copyMarkdown(draft.content, { html, clipboard: window.navigator?.clipboard, document, clipboardItemClass: window.ClipboardItem, blobClass: window.Blob })`, and keep the state success/error handling. Show “Markdown 已复制到剪贴板”。
6. Keep character count based on `draft.content`, not rendered text.

In `manifest.json`, add `content/markdown-renderer.js` to `web_accessible_resources`. In the README, replace the statement that Markdown is not parsed with the rendered-preview and dual-format-copy behavior.

- [x] **Step 4: Run the integration tests and verify they pass**

Run: `node --test chrome-extension/tests/workbench.test.js chrome-extension/tests/workbench-clipboard.test.js chrome-extension/tests/markdown-renderer.test.js`

Expected: all extension unit tests PASS.

- [x] **Step 5: Commit the preview integration**

```bash
git add chrome-extension/content/workbench-runtime.js chrome-extension/manifest.json chrome-extension/README.md chrome-extension/tests/workbench.test.js
git commit -m "feat: render markdown in extension draft preview"
```

### Task 4: 端到端图片与滚动回归

**Files:**
- Modify: `wemedia-studio/e2e/extension-workbench-layout.spec.ts`
- Modify: `chrome-extension/tests/manifest.test.js` only if the manifest contract needs an explicit renderer resource assertion.

**Interfaces:**
- Consumes the mounted workbench from Tasks 1–3; no backend or API schema changes。

- [x] **Step 1: Extend the harness with Markdown and a deterministic image**

Add a Markdown heading and `![预览图](/api/uploads/test.png)` to the harness draft. Route `http://localhost:8000/api/uploads/test.png` to a tiny valid PNG response. Keep the existing 420-line body so the preview must still scroll.

- [x] **Step 2: Add the visible-image assertions**

After selecting the draft, assert `.sw-markdown-image` is visible and its `src` equals `http://localhost:8000/api/uploads/test.png`; retain the existing footer visibility and scroll position assertions.

- [x] **Step 3: Run the focused browser test**

Run: `pnpm exec playwright test e2e/extension-workbench-layout.spec.ts`

Expected: desktop and narrow viewport cases PASS, with no page errors or console warnings.

- [x] **Step 4: Run final checks**

Run:

```bash
node --test chrome-extension/tests/*.test.js
pnpm exec playwright test e2e/extension-workbench-layout.spec.ts
node --check chrome-extension/content/markdown-renderer.js
node --check chrome-extension/content/workbench-clipboard.js
node --check chrome-extension/content/workbench-runtime.js
git diff --check
```

Expected: all extension tests, focused browser tests, syntax checks, and diff checks pass. Any unrelated pre-existing repository-wide TypeScript failures must be reported separately and not treated as part of this feature.

- [x] **Step 5: Commit the end-to-end regression**

```bash
git add wemedia-studio/e2e/extension-workbench-layout.spec.ts chrome-extension/tests/manifest.test.js
git commit -m "test: cover extension markdown image preview"
```
