# WeMedia Studio

自媒体内容运营辅助工具，集数据采集、AI 分析、选题管理、写作辅助于一体。

## 技术栈

- **后端**：FastAPI + PostgreSQL（SQLAlchemy async）+ APScheduler，Python 3.11（conda env: wems）
- **前端**：Next.js App Router (16.x) + Tailwind CSS + shadcn/ui，包管理器 pnpm
- **AI 层**：多 Provider（OpenAI / Anthropic / DeepSeek / 通义千问 / Moonshot / GLM / MiniMax / MiMo / 自定义）
- **X 采集**：feedgrab（Cookie 认证）
- **任务执行**：PostgreSQL 持久化任务 + Redis 队列 + Next.js AI SDK worker

## 目录结构

```
WeMediaStudio/
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
├── wemedia-studio/
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

后端必须从 backend/ 目录启动，使用 conda env wems。

```bash
# 终端 A：后端
cd backend
conda run -n wems uvicorn main:app --host 0.0.0.0 --port 8000

# 终端 B：前端
cd wemedia-studio
pnpm dev
```

后端 localhost:8000，前端 localhost:3000，API 文档 /docs。

### 自托管（Docker Compose）

开源版不需要 Hermes、Agent profile 或本地任务看板。复制环境变量模板后启动：

```bash
cp .env.example .env
docker compose up --build
```

服务会启动 Web（3000）、Python API（8000）、Postgres、Redis 和内容任务 worker。
`POSTGRES_PASSWORD` 可在 `.env` 中覆盖；LLM 与图片提供商密钥只配置在服务端环境变量中，绝不放入浏览器变量。

## 数字人口播（HeyGen）

「创作 → 数字人口播」提供可复用数字人角色、项目内脚本编辑、环境图和不可变成片版本：

1. 在「设置 → HeyGen」保存 API Key；也可用服务端 `HEYGEN_API_KEY` 作为回退。界面中已保存的设置优先于环境变量，浏览器不会拿到明文密钥。
2. 创建角色时选择一张 PNG/JPEG 正面照、一段 MP3/WAV 录音和一张默认环境图。直接发送给 HeyGen 的单个素材最大 32MB。
3. 在口播作品内手写脚本，或让 AI 按主题生成、把已有草稿转换为口播、改写当前脚本。AI 候选只有确认后才替换编辑器内容，不会自动生成视频。
4. 每次生成都会冻结脚本、角色和环境为独立版本。HeyGen 返回的临时下载地址不会作为最终资产；worker 会把 MP4 复制到本地 `uploads` 创作资产后才标记成功。

声音克隆需要 HeyGen 账号具备相应套餐权限；免费或受限套餐可能返回 `plan_upgrade_required`。如果只配置了环境变量，API 与 worker 都必须能读取同一个 `HEYGEN_API_KEY`。

真实 HeyGen 冒烟测试是显式可选操作，会产生 API 用量：

```bash
cd wemedia-studio
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
- Docker Compose 已将 API 的 `FEEDGRAB_DATA_DIR` 固定为 `/app/sessions`，并通过 `sessions-data` 命名卷持久化；重建 API 容器不会清空账号池。
- feedgrab 是可选的宿主机/运行时集成，不包含在默认后端依赖中。只有需要实际采集 X 时，才需在后端运行环境中安装兼容版本；未安装时其余信息源和产品功能仍可运行。

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

默认 PostgreSQL，通过 WMS_DATABASE_URL 覆盖：

```
postgresql+asyncpg://postgres:123456@127.0.0.1:5432/wemedia
```

旧版 SQLite 迁移：运行 backend/migrate_sqlite_to_pg.py。

### 前端环境

wemedia-studio/.env.local：

```
NEXT_PUBLIC_API_URL=http://localhost:8000/api
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
