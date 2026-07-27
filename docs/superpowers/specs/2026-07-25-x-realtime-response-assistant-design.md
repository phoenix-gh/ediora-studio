# X 即时响应助手设计

## 目标

把现有“指定 X 订阅 + 新帖回复提醒”升级为一个面向中文科技账号的即时响应助手。
用户可以为任意少数高价值 X 订阅单独开启该能力。系统在采集到新帖后判断它是否
值得立即评论、翻译引用转发、继续观察或忽略，并把高价值判断和可复制中文草稿直接
推送到 Telegram。

首版只提供判断和草稿，不调用 X 发布接口。最终发布必须由用户打开原帖、复制草稿并
手动完成。

成功标准：

- 指定订阅的新帖被采集后 60 秒内完成判断；受 5 分钟采集周期约束，从原帖发布算起
  通常在 1–6 分钟内收到高价值提醒。
- Telegram 消息直接包含推荐动作、理由和可一键复制的中文草稿。
- 中低价值内容不造成即时通知轰炸，但在 Web 中保留完整判断。
- 同一帖子在任务重试、服务重启或重复采集后不会产生重复判断和重复即时推送。
- 正常运行不依赖 Hermes。

## 首版范围

### 包含

- 任意 `timeline` 类型 X 订阅可单独开启“即时响应”，默认关闭。
- 所有面向用户的评论稿和翻译引用转发稿统一使用中文。
- 产品名、模型名、API 名和必要技术术语保留英文。
- 四种互斥主要动作：立即评论、翻译引用转发、继续观察、忽略。
- 高价值即时 Telegram 推送、中等价值每日摘要、低价值仅 Web 留档。
- Web“待响应”收件箱和采用、忽略、转为选题三种反馈。
- 官方链接的受限读取、核实状态和失败降级。
- 直接使用 Telegram Bot API，替换现有 `hermes send` 通知路径。

### 不包含

- 自动评论、自动转发或任何无人确认的 X 发布。
- 秒级流式监听。首版继续复用约 5 分钟轮询采集。
- 跨账号、跨平台事件聚类。数据模型保留未来关联事件的空间，但本次不实现。
- 面向用户的评分阈值编辑器。首版采用固定默认阈值，根据真实反馈再调整。
- Telegram 内完成完整工作流。Telegram 负责提醒和复制，Web 是记录与反馈的
  source of truth。

## 用户流程

1. 用户在 X 订阅列表中为少数高价值账号开启“即时响应”。
2. X 采集器按现有周期采集该账号；只有开启时刻以后采集到的原创新帖进入响应链。
3. 新帖提交成功后立即入队一个响应判断任务。
4. 系统读取帖子、账号上下文和可用的外部官方链接，产出结构化判断。
5. 高价值判断立即写入 Web 并推送 Telegram；中等价值进入 Web 和当日摘要；低价值
   仅进入 Web。
6. 用户从 Telegram 复制建议并手动在 X 发布，随后可在 Web 标记“已采用”。
7. 用户也可以忽略判断，或把具有长期内容价值的帖子“转为选题”。

## 架构与职责边界

```text
X subscription collector
  -> persist new XPost
  -> enqueue x_response decision job
  -> deterministic eligibility filter
  -> bounded link verification
  -> structured AI decision
  -> persist XResponseDecision
       -> immediate: Telegram notifier
       -> digest: daily Telegram digest
       -> silent: Web only
  -> Web feedback / convert to topic

Reconciliation scheduler
  -> find eligible posts without a decision
  -> enqueue missing jobs idempotently
```

### X 采集器

继续只负责采集和持久化，不在采集函数中直接调用模型或 Telegram。事务提交成功后，
为本次新增且符合订阅开关的帖子入队判断任务。这样避免现有“采集定时器 + 提醒定时器”
串联造成接近 10 分钟的最坏延迟。

### 资格过滤器

在调用模型前执行确定性过滤：

- 订阅已启用且“即时响应”开关已开启；
- 帖子在开关开启后采集；
- 只处理原创新帖，不处理目标账号发出的回复；
- 排除超过 48 小时的积压内容；
- 帖子尚无有效响应判断；
- 同一 `tweet_id` 的任务使用稳定幂等键。

搜索型订阅不进入首版即时响应，避免把关键词搜索结果误当作指定账号官方动态。

### 链接核实器

