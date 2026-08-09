# “值得写”完整文章写作 Job 设计

## 目标

情报中心点击“值得写”后，不再直接创建只包含 AI 分析提纲的草稿；它应创建一个 `expanded_article` 写作 job，由 worker 生成完整中文文章，成功后将文章落入草稿箱，并保留任务状态与草稿链接。

## 现状与问题

当前“值得写”按钮调用 `/responses/{item_id}/destination` 的 `draft` 分支。该分支使用分析结果拼接“核心判断、价值点、建议结构”等结构化种子，没有把文章交给写作模型，因此草稿不是完整文章。

项目已有 `content_response_output` durable job：它可以读取情报原文和 AI 评价，生成 `expanded_article`，并通过 worker-result 创建 `ArticleDraft`。本次改动复用这条链路。

## 设计

### 用户动作与状态

- 点击“值得写”或使用快捷键 `1`，直接提交 `expanded_article` 输出任务，不再弹出“结构化草稿种子”确认框。
- 任务提交成功后，情报中心展示“写作中”；不自动发布。
- worker 成功后，输出记录关联新草稿，情报中心展示“已进入草稿箱”链接。
- worker 失败时保留失败 job 状态，情报中心展示失败提示；任务仍可从任务看板按现有机制重试。
- “创作资产”继续使用原有对话框，将完整原文和 AI 评价保存为资产。

### 数据流

```text
值得写 / 快捷键 1
  -> POST /responses/{id}/outputs
  -> ContentResponseOutput(output_type=expanded_article)
  -> ContentJob(flow=content_response_output)
  -> worker prepare context + generate article + save output
  -> POST /responses/outputs/{output_id}/worker-result
  -> ArticleDraft(content=完整生成文章)
  -> ContentResponseItem.destination=(draft, draft_id)
```

输出任务使用分析 run 的当前版本和原文来源；重复点击使用现有 output 唯一约束与幂等逻辑，不创建重复 job 或重复草稿。

### API 与前端契约

- 前端增加 `createResponseOutputs` API 类型，固定提交 `output_types: ['expanded_article']`。
- response detail 的 `outputs` 返回输出状态、job 状态、job id、草稿 id 和错误信息。
- worker-result 成功时设置 `ContentResponseItem.destination_type='draft'`、`destination_id`，并记录完成事件。
- 输出排队后决策状态保持为 `worth_writing`，避免继续使用已被迁移逻辑淘汰的 `adopted`。
- 旧的直接 draft destination 不再由情报中心使用；为避免新入口绕过写作 job，API 不再创建结构化草稿。

## 验收标准

1. 点击“值得写”只创建一个 `content_response_output` + `content_response_output` job，输出类型为 `expanded_article`。
2. worker 上下文包含完整来源和 AI 评价；生成结果成功后创建 `ArticleDraft`，正文不是结构化种子，而是完整 Markdown 文章。
3. 完成回调幂等：重复回调不会创建第二篇草稿，并返回原草稿 id。
4. 情报中心能显示排队、完成、失败状态，并在完成后链接到草稿箱。
5. 创作资产流程、暂不处理流程、现有 worker 重试机制不回归。

## 测试策略

- Python service/router 测试 output job 创建、`worth_writing` 状态、幂等回调与草稿落库。
- TypeScript worker 测试 `expanded_article` 仍要求完整 Markdown 且禁止发布。
- React 测试按钮与快捷键提交 output API，不再打开结构化草稿种子对话框，并渲染任务状态/草稿链接。
- 运行定向 Vitest、pytest、ESLint、TypeScript 构建检查和必要的 Playwright 页面回归。
