# X 泛流量段子 →「参考文案库」设计

**Date:** 2026-05-30
**Status:** Awaiting user review of this spec.
**命名说明:** 表名 `ref_*` / 页面「段子库」均为暂定，review 时可改。

## 1. 背景与目标

现有 X 模块（`2026-05-25` 重构后）只有两件事：**订阅采集**（profile/list URL → 每小时入 `x_posts`）和**关键词实时搜索**（不入库）。它**没有**「热门 / 泛流量」采集能力——上一版基于 `tl1.com` 热门榜的抓取在那次重构中被**故意删除**。

本设计新增一个**独立的「参考文案库」**（创作区，与金句库并列）：存可复用、**分门别类**的参考文案。第一类内容是从 X 打捞的「泛流量段子」。

目标：
1. 后台按「采集规则」定时跑 X 的 **Top 搜索 + 互动阈值**，捞回话题无关的爆款洪流。
2. 经 **规则粗筛 → LLM 精筛（打分 + 归类 + 清洗）** 沉淀成参考文案。
3. 前端可**分门别类**浏览、按段子分/流量/时间排序、搜索。

非目标（v1）：写作链路复用（挂到写作方案/草稿）留 phase 2；除 X 外的采集源（schema 预留 `platform` 不代表现在做）。

## 2. 关键技术结论（feedgrab 能否抓「热门」）

实测**当前装的 feedgrab 0.1.0** 源码：

- ❌ **无**任何 trends / explore / for-you / hot 专用接口——抓不到 X 官方热搜榜。
- ✅ 唯一可行路径是 `feedgrab.fetchers.twitter_keyword_search.search_twitter_keyword`，签名含全部所需旋钮：
  ```python
  search_twitter_keyword(keyword, lang="", days=1, min_faves=0, min_retweets=0,
                         sort="live", exclude_retweets=True, max_results=100,
                         raw=False, save_tweets=False, skip_summary=True)
  ```
  - `sort="top"` → GraphQL `product="Top"`（互动度排序，而非时间）
  - `min_faves` / `min_retweets` → 爆款门槛
  - `lang="zh"`、`days=N`
  - `raw=True` → 直接塞任意高级检索语法（`build_search_query` 默认会给关键词加引号，话题无关查询**必须**走 `raw=True`）

**核心未验证假设（→ 实现第一步 spike）：** feedgrab 的 SearchTimeline GraphQL 能否接受「**无关键词、纯算子**」的 raw 查询（如 `min_faves:3000 lang:zh -filter:replies -filter:links`）并按 Top 返回结果。这正是「抓取看看 feedgrab 能否抓到热门」的实测点。退路：带一个极宽的种子词（如热门符号/常见字）。

## 3. 数据模型（3 张新表）

新表由 `database.py:41` 的 `Base.metadata.create_all` 自动建，**无需手动迁移**（符合项目「无迁移框架」约定）。

```python
class RefCollectRule(Base):
    """参考文案采集规则 —— 一条 X Top 搜索的 saved query。仿 XSubscription。"""
    __tablename__ = "ref_collect_rules"
    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    label: Mapped[str]                       # 显示名，如「中文泛流量·点赞过3000」
    platform: Mapped[str] = "x"              # v1 固定 x
    # 结构化参数（构建查询用）：
    min_faves: Mapped[int] = 3000
    min_retweets: Mapped[int] = 0
    lang: Mapped[str] = "zh"
    days: Mapped[int] = 1
    extra_terms: Mapped[str] = ""            # 可选附加算子/种子词
    raw_query: Mapped[str] = ""              # 非空则覆写上面所有参数，原样传 raw=True
    sort: Mapped[str] = "top"
    max_results: Mapped[int] = 100
    enabled: Mapped[bool] = True
    last_collected_at: Mapped[datetime | None]
    last_error: Mapped[str] = ""
    added_at: Mapped[datetime]

class RefPost(Base):
    """参考文案库条目（第一类来源 = X 段子）。"""
    __tablename__ = "ref_posts"
    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    platform: Mapped[str] = "x"
    source_id: Mapped[str]                   # = tweet_id；(platform, source_id) 去重
    text: Mapped[str]                        # 原文
    text_clean: Mapped[str] = ""             # LLM 清洗后的参考文案（去@/链接尾巴/emoji 噪声），可空
    author: Mapped[str] = ""                 # display name
    handle: Mapped[str] = ""                 # @screen_name
    source_url: Mapped[str] = ""
    cover_image: Mapped[str] = ""
    likes: Mapped[int] = 0
    reposts: Mapped[int] = 0
    replies: Mapped[int] = 0
    views: Mapped[int] = 0
    score: Mapped[int] = 0                   # LLM 段子分/参考价值 0-100
    category: Mapped[str] = ""               # 受控词表之一（见 §6）
    tags: Mapped[list] = []                  # JSON 细标签
    rule_id: Mapped[int | None]              # 来源采集规则
    status: Mapped[str] = "active"           # active / archived
    published_at: Mapped[datetime]
    collected_at: Mapped[datetime]
    # 唯一约束：UniqueConstraint(platform, source_id)

class RefSeen(Base):
    """去重账本：记录已评估过的 source_id，避免重复爆款二次过 LLM。"""
    __tablename__ = "ref_seen"
    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    platform: Mapped[str] = "x"
    source_id: Mapped[str]
    verdict: Mapped[str]                     # kept / rejected
    seen_at: Mapped[datetime]
    # 唯一约束：UniqueConstraint(platform, source_id)
```

