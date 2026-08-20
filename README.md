# Ediora · 述策

AI 内容工作台：集信息采集、价值甄选、AI 创作与发布辅助于一体。

## 技术栈

- **后端**：FastAPI + PostgreSQL（SQLAlchemy async）+ APScheduler，Python 3.11（conda env: wems）
- **前端**：Next.js App Router (16.x) + Tailwind CSS + shadcn/ui，包管理器 pnpm
- **AI 层**：多 Provider（OpenAI / Anthropic / DeepSeek / 通义千问 / Moonshot / GLM / MiniMax / MiMo / 自定义）
- **X 采集**：feedgrab（Cookie 认证）
- **任务执行**：PostgreSQL 持久化任务 + Redis 队列 + Next.js AI SDK worker

## 目录结构

```
Ediora/
├── backend/
│   ├── main.py                 应用入口（瘦版本，94 行）
│   ├── scheduler.py            APScheduler 任务注册 + 节流
│   ├── models.py               SQLAlchemy ORM
│   ├── database.py             数据库连接（默认 Postgres）
│   ├── config.py               app_settings 键值配置（60s 缓存）
│   ├── collector.py            RSS/YouTube/Reddit 通用采集
│   ├── llm.py                  多 Provider LLM 调用
│   ├── x_response_service.py   X 即时响应策略、幂等任务与补偿
│   ├── x_response_links.py     外链安全核验
│   ├── telegram_notifier.py    Telegram Bot API 推送
│   ├── *_collector.py          站点专用采集器（juejin/kr/v2ex/wechat/x/youtube/...）
│   ├── mcp_server.py           MCP streamable HTTP server
│   └── routers/                FastAPI 路由（统一 prefix=/<module>，main 处加 /api）
│
├── web/
│   ├── app/                    页面（drafts/topics/quotes/github/papers/...）
│   ├── components/
│   │   ├── features/           业务组件（Sidebar/ArticleReader/...）
│   │   └── ui/                 shadcn/ui
│   └── lib/
│       ├── api/                各模块 API 客户端
│       ├── format.ts           共享格式化 helper（fmtRelTime/fmtNum/fmtCount/fmtShortDate/fmtFullDate）
│       ├── use-infinite-scroll.ts 共享无限滚动 hook
│       └── use-media-query.ts  媒体查询 hook
│
└── chrome-plug/                Chrome 插件
```

## 启动方式

宿主机开发推荐从项目根目录使用统一脚本。先确保 Docker、conda 环境
`wems`、`pnpm` 和 `redis-server`（仅在本机没有可用 Redis 时需要）可从
当前 `PATH` 找到。首次使用时从示例创建根环境文件，并在其中配置 API 与
内容任务 worker 共用的 32 字符以上 token：

```bash
cp .env.example .env
# 编辑 .env，设置 WORKER_TOKEN
./dev.sh
```

之后日常开发只需执行 `./dev.sh`。脚本会自动加载根 `.env` 并把其中的变量
导出给所有子进程；命令行显式传入的环境变量优先，例如
`WEB_PORT=3001 ./dev.sh` 不会被 `.env` 覆盖。脚本按 PostgreSQL TCP
就绪 → Redis PING → API HTTP 就绪 → worker 就绪握手 → Web HTTP 就绪的
顺序启动完整运行时：

```text
Postgres: wms-dev-postgres-copy (127.0.0.1:55432)
Web:    http://localhost:3000
API:    http://localhost:8000
Worker: content-jobs queue
Redis:  redis://127.0.0.1:6379/0
```

