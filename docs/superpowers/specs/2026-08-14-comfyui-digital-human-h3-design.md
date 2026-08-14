# ComfyUI MiniMax H3 数字人口播

## 目标

在现有「数字人口播」上增加 ComfyUI / MiniMax H3 渲染后端，作为 HeyGen 的并列选项，而不是替换它。

本机 H3 只能稳定跑短片（当前机器上限 5 秒），因此 ComfyUI 路径按镜头编辑、按镜生成、硬切拼接。产品层仍是：

```text
数字人角色 → 口播作品 → 不可变成片版本 → 异步任务
```

H3 负责「人像首帧 + 提示词 → 带原生声音的短视频」，不负责脚本逐字对口型，也不克隆音色。

## 已确认的产品边界

- HeyGen 继续可用。已有角色、作品、成片和 `digital_human_render` 流程不迁移、不删除。
- 角色创建时选择渲染后端 `heygen` 或 `comfyui`，创建后不可改。
- ComfyUI 路径用 MiniMax H3 的图生视频（I2V），不是 LivePortrait / MuseTalk 式对口型。
- 作品按镜头列表编辑，不在后台把一整段脚本悄悄切开。
- 单镜时长可调；上限来自设置中的本机预算，默认 5 秒。下限以钉死的 H3 工作流为准，第一期按 4 秒。
- 默认硬切拼接。不把上一段尾帧自动当作下一段首帧。
- 每一镜独立生成、可单独重跑；拼接只使用当前工作态里已成功的 clip。
- 成片版本仍然不可变。重跑某一镜只改作品工作态；要新成片再出新版本。
- ComfyUI 工作流以仓库模板为准，第一期不开放用户改图。
- 成片必须落到本地创作资产后才算成功，规则与 HeyGen 路径相同。
- 第一期不接 H3-Context-IR、不接 H3-Regenerate-2K、不接 WebSocket 进度。

## 方案选择

采用「同一套领域对象 + 按后端分支的 job」：

- 领域模型仍是 `DigitalHuman`、`TalkingVideoProject`、`TalkingVideoRender`。
- ComfyUI 只增加角色定妆图、作品镜头列表、按镜 job 和拼接 job。
- 不另建「H3 项目」或「分镜工程」页面。

不采用整段脚本一次丢给 H3，因为本机无法跑长片。不采用尾帧续接作为默认，因为 H3 尾帧更容易糊，身份和音频都会漂。不把 H3 当成静图模型；定妆图用本地合成，把 GPU 留给出片。

## 信息架构

侧边栏和「口播作品 / 数字人角色」页签不变。

角色编辑增加「渲染后端」。HeyGen 角色仍要求人像、录音、环境。ComfyUI 角色要求人像和环境，录音可空。

口播作品编辑页仍是三栏。中栏按角色后端切换：

```text
HeyGen 角色：整段脚本
ComfyUI 角色：镜头列表
```

```text
┌────────────────┬──────────────────────────┬────────────────────┐
│ 角色与环境      │ 镜头列表                  │ 预览与成片          │
│                │                          │                    │
│ 定妆图          │ 镜 n · 时长 · 景别        │ 当前镜 clip        │
│ 环境覆盖        │ 口播句 / 动作             │ 生成 / 重跑这一镜   │
│ 角色就绪状态    │ 首帧覆盖 / 调序 / 拆镜     │ 全部未完成镜头      │
│                │                          │ 生成成片（拼接）     │
│                │                          │ 历史版本            │
└────────────────┴──────────────────────────┴────────────────────┘
```

设置页在 HeyGen 旁增加「ComfyUI」分区。

## 核心数据模型

### DigitalHuman

新增或放宽字段：

| 字段 | 说明 |
| --- | --- |
| `provider` | `heygen` 或 `comfyui`。创建后不可改。存量行回填 `heygen`。 |
| `voice_sample_asset_id` | 改为可空。HeyGen 必填，ComfyUI 可空。 |
| `look_asset_id` | ComfyUI 定妆图。16:9 本地合成结果。HeyGen 为空。 |

`ready` 条件：

