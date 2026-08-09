# 述策助手“发布并下一条” Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Chrome 插件发布指挥台中把当前 `ready` 草稿标记为 `published`，成功后自动选中当前结果中的下一条。

**Architecture:** 复用现有本机草稿 PATCH API，但通过 service worker 暴露一个只允许 `published` 的专用消息动作。content runtime 负责按钮、处理中状态和提示；纯状态函数负责从当前筛选结果中删除已发布草稿并选择下一条，避免重新加载时无选中项被默认回选第一条。

**Tech Stack:** Manifest V3 Chrome extension, vanilla ES modules, service worker messaging, browser `fetch`, Node built-in test runner.

## Global Constraints

- 只修改本次功能需要的 `chrome-extension` 文件和新增的规格/计划文档，保留仓库现有用户未提交改动。
- 插件动作固定提交 `{ "status": "published" }`，不接受任意状态参数。
- 不恢复 DevTools、控制台或 `window.Shuce` 接口，不自动操作 X DOM。
- 插件只允许当前已有的 localhost/127.0.0.1:8000 API 地址。
- 发布失败时不删除当前草稿、不改变选中项，并只显示安全固定文案。
- 当前环境 Git 元数据不可写，不能创建 worktree 或提交 commit；每个任务用独立测试命令和最终 diff 检查替代提交步骤。

---

### Task 1: 为草稿 API 增加受限发布动作

**Files:**
- Modify: `chrome-extension/background/draft-api.js`
- Test: `chrome-extension/tests/draft-api.test.js`

**Interfaces:**
- Produces `publishDraft(apiBase, draftId): Promise<SanitizedDraft>`.
- The function sends `PATCH /write/drafts/{draftId}` with the fixed body `{ status: 'published' }` and returns only `SAFE_FIELDS`.

- [ ] **Step 1: Write the failing tests**

Add tests to `chrome-extension/tests/draft-api.test.js` that call `publishDraft` and assert the exact request:

```js
test('publishes one draft through the local PATCH endpoint', async () => {
  const calls = []
  const result = await publishDraft(DEFAULT_API_BASE, 7, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({
        id: 7,
        title: '标题',
        content: '正文',
        status: 'published',
        draft_type: 'x',
        updated_at: 'now',
        sources: ['private'],
      }), { status: 200 })
    },
  })

  assert.equal(calls[0].url, 'http://localhost:8000/api/write/drafts/7')
  assert.equal(calls[0].init.method, 'PATCH')
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(calls[0].init.body), { status: 'published' })
  assert.deepEqual(result, {
    id: 7,
    title: '标题',
    content: '正文',
    status: 'published',
    draft_type: 'x',
    updated_at: 'now',
  })
})

test('rejects invalid draft ids before making a request', async () => {
  await assert.rejects(
    publishDraft(DEFAULT_API_BASE, 0, { fetchImpl: async () => new Response('{}') }),
    { code: 'DRAFT_API_INVALID_REQUEST' },
  )
})
```

