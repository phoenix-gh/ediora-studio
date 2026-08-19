# 多 LLM Adapter 与素材信息筛选设计

## 背景

当前设置只保存一组文本 LLM 配置和一组图片配置，调用方直接读取全局字段。这样无法在不同任务之间选择不同的 OpenAI-compatible 接口，也无法统一控制图片接口返回 URL 还是 base64。

本次把接口配置抽象为可复用的 Adapter 实例。第一阶段协议只支持 OpenAI-compatible HTTP API；一个 Adapter 只有一个模型字段，但可以分别声明是否支持文本和图片。运行时分别配置文字默认、图片默认和信息筛选 Adapter；X 内容筛选进入资产库时使用独立的信息筛选设置，并允许单个 X 订阅覆盖该设置。

## 目标

- 支持创建、编辑、删除多个 OpenAI-compatible Adapter。
- 每个 Adapter 配置名称、Endpoint、API Key、Model、文本能力、图片能力和图片响应模式。
- 提供一个文字默认 Adapter。
- 提供一个图片默认 Adapter。
- 提供一个独立的“信息筛选 Adapter”设置，专门用于把 X 内容筛选、归类进资产库的 LLM 调用。
- X 订阅可选填一个 Adapter；未填写时使用“信息筛选 Adapter”，该设置未填写时再回退到文字默认 Adapter。
- 图片生成按所选 Adapter 的配置支持 URL 或 base64；URL 模式由应用下载远程图片后再上传到本地资产存储。
- 保持现有任务、旧配置和已排队任务的兼容读取能力。
- API Key 不通过普通设置查询接口明文返回。

## 不在本次范围

- 不新增 Anthropic、Gemini 等协议；Adapter 的协议字段保留扩展空间，但当前只接受 `openai`。
- 不为文本和图片分别配置两个模型字段；一个 Adapter 只配置一个 `model`。
- 不提供一个同时覆盖文字和图片的全局默认 Adapter；文字和图片必须分别选择默认 Adapter。
- 不改变 X 内容的关键词初筛、AI 输出契约、去重和资产目录写入规则。
- 不把远程图片 URL 直接保存为资产 URL；URL 模式仍必须下载并经过现有资产上传流程。

## 核心概念

### Adapter 实例

Adapter 是一条可复用的接口配置，字段如下：

```json
{
  "id": "openai-main",
  "name": "OpenAI 主账号",
  "protocol": "openai",
  "endpoint": "https://api.openai.com/v1",
  "model": "gpt-4.1-mini",
  "supports_text": true,
  "supports_image": false,
  "image_response_format": "base64"
}
```

- `id`：应用生成的稳定标识，供设置、X 订阅和任务引用。
- `name`：用户可读名称，不能为空。
- `protocol`：当前固定为 `openai`，表示 OpenAI-compatible 接口。
- `endpoint`：API 根地址，保存时去除末尾 `/`；调用 `/chat/completions` 或 `/images/generations` 时统一拼接。
- `api_key`：只写字段。响应只返回 `api_key_set` 和脱敏预览。
- `model`：该 Adapter 唯一的模型字段，同时用于它声明支持的文本或图片调用。
- `supports_text` / `supports_image`：能力开关。未声明能力的 Adapter 不能被对应任务选中。
- `image_response_format`：仅影响图片调用，取值为 `url` 或 `base64`；不支持图片时仍保存默认值 `base64`。

### 选择优先级

不同任务按以下顺序解析 Adapter：

```text
调用方明确传入的 adapter_id
  -> X 订阅的 llm_adapter_id（仅 topic_source 信息筛选）
  -> 信息筛选 Adapter（仅信息筛选）
  -> 文字默认 Adapter（文本任务及未单独配置的信息筛选）
  -> 图片默认 Adapter（图片任务）
```

如果最终 Adapter 未声明所需能力，任务应直接失败并给出 Adapter 名称、能力类型和修复提示，不应静默切换到另一个不匹配的接口。

## 设置存储与迁移

继续使用 `AppSetting` 的 JSON 值，新增逻辑键：

- `llm_adapters`：Adapter 配置数组。API Key 加密/脱敏策略沿用现有设置保存方式；读取到内存后才用于调用。
- `llm_text_default_adapter_id`：文字默认 Adapter ID，可为空。
- `llm_image_default_adapter_id`：图片默认 Adapter ID，可为空。
- `llm_information_filtering_adapter_id`：信息筛选 Adapter ID，可为空。

