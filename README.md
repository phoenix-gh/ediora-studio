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

## X 即时响应助手

该功能用于关注指定 X 时间线账号（例如 Claude、ChatGPT/OpenAI 官方账号），在新帖采集后自动判断是否值得立即评论、翻译引用转发、继续观察或忽略。输出和可发布草稿统一为中文，产品名、模型名与 API 名保留原文。

工作流如下：

1. 在「X → 订阅管理」添加账号时间线，并为需要关注的账号开启「即时响应」。搜索订阅不能开启此功能。
2. 新的原创帖入库后，以 `x-response:{tweet_id}` 幂等键进入 Redis worker；每 5 分钟运行一次补偿扫描。
3. worker 依次完成资格判断、外链安全核验、AI 决策、结果持久化和通知。含外链但无法核验的公告会强制降级为“观察”，不会生成可发布翻译稿。
4. 评分不低于 75 且置信度不低于 70% 的建议即时推送 Telegram；50–74 分的建议在 Asia/Shanghai 18:00 汇总；更低分仅保留在「待响应」页面。
5. 在「待响应」中复制草稿后自行到 X 发布，并标记“已采用”“忽略”或“转为选题”。

系统只生成与推送建议，**永远不会自动调用 X 的发布、回复、转发或引用接口**。X 采集由定时器每 5 分钟检查一次，实际端到端延迟还取决于设置中的采集间隔和模型响应时间。

### Telegram 配置

1. 在 Telegram 中打开 `@BotFather`，使用 `/newbot` 创建机器人并取得 Bot Token。
2. 先向机器人发送一条消息，再通过 Telegram Bot API 的 `getUpdates` 获取目标 Chat ID；群组或频道通常使用负数 Chat ID，并需把机器人加入目标会话。
3. 打开「设置 → X / Twitter」，填写 `Telegram Bot Token` 和 `Telegram Chat ID`。Token 为只写字段，保存后界面只显示末四位预览。
4. 可选“建议基于账号”，从已启用的 X 发布账号中选择一个账号画像，用于约束语气、受众与禁区。

Telegram 消息使用 HTML `<pre>` 块承载草稿，便于手机端长按复制。重复执行通知接口不会再次发送同一条决策。

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

今日工作台 / 今日计划 / 创作任务 / AI 助手 / 草稿箱 / 写作模板 / 创作资产 / 热点选题 / 待响应 / 发布 / 各信息源 / 设置。

## 注意事项

- LLM 功能需在 设置 -> AI 模型 中配置 API Key
- X 认证由 feedgrab 管理；可运行 `feedgrab login twitter`，或在后端环境配置 `X_AUTH_TOKEN` 与 `X_CT0`
- RSSHub 需独立部署，在 设置 -> 数据采集 中填写地址
- 头像缓存目录 backend/avatars/，首次约 30s，后续毫秒级
