# 述策助手 Chrome Side Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 Chrome 原生 Side Panel 完全替代 X 页悬浮指挥台，并保留安排表记忆、草稿预览和发布标记。

**Architecture:** 边栏页 `sidepanel/index.html` 挂载现有 `mountWorkbench({ surface: 'sidepanel' })`。service worker 只在 x.com / twitter.com 启用边栏，并把安排表消息转给当前窗口活动的 X 标签。X 页 content script 只跑 `createScheduleMemory`，不再插入悬浮 DOM。

**Tech Stack:** Chrome Manifest V3 `sidePanel`、原生 ESM、Node `node:test`、jsdom、Playwright。

## Global Constraints

- 不改后端草稿接口、发布语义或安排表 localStorage 键。
- 不在 `tabs.onUpdated` 里调用 `sidePanel.open()`；首次打开只来自工具栏点击。
- 不增加 `tabs` 权限，不使用 `<all_urls>`，不读 Cookie / Token。
- 不引入 React、构建工具或第三方 UI 库。
- `surface` 只允许 `'sidepanel'`；删除悬浮入口、关闭按钮和页面 Shadow 宿主。
- 布局合法值只有 `'stack'` 和 `'split'`；存储键为 `shuceWorkbenchLayout`。
- 每个生产模块先写会失败的行为测试，再写最小实现。

## File map

- Create: `chrome-extension/background/x-site.js` — `isXSiteUrl`
- Create: `chrome-extension/content/schedule-bridge.js` — 安排表消息类型、边栏客户端、X 页 host
- Create: `chrome-extension/sidepanel/index.html`
- Create: `chrome-extension/sidepanel/main.js`
- Create: `chrome-extension/icons/icon-16.png`, `icon-32.png`, `icon-48.png`
- Modify: `chrome-extension/background/service-worker.js` — 按站点开关边栏、转发安排表消息
- Modify: `chrome-extension/content/workbench-state.js` — `layout` 状态
- Modify: `chrome-extension/content/workbench-runtime.js` — 边栏表面、布局切换、安排表客户端
- Modify: `chrome-extension/content/workbench.js` — 只启动安排表 host
- Modify: `chrome-extension/manifest.json`
- Modify: `chrome-extension/README.md`
- Test: `chrome-extension/tests/x-site.test.js`
- Test: `chrome-extension/tests/schedule-bridge.test.js`
- Test: `chrome-extension/tests/workbench.test.js`
- Test: `chrome-extension/tests/manifest.test.js`
- Test: `chrome-extension/tests/workbench-bootstrap.test.js`
- Test: `wemedia-studio/e2e/extension-workbench-layout.spec.ts`

---

### Task 1: X 站点判定

**Files:**
- Create: `chrome-extension/background/x-site.js`
- Test: `chrome-extension/tests/x-site.test.js`

**Interfaces:**
- Produces `isXSiteUrl(value): boolean`。只接受 `https:`，host 为 `x.com`、`www.x.com`、`twitter.com`、`www.twitter.com`。空值、相对路径、`http:`、其他 host 都返回 `false`。

- [ ] **Step 1: Write the failing tests**

```js
import assert from 'node:assert/strict'
import test from 'node:test'

import { isXSiteUrl } from '../background/x-site.js'

test('accepts https X and Twitter hosts including www', () => {
  assert.equal(isXSiteUrl('https://x.com/home'), true)
  assert.equal(isXSiteUrl('https://www.x.com/i/status/1'), true)
  assert.equal(isXSiteUrl('https://twitter.com/compose/post'), true)
  assert.equal(isXSiteUrl('https://www.twitter.com/'), true)
})

test('rejects missing, http, and non-X hosts', () => {
  assert.equal(isXSiteUrl(undefined), false)
  assert.equal(isXSiteUrl(''), false)
  assert.equal(isXSiteUrl('http://x.com/home'), false)
  assert.equal(isXSiteUrl('https://notx.com/'), false)
  assert.equal(isXSiteUrl('https://evilx.com/'), false)
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd chrome-extension && node --test tests/x-site.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` because `background/x-site.js` does not exist.

- [ ] **Step 3: Implement the helper**

```js
const X_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'])

export function isXSiteUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && X_HOSTS.has(url.hostname)
  } catch {
    return false
  }
}
```

- [ ] **Step 4: Re-run the tests**

