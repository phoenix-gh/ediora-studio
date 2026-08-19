# 仙宫云 ComfyUI 运行环境设计

## 背景

WeMediaStudio 已经支持通过 ComfyUI 生成数字人镜头。当前 worker 直接连接配置的 ComfyUI 地址，但不会管理承载 ComfyUI 的 GPU 实例。本次变更接入仙宫云实例 API，并把它作为 ComfyUI 的可选运行环境：用户可以继续直连现有环境，也可以选择由仙宫云在数字人镜头任务开始前自动开机。

仙宫云文档提供以下实例操作：获取实例列表 `GET /open/instances`、获取单个实例 `GET /open/instance/{id}`、开机 `POST /open/instance/boot`、关机 `POST /open/instance/shutdown`。实例信息中的 `status` 用于判断 `running`、`booting`、`shutdown` 等状态；本项目选择普通关机接口，暂不使用释放 GPU 或销毁实例接口。

## 用户可见行为

### ComfyUI 运行环境

ComfyUI 设置增加“运行环境”选择：

- `直连 ComfyUI`：默认选项，保持现有行为，只使用 ComfyUI 服务地址，不调用仙宫云。
- `仙宫云（自动开机）`：数字人镜头生成前，使用已配置的仙宫云默认实例完成状态检查和必要的开机流程，然后连接 ComfyUI。

选择仙宫云不会替代 ComfyUI 服务地址。`comfyui_base_url` 仍然是 worker 实际提交工作流的地址；仙宫云只负责默认实例的电源状态管理。

### 仙宫云设置

设置页新增“仙宫云”分组，包含：

- API 地址，默认 `https://api.xiangongyun.com`；
- API Token，服务端保存，前端只显示是否已配置和末四位预览；
- 默认实例选择器，实例选项来自仙宫云实例列表；
- 当前实例详情，包括名称、ID、状态、GPU、CPU、进度和 Web 地址等可用信息；
- 刷新状态、开机、关机操作。

关机按钮只调用仙宫云 API，不会自动触发，也不会改变数字人业务状态。设置页使用普通“关机保留 GPU”接口。

仙宫云配置允许分步保存。只有选择“仙宫云（自动开机）”且开始数字人镜头任务时，才要求 Token 和默认实例完整；未完整配置时任务以明确的配置错误失败。

## 配置与安全边界

应用配置继续使用现有 `app_settings` 键值表：

- `comfyui_runtime_provider`: `direct` 或 `xiangongyun`，默认 `direct`；
- `xiangongyun_base_url`: 默认 `https://api.xiangongyun.com`；
- `xiangongyun_api_token`: 仙宫云 Token；
- `xiangongyun_default_instance_id`: 默认实例 ID。

普通设置响应只返回 Token 的 `set` 状态和末四位预览。设置页的实例列表、详情和操作由后端代理，浏览器不会获得 Token。可信 worker 通过现有 `X-Worker-Token` 保护的 runtime 设置接口获得当前运行环境、仙宫云地址、Token 和默认实例 ID；该接口不加入公开 schema，也不允许缺少或错误的 worker token。

仙宫云请求使用 `Authorization: Bearer <token>`，Token 不放入 URL、响应消息或普通日志。外部错误只保留状态和已脱敏的简短消息。

## 组件与接口

### 后端

新增一个小型仙宫云 HTTP 适配器，负责：

- 构造认证请求；
- 解析实例列表、实例详情和操作响应；
- 把 HTTP 错误、非成功业务响应转换成不泄露 Token 的应用错误。

设置路由扩展为：

- `GET /api/settings/xiangongyun/instances`：获取实例列表；
- `GET /api/settings/xiangongyun/instances/{instance_id}`：获取单个实例；
- `POST /api/settings/xiangongyun/instances/{instance_id}/boot`：开机；
- `POST /api/settings/xiangongyun/instances/{instance_id}/shutdown`：关机；
- `GET /api/settings/xiangongyun-runtime`：仅供可信 worker 读取运行时配置。

已有 `GET/PUT /api/settings` 负责读取和保存新增字段，并保持现有敏感字段脱敏模式。

### Worker 与数字人流程

新增 TypeScript 仙宫云 client，供 video worker 使用。它提供 `getInstances`、`getInstance`、`bootInstance`、`shutdownInstance` 和 `ensureInstanceRunning`。

`runDigitalHumanShotRenderJob` 在第一次读取镜头素材或调用 ComfyUI 前执行环境检查：

1. 直连模式跳过仙宫云 client；
2. 仙宫云模式读取默认实例配置；
3. 当前状态为 `running` 时直接继续；
4. 当前状态为 `shutdown` 时调用开机；
5. 当前状态为 `booting` 或开机后的异步状态时，轮询单实例详情；
6. 只有状态变为 `running` 后才继续 ComfyUI 上传和排队；
7. 进入销毁、失败或不可启动状态，或在 5 分钟内未变为 `running`，任务失败；
8. 轮询期间继续检查 durable job 是否已取消。

数字人 HeyGen 生成、ComfyUI 角色定妆图生成和本地视频拼接不增加仙宫云电源前置；本次前置针对实际使用 ComfyUI GPU 工作流的 `digital_human_shot_render`。

## 错误处理与兼容性

- 直连模式不读取仙宫云 Token，也不调用仙宫云 API。
- 仙宫云模式缺少 Token、默认实例或 ComfyUI 地址时，在任务开始阶段返回可操作的配置错误。
- 仙宫云鉴权失败、实例不存在和不可启动状态属于不可重试配置/业务错误。
- 仙宫云网络超时、5xx 和限流错误按现有 worker 重试语义标记为可重试；轮询超时记录为实例启动超时。
- 已提交但 worker 重启的任务会再次执行幂等的实例状态检查；不会重复开机一个已在 `running` 或 `booting` 的实例。
- 本次不实现任务完成后的自动关机。

## 验证范围

- 后端设置 round-trip、敏感字段脱敏、runtime worker 鉴权；
- 后端实例列表、详情、开机、关机请求的路径、认证头、请求体和错误转换；
- TypeScript client 的响应解析、状态转换、轮询、超时和取消；
- ComfyUI 设置中的运行环境选择和仙宫云设置中的实例选择/状态操作；
- 数字人镜头任务只在仙宫云模式执行开机前置，直连模式不产生仙宫云调用；
- 运行相关后端测试、精确前端 Vitest 文件、TypeScript 检查和生产构建。

