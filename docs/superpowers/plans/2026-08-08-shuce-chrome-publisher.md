# Shuce Chrome Publisher MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the standalone Manifest V3 “述策助手” extension that exposes a temporary `Shuce.publish()` console command for immediate single-post publishing and X-native scheduled publishing.

**Architecture:** A temporary page-world console adapter sends request-ID-correlated messages to an isolated-world content bridge. The bridge delegates to a testable publisher orchestrator and X DOM driver; the service worker stores status-only execution summaries. There is no WeMediaStudio API traffic or task polling in this MVP.

**Tech Stack:** Chrome Manifest V3, vanilla JavaScript ES modules, `window.postMessage`, Chrome storage/runtime APIs, Node.js built-in test runner.

## Global Constraints

- Create the plugin under repository-root `chrome-extension/`; the displayed extension name is exactly `述策助手`.
- Support one X post only; do not support threads, polls, media, X Articles, or backend task claiming.
- `Shuce.publish({ text, scheduledAt?, dryRun? })` is the only user command.
- Omitting `scheduledAt` publishes immediately; providing it uses X’s native scheduler in the browser’s local timezone.
- Accept only `YYYY-MM-DD HH:mm` and `YYYY-MM-DDTHH:mm`; reject timezone suffixes and seconds.
- `dryRun: true` may fill the composer and configure X’s schedule dialog but must never click the final publish/schedule button.
- The console adapter is temporary. The publisher and DOM driver must not read `window.Shuce` or export page-world globals.
- Request only `https://x.com/*` and `https://twitter.com/*`; do not read cookies/tokens or contact WeMediaStudio, localhost, or third-party APIs.
- Keep XActions attribution for the exact reference commit and files described in the approved design.
- Preserve all unrelated existing workspace changes and stage only files created under `chrome-extension/` plus this plan.

---

## File Map

- `chrome-extension/manifest.json`: Manifest V3 entrypoints and minimum X-only permissions.
- `chrome-extension/package.json`: local `node --test` commands with no runtime or dev dependencies.
- `chrome-extension/README.md`: loading, console commands, dry-run workflow, limitations, and troubleshooting.
- `chrome-extension/THIRD_PARTY_NOTICES.md`: XActions attribution, commit, source-file licenses, and modification notice.
- `chrome-extension/background/service-worker.js`: status-only execution log persisted to `chrome.storage.local`.
- `chrome-extension/content/contracts.js`: command validation, local date parsing, local ISO formatting, result/error helpers.
- `chrome-extension/content/selectors.js`: selector fallback lists and schedule-control inference helpers.
- `chrome-extension/content/x-dom-driver.js`: all X DOM queries, input simulation, scheduler control setting, and success evidence observation.
- `chrome-extension/content/publisher.js`: busy lock and immediate/scheduled orchestration over a driver interface.
- `chrome-extension/content/bridge.js`: page-message validation, dynamic publisher loading, request dispatch, and background status reporting.
- `chrome-extension/injected/console-api.js`: temporary `window.Shuce.publish()` promise API and response correlation.
- `chrome-extension/tests/contracts.test.js`: request and local-time contract tests.
- `chrome-extension/tests/selectors.test.js`: fallback selector and schedule-select inference tests.
- `chrome-extension/tests/publisher.test.js`: orchestration, dry-run, busy lock, and error mapping tests with a fake driver.
- `chrome-extension/tests/console-api.test.js`: page command request/response/timeout behavior using a fake window event bus.
- `chrome-extension/tests/manifest.test.js`: permission, host, entrypoint, and no-network static assertions.

---

### Task 1: Extension shell and command contracts

**Files:**
- Create: `chrome-extension/package.json`
- Create: `chrome-extension/manifest.json`
- Create: `chrome-extension/background/service-worker.js`
- Create: `chrome-extension/content/contracts.js`
- Create: `chrome-extension/tests/contracts.test.js`
- Create: `chrome-extension/tests/manifest.test.js`