Run: `cd chrome-extension && node --test tests/x-site.test.js`

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add chrome-extension/background/x-site.js chrome-extension/tests/x-site.test.js
git commit -m "feat: detect X site URLs for the side panel"
```

---

### Task 2: 安排表消息桥

**Files:**
- Create: `chrome-extension/content/schedule-bridge.js`
- Test: `chrome-extension/tests/schedule-bridge.test.js`

**Interfaces:**
- Produces `SCHEDULE_MESSAGE_TYPES = { GET: 'SHUCE_SCHEDULE_GET', SET_AUTOFILL: 'SHUCE_SCHEDULE_SET_AUTOFILL', CHANGED: 'SHUCE_SCHEDULE_CHANGED', RESULT: 'SHUCE_SCHEDULE_RESULT' }`
- Produces `emptyScheduleSnapshot(): { selection: null, autoFillEnabled: false, available: false }`
- Produces `createScheduleClient({ runtime, randomUUID, timeoutMs }): { getSnapshot(), setAutoFillEnabled(enabled), subscribe(onChange), destroy() }`
- Produces `handleScheduleHostMessage(message, memory): object | null`。`GET` 返回当前 snapshot；`SET_AUTOFILL` 调用 `memory.setAutoFillEnabled` 后返回新 snapshot。其他 type 返回 `null`。
- Produces `async function resolveActiveXTab(queryTabs, isXSiteUrl): Promise<tab | null>`。查询 `{ active: true, currentWindow: true }`，只返回 URL 为 X 的活动标签。
- Produces `async function routeScheduleRequest(message, { queryTabs, sendToTab, isXSiteUrl }): Promise<object>`。没有 X 标签时返回 `{ ok: true, ...emptyScheduleSnapshot() }`，不抛错。

- [ ] **Step 1: Write the failing tests**

```js
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SCHEDULE_MESSAGE_TYPES,
  createScheduleClient,
  emptyScheduleSnapshot,
  handleScheduleHostMessage,
  resolveActiveXTab,
  routeScheduleRequest,
} from '../content/schedule-bridge.js'

test('host returns stored schedule and writes autofill', () => {
  const memory = {
    selection: { year: '2026', month: '8', day: '13', hour: '10', minute: '05' },
    autoFillEnabled: false,
    readStored() { return this.selection },
    readAutoFillEnabled() { return this.autoFillEnabled },
    setAutoFillEnabled(enabled) { this.autoFillEnabled = enabled === true },
  }

  assert.deepEqual(
    handleScheduleHostMessage({ type: SCHEDULE_MESSAGE_TYPES.GET }, memory),
    {
      type: SCHEDULE_MESSAGE_TYPES.RESULT,
      ok: true,
      selection: memory.selection,
      autoFillEnabled: false,
      available: true,
    },
  )
  assert.deepEqual(
    handleScheduleHostMessage({ type: SCHEDULE_MESSAGE_TYPES.SET_AUTOFILL, enabled: true }, memory),
    {
      type: SCHEDULE_MESSAGE_TYPES.RESULT,
      ok: true,
      selection: memory.selection,
      autoFillEnabled: true,
      available: true,
    },
  )
  assert.equal(handleScheduleHostMessage({ type: 'OTHER' }, memory), null)
})

test('router returns an empty snapshot when no active X tab exists', async () => {
  const result = await routeScheduleRequest(
    { type: SCHEDULE_MESSAGE_TYPES.GET, requestId: 'r1' },
    {
      queryTabs: async () => [{ id: 4, url: 'https://example.com/' }],
      sendToTab: async () => { throw new Error('should not send') },
      isXSiteUrl: url => url.includes('x.com'),
    },
  )
  assert.deepEqual(result, {
    type: SCHEDULE_MESSAGE_TYPES.RESULT,
    requestId: 'r1',
    ok: true,
    ...emptyScheduleSnapshot(),
  })
})

test('router forwards GET to the active X tab', async () => {
  const sent = []
  const result = await routeScheduleRequest(
    { type: SCHEDULE_MESSAGE_TYPES.GET, requestId: 'r2' },
    {
      queryTabs: async query => {
        assert.deepEqual(query, { active: true, currentWindow: true })
        return [{ id: 9, url: 'https://x.com/home' }]
      },
      sendToTab: async (tabId, message) => {
        sent.push({ tabId, message })
        return {
          type: SCHEDULE_MESSAGE_TYPES.RESULT,
          ok: true,
          selection: { year: '2026', month: '8', day: '13', hour: '11', minute: '00' },
          autoFillEnabled: true,
          available: true,
        }
      },
      isXSiteUrl: url => url.includes('x.com'),
    },
  )
  assert.equal(sent[0].tabId, 9)
  assert.equal(result.available, true)
  assert.equal(result.autoFillEnabled, true)
})

test('resolveActiveXTab returns only the active X tab', async () => {
  assert.equal(
    await resolveActiveXTab(
      async () => [{ id: 1, url: 'https://example.com/' }],
      url => url.includes('x.com'),
    ),
    null,
  )
  assert.deepEqual(
    await resolveActiveXTab(
      async () => [{ id: 9, url: 'https://x.com/home' }],
      url => url.includes('x.com'),
    ),
    { id: 9, url: 'https://x.com/home' },
  )
})

