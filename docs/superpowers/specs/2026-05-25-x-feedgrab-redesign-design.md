# X 模块重构：基于 feedgrab 的订阅 + 实时搜索

**Date:** 2026-05-25
**Branch base:** `refactor/project-optimization`
**Status:** Approved (brainstorming) — awaiting user review of this spec.

## 1. 背景与目标

当前 X 模块基于 `twitterapi.io` 付费 API + `tl1.com` 热门榜抓取，承载了候选博主发现、订阅采集、帖子分类、灵感分析、二创生成、metrics 历史等多种能力。维护负担重、依赖外部付费接口、且产品方向已收敛。

本次重构目标：**清空整个 X 模块，基于 [feedgrab](https://github.com/iBigQiang/feedgrab) 重建一个最小可用版本**，只保留两种能力：

1. **订阅列表** — 用户粘贴 X URL（个人主页或 list URL），系统每小时自动通过 feedgrab 采集该 URL 下的帖子并入库。
2. **关键词实时搜索** — 用户输入关键词，实时调用 feedgrab 的 X 搜索接口，结果直接返回前端展示，**不入库、不缓存**。

## 2. 删除清单

### 后端
- `backend/x_collector.py`（799 行）整体删除。
- `backend/routers/x.py`（521 行）整体重写。
- `backend/models.py` 删除三张表：`XBloggerCandidate`、`XPost`、`XPostMetrics`。生成 Alembic 迁移 drop 这三张表。
- `backend/scheduler.py` 删除作业 `scheduled_tl1_users`、`scheduled_tl1_trending`、`scheduled_x_collect`（旧实现），以及 `x_post_classify_*` 相关引用。
- `backend/config.py` 删除默认项 `x_cookies`、`x_follower_threshold`、`x_search_queries`、`twitterapi_io_key`、`x_post_classify_enabled`、`x_post_classify_prompt`。
- `backend/routers/settings.py` 删除所有 X 字段（GET / PATCH 中 `x_cookies`、`x_follower_threshold`、`x_search_queries`、`twitterapi_io_key*`、`x_post_classify_*`）。
- `backend/post_classifier.py`（若仅 X 使用）删除。

### 前端
- `wemedia-studio/app/x/XClient.tsx`、`XPostsPanel.tsx`、`page.tsx` 全部重写。
- 设置页 X 区块（cookies / threshold / queries / classify prompt 等）整段删除。

### 数据
- 旧数据 (`x_blogger_candidates` / `x_posts` / `x_post_metrics`) 不需要迁移，drop 即可。

## 3. 新增数据模型

```python
class XSubscription(Base):
    __tablename__ = "x_subscriptions"
    id: Mapped[int] = mapped_column(primary_key=True)
    url: Mapped[str] = mapped_column(String(500), unique=True, index=True)
    label: Mapped[str] = mapped_column(String(120))            # 显示名，默认从 URL 推断
    enabled: Mapped[bool] = mapped_column(default=True)
    last_collected_at: Mapped[datetime | None]
    last_error: Mapped[str | None] = mapped_column(String(500))
    added_at: Mapped[datetime]

class XPost(Base):
    __tablename__ = "x_posts"
    tweet_id: Mapped[str] = mapped_column(String(40), primary_key=True)
    subscription_id: Mapped[int] = mapped_column(
        ForeignKey("x_subscriptions.id", ondelete="CASCADE"), index=True
    )
    username: Mapped[str] = mapped_column(String(60), index=True)
    display_name: Mapped[str] = mapped_column(String(120))
    content: Mapped[str] = mapped_column(Text)
    url: Mapped[str] = mapped_column(String(500))
    published_at: Mapped[datetime] = mapped_column(index=True)
    collected_at: Mapped[datetime]
    replies: Mapped[int] = mapped_column(default=0)
    reposts: Mapped[int] = mapped_column(default=0)
    likes: Mapped[int] = mapped_column(default=0)
    views: Mapped[int] = mapped_column(default=0)
    raw_markdown: Mapped[str] = mapped_column(Text)            # feedgrab 单条原文，便于回溯
```

约束：
- 删除订阅时级联删除其帖子（`ON DELETE CASCADE`）。
- `tweet_id` 唯一，二次采集走 upsert。

## 4. feedgrab 集成层

新建 `backend/feedgrab_client.py`：

```python
@dataclass
class ParsedPost:
    tweet_id: str
    username: str
    display_name: str
    content: str
    url: str
    published_at: datetime
    replies: int
    reposts: int
    likes: int
    views: int
    raw_markdown: str

async def grab_timeline(url: str) -> list[ParsedPost]: ...
async def search_x(query: str, limit: int = 20) -> list[ParsedPost]: ...
```

**实现策略：**
- 优先尝试 Python import（`feedgrab.UniversalReader` 或等价入口）。feedgrab 同步 API，使用 `asyncio.to_thread` 包装。
- 实现计划阶段先写一个 spike：在 wems 环境装 feedgrab，验证可用的 Python 入口与返回结构。
- 若 Python 公开 API 不稳定（私有路径、签名变化），回退到 `subprocess` 调 `feedgrab` CLI：捕获 stdout 或读取落盘 Markdown 文件解析。
- 解析 Markdown → `ParsedPost` 的逻辑封装在 `feedgrab_client` 内部，对外只暴露 dataclass。

**认证：**
- 完全交给 feedgrab 自己的机制：用户首次部署时运行一次 `feedgrab login twitter`（或在 `.env` 写 `X_AUTH_TOKEN` / `X_CT0`）。
- 本项目**不再管 X cookie**，删除 camofox / VNC 集成。
- 设置页给一个简单状态展示：调用 `feedgrab` 探活接口（或读 `sessions/twitter.json` 是否存在），显示「feedgrab session 已就绪 / 未登录」 + 一行命令提示。

## 5. 后端 API

`backend/routers/x.py` 重写为：

```
GET    /x/subscriptions
       → [{id, url, label, enabled, last_collected_at, last_error, post_count}]

POST   /x/subscriptions
       body: {url: str, label?: str}
       → 创建订阅。label 默认从 URL 推断（@username 或 list-{id}）

PATCH  /x/subscriptions/{id}
       body: {enabled?: bool, label?: str}

DELETE /x/subscriptions/{id}
       级联删除其所有 posts

POST   /x/subscriptions/{id}/collect
       → 后台任务：仅采集这一个订阅
       → {ok: true, message}

POST   /x/collect-all
       → 后台任务：触发全量采集（与 cron 一致）

GET    /x/posts?subscription_id=&limit=200&offset=0&hours=168
       → 已入库帖子，按 published_at desc

GET    /x/search?q=...&limit=20
       → 实时搜索，不入库，直接返回 ParsedPost[]
       → 错误时返回 4xx + error message（如 feedgrab 未登录）

GET    /x/auth-status
       → {ready: bool, hint: str}  # 设置页用
```

## 6. 调度

`backend/scheduler.py`：
- 删除三个旧作业。
- 新增 `scheduled_x_collect`：`IntervalTrigger(hours=1)`，id=`x_collect_hourly`。
- 行为：
  1. `SELECT * FROM x_subscriptions WHERE enabled=TRUE`
  2. 逐个 `await grab_timeline(sub.url)`，每个之间 `asyncio.sleep(2)` 防风控。
  3. 对返回的每条 `ParsedPost`：按 `tweet_id` upsert 进 `x_posts`，关联 `subscription_id`。
  4. 更新 `last_collected_at=now`；异常时把 `str(e)[:500]` 写入 `last_error`，**不中断**其他订阅。
  5. 日志：通过现有 `logger.log("x", ...)` 输出汇总信息。

## 7. 前端 `/x` 重写

**`app/x/page.tsx`**：保持轻量壳，挂载 `XClient`。

**`XClient.tsx`** —— 单页两个 Tab（用现有 antd 组件）：

### Tab 1 「订阅」
- 顶部输入区：URL 输入框 + 可选 label 输入框 + 「添加」按钮
- 订阅卡片列表（每行一卡片）：
  - 左：label（可点击编辑） + URL + @username 头像（unavatar.io）
  - 中：上次采集时间、最近 24h 帖子数、`last_error` 红色 tag（如有）
  - 右：启用开关、「立即采集」按钮、「删除」按钮（confirm）
- 下方：所有订阅的最新帖子流
  - 过滤器：订阅下拉（默认「全部」） + 时间范围（24h / 7d / 30d）
  - 卡片列表：头像 + display_name @username + 时间 + content（保留换行）+ 浏览/转发/点赞数 + 「查看原推」链接
  - 分页：滚动加载或经典分页（实现阶段决定）

### Tab 2 「搜索」
- 顶部搜索框 + 「搜索」按钮 + 顶部说明文字：「实时结果，不保存到数据库」
- 提交 → 调用 `/x/search` → loading → 渲染结果卡片列表（与 Tab 1 同款卡片）
- 错误态：feedgrab 未登录时给清晰提示 + 文档链接

### 设置页
- 删除整段 X 区块。
- 新增一个最小区块：标题「X / Twitter (feedgrab)」 + 调 `/x/auth-status` 显示状态 + 命令提示 `feedgrab login twitter`。

## 8. 测试策略

- **feedgrab_client** 单测：mock feedgrab 返回的 Markdown，断言 `ParsedPost` 解析正确（tweet_id、metrics 数字、时间）。
- **routers/x** 单测：mock `grab_timeline` / `search_x`，覆盖 CRUD 与采集 / 搜索路径。
- **scheduler** 单测：mock client，验证逐源失败隔离（一个抛错不影响其他订阅）。
- **手工验证清单**（实现完成后逐条勾选）：
  1. `feedgrab login twitter` 成功后，添加一个真实订阅，手动「立即采集」能看到帖子入库。
  2. 等待一次 cron 触发（或手动调 `/x/collect-all`），多订阅采集成功，`last_collected_at` 更新。
  3. 关键词搜索能实时返回结果，重复搜索每次都走 feedgrab（无缓存）。
  4. 删除订阅 → 关联帖子被级联删除。
  5. 未登录状态下，设置页能正确显示「未登录」+ 命令提示。

## 9. 实现顺序（供 writing-plans 参考）

1. **Spike**: 在 wems env 装 feedgrab，写一个小脚本验证 Python import 入口与返回结构，落到 `docs/superpowers/spikes/feedgrab-python-api.md`。
2. 模型 + 迁移（drop 旧表，建新表）。
3. `feedgrab_client.py`（含解析） + 单测。
4. `routers/x.py` 重写 + 单测。
5. `scheduler.py` 替换 X 作业 + 单测。
6. `config.py` / `routers/settings.py` 清理 X 字段。
7. 前端 `app/x/*` 重写。
8. 设置页 X 区块清理 + 新增 auth-status 展示。
9. 手工验证清单走完。

## 10. 风险与已知未知

- **feedgrab Python API 稳定性**：spike 阶段会确认。如不可用，回退 subprocess（计划阶段选最终方案）。
- **feedgrab 性能**：未知单源采集耗时。如果一个订阅要 10s+，cron 串行 + sleep 可能导致后段订阅延迟。先按串行实现，必要时改并发（带速率限制）。
- **X 风控**：feedgrab 用单一 cookie，频繁调用可能被限。订阅之间 `sleep(2)`、关键词搜索由用户触发，应在安全范围。
- **list URL 支持**：feedgrab 的 list URL 与 username URL 解析路径可能不同。spike 一并验证。

## 11. 不做的事情（明确 YAGNI）

- 不做帖子 LLM 分类、灵感分析、二创文章生成、metrics 历史曲线 —— 这些都从旧版删除，**不重建**。
- 不做候选博主池（XBloggerCandidate） —— 用户已明确"会直接给你一个 url"，不再需要发现流程。
- 不做关键词搜索结果的缓存或去重 —— 完全实时，每次重新调用。
- 不做 VNC / camofox 集成 —— feedgrab 已有自己的登录机制。