为兼容已有安装：

1. 当 `llm_adapters` 不存在或为空时，文本运行时继续读取现有 `llm_provider`、`llm_model`、`llm_base_url`、`llm_api_key`。
2. 图片运行时继续读取现有 `image_api_key`、`image_base_url`、`image_model`，直到用户保存新的 Adapter 配置。
3. 设置页面首次加载旧配置时，把旧文本配置和旧图片配置展示为可迁移的 Adapter 草稿；如果两组旧配置不同，不强行合并为一个 Adapter，避免改变现有调用目标。
4. 新 Adapter 列表一旦保存，运行时优先使用新列表；旧字段仍保留用于旧客户端和回滚读取，不再覆盖新配置。
5. 已排队的旧任务仍可使用旧的运行时响应结构；新任务使用 Adapter 解析结果。

删除 Adapter 前校验其不是文字默认、图片默认、信息筛选 Adapter 或任何 X 订阅的覆盖值。用户需先改为其他 Adapter 或清空引用。

## 后端 API

### 设置读写

`GET /api/settings` 返回：

- `llm_adapters`：Adapter 公共字段数组，不包含明文 API Key。
- `llm_text_default_adapter_id`。
- `llm_image_default_adapter_id`。
- `llm_information_filtering_adapter_id`。
- 现有兼容字段和 `providers`。

`PUT /api/settings` 接收完整的 Adapter 列表和三个用途选择项。保存规则：

- 新建或修改 Adapter 时，非空 `api_key` 才覆盖已保存的 Key；空值表示保留原 Key。
- 需要清除 Key 时使用明确的 `clear_api_key` 标记，不把普通的空输入误当作清除操作。
- 校验 ID 唯一、名称非空、协议为 `openai`、model 非空、Endpoint 为合法 HTTP(S) URL、至少声明文本或图片能力。
- `image_response_format` 只允许 `url` / `base64`。
- 文字默认、图片默认和信息筛选 Adapter 必须引用存在且具备对应能力的 Adapter。

### 运行时解析

扩展 `GET /api/settings/ai-runtime`，支持：

- `adapter_id`：可选的明确 Adapter ID。
- `capability`：`text` 或 `image`，用于能力校验。
- `purpose`：`information_filtering` 时按信息筛选选择优先级解析。

返回选中的 Adapter 运行时字段：

```json
{
  "adapter_id": "openai-main",
  "protocol": "openai",
  "api_key": "...",
  "model": "gpt-4.1-mini",
  "base_url": "https://api.openai.com/v1",
  "image_response_format": "base64"
}
```

该接口继续受 worker token 保护。旧调用不传查询参数时保持旧响应字段，或由前端统一迁移到新字段，不能让现有 worker 因响应结构变化而失效。

## X 信息筛选流程

### 订阅配置

`XSubscription` 增加可空的 `llm_adapter_id`：

- 前端显示“信息筛选 Adapter”，默认选项为“跟随信息筛选设置”。
- 可选项只展示声明 `supports_text` 的 Adapter。
- 保存时校验 Adapter 存在且支持文本。
- 返回订阅时同时返回 `llm_adapter_id`，空值表示跟随信息筛选选择。

### 任务执行

`topic_source` 任务保留现有 `subscription_id`、`directory_ids`、`tweet_ids`，并可携带订阅的 Adapter 覆盖值。Worker 调用运行时配置时传入 `purpose=information_filtering` 和覆盖的 `adapter_id`（没有覆盖值时不传），由后端按上面的优先级解析。

筛选 LLM 的请求只替换模型和接口来源，不改变现有输入、固定 JSON 输出契约和落库校验：

```text
X 帖子采集
  -> 关键词确定性初筛
  -> 使用信息筛选 Adapter 的 topic_source LLM
  -> 校验 accepted/classifications 结果
  -> 写入选定资产目录
```

运行期间删除或禁用 Adapter、能力不匹配、Endpoint 请求失败等错误应让任务失败并记录可定位的 Adapter 名称/ID；不能自动改用默认文本模型，因为这会使信息筛选配置失效且难以追踪。

## 图片生成与落库

### base64 模式

继续使用现有 AI SDK 的图片生成路径。Adapter 的 `api_key`、`endpoint`、`model` 映射到 OpenAI provider；返回的 base64 由 SDK 转成字节，再进入现有 `saveCreativeAssetImage` / 草稿图片保存流程。