**Interfaces:**
- Consumes: Nothing.
- Produces: `ERROR_CODES`, `validatePublishRequest(raw, now)`, `parseLocalSchedule(value, now)`, `formatLocalIso(date)`, `successResult(action, scheduledAt?)`, and `failureResult(code, message, details?)`.

- [ ] **Step 1: Write failing contract tests**

Create tests that pin the public request contract and exact local-time behavior:

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ERROR_CODES,
  formatLocalIso,
  parseLocalSchedule,
  validatePublishRequest,
} from '../content/contracts.js'

test('accepts immediate and local scheduled requests', () => {
  const now = new Date(2026, 7, 8, 10, 0)
  assert.deepEqual(validatePublishRequest({ text: '  hello  ' }, now), {
    text: 'hello', dryRun: false, scheduledAt: null,
  })
  const request = validatePublishRequest({
    text: 'scheduled', scheduledAt: '2026-08-08 20:30', dryRun: true,
  }, now)
  assert.equal(request.scheduledAt.getTime(), new Date(2026, 7, 8, 20, 30).getTime())
  assert.equal(request.dryRun, true)
})

test('rejects empty, malformed, timezone-suffixed, and past requests', () => {
  const now = new Date(2026, 7, 8, 10, 0)
  assert.throws(() => validatePublishRequest({ text: ' ' }, now), { code: ERROR_CODES.EMPTY_TEXT })
  assert.throws(() => parseLocalSchedule('2026-08-08T20:30:00', now), { code: ERROR_CODES.INVALID_SCHEDULE_TIME })
  assert.throws(() => parseLocalSchedule('2026-08-08T20:30+08:00', now), { code: ERROR_CODES.INVALID_SCHEDULE_TIME })
  assert.throws(() => parseLocalSchedule('2026-08-08 09:59', now), { code: ERROR_CODES.SCHEDULE_TIME_IN_PAST })
})

