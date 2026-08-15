# 统一「参考文案库」：X 泛流量段子采集 + 金句库合并

**Date:** 2026-05-30
**Status:** Awaiting user review (revised — merged 金句库 in; spike validated 2026-05-30).
**命名说明:** 统一表 `ref_materials`、页面「参考文案库」、`/materials` 均为暂定，review 时可改。

## 1. 背景与目标

两个动机合一：

1. **新增 X 泛流量采集**：现有 X 模块（`2026-05-25` 重构后）只有「订阅采集」+「关键词实时搜索」，没有「热门 / 泛流量」打捞能力（旧 `tl1.com` 热门榜当时被故意删除）。
2. **合并金句库**：现有「金句库」（`quotes` 表 + `/quotes` 页 + MCP 工具）是**纯手工录入**、按**使用场景**组织的可复用文案库。它和「采集来的段子」本质都是**写作时可复用的参考文案**，应统一成一个库。

**目标：建立单一的「参考文案库」**，一张统一表承载两类条目，用 `platform` 区分来源：

- **手工金句**（`platform="manual"`）：从金句库迁移而来，保留使用场景标签 + 写作方案关联。
- **采集段子**（`platform="x"`）：X Top 搜索 + 互动阈值打捞，经规则粗筛 + LLM 精筛入库。

并保留**两个正交维度**：`category`（内容分类）+ `scene_tags`（使用场景，横跨两类）。

非目标（v1）：段子接写作链路（挂写作方案/草稿）留 phase 2；除 X 外的采集源（schema 预留 `platform` 不代表现在做）；把高分段子并入 writer 候选池留 phase 2。

## 2. 关键技术结论（feedgrab 能否抓「热门」）

实测**当前装的 feedgrab 0.1.0** 源码：

- ❌ **无**任何 trends / explore / for-you / hot 专用接口——抓不到 X 官方热搜榜。
- ✅ 唯一可行路径是 `feedgrab.fetchers.twitter_keyword_search.search_twitter_keyword`，含全部所需旋钮：
  ```python
  search_twitter_keyword(keyword, lang="", days=1, min_faves=0, min_retweets=0,
                         sort="live", exclude_retweets=True, max_results=100,
                         raw=False, save_tweets=False, skip_summary=True)
  ```
  - `sort="top"` → GraphQL `product="Top"`（互动度排序）
  - `min_faves` / `min_retweets` → 爆款门槛；`lang="zh"`、`days=N`
  - `raw=True` → 塞任意高级检索语法（`build_search_query` 默认给关键词加引号，话题无关查询**必须** `raw=True`）

**核心假设——已验证 ✅（spike 2026-05-30，见 `docs/superpowers/spikes/2026-05-30-x-top-search-operator-only.md`）：** operator-only raw 查询（`min_faves:1000 lang:zh -filter:replies -filter:links -filter:retweets`）+ `raw=True` + `sort="top"` 满页返回 20 条高赞中文帖，含大量真段子。主路径确认，**无需种子词退路**。spike 还测出：阈值/时间窗很敏感（高阈值+近窗过稀），且 tweet dict 自带 `possibly_sensitive` 可用于砍 NSFW。

## 3. 数据模型（3 张新表）

由 `database.py:41` 的 `Base.metadata.create_all` 自动建，**无需手动迁移建表**（符合「无迁移框架」约定）。金句**数据**迁移见 §9。