### URL 模式

不依赖 AI SDK 的只支持 base64 的解析路径，直接调用 OpenAI-compatible 图片接口：

1. `POST {endpoint}/images/generations`，请求体包含 `model`、`prompt`、`n`、可选 `size` 和 `response_format: "url"`。
2. 带参考图时调用对应的 `/images/edits` multipart 接口，同时传递 `response_format=url`。
3. 校验响应包含 `data[0].url` 且为 HTTP(S) URL。
4. 服务端/Worker 立即下载该 URL；下载请求不携带供应商的 Authorization 头。
5. 根据响应 `Content-Type` 或文件扩展名确定媒体类型，读取字节后复用现有资产上传接口保存到本地媒体目录。
6. 任何远程下载失败、非图片响应、空文件或 URL 无效都让本次生成失败，不保存远程 URL 作为最终资产地址。

OpenAI 官方图片接口对 GPT image 模型默认返回 `b64_json`，URL 返回格式主要适用于 DALL-E 2/3；因此当 Adapter 配置为 `url` 且模型属于不支持 URL 的 GPT image 系列时，设置保存可以成功，但运行时应返回明确的“不支持 URL 响应格式”错误，并在设置界面给出提示。适配器不能偷偷改回 base64，否则用户配置的返回模式无法验证。

### 统一调用入口

`image-generation.ts` 和 `content-job.ts` 通过同一个图片生成 helper 选择 base64 或 URL 路径，调用方只接收统一的 `{ bytes, mediaType }` 结果。所有现有图片生成入口（聊天工具、每日创作、提示词图片、内容任务）都继续复用现有本地资产保存逻辑。

## 前端设置

AI 设置页改为 Adapter 列表管理：

- 列表显示名称、协议、Model、Endpoint、文本/图片能力、图片响应模式和 Key 是否已配置。
- 支持新增、编辑、删除；编辑 Key 时使用掩码和“清除 Key”操作。
- 提供“文字默认 Adapter”选择，选项只包含支持文本的 Adapter。
- 提供“图片默认 Adapter”选择，选项只包含支持图片的 Adapter。
- 提供独立的“信息筛选 Adapter”选择，选项包含“跟随文字默认”和支持文本的 Adapter。
- 图片能力开启后显示 URL/base64 选择；选中 URL 且 Model 看起来是 GPT image 系列时显示兼容性提示。
- 旧单组文本/图片字段继续展示迁移结果或兼容提示，避免升级后用户看不到旧配置。

X 订阅对话框新增“信息筛选 Adapter”下拉框，默认“跟随信息筛选设置”，只列文本能力 Adapter。

## 错误处理

- 无可用 Adapter 或无 API Key：在设置校验或任务启动时给出明确错误。
- Adapter 不支持请求能力：拒绝调用并提示开启对应能力或更换 Adapter。
- 信息筛选 Adapter 未配置时：按文字默认 Adapter 解析；文字默认也未配置时沿用旧配置兼容路径。
- URL 图片接口只返回 base64、响应缺少 URL 或下载失败：任务失败，不创建空资产，不保存远程地址。
- 删除仍被引用的 Adapter：返回冲突，保留引用不变。

## 测试范围

### 后端

- Adapter 列表保存、读取、Key 脱敏、Key 保留/清除和协议/能力/模式校验。
- 文字默认、图片默认、信息筛选 Adapter 和无效引用校验。
- 旧单组文本/图片配置的兼容解析。
- X 订阅 `llm_adapter_id` 的新增、PATCH、返回和删除引用约束。
- `ai-runtime` 按 `adapter_id`、`capability`、`purpose=information_filtering` 的解析优先级。

### 前端

- AI 设置页 Adapter CRUD、文字默认/图片默认/信息筛选选择、单个 Adapter 测试、Key 掩码和图片模式交互。
- X 订阅选择 Adapter、默认跟随行为和保存回显。
- 图片 base64 路径保持现有 SDK 调用。
- 图片 URL 路径发送 `response_format=url`，下载远程字节后上传本地资产，且不把远程 URL 写入资产。
- URL 下载失败、响应缺少 URL、非图片响应和 GPT image URL 不兼容错误。
- `topic_source` 使用信息筛选 Adapter 请求文本模型并保持原有筛选输出契约。

只运行本次相关的后端测试和前端聚焦测试；不运行与本次改动无关的全量测试。
