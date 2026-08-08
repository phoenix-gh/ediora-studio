# 述策助手悬浮发布指挥台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox ("- [ ]") syntax for tracking.

**Goal:** 在 X 页面增加一个不改动草稿数据、只读取待发布草稿并支持原文预览和复制的专业悬浮工作台。

**Architecture:** 使用现有 GET /api/write/drafts 接口，不修改后端。Chrome MV3 service worker 负责读取 API 配置、校验本机 host permission、跨域请求并裁剪响应；X content script 通过 Shadow DOM 挂载工作台，使用纯函数模型完成 ready 筛选、排序、搜索和类型筛选。现有 Shuce.publish() 桥接和发布逻辑保持不变。

**Tech Stack:** Manifest V3、原生 JavaScript ESM、Shadow DOM、Chrome storage/runtime messaging、Node built-in test runner。

## Global Constraints

- 只使用现有 GET /api/write/drafts，不新增后端 endpoint。
- 草稿正文只保存在当前页面内存，不写入 chrome.storage.local，service worker 不打印正文。
- 只允许 http://localhost:8000/*、http://127.0.0.1:8000/* 作为 MVP API host permission，不使用 <all_urls>。
- 不读取 Cookie、X Token、Authorization header 或 WeMediaStudio 登录凭据。
- 所有草稿正文必须通过 textContent、value 或 pre 文本节点写入，禁止把正文当 HTML 注入。
- 本次不自动发布、不修改草稿、不增加发布按钮；Shuce.publish() 保持现有行为。
- 不引入 React、构建工具或第三方 UI 组件库。
- 每个生产模块先有一个会失败的行为测试，再写最小实现；每个绿色阶段运行对应测试。

---

## Task 1: 建立草稿数据模型和后台 API 合同

**Files:**
- Create: chrome-extension/content/draft-model.js
- Create: chrome-extension/background/draft-api.js
- Test: chrome-extension/tests/draft-model.test.js
- Test: chrome-extension/tests/draft-api.test.js

**Interfaces:**
- draft-model.js exports normalizeDraft, normalizeDrafts, selectReadyDrafts, filterDrafts, getDraftTypeLabel, getDraftTypeOptions, formatRelativeTime, and getDraftTitle.
- draft-api.js exports DEFAULT_API_BASE, API_BASE_STORAGE_KEY, ALLOWED_API_BASES, normalizeApiBase, assertAllowedApiBase, sanitizeDraftCollection, and fetchDraftCollection.
- selectReadyDrafts accepts the backend array and returns normalized ready drafts sorted by updated_at descending.
- fetchDraftCollection(apiBase, options) performs GET [normalizedApiBase]/write/drafts and returns only id, title, content, status, draft_type, and updated_at.

- [ ] **Step 1: Write failing model tests**

~~~js
import assert from 'node:assert/strict'
import test from 'node:test'
import { filterDrafts, getDraftTitle, getDraftTypeOptions, selectReadyDrafts } from '../content/draft-model.js'

const drafts = [
  { id: 2, title: 'X 帖子', content: 'Agent 工作流', status: 'ready', draft_type: 'x', updated_at: '2026-08-08T12:00:00Z' },
  { id: 1, title: '文章标题', content: '完整文章正文', status: 'editing', draft_type: 'article', updated_at: '2026-08-08T13:00:00Z' },
  { id: 3, title: '', draft: '公众号正文', status: 'ready', draft_type: 'mp', updated_at: '2026-08-08T11:00:00Z' },
]

test('keeps only ready drafts and sorts newest first', () => {
  assert.deepEqual(selectReadyDrafts(drafts).map(draft => draft.id), [2, 3])
})

test('searches title/content and filters by type', () => {
  const ready = selectReadyDrafts(drafts)
  assert.deepEqual(filterDrafts(ready, { query: '工作流' }).map(draft => draft.id), [2])
  assert.deepEqual(filterDrafts(ready, { type: 'mp' }).map(draft => draft.id), [3])
})

test('uses labels and safe title fallback', () => {
  const ready = selectReadyDrafts([{ id: 4, title: '', content: '', status: 'ready', draft_type: 'podcast' }])
  assert.equal(getDraftTitle(ready[0]), '未命名草稿')
  assert.deepEqual(getDraftTypeOptions(ready), ['podcast'])
})

test('supports legacy draft field when content is absent', () => {
  assert.equal(selectReadyDrafts(drafts)[1].content, '公众号正文')
})
~~~