```python
class RefMaterial(Base):
    """统一参考文案条目：手工金句(platform=manual) + 采集段子(platform=x)。"""
    __tablename__ = "ref_materials"
    id: Mapped[int]                          # PK autoincrement
    platform: Mapped[str] = "manual"         # manual / x （来源判别）
    source_id: Mapped[str | None]            # tweet_id（采集类）；manual 为 None
    text: Mapped[str]                        # 原文 / 金句正文
    text_clean: Mapped[str] = ""             # LLM 清洗后参考文案（采集类），可空
    author: Mapped[str] = ""
    handle: Mapped[str] = ""                 # @screen_name（采集类）
    source: Mapped[str] = ""                 # 出处（金句沿用）
    source_url: Mapped[str] = ""
    cover_image: Mapped[str] = ""            # 配图（采集类）
    likes: Mapped[int] = 0
    reposts: Mapped[int] = 0
    replies: Mapped[int] = 0
    views: Mapped[int] = 0
    score: Mapped[int] = 0                   # LLM 段子分 0-100（manual=0）
    category: Mapped[str] = ""               # 内容分类（受控词表，§6）
    scene_tags: Mapped[list] = []            # 使用场景（横跨两类，§6）
    tags: Mapped[list] = []                  # 自由细标签
    writing_plan_id: Mapped[int | None]      # 写作方案关联（金句沿用；段子 phase 2）
    rule_id: Mapped[int | None]              # 来源采集规则（采集类）
    status: Mapped[str] = "active"           # active / archived
    published_at: Mapped[datetime | None]    # 原帖时间（采集类）
    created_at: Mapped[datetime]
    updated_at: Mapped[datetime]
    # UniqueConstraint(platform, source_id)  —— source_id 非空时去重

class RefCollectRule(Base):
    """采集规则 —— 一条 X Top 搜索 saved query。仿 XSubscription。"""
    __tablename__ = "ref_collect_rules"
    id: Mapped[int]
    label: Mapped[str]                       # 如「中文泛流量·点赞过3000」
    platform: Mapped[str] = "x"
    min_faves: Mapped[int] = 1500            # spike：高阈值+近窗过稀，中等阈值+seen 去重更稳
    min_retweets: Mapped[int] = 0
    lang: Mapped[str] = "zh"
    days: Mapped[int] = 2
    exclude_sensitive: Mapped[bool] = True   # 砍 possibly_sensitive（NSFW）
    extra_terms: Mapped[str] = ""            # 可选种子词
    raw_query: Mapped[str] = ""              # 非空 → 原样传 raw=True（覆写上面）
    sort: Mapped[str] = "top"
    max_results: Mapped[int] = 100
    enabled: Mapped[bool] = True
    last_collected_at: Mapped[datetime | None]
    last_error: Mapped[str] = ""
    added_at: Mapped[datetime]

class RefSeen(Base):
    """去重账本：已评估的 source_id，避免重复爆款二次过 LLM。"""
    __tablename__ = "ref_seen"
    id: Mapped[int]
    platform: Mapped[str] = "x"
    source_id: Mapped[str]
    verdict: Mapped[str]                     # kept / rejected
    seen_at: Mapped[datetime]
    # UniqueConstraint(platform, source_id)
```
> 模型字段为示意，实现按项目 `mapped_column(...)` 写法落地。

## 4. 采集与提炼管道（仅 platform=x）

```
RefCollectRule  ──►  feedgrab Top 搜索   ──►  规则粗筛   ──►  LLM 精筛(批量)        ──►  upsert RefMaterial + 写 RefSeen
 (每天/手动)         search_top(...)         去明显杂质     keep/score/category/      仅 kept 入库(platform=x)
                                            + 去 seen      scene_tags/tags/clean     rejected 只记 seen
```

### 4.1 feedgrab 集成层（`feedgrab_client.py` 扩展）
现有 `search_x` 写死 `sort="live"`/`min_faves=0`，不能复用。新增：
```python
async def search_top(raw_query: str = "", *, min_faves: int = 0, min_retweets: int = 0,
                     lang: str = "", days: int = 1, extra_terms: str = "",
                     sort: str = "top", limit: int = 100) -> list[ParsedPost]:
    """raw_query 非空 → keyword=raw_query, raw=True（话题无关 operator-only，推荐默认）；
       否则 keyword=extra_terms（种子词，可空）+ 结构化 min_faves/lang/days。"""
```
透传到 `search_twitter_keyword`（`save_tweets=False, skip_summary=True`），复用现成的 `_tweet_dict_to_parsed_post`。

### 4.2 规则粗筛（`ref_collector.py`，零成本）
丢弃：`(x, source_id)` 已在 `RefSeen` → 跳过不过 LLM；`possibly_sensitive=True`（NSFW，当规则 `exclude_sensitive`）；含 URL 且无配图；`len(text)<10`；@-提及占比过高。（转推由查询的 `-filter:retweets` 排除。）注：**日采集不收窄 `since`**（spike 证近窗过稀），靠 `RefSeen` 去重避免重复爆款。

