# 文字视频 MP4 导出设计

## 目标

在文字视频作品的“视频合成”阶段提供可靠的本地 MP4 导出闭环：

- 使用作品当前 Remotion 模板、分镜、音频、画面比例、分辨率和 FPS。
- 固定输出 H.264 MP4 + AAC 音频，不在第一版增加编码参数面板。
- 渲染作为持久后台任务执行，关闭页面后任务仍继续。
- 页面显示排队、渲染进度、失败、完成和成片过期状态。
- 完成后可在线播放、下载，并将文件登记为创作资产。
- 重新渲染产生新的资产；失败或渲染中保留上一版成片。

## 非目标

- 不接入 Remotion Lambda 或其他云渲染平台。
- 不提供 WebM、GIF、ProRes、透明视频等额外格式。
- 不提供码率、CRF、编码器、音频采样率等专家设置。
- 不提供多个并发清晰度版本。
- 不删除旧的成片资产；作品只指向最新成功成片。

## 方案选择

### 采用：现有 Redis 内容 Worker 内本地渲染

复用 `content_jobs`、Redis 队列、Node Worker 和 Worker Token 边界。新增
`text_video_render` flow，由 Worker 使用 `@remotion/bundler` 和
`@remotion/renderer` 执行。

优点：

- 任务可持久化、可对账，页面关闭不影响执行。
- 沿用现有配音、主音频、分镜任务的启动和轮询模型。
- 不引入云账户和外部存储。
- Worker 天然可以运行 TypeScript Remotion 项目。

### 未采用：Next.js 请求内同步渲染

请求生命周期过短，容易因反向代理超时、页面关闭或 Web 容器重启而丢失结果。

### 未采用：Remotion Lambda

扩展性更强，但需要 AWS、对象存储和部署配置，不符合当前轻量自托管边界。

## 数据模型

`text_video_projects` 新增 `render_state JSON NOT NULL`，默认结构：

```json
{
  "status": "missing",
  "generation": 0,
  "source_hash": "",
  "job_id": null,
  "applied_job_id": null,
  "asset_id": null,
  "progress": 0,
  "error": ""
}
```

状态为：

- `missing`：从未发起渲染。
- `queued`：任务已入队。
- `rendering`：Worker 已开始渲染。
- `ready`：当前成功成片已写回。
- `stale`：作品内容已变化，现有成片仍可播放但不是当前版本。
- `failed`：最新一次渲染失败，上一版成片仍保留。

现有字段继续承担稳定职责：

- `output_asset_url`：最新成功成片 URL。
- `output_stale`：该 URL 是否对应旧版作品内容。
- `status=completed`：最新成功成片与当前渲染输入一致。

普通编辑不会清空 `output_asset_url`；只将 `output_stale` 和
`render_state.status` 标记为 `stale`。渲染失败也不会丢失上一版成片。

## 渲染身份与并发

启动渲染时，后端对经过模板校验的完整 `render_input` 做规范化 JSON 序列化，
并计算 SHA-256 `source_hash`。Job 的 `input_data` 固化：

```json
{
  "project_id": 2,
  "project_revision": 18,
  "render_generation": 3,
  "source_hash": "...",
  "composition_id": "tech-text-v1",
  "render_input": {}
}
```

规则：

- 同一作品仅允许一个 `queued` 或 `rendering` 渲染任务。
- 重复点击正在执行的同一任务时返回现有 Job，不重复入队。
- 成功后的“重新渲染”会递增 generation 并创建新 Job。
- Worker 只使用 Job 内的冻结快照，不读取正在编辑的前端草稿。
- 写回前再次验证 generation、job_id 和 source_hash；旧任务不得覆盖新任务。

## API

### 用户接口

`POST /api/text-videos/{project_id}/render`

请求：

```json
{ "revision": 18 }
```

启动前验证：

- revision 当前；
- 主音频与词时间轴 ready；
- 分镜 ready 且与主音频 source hash 一致；
- `render_input.audio`、segments、模板和 composition 合法；
- 音频属于本机 `/api/uploads/` 路径。

响应沿用其他文字视频任务：

```json
{
  "jobs": [
    { "id": 301, "flow": "text_video_render", "target_id": 2 }
  ],
  "project": {}
}
```

`GET /api/text-videos/{project_id}/output/download`

- 仅允许读取作品当前 `output_asset_url` 指向的本地视频资产。
- 返回 `video/mp4` 和 `Content-Disposition: attachment`。
- 文件不存在时返回 404，不返回空响应或 HTML 错误页。

### Worker 接口

以下接口必须校验 `X-Worker-Token` 和 `X-Content-Job-Id`：

- `GET /{project_id}/render/worker-context`
  - 返回冻结输入、composition id 和已应用结果。