test('client reads and writes through the runtime channel', async () => {
  const calls = []
  const runtime = {
    sendMessage(message) {
      calls.push(message)
      return Promise.resolve({
        type: SCHEDULE_MESSAGE_TYPES.RESULT,
        requestId: message.requestId,
        ok: true,
        selection: null,
        autoFillEnabled: message.enabled === true,
        available: false,
      })
    },
    onMessage: { addListener() {}, removeListener() {} },
  }
  const client = createScheduleClient({ runtime, randomUUID: () => 'fixed' })
  assert.deepEqual(await client.getSnapshot(), {
    selection: null,
    autoFillEnabled: false,
    available: false,
  })
  assert.equal((await client.setAutoFillEnabled(true)).autoFillEnabled, true)
  assert.equal(calls[0].type, SCHEDULE_MESSAGE_TYPES.GET)
  assert.equal(calls[1].type, SCHEDULE_MESSAGE_TYPES.SET_AUTOFILL)
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd chrome-extension && node --test tests/schedule-bridge.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the bridge**

Keep the module free of `chrome.*` globals. `routeScheduleRequest` must:

1. `const tab = await resolveActiveXTab(queryTabs, isXSiteUrl)`
2. 若没有 tab，返回 `{ type: RESULT, requestId, ok: true, ...emptyScheduleSnapshot() }`
3. 否则 `const response = await sendToTab(tab.id, message)`；若 response 不是对象，同样回退到 empty snapshot。

`createScheduleClient.getSnapshot` / `setAutoFillEnabled` 复用与 `draft-client` 相同的 `requestId` + timeout 模式，但 timeout 失败时返回 `emptyScheduleSnapshot()`，不要抛给边栏致命错误。

- [ ] **Step 4: Re-run the tests**

Run: `cd chrome-extension && node --test tests/schedule-bridge.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add chrome-extension/content/schedule-bridge.js chrome-extension/tests/schedule-bridge.test.js
git commit -m "feat: bridge side-panel schedule messages to the X tab"
```

---

### Task 3: 工作台布局状态

**Files:**
- Modify: `chrome-extension/content/workbench-state.js`
- Modify: `chrome-extension/tests/workbench.test.js`

**Interfaces:**
- Produces `WORKBENCH_LAYOUT_STORAGE_KEY = 'shuceWorkbenchLayout'`
- Produces `normalizeWorkbenchLayout(value): 'stack' | 'split'`。只有 `'split'` 返回 `'split'`，其他一律 `'stack'`。
- Produces `setWorkbenchLayout(state, layout)`，返回新 state，`layout` 已 normalize。
- `createWorkbenchState()` 增加 `layout: 'stack'`。

- [ ] **Step 1: Write the failing tests**

在 `workbench.test.js` 增加：

```js
import {
  WORKBENCH_LAYOUT_STORAGE_KEY,
  createWorkbenchState,
  normalizeWorkbenchLayout,
  setWorkbenchLayout,
} from '../content/workbench-state.js'

test('normalizes and stores stack or split layout', () => {
  assert.equal(WORKBENCH_LAYOUT_STORAGE_KEY, 'shuceWorkbenchLayout')
  assert.equal(normalizeWorkbenchLayout('split'), 'split')
  assert.equal(normalizeWorkbenchLayout('stack'), 'stack')
  assert.equal(normalizeWorkbenchLayout('weird'), 'stack')
  assert.equal(createWorkbenchState().layout, 'stack')
  assert.equal(setWorkbenchLayout(createWorkbenchState(), 'split').layout, 'split')
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd chrome-extension && node --test tests/workbench.test.js`

Expected: FAIL because `normalizeWorkbenchLayout` / `setWorkbenchLayout` are not exported.

- [ ] **Step 3: Implement the layout helpers**

```js
export const WORKBENCH_LAYOUT_STORAGE_KEY = 'shuceWorkbenchLayout'

export function normalizeWorkbenchLayout(value) {
  return value === 'split' ? 'split' : 'stack'
}

export function setWorkbenchLayout(state, layout) {
  return { ...state, layout: normalizeWorkbenchLayout(layout) }
}
```

Add `layout: 'stack'` to `createWorkbenchState`.

- [ ] **Step 4: Re-run the workbench tests**

Run: `cd chrome-extension && node --test tests/workbench.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add chrome-extension/content/workbench-state.js chrome-extension/tests/workbench.test.js
git commit -m "feat: add stack and split workbench layouts"
```

---

### Task 4: service worker 按站点开关并转发安排表

**Files:**
- Modify: `chrome-extension/background/service-worker.js`
- Test: `chrome-extension/tests/side-panel.test.js`

**Interfaces:**
- Consumes `isXSiteUrl` from Task 1 和 `routeScheduleRequest` / `SCHEDULE_MESSAGE_TYPES` from Task 2。
- Produces `sidePanelOptionsForUrl(url): { path: 'sidepanel/index.html', enabled: boolean }`。
- Produces `async function syncSidePanelForTab(tabId, url, sidePanel)`，内部调用 `sidePanel.setOptions({ tabId, ...sidePanelOptionsForUrl(url) })`。
- service worker 启动时调用 `setPanelBehavior({ openPanelOnActionClick: true })` 和 `setOptions({ enabled: false })`。
- 监听 `tabs.onUpdated`、`tabs.onActivated`；**禁止**调用 `sidePanel.open()`。
- `onMessage` 增加 `SHUCE_SCHEDULE_GET` / `SHUCE_SCHEDULE_SET_AUTOFILL`，用 `chrome.tabs.query` + `chrome.tabs.sendMessage` 走 `routeScheduleRequest`。

- [ ] **Step 1: Write the failing tests**

```js
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { sidePanelOptionsForUrl } from '../background/service-worker.js'

test('enables the side panel only on X tabs', () => {
  assert.deepEqual(sidePanelOptionsForUrl('https://x.com/home'), {
    path: 'sidepanel/index.html',
    enabled: true,
  })
  assert.deepEqual(sidePanelOptionsForUrl('https://github.com/'), {
    path: 'sidepanel/index.html',
    enabled: false,
  })
  assert.equal(sidePanelOptionsForUrl(undefined).enabled, false)
})

test('wires site gating and schedule routing without auto-opening', async () => {
  const source = await readFile(new URL('../background/service-worker.js', import.meta.url), 'utf8')
  assert.match(source, /setPanelBehavior\(\{ openPanelOnActionClick: true \}\)/)
  assert.match(source, /tabs\.onUpdated/)
  assert.match(source, /tabs\.onActivated/)
  assert.match(source, /SHUCE_SCHEDULE_GET/)
  assert.match(source, /routeScheduleRequest/)
  assert.doesNotMatch(source, /sidePanel\.open\(/)
})
```

Export `sidePanelOptionsForUrl` from `service-worker.js`. If importing the worker executes `chrome.*` listeners, wrap the chrome wiring in `if (globalThis.chrome?.sidePanel)` so Node tests can import the pure helper. The source-match test still covers the real wiring.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd chrome-extension && node --test tests/side-panel.test.js`

Expected: FAIL because the export / wiring does not exist.

- [ ] **Step 3: Implement the worker changes**

At the top of `service-worker.js` add imports for `isXSiteUrl`, `routeScheduleRequest`, and `SCHEDULE_MESSAGE_TYPES`.

```js
export function sidePanelOptionsForUrl(url) {
  return {
    path: 'sidepanel/index.html',
    enabled: isXSiteUrl(url),
  }
}

export async function syncSidePanelForTab(tabId, url, sidePanel = globalThis.chrome?.sidePanel) {
  if (!sidePanel || !Number.isInteger(tabId)) return
  await sidePanel.setOptions({ tabId, ...sidePanelOptionsForUrl(url) })
}
```

In the chrome-only bootstrap:

```js
if (globalThis.chrome?.sidePanel) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})
  chrome.sidePanel.setOptions({ enabled: false }).catch(() => {})
  chrome.tabs.onUpdated.addListener((tabId, _info, tab) => {
    void syncSidePanelForTab(tabId, tab?.url)
  })
  chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    const tab = await chrome.tabs.get(tabId).catch(() => null)
    void syncSidePanelForTab(tabId, tab?.url)
  })
}
```

Extend `onMessage` so schedule GET/SET types call:

```js
return routeScheduleRequest(message, {
  queryTabs: query => chrome.tabs.query(query),
  sendToTab: (tabId, payload) => chrome.tabs.sendMessage(tabId, payload),
  isXSiteUrl,
})
```

Keep existing draft message handling unchanged.

- [ ] **Step 4: Re-run side-panel and existing worker-related tests**

Run: `cd chrome-extension && node --test tests/side-panel.test.js tests/draft-api.test.js tests/manifest.test.js`

Expected: side-panel tests PASS. `manifest.test.js` may still fail until Task 6; that is OK if the only failures are missing `sidePanel` / `action`. If `manifest.test.js` fails for unrelated reasons, fix now.

- [ ] **Step 5: Commit**

```bash
git add chrome-extension/background/service-worker.js chrome-extension/tests/side-panel.test.js
git commit -m "feat: enable the side panel only on X tabs"
```

---

### Task 5: 把指挥台改成边栏表面

**Files:**
- Modify: `chrome-extension/content/workbench-runtime.js`
- Modify: `chrome-extension/tests/workbench.test.js`
- Modify: `chrome-extension/tests/workbench-bootstrap.test.js`

**Interfaces:**
- Consumes `setWorkbenchLayout` / `WORKBENCH_LAYOUT_STORAGE_KEY` from Task 3，`createScheduleClient` from Task 2。
- `mountWorkbench({ document, window, chromeApi, surface })` 在 `surface !== 'sidepanel'` 时直接 `return { destroy() {} }`，不挂 DOM。
- 不再创建 `#shuce-floating-draft-workbench`、Shadow Root、`.sw-entry`、关闭按钮。
- 把 `.sw-root` 直接挂到 `document.body`，铺满视口；`.sw-panel` 不再 `hidden`。
- 增加 `data-action="layout"` 按钮，标题在「左右布局」/「上下布局」间切换。
- `state.layout` 写入 `root.dataset.layout`；`.sw-body[data-layout="stack"]` 为上列表下预览，`.sw-body[data-layout="split"]` 为左列表右预览。
- 启动时 `chromeApi.storage.local.get(WORKBENCH_LAYOUT_STORAGE_KEY)`；切换时 `set`，失败只影响持久化。
- 安排表改用 `createScheduleClient`：`getSnapshot()` 填「上次安排」和复选框；`available === false` 时复选框 `disabled`；`subscribe` 接收 `SHUCE_SCHEDULE_CHANGED`。
- 删除 Esc 关面板和 `togglePanel`。

