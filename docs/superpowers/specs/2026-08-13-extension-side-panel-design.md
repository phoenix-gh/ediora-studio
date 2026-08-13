# 述策助手 Chrome Side Panel 设计

## 背景

述策助手当前把发布指挥台做成 X 页面里的悬浮层：右上角入口、Shadow DOM 面板、列表和预览都盖在时间线上。安排表记忆仍写在 X 页面 `localStorage`，草稿和本地图片走 service worker。

悬浮层会挡时间线，也无法利用浏览器自己的侧栏。本次用 Chrome 原生 Side Panel 完全替代悬浮指挥台。

## 目标

1. 用浏览器右侧 Side Panel 展示现有指挥台：草稿列表、Markdown 预览、复制、「发布并下一条」、上次安排、自动填入、刷新、乱序、API 设置。
2. 去掉 X 页面上的悬浮入口和悬浮面板。X 页 content script 只负责安排表记忆和与边栏的消息同步。
3. 边栏只在 `https://x.com/*` 和 `https://twitter.com/*` 可用。离开这些页面时边栏关闭。
4. 列表和正文支持「上下」与「左右」两种布局，用户可切换，选择写入扩展 `chrome.storage.local`。
5. 草稿读取、图片代理、发布标记、本机 API 白名单和「不自动发到 X」的语义保持不变。

## 非目标

- 不在进入 X 时静默自动弹出边栏。Chrome 要求 `sidePanel.open()` 必须有用户手势；首次打开靠点击工具栏图标。
- 不使用独立弹出窗（`chrome.windows.create`），不把指挥台再注入成页面右侧占位栏。
- 不把安排表记忆迁出 X 页面 `localStorage`。
- 不新增远程 API host permission，不读取 Cookie / Token。
- 不改变「发布并下一条」的含义：只把草稿标为 `published`，不调用 X 发帖接口。
- 不引入 React、构建工具或第三方 UI 库。

## 用户流程

1. 用户加载已解压的述策助手，打开 X。
2. 工具栏出现述策图标。第一次使用时点击图标，浏览器右侧打开「述策发布指挥台」。
3. 边栏请求 `status=ready` 草稿，默认上下布局：上头标题/安排表/操作，中间搜索和列表，底下预览和复制/发布。
4. 用户可切换成左右布局；该选择在扩展存储中保留，下次打开边栏沿用。
5. 用户复制 Markdown，到 X 粘贴或打开安排表。安排表仍由页面里的 content script 恢复/自动填入/在确认时写入。
6. 边栏展示「上次安排」和「自动填入发布时间」；勾选通过消息写回当前 X 页的 `localStorage`。
7. 用户切到非 X 标签页或导航离开 X，边栏关闭。回到 X 后，若该标签页之前开着边栏，Chrome 会再次显示；否则再点一次工具栏图标。
8. API 不可用时，错误只出现在边栏内，可重试；X 时间线不受影响。

## 方案

### 浏览器边栏，而不是页面浮层

新增扩展页面 `chrome-extension/sidepanel/index.html`，由 Manifest V3 `side_panel.default_path` 加载。该页面在扩展源下运行，不受 X 的 `img-src` CSP 限制，但仍继续走现有 service worker 图片代理，以复用本机 host 白名单和 `localhost` / `127.0.0.1` 改写。

`manifest.json` 增加：

- 权限 `sidePanel`
- `action.default_title` 为「述策发布指挥台」
- 工具栏图标使用 `chrome-extension/icons/icon-16.png`、`icon-32.png`、`icon-48.png`
- `side_panel.default_path` 为 `sidepanel/index.html`

不增加 `tabs` 权限。判断是否为 X 页时，只使用已有 host permission 能读到的 `tab.url`；读不到 URL 的标签页一律视为非 X，关闭边栏。

### 按站点开关

service worker 启动时：

1. 调用 `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`，让工具栏图标打开边栏。
2. 调用 `chrome.sidePanel.setOptions({ enabled: false })`，默认全局关闭。
3. 监听 `chrome.tabs.onUpdated` 和 `chrome.tabs.onActivated`。当标签页 URL 属于 `x.com` 或 `twitter.com` 时，对该 `tabId` 执行 `setOptions({ tabId, path: 'sidepanel/index.html', enabled: true })`；否则 `setOptions({ tabId, enabled: false })`。

不在 `onUpdated` 里调用 `sidePanel.open()`。首次打开必须来自工具栏点击。