- [ ] **Step 2: Run the model tests and verify the expected red state**

Run: cd chrome-extension && node --test tests/draft-model.test.js

Expected: FAIL with ERR_MODULE_NOT_FOUND because content/draft-model.js does not exist. Fix test mistakes before writing production code.

- [ ] **Step 3: Implement the minimal pure model**

Implement the following normalization contract:

~~~js
export function normalizeDraft(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalidResponseError('草稿条目不是对象')
  if (raw.id === undefined || raw.id === null || String(raw.id).trim() === '') {
    throw invalidResponseError('草稿条目缺少有效 id')
  }
  return {
    id: raw.id,
    title: String(raw.title ?? ''),
    content: String(raw.content ?? raw.draft ?? ''),
    status: String(raw.status ?? ''),
    draft_type: String(raw.draft_type ?? 'article'),
    updated_at: String(raw.updated_at ?? ''),
  }
}

export function selectReadyDrafts(rawDrafts) {
  return normalizeDrafts(rawDrafts)
    .filter(draft => draft.status === 'ready')
    .sort((left, right) => toTimestamp(right.updated_at) - toTimestamp(left.updated_at))
}
~~~

filterDrafts searches title and content case-insensitively, getDraftTypeOptions returns unique raw values in label order, and formatRelativeTime never throws for an empty/invalid timestamp.

- [ ] **Step 4: Run model tests and verify green**

Run: cd chrome-extension && node --test tests/draft-model.test.js

Expected: all model tests pass.

- [ ] **Step 5: Write failing API contract tests**

~~~js
import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_API_BASE, assertAllowedApiBase, fetchDraftCollection, normalizeApiBase } from '../background/draft-api.js'

test('normalizes and restricts local API bases', () => {
  assert.equal(normalizeApiBase('http://localhost:8000/api/'), DEFAULT_API_BASE)
  assert.equal(assertAllowedApiBase('http://127.0.0.1:8000/api'), 'http://127.0.0.1:8000/api')
  assert.throws(() => assertAllowedApiBase('https://example.com/api'), { code: 'DRAFT_API_HOST_NOT_ALLOWED' })
  assert.throws(() => normalizeApiBase('not a url'), { code: 'DRAFT_API_NOT_CONFIGURED' })
})

test('fetches the existing endpoint and strips unrelated fields', async () => {
  const calls = []
  const result = await fetchDraftCollection(DEFAULT_API_BASE, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return new Response(JSON.stringify([{ id: 7, title: '标题', content: '正文', status: 'ready', draft_type: 'article', updated_at: 'now', sources: ['private'] }]), { status: 200 })
    },
  })
  assert.equal(calls[0].url, 'http://localhost:8000/api/write/drafts')
  assert.equal(calls[0].init.headers.Accept, 'application/json')
  assert.deepEqual(result, [{ id: 7, title: '标题', content: '正文', status: 'ready', draft_type: 'article', updated_at: 'now' }])
})

test('hides error response bodies and rejects malformed payloads', async () => {
  await assert.rejects(fetchDraftCollection(DEFAULT_API_BASE, { fetchImpl: async () => new Response('secret body', { status: 500 }) }), error => {
    return error.code === 'DRAFT_API_UNAVAILABLE' && !error.message.includes('secret body')
  })
  await assert.rejects(fetchDraftCollection(DEFAULT_API_BASE, { fetchImpl: async () => new Response('{}', { status: 200 }) }), { code: 'DRAFT_API_INVALID_RESPONSE' })
})
~~~

- [ ] **Step 6: Run API tests and verify the expected red state**

Run: cd chrome-extension && node --test tests/draft-api.test.js

Expected: FAIL with ERR_MODULE_NOT_FOUND because background/draft-api.js does not exist.

- [ ] **Step 7: Implement API validation and response sanitization**

Use new URL() to allow only http/https, reject credentials/query/hash, strip trailing slashes, and compare the exact base origins against:

~~~js
export const ALLOWED_API_BASES = Object.freeze([
  'http://localhost:8000',
  'http://127.0.0.1:8000',
])
~~~

fetchDraftCollection calls only [apiBase]/write/drafts, sends Accept: application/json and cache: no-store, aborts after 10 seconds, maps network/non-2xx errors to DRAFT_API_UNAVAILABLE, and maps non-array/invalid-id responses to DRAFT_API_INVALID_RESPONSE. It returns exactly the six safe fields and never includes response bodies in errors.