## 4. 采集与提炼管道

```
RefCollectRule  ──►  feedgrab Top 搜索   ──►  规则粗筛   ──►  LLM 精筛(批量)   ──►  upsert RefPost + 写 RefSeen
 (每天/手动)         search_top(...)         去明显杂质     keep/score/          仅 kept 入库
                                            + 去 seen      category/tags/clean   rejected 只记 seen
```

### 4.1 feedgrab 集成层（`feedgrab_client.py` 扩展）
现有 `search_x` 写死 `sort="live"` / `min_faves=0`，不能复用。新增：
```python
async def search_top(raw_query: str = "", *, min_faves: int = 0, min_retweets: int = 0,
                     lang: str = "", days: int = 1, extra_terms: str = "",
                     sort: str = "top", limit: int = 100) -> list[ParsedPost]:
    """两条查询构建路径：
       - raw_query 非空 → 原样传 keyword=raw_query, raw=True（话题无关 operator-only，推荐默认）。
       - raw_query 为空 → keyword=extra_terms（种子词，可空）+ 结构化 min_faves/lang/days。
    """
```
透传到 `search_twitter_keyword`（`save_tweets=False, skip_summary=True`），复用现成的 `_tweet_dict_to_parsed_post` 解析。`ParsedPost` 已含 likes/reposts/replies/views/cover_image/author_avatar，够用。

> 注：默认「泛流量」规则用 **raw_query**（operator-only），正是 §2/§11 待 spike 验证的路径；结构化路径是「种子词 + 阈值」型规则的便捷入口（`build_search_query` 会给种子词加引号）。

### 4.2 规则粗筛（`ref_collector.py`，零成本）
对每条 `ParsedPost` 丢弃：
- `(platform, source_id)` 已在 `RefSeen`（无论 kept/rejected）→ 跳过，不再过 LLM。
- 含 URL 且**无**配图（纯导流/带货）。
- `len(text.strip()) < 10`。
- @-提及占比过高（纯 @ 互动）。
- （转推已由 feedgrab builder 的 `-is:retweet`（`exclude_retweets=True`）排除。）

### 4.3 LLM 精筛（`llm.py` 新增函数，仿 `generate_topics_from_x_posts`）
```python
async def classify_ref_posts(posts: list[dict], categories: list[str]) -> list[dict]:
    """批量喂粗筛幸存者，返回 [{source_id, keep, score, category, tags, text_clean}]。"""
```
- 一次批 ~20-40 条，prompt 要求**只输出 JSON 数组**，用现有 `_call` + `_extract_json_array`。
- 每条产出：`keep`(bool 是否够"段子"/有参考价值)、`score`(0-100)、`category`(从传入受控词表选，兜底「其他」)、`tags`(2-4 个)、`text_clean`(清洗后参考文案)。
- 失败/解析空 → 该批整体跳过（不污染库），记日志。

### 4.4 入库
- `keep=True` → upsert `RefPost`（`(platform, source_id)` 冲突时更新流量数 + score + category）。
- 所有评估过的（含 rejected）→ 写 `RefSeen`。
- 更新 `rule.last_collected_at`；异常写 `rule.last_error`，**逐规则失败隔离**。

## 5. 后端 API（`routers/materials.py`，新）

```
GET    /materials/rules                          采集规则列表
POST   /materials/rules        {label, min_faves, lang, days, extra_terms?, raw_query?, ...}
PATCH  /materials/rules/{id}    {enabled?, label?, min_faves?, ...}
DELETE /materials/rules/{id}
POST   /materials/rules/{id}/collect             单规则立即采集（sync）
POST   /materials/collect-all                    全量采集（与 cron 同逻辑）

GET    /materials/posts?category=&min_score=&platform=&q=&sort=score|views|time&limit=&offset=
PATCH  /materials/posts/{id}    {category?, tags?, status?}   人工改类/归档
DELETE /materials/posts/{id}
GET    /materials/categories                     受控词表（来自 config）
```
路由在 `main.py` 注册。采集复用 `routers/x.py` 的 `_pg_insert`/`_sl_insert` upsert 范式（pg/sqlite 双方言）。