- HeyGen：已有 `heygen_avatar_id` 和 `heygen_voice_id`。
- ComfyUI：已有 `look_asset_id`，且指向存在的本地图片资产。

`provider_state` 继续承载可恢复的供应商中间态。ComfyUI setup 可记录合成参数；不要再增加 `comfyui_*` 列。

换人像或默认环境：ComfyUI 角色重新排队 `digital_human_setup`，生成新定妆图，成功后原子替换 `look_asset_id`。历史成片继续引用各自快照。

### TalkingVideoShot（作品工作态）

镜头存在 `TalkingVideoProject.shots` JSON 数组中，不是独立表。每项：

| 字段 | 说明 |
| --- | --- |
| `id` | 稳定 UUID，调序后不变 |
| `duration_sec` | 本镜时长，必须落在 `[min_shot_seconds, max_shot_seconds]` |
| `framing` | `wide`、`medium`、`close` |
| `spoken_text` | 这一镜要说的话 |
| `motion_prompt` | 可选动作 / 运镜 |
| `first_frame_asset_id` | 可空；空则用角色定妆图 |
| `clip_asset_id` | 最近一次成功的本镜视频资产 |
| `status` | `draft`、`queued`、`running`、`succeeded`、`failed` |
| `job_id` | 最近一次按镜任务 |
| `error` | 对用户安全的错误 |
| `workflow_version` | 成功生成时使用的模板版本 |
| `seed` | 成功生成时的 seed |
| `provider_state` | 本镜 ComfyUI 中间态，至少含 `prompt_id` |

作品另增可空的 `look_asset_id`。若设置了 `environment_asset_id`，保存时按与角色 setup 相同的规则，用人像和该环境同步合成作品级定妆图。合成失败则拒绝保存该环境。

默认首帧解析顺序：镜头 `first_frame_asset_id` → 作品 `look_asset_id` → 角色 `look_asset_id`。

`TalkingVideoProject.script` 在 ComfyUI 路径上是各镜 `spoken_text` 按顺序用空行拼接的派生文本，供搜索、草稿转换和切换到展示层使用。保存镜头列表时重写 `script`。用户不能在 ComfyUI 作品里只改 `script` 而不改镜头。

新建 ComfyUI 作品时创建一镜空白镜头：`duration_sec = max_shot_seconds`，`framing = medium`。

### TalkingVideoRender

HeyGen 成片字段保持不变。ComfyUI 成片额外在快照里冻结镜头，不新增 HeyGen 式供应商列。

| 字段 | ComfyUI 成片用法 |
| --- | --- |
| `script_snapshot` | 各镜口播句拼接 |
| `digital_human_snapshot` | 含 `id`、`name`、`provider`、`look_asset_id` |
| `environment_asset_id` | 生成时的项目环境或角色默认环境 |
| `shots_snapshot` | 完整镜头列表副本，包括当时的 clip 资产 ID、时长、工作流版本、seed |
| `provider_state` | 拼接过程中间态 |
| `heygen_*` | 空字符串 |
| `video_asset_id` | 拼接后的本地成片 |

唯一约束仍是 `(project_id, version)`。创建拼接任务和 `TalkingVideoRender` 必须在同一事务中完成。

## 时长规则

设置项：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `comfyui_max_shot_seconds` | `5` | 本机单镜上限，整数，范围 4–15 |
| `comfyui_min_shot_seconds` | `4` | 当前钉死工作流的下限 |

第一期 H3 官方节点按时长 4–15 秒设计，本机预算把它截断到最多 5 秒，因此选择器实际是 4–5 秒。若以后换了能更短的模板，只改设置和下限，不改领域模型。

有效区间：

- 下限 = `max(comfyui_min_shot_seconds, 模板 meta.min_seconds)`
- 上限 = `min(comfyui_max_shot_seconds, 模板 meta.max_seconds)`
- 若下限大于上限，视为配置错误，按镜任务直接失败并提示检查设置和工作流。

校验：

- 保存镜头或提交按镜任务时，`duration_sec` 必须在闭区间内。
- 超过上限不能提交；界面提示拆成两镜。
- AI 切镜按中文口播约每秒 4–5 字估算，超出上限就拆镜，不拉长单镜。
- 拼接使用每段 clip 的真实时长，不假定都等于上限。