- [ ] **Step 8: Run API tests and verify green**

Run: cd chrome-extension && node --test tests/draft-api.test.js

Expected: all API tests pass.

- [ ] **Step 9: Commit the pure contracts**

~~~bash
git add chrome-extension/content/draft-model.js chrome-extension/background/draft-api.js chrome-extension/tests/draft-model.test.js chrome-extension/tests/draft-api.test.js
git commit -m "feat: add Shuce draft data contracts"
~~~

---

## Task 2: Add service-worker bridge and content API client

**Files:**
- Create: chrome-extension/content/draft-client.js
- Modify: chrome-extension/background/service-worker.js
- Test: chrome-extension/tests/draft-client.test.js

**Interfaces:**
- Message types are SHUCE_DRAFTS_REQUEST, SHUCE_DRAFTS_RESULT, SHUCE_DRAFTS_CONFIG_GET, SHUCE_DRAFTS_CONFIG_SET, and SHUCE_DRAFTS_CONFIG_RESET.
- createDraftClient({ runtime, timeoutMs, randomUUID }) returns fetchDrafts(apiBase), getConfig(), saveConfig(apiBase), and resetConfig().
- Every request carries a generated requestId; the service worker echoes it in both success and failure responses.
- The existing SHUCE_EXECUTION_RECORDED handler and lastExecution storage behavior remain unchanged.

- [ ] **Step 1: Write failing client tests**

~~~js
import assert from 'node:assert/strict'
import test from 'node:test'
import { createDraftClient } from '../content/draft-client.js'

function fakeRuntime(responses) {
  const calls = []
  return { calls, sendMessage(message) { calls.push(message); return Promise.resolve(responses[message.type]) } }
}

test('sends a correlated request and returns drafts', async () => {
  const runtime = fakeRuntime({ SHUCE_DRAFTS_RESULT: { requestId: 'request-1', ok: true, drafts: [{ id: 1 }] } })
  const client = createDraftClient({ runtime, randomUUID: () => 'request-1' })
  assert.deepEqual(await client.fetchDrafts('http://localhost:8000/api'), [{ id: 1 }])
  assert.deepEqual(runtime.calls[0], { type: 'SHUCE_DRAFTS_REQUEST', requestId: 'request-1', apiBase: 'http://localhost:8000/api' })
})

test('maps service-worker errors and timeouts', async () => {
  const runtime = fakeRuntime({ SHUCE_DRAFTS_RESULT: { requestId: 'request-2', ok: false, error: { code: 'DRAFT_API_UNAVAILABLE', message: 'API 暂不可用' } } })
  const client = createDraftClient({ runtime, randomUUID: () => 'request-2' })
  await assert.rejects(client.fetchDrafts('http://localhost:8000/api'), { code: 'DRAFT_API_UNAVAILABLE' })
  const hanging = createDraftClient({ runtime: { sendMessage() { return new Promise(() => {}) } }, randomUUID: () => 'request-3', timeoutMs: 5 })
  await assert.rejects(hanging.fetchDrafts('http://localhost:8000/api'), { code: 'DRAFT_API_UNAVAILABLE' })
})

test('reads, saves, and resets API configuration', async () => {
  const runtime = fakeRuntime({
    SHUCE_DRAFTS_CONFIG_GET: { requestId: 'request-4', ok: true, apiBase: 'http://localhost:8000/api' },
    SHUCE_DRAFTS_CONFIG_SET: { requestId: 'request-5', ok: true, apiBase: 'http://127.0.0.1:8000/api' },
    SHUCE_DRAFTS_CONFIG_RESET: { requestId: 'request-6', ok: true, apiBase: 'http://localhost:8000/api' },
  })
  let id = 4
  const client = createDraftClient({ runtime, randomUUID: () => 'request-' + id++ })
  assert.equal((await client.getConfig()).apiBase, 'http://localhost:8000/api')
  assert.equal((await client.saveConfig('http://127.0.0.1:8000/api')).apiBase, 'http://127.0.0.1:8000/api')
  assert.equal((await client.resetConfig()).apiBase, 'http://localhost:8000/api')
})
~~~

- [ ] **Step 2: Run client tests and verify the expected red state**

Run: cd chrome-extension && node --test tests/draft-client.test.js

Expected: FAIL with ERR_MODULE_NOT_FOUND because content/draft-client.js does not exist.