### 4.3 LLM 精筛（`llm.py` 新增，仿 `generate_topics_from_x_posts`）
```python
async def classify_ref_posts(posts, categories, scene_tags) -> list[dict]:
    """批量返回 [{source_id, keep, score, category, scene_tags, tags, text_clean}]。"""
```
每批 ~20-40 条，prompt 要求只输出 JSON 数组，用 `_call` + `_extract_json_array`。每条产出 `keep`(bool)、`score`(0-100)、`category`(从受控词表选，兜底「其他」)、`scene_tags`(从使用场景词表选 0-N 个)、`tags`、`text_clean`。批失败整体跳过、记日志。

### 4.4 入库
`keep=True` → upsert `RefMaterial`（platform=x，`(platform, source_id)` 冲突更新流量/score/分类）。所有评估过的写 `RefSeen`。更新 `rule.last_collected_at`/`last_error`，**逐规则失败隔离**。

## 5. 后端 API（`routers/materials.py`，新，替代 `routers/quotes.py`）

```
# 条目（两类统一）
GET    /materials?platform=&category=&scene_tag=&min_score=&q=&sort=score|views|time&plan_id=&limit=&offset=
POST   /materials              手工录入（金句库的创建路径迁移到此；platform 默认 manual）
PATCH  /materials/{id}         改 text/分类/场景/tags/归档/plan 关联
DELETE /materials/{id}
GET    /materials/categories   内容分类受控词表（来自 config）
GET    /materials/scene-tags   使用场景词表（固定 6 项，§6）

# 采集规则
GET    /materials/rules
POST   /materials/rules        {label, min_faves, lang, days, extra_terms?, raw_query?, ...}
PATCH  /materials/rules/{id}
DELETE /materials/rules/{id}
POST   /materials/rules/{id}/collect      单规则立即采集（sync）
POST   /materials/collect-all
```
`main.py` 注册新 router、**移除** quotes router。采集 upsert 复用 `routers/x.py` 的 pg/sqlite 双方言 `insert` 范式。

## 6. 两个维度的受控词表

- **使用场景 `scene_tags`（横跨两类，沿用金句库现值，前端 `SCENE_TAGS` 已定义）**：`opener 开头用` / `closer 收尾用` / `argument 论据` / `twist 反转` / `resonance 共鸣` / `warning 警示`。段子在 LLM 精筛时也打这些。
- **内容分类 `category`（新，存 `AppSetting` key `ref_categories`，可编辑）起始值**：`吐槽锐评`、`沙雕搞笑`、`温情共鸣`、`反转梗`、`金句格言`、`冷知识科普`、`热点观点`、`生活观察`、`职场打工`、`情感两性`、`其他`。

## 7. 调度（`scheduler.py`）

新增 `async def scheduled_ref_collect()`，仿 `scheduled_x_collect`（逐规则、`asyncio.sleep(2)`、失败隔离、`log("materials", ...)`）。`register_jobs()` 加：
```python
(scheduled_ref_collect, dict(trigger="interval", hours=24, id="ref_collect_daily")),
```
（节奏：**每天一次** + 前端「立即采集」手动入口。）

## 8. 前端 `/materials`（创作区，「参考文案库」，替代金句库）

- `Sidebar.tsx`「创作」组：**「金句库」改为「参考文案库」**（同一项，换名换 icon，指向 `/materials`）。`/quotes` 路由删除。
- **浏览**：左侧双维过滤——使用场景（沿用金句库现成 `SCENE_TAGS` 配色侧栏）+ 内容分类 + 来源(全部/手工/X)；顶部搜索 + 排序（段子分/流量/时间）。
- **卡片**：`text_clean` 优先（可展开看原文）+ 作者/出处 + 使用场景 chips + 分类 chip；`platform=x` 时多显示流量 + 段子分徽章 + 配图 + 「查看原推」；操作：复制/编辑/改类/归档/删除 + 写作方案关联（金句沿用）。
- **手工录入表单**：迁移金句库现成 `QuoteForm`（text/author/source/url + 使用场景 + 写作方案），并入本页「添加文案」。
- **采集规则**抽屉/Tab：规则 CRUD + 每条「立即采集」+「全部采集」。
- 栈：shadcn/ui + tailwind + sonner + lucide。注意 `web/AGENTS.md`：Next.js 有 breaking changes，写前查 `node_modules/next/dist/docs/`。