## 6. 分类受控词表（起始，可编辑）

存于 `AppSetting`，config key `ref_categories`（缺省时用下表）。LLM 只能从中选，兜底「其他」：

`吐槽锐评`、`沙雕搞笑`、`温情共鸣`、`反转梗`、`金句格言`、`冷知识科普`、`热点观点`、`生活观察`、`职场打工`、`情感两性`、`其他`

## 7. 调度（`scheduler.py`）

新增 `async def scheduled_ref_collect()`，仿 `scheduled_x_collect`（逐规则、`asyncio.sleep(2)`、失败隔离、`log("materials", ...)`）。在 `register_jobs()` 的 `jobs` 列表加一行：
```python
(scheduled_ref_collect, dict(trigger="interval", hours=24, id="ref_collect_daily")),
```
（节奏：**每天一次**；前端另有「立即采集」手动入口。）

## 8. 前端 `/materials`（创作区，暂名「段子库」）

- `Sidebar.tsx` 「创作」组加一项（金句库下方），icon 用 lucide（如 `Sparkles`/`Smile`）。
- **浏览视图**：顶部分类 chips（分门别类，来自 `/categories`）+ 排序下拉（段子分/流量/时间）+ 搜索框；卡片：参考文案（`text_clean` 优先，可展开看原文）+ 作者 + 流量数 + 段子分徽章 + 分类标签 + 配图 + 「查看原推」。卡片操作：改分类、归档、删除。
- **采集规则**抽屉/Tab：规则列表（label/参数/启用开关/上次采集/last_error）+ 新增表单 + 每条「立即采集」+ 顶部「全部采集」。
- 技术栈：shadcn/ui + tailwind + sonner + lucide（项目实际栈，非 antd）。
- 注意 `wemedia-studio/AGENTS.md`：本项目 Next.js 有 breaking changes，写前先查 `node_modules/next/dist/docs/`。

## 9. 测试策略

- `feedgrab_client.search_top`：mock `search_twitter_keyword`，断言 raw/结构化两条路径的参数透传（尤其 `sort="top"`、`raw=True`）。
- `ref_collector` 粗筛：表驱动断言各丢弃规则 + seen 去重短路。
- `ref_collector` 精筛：mock `classify_ref_posts`，验证仅 kept 入库、rejected 只写 seen、批失败不污染库。
- `routers/materials`：mock collector/LLM，覆盖 rules CRUD + posts 查询过滤（category/min_score/sort）+ collect。
- `scheduler`：mock，验证逐规则失败隔离。
- **手工验证清单**：见 §11 spike + 全链路实测。

## 10. 实现顺序（供 writing-plans 参考）

1. **Spike**：wems env 实测 `search_twitter_keyword(keyword="min_faves:3000 lang:zh -filter:replies", raw=True, sort="top", ...)` 能否返回结果，落 `docs/superpowers/spikes/`。决定主路径 or 种子词退路。
2. 模型（3 张新表）。
3. `feedgrab_client.search_top` + 单测。
4. `llm.classify_ref_posts` + prompt。
5. `ref_collector.py`（粗筛 + 精筛 + 入库 + seen）+ 单测。
6. `routers/materials.py` + `main.py` 注册 + 单测。
7. `scheduler.py` 加作业 + `config.py` 加 `ref_categories` 默认。
8. 前端 `/materials` 页 + Sidebar。
9. 手工全链路：建规则 → 立即采集 → 库里出现分门别类的段子 → 浏览/筛选/改类。

## 11. 风险与已知未知

- **operator-only raw 查询可行性**（最大风险）：§2 假设，spike 验证。不行则退种子词。
- **X 风控**：高 `min_faves` 返回页少；每天 1 次 + 逐规则 `sleep(2)`，应安全。需有效 cookie（`feedgrab login twitter`，`/x/auth-status` 已能探活）。
- **LLM 成本/质量**：规则粗筛 + seen 去重把过模型的量压住；批量调用。段子判定准确率取决于 prompt，迭代。
- **分类漂移**：受控词表 + 兜底「其他」防止碎片化。

## 12. 明确不做（YAGNI）

- 不做候选账号池、不做账号 List 订阅（本次选定纯 Top 搜索路径）。
- 不存被拒帖子原文（只记 `RefSeen` 的 id + verdict）。
- 不做 metrics 历史曲线、二创生成。
- 不做写作链路复用（挂写作方案/草稿）——phase 2。
- v1 只接 X。