- [ ] **Step 1: Update the failing surface tests**

Replace the overlay-position test in `workbench-bootstrap.test.js` with:

```js
test('keeps the content-script bootstrap limited to the extension runtime boundary', async () => {
  const source = await readFile(resolve(extensionRoot, 'content/workbench.js'), 'utf8')
  assert.match(source, /chrome\.runtime\.getURL\(['"]content\/schedule-host\.js['"]\)/)
  assert.doesNotMatch(source, /workbench-runtime\.js/)
  assert.doesNotMatch(source, /\bfetch\s*\(/)
})

test('mounts the workbench as a full-viewport side panel', async () => {
  const source = await readFile(resolve(extensionRoot, 'content/workbench-runtime.js'), 'utf8')
  assert.match(source, /surface !== ['"]sidepanel['"]/)
  assert.doesNotMatch(source, /shuce-floating-draft-workbench/)
  assert.doesNotMatch(source, /data-action="toggle"/)
  assert.doesNotMatch(source, /data-action="close"/)
  assert.match(source, /data-action="layout"/)
  assert.match(source, /createScheduleClient/)
})
```

`workbench.js` / `schedule-host.js` 还没改时，这个测试会红。先只改 `workbench-runtime` 相关断言，把 bootstrap 里对 `workbench-runtime.js` 的引用断言留到 Task 6。在本任务中，把 `workbench-bootstrap.test.js` 的「anchors the command center」改成检查边栏 CSS：

