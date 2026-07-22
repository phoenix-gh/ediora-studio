# WeMedia Studio

自媒体内容运营辅助工具，集数据采集、AI 分析、选题管理、写作辅助于一体。

## 技术栈

- **后端**：FastAPI + PostgreSQL（SQLAlchemy async）+ APScheduler，Python 3.11（conda env: wems）
- **前端**：Next.js App Router (16.x) + Tailwind CSS + shadcn/ui，包管理器 pnpm
- **AI 层**：多 Provider（OpenAI / Anthropic / DeepSeek / 通义千问 / Moonshot / GLM / MiniMax / MiMo / 自定义）
- **浏览器自动化**：camofox-browser（X 时间线采集）

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
│   ├── analyzer.py             LLM 选题分析
│   ├── llm.py                  多 Provider LLM 调用
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
| X 时间线 + 博主发现 | camofox-browser + Cookie 注入 | x_posts / x_post_metrics / x_blogger_candidates |
| 微信公众号 | 文章 URL 单篇导入 | wechat_articles |
| V2EX | Atom Feed | v2ex_subscriptions / v2ex_topics |
| 36 氪 | 热榜 + 最新 + 快讯 | kr_articles |
| 掘金 | 各分类 + 推荐流 | juejin_articles |
| Product Hunt | 当日热门 | producthunt_posts |
| YouTube 频道 | yt-dlp + 字幕 | youtube_channels / youtube_videos |

## 已实现页面

今日工作台 / 草稿箱 / 选题库 / 金句库 / GitHub 雷达 / 论文追踪 / YouTube 订阅 / 公众号订阅 / V2EX 订阅 / 36 氪 / 掘金 / Product Hunt / X 博主候选 / 设置。

## 注意事项

- LLM 功能需在 设置 -> AI 模型 中配置 API Key
- X 采集需在设置中填写 Cookie，并确保 camofox-browser 运行在 localhost:9377
- RSSHub 需独立部署，在 设置 -> 数据采集 中填写地址
- 头像缓存目录 backend/avatars/，首次约 30s，后续毫秒级