## 用户流程

### 配置 ComfyUI

设置页新增「ComfyUI」分区：

- 服务地址，例如 `http://127.0.0.1:8188`；
- 可选鉴权 token；已配置时 worker 带 `Authorization: Bearer <token>`，未配置则不带鉴权；
- 单镜最长秒数；
- 已配置状态；
- 保存和连通性测试。

地址和 token 只存在服务端设置存储。Worker 通过内部 runtime 接口读取。`COMFYUI_BASE_URL` 仅作为未配置数据库时的部署回退。浏览器不得拿到 token。

连通性测试请求 ComfyUI `GET /system_stats`。连不上、非 JSON、鉴权失败要分开提示。

### 创建 ComfyUI 角色

1. 选择渲染后端 `comfyui`。
2. 上传或选择人像和环境图；录音可跳过。
3. 后端创建本地角色，并创建 `digital_human_setup` job。
4. Worker 把人像合成到环境上，得到 16:9 定妆图，写入创作资产并归档到「数字人资产」。
5. 角色变为 `ready`。页面仍轮询本地状态。

定妆图不用 H3、不走 ComfyUI 队列。合成必须确定性、可重试。

### 编辑镜头

1. 用 `ready` 的 ComfyUI 角色新建作品。
2. 在中栏增删改镜头、调序、改时长和景别。
3. 口播句可手写，或让 AI 按主题 / 草稿 / 改写指令生成镜头列表。AI 只返回候选镜头，确认后才写入作品。
4. 页面防抖保存整个 `shots` 数组。

AI 提示必须明确：

- 按意群拆镜，不按时钟切；
- 每镜一句能在上限秒数内说完；
- 保留原文事实；
- 改成自然口语；
- 只返回镜头数组，不生成视频。

### 按镜生成

1. 用户点「生成这一镜」或「生成全部未完成镜头」。
2. 后端校验角色 `ready`、ComfyUI 已配置、时长合法、首帧存在。
3. 每一镜一个 `digital_human_shot_render` job，串行进入现有 Redis 队列。
4. Worker 用钉死的 H3 I2V 模板出片，下载到本地资产，更新该镜 `clip_asset_id`。
5. 同一镜再次生成：旧 clip 先留着，新任务成功后才替换指针；失败不丢旧 clip。

### 拼接成片

1. 每一镜都是 `succeeded` 且有 `clip_asset_id`。
2. 没有进行中的本作品按镜 job。
3. 后端冻结 `shots_snapshot`，创建 `TalkingVideoRender` 和 `digital_human_stitch` job。
4. Worker 按顺序拼接视频，镜间音频做 120ms 交叉淡化，画面硬切。
5. 本地 MP4 写入创作资产后，成片才 `succeeded`。没有当前版本时设为当前。

镜头列表在拼接任务创建之后被改过（镜头 id、顺序、clip 资产不一致）：拼接失败，不可自动用旧 snapshot 以外的 clip。重试拼接必须仍使用该成片冻结的 `shots_snapshot`。

## 定妆图合成

输入：人像 JPEG/PNG、环境 JPEG/PNG。

输出：16:9、短边 768、两边都能被 32 整除，即 `1344×768`。存为 JPEG 或 PNG，归档为数字人资产。

合成规则（第一期写死，不进设置）：

1. 环境图 cover 到 1344×768；
2. 人像按高度缩放到画面高度的 70%，水平居中，底边对齐画面底边；
3. 人像下方不做额外场景生成；
4. 不添加字幕、不添加台标。

换人像或默认环境后重跑角色 setup。作品覆盖环境只生成作品级定妆图，不改角色 `look_asset_id`。清空覆盖环境时清空作品 `look_asset_id`，各镜重新回退到角色定妆图。

## 提示词组装

Worker 把一镜打成单段英文/中文混合提示词，写入模板的 text 输入。固定模板：