```js
assert.match(source, /\.sw-root \{[^}]*inset: 0/s)
assert.match(source, /data-layout/)
assert.doesNotMatch(source, /\.sw-entry \{[^}]*right: 24px; top: 24px;/s)
```

在 `workbench.test.js` 增加：

```js
test('exposes a persisted layout toggle in the side panel runtime', async () => {
  const source = await readFile(new URL('../content/workbench-runtime.js', import.meta.url), 'utf8')
  assert.match(source, /WORKBENCH_LAYOUT_STORAGE_KEY/)
  assert.match(source, /setWorkbenchLayout/)
  assert.match(source, /data-action="layout"/)
})
```

- [ ] **Step 2: Run the runtime tests and confirm the new assertions fail**

Run: `cd chrome-extension && node --test tests/workbench.test.js tests/workbench-bootstrap.test.js`

Expected: FAIL on missing layout toggle / remaining overlay selectors.

- [ ] **Step 3: Rewrite the runtime chrome**

Required structural changes in `STATIC_UI`:

- 删除 `.sw-entry` 整块和关闭按钮。
- `.sw-root` 改为 `position: fixed; inset: 0; pointer-events: auto;`，不再创建高层级悬浮宿主。
- `.sw-panel` 改为 `position: absolute; inset: 0; width: auto; height: auto; max-width: none; max-height: none; border-radius: 0;`，去掉 `[hidden]` 依赖。
- `.sw-body` 默认 `grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(180px, 38%) minmax(0, 1fr);`
- 增加：

```css
.sw-body[data-layout="split"] { grid-template-columns: minmax(140px, 38%) minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); }
.sw-body[data-layout="stack"] { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(180px, 38%) minmax(0, 1fr); }
.sw-body[data-layout="stack"] .sw-sidebar { border-right: 0; border-bottom: 1px solid rgba(148, 163, 184, .14); }
```

- 在 `.sw-actions` 里加入 `<button class="sw-icon-button" type="button" data-action="layout" title="左右布局" aria-label="左右布局">☰</button>`。`title` 和 `aria-label` 在 `stack` 时为「左右布局」，在 `split` 时为「上下布局」。

`mountWorkbench` 开头：

```js
if (surface !== 'sidepanel') return { destroy() {} }
```

挂载：

```js
const root = document.createElement('div')
root.className = 'sw-root'
root.innerHTML = STATIC_UI
document.body.appendChild(root)
const query = selector => root.querySelector(selector)
```

`render()` 里：

```js
root.dataset.layout = state.layout
query('[data-role="body"]').dataset.layout = state.layout
layoutButton.title = state.layout === 'split' ? '上下布局' : '左右布局'
panel.hidden = false
```

给 `.sw-body` 加上 `data-role="body"`。

安排表：

