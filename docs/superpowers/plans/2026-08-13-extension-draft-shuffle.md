# Chrome 插件草稿列表重新排序 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Chrome 插件草稿工作台增加只作用于当前内存列表的随机重新排序，并保证刷新恢复服务端顺序、发布操作不重排。

**Architecture:** 在现有 workbench state 中增加纯函数 `shuffleDrafts`，只复制并打乱 `state.drafts`，不改变其他状态。运行时在刷新按钮旁增加独立的 `data-action="shuffle"` 按钮，点击后调用状态函数并重渲染；现有发布状态转换继续消费当前数组，因此发布后保留随机后的剩余顺序。

**Tech Stack:** Chrome Extension Manifest V3, vanilla JavaScript ES modules, Shadow DOM UI, Node.js built-in test runner (`node --test`).

## Global Constraints

- 随机顺序只保存在当前 workbench 内存状态，不写入后端、`localStorage` 或 Chrome storage。
- 首次加载、手动刷新、API 设置保存后的刷新继续由 `applyDrafts` 按服务端更新时间排序。
- 重新排序不得改变 `selectedId`、搜索关键词、平台筛选或草稿内容。
- “发布并下一条”不得重新请求草稿或重新排序，只按当前可见顺序移除并选择下一项。
- 不增加拖拽排序、排序方式选择或跨页面同步。

---

### Task 1: Add deterministic state-level shuffle behavior

**Files:**
- Modify: `chrome-extension/content/workbench-state.js:27-73`
- Test: `chrome-extension/tests/workbench.test.js:5-114`

**Interfaces:**
- Consumes: existing workbench state objects from `createWorkbenchState`, `applyDrafts`, filters, and publish transitions.
- Produces: `shuffleDrafts(state, random = Math.random)` returning a new state whose `drafts` array is a Fisher–Yates permutation while preserving all other state fields.

- [ ] **Step 1: Write the failing tests**

Import `shuffleDrafts` and add tests for selection/filter preservation, publishing after a shuffle, and refresh restoring server time order:

```js
test('shuffles current order without changing selection or filters', () => {
  let state = applyDrafts(createWorkbenchState(), [rawDrafts[0], rawDrafts[1]])
  state = setWorkbenchFilter(selectDraft(state, 1), { query: 'Agent', type: 'article' })
  const shuffled = shuffleDrafts(state, () => 0)

  assert.deepEqual(shuffled.drafts.map(draft => draft.id), [1, 2])
  assert.equal(shuffled.selectedId, 1)
  assert.equal(shuffled.query, 'Agent')
  assert.equal(shuffled.type, 'article')
  assert.notEqual(shuffled.drafts, state.drafts)
})

test('publishing after a shuffle keeps the remaining shuffled order', () => {
  const third = { ...rawDrafts[0], id: 4, title: '第三条', updated_at: '2026-08-08T09:00:00Z' }
  let state = applyDrafts(createWorkbenchState(), [rawDrafts[0], rawDrafts[1], third])
  state = shuffleDrafts(state, () => 0.99)
  state = selectDraft(state, state.drafts[1].id)
  const next = publishDraftAndSelectNext(state, state.selectedId)

  assert.deepEqual(next.drafts.map(draft => draft.id), [2, 1])
})

test('refreshing with applyDrafts restores server time order after a shuffle', () => {
  let state = shuffleDrafts(applyDrafts(createWorkbenchState(), rawDrafts), () => 0)
  state = applyDrafts(state, [...rawDrafts].reverse())
  assert.deepEqual(state.drafts.map(draft => draft.id), [2, 1])
})
```

- [ ] **Step 2: Run the focused tests and verify the expected failure**

Run: `cd chrome-extension && node --test tests/workbench.test.js`

Expected: FAIL because `shuffleDrafts` is not exported yet; existing tests should otherwise run.

- [ ] **Step 3: Write the minimal implementation**

Add this pure function after `applyDrafts` in `workbench-state.js`:

```js
export function shuffleDrafts(state, random = Math.random) {
  const drafts = [...state.drafts]
  for (let index = drafts.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1))
    ;[drafts[index], drafts[target]] = [drafts[target], drafts[index]]
  }
  return { ...state, drafts }
}
```

Do not call `selectReadyDrafts`, `filterDrafts`, or any API operation from this function.

- [ ] **Step 4: Run the state tests**

Run: `cd chrome-extension && node --test tests/workbench.test.js`

Expected: all workbench tests pass.

- [ ] **Step 5: Commit the state change**

```bash
git add chrome-extension/content/workbench-state.js chrome-extension/tests/workbench.test.js
git commit -m "feat: add in-memory draft shuffle"
```

### Task 2: Add the shuffle control to the Shadow DOM workbench

**Files:**
- Modify: `chrome-extension/content/workbench-runtime.js:190-240,352-369,500-547`
- Test: `chrome-extension/tests/workbench.test.js:148-156`

**Interfaces:**
- Consumes: `shuffleDrafts` from `workbench-state.js` and the existing `state.publishingId` interaction guard.
- Produces: a header button with `data-action="shuffle"`, title “重新排序”, disabled while publishing, and a click handler that shuffles current state then calls `render()`.

- [ ] **Step 1: Write the failing UI/source regression test**

Add this assertion to the existing runtime source test:

```js
test('provides an in-memory draft shuffle control', async () => {
  const source = await readFile(new URL('../content/workbench-runtime.js', import.meta.url), 'utf8')
  assert.match(source, /data-action="shuffle"/)
  assert.match(source, /title="重新排序"/)
  assert.match(source, /shuffleDrafts\(state\)/)
})
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `cd chrome-extension && node --test tests/workbench.test.js`

Expected: FAIL because the runtime has no shuffle button, import, or handler.

- [ ] **Step 3: Add the button, import, and handler**

Import `shuffleDrafts`, add the button beside refresh:

```html
<button class="sw-icon-button" type="button" data-action="shuffle" title="重新排序">⤨</button>
```

Capture the button near `refreshButton`; in `render()` set `shuffleButton.disabled = state.publishingId !== null`; bind its click handler to return early during publishing, call `state = shuffleDrafts(state)`, and call `render()`. Do not call `loadDrafts()` from this handler.

- [ ] **Step 4: Run the complete extension suite and syntax checks**

Run:

```bash
cd chrome-extension && npm test
node --check content/workbench-state.js
node --check content/workbench-runtime.js
cd .. && git diff --check
```

Expected: all extension tests pass and all commands exit 0.

- [ ] **Step 5: Commit the UI change**

```bash
git add chrome-extension/content/workbench-runtime.js chrome-extension/tests/workbench.test.js
git commit -m "feat: add draft shuffle control"
```

### Task 3: Final verification and handoff

**Files:**
- Verify: `chrome-extension/content/workbench-state.js`
- Verify: `chrome-extension/content/workbench-runtime.js`
- Verify: `chrome-extension/tests/workbench.test.js`

**Interfaces:**
- Consumes: the state and UI changes from Tasks 1–2.
- Produces: verified local behavior and a concise handoff; no additional product behavior.

- [ ] **Step 1: Run the full extension suite fresh**

Run: `cd chrome-extension && npm test`

Expected: exit 0 with zero failed tests.

- [ ] **Step 2: Confirm the working tree and commits**

Run:

```bash
git status --short --branch
git log -3 --oneline
```

Expected: only intentional feature changes are present, with both feature commits after the existing design commit.

- [ ] **Step 3: Report behavior and evidence**

Report that reload/API refresh restores server order, shuffle persists across filter/select/publish interactions in the current page, publishing does not reorder remaining drafts, and `npm test` passed.
