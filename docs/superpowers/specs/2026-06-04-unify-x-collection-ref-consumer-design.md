# 统一 X 采集，参考库改为下游消费

日期：2026-06-04

## 背景

目前有两套独立的 X 采集路径：

1. **订阅管理（raw 层）** —— `XSubscription`（一个时间线/列表 URL）→ `grab_timeline(url)` → 原始帖入 `x_posts`。纯抓取、无过滤、无 LLM。
2. **参考文案库 采集规程（精炼层）** —— `RefCollectRule` 是一条 X Top **搜索** saved query → 每次运行 `search_top(...)` 实时打 X → 规则粗筛 → LLM 精筛 → 入 `ref_materials`。每跑一次就实时打一次 X。

两条路径都直接打 X，职责重叠。

## 目标

统一 X 数据采集为单一 raw 层，参考库降级为下游消费者：

- **X 订阅 = 唯一的 raw 采集层**：把「采集规程」的搜索式采集并入订阅管理，成为新的 `search` 订阅类型，与时间线订阅一样把原始帖落进 `x_posts`。X 订阅完全不知道参考库存在。
- **参考库 = 下游消费者**：不再实时打 X，按自己的节奏从 `x_posts` 取候选，做粗筛 + LLM 精筛 → `ref_materials`。

核心原则：**X 只负责数据收集；参考库自己决定何时、从哪取数据。** 两边彻底解耦。

## 非目标

- 不改 LLM 精筛/打分逻辑（`_prefilter` → `classify_ref_posts` → `_upsert_material`），这段回归敏感，零改动。
- 不改去重账本 `RefSeen` 的结构与语义。
- 不引入迁移框架；模型加列走手动 ALTER（项目惯例）。

## 数据模型变更（`backend/models.py`）

### `XSubscription` 加字段

- `kind: str`，default `"timeline"` —— 取值 `"timeline"`（现有）| `"search"`（新）。
- 搜索参数（仅 `kind="search"` 使用，沿用旧 `RefCollectRule` 字段名）：
  - `raw_query: str` default `""`
  - `min_faves: int` default `0`
  - `min_retweets: int` default `0`
  - `lang: str` default `""`
  - `days: int` default `1`
  - `extra_terms: str` default `""`
  - `sort: str` default `"top"`
  - `max_results: int` default `100`
- `url` 改为**可空**（`nullable=True`）：搜索订阅无 URL。`url` 上的 unique 索引保留——PG 与 SQLite 均允许多个 NULL 共存，搜索订阅之间不冲突。

### `XPost` 加字段

- `possibly_sensitive: bool`，default `False` —— raw 采集时保存敏感标记。当前该标记来自 `ParsedPost.possibly_sensitive`，落库会丢；参考库粗筛 `_prefilter(exclude_sensitive=...)` 需要它，故必须在 raw 层持久化。

### `RefCollectRule` 改语义为「选取规则」

表名不变（`ref_collect_rules`），语义从「X 搜索 saved query」变为「从 x_posts 取数的选取规则」：

- 新增 `source_subscription_id: int | None`，`nullable=True` —— 从哪个 X 订阅取候选。`null` = 全部订阅（保留能力，但 UI 新建时必选一个，见下）。
- 继续使用并复用：`label / enabled / exclude_sensitive / min_faves / days / max_results / last_collected_at / last_error / added_at`。语义调整：
  - `min_faves` —— 对**已存 `XPost.likes`** 的二次下限（搜索订阅抓取时的 `min_faves` 是主过滤，这里是可选的额外地板）。
  - `days` —— 在 `x_posts` 里回看的时间窗（`published_at >= now - days`）。
  - `max_results` —— 每次取候选上限。
- 不再使用：`raw_query / sort / extra_terms / min_retweets`（这些职责搬去 `XSubscription` 了）。列保留但忽略，避免无谓的破坏性改动。

> `lang` 不在参考库侧过滤：搜索订阅抓取时已用 `lang` 算子约束，`x_posts` 也无 `lang` 列。