```js
const scheduleClient = createScheduleClient({ runtime: chromeApi.runtime })
let scheduleSnapshot = emptyScheduleSnapshot()

async function refreshSchedule() {
  scheduleSnapshot = await scheduleClient.getSnapshot()
  renderLastSchedule(scheduleSnapshot.selection)
  autoSchedule.checked = scheduleSnapshot.autoFillEnabled === true
  autoSchedule.disabled = scheduleSnapshot.available !== true
}

scheduleClient.subscribe(snapshot => {
  scheduleSnapshot = snapshot
  renderLastSchedule(snapshot.selection)
  autoSchedule.checked = snapshot.autoFillEnabled === true
  autoSchedule.disabled = snapshot.available !== true
})
```

复选框 change：

```js
autoSchedule.addEventListener('change', () => {
  void scheduleClient.setAutoFillEnabled(autoSchedule.checked).then(refreshSchedule)
})
```

布局按钮：

```js
query('[data-action="layout"]').addEventListener('click', () => {
  state = setWorkbenchLayout(state, state.layout === 'split' ? 'stack' : 'split')
  render()
  void chromeApi.storage?.local?.set?.({
    [WORKBENCH_LAYOUT_STORAGE_KEY]: state.layout,
  }).catch?.(() => {})
})
```

`initialize` 先读 storage：

```js
try {
  const stored = await chromeApi.storage?.local?.get?.(WORKBENCH_LAYOUT_STORAGE_KEY)
  state = setWorkbenchLayout(state, stored?.[WORKBENCH_LAYOUT_STORAGE_KEY])
} catch {}
await refreshSchedule()
```

删除 `entry`、`togglePanel`、Esc 关面板和 `createScheduleMemory` 本地实例。`destroy` 移除 `root` 并 `scheduleClient.destroy()`。

- [ ] **Step 4: Re-run runtime tests**

Run: `cd chrome-extension && node --test tests/workbench.test.js tests/workbench-bootstrap.test.js tests/workbench-clipboard.test.js`

Expected: PASS. 若 bootstrap 仍断言 `workbench.js` 加载 `workbench-runtime.js`，先把那条断言改成「本任务不改 workbench.js」，保留到 Task 6。

- [ ] **Step 5: Commit**

```bash
git add chrome-extension/content/workbench-runtime.js chrome-extension/tests/workbench.test.js chrome-extension/tests/workbench-bootstrap.test.js
git commit -m "feat: render the draft workbench as a side panel"
```

---

### Task 6: 边栏页面、图标、manifest 和瘦身 content script

**Files:**
- Create: `chrome-extension/sidepanel/index.html`
- Create: `chrome-extension/sidepanel/main.js`
- Create: `chrome-extension/content/schedule-host.js`
- Create: `chrome-extension/icons/icon-16.png`
- Create: `chrome-extension/icons/icon-32.png`
- Create: `chrome-extension/icons/icon-48.png`
- Modify: `chrome-extension/content/workbench.js`
- Modify: `chrome-extension/manifest.json`
- Modify: `chrome-extension/tests/manifest.test.js`
- Modify: `chrome-extension/tests/workbench-bootstrap.test.js`

**Interfaces:**
- `sidepanel/main.js` 只调用 `mountWorkbench({ document, window, chromeApi: chrome, surface: 'sidepanel' })`。
- `startScheduleHost({ document, window, chromeApi })` 创建 `createScheduleMemory`，在 `onChange` 时 `runtime.sendMessage({ type: CHANGED, selection, autoFillEnabled, available: true })`，并监听 GET/SET。
- `workbench.js` 改为 `import(chrome.runtime.getURL('content/schedule-host.js'))`。
- Manifest 增加 `sidePanel` 权限、`action.default_title = '述策发布指挥台'`、`action.default_icon`、`icons`、`side_panel.default_path = 'sidepanel/index.html'`。
- `web_accessible_resources` 只保留 content script 仍动态 import 的模块：`content/schedule-host.js`、`content/schedule-bridge.js`、`content/schedule-memory.js`、`content/selectors.js`。不要再列出 `workbench-runtime.js`。

- [ ] **Step 1: Update manifest and bootstrap tests first**

`manifest.test.js` 增加：

```js
assert.ok(manifest.permissions.includes('sidePanel'))
assert.equal(manifest.action.default_title, '述策发布指挥台')
assert.equal(manifest.side_panel.default_path, 'sidepanel/index.html')
assert.deepEqual(manifest.action.default_icon, {
  16: 'icons/icon-16.png',
  32: 'icons/icon-32.png',
  48: 'icons/icon-48.png',
})
assert.equal(manifest.permissions.includes('tabs'), false)
assert.deepEqual(manifest.web_accessible_resources[0].resources.sort(), [
  'content/schedule-bridge.js',
  'content/schedule-host.js',
  'content/schedule-memory.js',
  'content/selectors.js',
])
```

把 README 断言里的 `悬浮发布指挥台` 留到 Task 7。本任务若 README 测试失败，先不要改 README 语义，只保证 manifest 测试按新合同写。

