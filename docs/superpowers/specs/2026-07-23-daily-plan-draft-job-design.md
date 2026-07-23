# 日计划 draft 作业衔接设计

## 目标

让日计划的“开始创作”创建 AI SDK worker 已支持的 `draft` 作业，不再创建已废弃的 `topic_long` 或 `topic_short` flow。

## 范围

- 保留日计划的分组、一稿多发、账号选择和 `PipelineTask` 关联语义。
- 将每个分组 leader 的写作上下文（账号画像、内容类型、字数范围、角度和来源）作为 `draft` 作业输入。
- 将 `DailyPlanItem.pipeline_task_id` 写为新作业 ID，维持现有页面与状态字段兼容。
- 不修改普通手动创作、封面或配图作业。

## 数据流

`POST /daily-plan/{plan_id}/enqueue` 读取计划项和账号，按现有 group_key 分组；每组调用 `routers.studio._run_pipeline_chain("draft", context, ...)`。该兼容函数创建 `ContentJob(flow="draft")` 并投递 Redis。Node worker 依次完成 `brief` 和 `draft`，通过写作 API 保存草稿。

## 错误处理与验证

- 无账号、无可入队项等既有 400 校验保持不变。
- 任务创建失败仍返回 500，并且不将条目标为 enqueued。
- 回归测试断言长文和短文计划项都创建 `draft` 作业，作业输入保留 `content_type`、`word_range`、`angle` 和来源。