- [ ] **Step 3: Implement the client request wrapper**

Implement one sendRequest helper that calls runtime.sendMessage, verifies the returned requestId when present, rejects after timeoutMs, and converts { ok: false, error } into an Error carrying the stable code and message. The client must not access fetch, document, cookies, or page-world globals.

- [ ] **Step 4: Run client tests and verify green**

Run: cd chrome-extension && node --test tests/draft-client.test.js

Expected: all client tests pass.

- [ ] **Step 5: Convert the service worker to an MV3 module and add handlers**

Import API helpers from ./draft-api.js. Preserve the existing execution record. Add async handlers with these semantics:

~~~js
if (message.type === 'SHUCE_DRAFTS_REQUEST') {
  const configured = await readConfiguredApiBase()
  const apiBase = message.apiBase || configured
  const drafts = await fetchDraftCollection(apiBase)
  sendResponse({ requestId, ok: true, drafts })
}

if (message.type === 'SHUCE_DRAFTS_CONFIG_SET') {
  const apiBase = assertAllowedApiBase(message.apiBase)
  await chrome.storage.local.set({ [API_BASE_STORAGE_KEY]: apiBase })
  sendResponse({ requestId, ok: true, apiBase })
}
~~~

All async handlers return true. Catch blocks return only safe error code/message maps and the request id. Reset removes the stored value or sets the default; get returns stored/default. Do not log response bodies or write them into lastExecution.

- [ ] **Step 6: Run bridge tests and syntax checks**

Run: cd chrome-extension && node --check background/service-worker.js && node --check background/draft-api.js && npm test

Expected: syntax checks pass and all existing plus new tests are green.

- [ ] **Step 7: Commit the bridge**

~~~bash
git add chrome-extension/content/draft-client.js chrome-extension/background/service-worker.js chrome-extension/tests/draft-client.test.js
git commit -m "feat: bridge Shuce draft API through service worker"
~~~

---

## Task 3: Implement testable workbench state and clipboard behavior

**Files:**
- Create: chrome-extension/content/workbench-state.js
- Create: chrome-extension/content/workbench-clipboard.js
- Test: chrome-extension/tests/workbench.test.js

**Interfaces:**
- createWorkbenchState({ apiBase }) returns state with open, loading, error, drafts, selectedId, query, type, settingsOpen, apiBase, and copyState.
- applyDrafts(state, rawDrafts) normalizes/filters ready drafts and preserves the current selection when possible.
- setWorkbenchFilter, selectDraft, getVisibleDrafts, getSelectedDraft, and setWorkbenchSettingsOpen return new state objects.
- copyText(text, { clipboard, document }) prefers clipboard.writeText, falls back to a textarea, and throws CLIPBOARD_FAILED without including the text.

- [ ] **Step 1: Write failing state and clipboard tests**

~~~js
import assert from 'node:assert/strict'
import test from 'node:test'
import { applyDrafts, createWorkbenchState, getSelectedDraft, getVisibleDrafts, selectDraft, setWorkbenchFilter, setWorkbenchSettingsOpen } from '../content/workbench-state.js'
import { copyText } from '../content/workbench-clipboard.js'

const rawDrafts = [
  { id: 1, title: '文章', content: 'Agent', status: 'ready', draft_type: 'article', updated_at: '2026-08-08T10:00:00Z' },
  { id: 2, title: '帖子', content: 'X', status: 'ready', draft_type: 'x', updated_at: '2026-08-08T11:00:00Z' },
  { id: 3, title: '编辑中', content: '不要展示', status: 'editing', draft_type: 'article', updated_at: '2026-08-08T12:00:00Z' },
]

test('selects newest ready draft and applies filters', () => {
  let state = applyDrafts(createWorkbenchState(), rawDrafts)
  assert.equal(getSelectedDraft(state).id, 2)
  state = setWorkbenchFilter(state, { query: 'Agent' })
  assert.deepEqual(getVisibleDrafts(state).map(draft => draft.id), [1])
  state = setWorkbenchFilter(state, { query: '', type: 'x' })
  assert.deepEqual(getVisibleDrafts(state).map(draft => draft.id), [2])
})

test('preserves selection across refresh and toggles settings', () => {
  let state = selectDraft(applyDrafts(createWorkbenchState(), rawDrafts), 1)
  state = applyDrafts(state, [...rawDrafts].reverse())
  assert.equal(getSelectedDraft(state).id, 1)
  assert.equal(setWorkbenchSettingsOpen(state, true).settingsOpen, true)
})