### 需手动执行的线上 ALTER（Postgres）

```sql
ALTER TABLE x_subscriptions ADD COLUMN kind VARCHAR DEFAULT 'timeline';
ALTER TABLE x_subscriptions ADD COLUMN raw_query VARCHAR DEFAULT '';
ALTER TABLE x_subscriptions ADD COLUMN min_faves INTEGER DEFAULT 0;
ALTER TABLE x_subscriptions ADD COLUMN min_retweets INTEGER DEFAULT 0;
ALTER TABLE x_subscriptions ADD COLUMN lang VARCHAR DEFAULT '';
ALTER TABLE x_subscriptions ADD COLUMN days INTEGER DEFAULT 1;
ALTER TABLE x_subscriptions ADD COLUMN extra_terms VARCHAR DEFAULT '';
ALTER TABLE x_subscriptions ADD COLUMN sort VARCHAR DEFAULT 'top';
ALTER TABLE x_subscriptions ADD COLUMN max_results INTEGER DEFAULT 100;
ALTER TABLE x_subscriptions ALTER COLUMN url DROP NOT NULL;

ALTER TABLE x_posts ADD COLUMN possibly_sensitive BOOLEAN DEFAULT FALSE;

ALTER TABLE ref_collect_rules ADD COLUMN source_subscription_id INTEGER;
```

（本地 SQLite 由 `create_all` 在新建库时覆盖；已有库同样需手动 ALTER。`create_all` 不改已有表。）

## Raw 采集变更（`backend/routers/x.py`）

### `_collect_one(db, sub)` 按 `kind` 分支

- `kind == "timeline"`（默认）：现有逻辑 `grab_timeline(sub.url, since=cutoff)`，不变。
- `kind == "search"`：`search_top(raw_query=sub.raw_query, min_faves=sub.min_faves, min_retweets=sub.min_retweets, lang=sub.lang, days=sub.days, extra_terms=sub.extra_terms, sort=sub.sort, limit=sub.max_results)`，结果同样 upsert 进 `x_posts`（`subscription_id=sub.id`）。
  - 搜索订阅不走 `_compute_collect_cutoff`（搜索自带 `days` 窗口；`x_posts` 的 `tweet_id` upsert 天然去重）。

### `_upsert_post_stmt`

- 补 `possibly_sensitive=p.possibly_sensitive`（插入与 on-conflict 更新均带上）。

### 订阅创建/列表 API

- `SubscriptionCreate` 增加 `kind` 与搜索参数字段（可选；`kind` 默认 `"timeline"`）。
- `kind="timeline"` 校验 `url` 必填且以 `http(s)://` 开头（现有逻辑）。
- `kind="search"` 校验 `raw_query` 非空（或结构化参数足以构建查询）；`url` 允许为空，label 默认由 query 生成。
- `SubscriptionOut` 增加 `kind`（前端显示徽标）。

### 调度器

无需改动：小时级 `scheduled_x_collect` 本就遍历所有 enabled `XSubscription`，自动覆盖搜索订阅（`_collect_one` 内部分支）。

## 参考库精炼变更（`backend/ref_collector.py`）

### `collect_rule(db, rule)` 数据源切换

把开头的 `search_top(...)` 替换为对 `XPost` 的查询：

```
候选 = XPost
  where (rule.source_subscription_id 为空 或 subscription_id == rule.source_subscription_id)
    and published_at >= now - rule.days
    and likes >= rule.min_faves
  order by published_at desc
  limit rule.max_results
```

查出的 `XPost` 行经一个轻适配器转成 `_prefilter` / `_upsert_material` 所需的字段载体（`ParsedPost`-like：`tweet_id / content / possibly_sensitive / likes / reposts / replies / views / display_name / username / url / cover_image / published_at`）。

此后管线**完全不变**：