默认情况下，脚本检查 Docker 容器 `wms-dev-postgres-copy`；若容器已停止则
自动启动，并等待 `127.0.0.1:55432` 可连接。可分别通过
`DEV_POSTGRES_CONTAINER`、`DEV_POSTGRES_HOST` 和
`DEV_POSTGRES_PORT` 覆盖容器名和连接地址。PostgreSQL 是持久化外部
依赖，不属于脚本拥有的临时进程；`./dev.sh stop` 和启动失败回滚都不会
停止该容器。API 默认使用这个开发数据库生成 `DATABASE_URL`；如果数据库
用户、密码或数据库名不同，可在 `.env` 中显式设置 `DATABASE_URL` 覆盖默认值。

本地语音转写使用独立的 GPU 容器，不依赖整套 Docker Compose。首次运行或
容器被手动停止后执行：

```bash
./scripts/local-asr.sh start
```

容器名为 `ediora-local-asr`，使用 `restart=unless-stopped`，只在宿主机
`127.0.0.1:8001` 暴露服务；开发模式 API 默认连接
`http://127.0.0.1:8001/v1`。模型缓存保存在独立 Docker volume 中。

若 `127.0.0.1:6379` 已有能响应 PING 的 Redis，脚本只连接并把它标记为
`external`，`./dev.sh stop` 不会停止它；否则脚本启动并只管理自己创建的
临时 Redis。API、worker 与 Web 作为一个配置单元，共享同一个宿主机
Redis URL、队列名、`WORKER_TOKEN`、API URL 与 CORS 配置。任一配置
变化都会完整替换这三项服务，避免新旧配置混跑。默认 CORS 同时允许当前
`WEB_PORT` 对应的 `127.0.0.1` 和 `localhost` 地址；需要覆盖时设置
`CORS_ORIGINS`。端口可分别用 `REDIS_PORT`、`API_PORT` 和
`WEB_PORT` 覆盖。

worker 启动后只有完成 Redis 连接和启动时的待处理任务协调，才可以向
`WORKER_READY_FILE` 原子写入当前进程的
`DEV_SERVICE_MARKER` 与 `DEV_CONFIG_FINGERPRINT`：

```text
marker=<DEV_SERVICE_MARKER>
config_fingerprint=<DEV_CONFIG_FINGERPRINT>
```

统一脚本会在每次启动 worker 前删除旧文件，并校验标记、配置指纹和进程
所有权；仅有存活进程或遗留 ready 文件都不算就绪。握手超时会回滚本次
启动。内容 worker 的实现应先写同目录临时文件，再以 rename 替换目标，
不能直接逐行改写 ready 文件。

```bash
./dev.sh status
./dev.sh logs                 # 跟随四项服务日志
./dev.sh logs --no-follow     # 只看最近日志
./dev.sh restart
./dev.sh stop
```

脚本只停止带有匹配 PID、进程组、Linux 启动时间和本次服务标记的进程，
不会依据一个复用或过期的 PID 误杀其他服务。停止时会检查整个已记录进程
组中的非僵尸成员；TERM 超时后升级为 KILL，只有确认进程组清空才删除
所有权元数据并报告成功。无法清理时命令返回失败并保留元数据。任一启动
阶段失败时，只会逆序回滚本次新创建的进程。

### 自托管（Docker Compose）

开源版不需要 Hermes、Agent profile 或本地任务看板。Linux 和 macOS
推荐使用仓库根目录的一键安装器：

```bash
./install.sh
```

也可以在新主机上直接执行：

```bash
curl -fsSL https://raw.githubusercontent.com/phoenix-gh/ediora-studio/main/install.sh | sh
```

也可以先下载单文件再运行（请放在不含完整 Ediora checkout 的目录中）：

```bash
curl -fsSLo install.sh https://raw.githubusercontent.com/phoenix-gh/ediora-studio/main/install.sh
chmod +x install.sh
./install.sh
```