test('copies without leaking body text on failure', async () => {
  const copied = []
  await copyText('正文\\n第二段', { clipboard: { writeText: async text => copied.push(text) } })
  assert.deepEqual(copied, ['正文\\n第二段'])
  await assert.rejects(copyText('private body', { clipboard: { writeText: async () => { throw new Error('nope') } } }), error => {
    assert.equal(error.code, 'CLIPBOARD_FAILED')
    assert.equal(error.message.includes('private body'), false)
    return true
  })
})
~~~

- [ ] **Step 2: Run workbench tests and verify the expected red state**

Run: cd chrome-extension && node --test tests/workbench.test.js

Expected: FAIL with ERR_MODULE_NOT_FOUND because the state and clipboard modules do not exist.

- [ ] **Step 3: Implement pure transitions and clipboard fallback**

Keep state updates pure. applyDrafts calls selectReadyDrafts, resets error/copyState, and keeps the previous id only if it remains. getVisibleDrafts calls filterDrafts. copyText first calls clipboard.writeText; if unavailable/failing, it creates an off-screen textarea, sets value, selects it, calls document.execCommand('copy'), removes it, and throws the stable error when copying fails.

- [ ] **Step 4: Run workbench tests and verify green**

Run: cd chrome-extension && node --test tests/workbench.test.js

Expected: all state and clipboard tests pass.

- [ ] **Step 5: Commit the UI primitives**

~~~bash
git add chrome-extension/content/workbench-state.js chrome-extension/content/workbench-clipboard.js chrome-extension/tests/workbench.test.js
git commit -m "feat: add Shuce workbench state primitives"
~~~

---

## Task 4: Build the Shadow DOM workbench and bootstrap

**Files:**
- Create: chrome-extension/content/workbench-runtime.js
- Create: chrome-extension/content/workbench.js
- Test: chrome-extension/tests/workbench-bootstrap.test.js

**Interfaces:**
- workbench-runtime.js exports mountWorkbench({ document, window, chromeApi }) and returns { destroy }.
- The classic workbench.js dynamically imports content/workbench-runtime.js through chrome.runtime.getURL() and mounts once per page.
- The runtime creates one Shadow DOM host, one entry button, and one panel; draft data is assigned with textContent/value.

- [ ] **Step 1: Write a failing bootstrap boundary test**

Add a source-level test that reads workbench.js and asserts it dynamically imports chrome.runtime.getURL('content/workbench-runtime.js') and contains no fetch call, document.cookie access, Authorization header, or page-world publish message. Run:

~~~bash
cd chrome-extension && node --test tests/workbench-bootstrap.test.js
~~~

Expected: FAIL because content/workbench.js does not exist yet.

- [ ] **Step 2: Implement the Shadow DOM shell**

Create a fixed high-z-index host with a Shadow Root. The panel structure is:

~~~text
entry -> header(title/count/refresh/settings/close)
      -> left(search/type chips/scrollable list)
      -> right(title/type/time/preformatted body/char count/copy)
      -> inline settings(error/api input/save/reset)
~~~

Use a 760px x 640px panel capped at 90vw/90vh, dark glass background, blue-purple gradient border, cyan selected state, readable high-contrast body, and a bottom full-width layout below 720px. Include loading skeletons, empty state, error/retry state, and no browser alert.

- [ ] **Step 3: Wire loading, filters, selection, copy, and settings**

On mount load config once. On first open and refresh call client.fetchDrafts(apiBase), then applyDrafts and render. Do not start an interval. Wire:

~~~js
searchInput.addEventListener('input', event => {
  state = setWorkbenchFilter(state, { query: event.target.value })
  render()
})

copyButton.addEventListener('click', async () => {
  await copyText(getSelectedDraft(state)?.content ?? '', { document, clipboard: window.navigator.clipboard })
})

saveSettingsButton.addEventListener('click', async () => {
  const config = await client.saveConfig(apiInput.value)
  state = { ...state, apiBase: config.apiBase, settingsOpen: false }
  await loadDrafts()
})
~~~

Use event delegation for rows/chips, keep list and preview independently scrollable, preserve newlines with a pre text node, show Unicode character count, and close on Escape. Stop propagation only inside the workbench.

- [ ] **Step 4: Implement the classic bootstrap**