URL 判定抽成纯函数 `isXSiteUrl(value)`：只接受 `https:`，host 为 `x.com`、`twitter.com` 或其 `www.` 形式。

### 指挥台表面

现有 `mountWorkbench({ document, window, chromeApi })` 增加必填表面参数：

```text
mountWorkbench({ document, window, chromeApi, surface: 'sidepanel' })
```

`surface` 只允许 `'sidepanel'`。实现中删除悬浮入口、关闭按钮、固定在页面右上角的定位和 Shadow DOM 宿主。边栏页面直接把指挥台挂到 `document.body`，根节点铺满视口。

窄栏默认 `layout: 'stack'`（上列表、下预览）。用户点击布局按钮切换到 `layout: 'split'`（左列表、右预览）。合法值只有这两个字符串。偏好键为 `shuceWorkbenchLayout`，写入 `chrome.storage.local`；读到其他值时回退到 `stack`。

Chrome 边栏关闭控件替代原来的「收起」。Esc 不再负责关面板。

### X 页只保留安排表

`content/workbench.js` 不再动态加载 `workbench-runtime.js`，也不再向页面插入 `#shuce-floating-draft-workbench`。它只启动 `createScheduleMemory`，并回答边栏的安排表消息。

安排表存储键不变：

```text
x_schedule_last_selection_v3
x_schedule_auto_fill_enabled_v1
```

边栏不能读 X 页 `localStorage`。新增扩展内部消息：

| 类型 | 方向 | 作用 |
|---|---|---|
| `SHUCE_SCHEDULE_GET` | 边栏 → 当前 X 标签 content script | 读取上次安排和自动填入开关 |
| `SHUCE_SCHEDULE_SET_AUTOFILL` | 边栏 → 当前 X 标签 content script | 写入自动填入开关 |
| `SHUCE_SCHEDULE_CHANGED` | content script → 边栏 | 页面确认安排表或开关变化后推送 |

service worker 把安排表消息转给边栏所在窗口里当前活动、且 URL 为 X 的那个标签。同一窗口有多个 X 标签时只问活动标签；找不到这样的标签时，边栏显示「上次安排：未记录」，自动填入复选框不可用，不报致命错误。

草稿、图片、发布、API 配置消息保持现有 `SHUCE_DRAFTS_*` 合同。

### 失败与边界

- 离开 X：该标签的 Side Panel `enabled: false`，边栏关闭。
- 草稿 API 失败：边栏列表区显示可重试行内错误；不写扩展存储、不弹系统通知。
- 安排表读失败或没有 X 标签：显示「未记录」，不阻塞草稿列表。
- 布局存储失败：当次会话仍可切换，刷新后回到 `stack`。
- 图片仍只代理本机 `8000` 端口 `/api/uploads/`；`localhost` 与 `127.0.0.1` 视为同一本机 API。

## 测试

- Manifest：声明 `sidePanel`、`side_panel.default_path`、`action`；content script 仍只有 `content/workbench.js`；不出现 `<all_urls>`；不再要求把工作台运行时列为 X 页 `web_accessible_resources`。
- 纯函数：`isXSiteUrl` 接受 x.com / twitter.com / www 形式，拒绝其他 host 和 `http:`。
- 安排表桥：`SHUCE_SCHEDULE_GET` 返回页面存储；`SET_AUTOFILL` 写回；没有 X 标签时返回空记录而不是抛错。
- 工作台表面：`surface: 'sidepanel'` 不渲染悬浮入口和关闭按钮；布局在 `stack` / `split` 间切换并写入存储。
- Playwright：直接打开 `sidepanel/index.html` 的 harness，确认上下/左右切换后列表和预览都在，底部复制/发布仍可见，本地图片仍是 `data:image/...`。

## 文档

更新 `chrome-extension/README.md`：指挥台在浏览器 Side Panel，不再是页面悬浮层；首次使用要点工具栏图标；安排表仍在 X 页面本地存储。

## 验收

1. X 页面上看不到「述策」悬浮入口，时间线不被插件 DOM 覆盖。
2. 在 X 上点工具栏图标后，右侧出现指挥台；能列出 ready 草稿、预览、复制、标记发布。
3. 能在上下/左右布局间切换，刷新边栏后布局保持。
4. 边栏能显示并改写「自动填入发布时间」；X 安排表确认后，「上次安排」会更新。
5. 打开非 X 标签页时边栏不可用或关闭。
6. 插件单测和 side panel 布局 e2e 通过。