```text
The same person from the first frame talks to camera.
Keep identity, clothing, and background stable.
Framing: {framing_label}.
{motion_prompt}
The person says: "{spoken_text}"
Natural speech motion, no subtitles, no captions, no on-screen text.
```

`framing_label`：`wide` → wide shot；`medium` → medium shot；`close` → close-up.

`motion_prompt` 为空则省略该行。不要把时长写进提示词；时长只写进工作流节点。

## ComfyUI 客户端和工作流

新增独立 TypeScript 客户端，集中处理：

- `GET /system_stats`
- `POST /upload/image`
- `POST /prompt`
- `GET /history/{prompt_id}`
- `GET /queue`
- `GET /view`（按 filename / subfolder / type 下载）

不记录 token、完整提示词或原始错误体。持久化事件只记安全状态、`prompt_id`、工作流版本、耗时和错误分类。

工作流模板放在：

```text
wemedia-studio/lib/comfyui/workflows/h3-i2v-v1.json
wemedia-studio/lib/comfyui/workflows/h3-i2v-v1.meta.json
```

`meta.json` 固定输入输出映射，禁止在代码里硬编码 ComfyUI 节点数字 ID：

```json
{
  "workflow_version": "h3-i2v-v1",
  "min_seconds": 4,
  "max_seconds": 15,
  "width": 1344,
  "height": 768,
  "inputs": {
    "image": "<node_id>:<input_name>",
    "prompt": "<node_id>:<input_name>",
    "duration": "<node_id>:<input_name>",
    "seed": "<node_id>:<input_name>"
  },
  "output_node": "<node_id>"
}
```

仓库提交一份可在 ComfyUI 0.30+ 加载的官方 H3 I2V API 格式模板。实现时按本机已安装的 Comfy-Org MiniMax H3 节点填映射；映射变更必须升版本号（`h3-i2v-v2`），旧 clip 和旧成片继续记录旧版本。

提交前把本机预算上限写入 duration，即使模板支持 15 秒。seed 在第一次提交时随机生成并写入镜头 `provider_state`；重试同一 job 复用该 seed。用户点「重跑这一镜」创建新 job 时换新 seed。

## durable job 设计

`digital_human_setup` 按 `role.provider` 分支：

```text
heygen
  -> heygen_avatar
  -> heygen_voice
  -> finalize_digital_human

comfyui
  -> compose_look
  -> finalize_digital_human
```

新增：

```text
digital_human_shot_render
  -> prepare_shot
  -> comfyui_i2v
  -> save_shot_clip

digital_human_stitch
  -> concat_shots
  -> save_talking_video
```

HeyGen 的 `digital_human_render` 保持原步骤。

`digital_human_shot_render` 的 `input_data` 为 `{ project_id, shot_id }`，幂等键为 `talking-shot:{project_id}:{shot_id}:{job_id}`。不要用「同一镜永远一个 job」：每次用户触发都是新 job，这样才能换 seed 重跑。

`digital_human_stitch` 的 `input_data` 为 `{ render_id }`，幂等键为 `talking-stitch:{render_id}`。

「生成全部未完成镜头」只给 `draft` / `failed` 且没有进行中 job 的镜头建任务。已是 `succeeded` 的镜头跳过。

Worker 每个轮询周期重读本地 job。取消后停止本地轮询和保存。ComfyUI 已接受的 `prompt_id` 可能继续跑完；结果不写回已取消的镜头。拼接取消不删除各镜 clip。

重试从失败 step 开始。若 `provider_state.prompt_id` 在 ComfyUI `/history` 里已成功，只下载，不重新 `POST /prompt`。

不可重试：

- ComfyUI 地址或鉴权无效；
- 模板缺节点或 meta 映射对不上；
- 时长超出本机上限或低于工作流下限；
- 角色、作品、镜头、首帧或 clip 资产不存在；
- 拼接时 snapshot 与任务创建时不一致（仅当重试用了错误输入；正常重试必须继续用 snapshot）。

可重试：

- ComfyUI 连不上、5xx、排队超时、下载中断；
- 本地保存暂时失败。

本机预算类（OOM、显存不足、ComfyUI 报 CUDA out of memory）：标失败，提示缩短时长或降低分辨率。不自动改 duration / 分辨率重跑。

