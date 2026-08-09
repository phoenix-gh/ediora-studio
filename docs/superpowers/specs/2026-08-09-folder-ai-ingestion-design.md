# 文件夹级 AI 素材入库设计

## 背景

当前 X 素材入库配置以 `TopicSourceRule` 绑定到单个订阅，目录、关键词和 AI 提示词都属于订阅配置。这种模型无法复用，也无法让一个订阅同时把帖子分类到多个候选目录。

本次调整把“规则”归属到文章素材文件夹：每个文件夹最多有一条 AI 入库配置；X 订阅只选择多个已配置规则的文件夹。采集后的同一批帖子由一次 AI 分析完成最终归类，每条帖子最多进入一个文件夹。

## 目标

- 在素材页的文件夹管理中配置 AI 入库规则。
- X 订阅支持选择多个文章文件夹。
- 一次 AI 分析同时接收所选文件夹的名称、关键词和提示词。
- AI 对每条帖子返回一个最终文件夹，或返回不入库。
- 后端校验 AI 返回的文件夹属于该订阅已选择且启用 AI 入库的文件夹。
- 现有订阅级规则和历史判断记录自动迁移，不影响已排队旧任务。

## 非目标

- 不新增独立的全局“规则库”页面。
- 不让 AI 自由创建文件夹或修改文件夹名称。
- 不允许同一条帖子在一次 X 订阅分析中写入多个文件夹。
- 不改变情报中心的价值分析链路。

## 用户流程

### 配置素材文件夹

素材页的文章文件夹新增/编辑对话框增加“AI 素材入库”区域，包含：

- 启用/停用开关。
- 关键词初筛（可留空，逗号分隔）。
- AI 入库规则提示词（描述什么内容应归入该文件夹）。

配置通过文件夹 ID 关联，因此重命名文件夹不会丢失规则。未启用或没有提示词的文件夹在 X 订阅配置中不可选，并显示原因。

### 配置 X 订阅

X 订阅新增/编辑对话框删除原来的目录、关键词和“保存入库规则”区域，改为文章文件夹多选列表：

- 只展示文章文件夹。
- 已启用 AI 入库且有提示词的文件夹可选。
- 每个文件夹展示名称和规则摘要。
- 保存订阅时提交 `ingestion_directory_ids`，新增和编辑保持同一行为。

### 自动入库

新帖子采集完成后，每个订阅最多创建一个 `topic_source` 分析任务。任务上下文包含：

```json
{
  "subscription_id": 1,
  "directory_ids": [11, 12],
  "tweet_ids": ["tweet-a", "tweet-b"]
}
```

候选接口返回所选文件夹的 ID、名称、关键词和提示词，以及经过关键词初筛后的帖子。AI 必须返回：

```json
{
  "classifications": [
    {"tweet_id": "tweet-a", "directory_id": 11},
    {"tweet_id": "tweet-b", "directory_id": null}
  ]
}
```

`directory_id: null` 表示不入库。Worker 将未返回的帖子视为不入库，并把完整决策提交后端；后端只接受候选目录中的一个 ID，非法 ID、重复帖子或多目录结果都不能写入资产。

## 数据模型

### 文件夹规则

在 `creative_asset_directories` 上增加文件夹级配置字段：

- `ai_ingestion_enabled: boolean`。
- `ai_ingestion_keywords: JSON list`。
- `ai_ingestion_prompt: TEXT`。

规则天然与文件夹一对一，不新增用户可见的全局规则实体。

### X 订阅关联

新增 `x_subscription_ingestion_directories`：

- `subscription_id`。
- `directory_id`。
- `created_at`。
- 唯一约束为 `(subscription_id, directory_id)`。

`XSubscription` API 输出 `ingestion_directory_ids`；新增和 PATCH 接口支持完整替换这个 ID 列表。删除 X 订阅时显式清理关联记录。

### 新决策记录

新增 `asset_ingestion_decisions`：

- `subscription_id`。
- `tweet_id`。
- `directory_id`，可空。
- `created_at`。
- 唯一约束为 `(subscription_id, tweet_id)`。

该唯一约束从数据层保证同一订阅的一条帖子只能有一个最终归属。旧 `topic_source_decisions` 保留给兼容旧任务使用。

## API 设计

- `GET /assets/directories?asset_type=article` 返回 AI 入库字段。
- `PUT /assets/directories/{id}/ingestion-rule` 保存文件夹级配置。
- `GET /assets/directories/{id}/ingestion-rule` 读取文件夹级配置。
- `GET/PATCH/POST /x/subscriptions` 支持 `ingestion_directory_ids`。
- 新的 topic source candidates/accepted 接口按 `subscription_id + directory_ids` 工作；旧 `/assets/topic-rules/*` 路径保留兼容已排队任务和旧客户端。

## 迁移策略

初始化新表/字段后：

1. 找到旧 `topic_source_rules` 指向的文章目录；目录不存在时创建同名文章文件夹。
2. 将每个目录最新的已启用旧规则迁移到文件夹级关键词和提示词。
3. 将旧规则的已启用订阅绑定到对应文件夹。
4. 将旧决策映射到新的 `(subscription_id, tweet_id, directory_id)` 记录；同一订阅同一帖子发生冲突时保留最新决策。
5. 旧表、旧接口和缺少 `subscription_id` 的旧 job 输入继续可读，但新的采集派发只读取文件夹关联表。

如果多个订阅为同一文件夹配置了不同提示词，迁移采用 `updated_at` 最新且启用的规则，并在迁移日志中记录冲突，避免初始化失败。

## 错误处理

- 没有启用的入库文件夹时不创建素材分析任务。
- 文件夹被删除前，如果仍被订阅关联或有 AI 规则，返回冲突并要求先解除配置。
- AI 返回非法文件夹 ID、重复分类或不符合候选目录的结果时，任务失败且不写入任何资产。
- 资产写入仍按目标文件夹执行现有 URL/内容去重。
- 同一帖子已存在决策时，重复任务只返回跳过，不重复创建素材。

## 测试范围

只运行相关聚焦测试：

- 文件夹规则 CRUD、目录重命名/删除约束和初始化迁移。
- X 订阅新增、编辑、返回和清理多文件夹关联。
- 新帖子只生成一个合并分析 job，并携带全部目录 ID。
- Worker 对 AI 返回值的解析、非法目录拒绝、单文件夹落库和重复决策跳过。
- Assets 文件夹配置对话框和 X 订阅多选交互。

不运行与本次改动无关的全量测试。
