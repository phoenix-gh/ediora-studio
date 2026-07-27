# HeyGen 数字人口播

## 目标

在 WeMediaStudio 的“创作”分组下增加“数字人口播”，让单用户可以：

1. 用一张正面人物图片和一段录音创建可复用的数字人角色；
2. 为角色设置默认环境图，并在单个口播作品中覆盖；
3. 在独立脚本编辑器中手写、使用 AI 生成或把现有草稿转成口播脚本；
4. 通过 HeyGen V3 API 生成无字幕、无配乐的 16:9 MP4 口播视频；
5. 保留每次生成的成片版本，并把视频持久化到本地创作资产。

首版直接使用 HeyGen，不实现其他数字人供应商或本地数字人模型。内部仍将 HeyGen
调用封装为独立客户端，避免把 HTTP 细节散落到页面和领域服务中。

## 已确认的产品边界

- 首版是“可复用数字人角色 + 单条口播视频”，不是持续运营的数字人 IP，也不是实时互动数字人。
- 角色形象来自一张上传的正面单人图片。
- 角色声音来自上传录音的声音克隆。
- 脚本属于口播作品，不建立独立脚本库。
- 脚本支持手动编辑、AI 辅助生成和现有草稿转脚本。
- 数字人角色有默认环境图，口播作品可以覆盖。
- 环境图支持上传、从创作资产选择和 AI 生成；AI 结果进入创作资产。
- 首版成片只有人物、环境、克隆声音和口型同步，不含字幕、配乐、转场、B-roll 或时间轴。
- 每次生成创建新成片版本，不能覆盖旧版本。
- 首版只接 HeyGen V3 API。

## 信息架构

侧边栏“创作”分组新增：

```text
草稿箱
写作模板
创作资产
数字人口播
热点选题
发布
```

“数字人口播”页面包含两个页签：

- **口播作品**：默认页签，显示作品列表并创建口播作品。
- **数字人角色**：管理人物形象、克隆声音和默认环境。

口播作品编辑页采用三栏工作台：

```text
┌────────────────┬──────────────────────────┬────────────────────┐
│ 角色与环境      │ 脚本编辑器                │ 成片预览与版本      │
│                │                          │                    │
│ 数字人角色      │ 手写 / AI 生成            │ 当前版本预览        │
│ 默认/覆盖环境   │ 草稿转脚本                 │ 生成状态            │
│ 角色就绪状态    │ 自动保存                   │ 历史成片版本        │
└────────────────┴──────────────────────────┴────────────────────┘
```

## 核心数据模型

### DigitalHuman

表示长期复用的数字人角色。

| 字段 | 说明 |
| --- | --- |
| `id` | 本地角色 ID |
| `name` | 角色名称 |
| `status` | `draft`、`processing`、`ready`、`failed`、`archived` |
| `portrait_asset_id` | 本地正面形象图片资产 |
| `voice_sample_asset_id` | 本地声音样本资产 |
| `default_environment_asset_id` | 本地默认环境图片资产 |
| `heygen_avatar_group_id` | HeyGen Avatar Group ID |
| `heygen_avatar_id` | HeyGen Photo Avatar Look ID |
| `heygen_voice_id` | HeyGen Voice Clone ID |
| `setup_job_id` | 最近一次角色初始化任务 |
| `error` | 对用户安全的最近错误 |
| `archived_at` | 归档时间 |
| `created_at` / `updated_at` | 时间戳 |

角色更新形象或声音时先创建新的初始化任务。只有新素材在 HeyGen 全部就绪后才原子替换
当前 `heygen_avatar_id` 和 `heygen_voice_id`。历史成片继续引用各自快照，不随角色更新。

### TalkingVideoProject

表示一个口播作品和它的当前编辑状态。

| 字段 | 说明 |
| --- | --- |
| `id` | 作品 ID |
| `title` | 作品标题 |
| `digital_human_id` | 当前选择的数字人角色 |
| `script` | 当前保存的口播脚本 |
| `script_source` | `manual`、`ai`、`draft` |
| `source_draft_id` | 从草稿转换时记录原草稿 |
| `environment_asset_id` | 项目覆盖环境；为空时使用角色默认环境 |
| `current_render_id` | 当前选中的成片版本 |
| `created_at` / `updated_at` | 时间戳 |

脚本采用页面防抖自动保存。AI 返回的内容必须先写入编辑器，由用户确认后才能生成视频。

### TalkingVideoRender

表示一次不可变的成片版本。

| 字段 | 说明 |
| --- | --- |
| `id` | 成片版本 ID |
| `project_id` | 所属口播作品 |
| `version` | 同一作品内递增版本号 |
| `status` | `queued`、`running`、`succeeded`、`failed`、`cancelled` |
| `job_id` | durable content job |
| `script_snapshot` | 生成时的完整脚本 |
| `digital_human_snapshot` | 角色、HeyGen Avatar 和 Voice ID 快照 |
| `environment_asset_id` | 生成时使用的环境资产 |
| `heygen_environment_asset_id` | 本次 HeyGen 背景资产 ID |
| `heygen_video_id` | HeyGen 视频 ID |
| `video_asset_id` | 下载后创建的本地视频资产 |
| `error` | 对用户安全的生成错误 |
| `created_at` / `completed_at` | 时间戳 |

