# Reddit 订阅模块 — 设计文档

**日期:** 2026-05-26  
**分支:** refactor/project-optimization  
**状态:** 已批准，待实现

---

## 目标

为 Ediora 添加 Reddit 版块（subreddit）订阅功能，采集热帖（hot）和最新帖（new），评论随帖子一起存储，UI 与 V2EX / X 页面风格对齐。

---

## 采集方式

使用 feedgrab 内置的 `feedgrab.fetchers.reddit` 模块，无需 OAuth / PRAW。

- **Tier 0**：直接请求 `old.reddit.com/r/<sub>/<sort>.json`（匿名，无需登录）
- **Tier 1/2**：CDP / stealth Playwright 浏览器兜底（应对 IP 限速）
- **Tier 3**：Jina Reader（仅限单帖，无评论）

关键函数：
- `fetch_reddit_subreddit(sub, sort, limit)` → 列表页采集
- `fetch_reddit(url)` → 单帖 + Top 评论，内容渲染为 Markdown

---

## 数据模型

### `RedditSubscription`（表：`reddit_subscriptions`）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | int PK | 自增 |
| `subreddit` | str | 版块名，如 `programming`（不含 r/） |
| `label` | str | 显示名，默认 `r/<subreddit>` |
| `group` | str | 分组，默认 `未分组` |
| `muted` | bool | 静音时跳过自动采集 |
| `last_collected_at` | datetime\|None | 最近一次成功采集时间 |
| `created_at` | datetime | 创建时间 |

唯一约束：`subreddit`（大小写不敏感，存储时 lower）

### `RedditPost`（表：`reddit_posts`）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | str PK | `"{subscription_id}:{post_reddit_id}"` |
| `post_id` | str | Reddit 原始帖子 ID（如 `1abc23`） |
| `subscription_id` | int | FK → reddit_subscriptions.id |
| `title` | str | 标题 |
| `content` | text | Markdown 全文（正文 + Top 评论，feedgrab 渲染） |
| `url` | str | 帖子 permalink（reddit.com/r/...） |
| `linked_url` | str | 外链 URL（link post），self post 为空 |
| `author` | str | 发帖人用户名 |
| `subreddit` | str | 版块名（冗余，方便查询） |
| `flair` | str | 帖子 flair 标签 |
| `score` | int | 得分（upvote - downvote） |
| `upvote_ratio` | float | 好评率 0~1 |
| `comment_count` | int | 评论数 |
| `is_self` | bool | 是否为纯文字帖 |
| `published_at` | datetime | 发帖时间（UTC） |
| `collected_at` | datetime | 采集时间 |

**去重策略**：同一 `subscription_id` + `post_id` 只存一条。  
采集时已存在则 upsert 更新 `score` / `comment_count`。  
Hot 视图 = 按 `score DESC`；New 视图 = 按 `published_at DESC`。

---

## 采集器（`backend/reddit_collector.py`）

```
collect_subscription(sub, db)
  ├── 并发调用 fetch_reddit_subreddit(sub.subreddit, "hot", 25)
  ├──         fetch_reddit_subreddit(sub.subreddit, "new", 25)
  ├── 合并去重（以 post_id 为键）
  ├── upsert 每条帖子到 redis_posts
  └── 更新 sub.last_collected_at

collect_all(db)
  └── 遍历非 muted 订阅，依次调用 collect_subscription
```

每次采集 hot + new 各 25 条，共最多 50 条（实际因重叠通常 30~45 条新帖）。

---

## API 路由（`backend/routers/reddit.py`，prefix `/reddit`）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/subscriptions` | 列出所有订阅（含 post_count） |
| POST | `/subscriptions` | 添加订阅（body: subreddit, label?, group?） |
| PATCH | `/subscriptions/{id}` | 更新 label / group / muted |
| DELETE | `/subscriptions/{id}` | 删除订阅及其所有帖子 |
| POST | `/subscriptions/{id}/collect` | 后台触发单个采集 |
| GET | `/posts` | 帖子列表（filters: subscription_id, view=hot/new, days, limit, search） |
| POST | `/collect` | 触发全量采集（后台任务） |

**`GET /posts` 参数：**
- `subscription_id` (可选) — 筛选单个版块
- `view` = `hot` | `new` | `all`（默认 `hot`）— 决定排序
- `days` = 1~365（默认 14）— 时间窗口
- `limit` = 1~500（默认 100）
- `search` — 标题关键词模糊搜索

---

## 前端

### 文件

```
web/
  lib/api/reddit.ts             # API 客户端类型 + 函数
  app/reddit/page.tsx           # Server Component 入口
  app/reddit/RedditClient.tsx   # 主 Client Component（~500行）
  components/features/Sidebar.tsx  # 加 /reddit 导航项
```

### UI 结构

```
┌─────────────────┬──────────────────────────────────────────┐
│  订阅列表        │  帖子列表                                 │
│                 │                                          │
│ [管理订阅]      │  [Hot] [New]  🔍搜索框                   │
│                 │                                          │
│ ● r/programming │  ┌─────────────────────────────────────┐│
│   r/rust        │  │ 标题                         ↑1.2k  ││
│   r/MachineLe.. │  │ u/author · r/programming · 2h  💬34 ││
│                 │  │ [flair]                              ││
│                 │  └─────────────────────────────────────┘│
└─────────────────┴──────────────────────────────────────────┘
```

- 点击帖子 → 右侧 `ArticleReader` 侧边栏展示 Markdown 全文（含评论）
- 订阅管理对话框：输入 subreddit 名 → 验证可访问性 → 添加，支持删除/静音

### 导航图标

使用 lucide-react 的 `MessageSquare`（与 Reddit 气泡感接近）。

---

## 调度器

在 `backend/scheduler.py` 添加 `scheduled_reddit()`，间隔 60 分钟（可通过设置 `reddit_collect_interval_minutes` 调整）。

---

## 边界与限制

- 匿名请求频率受 Reddit 限制（约 60 req/min），feedgrab Tier 0 已处理
- 评论默认取 feedgrab config 的 `reddit_max_comments`（通常 10~20 条 top 评论）
- 不支持私有 subreddit（需登录）
- subreddit 存储统一小写，订阅时自动 lower