- `_already_seen` / `_prefilter(exclude_sensitive=rule.exclude_sensitive)` / `classify_ref_posts(LLM 精筛)` / `_upsert_material(rule.id, …)` / `_mark_seen` 全部原样。
- `rule.last_collected_at` / `rule.last_error` 写法不变。
- 异常处理：原 `search_top` 失败写 `last_error` 的分支，改为查询/适配阶段的异常处理（DB 查询一般不抛网络错，但保留 last_error 写入以兼容 UI）。

### `collect_all(db)`

不变（仍遍历 enabled 的选取规则，逐条 `collect_rule`）。daily 调度 `scheduled_ref_collect` 与手动「立即采集」按钮逻辑不变——只是底层不再实时打 X。

### 去重衔接

`RefSeen`（`platform="x"`, `source_id=tweet_id`）与 `x_posts.tweet_id` 对齐。迁移前已 kept/rejected 的 tweet 不会因为换数据源而二次过 LLM。

## 迁移（`backend/ref_migrate.py`，幂等）

新增一个幂等迁移函数（`AppSetting` 标志位，沿用现有模式），在 startup 调用：

对每条现有 `RefCollectRule`：

1. 新建一个 `XSubscription`：`kind="search"`，拷贝 `raw_query / min_faves / min_retweets / lang / days / extra_terms / sort / max_results / label / enabled`，`url=NULL`，`added_at=now`。
2. 设 `rule.source_subscription_id = 新订阅.id`。
3. 提交并打标志位。

已入库的 `ref_materials`、`RefSeen` 原样保留。`ref_materials.rule_id` 仍指向同一条（语义不变的）规则，外键关系不破。

迁移后首次运行：搜索订阅把原始帖灌进 `x_posts`，参考库选取规则从 `x_posts` 读 → 因 `RefSeen` 命中而跳过已处理 tweet，仅新帖过 LLM。

## 前端变更

### X 订阅管理抽屉（`web/app/x/XClient.tsx`）

- URL 输入区旁增加「搜索订阅」表单：`raw_query`（或 query/min_faves/lang/days 结构化输入），提交时带 `kind="search"`。
- 订阅列表项显示 `kind` 徽标（时间线 / 搜索）。

### 参考库采集抽屉（`web/app/materials/MaterialsClient.tsx` `RulesDrawer`）

- 标题与文案从「采集规则（X 泛流量）」改为「选取规则」。
- 新建规则表单：把 `raw_query` 输入替换为**来源订阅选择器**（必选一个 X 订阅）+ 阈值（min_faves / days / max_results）+ exclude_sensitive。
- 「立即采集 / 全部采集」语义改为「从 x_posts 精炼」，文案相应调整。

### API 客户端

- `web/lib/api/x.ts`：`SubscriptionOut` 加 `kind`；create 支持 `kind` + 搜索参数。
- `web/lib/api/materials.ts`：`CollectRule` 加 `source_subscription_id`，create/patch 支持。

## 测试

复用并扩展现有测试：

- `backend/tests/test_x_router.py`：新增 search 订阅创建、`_collect_one` 在 `kind="search"` 下调用 `search_top` 并落库（mock `search_top`）。
- `backend/tests/test_ref_collector.py`：`collect_rule` 现在从 `x_posts` 取候选（构造 XPost 行，mock `classify_ref_posts`），验证粗筛/精筛/入库/RefSeen 行为不变。
- `backend/tests/test_ref_migrate.py`：新增搜索订阅迁移用例（每条旧规则 → 一个 search 订阅 + `source_subscription_id` 回填，幂等）。

所有命令加 `conda run -n wems` 前缀。

## 决策记录

1. **候选来源**：X 只收集，参考库自己从 `x_posts` 取——两边解耦（用户明确）。
2. **参考库取数方式**：保留「采集规程」，改为指向订阅的「选取规则」（用户选定）。
3. **`possibly_sensitive` 加列**：在 raw 层持久化敏感标记，含线上手动 ALTER（用户确认自行处理列）。
4. **`source_subscription_id` 默认**：迁移来的指向对应搜索订阅；UI 新建时必选一个订阅（避免误把时间线普通帖喂进 LLM）。