## 本地 API

角色创建体增加：

```text
provider: "heygen" | "comfyui"
voice_sample_asset_id?: number   # HeyGen 必填
```

公开领域 API 增加：

```text
PUT    /api/talking-videos/{id}/shots
POST   /api/talking-videos/{id}/shots/{shot_id}/render
POST   /api/talking-videos/{id}/shots/render-pending
POST   /api/talking-videos/{id}/stitch
```

`PUT /shots` 接收完整镜头数组（可含已有 `id`）。服务端校验时长、景别、资产，重写 `script`，保留未出现在请求中的旧镜头的 clip 资产文件（只断开引用，不删文件）。

`POST .../renders` 仅用于 HeyGen 角色。ComfyUI 角色调用时返回 409，提示改走按镜生成和拼接。

Worker-only API 增加：

```text
GET  /api/settings/comfyui-runtime
POST /api/settings/comfyui/test
GET  /api/talking-videos/{id}/shots/{shot_id}/worker-context
POST /api/talking-videos/{id}/shots/{shot_id}/worker-progress
GET  /api/talking-videos/renders/{id}/worker-context   # 已有，拼接复用并返回 shots_snapshot
POST /api/talking-videos/renders/{id}/worker-progress  # 已有
```

设置读写增加 `comfyui_base_url`、`comfyui_auth_token`（只回传是否已设置和后四位）、`comfyui_max_shot_seconds`、`comfyui_min_shot_seconds`。

Next.js 脚本 route `POST /api/digital-human/script` 增加 ComfyUI 模式：请求带 `provider=comfyui` 时，响应为候选 `shots` 数组，而不是单段字符串。HeyGen 模式保持现有 `generate` / `convert_draft` / `rewrite`。

## 素材和文件约束

- 人像和环境图仍只接受 JPEG/PNG。ComfyUI 路径第一期不套用 HeyGen 的 32MB 上传限制；沿用创作资产现有上限。
- 定妆图、单镜 clip、拼接成片都归档到「数字人资产」。
- 单镜 clip 和成片必须是可播放的 MP4。H3 若输出 webm 或其他容器，worker 用 ffmpeg 转成 H.264 + AAC 再入库。
- Worker 通过内部 API origin 读本地资产，不能把浏览器 localhost URL 交给 ComfyUI。
- 上传到 ComfyUI 的首帧用内部 multipart，文件名带 `look-{roleId}` 或 `shot-{shotId}`，避免和工作室其他任务撞名。

## 删除和归档

沿用现有角色归档 / 删除保护。删除作品删除项目和成片记录，默认不删除已进创作资产的定妆图、单镜 clip 和成片文件。

删除失败或取消的成片版本不影响各镜 clip。成功成片若是当前版本，仍须先改选或清空当前版本才能删记录。

## 测试与验收

### 自动化

后端：

- `provider` 回填和不可变；
- ComfyUI 角色允许空录音，HeyGen 角色拒绝空录音；
- 创建 ComfyUI 角色时原子创建 setup job；
- 镜头时长上下限、拆镜校验；
- `PUT /shots` 重写 `script`；
- 未完成镜头不能拼接；
- 拼接冻结 `shots_snapshot` 并递增版本；
- ComfyUI 角色调用 `POST /renders` 返回 409；
- 设置脱敏、runtime 读取、连通性错误分类。

TypeScript：

- ComfyUI 客户端路径、上传、提交、history 复用 `prompt_id`；
- 提示词组装；
- setup 只走 `compose_look`；
- shot job 成功、失败、取消、重试不重复提交；
- OOM 不可自动改参；
- stitch 按 snapshot 顺序拼接，音频 120ms 淡化；
- worker 路由三个新/分支 flow；
- 脚本 AI 在 `provider=comfyui` 时返回镜头数组。

前端：

- 角色编辑后端选择；
- ComfyUI 作品中栏是镜头列表，HeyGen 作品仍是整段脚本；
- 时长选择不超过设置上限；
- 超长口播句提示拆镜；
- 按镜生成、全部未完成、拼接按钮的禁用条件；
- 当前镜预览和成片版本面板。