- `POST /{project_id}/render/worker-progress`
  - 接收 source hash、generation 和 0–100 整数进度。
  - 只更新 `render_state` 与运行中 step 的进度，不递增作品 revision。
- `POST /{project_id}/render/worker-result`
  - multipart 上传 MP4。
  - 流式写入临时文件，验证非空、大小上限和 MP4 content type。
  - 在数据库事务内创建 `CreativeAsset(source="generated")` 并写回作品。
  - 使用 `applied_job_id` 保证响应丢失后的重放不会产生第二个资产。
- `POST /{project_id}/render/worker-failure`
  - 仅允许当前 generation/job 写入失败状态和错误。

## Worker 渲染

新增 `runTextVideoRenderJob(jobId)`：

1. 获取 Worker Context 并验证 Job 未取消。
2. 将快照中的 `/api/uploads/...` 音频改写为 Worker 可访问的绝对 API URL。
3. 复用进程级 Remotion bundle Promise，避免每个任务重复打包。
4. 用 `selectComposition()` 读取动态 duration、fps、width、height。
5. 用 `renderMedia()` 输出 H.264/AAC MP4 到 `mkdtemp()` 临时目录。
6. 将 Remotion 进度按整数节流并上报。
7. 验证生成文件存在、非空且没有超过上传上限。
8. multipart 上传结果并完成 Job。
9. 无论成功或失败都清理 Worker 临时目录。

Worker 镜像改为 Remotion 支持的 Debian Node 基础镜像，并在构建阶段准备
Chrome Headless Shell 及所需系统库。`worker` 服务挂载可选 bundle 缓存目录，
但不依赖 API 的 uploads volume；输入通过 HTTP 读取，结果通过受保护接口上传。

## 前端

`VideoStage` 右侧导出区域改为：

- 未满足渲染条件：按钮禁用，并显示需要先完成分镜/时间轴。
- 可渲染：主按钮“渲染 MP4”。
- 排队：主按钮“等待渲染…”。
- 渲染中：主按钮“正在渲染 37%”并显示进度条。
- 失败：显示错误，主按钮“重新渲染”。
- 成功且当前：显示“播放成片”“下载 MP4”“重新渲染”。
- 有旧成片但当前输入变化：保留播放/下载，并提示“这是上一版成片”。

点击“渲染 MP4”必须先 `autosave.flush()`，再用后端返回的规范项目进入轮询。
页面轮询 Job 的同时读取运行 step 的 `progress`，刷新页面后从
`project.render_state` 恢复进度与状态。

在线播放使用 API 绝对 URL；下载使用专用 attachment 接口。

## 错误与恢复

- Bundle、浏览器、音频下载、编码和上传分别使用可识别的 Job step。
- 临时网络错误标记 retryable；输入无效、模板不存在、媒体格式错误不可重试。
- 用户点击失败状态的“重新渲染”创建新 generation，而不是复用可能带有临时文件
  状态的旧 step。
- Worker 或 API 重启后，现有 Job reconciliation 会重新入队非终态 Job。
- 已写回结果但 Worker 未收到响应时，`applied_job_id` 使结果接口幂等返回。
- 旧 generation 的迟到进度、失败和结果全部返回冲突，不改变作品。

## 测试与验收

### 后端

- schema 迁移为存量项目补默认 render state。
- 启动条件、revision 冲突、活动任务复用、冻结输入和 source hash。
- Worker progress 的身份校验与单调进度。
- MP4 结果原子写入、幂等重放、旧任务拒绝和旧成片保留。
- 下载接口 content type、attachment、文件缺失和路径越界。

### Worker

- flow 路由到 `runTextVideoRenderJob`。
- 相对音频 URL 改写为内部 API URL。
- composition 选择、H.264/AAC 参数、进度节流、上传和临时文件清理。
- 失败上报、可重试分类、取消和结果响应丢失。

### 前端

- 入口禁用条件与所有状态文案。
- 启动前保存、任务轮询、进度显示、失败重渲染。
- 成片播放和下载链接。
- 旧成片提示与重新渲染后更新。

### 真实验收

使用一个已完成时间轴和分镜的真实作品：

1. 点击“渲染 MP4”。
2. 页面显示排队和非递减进度。
3. 页面关闭后重新打开，任务状态仍存在。
4. 任务完成后页面出现视频播放器和下载按钮。
5. 下载文件可由 `ffprobe` 识别为 H.264 视频与 AAC 音频。
6. 视频时长与主音频时长误差不超过一帧。
7. 播放检查画面、文字动画和音频同步。
8. 修改模板视觉后旧成片保留并标记过期，再渲染产生新 URL。