Import `publishDraft` in the test before running it.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test tests/draft-api.test.js` from `chrome-extension/`.

Expected: FAIL because `publishDraft` is not exported.

- [ ] **Step 3: Implement the minimal API function**

In `chrome-extension/background/draft-api.js`:

1. Add `publishDraft` beside `fetchDraftCollection`.
2. Reuse `assertAllowedApiBase`, `AbortController`, timeout cleanup, and the existing generic HTTP error behavior.
3. Reject when `draftId` is not an integer greater than zero with code `DRAFT_API_INVALID_REQUEST`.
4. Call:

```js
fetchImpl(`${normalized}/write/drafts/${draftId}`, {
  method: 'PATCH',
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ status: 'published' }),
  cache: 'no-store',
  ...(controller ? { signal: controller.signal } : {}),
})
```

5. Parse the object response and pass it through a single-draft sanitizer that has the same field mapping as `sanitizeDraftCollection`.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `node --test tests/draft-api.test.js`.

Expected: all draft API tests PASS.

- [ ] **Step 5: Run the API syntax check**

Run: `node --check background/draft-api.js`.

Expected: exit code 0.

---

### Task 2: Route the publish action through the extension message client

**Files:**
- Modify: `chrome-extension/content/draft-client.js`
- Modify: `chrome-extension/background/service-worker.js`
- Test: `chrome-extension/tests/draft-client.test.js`

**Interfaces:**
- Adds `DRAFT_MESSAGE_TYPES.PUBLISH = 'SHUCE_DRAFT_PUBLISH'`.
- Adds `client.publishDraft(apiBase, draftId): Promise<{ draft: SanitizedDraft }>`.
- Service worker handles `SHUCE_DRAFT_PUBLISH` and calls `publishDraft(apiBase, draftId)` from `background/draft-api.js`.

- [ ] **Step 1: Write the failing client contract test**

Extend `chrome-extension/tests/draft-client.test.js` with a response for `SHUCE_DRAFT_PUBLISH` and assert:

```js
const response = await client.publishDraft('http://localhost:8000/api', 7)
assert.deepEqual(response, {
  draft: { id: 7, status: 'published' },
})
assert.deepEqual(runtime.calls.at(-1), {
  type: 'SHUCE_DRAFT_PUBLISH',
  requestId: 'request-7',
  apiBase: 'http://localhost:8000/api',
  draftId: 7,
})
```

Also add an error response assertion proving `client.publishDraft` maps the service-worker error to `DRAFT_API_UNAVAILABLE`.

- [ ] **Step 2: Run the focused client test to verify it fails**

Run: `node --test tests/draft-client.test.js`.

Expected: FAIL because the client has no `publishDraft` method and no publish message constant.

- [ ] **Step 3: Add the message and service-worker route**

In `content/draft-client.js`:

1. Add `PUBLISH: 'SHUCE_DRAFT_PUBLISH'` to `DRAFT_MESSAGE_TYPES`.
2. Add `publishDraft(apiBase, draftId)` to the returned frozen client, sending `{ apiBase, draftId }` and requiring a `draft` object in the response.

In `background/service-worker.js`:

1. Import `publishDraft` from `./draft-api.js`.
2. Add `DRAFT_PUBLISH_TYPE = 'SHUCE_DRAFT_PUBLISH'`.
3. Add the type to the accepted message set.
4. In `handleDraftMessage`, resolve the configured API base as the existing fetch route does, call `publishDraft(apiBase, message.draftId)`, and return:

```js
{
  type: DRAFTS_RESULT_TYPE,
  requestId,
  ok: true,
  draft,
}
```

5. Add `DRAFT_API_INVALID_REQUEST: '发布请求无效'` to the fixed safe error map.

- [ ] **Step 4: Run the focused client test to verify it passes**

Run: `node --test tests/draft-client.test.js`.

Expected: all client tests PASS.

- [ ] **Step 5: Run syntax checks for the message path**

Run: `node --check content/draft-client.js && node --check background/service-worker.js`.

Expected: exit code 0.

---

### Task 3: Add deterministic “remove current and select next” state transition

**Files:**
- Modify: `chrome-extension/content/workbench-state.js`
- Test: `chrome-extension/tests/workbench.test.js`

**Interfaces:**
- Adds `publishingId: null | string | number` to workbench state.
- Produces `publishDraftAndSelectNext(state, draftId): WorkbenchState`.
- The returned state removes the target from `drafts`, selects the immediately following visible draft, and selects `null` when there is no following draft.

- [ ] **Step 1: Write the failing state tests**

Import `publishDraftAndSelectNext` and add these cases:

```js
test('removes the published draft and selects the next visible draft', () => {
  let state = applyDrafts(createWorkbenchState(), [rawDrafts[0], rawDrafts[1]])
  state = selectDraft(state, 2)

  const next = publishDraftAndSelectNext(state, 2)

  assert.deepEqual(next.drafts.map(draft => draft.id), [1])
  assert.equal(next.selectedId, 1)
  assert.equal(next.copyState, 'idle')
})

test('does not wrap to the first draft after publishing the last item', () => {
  let state = applyDrafts(createWorkbenchState(), [rawDrafts[0], rawDrafts[1]])
  state = selectDraft(state, 1)

  const next = publishDraftAndSelectNext(state, 1)

  assert.deepEqual(next.drafts.map(draft => draft.id), [2])
  assert.equal(next.selectedId, null)
})