Linux 上如果 Docker Engine 或 Compose v2 不可用，Ubuntu 22.04/24.04 安装器会
先说明将通过 Docker 官方 apt 仓库安装 Docker Engine、Buildx 和 Compose 插件，
并要求输入 `y`/`yes` 确认后才使用 `sudo`。其他 Linux 发行版需要先自行安装
Docker。macOS 需要先安装并启动 Docker Desktop；安装器不会通过 apt 或 sudo
安装 macOS Docker。它不会在宿主机安装 Python、Node.js、
PostgreSQL 或 Redis。安装器会交互式创建或补全根目录 `.env`，保留已有值，
并将文件权限设为 `0600`；数据库密码、worker token 和 X 会话密钥可接受
安全随机默认值，provider API Key 不会写入该文件。`NEXT_PUBLIC_API_URL`
会按 `API_PORT` 自动生成，`CORS_ORIGINS` 会按 `WEB_PORT` 自动包含
`127.0.0.1` 和 `localhost`；已有自定义 URL 或来源会保留。

从远程命令或单独下载的脚本运行时，安装器会显示目录选择：
`1` 当前目录、`2` `$HOME/ediora-studio`、`3` 自定义目录；直接回车默认选择
`2`。自动化场景可通过 `EDIORA_INSTALL_DIR=/srv/ediora` 跳过目录询问。
从其他目录调用某个 checkout 中的 `install.sh` 时，也不会把脚本所在目录
当作目标；只有当前工作目录本身是完整 Ediora checkout 时才会原地运行。

默认流程只下载 `docker-compose.yml`，使用 `ghcr.io/phoenix-gh/ediora-studio:latest` 拉取镜像后以
`docker compose up -d --no-build` 启动，不会下载源码，也不会启动可选的 `local-asr` profile。
重复运行会保留 `.env` 和 Compose 文件旁的 `data/` 目录。安装器不负责构建镜像；需要本地构建时，
请在完整源码 checkout 中单独执行 `docker compose build api`，再执行
`docker compose up -d --no-build`。非交互地确认 Docker 安装时可使用 `./install.sh --yes`，管道命令则使用
`curl -fsSL https://raw.githubusercontent.com/phoenix-gh/ediora-studio/main/install.sh | sh -s -- --yes`。
模型、图片、语音和
HeyGen 凭据在 Web 启动后从 Ediora「Settings」配置，不通过安装器收集。

自托管运行时数据全部位于 `data/`：

```text
data/postgres         PostgreSQL 业务库
data/redis            Redis 队列数据
data/uploads          上传和生成的图片、音频、视频
data/sessions         X/feedgrab session（敏感，权限 700）
data/web-runtime      上传 Skill 与启用状态
data/scheduler        调度器节流状态
data/avatars          头像缓存
data/wechat-images    微信图片缓存
data/local-asr-models 可选 local-asr 模型缓存
```

升级前至少备份 `data/postgres`、`data/uploads`、`data/sessions`、
`data/web-runtime` 和根目录 `.env`；其中 `.env` 的 `X_SESSION_KEY` 必须与
`data/sessions` 一起保留。改为 `data/` 后不会自动迁移旧 Docker 命名卷。

安装完成后可使用以下安全运维命令：

```bash
docker compose ps
docker compose logs -f api worker web
docker compose stop
```

如果 GHCR package 为私有，先执行 `docker login ghcr.io`。本地语音转写仍是
独立的可选 profile：

```bash
docker compose --profile local-asr up -d
```

需要手动控制环境变量时，也可以复制模板后启动：

```bash
cp .env.example .env
docker compose up --build
```

上面的手动命令才负责本地构建；`install.sh` 只负责 Docker 环境、Compose 配置、环境变量、镜像拉取和启动。

API、worker 和 Web 共用一个由根目录 `Dockerfile` 构建的应用镜像，但仍以三个独立
服务运行；另有 Postgres 和 Redis。默认启动不会拉起 GPU 依赖的 local-asr。
如需启用本地语音转写，可使用：

```bash
docker compose --profile local-asr up --build
```

