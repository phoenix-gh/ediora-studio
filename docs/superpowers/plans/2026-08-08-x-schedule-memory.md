# X Schedule Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate X schedule last-selection memory into the Shuce extension UI and remove the legacy DevTools publishing interface.

**Architecture:** Add a focused page-local schedule memory module that reads/writes the existing `x_schedule_last_selection_v3` key, watches X's schedule dialog, restores saved controls, and saves the current controls only during the capture-phase click of X's schedule confirmation button. The internal X DOM driver only sets and verifies controls; it does not write schedule memory directly. Remove the page-injected `Shuce.publish` bridge from the manifest and source tree while keeping the internal publisher and driver modules available for a future first-class UI.

**Tech Stack:** Manifest V3 Chrome extension, browser JavaScript modules, Node.js built-in test runner, existing X DOM selectors and workbench Shadow DOM.

## Global Constraints

- Do not expose any DevTools or `Shuce` console API.
- Reuse `x_schedule_last_selection_v3` and accept the legacy five-field JSON shape.
- Do not write schedule memory to the backend or extension storage.
- Do not change the internal publisher's request validation or submission behavior.
- Preserve all unrelated existing uncommitted changes in the main workspace.

---

### Task 1: Add the schedule memory model and monitor

**Files:**
- Create: `chrome-extension/content/schedule-memory.js`
- Create: `chrome-extension/tests/schedule-memory.test.js`

**Interfaces:**
- Produces `SCHEDULE_MEMORY_KEY`, `normalizeScheduleSelection(value)`, `readScheduleSelection(storage)`, `writeScheduleSelection(storage, value)`, `scheduleSelectionFromDate(date)`, `formatScheduleSelection(value)`, and `createScheduleMemory(options)`.
- `createScheduleMemory(options)` accepts `{ document, window, onChange, intervalMs, restoreDelayMs }` and returns `{ read, readStored, save, saveCurrent, restore, start, stop }`.
- `onChange(selection)` receives the normalized selection after a successful confirmation-button write; no function is attached to `window`.

- [ ] **Step 1: Write failing pure-model tests**

```js
test('reads and formats the legacy five-field selection', () => {
  const storage = {
    getItem() {
      return JSON.stringify({ month: '8', day: '8', year: '2026', hour: '8', minute: '30' })
    },
  }

  const selection = readScheduleSelection(storage)

  assert.deepEqual(selection, {
    month: '8', day: '8', year: '2026', hour: '8', minute: '30',
  })
  assert.equal(formatScheduleSelection(selection), '2026-08-08 08:30')
})

test('normalizes and formats an AM/PM selection as local 24-hour display time', () => {
  const selection = normalizeScheduleSelection({
    month: 8, day: 8, year: 2026, hour: 8, minute: 30, period: 'PM',
  })

  assert.deepEqual(selection, {
    month: '8', day: '8', year: '2026', hour: '8', minute: '30', period: 'PM',
  })
  assert.equal(formatScheduleSelection(selection), '2026-08-08 20:30')
})

test('treats malformed JSON and storage failures as no saved selection', () => {
  assert.equal(readScheduleSelection({ getItem: () => '{' }), null)
  assert.equal(readScheduleSelection({ getItem: () => { throw new Error('blocked') } }), null)
})
```

- [ ] **Step 2: Run the focused test and confirm the expected missing-module failure**

Run: `npm test -- tests/schedule-memory.test.js`

Expected: FAIL because `content/schedule-memory.js` does not exist yet.

- [ ] **Step 3: Implement the pure model**

Use the exact storage key and normalize only finite date/time fields. Reject missing year/month/day/hour/minute, month outside `1..12`, day outside `1..31`, minute outside `0..59`, or an invalid `period`. Keep `period` optional so the original five-field script remains readable. Catch both JSON and storage exceptions in `readScheduleSelection` and `writeScheduleSelection`.

