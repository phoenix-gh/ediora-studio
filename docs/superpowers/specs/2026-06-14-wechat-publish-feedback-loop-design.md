# 设计：公众号发布效果回流（Phase 1）

日期：2026-06-14
状态：设计已确认，待写实现计划
关联：闭环审计 `docs/superpowers/specs/2026-06-14-cleanup-and-creation-loop-audit.md`（P0 缺口）

## 背景与目标

文章创作闭环目前止于「发布」：草稿发到公众号草稿箱后，阅读/点赞从不回采，更不反哺选题——闭环没闭上。`DailyPlanItem` 的注释早写了「后续发布排期/效果回流都挂在这个锚点上」，锚点留了，功能没做。

**目标（Phase 1）**：把公众号发布表现引入系统并回流到选题——
1. 记录「哪篇草稿发到了哪个公众号、何时、外部句柄」（发布记录）。
2. 手动回填阅读/点赞/在看/分享。
3. 每天 8 点 wms_scout 总编选题时读到「最近哪些选题/账号表现好」，据此调整选题。
4. 一个最小「发布表现」页，既是录入口也是表现榜。

**成功标准**：能在系统里看到「某篇 → 某号 → 阅读 N / 点赞 M」，且总编选题的指令里实际带上了近期表现数据。

## 非目标（留 Phase 2）

- 微信「数据统计 API」自动拉数（需认证号 + 群发，且要新建统计客户端）。
- 统计时间序列/趋势（v1 只存最新快照）。
- Blog / X 渠道回流（数据结构预留 `platform`，逻辑不做）。
- 把表现喂进候选池 `heat` 权重（v1 只喂总编 prompt，人仍在环）。

## 数据模型 — 新表 `Publication`

新建表 `publications`。新表由 `create_all` 自动生成，无需手动 ALTER（项目无迁移框架，只有给已有表加列才要手动 ALTER）。无外键约束，`draft_id`/`account_id` 用普通索引列（与现有 XPost/RedditPost 风格一致）。

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | int PK autoincrement | |
| `draft_id` | int, index | → `ArticleDraft.id` |
| `account_id` | str, index | → `PublishAccount.id`（哪个公众号） |
| `platform` | str, default `"wechat"` | 预留 `blog`/`x` |
| `title` | str | 发布时标题快照（回流查询不依赖 draft 现状） |
| `external_id` | str, default `""` | 微信 `media_id`（草稿箱句柄，Phase 2 统计 API 用） |
| `url` | str, default `""` | 公开文章 URL（群发后手动回填，Phase 2 抓数用） |
| `status` | str, default `"draft_box"` | `draft_box`（已存草稿箱）\| `published`（已群发公开） |
| `published_at` | datetime \| None | 标「已发布」时设；草稿箱态为空 |
| `read_count` | int, default 0 | 阅读 |
| `like_count` | int, default 0 | 点赞 |
| `look_count` | int, default 0 | 在看 |
| `share_count` | int, default 0 | 分享/转发 |
| `stats_as_of` | datetime \| None | 统计快照时间；任一统计字段被改时自动置 now（最新覆盖，无时间序列） |
| `created_at` / `updated_at` | datetime | `updated_at` onupdate=now |

## 数据流（闭环）

```
创作 → 草稿(ArticleDraft) → [POST 发布到公众号]
        └─ 成功后自动 upsert Publication(status=draft_box, external_id=media_id)
你在公众号后台群发 → /published 页：标「已发布」+ 填阅读/点赞/在看/分享 (+可选 URL)
每天 8 点 wms_scout 总编 → get_recent_performance() 读近 30 天已发布表现
        └─ 选题时倾向复制表现好的方向、避开哑火方向
→ 表现回流到选题，闭环闭合
```

## 后端

### 1. 发布钩子（drafts.py）
`POST /drafts/{id}/publish/wechat` 成功（拿到 `media_id`）后，**upsert** 一条 `Publication`：
- 同 `(draft_id, account_id, platform="wechat")` 已有 `draft_box` 记录 → 更新 `external_id`/`title`（不重复建）。
- 否则新建（status=`draft_box`）。
- 建记录失败**不**让发布失败（发布已成功、media_id 已返回）：try/except 包裹 + `log("publish", "warn", ...)`。

### 2. 新路由 `routers/published.py`（main 处挂 `/api`）
- `GET /published-articles?status=&account_id=` — 列表，默认 `read_count` 倒序；返回含 `account_name`（join PublishAccount）。
- `POST /published-articles` — 手动建（给 X/Blog 或系统外已发的留口）；必填 draft_id/account_id/title。
- `PATCH /published-articles/{id}` — 改 status/published_at/url/统计；任一统计字段出现即把 `stats_as_of=now`；标 published 时若未给 published_at 则置 now。
- `DELETE /published-articles/{id}`。
- 统计字段校验：非负整数，负数 → 400。

### 3. MCP 工具 `get_recent_performance(days: int = 30, limit: int = 20)`（mcp_server.py）
返回 `status="published"` 且 `published_at >= now-days` 的记录，按 `read_count` 倒序取 limit：
```
[{title, account_id, account_name, read_count, like_count, look_count, share_count, published_at}]
```
空表返回 `[]`。供总编判断「什么选题/账号有效」。

### 4. 总编接线（pipeline_template.py `DAILY_PLAN_PIPELINE`）
在总编指令现有「1. 调 get_topic_candidates()…」之后加一步：
> 「先调 `get_recent_performance()` 看最近哪些选题/账号阅读表现好或哑火；选题时倾向复制成功方向、避开重复哑火题材。」

## 前端 — `/published`「发布」页

导航「创作」组新增「发布」入口（`lib/api/published.ts` + `app/published/`）。一个列表，每行：
- 标题 · 公众号名 · 状态徽标 · 发布时间
- 行内可编辑统计：阅读 / 点赞 / 在看 / 分享（数字输入 + 每行一个「保存」按钮 → PATCH）
- 「标记已发布」按钮 + URL 输入框（draft_box → published）
- 默认按阅读量倒序 —— 这个排序列表本身就是「表现榜」，录入与可视化合一。

（不再单独做 dashboard 小组件，YAGNI；以后需要再加。）

## 错误处理

- 发布钩子建记录失败 → 不影响发布主流程，仅 warn 日志。
- 统计输入负数 → 400。
- `get_recent_performance` 空 → `[]`，总编容错。
- 列表/详情走标准 404/校验。

## 测试

仿现有模式（`test_wechat_publish` / `test_mcp_daily_plan_tools` / `test_dashboard`）：
- `Publication` 建记录、PATCH 改统计（`stats_as_of` 自动置位）、标已发布置 `published_at`、列表按 read 倒序、负数统计 400。
- publish/wechat 成功自动 upsert Publication；重复发布同 draft+account 不产生重复行（更新 media_id）。建记录失败不阻断发布（注入异常验证发布仍 200）。
- `get_recent_performance` 只取 published、按窗口过滤、按 read 倒序、空表返回 `[]`。

## 影响的文件

新增：`backend/routers/published.py`、`web/lib/api/published.ts`、`web/app/published/*`、对应测试。
修改：`models.py`(+Publication)、`schemas.py`、`main.py`(挂路由)、`routers/drafts.py`(发布钩子)、`mcp_server.py`(+工具)、`pipeline_template.py`(总编指令)、`Sidebar.tsx`(导航)。