修改 `NEXT_PUBLIC_API_URL` 或 `NEXT_PUBLIC_DEVELOPER_MODE` 后需要重新构建应用镜像，
因为它们会在 Next.js 构建阶段写入浏览器 bundle。将
`NEXT_PUBLIC_DEVELOPER_MODE=1`（也支持 `true`、`yes`、`on`）写入 `.env` 后，
Job/Chat/设置中的 Agent 运行轨迹、AI 完整消息和执行事件才会显示。服务会启动
Web（3000）、Python API（8000）、Postgres、Redis 和内容任务 worker。
`POSTGRES_PASSWORD` 可在 `.env` 中覆盖；首次启动前还需把
`WORKER_TOKEN` 改成一个长随机值。API 与 worker 必须使用同一个值，
且不得使用 `NEXT_PUBLIC_` 前缀。LLM、图片和 HeyGen 密钥只配置在服务端，
统一在「设置」页面保存，运行时不会从环境变量读取 provider 密钥，绝不放入浏览器变量。
如果宿主机的 8000 或 3000 已被占用，可在 `.env` 中设置 `API_PORT` 或
`WEB_PORT`；这只改变宿主机映射，不改变容器内端口。

### GitHub Actions 与 GHCR

`.github/workflows/docker-build.yml` 会在 PR 和普通分支推送时只做构建验证；推送到
`main` 后，GitHub Actions 会使用仓库 `GITHUB_TOKEN` 自动发布：

```text
ghcr.io/phoenix-gh/ediora-studio:latest
ghcr.io/phoenix-gh/ediora-studio:sha-<commit>
```

也可以在 GitHub Actions 页面手动运行 workflow，在 `main` 分支勾选 `Publish the image
to GHCR`。首次发布后，可在 GitHub Package 设置中调整公开/私有权限。使用已发布镜像时，
在 `.env` 设置：

```dotenv
APP_IMAGE=ghcr.io/phoenix-gh/ediora-studio
IMAGE_TAG=latest
```

然后执行 `docker compose up -d --no-build`；私有镜像需要先执行 `docker login ghcr.io`。

## 文字视频（当前里程碑）

「创作 → 文字视频」把整篇文稿先生成一条主音频，再依据转写词级时间轴
驱动 Remotion 动态文字场景。语音与转写凭据都保留在服务端；MiMo 使用
官方 `https://api.xiaomimimo.com/v1` 地址。可在设置页保存语音配置，
所有语音 provider 配置（包括 API Key、模型和 endpoint）都在「设置 → 语音」保存；
运行时不会从 `.env` 读取语音凭据。

转写 provider 必须返回带 `words` 数组的 `verbose_json`，系统才能把每个
稳定 word ID 投影到精确秒数。AI 自动分段只产生预览，用户点击“应用分段”
后才修改项目；每个生成完成的口播段都必须人工试听并确认，全部确认后才能
生成主音频。分镜 AI 只操作稳定的词范围，最终起止秒数由 Python 后端投影。

若付费 provider 调用在响应是否送达不明确时中断，系统不会自动重复扣费
调用，需要用户明确重试，并可能再次计费。当前里程碑提供带真实音频时间轴的
Remotion 预览，**不包含 MP4 文件渲染，也不包含音色克隆**。

## 数字人口播（HeyGen）

「创作 → 数字人口播」提供可复用数字人角色、项目内脚本编辑、环境图和不可变成片版本：

1. 在「设置 → HeyGen」保存 API Key。API 与 Node worker 只通过受保护的运行时接口读取已保存配置，不从环境变量回退读取，浏览器不会拿到明文密钥。
2. 创建角色时选择一张 PNG/JPEG 正面照、一段 MP3/WAV 录音和一张默认环境图。直接发送给 HeyGen 的单个素材最大 32MB。
3. 在口播作品内手写脚本，或让 AI 按主题生成、把已有草稿转换为口播、改写当前脚本。AI 候选只有确认后才替换编辑器内容，不会自动生成视频。
4. 每次生成都会冻结脚本、角色和环境为独立版本。HeyGen 返回的临时下载地址不会作为最终资产；worker 会把 MP4 复制到本地 `uploads` 创作资产后才标记成功。