test('uses the next item from the current filtered result', () => {
  let state = applyDrafts(createWorkbenchState(), [rawDrafts[0], rawDrafts[1]])
  state = setWorkbenchFilter(state, { type: 'x' })
  state = selectDraft(state, 2)

  const next = publishDraftAndSelectNext(state, 2)

  assert.deepEqual(next.drafts.map(draft => draft.id), [1])
  assert.equal(next.selectedId, null)
})
```

- [ ] **Step 2: Run the focused state test to verify it fails**

Run: `node --test tests/workbench.test.js`.

Expected: FAIL because the new transition function and state field do not exist.

- [ ] **Step 3: Implement the pure transition**

In `content/workbench-state.js`:

1. Add `publishingId: null` to `createWorkbenchState`.
2. Implement `publishDraftAndSelectNext` by finding the target in `getVisibleDrafts(state)`, taking `visible[index + 1]?.id ?? null`, filtering the target out of `state.drafts`, and returning the state with `selectedId`, `copyState: 'idle'`, `publishingId: null`, and `error: null` updated.
3. Return the original state when the target is not present in the visible results.

- [ ] **Step 4: Run the focused state test to verify it passes**

Run: `node --test tests/workbench.test.js`.

Expected: all workbench state tests PASS.

---

### Task 4: Wire the publish button and processing/error UI

**Files:**
- Modify: `chrome-extension/content/workbench-runtime.js`
- Modify: `chrome-extension/tests/workbench-bootstrap.test.js`
- Modify: `chrome-extension/README.md`
- Modify: `chrome-extension/tests/manifest.test.js`

**Interfaces:**
- The runtime calls `client.publishDraft(state.apiBase, selected.id)`.
- The runtime uses `state.publishingId` to disable action buttons while a request is active.
- The runtime applies `publishDraftAndSelectNext` only after the client promise resolves successfully.

- [ ] **Step 1: Write the failing UI contract tests**

Extend `workbench-bootstrap.test.js` to assert that the runtime source includes:

```js
assert.match(source, /data-action="publish"/)
assert.match(source, /发布并下一条/)
assert.match(source, /client\.publishDraft\(/)
assert.match(source, /publishDraftAndSelectNext/)
```

Update the manifest/readme contract test expectations to require the readme phrases `发布并下一条`, `status=published`, and `不执行 X 的实际发布动作`.

- [ ] **Step 2: Run the focused source contract tests to verify they fail**

Run: `node --test tests/workbench-bootstrap.test.js tests/manifest.test.js`.

Expected: FAIL because the runtime and README do not contain the new action.

- [ ] **Step 3: Add the button and runtime action**

In `workbench-runtime.js`:

1. Import `publishDraftAndSelectNext` from `workbench-state.js`.
2. Add a secondary copy button and a primary publish button in the preview footer:

```html
<button class="sw-ghost-button" type="button" data-action="copy" disabled>复制内容</button>
<button class="sw-primary-button" type="button" data-action="publish" disabled>发布并下一条</button>
```

3. Capture `publishButton` and render both buttons disabled when there is no selected draft, no content, or `state.publishingId` is non-null. Render `发布中…` while the selected item is publishing.
4. While `state.publishingId` is non-null, render list rows disabled and ignore list-row selection events; this keeps the request tied to the draft that the user confirmed.
5. Add `async function publishSelected()`:
   - return if there is no selected draft or another publish is active;
   - save `draft.id` and set `publishingId` before rendering;
   - call `await client.publishDraft(state.apiBase, draft.id)`;
   - if successful, apply `publishDraftAndSelectNext(state, draft.id)`, render, and call `notify('已标记为已发布，已进入下一条')`;
   - if the request fails, clear `publishingId`, render, and call `notify(safeMessage(error))` without changing the draft list;
6. Attach `publishButton.addEventListener('click', () => void publishSelected())`.

In the static CSS, retain the existing primary styles and add a compact `.sw-ghost-button` footer style if needed so both actions remain readable.

- [ ] **Step 4: Update the operating guide**

Change `chrome-extension/README.md` so the workbench section says:

- `复制内容` only copies the full original text.
- `发布并下一条` marks the selected `status=ready` draft as `status=published` and selects the next item.
- The button does not publish to X; the user completes the actual X publish/schedule action separately.
- Failures leave the current draft selected for retry.

- [ ] **Step 5: Run focused UI contract tests**

Run: `node --test tests/workbench-bootstrap.test.js tests/manifest.test.js`.

Expected: all focused contract tests PASS.

---

### Task 5: Run the complete extension verification

**Files:**
- Test: all files under `chrome-extension/tests/`

- [ ] **Step 1: Run all extension tests**

Run: `npm test` from `chrome-extension/`.

Expected: every test passes with zero failures.

- [ ] **Step 2: Check every remaining JavaScript source file**

Run:

```bash
find background content tests -name '*.js' -print0 | xargs -0 -n1 node --check
```

Expected: every file exits successfully.

- [ ] **Step 3: Check whitespace errors**

Run: `git diff --check` from the repository root.

Expected: no output and exit code 0.

- [ ] **Step 4: Review the final scoped diff**

Run: `git diff -- chrome-extension docs/superpowers/specs/2026-08-08-extension-publish-next-design.md docs/superpowers/plans/2026-08-08-extension-publish-next.md`.

Confirm that the diff contains only the publish message/API/state/UI/documentation changes plus the new spec and plan, and that no DevTools or `window` interface was reintroduced.