test('formats a local datetime with its actual timezone offset', () => {
  assert.match(formatLocalIso(new Date(2026, 7, 8, 20, 30)), /^2026-08-08T20:30:00[+-]\d{2}:\d{2}$/)
})
```

- [ ] **Step 2: Write failing manifest tests**

Read `manifest.json` from disk and assert:

```js
assert.equal(manifest.manifest_version, 3)
assert.equal(manifest.name, '述策助手')
assert.deepEqual(manifest.host_permissions.sort(), [
  'https://twitter.com/*',
  'https://x.com/*',
])
assert.equal(JSON.stringify(manifest).includes('localhost'), false)
assert.equal(JSON.stringify(manifest).includes('http://'), false)
assert.equal(manifest.content_scripts[0].js[0], 'content/bridge.js')
```

- [ ] **Step 3: Run tests to verify the shell is missing**

Run: `cd chrome-extension && node --test tests/contracts.test.js tests/manifest.test.js`

Expected: FAIL because the manifest and contract module do not exist.

- [ ] **Step 4: Implement the package, manifest, and contracts**

Use a dependency-free package:

```json
{
  "name": "shuce-chrome-publisher",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test tests/*.test.js"
  }
}
```

The manifest must include only `storage` in `permissions`, the two approved hosts, `background/service-worker.js`, `content/bridge.js`, and web-accessible resources for `injected/console-api.js` plus the ES modules under `content/`.

Implement strict regex parsing with component round-trip validation:

```js
const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/

export function parseLocalSchedule(value, now = new Date()) {
  const match = LOCAL_DATETIME.exec(String(value ?? ''))
  if (!match) throw contractError(ERROR_CODES.INVALID_SCHEDULE_TIME, '定时时间格式必须为 YYYY-MM-DD HH:mm')
  const [, year, month, day, hour, minute] = match.map(Number)
  const date = new Date(year, month - 1, day, hour, minute, 0, 0)
  const roundTrips = date.getFullYear() === year
    && date.getMonth() === month - 1
    && date.getDate() === day
    && date.getHours() === hour
    && date.getMinutes() === minute
  if (!roundTrips) throw contractError(ERROR_CODES.INVALID_SCHEDULE_TIME, '定时时间不存在')
  if (date.getTime() <= now.getTime()) throw contractError(ERROR_CODES.SCHEDULE_TIME_IN_PAST, '定时时间必须晚于当前时间')
  return date
}
```

The service worker stores only `{ requestId, ok, action, errorCode, finishedAt }` under `lastExecution`; it must never receive or persist post text.

- [ ] **Step 5: Run Task 1 tests**

Run: `cd chrome-extension && npm test`

Expected: contract and manifest tests PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add chrome-extension/package.json chrome-extension/manifest.json chrome-extension/background/service-worker.js chrome-extension/content/contracts.js chrome-extension/tests/contracts.test.js chrome-extension/tests/manifest.test.js
git commit -m "feat: scaffold Shuce Chrome publisher"
```

---

### Task 2: Temporary console API and isolated bridge

**Files:**
- Create: `chrome-extension/injected/console-api.js`
- Create: `chrome-extension/content/bridge.js`
- Create: `chrome-extension/tests/console-api.test.js`
- Modify: `chrome-extension/tests/manifest.test.js`

**Interfaces:**
- Consumes: `publisher.publish(rawRequest)` from Task 3; dynamic import delays that dependency until a request arrives.
- Produces: temporary page API `window.Shuce.publish(input): Promise<PublishResult>` and bridge message types `SHUCE_PUBLISH_REQUEST` / `SHUCE_PUBLISH_RESULT`.

- [ ] **Step 1: Write the failing console API tests**

Import `installConsoleApi()` and run it against a fake event target to verify request correlation:

```js
test('publish posts a correlated request and resolves only its matching response', async () => {
  const fakeWindow = createFakeWindow()
  installConsoleApi(fakeWindow, { randomUUID: () => 'request-1', timeoutMs: 100 })
  const promise = fakeWindow.Shuce.publish({ text: 'hello' })
  assert.deepEqual(fakeWindow.sent[0], {
    source: 'shuce-console', type: 'SHUCE_PUBLISH_REQUEST', requestId: 'request-1', payload: { text: 'hello' },
  })
  fakeWindow.emitMessage({ source: 'shuce-bridge', type: 'SHUCE_PUBLISH_RESULT', requestId: 'other', result: { ok: true } })
  fakeWindow.emitMessage({ source: 'shuce-bridge', type: 'SHUCE_PUBLISH_RESULT', requestId: 'request-1', result: { ok: true, action: 'published' } })
  assert.deepEqual(await promise, { ok: true, action: 'published' })
})

test('publish rejects with a stable timeout error', async () => {
  const fakeWindow = createFakeWindow()
  installConsoleApi(fakeWindow, { randomUUID: () => 'request-2', timeoutMs: 5 })
  await assert.rejects(fakeWindow.Shuce.publish({ text: 'hello' }), { code: 'BRIDGE_TIMEOUT' })
})
```

Expose an internal installer only under Node’s test environment; browser installation still occurs automatically.

- [ ] **Step 2: Run the console API test to verify failure**

Run: `cd chrome-extension && node --test tests/console-api.test.js`

Expected: FAIL because `console-api.js` does not exist.

- [ ] **Step 3: Implement the temporary API**

Implement `console-api.js` as a page-world ES module. Export `installConsoleApi(targetWindow, options)` for Node tests, call it automatically when `window` exists, and define a non-writable API object without exposing publisher internals:

```js
Object.defineProperty(targetWindow, 'Shuce', {
  configurable: true,
  enumerable: false,
  writable: false,
  value: Object.freeze({ publish }),
})
```

Validate that `input` is a plain object before posting it. Keep a `Map` of pending request IDs, remove listeners/timeouts on resolution, and reject duplicate installation without replacing an active API.

- [ ] **Step 4: Implement the isolated bridge**

`bridge.js` must:

1. Inject `injected/console-api.js` once as `<script type="module">` using `chrome.runtime.getURL()`.
2. Ignore events unless `event.source === window`, source/type match, request ID is a non-empty string, and payload is a non-array object.
3. Dynamically import `content/publisher.js` only after a valid request.
4. Call `publish(payload)` once and return either its structured result or `failureResult('INTERNAL_ERROR', ...)`.
5. Send status-only metadata to the service worker; omit `payload` and text.

- [ ] **Step 5: Extend manifest tests for accessible resources**

Assert that `injected/console-api.js`, `content/publisher.js`, `content/contracts.js`, `content/selectors.js`, and `content/x-dom-driver.js` are accessible only on the two X hosts.

- [ ] **Step 6: Run Task 2 tests**

Run: `cd chrome-extension && npm test`

Expected: all current tests PASS.

- [ ] **Step 7: Commit Task 2**

```bash
git add chrome-extension/injected/console-api.js chrome-extension/content/bridge.js chrome-extension/tests/console-api.test.js chrome-extension/tests/manifest.test.js
git commit -m "feat: expose temporary Shuce console command"
```

---

### Task 3: Immediate single-post publisher

**Files:**
- Create: `chrome-extension/content/selectors.js`
- Create: `chrome-extension/content/x-dom-driver.js`
- Create: `chrome-extension/content/publisher.js`
- Create: `chrome-extension/tests/selectors.test.js`
- Create: `chrome-extension/tests/publisher.test.js`

**Interfaces:**
- Consumes: Task 1 contract functions.
- Produces: `createPublisher({ driver, now }): (rawRequest) => Promise<PublishResult>`, lazy default `publish(rawRequest)`, `createXDomDriver(document, window)`, `findFirst(root, selectors)`, and `SELECTORS`.

- [ ] **Step 1: Write selector fallback tests**

Use a fake root whose `querySelector()` records calls:

```js
test('findFirst returns the first matching fallback', () => {
  const second = { id: 'inline' }
  const root = fakeQueryRoot({ '[data-testid="tweetButtonInline"]': second })
  assert.equal(findFirst(root, SELECTORS.submit), second)
  assert.deepEqual(root.queries, [
    '[data-testid="tweetButton"]',
    '[data-testid="tweetButtonInline"]',
  ])
})
```

Pin fallback lists for compose trigger, composer, immediate/final submit, scheduler trigger, scheduler dialog, and schedule confirmation.

- [ ] **Step 2: Write failing immediate-publisher tests**

Define a fake driver with call recording and cover these exact cases:

```js
test('publishes only after text round-trip verification', async () => {
  const driver = fakeDriver({ composerBefore: '', composerAfterWrite: 'hello', evidence: true })
  const publish = createPublisher({ driver, now: () => new Date(2026, 7, 8, 10, 0) })
  assert.deepEqual(await publish({ text: 'hello' }), { ok: true, action: 'published' })
  assert.deepEqual(driver.calls, [
    'assertSupportedPage', 'ensureComposer', 'readComposerText',
    ['writeComposerText', 'hello'], 'readComposerText',
    ['clickFinalSubmit', 'published'], ['waitForSubmissionEvidence', 'published'],
  ])
})

test('dry run never submits', async () => {
  const driver = fakeDriver({ composerBefore: '', composerAfterWrite: 'hello' })
  const publish = createPublisher({ driver, now: () => new Date(2026, 7, 8, 10, 0) })
  assert.deepEqual(await publish({ text: 'hello', dryRun: true }), { ok: true, action: 'dry-run' })
  assert.equal(driver.calls.some(call => Array.isArray(call) && call[0] === 'clickFinalSubmit'), false)
})
```

Also test non-empty existing draft protection, text mismatch, unsupported page, missing composer, unconfirmed submission, and a second overlapping call returning `BUSY` without invoking driver methods.

- [ ] **Step 3: Run Task 3 tests to verify failure**

Run: `cd chrome-extension && node --test tests/selectors.test.js tests/publisher.test.js`

Expected: FAIL because selector, driver, and publisher modules are missing.

- [ ] **Step 4: Implement the publisher state machine**

Use a closure-scoped busy flag and map only known driver errors:

```js
export function createPublisher({ driver, now = () => new Date() }) {
  let busy = false
  return async function publish(rawRequest) {
    if (busy) return failureResult(ERROR_CODES.BUSY, '当前标签页已有发布任务正在执行')
    busy = true
    try {
      const request = validatePublishRequest(rawRequest, now())
      await driver.assertSupportedPage()
      await driver.ensureComposer()
      const existing = normalizeComposerText(await driver.readComposerText())
      if (existing) return failureResult(ERROR_CODES.EXISTING_DRAFT, '编辑器中已有未提交内容')
      await driver.writeComposerText(request.text)
      if (normalizeComposerText(await driver.readComposerText()) !== request.text) {
        return failureResult(ERROR_CODES.TEXT_MISMATCH, '写入后的帖子内容与请求不一致')
      }
      if (request.scheduledAt) return runScheduled({ driver, request })
      if (request.dryRun) return successResult('dry-run')
      await driver.clickFinalSubmit('published')
      if (!await driver.waitForSubmissionEvidence('published')) {
        return failureResult(ERROR_CODES.SUBMIT_NOT_CONFIRMED, '未观察到 X 的发布成功证据')
      }
      return successResult('published')
    } catch (error) {
      return toFailureResult(error)
    } finally {
      busy = false
    }
  }
}
```

- [ ] **Step 5: Implement the immediate X DOM driver**

The driver must:

- Reject hosts outside the approved domains.
- Open the composer only when no composer exists.
- Wait by polling DOM conditions, never with one fixed sleep as success proof.
- Refuse to overwrite non-empty `innerText`/`textContent`.
- Insert text through focused `beforeinput` plus `execCommand('insertText')`, with an `input` event fallback.
- Resolve submit success only when the composer disappears or a success-status element contains a known English/Chinese posting success phrase.

- [ ] **Step 6: Run Task 3 tests**

Run: `cd chrome-extension && npm test`

Expected: all current tests PASS.

- [ ] **Step 7: Commit Task 3**

```bash
git add chrome-extension/content/selectors.js chrome-extension/content/x-dom-driver.js chrome-extension/content/publisher.js chrome-extension/tests/selectors.test.js chrome-extension/tests/publisher.test.js
git commit -m "feat: automate immediate X post publishing"
```

---

### Task 4: X-native scheduled publishing

**Files:**
- Modify: `chrome-extension/content/contracts.js`
- Modify: `chrome-extension/content/selectors.js`
- Modify: `chrome-extension/content/x-dom-driver.js`
- Modify: `chrome-extension/content/publisher.js`
- Modify: `chrome-extension/tests/contracts.test.js`
- Modify: `chrome-extension/tests/selectors.test.js`
- Modify: `chrome-extension/tests/publisher.test.js`

**Interfaces:**
- Consumes: `request.scheduledAt: Date` from Task 1 and the Task 3 driver.
- Produces: driver methods `openScheduler()`, `setScheduleFields(parts)`, `confirmScheduleDialog()`, `verifyComposerSchedule(date)`, and scheduled branch result `{ ok: true, action: 'scheduled', scheduledAt }`.

- [ ] **Step 1: Write failing scheduled-orchestration tests**

```js
test('sets, verifies, and finally submits an X-native schedule', async () => {
  const driver = fakeDriver({ composerBefore: '', composerAfterWrite: 'later', evidence: true, scheduleVerified: true })
  const publish = createPublisher({ driver, now: () => new Date(2026, 7, 8, 10, 0) })
  const result = await publish({ text: 'later', scheduledAt: '2026-08-08 20:30' })
  assert.equal(result.ok, true)
  assert.equal(result.action, 'scheduled')
  assert.match(result.scheduledAt, /^2026-08-08T20:30:00[+-]\d{2}:\d{2}$/)
  assert.deepEqual(driver.scheduleCalls, [
    'openScheduler',
    ['setScheduleFields', { year: 2026, month: 8, day: 8, hour12: 8, minute: 30, period: 'PM' }],
    'confirmScheduleDialog',
    ['verifyComposerSchedule', new Date(2026, 7, 8, 20, 30)],
    ['clickFinalSubmit', 'scheduled'],
    ['waitForSubmissionEvidence', 'scheduled'],
  ])
})

test('scheduled dry run configures X but never submits', async () => {
  const driver = fakeDriver({ composerBefore: '', composerAfterWrite: 'later', scheduleVerified: true })
  const publish = createPublisher({ driver, now: () => new Date(2026, 7, 8, 10, 0) })
  const result = await publish({ text: 'later', scheduledAt: '2026-08-08T20:30', dryRun: true })
  assert.equal(result.action, 'dry-run')
  assert.equal(driver.calls.some(call => Array.isArray(call) && call[0] === 'clickFinalSubmit'), false)
})
```

Add cases for scheduler unavailable, control inference failure, value round-trip mismatch, composer schedule mismatch, and unconfirmed final schedule submission.

- [ ] **Step 2: Write failing schedule-control inference tests**

Build fake `<select>` objects with option text/value sets. Assert that inference identifies:

- year by four-digit options;
- month by 12 month options or numeric 1–12 values;
- day by 1–31 options;
- hour by 1–12 options;
- minute by 00–59 options;
- period by AM/PM options;
- X’s known six-select order as the final fallback.

Assert that setting each select dispatches both `input` and `change`, then reads the selected option back before continuing.

- [ ] **Step 3: Run scheduled tests to verify failure**

Run: `cd chrome-extension && node --test tests/contracts.test.js tests/selectors.test.js tests/publisher.test.js`

Expected: FAIL because the scheduled branch and control inference are incomplete.

- [ ] **Step 4: Implement scheduled orchestration**

Convert local time to explicit control parts:

```js
export function scheduleParts(date) {
  const hour24 = date.getHours()
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour12: hour24 % 12 || 12,
    minute: date.getMinutes(),
    period: hour24 < 12 ? 'AM' : 'PM',
  }
}
```

The scheduled branch must open, set, confirm, and verify the schedule before honoring `dryRun`; only non-dry-run requests click the final composer action.

- [ ] **Step 5: Implement scheduler DOM operations**

Use these selector families in order:

- Trigger: `[data-testid="scheduleOption"]`, `[data-testid="scheduledButton"]`, English/Chinese schedule aria-label fallbacks.
- Dialog: `[role="dialog"]` containing schedule controls.
- Direct fields: `scheduledDateField` / `scheduleDateInput`, `scheduledTimeField` / `scheduleTimeInput`.
- Confirm: `scheduledConfirmationPrimaryAction`, `scheduleConfirm`, then enabled primary action inside the schedule dialog.

Prefer native select matching and round-trip validation. If the page exposes direct controlled inputs, use the native prototype value setter and dispatch `input` plus `change`. Never continue when a control cannot be read back as the requested value.

After dialog confirmation, verify that the composer displays the requested date/time before clicking its final Schedule action.

- [ ] **Step 6: Run Task 4 tests**

Run: `cd chrome-extension && npm test`

Expected: all current tests PASS.

- [ ] **Step 7: Commit Task 4**

```bash
git add chrome-extension/content/contracts.js chrome-extension/content/selectors.js chrome-extension/content/x-dom-driver.js chrome-extension/content/publisher.js chrome-extension/tests/contracts.test.js chrome-extension/tests/selectors.test.js chrome-extension/tests/publisher.test.js
git commit -m "feat: schedule posts with X native scheduler"
```

---

### Task 5: Attribution, operating guide, and final validation

**Files:**
- Create: `chrome-extension/README.md`
- Create: `chrome-extension/THIRD_PARTY_NOTICES.md`
- Modify: `chrome-extension/tests/manifest.test.js`

**Interfaces:**
- Consumes: all previous tasks.
- Produces: user-facing unpacked-extension workflow, exact console examples, known limitations, and auditable XActions attribution.

- [ ] **Step 1: Extend static tests for privacy and attribution**

Recursively read tracked JavaScript and manifest files and assert:

```js
for (const source of runtimeSources) {
  assert.equal(/https?:\/\/(?!x\.com|twitter\.com)/.test(source), false)
  assert.equal(/document\.cookie|authorization|auth_token|ct0/i.test(source), false)
}
const notices = await readFile('THIRD_PARTY_NOTICES.md', 'utf8')
assert.match(notices, /3c0d8d335fe4bc8a81f5093155e4e60c33dd8312/)
assert.match(notices, /scripts\/postThread\.js/)
assert.match(notices, /scripts\/twitter\/schedule-post\.js/)
assert.match(notices, /src\/schedulePosts\.js/)
assert.match(notices, /Apache License, Version 2\.0/)
assert.match(notices, /MIT License/)
```

- [ ] **Step 2: Run tests to verify docs/notice are missing**

Run: `cd chrome-extension && npm test`

Expected: FAIL because README and third-party notices do not exist.

- [ ] **Step 3: Write the operating guide**

Document these exact commands:

```js
await Shuce.publish({ text: '述策助手立即发布测试' })

await Shuce.publish({
  text: '述策助手定时发布测试',
  scheduledAt: '2026-08-08 20:30',
  dryRun: true,
})

await Shuce.publish({
  text: '述策助手定时发布测试',
  scheduledAt: '2026-08-08 20:30',
})
```

Include: `chrome://extensions/` loading steps, X login requirement, local timezone behavior, `dryRun` order, structured error table, how to reload after source edits, and how to inspect the service worker’s status-only `lastExecution` record.

State clearly that X DOM changes may break selectors and that automation may be subject to X account/product rules.

- [ ] **Step 4: Write third-party notices**

Record XActions author `nichxbt`, repository URL, exact reference commit, each referenced file, its applicable Apache-2.0 or MIT notice, and that WeMediaStudio’s implementation is modified and purpose-limited.

- [ ] **Step 5: Run all extension tests and static checks**

Run: `cd chrome-extension && npm test`

Expected: all tests PASS.

Run: `node --check background/service-worker.js && node --check content/bridge.js && node --check content/contracts.js && node --check content/selectors.js && node --check content/x-dom-driver.js && node --check content/publisher.js && node --check injected/console-api.js`

Expected: every file exits 0 with no syntax errors.

- [ ] **Step 6: Load the unpacked extension for dry-run browser QA**

Open `chrome://extensions/`, enable Developer mode, choose Load unpacked, and select the absolute `chrome-extension/` directory. On an authenticated X tab:

1. Confirm `typeof Shuce.publish === 'function'`.
2. Run immediate `dryRun`; confirm text is filled and no final click occurs.
3. Clear the composer manually.
4. Run scheduled `dryRun` at least ten minutes in the future; confirm X’s composer shows the exact local scheduled time and no final click occurs.
5. Confirm the extension service worker log contains status metadata but no post body.

Do not execute a real public post or real schedule during automated QA. Hand the two non-dry-run commands to the user for explicit execution in their logged-in account.

- [ ] **Step 7: Commit Task 5**

```bash
git add chrome-extension/README.md chrome-extension/THIRD_PARTY_NOTICES.md chrome-extension/tests/manifest.test.js
git commit -m "docs: explain Shuce publisher operation"
```

---

## Final Verification

- [ ] Run `cd chrome-extension && npm test` and require exit code 0.
- [ ] Run all seven `node --check` commands and require exit code 0.
- [ ] Run `git diff --check` and require no extension-related whitespace errors.
- [ ] Confirm `rg -n "fetch\(|XMLHttpRequest|WebSocket|localhost|127\.0\.0\.1" chrome-extension` has no runtime network integration.
- [ ] Confirm `rg -n "window\.Shuce|globalThis\.Shuce" chrome-extension/content chrome-extension/background` has no matches; only `injected/console-api.js` may define the temporary global.
- [ ] Confirm all extension files are in the intended commits and no unrelated workspace files were staged.
- [ ] Report that real immediate and scheduled publication remain user-run acceptance checks because they create external public state.