### 手工验收

在已安装 MiniMax H3 的本机 ComfyUI 上：

1. 设置页保存地址并测试连通。
2. 创建 ComfyUI 角色，定妆图出现且角色 `ready`。
3. 建作品，拆成两镜（4 秒和 5 秒），分别生成，单镜可预览。
4. 故意失败一镜，重跑后旧成功镜仍在。
5. 拼接后右栏能播完整成片，创作资产中有本地 MP4。
6. 改第二镜口播并重跑，再拼接得到 V2；V1 仍可预览。
7. 用同一套界面创建 HeyGen 角色（若有 Key），确认旧流程未被镜头列表打断。

## 非目标

- 用 H3 做静图主路径（封面、环境图仍走现有图片 provider）；
- 脚本 + TTS + 对口型；
- 尾帧续接长镜头；
- 用户编辑 ComfyUI 图；
- H3-Context-IR / 2K regenerate；
- 字幕、配乐、B-roll、多轨时间轴；
- 实时数字人；
- 自动发布；
- 去掉 HeyGen。

## Key Decisions

1. **HeyGen 与 ComfyUI 并列，角色级选择，创建后不可改。** 避免一个角色混用两套供应商 ID。
2. **ComfyUI 路径按镜头工作，不按整段脚本。** 与本机 5 秒上限一致，也和短视频切镜习惯一致。
3. **默认硬切，不用尾帧续接。** 降低身份漂和糊尾帧累积。
4. **时长按镜可调，上限是本机预算而不是产品常量。** 默认上限 5 秒，下限跟工作流走。
5. **H3 自带声音，ComfyUI 角色不要求录音。** 不把 HeyGen 的声音克隆契约套到 H3 上。
6. **定妆图本地合成，不出 ComfyUI。** GPU 只用来出 4–5 秒片子。
7. **按镜 job 与拼接 job 分开。** 单镜失败可单独重试；成片版本仍然不可变。
8. **工作流模板进仓库并用 meta 映射节点。** 换图必须升版本，旧成片可追溯。
9. **OOM 不自动降级重跑。** 避免静默改长度或分辨率，结果和用户提交不一致。

## Open Questions

无。时长上下限、切镜交互、job 切分和编辑页布局已在设计对话中确认。

## PR Plan

### PR 1 — ComfyUI 设置与客户端

- 影响：`backend/config.py`、`backend/routers/settings.py`、`wemedia-studio/app/settings/**`、`wemedia-studio/lib/comfyui/client.ts`、对应测试
- 依赖：无
- 保存/脱敏/runtime/连通性测试；尚不接业务 job

### PR 2 — 角色 provider、定妆图、可空录音

- 影响：`backend/models.py`、迁移、`digital_human_service.py`、`routers/digital_humans.py`、角色 UI、setup job 分支 `compose_look`
- 依赖：PR 1（setup 合成本身不依赖 ComfyUI，但 runtime 与设置分区应已存在）
- 存量角色回填 `heygen`；ComfyUI 角色可 `ready`

### PR 3 — 镜头模型与按镜生成

- 影响：`TalkingVideoProject.shots`、`TalkingVideoProject.look_asset_id`、shots API、环境覆盖时同步合成作品定妆图、`lib/comfyui/workflows/h3-i2v-v1.*`、`digital_human_shot_render` worker、脚本 AI 镜头模式
- 依赖：PR 1、PR 2
- 不含拼接

### PR 4 — 拼接成片与版本快照

- 影响：`TalkingVideoRender.shots_snapshot`、`digital_human_stitch`、`POST /stitch`、成片面板
- 依赖：PR 3
- HeyGen `POST /renders` 对 ComfyUI 角色返回 409

### PR 5 — 镜头编辑页

- 影响：`TalkingVideoEditor.tsx` 及测试、`RoleEditorDialog.tsx`、`ScriptAssistantDialog.tsx`
- 依赖：PR 3、PR 4
- HeyGen 作品保持整段脚本；ComfyUI 作品换成镜头列表、按镜预览和禁用规则