`workbench-bootstrap.test.js` 的 content-script 测试改成 Task 5 里最终版本。

- [ ] **Step 2: Run those tests and confirm they fail**

Run: `cd chrome-extension && node --test tests/manifest.test.js tests/workbench-bootstrap.test.js`

Expected: FAIL on missing `sidePanel` / old WAR list / old workbench.js import.

- [ ] **Step 3: Implement the page, host, icons, and manifest**

`chrome-extension/sidepanel/index.html`:

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <title>述策发布指挥台</title>
    <style>
      html, body { width: 100%; height: 100%; margin: 0; background: #0b1020; }
    </style>
  </head>
  <body>
    <script type="module" src="./main.js"></script>
  </body>
</html>
```

`chrome-extension/sidepanel/main.js`:

```js
import { mountWorkbench } from '../content/workbench-runtime.js'

mountWorkbench({
  document,
  window,
  chromeApi: chrome,
  surface: 'sidepanel',
})
```

`chrome-extension/content/schedule-host.js`:

```js
import { createScheduleMemory } from './schedule-memory.js'
import {
  SCHEDULE_MESSAGE_TYPES,
  handleScheduleHostMessage,
} from './schedule-bridge.js'

export function startScheduleHost({ document, window, chromeApi = globalThis.chrome }) {
  const runtime = chromeApi?.runtime
  const memory = createScheduleMemory({
    document,
    window,
    onChange(selection) {
      runtime?.sendMessage?.({
        type: SCHEDULE_MESSAGE_TYPES.CHANGED,
        selection,
        autoFillEnabled: memory.readAutoFillEnabled(),
        available: true,
      })
    },
  })
  memory.start()

  runtime?.onMessage?.addListener((message, _sender, sendResponse) => {
    const result = handleScheduleHostMessage(message, memory)
    if (!result) return false
    sendResponse(result)
    return true
  })

  return {
    destroy() {
      memory.stop()
    },
  }
}
```

`workbench.js`:

```js
(() => {
  const hostUrl = chrome.runtime.getURL('content/schedule-host.js')
  import(hostUrl)
    .then(({ startScheduleHost }) => startScheduleHost({ document, window, chromeApi: chrome }))
    .catch(error => console.error('述策助手安排表初始化失败', error))
})()
```

生成三个简单 PNG 图标（16/32/48），深色底 + 青色方标即可，不要引入图片依赖。可用这段脚本写入文件：

```bash
python3 - <<'PY'
from pathlib import Path
import struct, zlib

def png(size, rgb=(103, 232, 249)):
    raw = b''.join(b'\x00' + bytes(rgb) * size for _ in range(size))
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')

root = Path('chrome-extension/icons')
root.mkdir(parents=True, exist_ok=True)
for size in (16, 32, 48):
    (root / f'icon-{size}.png').write_bytes(png(size))
PY
```

`manifest.json` 按 Interfaces 更新。

- [ ] **Step 4: Re-run extension unit tests**

Run: `cd chrome-extension && node --test tests/*.test.js`

Expected: 除 README 文案断言外全部 PASS。若 README 测试仍要求「悬浮发布指挥台」，下一步马上改文档。

- [ ] **Step 5: Commit**

```bash
git add chrome-extension/sidepanel chrome-extension/content/schedule-host.js chrome-extension/content/workbench.js chrome-extension/manifest.json chrome-extension/icons chrome-extension/tests/manifest.test.js chrome-extension/tests/workbench-bootstrap.test.js
git commit -m "feat: ship the X-only Chrome side panel shell"
```

---

### Task 7: 端到端布局、README 和回归

**Files:**
- Modify: `wemedia-studio/e2e/extension-workbench-layout.spec.ts`
- Modify: `chrome-extension/README.md`
- Modify: `chrome-extension/tests/manifest.test.js` 里的 README 断言

**Interfaces:**
- e2e 直接打开 `sidepanel/index.html` 的 harness，不再点击「发布指挥台」。
- 覆盖 stack 默认和切换到 split：列表与预览都可见，footer 的复制/发布不被挤出，图片仍是 `data:image/png;base64,`。
- README 写明：指挥台在浏览器 Side Panel；首次要点工具栏图标；离开 X 边栏关闭；安排表仍在 X 页 localStorage。

- [ ] **Step 1: Rewrite the Playwright harness**

把 `harnessHtml()` 改成加载真实边栏入口，而不是页面里的悬浮台：

```ts
function harnessHtml() {
  return `<!doctype html>
<html lang="zh-CN">
  <head><meta charset="utf-8"><title>述策发布指挥台</title></head>
  <body>
    <script type="module">
      import { mountWorkbench } from '/content/workbench-runtime.js'
      const draft = ${JSON.stringify({
        id: 901,
        title: '超长文章布局验证',
        content: longArticle,
        status: 'ready',
        draft_type: 'article',
        updated_at: '2026-08-13T00:00:00Z',
      })}
      const storage = new Map()
      const chromeApi = {
        runtime: {
          sendMessage: async message => {
            if (message.type === 'SHUCE_DRAFTS_CONFIG_GET') {
              return { type: 'SHUCE_DRAFTS_RESULT', requestId: message.requestId, ok: true, apiBase: 'http://localhost:8000/api' }
            }
            if (message.type === 'SHUCE_DRAFTS_REQUEST') {
              return { type: 'SHUCE_DRAFTS_RESULT', requestId: message.requestId, ok: true, drafts: [draft] }
            }
            if (message.type === 'SHUCE_DRAFT_IMAGE_REQUEST') {
              return { type: 'SHUCE_DRAFTS_RESULT', requestId: message.requestId, ok: true, dataUrl: 'data:image/png;base64,' + ${JSON.stringify(testPng.toString('base64'))} }
            }
            if (message.type === 'SHUCE_SCHEDULE_GET' || message.type === 'SHUCE_SCHEDULE_SET_AUTOFILL') {
              return { type: 'SHUCE_SCHEDULE_RESULT', requestId: message.requestId, ok: true, selection: null, autoFillEnabled: false, available: false }
            }
            throw new Error('Unexpected extension message: ' + message.type)
          },
          onMessage: { addListener() {}, removeListener() {} },
        },
        storage: {
          local: {
            async get(key) { return { [key]: storage.get(key) } },
            async set(values) { Object.entries(values).forEach(([key, value]) => storage.set(key, value)) },
          },
        },
      }
      window.__workbench = mountWorkbench({ document, window, chromeApi, surface: 'sidepanel' })
    </script>
  </body>
</html>`
}
```

测试体改成：

```ts
await page.setViewportSize({ width: 360, height: 800 })
await page.goto(`${origin}/harness.html`)
const panel = page.getByRole('region', { name: '述策发布指挥台' })
await expect(panel).toBeVisible()
await expect(page.getByRole('button', { name: /发布指挥台/ })).toHaveCount(0)
await expect(panel.getByRole('heading', { name: '超长文章布局验证' })).toBeVisible()
await expect(panel.locator('.sw-markdown-image')).toHaveAttribute('src', /^data:image\/png;base64,/)
await expect(panel.getByRole('button', { name: '复制 Markdown' })).toBeVisible()
await expect(panel.getByRole('button', { name: '发布并下一条' })).toBeVisible()

const body = panel.locator('[data-role="body"]')
await expect(body).toHaveAttribute('data-layout', 'stack')
await panel.getByRole('button', { name: '左右布局' }).click()
await expect(body).toHaveAttribute('data-layout', 'split')
await expect(panel.getByRole('button', { name: '上下布局' })).toBeVisible()
```

保留长文滚动和 footer 不被遮挡的断言。第二个 viewport 用 `720x800` 再跑一遍 split 后的 footer 可见性。

- [ ] **Step 2: Run the e2e and confirm the old overlay flow fails first if you have not updated the spec yet**

Run: `cd wemedia-studio && pnpm exec playwright test e2e/extension-workbench-layout.spec.ts --reporter=line`

Expected after the rewrite: PASS, 2 tests.

- [ ] **Step 3: Update README**

替换「悬浮发布指挥台」这一节，写清：

1. 打开 X 后点击工具栏「述策发布指挥台」。
2. 边栏只在 x.com / twitter.com 可用，离开后关闭。
3. 列表/预览可在上下和左右之间切换。
4. 安排表记忆仍写在 X 页 `x_schedule_last_selection_v3`。
5. 「发布并下一条」仍只改草稿状态。

同步改 `manifest.test.js` 里对 README 的 `悬浮发布指挥台` 匹配为 `Side Panel` 或 `浏览器` / `工具栏`。

- [ ] **Step 4: Run the full extension suite and e2e**

Run:

```bash
cd chrome-extension && node --test tests/*.test.js
cd ../wemedia-studio && pnpm exec playwright test e2e/extension-workbench-layout.spec.ts --reporter=line
```

Expected: all extension unit tests PASS; Playwright 2 passed.

- [ ] **Step 5: Commit**

```bash
git add wemedia-studio/e2e/extension-workbench-layout.spec.ts chrome-extension/README.md chrome-extension/tests/manifest.test.js
git commit -m "test: cover the side-panel workbench layout"
```

---

## Spec coverage

| Spec 要求 | Task |
|---|---|
| Side Panel 替代悬浮台 | 5, 6 |
| X 页只留安排表 | 2, 6 |
| 只在 x.com / twitter.com 启用 | 1, 4 |
| 首次工具栏打开，不 auto-open | 4, 6 |
| stack / split 可切换并记住 | 3, 5, 7 |
| 安排表走消息，失败显示未记录 | 2, 4, 5 |
| 草稿/图片仍走 SW | 5（沿用现有 client） |
| Manifest / 图标 / 瘦 WAR | 6 |
| Playwright + README | 7 |
