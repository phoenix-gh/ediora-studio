# Docker Compose 可用构建设计

## 目标

让默认的 `docker compose up --build` 在不依赖 NVIDIA GPU 和本地 ASR
服务的情况下启动完整的自托管主链路：PostgreSQL、Redis、Python API、
Node worker 和 Next.js Web。API、worker、Web 使用同一个应用镜像，但仍
保持三个独立的 Compose 服务。保留 local-asr 作为显式可选能力，并让
生产构建时的浏览器 API 地址真正进入 Next.js 客户端代码。

## 范围

### 包含

- 为 `local-asr` 增加 `local-asr` Compose profile。
- 确保默认 Compose 启动和构建不要求 local-asr、CUDA 或 NVIDIA runtime。
- 保留 local-asr 的 GPU 配置、模型缓存和内部服务地址；通过
  `docker compose --profile local-asr up --build` 显式启用。
- 新增根目录多阶段 `Dockerfile`，在一个镜像中提供 Python API、Node worker
  和 Next.js Web 所需的运行时、依赖和构建产物。
- 让 `api`、`worker`、`web` 共用同一个镜像标签；只有 `api` 声明构建上下文，
  `docker compose build` 只生成一个应用镜像。
- 为统一应用镜像增加 `NEXT_PUBLIC_API_URL` 构建参数，并在 Compose 中从根
  环境文件传入；运行时环境继续提供服务端使用的 `WMS_API_URL`。
- 增加 GitHub Actions，在 push/PR 上校验 Compose 并编译这一个应用镜像；推送到
  `main` 或手动选择发布时，使用仓库 `GITHUB_TOKEN` 发布到 GHCR。
- 更新环境变量示例、自托管文档和 Compose 契约测试。
- 构建 `api`、`worker`、`web` 镜像，并验证默认服务的健康状态和 API/Web
  可访问性。

### 不包含

- 修改 local-asr 推理镜像、模型、GPU 参数或 `scripts/local-asr.sh`。
- 将 PostgreSQL、Redis 或 local-asr 打包进应用镜像。
- 修改业务 API、数据库模型、worker 任务或前端页面逻辑。
- 为 local-asr 增加 CPU fallback。
- 将真实的 LLM、图片、语音或 HeyGen provider 验收冒充为本地 Compose
  构建验收。

## 设计

### Compose 拓扑

默认拓扑保持为：

```text
postgres ─┐
          ├─ api ── web
redis ────┘   └── worker
```

`local-asr` 仍定义在主 Compose 文件中，但增加：

```yaml
profiles: [local-asr]
```

API 不在 `depends_on` 中声明 local-asr，因此默认启动不会等待或拉起 GPU
服务。启用 profile 时，API 通过现有的 `http://local-asr:8000/v1` 地址访问
它。PostgreSQL、Redis、上传文件、X session 和 Whisper 模型缓存的持久化
卷保持不变；Whisper 缓存只有在 profile 启用时才会被使用。

### 统一应用镜像

根目录 `Dockerfile` 使用多阶段构建：

1. Python 依赖阶段根据 `backend/requirements.txt` 创建 `/opt/venv`。
2. Node 依赖阶段根据 `web/package.json` 和 `web/pnpm-lock.yaml` 安装依赖。
3. Web 构建阶段接收 `NEXT_PUBLIC_API_URL` 并执行 `next build`。
4. 运行时阶段以 Node 22 为基础，安装 Python 3.11、ffmpeg、Chromium 和
   CJK/emoji 字体，复制 Python venv、后端代码、Web 代码、Node 依赖和
   `.next` 产物。

镜像保持以下目录契约：

```text
/app/                 Python API 工作目录
/app/web/             Next.js 与 Node worker 工作目录
/app/uploads/         API 上传卷
/app/sessions/        feedgrab session 卷
```

Compose 的 `api`、`worker`、`web` 服务使用同一个
`${WMS_APP_IMAGE:-ediora-studio}:${WMS_IMAGE_TAG:-local}` 镜像。API 保持
`/app` 工作目录；worker 和 Web 使用 `/app/web` 工作目录并通过不同的
`command` 启动。这样只有一个镜像需要在 GitHub Actions 中构建和发布，
但单个进程仍可独立重启、检查和记录日志。

### Web 构建配置

根目录 `Dockerfile` 的 Web 构建阶段声明并设置：

```dockerfile
ARG NEXT_PUBLIC_API_URL=http://localhost:8000/api
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
```

Compose 的唯一构建服务使用根目录构建上下文；Web 构建参数从
`${NEXT_PUBLIC_API_URL:-http://localhost:8000/api}` 解析。Web 容器运行时仍
设置相同的公开地址，并通过 `WMS_API_URL=http://api:8000/api` 给 Next.js
服务端路由使用内部网络地址。这样浏览器请求和容器内服务端请求分别使用
可达的地址。

### 环境和文档

在 `.env.example` 增加 `NEXT_PUBLIC_API_URL=http://localhost:8000/api`，
并在自托管文档中说明：修改该值后必须重新构建应用镜像。文档同时说明
local-asr 默认不启动，只有显式启用 profile 时才需要 NVIDIA runtime。

新增 `.github/workflows/docker-build.yml`，在 push、pull request 和手动触发
时执行 `docker compose config --quiet`、`docker compose build api`，并用
临时容器验证 Python API 和 Node worker 的依赖可导入。推送到 `main` 后，独立
的发布 job 使用 `docker/login-action`、`docker/metadata-action` 和
`docker/build-push-action`，通过 `GITHUB_TOKEN` 发布
`ghcr.io/<owner>/ediora-studio:latest` 与 `sha-<commit>`。PR 和普通分支不发布，
手动触发只有在 `main` 分支显式勾选发布时才发布。

## 验证策略

先更新 Compose 契约测试，使其验证：

1. `local-asr` 使用 `local-asr` profile、GPU reservation 和持久化缓存。
2. 默认服务集合的 `api.depends_on` 不包含 `local-asr`。
3. API 的 local-asr 地址仍指向 profile 内部服务。
4. `api`、`worker`、`web` 解析后使用同一个镜像；只有 `api` 拥有构建上下文。
5. 根构建上下文和构建参数包含公开 API 地址。
6. GitHub workflow 只构建默认应用镜像，不启用 `local-asr` profile。

实现后执行：

```bash
docker compose config --quiet
docker compose build api
docker compose run --rm --no-deps api python -c "import main"
docker compose run --rm --no-deps worker node -e "console.log(require.resolve('tsx'))"
docker compose up -d postgres redis api worker web
curl -fsS http://localhost:8000/health
curl -fsS http://localhost:3000
```

然后检查 `docker compose ps` 中默认五项服务为运行/健康状态，并确认未因
默认启动而创建或要求 local-asr。若 Docker daemon、GitHub runner 或外部
provider 凭据不可用，单独报告环境阻塞，不把它们归因于镜像构建结果。

## 失败处理

- 缺少或过短的 `WMS_WORKER_TOKEN` 继续让 API/worker fail closed；文档和
  `.env.example` 保持明确的 token 要求。
- `NEXT_PUBLIC_API_URL` 未设置时使用 localhost 默认值，保证现有本地访问
  路径不变。
- local-asr 未启用时，本地转写状态可以不可用；用户可选择远端转写 provider
  或显式启用 local-asr，不阻塞主应用启动。
