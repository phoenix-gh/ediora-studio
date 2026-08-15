# Chrome Extension Long Article Preview Scroll Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Chrome 插件发布指挥台在文章超长时只滚动正文，并让底部操作栏始终留在预览容器底部。

**Architecture:** 保留现有面板和正文节点，在预览 `<article>` 上补齐受限高度的纵向 flex 链路。正文作为唯一的弹性滚动区，标题、分隔线和底栏不参与收缩；使用真实 Chromium 尺寸断言覆盖回归。

**Tech Stack:** Manifest V3 Chrome extension, vanilla JavaScript ES modules, CSS flexbox, Playwright Chromium, Node built-in test runner.

## Global Constraints

- 只修改插件预览布局和对应测试，不改变复制、发布、筛选或 API 行为。
- 正文是唯一纵向滚动区域。
- 操作栏固定在插件预览容器内部，不使用相对浏览器视口的 fixed 或 absolute 定位。
- 桌面和窄屏布局共享同一结构。

---

### Task 1: Constrain the preview and verify long-content scrolling

**Files:**
- Create: `web/e2e/extension-workbench-layout.spec.ts`
- Modify: `chrome-extension/content/workbench-runtime.js:82-91,137`

**Interfaces:**
- Consumes: `mountWorkbench({ document, window, chromeApi })` and the open Shadow DOM rendered by `workbench-runtime.js`.
- Produces: `.sw-preview-article` as the bounded flex container; `.sw-preview-content` as the only scroll region; `.sw-preview-footer` as a non-shrinking footer.

- [ ] **Step 1: Write the failing browser regression**

Create a Playwright test that routes `http://extension.test/**` to the real files under `chrome-extension/`, mounts the workbench with a runtime stub returning one `ready` draft whose content contains at least 400 lines, opens the panel, and asserts literal layout outcomes:

```ts
const metrics = await content.evaluate(element => ({
  clientHeight: element.clientHeight,
  scrollHeight: element.scrollHeight,
}))
expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight)

const footerYBefore = (await footer.boundingBox())?.y
await content.evaluate(element => { element.scrollTop = element.scrollHeight })
await expect.poll(async () => (await footer.boundingBox())?.y).toBe(footerYBefore)
```

Also assert the footer bottom does not exceed the preview bottom and collect console errors/warnings into an array that must remain empty.

- [ ] **Step 2: Run the focused test and verify RED**

Run from `web/`:

```bash
pnpm exec playwright test e2e/extension-workbench-layout.spec.ts --project=chromium
```

Expected: FAIL because the current `.sw-preview-content` expands to its full scroll height instead of receiving a smaller client height.

- [ ] **Step 3: Implement the minimal flex containment fix**

In `chrome-extension/content/workbench-runtime.js`, add:

```css
.sw-preview-article { display: flex; flex-direction: column; min-height: 0; flex: 1; overflow: hidden; }
.sw-preview-article[hidden] { display: none; }
.sw-preview-head, .sw-preview-divider, .sw-preview-footer { flex-shrink: 0; }
```

Keep `.sw-preview-content { min-height: 0; flex: 1; overflow-y: auto; ... }` and add `class="sw-preview-article"` to the existing preview `<article>`.

- [ ] **Step 4: Run focused verification and verify GREEN**

Run from `web/`:

```bash
pnpm exec playwright test e2e/extension-workbench-layout.spec.ts --project=chromium
```

Expected: PASS with a scrollable long body, an unchanged footer position after scrolling, and no console problems.

- [ ] **Step 5: Run extension regressions and syntax checks**

Run:

```bash
cd chrome-extension
npm test
node --check background/service-worker.js
node --check content/workbench.js
node --check content/selectors.js
node --check content/draft-client.js
node --check content/draft-model.js
node --check content/workbench-clipboard.js
node --check content/workbench-runtime.js
node --check content/workbench-state.js
node --check content/schedule-memory.js
```

Then run `git diff --check` from the repository root. Expected: all tests and syntax checks pass with no whitespace errors.

- [ ] **Step 6: Commit the implementation**

```bash
git add chrome-extension/content/workbench-runtime.js web/e2e/extension-workbench-layout.spec.ts
git commit -m "fix: keep extension preview actions visible"
```
