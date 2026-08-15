# 述策助手“发布并下一条”设计规格

## 背景

Chrome 插件的悬浮发布指挥台目前从 Ediora 草稿 API 读取 `status=ready` 的草稿，并提供原文查看和复制。用户在 X 页面完成实际发布或安排后，还需要回到系统手动把草稿改成已发布，导致连续处理多条内容时中断。

系统已有 `published` 草稿状态和 `PATCH /api/write/drafts/{draft_id}` 接口。本次只在插件中增加一个受限的“发布”动作：把当前草稿标记为 `published`，然后在当前排序/筛选结果中选中下一条待发布草稿。

## 目标

1. 在正文预览底部增加“发布并下一条”按钮。
2. 点击后只将当前草稿状态更新为 `published`，不自动操作 X DOM、不调用 DevTools、不新增 `window` 接口。
3. 状态更新成功后，从插件内存列表移除当前草稿，并选中当前列表中的下一条。
4. 当前草稿是最后一条时，不循环回第一条；列表为空时显示空状态。
5. 更新失败时保留当前草稿和正文，展示安全错误提示，允许重试。
6. 保留“复制内容”能力，复制和状态更新互不耦合。

## 非目标

- 不实现 X 的真实发布、安排发布或发布结果检测；这些仍由用户在 X 页面完成。
- 不修改后端草稿状态枚举、数据库模型或后端接口行为。
- 不开放通用状态修改能力；插件动作固定提交 `status=published`。
- 不恢复已删除的 DevTools、控制台或 `window.Shuce` 接口。

## 交互规则

### 成功路径

1. 插件显示一条 `ready` 草稿时，底部显示“复制内容”和“发布并下一条”。
2. 点击发布后，两个动作按钮进入禁用状态，发布按钮显示处理中状态。
3. 发布请求进行中时，左侧列表项也暂时不可切换，保证响应仍然对应用户刚确认的草稿。
4. service worker 通过本地 API 发起 `PATCH /write/drafts/{id}`，请求体固定为：

   ```json
   { "status": "published" }
   ```

5. API 成功返回后，插件根据点击前的当前可见列表计算下一条：当前项后面的第一条；成功后删除当前项并选中该条。
6. 如果没有下一条，则删除当前项并清空选中项；提示“已标记为已发布”。

### 失败路径

- API、消息通道或响应格式失败时，当前草稿仍保留，选中项不变，按钮恢复可用。
- 错误提示只显示安全的固定文案，不向页面暴露响应正文或草稿正文。
- 发布操作进行中再次点击无效。

### 筛选和排序

- 下一条依据当前列表顺序和当前搜索/类型筛选后的可见结果计算。
- 当前项从 `state.drafts` 移除后，搜索词和类型筛选保持不变。
- 不自动重新拉取列表，避免最后一条成功后被现有“无选中项则默认第一条”的刷新逻辑循环选回；用户仍可通过刷新按钮同步服务端列表。

## 技术设计

### API 层

在 `chrome-extension/background/draft-api.js` 增加 `publishDraft(apiBase, draftId)`：

- 复用现有本地 API 地址校验和超时控制。
- 校验 `draftId` 为正整数。
- 使用 `PATCH ${normalized}/write/drafts/${draftId}`。
- 请求头为 `Accept: application/json`、`Content-Type: application/json`。
- 请求体固定为 `{"status":"published"}`。
- 检查 HTTP 成功和 JSON 对象响应，并只返回 `SAFE_FIELDS` 中的字段。

### 扩展消息层

在 `draft-client.js` 和 `background/service-worker.js` 增加专用消息类型 `SHUCE_DRAFT_PUBLISH`。消息携带 `apiBase`、`draftId` 和 `requestId`；响应复用 `SHUCE_DRAFTS_RESULT` 外壳，成功返回 `draft`，失败返回已有安全错误结构。

不增加任意 status 参数，防止插件 UI 意外修改为 `drafting`、`archived` 等其他状态。

### 状态层

在 `workbench-state.js` 增加纯函数 `publishDraftAndSelectNext(state, draftId)`：

- 使用当前 `getVisibleDrafts(state)` 找到目标位置。
- 目标不存在时原样返回。
- 删除目标后，选择其后一项；没有后一项则选择 `null`。
- 清理 `copyState`，避免已复制状态泄漏到下一篇。

在 `createWorkbenchState` 增加 `publishingId`，用于渲染禁用和处理中状态；成功/失败路径都清除该字段。

### UI 层

在 `workbench-runtime.js`：

- 预览底部改为两个按钮：`复制内容` 和 `发布并下一条`。
- 当前无选中草稿、内容不存在或发布中时，发布按钮禁用。
- 发布成功后使用状态纯函数更新界面并提示；失败则保留当前预览并提示错误。
- 列表数量和徽标随内存列表立即更新。

## 验证标准

- API 单元测试验证 PATCH URL、方法、请求体、响应清洗、HTTP 错误和非法 ID。
- client 单元测试验证发布消息类型、请求参数、成功响应和错误映射。
- state 单元测试验证中间项、最后一项、目标不存在和筛选结果下的下一条选择。
- 现有扩展测试全部保持通过。
- 所有仍被 manifest 加载的 JavaScript 文件通过 `node --check`。
- `git diff --check` 无空白错误。
- 文档明确说明插件按钮是“标记已发布”，不执行 X 的实际发布动作。