~~~js
(() => {
  const runtimeUrl = chrome.runtime.getURL('content/workbench-runtime.js')
  import(runtimeUrl)
    .then(({ mountWorkbench }) => mountWorkbench({ document, window, chromeApi: chrome }))
    .catch(error => console.error('述策助手工作台初始化失败', error))
})()
~~~

The bootstrap must contain no API fetch, draft body, credential, or page-world injection logic.

- [ ] **Step 5: Run syntax checks and the bootstrap boundary test**

Run: cd chrome-extension && node --check content/workbench.js && node --check content/workbench-runtime.js && node --check content/workbench-state.js && node --check content/workbench-clipboard.js && node --test tests/workbench-bootstrap.test.js

Expected: all syntax checks and bootstrap assertions pass.

- [ ] **Step 6: Commit the workbench**

~~~bash
git add chrome-extension/content/workbench-runtime.js chrome-extension/content/workbench.js chrome-extension/tests/workbench-bootstrap.test.js
git commit -m "feat: add Shuce floating draft workbench"
~~~

---

## Task 5: Finish Manifest security checks and operator documentation

**Files:**
- Modify: chrome-extension/manifest.json
- Modify: chrome-extension/tests/manifest.test.js
- Modify: chrome-extension/README.md

**Interfaces:**
- Background is { "service_worker": "background/service-worker.js", "type": "module" }.
- Host permissions are exactly the two X hosts plus http://localhost:8000/* and http://127.0.0.1:8000/*.
- Content scripts are content/bridge.js and content/workbench.js.
- Web-accessible resources include existing publisher modules plus workbench runtime/model/client/state/clipboard modules.

- [ ] **Step 1: Make Manifest tests red against the old Manifest**

Expect the exact host/content/background values above. Change the runtime URL assertion to allow only X and the two local API origins while continuing to reject third-party URLs, credentials, and <all_urls>. Run:

~~~bash
cd chrome-extension && node --test tests/manifest.test.js
~~~

Expected: FAIL before the Manifest change.

- [ ] **Step 2: Apply the Manifest changes**

Add local host permissions, set background type to module, add the workbench content script, and expose only the dynamic workbench modules. Do not add a broad match or a new permission beyond existing storage.

- [ ] **Step 3: Run Manifest tests and verify green**

Run: cd chrome-extension && node --test tests/manifest.test.js

Expected: all Manifest/security/documentation assertions pass.

- [ ] **Step 4: Update README**

Keep all existing Shuce.publish() examples. Add a “悬浮发布指挥台” section explaining the default API http://localhost:8000/api, the 127.0.0.1 alternative, reload steps, ready-only behavior, all draft types, search/type filters, copy-only behavior, settings save/reset, and retryable API outage state. State explicitly that draft bodies remain in page memory, no credentials are read, and remote URLs are outside this MVP.

- [ ] **Step 5: Commit Manifest and docs**

~~~bash
git add chrome-extension/manifest.json chrome-extension/tests/manifest.test.js chrome-extension/README.md
git commit -m "docs: document Shuce draft workbench"
~~~

---

## Task 6: Full verification and handoff

**Files:**
- Verify: all files under chrome-extension/

- [ ] **Step 1: Run the complete extension test suite**

Run: cd chrome-extension && npm test

Expected: every test file passes with zero failures.

- [ ] **Step 2: Check every runtime JavaScript file**

Run:

~~~bash
cd chrome-extension
find background content injected -name '*.js' -print0 | xargs -0 -n1 node --check
~~~

Expected: every syntax check exits successfully.

- [ ] **Step 3: Run whitespace and security checks**

Run: git diff --check HEAD~5..HEAD

Expected: no output. The Manifest tests are authoritative for rejecting third-party URLs, credentials, and <all_urls>; report any shell-regex limitation rather than treating an unexecuted check as passed.

- [ ] **Step 4: Inspect final branch state**

Run: git status --short --branch and git log --oneline --decorate -8.

Expected: only intentional feature commits exist on feature/shuce-floating-draft-workbench; the main worktree's unrelated changes remain untouched.

- [ ] **Step 5: Provide manual Chrome acceptance steps**

Report the exact extension path and reload steps. Verify: the entry appears on X; only status=ready article/X/unknown types appear; search/type filters work; rows and preview scroll independently; Markdown remains plain text; copy succeeds; settings save/reset works; and API outage shows an inline retryable error without breaking X.
