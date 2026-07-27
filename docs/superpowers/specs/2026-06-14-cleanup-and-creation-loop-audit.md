# 项目梳理：旧链路下线 + 文章创作闭环审计

日期：2026-06-14
范围：① 移除已废弃模块/死代码（已执行）；② 文章创作闭环梳理与缺口/优化清单（报告）。

---

## 一、TL;DR

- **已执行**：整体下线「旧选题链路」（通用 `collector` → `analyzer` 聚类 → `Topic` 表 → 首页「系统推荐选题」），并清掉一批孤儿前后端文件。共 **删除 17 个文件、约 2470 行**，新增 22 行。
- 下线动机：该链路每 15 分钟空转一次（烧网络 + LLM），产出的 `Topic` 只被「不存在的 `/api/topics` 路由」（首页永远 404 走空）和一个可选 MCP 候选源消费；trend 数据还是 `random.gauss` 假的。
- **验证**：后端可正常 import（182 路由）；前端 `tsc --noEmit` 零错误；受影响的 24 个测试全绿；其余失败均为既存（writing_plans/wechat_publish/ref flake）。
- **闭环最大缺口**：发布后无「效果回流」——发出去的文章阅读/点赞从不回采反哺选题，闭环其实没闭上。

---

## 二、本轮已执行的清理

### 删除的旧选题链路
| 层 | 删除项 |
|----|--------|
| 后端模块 | `collector.py`、`analyzer.py`、`topic_clustering.py` |
| 后端路由 | `routers/accounts.py`、`routers/collect.py`、`routers/synthesize.py`（X 长文按角度合成，0 引用） |
| 模型 | `Account`、`Post`、`Topic`、`TopicCluster`（**保留** `PublishAccount`/`ContentDirection`/`TopicStrategy`/`TopicGeneratorCache`） |
| schemas | `AccountCreate/Out/Update`、`PostOut`、`TopicOut/Create/StatusUpdate`、`CollectResult`、`GenerateResult` |
| 前端 | `lib/api/{topics,write,accounts}.ts`、`store/topics.ts`、`mock/`、`components/features/{TopicCard,TopicActions,TopicDrawer,GenerateButton,UrgencyBadge,ScoreStars,MiniSparkline}.tsx` |
| 类型 | `lib/types.ts` 的 `Source`/`Topic`/`TopicStatus`/`UrgencyLevel`/`FollowedAccount`/`GenerateResult` |

### 连带编辑
- `main.py`：摘 accounts/collect/synthesize 路由 + 删 `/api/analyze/all`。
- `scheduler.py`：删 `scheduled_collect_and_analyze` + `collect_analyze` 定时任务（**不再每 15 分钟空转**）。
- `mcp_server.py`：候选池删 `topic_library` 源 + docstring。
- `dashboard.py`：源状态网格删「订阅账号(collect)/选题分析(analyze)」两格（13→11 源）；首页「今日 +N 选题」由数 `Topic` 改为数 `DailyPlanItem`（今日计划入选条目）。
- `settings.py`/`config.py`/`settings.ts`/`CollectSection.tsx`：删 `collect_interval_minutes`（死配置 + 会去重排已删任务的 reschedule 逻辑）；**保留 `rsshub_base`**（github trending 仍在用）。
- `database.py`：`init_db` 幂等 `DROP TABLE` accounts/posts/topics/topic_clusters。
- 首页 `page.tsx`：移除坏掉的「系统推荐选题」段。

### 验证记录
- `python -c "import main ..."` → OK，182 路由。
- `pnpm exec tsc --noEmit` → 0 错误（首轮抓到 `mock/` 残留，已删）。
- `pytest tests/test_dashboard.py tests/test_mcp_daily_plan_tools.py` → 24 passed。
- 全量 pytest：本轮引入的 5 个失败已全部修复；剩余失败为既存（8 writing_plans dispatch + 2 wechat_publish + ref_collector 顺序 flake）。

---

## 三、文章创作闭环现状图

```
信息源采集 ──→ 候选池 ──→ 选题 ──→ 创作 ──→ 草稿 ──→ 发布 ──→ ❌(效果回流缺失)
```

| 环节 | 现役实现 |
|------|---------|
| 采集 | 10 个专用采集器（github/x/reddit/papers/v2ex/kr/juejin/producthunt/youtube/wechat）+ 参考文案清洗线，各写专用表 |
| 候选池 | MCP `get_topic_candidates`：近 24h 各源高热 + 写作方案 |
| 选题 | `daily_planner`（每天 8 点 wms_scout 总编）→ `/daily-plan` 确认入队；`topic_generator`（热点选题页按需生成） |
| 创作 | `studio.py` + `pipeline_template`（scout→editor→writer→critic 多 agent） |
| 草稿/发布 | drafts → 公众号 API 草稿箱 / Blog(mkflow) / X 预览复制 |

---

## 四、闭环缺口（按优先级）

### P0 — 发布效果回流（闭环没闭上）
- **现状**：发布后没有任何环节把阅读/点赞/转发回采，更没有反哺选题。`DailyPlanItem` 模型注释写着「后续发布排期/效果回流都挂在这个锚点上」——锚点留了，回流没做。
- **建议**：加一个定时任务，对已发布文章拉回表现数据（公众号走 API stats；X 的 metrics 本就在采；Blog 视平台），落到 draft/plan-item 上；再把「哪类选题/账号表现好」喂给总编 prompt 或候选池热度。这才真正闭环。

### P1 — 首页丢了「今天写什么」入口
- 本轮删掉了坏掉的「系统推荐选题」，首页现在只剩提醒/今日 Release/采集网格，没有「今天写什么」。
- **建议**：把「今日计划」(DailyPlanItem) 直接搬上首页（数据已有 `/api/daily-plan`），是最贴合的「今天写什么」入口，小改动高价值。

### P1 — 候选池盲区 + 跨稿去重
- `get_topic_candidates` 没有 **公众号**源：竞品公众号文章在采却没进选题池（强信号被浪费）。
- 候选未对「已写草稿 / 已发选题」去重，总编可能重复选已写过的题。
- **建议**：候选池加 wechat 源；用仓库已有的 `text_dedupe`/overlap 工具，按标题与近期 `ArticleDraft` / 已发布做重叠过滤。

---

## 五、其他可优化点（P2）

- **配图/封面闭环**：确认 `baoyu-article-illustrator` / `baoyu-cover-image` 技能是否接进 pipeline 产出，否则仍是手动。
- **一稿多发扩面**：掘金已采集但只读；可加掘金/知乎发布通道，复用现有「发布弹窗」壳。
- **发布排期视图**：`release_drafter` + `daily_quota` 已有底子，可做一个「发布日历」把排期可视化。
- **真·趋势数据**：旧的假 trend/competitor_count 已随链路删除；若仍想要趋势小图，用 X/公众号真实 metrics 回填，而非随机数。

---

## 六、后续如何推进
P0/P1 每项都可独立走「设计 → 计划 → 实现」。建议先做 **P0 效果回流**（闭环价值最高）或 **P1 首页今日计划入口**（成本最低、立刻可见）。
