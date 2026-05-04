# WeMedia Studio

自媒体内容运营辅助工具，集数据采集、AI 分析、选题管理、写作辅助于一体。

## 技术栈

- **后端**：FastAPI + SQLite（SQLAlchemy async）+ APScheduler，Python 3.11（conda env: `wems`）
- **前端**：Next.js App Router + Tailwind CSS + shadcn/ui，包管理器 pnpm
- **AI 层**：多 Provider（Anthropic / OpenAI 兼容接口），可在设置中切换
- **浏览器自动化**：[camofox-browser](https://github.com/jo-inc/camofox-browser)（X 时间线采集）

## 目录结构

```
WeMediaStudio/
├── backend/                    # FastAPI 后端
│   ├── main.py                 # 应用入口、APScheduler 定时任务
│   ├── models.py               # SQLAlchemy ORM 模型（SQLite）
│   ├── database.py             # 数据库初始化
│   ├── config.py               # app_settings 键值配置（从 DB 读取）
│   ├── collector.py            # RSS/YouTube/Reddit/arXiv账号 内容采集
│   ├── paper_collector.py      # arXiv 论文专项采集（arXiv API）
│   ├── analyzer.py             # LLM 分析（选题/热点/经济）
│   ├── github_collector.py     # GitHub Issues/Releases/Trending 采集
│   ├── github_analyzer.py      # GitHub Issues 痛点分析
│   ├── x_collector.py          # X 时间线采集（via camofox-browser）
│   ├── avatar_cache.py         # X 头像本地缓存（fetch-once，serve-from-disk）
│   ├── llm.py                  # 多 Provider LLM 调用封装
│   ├── logger.py               # 采集日志写入 DB
│   ├── schemas.py              # Pydantic 公共 schema
│   └── routers/
│       ├── accounts.py         # 账号管理 CRUD
│       ├── posts.py            # 帖子查询
│       ├── topics.py           # 选题管理
│       ├── hotspots.py         # 热点管理
│       ├── collect.py          # 手动触发采集
│       ├── economic.py         # 经济动态
│       ├── write.py            # AI 写作（支持写手人设）
│       ├── personas.py         # 写手人设 CRUD
│       ├── papers.py           # arXiv 论文查询 + 手动采集触发
│       ├── settings.py         # 系统配置读写
│       ├── github.py           # GitHub 数据接口
│       ├── x.py                # X 博主候选 + 帖子接口
│       ├── avatars.py          # X 头像代理端点（/api/avatars/x/{username}）
│       └── directions.py       # 内容方向 + 选题策略 CRUD + 生成
│
├── wemedia-studio/             # Next.js 前端
│   ├── app/
│   │   ├── page.tsx            # 首页（内容 Feed）
│   │   ├── directions/         # 内容方向与选题策略管理
│   │   ├── following/          # 关注账号管理
│   │   ├── topics/             # AI 选题库
│   │   ├── hotspots/           # 热点追踪
│   │   ├── github/             # GitHub 监控
│   │   ├── economic/           # 经济动态
│   │   ├── papers/             # arXiv 论文追踪（分类/时间范围/搜索）
│   │   ├── write/              # AI 写作（含写手人设选择）
│   │   ├── x/                  # X 博主候选 + 帖子趋势
│   │   └── settings/           # 系统设置（分 section 侧边栏）
│   │       └── sections/
│   │           ├── AISection.tsx
│   │           ├── CollectSection.tsx
│   │           ├── GitHubSection.tsx
│   │           ├── XSection.tsx
│   │           ├── ArxivSection.tsx
│   │           ├── PersonasSection.tsx  # 写手人设管理
│   │           └── LogsSection.tsx
│   ├── components/
│   │   ├── features/           # 业务组件（Sidebar、TopicCard 等）
│   │   └── ui/                 # shadcn/ui 基础组件
│   └── lib/api/                # 各模块 API 客户端
│
└── chrome-plug/                # Chrome 插件（辅助工具）
```

## 数据追踪通道

每种数据类型的抓取来源与实现方式：

### 关注账号内容（`posts` 表）

| 平台类型 | 接入方式 | 账号路径格式 |
|----------|----------|-------------|
| **RSS 通用**（少数派、HN、36kr 等） | RSSHub → feedparser 解析 RSS/Atom | `/sspai/articles`、`/hackernews/best` 等 RSSHub 路径 |
| **YouTube 频道** | yt-dlp 获取频道视频列表 + 字幕 | `https://www.youtube.com/@channelname` |
| **Reddit 板块** | Reddit 原生 Atom Feed（带合规 UA） | `https://www.reddit.com/r/MachineLearning/.rss` |
| **arXiv 账号**（已迁移） | ~~arXiv RSS~~ → **已改用独立论文追踪模块** | 见「arXiv 论文」行 |

> **路由逻辑（`collector.py`）**：`platform == "arXiv"` 或路径含 `arxiv.org` → `_collect_arxiv()`；含 `youtube.com`/`youtu.be` → `_collect_youtube()`（yt-dlp）；含 `reddit.com` → `_collect_rss()` 自动注入合规 `User-Agent`；其余 → `_collect_rss()`（走 RSSHub）

### arXiv 论文（`papers` 表）

| 来源 | 接入方式 | 说明 |
|------|----------|------|
| **arXiv API** | `export.arxiv.org/api/query` Atom 格式 | 每 6 小时采集（可配置），支持全周，不受 `<skipDays>` 限制 |

采集分类在 **设置 → arXiv 论文** 中配置（默认 `cs.AI,cs.CL,cs.CV,cs.LG`），每次最多取最新 50 篇。

### GitHub（`github_issues` / `github_releases` / `github_trending` 表）

| 数据类型 | 接入方式 |
|----------|----------|
| **Issues / Releases** | GitHub REST API（需配置 Personal Access Token） |
| **Trending 仓库** | 抓取 `github.com/trending`（每日/每周） |

### X / Twitter（`x_posts` / `x_post_metrics` 表）

| 数据类型 | 接入方式 |
|----------|----------|
| **时间线推文** | camofox-browser（Playwright）注入 Cookie → 打开时间线 → JS 提取推文内容 + 指标 |
| **博主候选发现** | 采集推文时自动解析转发/回复作者 → 访问其主页提取粉丝数 → 超阈值加入候选库 |

每次采集全量追加指标到 `x_post_metrics`（append-only），前端用历史数据渲染迷你折线图。

### 热点（`hotspots` 表）& 经济动态（`economic_items` 表）

| 数据类型 | 接入方式 |
|----------|----------|
| **热点** | 由 LLM 对近期 `posts` 做跨平台热点聚合分析生成 |
| **经济动态** | 由 LLM 对财经类 RSS 内容做影响评估，分类标注 positive/negative/neutral |

## 已实现功能

### 数据采集层

| 模块 | 功能 |
|------|------|
| **RSS/YouTube/Reddit** | 定时抓取已关注账号内容，入库 `posts` 表；YouTube 额外抓取字幕作为正文 |
| **arXiv 论文** | 独立采集模块，按分类批量拉取最新论文，解析标题/摘要/作者/分类，存 `papers` 表 |
| **GitHub Issues** | 监控指定仓库 Issues 和 Releases，定时采集 |
| **GitHub Trending** | 定时抓取每日/每周 Trending 仓库 |
| **X 时间线** | camofox-browser 注入 Cookie，JS 提取推文，每次采集记录回复/转发/点赞/阅读历史 |
| **X 博主发现** | 采集时自动解析博主信息，超粉丝阈值（默认 5000）加入候选库 |

### AI 分析层

- **选题生成（通用）**：基于近期帖子，LLM 生成内容选题（含评分、紧迫度、分类）
- **按内容方向生成**：在指定内容方向和策略下，从 X 热帖提炼定向选题（见内容方向功能）
- **热点识别**：跨平台热点聚合分析
- **经济动态**：财经新闻影响评估
- **GitHub 痛点**：对 Issues 做聚类分析，提炼用户痛点

### 写手人设

在 **设置 → 写手人设** 中管理提示词模板，每个写手包含：
- **名称**：如"公众号深度"、"X 推文"、"小红书"
- **简介**：一句话描述风格
- **提示词**：完整的角色定位 + 写作要求，替换 LLM 调用时的默认 system prompt
- **默认**：写作页打开时自动选中

预置三个内置写手（首次访问自动写入）：

| 名称 | 风格 |
|------|------|
| 公众号深度 | 1500-2000 字深度长文，## 小标题分段，专业易读 |
| X / Twitter | 5-8 条推文串，每条 ≤140 中文字，强 hook 开头 |
| 小红书 | 种草风，emoji 分段，口语化，末尾 #话题标签 |

**撰写文章** 页在生成按钮旁显示写手选择器，切换后立即生效，无需重新加载。

### 前端页面

| 页面 | 功能 |
|------|------|
| **首页** | 内容 Feed，展示采集到的帖子 |
| **内容方向** | 创作方向管理（教程/科普/新闻评价等），每个方向可配置多个选题策略，策略控制 X 热帖筛选条件和 LLM 提示词，支持一键生成选题 |
| **关注管理** | 账号 CRUD，支持分组、优先级、静音 |
| **选题库** | 卡片展示，支持状态流转（待审/采纳/搁置/完成），显示来源方向标签 |
| **热点** | 热点列表，含趋势标签 |
| **GitHub** | Issues/Trending/Releases 展示，痛点分析 |
| **论文追踪** | arXiv 论文列表，分类 Tab、时间范围、全文搜索，可展开摘要，手动触发采集 |
| **X 博主** | 候选库管理（candidate/following/rejected 状态流转），头像本地缓存显示 |
| **X 帖子趋势** | 帖子列表，含 SVG 迷你折线图（回复/转发/点赞/阅读历史），"超粉丝浏览" 🔥 标签 |
| **经济动态** | 财经事件列表（服务端实时渲染） |
| **AI 写作** | 选择写手人设 → 基于选题一键生成草稿 → 在线编辑 → 复制全文 |
| **设置** | 分区侧边栏：AI 模型、RSS 采集、GitHub、X/Twitter、arXiv 论文、写手人设、系统日志 |

### 内容方向与选题策略

内容方向对应创作者的不同写作维度（如教程、科普、新闻评价），每个方向可创建多个选题策略，策略参数包括：

| 参数 | 说明 |
|------|------|
| 时间窗口 | 抓取多少小时内的 X 帖子（默认 48h） |
| 最低阅读量 | 过滤低热度帖子 |
| 仅 Viral 帖 | 只看阅读量超过作者粉丝数 1.5 倍的帖子 |
| 关键词白/黑名单 | 精准过滤内容领域 |
| LLM 提示词 | 自定义角度和风格要求，留空使用默认模板 |
| 输出数量 | 期望生成的选题数（1-10） |

生成的选题自动写入选题库，并标记来源方向和策略名称。

### X 头像缓存机制

`GET /api/avatars/x/{username}` 代理端点，三段式降级：

1. **本地磁盘缓存**（`backend/avatars/`）：命中则直接 `FileResponse`，约 1ms
2. **HTTP 直接下载**：从 DB 中存储的 `avatar_url` 下载并缓存，遇 429 自动重试
3. **Playwright 浏览器兜底**：通过 camofox 打开 `x.com/{username}` 页面提取真实 `pbs.twimg.com` 地址，下载缓存（约 30-40s，仅首次）

### 数据库（SQLite，19 张表）

| 表名 | 说明 |
|------|------|
| `accounts` | 关注的账号（RSS/YouTube/Reddit） |
| `posts` | 采集到的内容帖子 |
| `topics` | AI 生成的内容选题（含来源方向/策略字段） |
| `hotspots` | 热点事件 |
| `economic_items` | 经济动态 |
| `papers` | arXiv 论文（arxiv_id/标题/摘要/作者/分类/PDF链接） |
| `writer_personas` | 写手人设（名称/提示词/是否默认） |
| `github_repos` | 监控的 GitHub 仓库 |
| `github_issues` | 采集的 Issues |
| `github_releases` | 采集的 Releases |
| `github_trending` | Trending 仓库快照 |
| `issue_pain_points` | LLM 分析出的用户痛点 |
| `x_blogger_candidates` | X 博主候选库 |
| `x_posts` | X 采集到的推文 |
| `x_post_metrics` | 推文指标历史（回复/转发/点赞/阅读，append-only） |
| `content_directions` | 内容创作方向 |
| `topic_strategies` | 选题策略（挂在方向下） |
| `app_settings` | 系统配置键值对 |
| `collect_logs` | 采集运行日志 |

## 启动方式

> 重要：后端数据库配置为相对路径 `sqlite+aiosqlite:///./wemedia.db`，因此必须从 `backend/` 目录启动后端。这样实际使用的数据库是 `backend/wemedia.db`。不要从项目根目录直接运行 `uvicorn backend.main:app`，否则会在根目录创建/使用另一个 `wemedia.db` 空库。

```bash
# 1) 后端（必须从 backend/ 目录启动；conda env: wems）
cd backend
conda run -n wems uvicorn main:app --host 0.0.0.0 --port 8000

# 2) 前端（从前端目录启动）
cd ../wemedia-studio
pnpm dev
```

也可以开两个终端分别启动：

```bash
# 终端 A：后端
cd /workspace/projects/WeMediaStudio/backend
conda run -n wems uvicorn main:app --host 0.0.0.0 --port 8000

# 终端 B：前端
cd wemedia-studio
pnpm dev
```

后端监听 `localhost:8000`，前端默认 `localhost:3000`。  
API 文档：`http://localhost:8000/docs`

### 启动目录与数据库

| 启动位置 | 命令 | 实际数据库 |
|----------|------|------------|
| `backend/` | `conda run -n wems uvicorn main:app --host 0.0.0.0 --port 8000` | `backend/wemedia.db`（正确） |
| 项目根目录 | `uvicorn backend.main:app ...` | `wemedia.db`（错误，容易生成空库） |
| `wemedia-studio/` | `pnpm dev` | 不直接使用 SQLite，只通过 `NEXT_PUBLIC_API_URL` 访问后端 |

前端 API 地址配置在 `wemedia-studio/.env.local`，默认应为：

```bash
NEXT_PUBLIC_API_URL=http://localhost:8000/api
```

## 注意事项

- LLM 功能需在 **设置 → AI 模型** 中配置 API Key，未配置时返回 502 并提示
- X 采集需要在设置中填写 Cookie（通过 `camofox` 登录后导出），并确保 camofox-browser 服务运行在 `localhost:9377`
- RSSHub 需独立部署（推荐 Docker），在 **设置 → 数据采集** 中填写地址（默认 `http://127.0.0.1:1200`）
- Reddit 账号路径直接填写原生 RSS 地址（`https://www.reddit.com/r/{subreddit}/.rss`），无需 RSSHub
- arXiv 论文采集不依赖 RSSHub，直接调用 arXiv API，任何时间均可采集
- 头像缓存目录：`backend/avatars/`，首次访问未缓存头像会通过浏览器自动获取（约 30s），后续请求毫秒级返回
