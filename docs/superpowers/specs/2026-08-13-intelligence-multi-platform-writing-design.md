# 情报中心多平台独立写作设计

## 目标

将情报中心的“值得写”从固定生成一篇通用长文，改为由用户人工多选目标内容形态。每个目标分别创建 Agent 写作任务，并最终形成一篇带平台标记的独立草稿。

首批目标形态为：

- `x_short_post`：X 短帖；
- `x_article`：X Article；
- `wechat_article`：公众号文章。

## 产品边界

- “值得写”只负责选择创作目标、提交素材快照和创建任务。
- 平台的篇幅、结构、语气、标题、排版等具体写法由 Agent 自主发现并加载相关 Skill 决定，业务代码不复制 Skill 规则。
- 每个目标产生独立任务和独立草稿，不创建平台版本组。
- 平台标记只用于草稿识别、筛选和 Agent 目标表达，不限制发布账号或发布入口。
- 同一条情报可以重复选择同一目标；每次确认都生成新的独立任务与草稿。
- 系统只保存草稿，不自动发布。

## 用户交互

点击“值得写”或快捷键 `1` 后打开“选择创作目标”对话框，而不是立即创建固定长文任务。

对话框提供三个可多选项：

- X 短帖；
- X Article；
- 公众号文章。

用户至少选择一项后才能提交。一次提交中的目标去重；提交成功后关闭对话框并刷新当前情报详情与列表。重复打开对话框并再次选择已有目标是合法的新一轮创作。

## 数据与任务契约

`POST /api/responses/{item_id}/outputs` 继续作为任务创建入口。请求携带当前分析版本和目标数组，不绑定发布账号：

```json
{
  "analysis_run_id": 123,
  "output_types": ["x_short_post", "x_article", "wechat_article"]
}
```

每个目标创建独立的 `ContentResponseOutput` 和 `content_response_output` job。任务上下文固定包含提交时关联的：

- 情报原文和来源元数据；
- AI 评价与证据；
- 目标内容形态；
- response item、analysis run 和 output 的稳定标识。

同一次请求中的重复目标只创建一次；不同请求不复用历史 output，也不复用历史 job。

## Agent 写作契约

Agent Objective 只声明目标内容形态、素材、事实边界和交付要求。Agent 可按目标调用 `loadSkill` 与 `readSkillReference`，具体写法由所加载 Skill 决定。

每个目标必须且只能成功调用一次 `save_draft`，并使用以下草稿类型：

| 输出目标 | `draft_type` | 草稿标记 |
| --- | --- | --- |
| `x_short_post` | `x` | X 短帖 |
| `x_article` | `x_article` | X Article |
| `wechat_article` | `mp` | 公众号文章 |

所有草稿使用 `topic_id=response:{response_item_id}`、`status=drafting`。只有真实 `save_draft` 审计成功并由 worker 将该草稿关联回 output，任务才算完成。

## 草稿与情报展示

草稿箱复用现有 `draft_type` 徽标机制，新增 `x_article` 类型并将旧 `x` 的展示名称明确为“X 短帖”。这些类型不改变发布对话框的账号选择规则。

情报详情展示该条情报创建过的全部输出任务，不再只展示 `expanded_article`。每条状态卡显示目标名称、排队或运行状态、失败原因，以及成功后的草稿链接。

`ContentResponseItem.destination_id` 只能表达一个历史目的地，不能作为多草稿真相来源。多目标及重复生成的完整结果以 `ContentResponseOutput.article_draft_id` 为准；情报详情中的每个输出分别链接自己的草稿。

## 重复、失败与恢复

- 同一 API 请求中的重复类型去重，避免单次误提交创建两份相同任务。
- 新 API 请求始终创建新 output；同一情报可以拥有多个相同 `output_type`。
- 一个目标失败不回滚同批次其他目标。
- 失败任务沿用任务看板的单任务重试机制。
- worker 回调及 `worker-link` 对单个 output 保持幂等，重复回调不能创建或关联第二篇草稿。
- Agent 恢复执行时继续复用已审计成功的 `save_draft`，不得再次保存。

## 兼容性

- 保留历史 `expanded_article`、`commentary`、`x_share`、`x_reply` 和 `x_quote` 数据的读取与展示能力。
- 新“值得写”入口只提交三个新目标类型。
- 创作资产和暂不处理流程不变。
- 不修改发布账号选择或发布能力。

## 验收标准

1. “值得写”打开多选对话框，至少选择一个目标才能提交。
2. 一次选择三个目标会创建三个独立 output 和三个独立 job。
3. 再次选择同一目标会创建新的 output、job 和草稿。
4. Agent Objective 明确目标和对应 `draft_type`，但不硬编码平台写作细节。
5. 三种目标都必须通过真实 `save_draft` 创建草稿，并分别关联回自己的 output。
6. 草稿箱正确显示“X 短帖”“X Article”“公众号文章”标记。
7. 情报详情分别显示全部输出状态及各自草稿链接。
8. 单个任务失败不影响其他任务；重试和 worker 回调保持单 output 幂等。
9. 创作资产、暂不处理和发布账号选择行为不回归。

## 测试策略

- Python service/router 测试多目标创建、跨请求重复创建、单请求去重、三类草稿关联和历史类型兼容。
- Vitest 测试 Agent Objective 的目标与 `draft_type` 映射、真实 `save_draft` 证据和恢复语义。
- React 测试按钮与快捷键打开多选对话框、空选择校验、多目标请求、重复提交以及全部输出状态渲染。
- 草稿箱测试三种类型徽标，不增加发布账号限制。
- 运行相关 pytest、精确 Vitest、ESLint 和必要的构建检查；再通过本地 API/worker 做一条可追踪的真实任务验证。