`scheduleSelectionFromDate(new Date(2026, 7, 8, 20, 30))` must return `{ year: '2026', month: '8', day: '8', hour: '8', minute: '30', period: 'PM' }`. `formatScheduleSelection` must convert AM/PM values and otherwise display the stored hour without guessing its period.

- [ ] **Step 4: Add monitor tests with a minimal fake schedule dialog**

The fake document must expose one `[role="dialog"]` with six `select` controls in X's month/day/year/hour/minute/period order. Verify that `restore()` writes the saved values in year → month → day → hour → minute → period order, dispatches input/change events, and does not overwrite storage with intermediate values. Verify `saveCurrent()` writes the current selection and invokes `onChange`.

- [ ] **Step 5: Implement the monitor**

Use `findFirst`, `SELECTORS`, and `inferScheduleControls` from `selectors.js`. Detect a schedule dialog only when it has recognizable schedule inputs or at least five select controls, so an unrelated X dialog is ignored. Poll at 300ms only to detect a newly opened dialog for restoration, wait 200ms before restoring it, and save only from the capture-phase click listener for the schedule confirmation button. Support both select controls and the existing direct date/time input selectors. `start()` must be idempotent; `stop()` must clear the timer and click listener, and all state must remain page-local.

- [ ] **Step 6: Run the focused schedule memory tests**

Run: `npm test -- tests/schedule-memory.test.js`

Expected: all schedule memory tests PASS.

### Task 2: Keep schedule memory tied to confirmation click

**Files:**
- Modify: `chrome-extension/content/x-dom-driver.js`
- Modify: `chrome-extension/tests/x-dom-driver.test.js`

**Interfaces:**
- Consumes the confirmation-click behavior from `content/schedule-memory.js`.
- Produces no new page or console API; `setScheduleFields` does not persist schedule memory.

- [ ] **Step 1: Write the failing driver regression test**

Change the existing direct-input schedule test to assert that `driver.setScheduleFields({ year: 2026, month: 8, day: 8, hour12: 8, minute: 30, period: 'PM' })` does not write `x_schedule_last_selection_v3`; the schedule-memory click test owns the persistence contract.

- [ ] **Step 2: Run the focused driver test and confirm it fails**

Run: `npm test -- tests/x-dom-driver.test.js`

Expected: the existing date/time assertions pass, but the new no-write assertion fails because `setScheduleFields` still persists the final value.

- [ ] **Step 3: Remove direct schedule-memory persistence**

Remove the direct schedule-memory writes after setting direct inputs and select controls. The confirmation-button click listener in `schedule-memory.js` reads the final values after existing read-back checks and performs the single persistence action.

- [ ] **Step 4: Run the focused driver tests**

Run: `npm test -- tests/x-dom-driver.test.js`

Expected: all driver tests PASS, including the new storage regression.

### Task 3: Show and update the last schedule in the floating workbench

**Files:**
- Modify: `chrome-extension/content/workbench-runtime.js`
- Modify: `chrome-extension/tests/workbench-bootstrap.test.js`

**Interfaces:**
- Consumes `createScheduleMemory` and `formatScheduleSelection` from `content/schedule-memory.js`.
- Adds one Shadow DOM element with `data-role="last-schedule"`; it has no click handler and does not expose a global API.

- [ ] **Step 1: Write the failing workbench markup/source regression**

Add assertions that `workbench-runtime.js` imports `schedule-memory.js`, contains `data-role="last-schedule"`, and renders the copy `上次安排：未记录`. The test must fail before the markup and integration exist.

- [ ] **Step 2: Run the focused bootstrap test and confirm failure**

Run: `npm test -- tests/workbench-bootstrap.test.js`

Expected: FAIL because the workbench has no last-schedule status yet.

- [ ] **Step 3: Add the status capsule and lifecycle integration**