唯一约束为 `(project_id, version)`。创建成片版本和 durable job 必须在同一事务中完成。

## 用户流程

### 配置 HeyGen

设置页新增“HeyGen”分区：

- API Key 密码输入框；
- 已配置状态和后四位预览；
- 保存按钮；
- 连通性测试按钮。

API Key 保存在现有服务端设置存储中，不返回浏览器。worker 通过内部 runtime endpoint
读取。`HEYGEN_API_KEY` 环境变量仅作为未配置数据库时的部署回退。

连通性测试调用 HeyGen 当前用户或私有 Avatar 列表接口。认证失败、套餐不支持声音克隆、
限流和网络错误必须显示不同提示。

### 创建数字人角色

1. 用户上传或从创作资产选择人物图片。
2. 用户上传或从创作资产选择声音样本。
3. 用户上传、选择或 AI 生成默认环境图。
4. 前端先创建本地 `DigitalHuman`，后端同时创建 `digital_human_setup` durable job。
5. Node worker 执行：
   - 上传人物图片到 `POST /v3/assets`；
   - 调用 `POST /v3/avatars`，`type=photo`；
   - 查询 Photo Avatar 状态直到 `completed` 或 `failed`；
   - 上传声音样本到 `POST /v3/assets`；
   - 调用 `POST /v3/voices/clone`；
   - 查询声音状态直到 `complete` 或失败；
   - 更新本地角色为 `ready`。
6. 页面轮询本地角色状态。离开页面不影响后台任务。

人物图片、声音样本和环境图必须先持久化为本地创作资产。HeyGen 只保存供应商侧副本和 ID。

### 编辑口播作品

1. 新建作品并选择一个 `ready` 角色。
2. 默认带入角色环境图，允许项目覆盖。
3. 在中栏编辑脚本：
   - 空白开始；
   - 输入主题和要求让 AI 生成；
   - 选择草稿并转换为口语脚本；
   - 输入修改指令让 AI 重写当前脚本。
4. AI 使用当前已配置的文本模型，通过专用 Next.js server route 调用。该 route 不保存
   脚本，只返回候选文本。
5. 用户在编辑器确认，页面防抖保存到 `TalkingVideoProject.script`。

AI 脚本提示必须明确：

- 保留原文事实，不编造材料；
- 改成自然口语；
- 去掉 Markdown 标题、链接和不适合朗读的格式；
- 只返回最终脚本正文；
- 不自动生成视频。

### 生成和管理成片

1. 用户点击“生成口播”。
2. 后端校验角色 `ready`、脚本非空、环境图存在、HeyGen 已配置。
3. 后端冻结输入快照，创建 `TalkingVideoRender` 和 `digital_human_render` job。
4. Node worker：
   - 将本地环境图片上传 HeyGen；
   - 调用 `POST /v3/videos`：
     - `type=avatar`
     - `avatar_id=<角色 HeyGen Photo Avatar ID>`
     - `script=<脚本快照>`
     - `voice_id=<角色 HeyGen Voice ID>`
     - `background={type:image, asset_id:<环境 HeyGen Asset ID>}`
     - `aspect_ratio=16:9`
     - `output_format=mp4`
     - 不设置烧录字幕
   - 查询 `GET /v3/videos/{video_id}`；
   - 完成后立即下载 presigned `video_url`；
   - 上传到本地 `/api/assets/upload?media_kind=video`；
   - 更新成片版本为 `succeeded`，并在作品没有当前版本时设为当前。
5. 用户可以预览、下载、删除失败版本，或把任意成功版本设为当前。

HeyGen 的视频下载地址不是本系统的持久存储。只有本地 `video_asset_id` 创建成功后，任务
才可以标记成功。

## HeyGen V3 客户端边界

新增独立 TypeScript 客户端，集中处理：

- `POST /v3/assets`
- `POST /v3/avatars`
- `GET /v3/avatars/{group_id}`
- `GET /v3/avatars/looks/{look_id}`
- `POST /v3/voices/clone`
- `GET /v3/voices/{voice_id}`
- `POST /v3/videos`
- `GET /v3/videos/{video_id}`

所有创建请求使用由本地 job、step 和业务对象组成的 `Idempotency-Key`。重试时如果已经
保存供应商 ID，只查询已有资源，不重复创建扣费资源。

HTTP 客户端不得记录 API Key、完整声音样本、完整脚本或 HeyGen 原始错误体。持久化事件
只记录安全状态、供应商资源 ID、耗时和错误分类。

## durable job 设计

新增两个 flow：

```text
digital_human_setup
  -> heygen_avatar
  -> heygen_voice
  -> finalize_digital_human

digital_human_render
  -> heygen_render
  -> save_talking_video
```