当帖子包含外部链接，并且初步看起来可能需要立即评论或翻译引用时，系统读取链接
正文作为判断证据。读取必须限制超时、重定向次数、响应体大小和内容类型，并阻止访问
本机、内网、云元数据地址及其他非公网目标。

核实结果分为：

- `verified`：成功读取并能支持草稿中的核心事实；
- `not_required`：帖子正文已足够，或没有外部链接；
- `unverified`：链接读取失败、正文不足或证据矛盾。

`unverified` 不允许输出确定口吻的翻译稿，动作降级为“继续观察”。Web 可以展示原因，
但不发送可直接发布的误导性文案。

### 响应评估器

评估器使用有界、结构化模型调用，只返回约定 JSON，不允许写数据库或直接发送通知。
输入包括：

- X 帖子正文、作者、发布时间和当前互动数据；
- 订阅标签和原帖 URL；
- 已核实链接的标题、摘要和规范 URL；
- 一个全局目标 X 发布账号画像；若尚未配置，则使用固定的“中文科技从业者”中性
  画像。

首版不为每个订阅配置不同目标账号，避免设置复杂度。全局目标账号可复用现有
`PublishAccount` 画像，并在 X 设置中选择一次。

### 响应记录

判断结果独立存储，不再继续扩展 `XPost.x_reply_*` 字段。`XPost` 是采集事实，
`XResponseDecision` 是可版本化的模型判断，两者职责分开。

### Telegram 通知器

通知器直接调用 Telegram Bot API，凭据来自服务端环境变量或受保护设置。通知器只消费
已持久化判断，负责消息格式、长度控制、重试和幂等，不负责重新调用模型。

### Web 待响应收件箱

Web 是判断、状态和反馈的完整记录。Telegram 消息链接回对应响应卡片；Telegram 删除、
推送失败或聊天记录过期都不会丢失业务数据。

## 判断合同

模型必须返回以下结构，服务端用 schema 严格校验：

```json
{
  "action": "comment | translate_quote | watch | ignore",
  "score": 0,
  "confidence": 0.0,
  "reason": "为什么采取这个动作",
  "summary_cn": "原帖中文摘要",
  "comment_draft": null,
  "quote_draft": null,
  "claims": [
    {
      "text": "草稿依赖的事实",
      "source_url": "https://official.example/announcement",
      "verified": true
    }
  ]
}
```

约束：

- `action=comment` 时只要求 `comment_draft`；`action=translate_quote` 时只要求
  `quote_draft`。
- 只有两个动作都确实有独立价值时，才允许同时返回两个草稿；UI 仍突出一个主要动作。
- `watch` 和 `ignore` 不生成可直接发布的草稿。
- 评论必须提供具体信息、问题或观点，不生成“Great”“值得期待”一类空泛互动。
- 翻译引用稿是适合 X 长度限制的忠实中文转述，不擅自补充原帖没有的结论，也不把
  摘要伪装成逐字全文翻译。
- 草稿不得包含“根据 AI 分析”等内部措辞。
- 服务端负责最终长度校验；超限输出退回一次修正，仍超限则标记失败，不静默截断。

## 动作规则与通知分级

### 主要动作

- `comment`（立即评论）：原帖存在明确观点、问题或争议点，并且目标账号能够补充
  有价值的中文观点。
- `translate_quote`（翻译引用转发）：模型发布、API 变化、价格调整、重要功能、
  政策或研究成果等具有明确中文传播价值的事实性消息。
- `watch`（继续观察）：预告、证据不足、链接无法核实、信息可能很快变化，或需要等待
  官方文档。
- `ignore`（忽略）：普通营销、重复宣传、日常互动、低信息量内容，或与目标受众无关。

### 评分

`score` 为 0–100，综合：

- 来源权威度；
- 与目标中文科技受众的相关性；
- 相对已有公开信息的增量；
- 时间敏感度；
- 可提供的评论空间或翻译传播价值；
- 误读、事实变化和品牌风险。

`confidence` 为 0–1，表示证据是否足以支持当前动作和草稿。

首版固定分级：

- `score >= 75` 且 `confidence >= 0.70`：即时 Telegram 推送；
- `50 <= score < 75`：进入 Web，并在每天 18:00（Asia/Shanghai）进入摘要；
- `score < 50`：仅 Web 留档；
- `confidence < 0.70`：无论分数多高都不得立即推送可发布草稿，降级为 `watch`。