Add a compact header status element that displays `上次安排：未记录` or `上次安排：${formatScheduleSelection(selection)}`. Create one schedule memory monitor during `mountWorkbench`, initialize the display from `readStored()`, start it once, update the display from `onChange`, and call `stop()` from the existing destroy handler. Keep the existing top-right positioning and all draft interactions unchanged.

- [ ] **Step 4: Run the focused workbench tests**

Run: `npm test -- tests/workbench-bootstrap.test.js tests/workbench.test.js`

Expected: all workbench tests PASS.

### Task 4: Remove the legacy DevTools publishing interface

**Files:**
- Modify: `chrome-extension/manifest.json`
- Modify: `chrome-extension/background/service-worker.js`
- Modify: `chrome-extension/tests/manifest.test.js`
- Modify: `chrome-extension/README.md`
- Modify: `chrome-extension/THIRD_PARTY_NOTICES.md`
- Delete: `chrome-extension/content/bridge.js`
- Delete: `chrome-extension/content/bridge-protocol.js`
- Delete: `chrome-extension/injected/console-api.js`
- Delete: `chrome-extension/tests/bridge-protocol.test.js`
- Delete: `chrome-extension/tests/console-api.test.js`

**Interfaces:**
- The only active content script entry remains `content/workbench.js`.
- Draft API messages through the service worker remain unchanged.
- No `window.Shuce`, `SHUCE_PUBLISH_REQUEST`, `SHUCE_PUBLISH_RESULT`, or `SHUCE_EXECUTION_RECORDED` interface remains active.

- [ ] **Step 1: Write the failing manifest/README regression**

Change the manifest test expectations so it requires exactly `['content/workbench.js']`, requires `content/schedule-memory.js` in web-accessible resources, and asserts that the manifest and README contain none of `bridge.js`, `console-api.js`, `Shuce.publish`, or `dryRun` documentation. Run the test before changing production files.

- [ ] **Step 2: Run the focused manifest test and confirm failure**

Run: `npm test -- tests/manifest.test.js`

Expected: FAIL because the current manifest and README still expose the old bridge and console examples.

- [ ] **Step 3: Remove active bridge wiring and stale execution logging**

Remove `content/bridge.js` from `content_scripts`, remove the injected API and bridge/publisher-only resources from `web_accessible_resources`, and add `content/schedule-memory.js`. Delete the three bridge/API source files. Remove `LAST_EXECUTION_KEY`, the install-time reset, and the `SHUCE_EXECUTION_RECORDED` handler from the service worker; draft API request handling must remain intact.

- [ ] **Step 4: Remove bridge-only tests and update documentation**

Delete the bridge protocol and console API tests. Update the README to document the top-right read-only workbench, the last schedule status, and the extension reload procedure without any console publishing commands. Update third-party notices to say the internal X DOM driver is retained but no page bridge or console API is shipped.

- [ ] **Step 5: Run the focused manifest test**

Run: `npm test -- tests/manifest.test.js`

Expected: all manifest and documentation assertions PASS, including the absence of the old DevTools interface.

### Task 5: Full verification and handoff

**Files:**
- Verify: all files changed by Tasks 1–4

- [ ] **Step 1: Run the complete extension test suite**

Run: `npm test`

Expected: all remaining test files PASS with zero failures.

- [ ] **Step 2: Run JavaScript syntax checks**

Run: `find background content injected -name '*.js' -print0 | xargs -0 -n1 node --check`

Expected: every remaining extension JavaScript file passes syntax validation.

- [ ] **Step 3: Check the diff**

Run: `git diff --check`

Expected: no whitespace errors. Confirm `git status --short` lists only the intended extension files and the new spec/plan; do not stage or reset unrelated user changes.

- [ ] **Step 4: Manually reload the extension**

In `chrome://extensions`, reload “述策助手” and refresh an X page. Open the schedule dialog, choose a future time, close and reopen it, then open the top-right workbench and confirm the status shows the saved time. Confirm `window.Shuce` is not created by the extension.
