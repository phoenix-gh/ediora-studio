# 每日自动内容计划（今日计划）设计

日期：2026-06-12
状态：已批准

## 背景：内容闭环与本期范围

完整闭环：①情报采集 → ②账号策略 → ③每日选题分发 → ④内容生成 → ⑤人工审核 → ⑥发布排期 → ⑦效果回流（反哺②③）。
现状 ①④⑤ 已通，③ 是手动（topic_generator 人点按钮人勾选），⑥ 缺排期与状态回写，⑦ 整段缺失。

**本期只打 ③**：每天 8 点由 Hermes 策划 agent 为每个 active 账号制定「今日计划」，用户在独立页面确认后入队现有创作链路。⑥⑦ 为后续两期，都挂在本期的 `DailyPlanItem` 锚点上，不返工。

## 已确认的决策

- 人工介入点：自动到「今日计划」，**确认后**才入队生成（不全自动到草稿）
- 策划者：**Hermes agent**（方案 B），不是 LLM 直调（A）也不是纯规则（C）
- 复用 **wms_scout**（策划型档案，带 web 工具 + MCP 桥），不新建 wms_planner
- 触发：每天早上 **8 点**（APScheduler cron）
- UI：导航**单独列项**的独立页面 `/daily-plan`
- 撞题处理：**一稿多发**——同一选题分给多个账号时共享草稿，只跑一条 agent 链，不重复写
- 配额：`PublishAccount.daily_quota` JSON，形如 `{"long": 1, "short": 2}`（story/share 由 planner 在 short 配额内调剂）；空 dict = 不参与每日计划

## 数据模型（models.py）

```
DailyPlan                            DailyPlanItem
├ id (int autoincrement)             ├ id (int autoincrement)
├ plan_date (Date, unique)           ├ plan_id (FK DailyPlan, index)
├ status planning|ready|failed       ├ account_id (FK PublishAccount)
├ kanban_task_id (str, 策划任务)     ├ title / angle / reason (推荐理由)
├ planner_note (Text, 总编留言)      ├ content_type long|short|story|share
└ created_at / updated_at            ├ sources JSON [{platform,title,url}]
                                     ├ group_key (str, 默认""；同组共享一稿)
                                     ├ is_primary (bool；主笔账号=用谁的画像写)
                                     ├ status suggested|approved|skipped|enqueued
                                     ├ pipeline_task_id (int|None) / draft_id (int|None)
                                     └ created_at
```

- 同 `group_key` 的 items 必须同体裁；组内恰好一个 `is_primary=True`
- `draft_id` 读时回填：GET 计划接口 join `PipelineTask.draft_id`，有值则持久化到 item
- `PublishAccount` 加列 `daily_quota`（JSON, default dict）。⚠️ 无迁移框架：线上 PG 手动
  `ALTER TABLE publish_accounts ADD COLUMN daily_quota JSON DEFAULT '{}'`

## 后端

### daily_planner.py（新模块）

`async def create_today_plan(db, *, force=False) -> DailyPlan`：

1. 守卫：今日已有 DailyPlan 且非 force → 直接返回（幂等）；force 则删除重建（连带 items）
2. 无 active 账号或所有 daily_quota 为空 → 跳过并 `log("daily_plan", "skip", ...)`
3. 建 `DailyPlan(status=planning)` → 按 `DAILY_PLAN_PIPELINE` 蓝图 `kanban_create` 单棒任务，
   回填 `kanban_task_id`

scheduler.py：`register_jobs` 新增 cron job（`trigger="cron", hour=8`，id=`daily_plan`），调
`create_today_plan`；异常写 collect_logs（沿用 `log()`）。

### pipeline_template.py — DAILY_PLAN_PIPELINE

单棒，flow `"daily_plan"`，assignee `wms_scout`。任务书包含：

- 今天日期、各 active 账号的画像摘要（定位/受众/topic_focus/禁区）+ `daily_quota`
- 近 7 天已写标题清单（DailyPlanItem titles + ArticleDraft titles），明令不重复选题
- 指令：调 `get_topic_candidates` 拉候选池 → 可 web 搜索核实/补热点 → 按账号画像与配额
  分配选题，给出角度与推荐理由 → 撞题时同 `group_key` 标组、指定主笔（`is_primary`）、
  同组同体裁 → `save_daily_plan(...)` → `kanban_complete(summary, metadata={plan_id, item_count})`

