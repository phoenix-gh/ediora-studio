# X 订阅已有帖子素材入库补处理设计

## 背景

X 订阅的 AI 素材入库目前会随着新帖子采集触发 `topic_source` Agent，但在订阅配置素材入库规则之后，数据库中已经存在的帖子不会自动再次进入这条链路。需要提供一个按时间窗口执行的一次性补处理入口，并保证已经有最终入库决策的帖子不会重复处理。

## 目标

在 X 订阅编辑对话框中增加“补处理已有帖子”操作，按用户指定的最近天数查询当前订阅已保存的帖子，跳过已有 `AssetIngestionDecision` 的帖子，并把剩余帖子送入现有 `topic_source` Agent 流程。

## 交互设计

- 入口位于 X 订阅编辑对话框的“采集操作”区域，仅编辑已有订阅时显示。
- 提供“补处理天数”输入框，默认 7 天，允许 1–90 天整数。
- 按钮文案为“补处理已有帖子”；执行中显示加载状态并禁用按钮。
- 操作说明明确：不重新采集 X，只处理本地已保存帖子；已经有入库决策的帖子会跳过。
- 成功提示显示时间窗口、待处理帖子数、跳过数和创建的 Agent 任务数。
- 没有待处理帖子时不创建任务，并提示“没有待处理的帖子”。

## 后端设计

新增 X 订阅补处理接口：

```text
POST /api/x/subscriptions/{sub_id}/ingestion-backfill
body: { "days": 7 }
```

处理规则：

1. 订阅不存在返回 404。
2. `days` 由 Pydantic 限制为 1–90。
3. 查询该订阅 `published_at >= now - days` 的 `XPost`，按发布时间倒序。
4. 通过 `NOT EXISTS` 排除同一订阅下已经存在 `AssetIngestionDecision(subscription_id, tweet_id)` 的帖子。`directory_id = null` 也代表已做出“不入库”决策，必须跳过。
5. 如果该订阅没有有效的 AI 入库目录，返回 422，不创建任务。
6. 剩余帖子按 50 条分批复用 `dispatch_topic_source_posts`，每批生成一个现有 `topic_source` Agent 任务。
7. 任务仍使用现有的订阅目录快照、候选过滤、AI 评价和最终入库接口；补处理不改变情报分析任务。
8. 任务幂等键继续由订阅 ID 和批次 tweet ID 生成。重复点击时，已产生决策的帖子会被排除；尚未完成的相同批次由现有幂等键保护，不再创建重复任务。

返回结构：

```json
{
  "ok": true,
  "days": 7,
  "candidate_count": 120,
  "skipped_count": 35,
  "created": 3,
  "enqueued": 3,
  "errors": []
}
```

其中 `candidate_count` 是窗口内未有决策的帖子数量，`skipped_count` 是窗口内已有决策的帖子数量；任务入队错误保留在 `errors` 中并返回，已创建的数据库任务仍可由现有 reconciliation 流程处理。

## 数据流

```text
订阅编辑对话框
  -> POST ingestion-backfill(days)
  -> 查询 XPost + 排除 AssetIngestionDecision
  -> 50 条一批 dispatch_topic_source_posts
  -> ContentJob(flow=topic_source)
  -> Agent GET /assets/ingestion/candidates
  -> Agent 评价文章归属/提示词
  -> POST /assets/ingestion/accepted
```

## 错误和边界

- 输入天数无效由接口返回 422，前端在提交前也做同样校验。
- 没有配置入库目录时不静默创建空任务，返回明确的 422。
- 帖子正文为空的过滤仍由现有候选接口处理，不在补处理接口复制 AI 规则。
- 只以 `AssetIngestionDecision` 作为“已经处理过”的判定，不以是否已经生成资产作为判定，避免失败或“不入库”结果被反复提交。

## 测试范围

- 后端服务测试：窗口过滤、已决策帖子跳过、分批 dispatch、重复调用不产生重复任务、无入库目录错误。
- X 路由测试：接口参数校验、订阅不存在、成功返回统计信息。
- 前端对话框测试：默认 7 天、调用回调传入订阅和天数、执行状态禁用按钮、错误提示。
- 仅运行与本功能直接相关的后端和前端测试，不执行全量测试套件。