## 9. 金句库合并 / 迁移（一次性）

1. **数据迁移脚本**（`migrate_quotes_to_materials.py`，幂等：仅当 `ref_materials` 无 manual 行时执行）：
   `INSERT INTO ref_materials(platform, text, author, source, source_url, scene_tags, writing_plan_id, category, status, created_at, updated_at) SELECT 'manual', text, author, source, source_url, scene_tags, writing_plan_id, '', 'active', created_at, updated_at FROM quotes;`
2. **MCP 工具重指**（`mcp_server.py`，签名/名称不变，行为保持）：
   - `list_quotes(scene_tag=...)` → 查 `ref_materials WHERE platform='manual' [AND scene_tag ∈ scene_tags]`。
   - `save_quote(...)` → INSERT `ref_materials`（platform='manual'）。
   - （writer 候选池继续只取 manual 金句；高分段子并入留 phase 2。）
3. **退休**：删 `routers/quotes.py` + `app/quotes/` + `lib/api/quotes.ts` 的页面/路由；`main.py` 去掉 quotes router。
4. **`quotes` 物理表**：迁移并在生产验证无误前**保留**（作备份），后续单独清理删除。

## 10. 实现顺序（供 writing-plans 参考）

1. ~~**Spike**~~ ✅ 已完成（`docs/superpowers/spikes/2026-05-30-x-top-search-operator-only.md`）：operator-only 主路径确认。
2. 模型（3 张新表）+ `config.py` 加 `ref_categories` 默认。
3. `feedgrab_client.search_top` + 单测。
4. `llm.classify_ref_posts` + prompt（含 scene_tags 输出）。
5. `ref_collector.py`（粗筛 + 精筛 + 入库 + seen）+ 单测。
6. `routers/materials.py`（条目 + 规则）+ `main.py` 注册 + 单测。
7. `scheduler.py` 加作业。
8. **金句合并**：迁移脚本 + MCP 重指 + 退休 quotes router/页面（§9）。
9. 前端 `/materials` 统一页（双维浏览 + 手工表单 + 采集规则）+ Sidebar 改名。
10. 手工全链路：迁移后金句仍在、MCP `list_quotes` 仍可用；建采集规则 → 立即采集 → 段子分门别类入库；双维筛选 / 手工新增 / 编辑均 OK。

## 11. 测试策略

- `feedgrab_client.search_top`：mock，断言 raw/结构化两路参数透传（`sort="top"`、`raw=True`）。
- `ref_collector`：粗筛表驱动 + seen 去重短路；精筛 mock，验证仅 kept 入库、rejected 只写 seen、批失败不污染。
- `routers/materials`：条目查询双维过滤（platform/category/scene_tag/min_score/sort）+ 手工 POST + 规则 CRUD + collect。
- **迁移**：脚本幂等性（重复跑不重复插）；迁移后 `list_quotes`/`save_quote` MCP 行为不变（关键回归）。
- `scheduler`：逐规则失败隔离。

## 12. 风险与已知未知

- ~~operator-only raw 查询可行性~~ **已验证**（spike 2026-05-30）：满页返回，主路径确认，去掉种子词退路。
- **金句迁移 / MCP 回归**：金句库已接 agent 写作管道（writer `list_quotes`），迁移必须保证 MCP 行为零变化——列为关键回归测试；物理 `quotes` 表迁移后暂留作备份。
- **X 风控**：高 `min_faves` 返回页少；每天 1 次 + 逐规则 `sleep(2)`。需有效 cookie（`/x/auth-status` 探活）。
- **LLM 成本/质量**：规则粗筛 + seen 去重压住过模型量；段子判定 + 场景标注准确率靠 prompt 迭代。
- **两维度耦合**：`category` 与 `scene_tags` 都受控 + 兜底「其他」，防碎片化。

## 13. 明确不做（YAGNI）

- 不做候选账号池、不做账号 List 订阅（选定纯 Top 搜索）。
- 不存被拒帖子原文（只记 `RefSeen`）。
- 不做 metrics 历史曲线、二创生成。
- 段子接写作链路（挂写作方案/草稿）、高分段子并入 writer 候选池——phase 2。
- v1 采集只接 X。
- 不立即物理 drop `quotes` 表（验证后再清理）。