这些阈值放在服务端配置常量中并记录 `decision_policy_version`，首版不提供 UI 调整。

## Telegram 消息

Telegram 使用 Bot API 的 HTML 模式。可复制稿件放入独立 `<pre>` 块，所有动态内容先
做 HTML 转义。消息示例：

```text
🔴 建议立即翻译引用转发
价值 88 · 高置信度
来源：Claude
原因：发布新的 API 能力，中文社区尚未广泛传播

原帖摘要
Claude 发布了……

可复制内容
┌────────────────
Claude 刚刚发布了……
└────────────────

查看原帖
查看待响应记录
```

实际消息中的“可复制内容”使用 `<pre>`，Telegram 客户端可直接复制。若评论与引用转发
都值得提供，则使用两个分别标记的 `<pre>` 块。原帖链接和 Web 记录链接单独展示，
不混入草稿。

Telegram 的平台长度限制在发送前计算。超长摘要优先压缩；草稿本身不截断。单条仍然
超限时拆成“判断摘要”和“可复制草稿”两条关联消息，并使用同一个幂等通知键。

中等价值摘要按来源分组，只展示标题、动作、分数和 Web 链接，不在摘要里塞入全部草稿。

## 数据模型

新增 `x_response_decisions`：

- `id`
- `tweet_id`：外键到 `x_posts`，首版唯一；
- `subscription_id`
- `action`
- `score`
- `confidence`
- `reason`
- `summary_cn`
- `comment_draft`
- `quote_draft`
- `claims`：JSON 证据列表；
- `verification_status`
- `verified_urls`：JSON；
- `notification_tier`：`immediate | digest | silent`；
- `workflow_status`：`ready | used | ignored | converted`；
- `model_provider`
- `model_name`
- `prompt_version`
- `decision_policy_version`
- `telegram_status`：`not_required | pending | sent | failed`；
- `telegram_message_ids`：JSON；
- `telegram_attempts`
- `telegram_last_error`
- `notified_at`
- `created_at`
- `updated_at`

保留 `XSubscription.notify_new_posts` 数据并把 UI 文案改为“即时响应”，以减少迁移风险；
代码中逐步使用更明确的领域名称封装它。`notify_enabled_at` 继续作为防止旧帖刷屏的边界。

旧的 `XPost.x_reply_score`、`x_reply_draft`、`x_reply_notified_at` 首版不再写入。迁移时可将
已有数据按 `prompt_version=legacy-reply-scout` 回填到新表；确认新链路稳定后再单独删除旧
字段，不在本功能提交中同时做破坏性删列。

预留可空 `event_id` 字段，未来事件聚类可以把多条判断关联到同一事件；首版不创建事件
表，也不实现聚类逻辑。

## API 与任务

### Python 业务 API

- `GET /api/x/responses`：按状态、动作、分级、订阅和时间筛选。
- `GET /api/x/responses/{id}`：读取完整判断和证据。
- `POST /api/x/responses/{id}/feedback`：提交 `used` 或 `ignored`。
- `POST /api/x/responses/{id}/convert-to-topic`：幂等创建选题并回填关联。
- 现有 X 订阅 PATCH 继续更新 `notify_new_posts` 和 `notify_enabled_at`。

所有写 API 都进行状态校验；重复“已采用”或“转为选题”返回现有结果，不重复创建对象。

### 异步任务

新增 `x_response` job flow：

1. `qualify`：资格过滤；
2. `verify_links`：按需核实外部链接；
3. `decide`：结构化 AI 判断；
4. `persist`：幂等保存响应记录；
5. `notify`：仅即时层级执行 Telegram 通知。

任务复用 Hermes-free 架构的 Postgres + Redis worker、attempt、event 和 retry 语义。模型调用
或 Telegram 失败只让对应步骤失败，重试不得重跑已经成功的步骤。

补偿扫描每 5 分钟查找开启订阅后采集、符合 48 小时窗口、但没有有效判断的帖子，并用
相同幂等键重新入队。每天 18:00 创建一个摘要任务。

## Web 交互

### X 订阅列表

- 把现有“动态通知”改名为“即时响应”。
- 默认关闭；开启时记录 `notify_enabled_at`，不处理历史积压。
- 设置页提供一个全局“建议基于账号”下拉框，复用 active `platform=x` 的
  `PublishAccount` 画像；未选择时明确显示使用中性中文科技画像。
