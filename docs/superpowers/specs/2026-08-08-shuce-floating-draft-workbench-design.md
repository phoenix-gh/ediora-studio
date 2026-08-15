# 述策助手悬浮发布指挥台设计

## 背景

当前“述策助手”已经支持通过 `Shuce.publish()` 在 X 页面执行单条立即发布和 X 原生安排表发布。控制台命令适合开发验证，但不适合作为日常从 Ediora 草稿箱挑选内容的工作流。

本次增加一个专业、酷炫但不遮挡 X 主界面的悬浮发布指挥台。它从 Ediora API 读取所有 `status=ready` 的草稿，左侧展示待发布列表，右侧展示当前草稿正文，并提供一键复制正文功能。当前版本不自动发布、不修改草稿，只负责浏览和复制；既有 `Shuce.publish()` 保持兼容。

## 目标

- 在 X 页面提供可展开/收起的悬浮工作台。
- 从现有 `GET /api/write/drafts` 获取草稿，并在插件内筛选待发布草稿。
- 展示所有 `draft_type`，不只展示 X 类型。
- 左侧列表支持选中、搜索和类型筛选。
- 右侧展示标题、类型、更新时间、正文和字数。
- 通过用户点击复制当前草稿的 `content` 字段；复制成功给出明确反馈。
- 支持手动刷新和独立滚动列表，不做高频自动刷新。
- API 地址默认 `http://localhost:8000/api`，允许在工作台设置中修改。
- API 请求由 service worker 发起，避免 X 页面跨域请求受页面源限制。
- 不保存 API 返回的草稿正文到扩展持久化存储，不读取 Cookie、X Token 或 Ediora 凭据。

## 非目标

- 本次不把草稿自动发布到 X。
- 本次不新增草稿编辑、删除、状态修改或发布状态回写。
- 本次不接入 Ediora 任务认领、轮询或实时推送。
- 本次不支持线程拆分、图片上传、视频、投票或 X Articles。
- 本次不引入 React、构建工具或第三方 UI 组件库。

## 用户流程

1. 用户在 X 页面加载已解压的“述策助手”插件。
2. 页面右下角显示一个带待发布数量徽标的“述策”悬浮入口。
3. 用户点击入口，工作台展开并请求草稿列表，然后只保留 `status=ready` 的草稿。
4. 左侧默认选中更新时间最新的第一条草稿，右侧显示正文。
5. 用户可以搜索标题/正文，也可以按草稿类型筛选。
6. 用户点击“复制内容”，插件将当前草稿正文复制到系统剪贴板，并显示“已复制”。
7. 用户可点击刷新重新读取草稿列表；左、右两列可以独立滚动，不刷新 X 页面。
8. 用户可在设置中修改 API 地址；保存后重新加载列表。
9. 用户关闭工作台后，入口仍保留；再次打开时重新显示最近一次列表状态并刷新数据。

## 数据与 API

### 草稿接口

使用现有接口：

```text
GET {apiBase}/write/drafts
```

响应结构：

```json
[
  {
    "id": 12,
    "title": "标题",
    "content": "正文",
    "status": "ready",
    "draft_type": "article",
    "updated_at": "2026-08-08T10:00:00+08:00"
  }
]
```

插件只接受对象数组中的必要字段：`id`、`title`、`content`、`status`、`draft_type`、`updated_at`。列表层过滤 `status === 'ready'`，并按 `updated_at` 倒序排列，防止 API 或缓存返回其他状态。旧数据若只有 `draft` 字段，正文读取使用 `content || draft || ''`，但不修改 API 数据。

### API 地址与请求边界

- 默认 API base：`http://localhost:8000/api`。
- 可配置值只允许 `http` 或 `https` URL，自动去掉末尾 `/`。
- MVP 的 manifest 允许默认本机开发 API：`http://localhost:8000/*` 和 `http://127.0.0.1:8000/*`；配置其他远程 API 时显示“需要在 manifest 中增加对应 host permission”，不使用 `<all_urls>`。
- service worker 读取 `chrome.storage.local` 中的 `apiBase`，通过 `fetch` 发起 GET 请求。
- API 请求不附加查询参数，不附加 X Cookie、X Token 或 Worker Token。
- service worker 不打印正文、不把正文写入 `lastExecution`；请求失败只回传状态码和安全错误信息。

### 消息协议

新增扩展内部消息：

```js
{
  type: 'SHUCE_DRAFTS_REQUEST',
  requestId: 'request-id',
  apiBase: 'http://localhost:8000/api',
}
```

成功响应：

```js
{
  type: 'SHUCE_DRAFTS_RESULT',
  requestId: 'request-id',
  ok: true,
  drafts: [],
}
```

失败响应包含 `requestId` 和 `{ ok: false, error: { code, message } }`，不包含请求正文或 API 响应中的敏感字段。

## UI 设计

### 视觉方向

工作台命名为“述策发布指挥台”，采用深色玻璃面板、轻量蓝紫渐变、青色状态强调和柔和阴影。视觉目标是专业控制台，而不是高亮霓虹玩具：渐变只用于边框、选中态和主按钮，正文区域保持高对比度和易读性。

默认面板使用深色主题，并通过 CSS 变量提供浅色 fallback，跟随 `prefers-color-scheme`。所有文字内容使用 `textContent` 写入，不把草稿 Markdown/HTML 作为可执行 HTML 注入页面。

