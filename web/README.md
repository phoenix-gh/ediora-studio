# Ediora Frontend

Next.js 前端应用。完整本地运行时应从项目根目录统一启动：

```bash
export WORKER_TOKEN="$(openssl rand -hex 32)"
./dev.sh
```

默认 Web 为 `http://localhost:3000`、API 为
`http://localhost:8000`、worker 使用 `content-jobs` 队列，宿主机 Redis
为 `redis://127.0.0.1:6379/0`。`WORKER_TOKEN` 必须至少 32 字符，
并由 API 与 worker 共享。API、worker 与 Web 会按统一配置指纹整体复用或
替换；worker 必须完成 Redis 连接与启动协调，并使用脚本传入的
`WORKER_READY_FILE` 发布匹配当前进程标记和配置指纹的原子就绪握手，
仅有进程存活不算就绪。已有健康 Redis 会作为 external 服务复用且不会被
`./dev.sh stop` 停止；完整状态与日志可用 `./dev.sh status` 和
`./dev.sh logs` 查看。

前端 API 地址由 `NEXT_PUBLIC_API_URL` 配置；统一脚本会按实际
`API_PORT` 自动设置。`NEXT_PUBLIC_DEVELOPER_MODE` 默认关闭，Compose 和
`dev.sh` 会在启动 Web 服务时将它映射为服务端运行时配置。只有设置为
`1`、`true`、`yes` 或 `on` 时，Job、Chat 和设置页才显示 Agent 运行轨迹、AI
完整消息和执行事件。修改开发者模式无需重新构建镜像，只需重新创建 Web 容器
或执行 `./dev.sh restart`；直接运行 Next.js 时使用服务端环境变量
`DEVELOPER_MODE`。`NEXT_PUBLIC_API_URL` 仍是构建时配置。默认 CORS 同时包含当前 Web 端口的
`127.0.0.1` 与 `localhost` 地址。完整启动、ready 文件格式、端口覆盖和
进程所有权规则见项目根目录 `README.md`。

## 文字视频本地配置

MiMo 语音凭据只保留在服务端，官方 base URL 为
`https://api.xiaomimimo.com/v1`。转写 provider 必须返回
`verbose_json.words`。AI 分段先预览再应用；所有已生成口播段都要人工试听
确认，才能生成主音频并进入按稳定 word range 生成分镜的阶段。当前里程碑
只有 Remotion 时间轴预览，不提供 MP4 渲染或音色克隆；不明确是否成功的
付费 provider 调用必须由用户手动重试，并可能再次计费。

## 数字人口播本地开发

数字人口播由 Python API 保存角色、作品、版本与创作资产，统一脚本启动的
Node worker 调用 HeyGen。

HeyGen API Key 只在「设置 → HeyGen」保存；API 与 worker 通过受保护的运行时接口读取配置，不从环境变量回退。角色素材只接受 PNG/JPEG 与 MP3/WAV，且发送给 HeyGen 的单文件上限为 32MB。声音克隆要求 HeyGen 套餐具备相应权限；成片完成后会被下载到后端本地 uploads，而不是长期引用 HeyGen 的临时 URL。
