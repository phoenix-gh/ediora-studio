# Chat 草稿写回审批渲染修复设计

## 问题

全局 Chat 调用 MCP `update_draft` 时，后端和 AI SDK 正确产生并持久化了 `type: "dynamic-tool"`、`state: "approval-requested"` 的工具部件。前端 `ChatClient` 的 `isToolPart()` 只接受 `tool-event`、`tool-result` 和 `tool-*`，因此排除了 `dynamic-tool`。工具活动区域和“批准 / 拒绝”按钮没有渲染，用户无法批准写回，草稿保持不变。

最新会话 17 中的消息 137、139、141 均保留了待批准的 `update_draft` 参数；草稿 185 的更新时间仍早于这些会话消息，证明写回未执行。

## 方案

在 `wemedia-studio/app/chat/ChatClient.tsx` 中让工具部件判定同时接受 `dynamic-tool`。继续复用已有 `ToolActivityGroup`、`respondToApproval()` 和服务端 `persistApproval()`，不新增绕过审批的写回通道。

不自动批准历史请求，不直接修改草稿 185，不改变 `requiresToolApproval("update_draft") === true` 的策略。修复上线后，重新打开会话即可看到历史待批准操作的按钮，由用户决定批准或拒绝。

## 测试

把工具部件判定提取为可直接测试的纯函数，并新增回归测试，验证：

- `dynamic-tool` 被识别为工具部件；
- 普通 `text` 和 `step-start` 不被误识别；
- 现有 `tool-event`、`tool-result`、`tool-*` 兼容行为保持不变。

运行 Chat 聚焦测试与前端完整 Vitest，随后在浏览器重新打开最新会话，确认 `update_draft` 显示“批准 / 拒绝”按钮。测试过程中不点击批准，避免修改真实草稿。