声音克隆需要 HeyGen 账号具备相应套餐权限；免费或受限套餐可能返回 `plan_upgrade_required`。

真实 HeyGen 冒烟测试是显式可选操作，会产生 API 用量：

```bash
cd web
HEYGEN_API_KEY=... \
HEYGEN_SMOKE_PORTRAIT=/absolute/path/portrait.png \
HEYGEN_SMOKE_VOICE=/absolute/path/voice.wav \
HEYGEN_SMOKE_ENVIRONMENT=/absolute/path/environment.jpg \
pnpm heygen:smoke
```

脚本只输出资源 ID、文件大小和耗时，不输出 API Key。

## X 即时响应助手

该功能用于关注指定 X 时间线账号（例如 Claude、ChatGPT/OpenAI 官方账号），在新帖采集后自动判断是否值得立即评论、翻译引用转发、继续观察或忽略。输出和可发布草稿统一为中文，产品名、模型名与 API 名保留原文。

工作流如下：

1. 在「X → 订阅管理」添加账号时间线，并为需要关注的账号开启「即时响应」。搜索订阅不能开启此功能。
2. 新的原创帖入库后，以 `x-response:{tweet_id}` 幂等键进入 Redis worker；每 5 分钟运行一次补偿扫描。
3. worker 依次完成资格判断、外链安全核验、AI 决策、结果持久化和通知。含外链但无法核验的公告会强制降级为“观察”，不会生成可发布翻译稿。
4. 评分不低于 75 且置信度不低于 70% 的建议即时推送 Telegram；50–74 分的建议在 Asia/Shanghai 18:00 汇总；更低分仅保留在「待响应」页面。
5. 在「待响应」中复制草稿后自行到 X 发布，并标记“已采用”或“忽略”。

系统只生成与推送建议，**永远不会自动调用 X 的发布、回复、转发或引用接口**。X 采集由定时器每 5 分钟检查一次，实际端到端延迟还取决于设置中的采集间隔和模型响应时间。

### X 采集账号池

- 打开「设置 → X / Twitter → X 采集账号池」可以新增、编辑、启停、测试和删除由 UI 管理的采集账号。凭据只写入后端 session 目录，界面和 API 只返回脱敏预览。
- 所有已启用凭据组成 feedgrab 的全局轮换池；单个账号遇到限流时，后续请求可切换到其他可用账号。
- 既有的 `feedgrab login twitter` session 继续参与采集，但在 UI 中仅显示为外部 session，不能查看、修改或删除。
- 本地运行时，须在启动后端前设置专用目录，例如：

  ```bash
  export FEEDGRAB_DATA_DIR="$PWD/backend/sessions"
  mkdir -p "$FEEDGRAB_DATA_DIR"
  cd backend
  conda run -n wems uvicorn main:app --host 0.0.0.0 --port 8000
  ```

  如需继续使用 feedgrab 命令登录，请确保命令与后端使用同一个 `FEEDGRAB_DATA_DIR`。不要把 session 文件、Cookie 或 Token 复制进源码目录或容器镜像。
- Docker Compose 已将 API 的 `FEEDGRAB_DATA_DIR` 固定为 `/app/sessions`，并映射到 Compose 文件旁的 `data/sessions`；重建 API 容器不会清空账号池。
- Docker API 镜像会安装固定版本的 feedgrab X 运行时，启动后即可使用持久化 session 采集。若使用宿主机方式启动后端，也需在对应 Python 环境中安装 `backend/requirements.txt`，确保 feedgrab 版本与容器一致。

### Telegram 配置