worker 每个轮询周期都重新读取本地 job 状态。用户取消后停止本地轮询和保存；HeyGen 已
提交的外部调用可能继续执行。重试从失败 step 开始，并复用已保存的 HeyGen 资源 ID。

以下错误不可重试：

- API Key 无效；
- HeyGen 套餐不支持声音克隆；
- 图片、音频、脚本或背景参数不合法；
- 本地关联角色、作品或资产不存在。

以下错误可重试：

- HeyGen 429；
- HeyGen 5xx；
- 网络超时或下载中断；
- 轮询超时；
- 本地视频保存暂时失败。

## 本地 API

新增公开领域 API：

```text
GET    /api/digital-humans
POST   /api/digital-humans
GET    /api/digital-humans/{id}
PATCH  /api/digital-humans/{id}
DELETE /api/digital-humans/{id}
POST   /api/digital-humans/{id}/archive
POST   /api/digital-humans/{id}/retry

GET    /api/talking-videos
POST   /api/talking-videos
GET    /api/talking-videos/{id}
PATCH  /api/talking-videos/{id}
DELETE /api/talking-videos/{id}
POST   /api/talking-videos/{id}/renders
POST   /api/talking-videos/{id}/renders/{render_id}/select
DELETE /api/talking-videos/{id}/renders/{render_id}
```

新增 worker-only API：

```text
GET  /api/settings/heygen-runtime
GET  /api/digital-humans/{id}/worker-context
POST /api/digital-humans/{id}/worker-progress
GET  /api/talking-videos/renders/{id}/worker-context
POST /api/talking-videos/renders/{id}/worker-progress
```

新增 Next.js AI route：

```text
POST /api/digital-human/script
```

请求模式为 `generate`、`convert_draft` 或 `rewrite`，响应只包含候选脚本。

## 素材和文件约束

- HeyGen V3 单次直接上传最大 32 MB；人物图片、声音样本和环境图在创建角色前按此限制
  校验。
- 人物图片只接受 JPEG/PNG。
- 声音样本只接受 MP3/WAV，并在 UI 提示使用清晰、单人、无背景音乐的录音。
- 环境图只接受 JPEG/PNG。
- 本地生成视频仍遵循创作资产 100 MB 限制；超过时给出明确错误。
- 所有本地文件 URL 在 worker 中通过内部 API origin 读取，不能把浏览器 localhost URL
  直接交给 HeyGen。

## 删除和归档

- 没有关联作品的角色可以删除；有关联作品的角色只能归档。
- 归档角色不出现在新作品选择器中，历史作品仍可显示。
- 删除口播作品时删除项目和成片记录，但默认不删除已进入创作资产的视频文件。
- 删除失败或取消的成片版本不会影响其他版本。
- 成功成片如果是当前版本，必须先选择其他版本或明确清空当前版本才能删除记录。

## 测试与验收

### 自动化

后端测试覆盖：

- 三个新模型的约束和状态；
- 创建角色时原子创建 setup job；
- 创建成片时冻结输入快照并递增版本；
- 角色归档和删除保护；
- 项目自动保存、成片选择和删除规则；
- HeyGen 设置脱敏、保存、内部读取和连通性错误分类；
- API 输入校验和安全错误。

TypeScript 测试覆盖：

- HeyGen V3 请求路径、请求体和 `Idempotency-Key`；
- 认证、套餐、限流、5xx 和网络错误分类；
- setup job 成功、失败、重试时不重复创建供应商资源；
- render job 下载并保存本地视频；
- 脚本 AI 三种模式和输出清理；
- worker 对两个新 flow 的路由。

前端测试覆盖：

- 侧边栏使用“数字人口播”；
- “口播作品 / 数字人角色”页签；
- 三栏编辑器结构；
- 非 `ready` 角色不能生成；
- 环境图三种来源；
- 脚本自动保存和草稿转换；
- 成片状态、预览、版本选择和错误展示。

### 手工验收

在真实 HeyGen 付费 API Key 下完成：

1. 设置页保存并测试 HeyGen Key。
2. 上传一张正面图片、一段声音和一张环境图，角色最终变为“可以创作”。
3. 创建口播作品，让 AI 从主题生成脚本并手动修改。
4. 从一个现有草稿转换脚本并确认不会修改原草稿。
5. 生成第一版口播视频，刷新或离开页面后任务仍继续。
6. HeyGen 完成后视频可在右栏播放，且创作资产中存在本地 MP4。
7. 修改脚本生成第二版，第一版仍可预览并可重新设为当前。
8. 模拟可重试失败并只重试失败 step。

## 非目标

- 字幕、背景音乐、转场、B-roll、多场景时间轴；
- 实时直播和互动数字人；
- 自动发布；
- 独立脚本库；
- Digital Twin 视频训练；
- HeyGen 之外的云供应商；
- 本地数字人和本地声音模型；
- 多用户、计费和租户隔离。
