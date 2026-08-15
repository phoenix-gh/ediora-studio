# 统一内容响应与 YouTube 字幕分析

日期：2026-07-26
状态：已由用户逐段确认

## 1. 目标

把现有仅面向 X 的“待响应”升级为统一内容响应系统，并为 YouTube 增加自动字幕提取和
内容价值分析。系统需要：

1. 对开启自动分析的 YouTube 频道，在采集到新视频后自动提取字幕；
2. 优先使用平台人工或自动字幕，无字幕时下载音频并调用可配置的 Whisper API；
3. 把原始语言字幕全文和带时间戳分段保存在 `youtube_videos`；
4. 用 AI 提取核心思想、关键论据、价值点、风险和可扩写方向；
5. 分别评价内容本身的价值，以及它对所有启用发布账号的适配度；
6. 不论评分高低，都把分析结果放入统一“待响应”页面；
7. 支持用户标记“采纳创作 / 稍后处理 / 不值得”，并积累反馈数据；
8. 采纳后可生成扩写文章、观点评论或 X 分享草稿，但绝不自动发布；
9. 把现有 X 待响应数据一次迁移到统一模型，切换后不长期双写旧模型。

首版不做视频抽帧和视觉理解。参考
[`bradautomates/claude-video`](https://github.com/bradautomates/claude-video)
的字幕优先、VTT 时间戳解析、YouTube 滚动字幕去重和 Whisper 兜底经验，但在
Ediora 中实现为持久化领域流程，而不是临时命令行 Skill。

## 2. 已确认的产品决策

- 各内容平台保留自己的原始采集表，统一的是分析、待响应、反馈和创作输出层。
- 直接采用全平台统一响应架构，不先做 YouTube 专用待响应表。
- YouTube 字幕属于视频原始内容，保存在 `youtube_videos`。
- 原始字幕保留原语言；AI 分析和创作建议使用中文。
- 完整中文字幕只按需生成，不随每次分析自动生成。
- 频道级提供“自动分析新视频”开关。
- 开关只影响开启后的新视频，不自动补跑存量。
- 存量视频在每个视频项目上提供单条“提取字幕并分析”操作，不提供批量补分析。
- 所有分析结果都进入待响应，包括低价值内容。
- 内容价值和账号适配度分别评分。
- 对所有启用发布账号评分，并推荐最适合的账号。
- 人工反馈使用“采纳创作 / 稍后处理 / 不值得”；不值得可以填写原因。
- 采纳创作时由 AI 预选创作形式，用户可选择扩写文章、观点评论或 X 分享。
- 允许一次选择多个创作形式，每种形式产生独立输出和任务。
- 统一待响应页面采用左侧队列、右侧详情的分栏工作台。
- 现有 X Telegram 即时通知和摘要保留；YouTube 首版不逐条发送 Telegram。
- 第一版积累反馈数据，但不自动训练或微调模型。
- 所有发布行为仍需用户显式确认。

## 3. 架构边界

### 3.1 原始内容层

平台原始表继续负责保存来源事实：

- `x_posts`：X 原帖、作者、互动数据和原始 Markdown；
- `youtube_videos`：视频元数据和当前有效字幕；
- 后续 Reddit、公众号、GitHub 等平台仍使用自己的采集表。

统一响应层不复制平台全部字段，只保存稳定来源引用和分析时的必要快照。

### 3.2 统一响应层

新增五个核心模型：

- `ContentResponseItem`：一条来源内容在统一待响应池中的稳定身份和人工状态；
- `ContentAnalysisRun`：一次不可变的 AI 分析版本；
- `ContentAccountScore`：一次分析对一个发布账号的适配评分；
- `ContentResponseOutput`：采纳后生成的一种创作输出；
- `ContentResponseNotification`：统一记录 Telegram 等通知投递。

现有 `ContentJob`、`ContentJobStep` 和 `ContentJobEvent` 继续作为 durable job
基础设施，不创建第二套任务系统。

### 3.3 来源适配器

统一流程通过受控适配器读取来源内容：

- X 适配器读取 `x_posts`；
- YouTube 适配器读取 `youtube_videos`，需要时执行字幕提取；
- 后续平台通过相同接口增加适配器。

适配器只能访问对应领域服务，不允许模型执行任意 SQL、Shell、文件或 HTTP 请求。

## 4. 数据模型

### 4.1 YoutubeChannel 扩展

| 字段 | 说明 |
| --- | --- |
| `auto_analyze_new_videos` | 是否自动分析新采集视频 |
| `analysis_enabled_at` | 最近一次开启自动分析的时间 |

迁移时所有现有频道的开关默认为关闭，防止上线后自动创建存量任务。新增频道时前端默认
勾选自动分析，但用户可以关闭。

开关从关闭变为开启时写入当前时间；从开启变为关闭时保留最近开启时间。只有新插入且
采集时间不早于当前 `analysis_enabled_at` 的视频才自动创建任务。

### 4.2 YoutubeVideo 字幕字段

| 字段 | 说明 |
| --- | --- |
| `transcript_status` | `not_requested / queued / extracting / ready / failed` |
| `transcript_source` | `manual / auto / whisper`，未成功时为空 |
| `transcript_language` | 来源语言代码 |
| `transcript_text` | 去除字幕格式噪音后的完整原语言文本 |
| `transcript_segments` | `{start, end, text}` 分段数组 |
| `transcript_content_hash` | 规范化字幕内容哈希 |
| `transcript_fetched_at` | 当前字幕成功保存时间 |
| `transcript_error_code` | 有限错误分类 |
| `transcript_error` | 对用户安全的错误摘要 |

`transcript_text` 和 `transcript_segments` 是同一份原始语言内容的两种读取形式。
清理 YouTube 自动字幕的滚动重复不改变原意；时间戳以秒为单位保存。

### 4.3 ContentResponseItem

一条来源内容只对应一条稳定待响应记录。

| 字段 | 说明 |
| --- | --- |
| `id` | 整数主键 |
| `source_type` | `x_post / youtube_video`，后续可扩展 |
| `source_id` | 来源表主键的字符串形式 |
| `source_url` | 来源 URL 快照 |
| `source_title` | 列表展示标题快照 |
| `source_author` | 来源作者或频道快照 |
| `source_published_at` | 来源发布时间 |
| `workflow_status` | `queued / processing / ready / failed` |
| `decision_status` | `pending / adopted / later / rejected` |
| `current_analysis_run_id` | 当前展示的分析版本 |
| `selected_publish_account_id` | 用户最终选择的账号 |
| `selected_output_types` | 用户最终选择的创作形式 |
| `feedback_reason` | “不值得”等人工原因 |
| `decided_at` | 最近人工处理时间 |
| `created_at` / `updated_at` | 时间戳 |

唯一约束为 `(source_type, source_id)`。重新分析创建新分析版本，但不创建新的待响应条目。

### 4.4 ContentAnalysisRun

每次完成的分析不可变，新的模型、提示词或人工重跑创建新版本。

| 字段 | 说明 |
| --- | --- |
| `id` | 整数主键 |
| `response_item_id` | 统一待响应条目 |
| `version` | 条目内递增版本 |
| `status` | `queued / running / succeeded / failed` |
| `job_id` | 对应 durable job |
| `source_content_hash` | 分析输入哈希 |
| `source_snapshot` | 分析时使用的最小来源快照 |
| `content_value_score` | 内容价值总分 `0-100` |
| `value_dimensions` | 五个价值维度的分数和理由 |
| `summary_cn` | 中文摘要 |
| `core_thesis` | 一句话核心思想 |
| `key_points` | 主要观点列表 |
| `evidence` | 事实、数据和案例，含证据类型 |
| `value_points` | 真正值得创作的内容 |
| `risks` | 夸大、缺失、过时和版权风险 |
| `verification_items` | 需要进一步核验的事实 |
| `personal_angles` | 可加入的个人观点 |
| `article_outlines` | 可扩写文章结构 |
| `comment_angles` | 可评论或反驳的切入点 |
| `recommended_output_types` | 推荐创作形式及顺序 |
| `recommended_action` | 来源适配的首选动作，如扩写、评论、回复、引用或忽略 |
| `recommendation_reason` | 建议或不建议创作的原因 |
| `model_provider` / `model_name` | 模型信息 |
| `prompt_version` / `policy_version` | 分析合同版本 |
| `error_code` / `error` | 失败分类和安全错误摘要 |
| `created_at` / `completed_at` | 时间戳 |

唯一约束为 `(response_item_id, version)`。`source_snapshot` 不复制完整视频文件，只保存
标题、作者、URL、描述、字幕哈希和本次分析所用文本。

### 4.5 ContentAccountScore

| 字段 | 说明 |
| --- | --- |
| `id` | 整数主键 |
| `analysis_run_id` | 分析版本 |
| `publish_account_id` | 发布账号 |
| `score` | 适配分 `0-100` |
| `rank` | 本次分析中的账号排名 |
| `fit_reasons` | 与定位、受众和主题的契合点 |
| `audience_value` | 对该账号受众的价值 |
| `recommended_tone` | 推荐语气 |
| `recommended_output_types` | 适合该账号的创作形式 |
| `taboo_risks` | 可能触犯的账号禁区 |
| `created_at` | 时间戳 |

唯一约束为 `(analysis_run_id, publish_account_id)`。评分保存账号 ID 和必要的账号画像快照，
避免账号后续修改导致历史分析无法解释。

### 4.6 ContentResponseOutput

| 字段 | 说明 |
| --- | --- |
| `id` | 整数主键 |
| `response_item_id` | 统一待响应条目 |
| `analysis_run_id` | 生成依据的分析版本 |
| `publish_account_id` | 目标发布账号 |
| `output_type` | `expanded_article / commentary / x_share / x_reply / x_quote` |
| `status` | `queued / generating / draft_ready / published / abandoned / failed` |
| `job_id` | 生成任务 |
| `article_draft_id` | 文章或评论草稿关联 |
| `content` | X 分享等不进入文章草稿库的正文 |
| `source_attribution` | 来源链接与引用说明 |
| `error_code` / `error` | 失败信息 |
| `created_at` / `updated_at` | 时间戳 |

同一分析版本、账号和输出形式只允许存在一个非放弃输出，重试复用原输出记录。

### 4.7 ContentResponseNotification

| 字段 | 说明 |
| --- | --- |
| `id` | 整数主键 |
| `response_item_id` | 统一待响应条目 |
| `analysis_run_id` | 触发通知的分析版本 |
| `channel` | 首版为 `telegram` |
| `notification_tier` | `immediate / digest` |
| `status` | `not_required / queued / sending / sent / failed` |
| `message_ids` | 外部消息 ID 列表 |
| `attempts` | 投递次数 |
| `claim_token` | 并发投递认领令牌 |
| `last_error` | 清理后的错误 |
| `notified_at` | 成功时间 |
| `created_at` / `updated_at` | 时间戳 |

同一分析版本、通知渠道和通知等级只允许一条记录，避免 worker 重试导致重复推送。

### 4.8 人工事件

新增 `ContentResponseEvent`，记录：

- `adopted`
- `deferred`
- `rejected`
- `feedback_reason_changed`
- `publish_account_changed`
- `output_requested`
- `output_abandoned`
- `output_published`

事件保存安全的结构化 payload 和时间戳，不保存 API Key、完整模型请求或完整字幕副本。

## 5. 任务流程

### 5.1 统一分析 flow

新增 flow：

```text
content_response_analysis
  -> prepare_source
  -> extract_content
  -> analyze_value
  -> score_accounts
  -> persist_response
```

创建任务的 API 或采集服务先在一个数据库事务中：

- 创建或复用 `ContentResponseItem`；
- 对条目加锁并分配下一个分析版本；
- 创建 `ContentAnalysisRun`；
- 创建并关联 `ContentJob`；
- 提交后把 job ID 放入 Redis。

这样手动触发接口可以立即返回 response item 和 job ID，并避免并发点击分配重复版本。

`prepare_source`：

- 校验来源存在；
- 获取稳定来源元数据；
- 重新读取 API 已创建的 `ContentResponseItem` 和 `ContentAnalysisRun`；
- 记录来源内容哈希。

`extract_content`：

- X 直接读取原帖内容和链接上下文；
- YouTube 复用已成功字幕；
- Node durable worker 调用受 `WMS_WORKER_TOKEN` 保护的 Python 领域 API；
- Python 内容服务执行字幕获取、音频处理和 Whisper 兜底；
- 保存字幕后返回规范化文本和时间戳分段。

`analyze_value`：

- 按结构化合同生成内容价值评价；
- 严格区分来源事实、作者观点和 AI 推断；
- 输出中文分析，不改写原始字幕。

`score_accounts`：

- 读取所有启用发布账号的定位、受众、主题、调性和禁区；
- 一次模型调用返回每个账号的独立评分；
- 缺少启用账号时仍完成内容价值分析，账号评分列表为空。

`persist_response`：

- 校验输出结构；
- 在事务中保存分析版本和账号评分；
- 更新 `ContentResponseItem.current_analysis_run_id`；
- 标记条目 `ready`。

### 5.2 自动触发

YouTube 采集器只在首次插入视频后考虑自动触发。满足以下全部条件时创建任务：

- 频道 `auto_analyze_new_videos=true`；
- 视频 `collected_at >= analysis_enabled_at`；
- 不存在已运行或已成功的同来源分析任务。

更新已有视频的播放量、描述、标题或缩略图不能触发分析。自动任务使用幂等键：

```text
content-response:youtube_video:<video_id>:initial
```

### 5.3 单条手动触发

所有 YouTube 视频项目提供：

- 尚未分析：`提取字幕并分析`
- 运行中：显示任务阶段和进度
- 已完成：`查看分析`、`重新分析`
- 已失败：`重试`

重新分析只创建新的 `ContentAnalysisRun`。字幕内容哈希未变化时复用现有字幕，不重新下载。

### 5.4 字幕提取

字幕策略：

1. 用 `yt-dlp` 读取视频元数据和字幕列表；
2. 优先选择视频原语言的人工字幕；
3. 无人工字幕时选择原语言自动字幕；
4. 字幕可用时仅下载 VTT，不下载音视频；
5. 没有字幕时下载单声道压缩音频并调用配置的 Whisper API；
6. 把 VTT 或 Whisper 结果统一为 `{start, end, text}`；
7. 清理 HTML/VTT 标签和连续滚动重复；
8. 保存完整文本、分段、语言、来源和哈希；
9. 删除任务临时文件。

Whisper 设置独立于聊天模型设置，支持 OpenAI/Groq 兼容的 transcription endpoint：

- API Base URL
- API Key
- Model
- 超时
- 最大音频大小

聊天模型的 API Key 不能被假定支持语音转写。设置页必须提供独立保存和连通性测试。

### 5.5 创作输出 flow

新增 flow：

```text
content_response_output
  -> prepare_output_context
  -> generate_output
  -> save_output
```

一次选择多个形式时，每个形式创建独立 `ContentResponseOutput` 和 job。

- `expanded_article` 和 `commentary` 保存到现有 `article_drafts`，并回填
  `article_draft_id`；
- `x_share` 正文保存在 `ContentResponseOutput.content`，由统一待响应页面继续编辑和发布；
- 现有 X 即时响应继续使用 `x_reply` 和 `x_quote`，分别表示回复稿和引用稿；
- 每份输出关联来源条目、分析版本、目标账号和来源说明。

生成失败只影响当前输出。重试失败 step 时不能重复创建已成功草稿。

## 6. AI 分析合同

### 6.1 内容价值

总分为五个等权维度之和，每项 `0-20`：

- 信息密度
- 新颖程度
- 可信程度
- 时效价值
- 再创作空间

展示等级：

- `80-100`：优先创作
- `60-79`：值得创作
- `40-59`：可作为参考
- `0-39`：价值较低

等级只影响展示和排序，绝不决定是否持久化或是否进入待响应。

### 6.2 证据边界

每个证据项必须包含：

- 文本；
- 类型：`source_fact / source_opinion / model_inference`；
- 字幕时间范围或来源链接；
- 是否需要外部核验。

模型推断不能伪装成视频明确表达的事实。未经核验的数据进入创作上下文时必须携带风险
提示。

### 6.3 账号适配

每个启用账号独立评估：

- 定位匹配
- 受众价值
- 主题相关
- 调性匹配
- 禁区风险
- 推荐内容形式

最终推荐得分最高且没有硬禁区冲突的账号。用户创作时可以切换账号；切换不会改变历史
评分。

### 6.4 创作约束

AI 生成内容必须：

- 重新组织结构，不能简单拼接或轻微改写字幕；
- 明确区分事实、来源观点和作者自己的评论；
- 不把未经核验的信息写成确定事实；
- 遵守目标账号的定位、受众、语气和禁区；
- 保留原视频链接以供审核；
- X 分享默认附来源链接；
- 不自动执行发布。

## 7. 统一待响应页面

侧边栏继续使用“待响应”，路由可保留 `/x-responses` 的兼容重定向，但新的正式路由为
`/responses`。

### 7.1 分栏工作台

页面采用已确认的分栏布局：

```text
┌──────────────────────┬──────────────────────────────────────────────┐
│ 统一来源与状态筛选    │ 来源标题、缩略图、分数与分析版本             │
├──────────────────────┼──────────────────────────────────────────────┤
│ 待响应队列            │ 概览 / 字幕 / 账号适配 / 分析历史            │
│                      │                                              │
│ 来源、标题、核心观点  │ 核心思想、主要观点、价值点、风险、核验项     │
│ 内容分、最佳适配分    │ 推荐创作方向与各账号评分                     │
│ 推荐账号与形式        │                                              │
├──────────────────────┼──────────────────────────────────────────────┤
│                      │ 采纳创作 / 稍后处理 / 不值得                  │
└──────────────────────┴──────────────────────────────────────────────┘
```

来源筛选：

- 全部
- X
- YouTube

状态筛选：

- 待处理
- 稍后处理
- 已采纳
- 不值得
- 失败

支持按综合价值、发布时间和最近分析时间排序，支持按标题、来源作者和核心观点搜索。

### 7.2 详情页签

`概览`：

- 内容价值和最佳账号适配分；
- 核心思想、主要观点、价值点；
- 风险和待核验信息；
- 推荐创作方向。

`字幕`：

- 原始语言和字幕来源；
- 带时间戳分段；
- 点击时间戳打开对应 YouTube 时间位置；
- 复制全文；
- 字幕提取错误和重试入口。

`账号适配`：

- 所有启用账号的分数和排序；
- 契合点、受众价值、推荐形式和禁区风险。

`分析历史`：

- 版本、时间、模型和提示词版本；
- 切换查看旧版本；
- 将旧版本设为当前展示版本；
- 发起重新分析。

### 7.3 人工反馈

固定底部操作：

- `采纳创作`
- `稍后处理`
- `不值得`

“不值得”打开可选原因输入。状态可以撤销或修改，每次变化写入事件。

### 7.4 采纳创作面板

面板默认填入：

- AI 推荐账号；
- 推荐创作形式；
- 推荐角度；
- 需要核验的事实；
- 来源链接。

用户可以切换账号并多选扩写文章、观点评论、X 分享。提交后显示每个独立输出的任务状态。

## 8. YouTube 页面

### 8.1 频道设置

频道订阅和编辑界面新增“自动分析新视频”开关。开关文案必须明确：

- 只分析开启后的新视频；
- 不自动补跑历史视频；
- 历史视频可以逐条手动分析。

### 8.2 视频项目操作

视频项目保留“加入选题”，并新增：

- `提取字幕并分析`
- `查看分析`
- `重新分析`
- `重试`

视频项目显示字幕和分析状态，不在卡片内展开完整字幕或完整分析。

## 9. API

### 9.1 统一待响应

```text
GET    /api/responses
GET    /api/responses/{id}
POST   /api/responses/{id}/analyze
POST   /api/responses/{id}/retry
POST   /api/responses/{id}/decision
POST   /api/responses/{id}/outputs
GET    /api/responses/{id}/events
GET    /api/responses/{id}/analyses
POST   /api/responses/{id}/analyses/{analysis_id}/select
```

`GET /api/responses` 支持来源、状态、最低分、账号、搜索、排序和分页参数。

### 9.2 YouTube

```text
PATCH  /api/youtube/channels/{id}
POST   /api/youtube/videos/{id}/analyze
GET    /api/youtube/videos/{id}/transcript
POST   /api/youtube/videos/{id}/transcript/retry
```

频道 PATCH 请求增加 `auto_analyze_new_videos`。视频分析接口返回统一 response item 和
job ID。

### 9.3 Worker-only

```text
GET  /api/responses/{id}/worker-context
POST /api/responses/{id}/worker-analysis
GET  /api/responses/outputs/{id}/worker-context
POST /api/responses/outputs/{id}/worker-result
GET  /api/settings/transcription-runtime
```

worker-only 接口必须使用现有 `WMS_WORKER_TOKEN` 保护。

### 9.4 兼容

`/api/x/responses` 和 `/x-responses` 在迁移期保留兼容读取或重定向，但内部只读取统一响应
模型。兼容层不得继续写 `x_response_decisions`。

## 10. 现有 X 数据迁移

迁移执行顺序：

1. 创建统一表和约束；
2. 为每条 `x_response_decisions` 创建 `ContentResponseItem`；
3. 把评分、摘要、理由、claims、核验状态、模型和策略版本迁入
   `ContentAnalysisRun`；
4. 把评论稿和引用稿迁入 `ContentResponseOutput`；
5. 把 Telegram 状态、消息 ID 和通知时间迁入
   `ContentResponseNotification`；
6. 回填每个条目的当前分析版本；
7. 比较源记录数、唯一 tweet ID、草稿数、状态和 Telegram 关联；
8. 切换 API、worker 和页面到统一模型；
9. 运行端到端验收；
10. 备份后删除 `x_response_decisions`。

迁移必须在受控停写窗口或事务边界内进行，不能在 X 实时采集仍向旧表写入时执行。迁移
失败时回滚新表数据并恢复旧代码路径。

## 11. 通知

现有 X 通知策略保持：

- 高价值即时 Telegram 通知；
- 每日摘要；
- 现有通知等级和验证门槛。

通知读取 `ContentResponseItem` 和当前 `ContentAnalysisRun`，X 特有的评论/引用建议从
`ContentResponseOutput` 读取。

YouTube 首版不逐条通知，只在统一待响应页面展示。后续高分摘要需要作为独立功能设计，
不能默认复用 X 的即时通知阈值。

## 12. 安全与资源约束

- 只处理数据库中已采集的 HTTP/HTTPS 视频 URL；
- 不接受任意本地文件路径；
- `yt-dlp` 和 `ffmpeg` 使用参数数组调用，不拼接 Shell 字符串；
- 配置允许的域名和重定向策略，阻止访问本地网络地址；
- 字幕可用时不下载视频；
- Whisper 只处理压缩后的单声道音频；
- 设置最大视频时长、最大音频字节、下载超时、转写超时和任务总超时；
- 临时文件使用任务专属目录，成功或失败后都清理；
- API Key 不写入 job、step、event、分析记录、日志或前端响应；
- 外部错误映射为有限错误分类和清理后的中文提示；
- 完整字幕只在用户查看详情或执行分析时返回，不进入列表 API；
- 发布仍需要用户显式操作。

## 13. 失败和重试

错误分类：

- `source_not_found`
- `captions_unavailable`
- `caption_download_failed`
- `audio_download_failed`
- `audio_too_large`
- `video_too_long`
- `transcription_failed`
- `analysis_failed`
- `account_scoring_failed`
- `persistence_failed`
- `output_generation_failed`

重试规则：

- 来源不存在、视频超限和配置缺失在配置改变前不可重试；
- 网络超时、429、5xx、下载中断和模型临时错误可重试；
- 字幕已成功时不重复提取；
- 价值分析成功但账号评分失败时只重跑账号评分；
- 某个创作输出失败时不影响其他输出；
- 重试失败 output 时复用原记录和已成功的文章草稿关联。

## 14. 反馈与后续学习

第一版记录：

- 分析版本和模型；
- 内容价值及账号适配评分；
- 用户最终状态；
- 用户反馈原因；
- 最终账号和创作形式；
- 输出是否继续编辑、放弃或发布；
- 从分析到决策的耗时。

后续可以据此：

- 调整价值维度权重；
- 学习不同账号的采纳偏好；
- 优化推荐创作形式；
- 构建少样本提示；
- 评估模型升级是否改善人工采纳率。

第一版不自动更新提示词、不在线训练模型，也不把用户行为自动当作绝对正确标签。

## 15. 测试与验收

### 15.1 字幕

- 人工字幕优先于自动字幕；
- 自动字幕优先于 Whisper；
- 字幕可用时不下载音视频；
- 无字幕时只下载音频；
- VTT 标签被清理；
- YouTube 滚动重复被合并；
- 时间戳和原语言被保留；
- 字幕成功写入 `youtube_videos`；
- 临时文件在成功和失败后清理；
- 非法 URL、本地地址、超长视频和超大音频被拒绝。

### 15.2 触发和幂等

- 现有频道迁移后不开启自动分析；
- 新增频道默认开启但可关闭；
- 开启前的存量视频不自动补跑；
- 新插入视频在开关开启时创建任务；
- 更新播放量不创建任务；
- 单条手动分析可以处理存量视频；
- 重复点击返回现有运行任务；
- 重新分析创建新版本而非新待响应条目。

### 15.3 分析

- 五个内容价值维度和总分通过 schema 校验；
- 低分内容仍持久化并进入待响应；
- 事实、来源观点和模型推断可区分；
- 所有启用账号都有独立评分；
- 有硬禁区冲突的账号不能成为推荐账号；
- 无启用账号时内容分析仍可完成；
- 模型输出无效时执行一次受控修复，仍无效则失败。

### 15.4 统一待响应

- X 和 YouTube 同时出现在统一列表；
- 来源、状态、搜索和排序有效；
- 详情按需加载字幕，不污染列表响应；
- 概览、字幕、账号适配和分析历史可切换；
- 采纳、稍后、不值得及原因可保存和撤销；
- 状态变化产生审计事件。

### 15.5 创作

- 用户可以切换账号和多选创作形式；
- 每种形式创建独立 output 和 job；
- 文章和评论进入文章草稿库；
- X 分享正文保存在统一 output；
- 输出关联来源、分析版本和账号；
- 失败输出可独立重试；
- 成功草稿不会因重试被重复创建；
- 没有任何路径自动发布。

### 15.6 X 迁移

- 迁移前后 X 响应唯一来源数一致；
- 原评分、摘要、原因、claims 和验证状态可追溯；
- 评论稿和引用稿数量一致；
- Telegram 状态和消息 ID 一致；
- 兼容 API 只读统一模型；
- 切换后不再写旧表；
- 迁移失败可以回滚。

### 15.7 运行态

- Python API 容器包含 `yt-dlp` 和 `ffmpeg`，Node worker 不直接执行媒体命令；
- Node worker 通过受保护的内部 API 调用 Python 字幕领域服务；
- API、worker、Redis 和 Postgres 使用同一任务队列配置；
- Whisper、聊天模型和 worker token 设置可用；
- 任务离开页面后继续运行；
- API 和 worker 重启后可以从失败或未完成步骤恢复；
- 前端无水合错误、控制台错误或空白页面。

## 16. 首版明确不做

- 视频画面抽帧、OCR 或视觉理解；
- 自动发布文章或 X；
- 自动训练、微调或在线更新模型；
- 存量视频批量补分析；
- 自动生成完整中文字幕；
- YouTube 逐条 Telegram 通知；
- 把所有平台原始采集数据迁入一张通用内容表；
- 任意 URL 或本地视频上传分析。
