# 任务看板：创作任务与定时 Job 日志设计

日期：2026-08-05

## 目标

修复定时创作任务最终产出无法落库的问题，并将现有“任务安排”页面重构为“任务看板”，让用户在一个页面内看到规则、今日运行状态、产出数量、下一次执行时间和 Job 失败原因。

## 当前问题证据

2026-08-05 20:00（Asia/Shanghai）的规则“X每日搞钱帖”已经创建 run 24 和 content job 931。Agent 成功读取素材并生成 10 条帖子，但 `save_daily_creation_outputs` 连续失败，最终 run 24 为 failed、created_count 为 0，且没有 output batch 或 usage 记录。

失败有两层：

1. 运行中的 PostgreSQL 表 `daily_creation_output_batches` 还保留旧的 `plan_item_ids` 非空字段，而当前模型和保存代码已经移除该字段，INSERT 时产生 NULL 约束错误。
2. Agent 为兼容旧计划尝试写入数组型 `metadata.plan_item_ids`，当前服务要求 metadata 的每个值都是字符串，导致第二类校验错误。

Job 失败时，Agent execution 仍保持 running，造成任务看板无法准确表达最终状态。

## 范围

### 包含

- 为 `daily_creation_output_batches` 增加兼容迁移，移除已经废弃的 `plan_item_ids` 数据库字段，并让新旧 SQLite/PostgreSQL 数据库都能完成初始化。
- 让每日创作保存服务只接受当前仍有业务意义的 `topic`、`angle` 字符串元数据；忽略旧计划字段，避免旧 Agent 输出阻断最终保存。
- Job 失败时同步将 Agent execution 标记为 failed，并保留错误摘要。
- 新增创作任务看板聚合接口，返回规则、运行记录、Job steps/events、Agent 工具调用摘要和 `daily_creation` 调度日志。
- 页面标题改为“任务看板”，增加头部统计卡片、定时任务列表和可展开的运行日志。
- 支持手动刷新；页面在打开状态下每 30 秒刷新一次运行数据，操作规则后立即刷新。

### 不包含

- 不自动重跑已经失败的今天任务，避免重复调用模型或重复生成草稿。
- 不恢复旧 daily plan / plan item 业务模型。
- 不新建独立日志服务；继续使用现有 `CollectLog`、`ContentJobEvent`、`ContentJobStep` 和 Agent tool call 数据。
- 不改变规则编辑表单的业务字段。

## 后端设计

### 1. 数据库兼容迁移

在数据库初始化迁移中检查 `daily_creation_output_batches` 的旧 `plan_item_ids` 列：

- PostgreSQL 使用 `ALTER TABLE ... DROP COLUMN IF EXISTS plan_item_ids`。
- SQLite 使用项目已有的方言兼容迁移方式完成同等结果。
- 迁移必须幂等；全新数据库不应创建该列，已有历史 batch 即使没有该列也不能失败。

模型 `DailyCreationOutputBatch` 保持当前字段集合，不重新引入 `plan_item_ids`。

### 2. 最终输出保存契约

`_normalize_agent_post` 保持 source asset、正文、去重决策和 compared usage 的严格校验。metadata 只保留：

```python
{
    "topic": "...",
    "angle": "...",
}
```

未知 metadata 键（包括 `plan_item_id`、`plan_item_ids`）被忽略；`topic` 和 `angle` 只有在值为字符串时才使用，否则使用现有 fallback。这样可以兼容模型携带旧上下文，同时不把旧计划字段写入当前创作产出。

### 3. Agent 状态收敛

新增 worker-only `failAgentExecution` API 和客户端调用。`runDailyCreationAgentJob` 捕获最终错误时按以下顺序处理：

1. 将 Agent execution 标记为 failed，保存截断后的错误摘要和完成时间。
2. 将当前 Agent step 标记为 failed。
3. 由现有 Job 失败逻辑收敛 ContentJob 和 DailyCreationRun 状态。

如果 Agent execution 已经是 terminal 状态，失败收敛操作保持幂等。

### 4. 任务看板聚合接口

新增：

```text
GET /api/creation-rules/dashboard?date=YYYY-MM-DD&limit=50
```

返回结构：

```ts
type CreationDashboard = {
  date: string
  summary: {
    enabled_rules: number
    scheduled_runs: number
    queued: number
    running: number
    succeeded: number
    partial: number
    failed: number
    requested_count: number
    created_count: number
    next_run_at: string | null
  }
  rules: DailyCreationRule[]
  runs: Array<DailyCreationRun & {
    job: {
      id: number | null
      status: string | null
      started_at: string | null
      completed_at: string | null
      steps: Array<{
        key: string
        attempt: number
        status: string
        started_at: string | null
        completed_at: string | null
        error: string
      }>
      events: Array<{
        kind: string
        payload: Record<string, unknown>
        created_at: string
      }>
    } | null
  }>
  scheduler_logs: Array<{
    status: string
    message: string
    detail: string
    created_at: string
  }>
}
```

接口在服务端按 run/job ID 批量读取关联数据，避免前端对每条运行记录发起 N+1 请求。日志内容继续经过现有错误脱敏边界，不返回凭据。

## 前端设计

### 页面结构

页面标题为“任务看板”，副标题说明当前查看日期和自动刷新状态。

头部仪表盘使用 5 张紧凑统计卡片：

1. 已启用规则
2. 今日计划
3. 执行中 / 排队中
4. 今日产出
5. 成功 / 失败

仪表盘下方为双栏布局：

- 左栏“定时任务”：保留规则卡片、立即执行、编辑、暂停/开启、删除、新建规则；规则卡片增加今日运行状态和下一次执行时间。
- 右栏“运行日志”：按时间倒序展示今日 run。每行显示规则名、计划时间、Job ID、状态、产出数量和最近步骤；点击展开显示 steps、错误信息、调度日志以及 Agent tool call 摘要。

空状态需要区分：没有规则、今天尚未调度、今天有失败但没有产出。

### 交互与性能

- 首次加载并行请求看板数据、素材目录和 Skill 列表。
- 规则操作成功后重新请求看板数据，不在本地拼接运行状态。
- 自动刷新只更新看板数据，不重置正在编辑的规则对话框。
- 将日志行拆为独立组件，避免整个页面因单个展开项变化而重复渲染。
- 长日志只默认显示摘要，错误详情和工具调用通过展开区域查看。

## 测试策略

### 后端

- 迁移测试：旧 batch 表存在 `plan_item_ids` 时初始化后字段被移除；重复初始化通过。
- 保存测试：带数组型旧计划 metadata 的帖子仍能保存；未知 metadata 不进入 `posts_data`；topic/angle 字符串仍正确写入 usage。
- Agent 状态测试：Job runner 失败后 Agent execution 为 failed，错误被保存且重复调用不改变 terminal 状态。
- 看板接口测试：统计 queued/running/succeeded/partial/failed、产出数、下一次执行时间和关联 steps/events。

### 前端

- API 类型和看板聚合数据渲染测试。
- 统计卡片、规则列表、运行日志展开和失败详情测试。
- 保留现有规则编辑、立即执行和暂停操作测试。

### 浏览器验证

验证流程：进入 `/creation-rules` → 页面显示“任务看板” → 查看统计卡片 → 展开失败运行日志 → 确认 Job step 错误和产出数量可见 → 暂停/开启规则后看板刷新。