- 首版不展示阈值、模型 prompt 或每订阅语言设置。

### 待响应收件箱

响应卡片显示：

- 来源账号、发布时间、原帖正文和链接；
- 推荐动作、分数、置信度和简短理由；
- 中文摘要及主要草稿；
- 证据链接和 `已核实 / 无需核实 / 未核实`；
- Telegram 推送状态；
- `复制建议`、`打开原帖`、`已采用`、`忽略`、`转为选题`。

默认按“待处理优先、分数降序、发布时间降序”排列。`used`、`ignored` 和 `converted`
保留在历史筛选中，不物理删除。

“已采用”只记录反馈，不表示系统已在 X 发布。“转为选题”进入现有选题/内容任务入口，
并带上原帖、核实链接、摘要和判断理由，避免下游再次从零读取。

## 失败处理与安全

- 模型输出必须通过 schema、动作/草稿组合、分值范围、事实证据和长度校验。
- 结构错误最多自动修正重试一次；仍失败则记录安全错误，不发送 Telegram。
- 外部链接失败或内容矛盾时降级为 `watch`，不生成确定口吻的翻译稿。
- Telegram 发送使用 `decision_id + notification_tier` 作为幂等键。HTTP 超时、429 和 5xx
  采用有上限的指数退避；永久 4xx 显示可操作错误。
- Telegram 失败不回滚判断记录。用户仍可在 Web 查看和复制，后台可单独重试通知步骤。
- Bot Token 和 Chat ID 只存在服务端环境变量或受保护配置中，不返回浏览器、不进入事件
  payload 和日志。
- 外链读取防 SSRF，并限制响应体、超时、重定向和 MIME 类型。
- 记录模型、prompt、策略版本和安全错误，但不在通知或普通日志中泄露密钥和完整模型
  原始响应。

## 测试与验收

### 单元测试

- 资格过滤：开关、开启时刻、原创/回复、48 小时窗口和重复帖子。
- 四种动作的 schema、中文约束、草稿组合和长度校验。
- 75/50 分界、0.70 置信度边界及未核实降级。
- Telegram HTML 转义、`<pre>` 可复制格式、长度拆分和幂等键。
- 外链安全策略，包括内网目标、重定向、超时、超大正文和不支持 MIME。
- feedback 和 convert-to-topic 的状态转换及幂等。

### 集成测试

- 采集新增帖子后立即创建一个且仅一个 `x_response` job。
- worker 重启、任务重试和补偿扫描不会重复判断或推送。
- 高价值立即推送；中等价值只进入摘要；低价值只留 Web。
- 模型失败可重试且不生成半成品通知。
- Telegram 失败保留 Web 记录，重试成功后只产生一次有效通知。
- 官方链接成功核实进入草稿；核实失败降级为 `watch`。

### 真实链路验收

使用一个测试 X 订阅、真实 Postgres/Redis worker 和测试 Telegram chat 完成：

```text
采集新帖
  -> 60 秒内完成判断
  -> Postgres 保存响应记录
  -> Telegram 收到动作、理由、原帖链接和可复制中文草稿
  -> Web 标记已采用
  -> 同一任务重试不重复推送
```

验收同时记录各阶段时间戳：原帖发布时间、采集时间、任务入队时间、判断完成时间和推送
时间，用于确认“采集后 60 秒”和“发帖后通常 1–6 分钟”两个时效口径。

## 迁移与交付顺序

1. 新增响应判断模型、查询/反馈 API 和 Web 收件箱，不改变现有提醒运行。
2. 抽出资格过滤、链接核实和结构化评估器，以测试固定判断合同。
3. 在 X 采集提交后入队 `x_response` job，并增加补偿扫描。
4. 增加直接 Telegram Bot 通知和每日摘要，验证格式、重试和防重复。
5. 将订阅 UI 的“动态通知”切换到新链路，停止写入旧 `x_reply_*` 字段和
   `hermes send` 路径。
6. 完成真实链路验收后，另开清理任务处理旧字段；再根据采用率和误报率决定是否进入
   跨来源事件聚类。

此顺序保证迁移期间现有 X 采集不受影响，并让旧提醒在新链路验证前保持可回退。