1. 在 Telegram 中打开 `@BotFather`，使用 `/newbot` 创建机器人并取得 Bot Token。
2. 先向机器人发送一条消息，再访问 Telegram Bot API 的 `getUpdates` 获取目标 Chat ID；群组或频道通常使用负数 Chat ID，并需先把机器人加入目标会话。
3. 打开「设置 → X / Twitter」，填写 `Telegram Bot Token` 和 `Telegram Chat ID`，点击“保存 Telegram 配置”。Token 是只写字段，保存后不会回填，页面只显示后端返回的末四位脱敏预览；输入框留空并保存会保留已有 Token。
4. 必须先保存当前修改，才能点击“发送测试消息”。测试只使用服务端已保存的 Token 和 Chat ID，且只发送一条带 Asia/Shanghai 时间的固定中文连接测试消息，不会使用尚未保存的输入。
5. “清除 Telegram 配置”需要二次确认，会删除已保存的 Token、Chat ID 和测试状态，但不会删除历史 X 响应决策、投递记录或消息 ID。
6. 可选“建议使用的发布账号画像”，从已启用的 X 发布账号中选择一个账号画像，用于约束语气、受众与禁区。

Telegram 消息使用 HTML `<pre>` 块承载草稿，便于手机端长按复制。重复执行通知接口不会再次发送同一条决策。
单元测试和页面冒烟不会替代真实 Telegram 投递验收；只有在本机已安全配置实际 Bot Token 与 Chat ID 时，才应由操作员发送一次测试消息并在目标会话中人工确认。

### 数据库

运行时只支持 PostgreSQL，通过 `DATABASE_URL` 覆盖：

```dotenv
postgresql+asyncpg://postgres:123456@127.0.0.1:5432/wemedia
```

后端测试同样使用 PostgreSQL。测试夹具会为每条数据库测试创建独立的
`wemedia_test_<随机后缀>` 数据库，并在测试结束后删除，不会复用或清空开发库。
管理连接默认取自 `TEST_DATABASE_ADMIN_URL`，未设置时使用：

```dotenv
TEST_DATABASE_ADMIN_URL=postgresql+asyncpg://wemedia:wemedia@127.0.0.1:55432/postgres
```

该账号需要具备 `CREATEDB` 权限。运行全部后端测试：

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests -q
```

### 前端环境

web/.env.local：

```
NEXT_PUBLIC_API_URL=http://localhost:8000/api
NEXT_PUBLIC_DEVELOPER_MODE=0
```

## 数据通道速览

| 类型 | 数据源 | 表 |
|------|--------|----|
| RSS / YouTube / Reddit | RSSHub + yt-dlp + Reddit Atom | accounts / posts |
| arXiv 论文 | arXiv API | papers |
| GitHub Issues / Releases / Trending | GitHub REST + trending HTML | github_* |
| X 时间线 + 即时响应 | feedgrab + Cookie | x_subscriptions / x_posts / x_response_decisions |
| 微信公众号 | 文章 URL 单篇导入 | wechat_articles |
| V2EX | Atom Feed | v2ex_subscriptions / v2ex_topics |
| 36 氪 | 热榜 + 最新 + 快讯 | kr_articles |
| 掘金 | 各分类 + 推荐流 | juejin_articles |
| Product Hunt | 当日热门 | producthunt_posts |
| YouTube 频道 | yt-dlp + 字幕 | youtube_channels / youtube_videos |

## 已实现页面

今日工作台 / 今日计划 / 创作任务 / AI 助手 / 草稿箱 / 写作模板 / 创作资产 / 数字人口播 / 待响应 / 各信息源 / 设置。

## 注意事项

- LLM 功能需在 设置 -> AI 模型 中配置 API Key
- X 认证可在「设置 → X / Twitter → X 采集账号池」管理；外部 `feedgrab login twitter` session 仍兼容但只读
- RSSHub 需独立部署，在 设置 -> 数据采集 中填写地址
- 头像缓存目录 backend/avatars/，首次约 30s，后续毫秒级