### 悬浮入口

- `position: fixed; right: 24px; bottom: 24px`。
- 入口为圆角胶囊/按钮，包含小型品牌标识和“述策”文字。
- 右上角徽标显示当前已加载的待发布数量。
- 入口点击切换工作台展开状态；展开时入口变成收起按钮。
- 入口和工作台都放在独立 Shadow DOM 中，避免继承 X 的全局 CSS。

### 工作台布局

展开面板约 `760px × 640px`，最大不超过视口宽高的 90%，窄屏自动变为全宽底部面板。

```text
┌─────────────────────────────────────────────────────────────┐
│  述策发布指挥台       12 条待发布    ⟳ 刷新    ⚙ 设置    ×  │
├──────────────────────┬──────────────────────────────────────┤
│ 搜索草稿              │ 文章标题                             │
│ [全部][文章][X]...    │ 文章 · 2026-08-08 18:20              │
│                      │ ───────────────────────────────────  │
│ ● 标题一              │                                      │
│   文章 · 2分钟前      │ 正文预览                             │
│                      │                                      │
│ ○ 标题二              │                                      │
│   X · 12分钟前        │                                      │
│                      │                                      │
│                      │                         [复制内容]   │
└──────────────────────┴──────────────────────────────────────┘
```

- 左列宽度约 `260px`，独立滚动；右列展示当前选择。
- 列表行包含标题、类型标签、相对更新时间和选中高亮。
- 右侧正文使用等宽/阅读友好的字体组合，保留换行，显示字符数。
- 复制按钮固定在右侧底部，用户滚动正文时仍可操作。
- 空状态显示“暂无待发布草稿”和刷新按钮。
- 加载状态使用骨架行，错误状态显示 API 地址和重试按钮，不弹浏览器 alert。

### 设置

设置按钮打开工作台内的小型设置层，不使用浏览器新窗口或抽屉：

- API 地址输入框。
- 当前使用的 API 地址。
- 保存并刷新按钮。
- 恢复默认地址按钮。

保存失败时保留用户输入，不覆盖原配置。API 地址只保存在 `chrome.storage.local`，不记录草稿正文。

## 模块边界

- `chrome-extension/content/workbench.js`：Shadow DOM 悬浮入口、面板 DOM、交互状态和复制操作。
- `chrome-extension/content/draft-model.js`：草稿数据归一化、状态过滤、排序、类型筛选和搜索纯函数。
- `chrome-extension/content/draft-client.js`：向 service worker 发送带 requestId 的草稿请求，处理超时和结构化错误。
- `chrome-extension/background/service-worker.js`：读取 API 配置、执行草稿 GET 请求、返回安全响应；保留现有发布状态记录逻辑。
- `chrome-extension/content/bridge.js`：保留现有控制台发布桥；不把草稿正文转发到页面 world。
- `chrome-extension/manifest.json`：增加 `workbench.js` content script、默认本机 API host permissions 和新增可访问资源。
- `chrome-extension/tests/draft-model.test.js`：归一化、过滤、排序和搜索测试。
- `chrome-extension/tests/draft-client.test.js`：消息协议、requestId、超时和错误测试。
- `chrome-extension/tests/workbench.test.js`：面板渲染、选择、复制和设置交互测试。
- `chrome-extension/tests/manifest.test.js`：新增入口、API host、无第三方网络和无敏感凭据断言。
- `chrome-extension/README.md`：更新 API 配置、悬浮面板和常见故障排查。

## 错误处理

- `DRAFT_API_NOT_CONFIGURED`：API 地址为空或格式非法。
- `DRAFT_API_HOST_NOT_ALLOWED`：配置的 API origin 不在扩展允许范围内。
- `DRAFT_API_UNAVAILABLE`：网络失败、超时或非 2xx 响应。
- `DRAFT_API_INVALID_RESPONSE`：响应不是数组或条目没有有效 id。
- `DRAFT_EMPTY`：接口成功但没有 `status=ready` 草稿。
- `CLIPBOARD_FAILED`：剪贴板 API 和 fallback 都失败，保留正文供用户手动复制。

所有错误只展示可操作的中文提示；不展示完整 URL 查询参数、响应正文或任何凭据。

## 测试与验收

自动化验收：

- `cd chrome-extension && npm test` 全部通过。
- 所有 background/content/injected JavaScript 通过 `node --check`。
- `git diff --check` 无空白错误。
- 静态检查确认运行时代码没有 Cookie、X Token、第三方 API 或 `<all_urls>`。

手动验收：

1. 在 `chrome://extensions/` 加载 `chrome-extension/`。
2. 打开 X 页面，确认右下角出现述策入口。
3. API 服务运行时打开面板，确认只展示 `status=ready` 的全部类型草稿。
4. 搜索、类型筛选、选择草稿以及左右栏滚动均不刷新 X 页面。
5. 点击复制后粘贴到文本编辑器，确认只包含正文、不包含标题和 HTML 标签。
6. 修改 API 地址、保存、刷新，确认列表从新地址读取。
7. 停止 API 服务，确认面板展示错误和重试按钮，X 页面仍可正常使用。

## 兼容性与后续

本次不做真实发布按钮，复制后仍由现有 `Shuce.publish()` 或用户手动完成发布。后续若需要把草稿行直接送入发布流程，可以在不改变数据客户端和 UI 状态边界的前提下增加“发送到编辑器/安排发布”动作。
