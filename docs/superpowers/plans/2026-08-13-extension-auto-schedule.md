# Chrome Extension Auto Schedule Fill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在述策 Chrome 插件中增加持久化“自动填入发布时间”复选框，并在每次打开 X 安排弹窗时填入上次确认时间的下一小时和 `00–15` 随机分钟。

**Architecture:** `schedule-memory.js` 独立负责设置持久化、下一次时间纯计算、X 控件写入与弹窗生命周期；`workbench-runtime.js` 只渲染复选框并调用该模块公开的读写接口。现有 X 确认按钮仍是唯一推进“上次安排”的入口。

**Tech Stack:** Manifest V3 Chrome extension, vanilla JavaScript ES modules, page `localStorage`, Node built-in test runner, Playwright Chromium.

## Global Constraints

- 每次 X 安排时间弹窗从关闭变为打开时最多自动填写一次。
- 有记录时按上次确认时间的小时加 `1`；无记录时按当前本地时间的小时加 `1`。
- 原分钟丢弃，分钟使用闭区间 `00–15` 的随机整数。
- 自动填写不更新“上次安排”；只有 X 原生确认按钮点击后才保存实际选择。
- 关闭复选框时保持现有“恢复上次选择”行为。
- 勾选状态持久保存，不进入后端或 service worker。
- 不自动确认、不自动发布、不修改草稿状态。

---

### Task 1: Add deterministic next-time calculation and preference persistence

**Files:**
- Modify: `chrome-extension/content/schedule-memory.js`
- Test: `chrome-extension/tests/schedule-memory.test.js`

**Interfaces:**
- Produces `SCHEDULE_AUTO_FILL_KEY = 'x_schedule_auto_fill_enabled_v1'`.
- Produces `readScheduleAutoFillEnabled(storage): boolean`.
- Produces `writeScheduleAutoFillEnabled(storage, enabled): boolean`.
- Produces `nextScheduleSelection({ previous, now, random }): ScheduleSelection`.

- [ ] **Step 1: Write failing pure-function tests**

Add imports and literal expectations covering:

```js
assert.deepEqual(nextScheduleSelection({
  previous: { year: '2026', month: '8', day: '13', hour: '10', minute: '47' },
  now: new Date(2020, 0, 1),
  random: () => 0,
}), {
  year: '2026', month: '8', day: '13', hour: '11', minute: '0',
})

assert.deepEqual(nextScheduleSelection({
  previous: { year: '2026', month: '12', day: '31', hour: '11', minute: '47', period: 'PM' },
  random: () => 0.999999,
}), {
  year: '2027', month: '1', day: '1', hour: '12', minute: '15', period: 'AM',
})
```

Use a fixed `now = new Date(2026, 7, 13, 10, 59)` with no previous selection and expect `11:00–11:15` according to the injected random value. Add preference tests proving only stored `true` enables the feature and storage exceptions return `false` without throwing.

- [ ] **Step 2: Run the focused test and verify RED**

Run from `chrome-extension/`:

```bash
node --test tests/schedule-memory.test.js
```

Expected: FAIL because the new constant and functions are not exported.

- [ ] **Step 3: Implement the pure functions**

In `schedule-memory.js`:

1. Export `SCHEDULE_AUTO_FILL_KEY`.
2. Implement safe boolean reads and writes through `getItem` / `setItem`.
3. Convert a normalized previous selection to a local `Date`, respecting optional AM/PM; otherwise clone the supplied valid `now` or use `new Date()`.
4. Calculate the minute with `Math.min(15, Math.max(0, Math.floor(Number(random()) * 16) || 0))`.
5. Call `date.setHours(date.getHours() + 1, minute, 0, 0)` and return `scheduleSelectionFromDate(date)` when the baseline uses AM/PM; for a legacy five-field previous selection, return the same date fields without `period` and with 24-hour `hour`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run `node --test tests/schedule-memory.test.js` and expect all schedule-memory tests to pass.

- [ ] **Step 5: Run syntax validation**

Run `node --check content/schedule-memory.js` and expect exit code `0`.

---

### Task 2: Apply auto-fill once per dialog opening without advancing memory

**Files:**
- Modify: `chrome-extension/content/schedule-memory.js`
- Modify: `chrome-extension/tests/schedule-memory.test.js`

**Interfaces:**
- Extends `createScheduleMemory({ document, window, onChange, intervalMs, restoreDelayMs, now, random })`.
- Produces `memory.readAutoFillEnabled()` and `memory.setAutoFillEnabled(enabled)` for the workbench UI.
- Produces `memory.fillNext()` for an unsaved control write.

- [ ] **Step 1: Write failing lifecycle tests**

Use controlled select fixtures, a fixed `now` and injected random value. Store an enabled preference plus an existing selection and assert after the first polling interval:

```js
assert.deepEqual(selects.map(select => select.value), ['8', '13', '2026', '11', '7'])
assert.equal(storage.getItem(SCHEDULE_MEMORY_KEY), JSON.stringify(previous))
```

Run another interval while the same dialog remains open and assert no additional input/change events. Close and reopen the fake dialog, run the interval, and assert a second fill occurs. Add a disabled case that restores the exact old minute, plus a confirm-click case proving only the actual post-fill selection is saved and sent to `onChange`.

- [ ] **Step 2: Run the focused test and verify RED**

Run `node --test tests/schedule-memory.test.js`.

Expected: FAIL because `createScheduleMemory` always calls the old `restore()` path and exposes no auto-fill preference methods.

- [ ] **Step 3: Refactor control application and implement the lifecycle branch**

1. Extract the existing date/time and select write logic into a private `applySelection(selection)` function that never writes storage.
2. Keep `restore()` as `applySelection(readStored())`.
3. Implement `fillNext()` as `applySelection(nextScheduleSelection({ previous: readStored(), now: now(), random }))`.
4. In `poll()`, preserve the existing `isOpen && !wasOpen` gate, then call `fillNext()` when the preference is enabled or `restore()` otherwise.
5. Implement the two public preference methods through the safe storage functions.
6. Do not change `handleClick`; `saveCurrent()` remains the only path that advances `SCHEDULE_MEMORY_KEY`.

- [ ] **Step 4: Run the focused lifecycle tests and verify GREEN**

Run `node --test tests/schedule-memory.test.js` and expect all tests to pass.

- [ ] **Step 5: Run the plugin Node suite**

Run `npm test` from `chrome-extension/` and expect all plugin test files to pass.

---

### Task 3: Add the persistent checkbox to the workbench and verify the real flow

**Files:**
- Modify: `chrome-extension/content/workbench-runtime.js`
- Modify: `chrome-extension/README.md`
- Create: `wemedia-studio/e2e/extension-auto-schedule.spec.ts`

**Interfaces:**
- Consumes `scheduleMemory.readAutoFillEnabled()` and `scheduleMemory.setAutoFillEnabled(enabled)`.
- Produces `[data-role="auto-schedule"]` checkbox labelled `自动填入发布时间`.

- [ ] **Step 1: Write the failing Chromium flow**

Create a Playwright harness that loads the real extension modules, opens the command center, and asserts the checkbox starts unchecked. Check it, reload the page, and assert it remains checked. Then insert a simulated X schedule dialog with date/time controls, wait for the schedule poll, and assert a fixed `now` / random injection produces the expected next hour and minute while `x_schedule_last_selection_v3` remains unchanged until the simulated native confirmation button is clicked.

The test must also assert no page error or console warning/error occurs.

- [ ] **Step 2: Run the Chromium test and verify RED**

Run from `wemedia-studio/`:

```bash
pnpm exec playwright test e2e/extension-auto-schedule.spec.ts --project=chromium
```

Expected: FAIL because the workbench has no auto-schedule checkbox.

- [ ] **Step 3: Implement the checkbox and documentation**

In `workbench-runtime.js`:

1. Add a compact label near `[data-role="last-schedule"]` containing `<input type="checkbox" data-role="auto-schedule">` and the text `自动填入发布时间`.
2. Add styles that keep the control readable within the existing desktop and narrow headers.
3. Query the checkbox during mount and set `checked = scheduleMemory.readAutoFillEnabled()` during render.
4. On `change`, call `scheduleMemory.setAutoFillEnabled(autoSchedule.checked)` and render the persisted result.

In `README.md`, document the persistent setting, the previous-or-current baseline, next-hour calculation, `00–15` minute range, and confirmation-only memory advancement.

- [ ] **Step 4: Run Chromium verification and verify GREEN**

Run `pnpm exec playwright test e2e/extension-auto-schedule.spec.ts --project=chromium` and expect the persistence and simulated X dialog flow to pass.

- [ ] **Step 5: Run final focused checks**

Run:

```bash
cd chrome-extension
npm test
node --check content/schedule-memory.js
node --check content/workbench-runtime.js
cd ../wemedia-studio
pnpm exec playwright test e2e/extension-auto-schedule.spec.ts e2e/extension-workbench-layout.spec.ts --project=chromium
pnpm exec eslint e2e/extension-auto-schedule.spec.ts e2e/extension-workbench-layout.spec.ts
```

Then run `git diff --check` from the repository root. Expected: all commands pass without failures or whitespace errors.

- [ ] **Step 6: Commit the implementation**

```bash
git add chrome-extension/content/schedule-memory.js chrome-extension/content/workbench-runtime.js chrome-extension/tests/schedule-memory.test.js chrome-extension/README.md wemedia-studio/e2e/extension-auto-schedule.spec.ts
git commit -m "feat: auto-fill the next X schedule time"
```