### mcp_server.py — 新增 3 个工具

| 工具 | 行为 |
|---|---|
| `get_topic_candidates(sources=None, limit_per_source=10)` | 统一候选池：X 热帖（24h 按 likes+reposts top50）、GitHub release（近 24h）、论文/快讯/掘金/V2EX/Reddit/ProductHunt/YouTube（各近 24h top10）、选题库 pending Topic、active WritingPlan。统一返回 `{source, title, summary, url, heat, published_at}` |
| `save_daily_plan(plan_id, items, note="")` | 校验 plan 存在、account_id 有效、content_type 合法、组约束（同组同体裁、恰一个主笔）；整体替换该 plan 的 items（幂等），置 `status=ready`，写 planner_note |
| `get_recent_outputs(days=7)` | 近 N 天 plan item + draft 标题（备用查重；任务书已附清单） |

### routers/daily_plan.py（新路由）

- `GET /daily-plan/today`（兼 `?date=`）→ plan + items（按账号分组所需字段齐全；读时回填 draft_id）
- `POST /daily-plan/generate` → 调 `create_today_plan(force=True)`（页面「重新生成」与测试入口）
- `POST /daily-plan/{plan_id}/enqueue` body `{item_ids: [...]}`：
  - 选中 items 按 `group_key` 分组（空 key 各自独立）
  - 每组只建一条链：主笔 item 被选中用主笔，否则用组内第一个选中项的账号画像
  - `content_type=long` → `topic_long` 蓝图；short/story/share → `topic_short`；复用 studio
    `_run_pipeline_chain`（item 的 title/angle/content_type/sources 对应 ctx）
  - 组内所有选中 item：status=enqueued、共享同一 `pipeline_task_id`
- `POST /daily-plan/items/{item_id}/skip` → toggle：suggested→skipped，skipped→suggested；
  enqueued 项不可 skip（400）

错误处理：hermes CLI 失败 → 503（沿用 `_kanban_create`）；agent 挂住 → plan 停在 planning，
页面显示「生成中」+「重新生成」可用；item/plan 不存在 → 404；入队已 enqueued 的 item → 跳过不重复建链。

## 前端

- 导航单独列项「今日计划」→ `app/daily-plan/page.tsx` + `components/features/DailyPlanClient.tsx`
- `lib/api/dailyPlan.ts`：类型 + `getTodayPlan` / `generatePlan` / `enqueueItems` / `skipItem`
- 页面结构：header（日期 + 状态徽章 planning/ready/failed + 重新生成按钮）；按账号分组的
  item 卡片：勾选框、标题、角度、体裁徽章、来源链接、推荐理由；共享组显示「共享一稿·主笔 X」
  徽章；底部「入队所选」；enqueued 项显示链路状态、draft 就绪后链到草稿
- 工作台提醒区追加：「今日计划已就绪，N 条待确认」→ 链到 /daily-plan

## 测试

- `test_daily_planner.py`：幂等守卫（今日已有→跳过；force→重建）、无账号/空配额跳过、
  kanban_task_id 回填（monkeypatch `_kanban_create`）
- `test_pipeline_template_daily_plan.py`：蓝图渲染含账号画像/配额/查重清单/组规则指令
- `test_mcp_daily_plan_tools.py`：候选池聚合（seed 各源数据断言形态与上限）、save_daily_plan
  校验与整体替换幂等、组约束拒绝（异组体裁/多主笔）
- `test_daily_plan_enqueue.py`：组去重建链（一组一链、共享 pipeline_task_id）、主笔选择规则、
  已 enqueued 跳过、404（照搬 test_studio_enqueue_manual 的 monkeypatch 手法）
- cron 注册冒烟（register_jobs 含 daily_plan job）；测试隔离 scheduler STATE_FILE（既有坑）
- 前端 `pnpm build`

## 后续两期（不在本期）

- 第二期：item 带建议发布时段，发布动作回写状态与 published_at，工作台「今天还有 N 条没发」
- 第三期：自有账号数据回采挂回 item，策划任务书注入「近 30 天 top/bottom 选题表现」自我调优
