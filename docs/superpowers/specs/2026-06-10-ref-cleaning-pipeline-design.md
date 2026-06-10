# 参考文案清洗管道重做 — Design Spec

**Date:** 2026-06-10
**Status:** Approved

---

## Goal

重做 `/materials` 参考文案库（RefMaterial）的清洗线。移除「LLM 一体化清洗守门」模式（`classify_ref_posts` 的 keep/score/category/text_clean），换成 last30days 式漏斗：**规则 + 本地信号守门，素材入库零 LLM 依赖**；LLM 降级为低频补分类标签。同时新增「神回复也是素材」子管道——高分爆款帖抓评论串，高赞回复经同样清洗后作为独立素材入库。

设计哲学（源自 mvanhorn/last30days-skill 源码分析）：
1. 漏斗结构，便宜的先做——规则过滤 → 本地打分 → 去重，LLM 只碰高分 shortlist
2. 每步有 fallback，管道永不断——LLM 挂了只是标签空着，素材照常入库
3. log1p 互动打分解决量纲问题，绝对刻度保证跨批可比

**范围**：第一期只处理 X（ref 线现状唯一源）。清洗/打分/去重模块设计为 source-agnostic，Reddit 等后续接入。

---

## 新管道架构

```
ref_collect 定时任务（15min，现有调度位）
  └─ collect_rule(rule)：
       feedgrab search_top（X 爆款搜索，现状保留）
         ▼ ① 规则预过滤（现有 _prefilter 保留：短文/URL/@刷屏/敏感标记）
         ▼ ② seen 去重（现有，RefSeen source_id 级）
         ▼ ③ 近重复去重【新】 text_dedupe.py
         ▼ ④ 本地信号打分【新】 ref_signals.py → score 0-100
         ▼ ⑤ 规则文本清洗【新】 → text_clean
         ▼ 直接入库 RefMaterial（status=active，不再等 LLM 判定）

comment_scout 子管道【新】 reply_scout.py（ref_collect 尾部触发）
  └─ 本批 score ≥ ref_reply_scout_threshold 的父帖（top 5）
       → fetch_tweet_detail 抓首屏回复（不翻页）
       → 同规则清洗 + likes ≥ ref_reply_min_likes → top 3
       → 作为独立 RefMaterial 入库（parent_source_id 标记父帖）

ref_classify 低频任务（60min，替代旧 ref_clean 调度位）
  └─ score ≥ ref_classify_min_score 且 category='' 且 status='active'
       → LLM 批量补 category/scene_tags（只分类；失败不影响素材可用）
```

与旧线的本质区别：旧线 LLM 不跑素材就堵在 raw 态进不了库；新线素材入库零 LLM 依赖，分类挂了顶多标签空着。

---

## 本地信号打分（ref_signals.py）

X 互动权重沿用 last30days signals.py 配方，加 views 维度：

```python
engagement_raw = (
    0.45 * log1p(likes)
    + 0.25 * log1p(reposts)      # 转发是最强传播信号
    + 0.15 * log1p(replies)
    + 0.15 * log1p(views / 100)  # views 量纲大，除 100 拉平
)
score = round(min(100, ref_score_scale * engagement_raw))
```

- **绝对对数刻度**而非 last30days 的批内 min-max：流式采集下批内归一化会让分数跨批不可比。锚点效果（scale=18.5）：1 千赞 ≈ 57、1 万赞 ≈ 76、10 万赞 ≈ 95。实现时用库内真实数据校准常数。
- `ref_score_scale` 进 config 可调。
- 神回复同公式（互动低一个量级是正确反映）。

---

## 近重复去重（text_dedupe.py）

段子被洗稿/抄袭转发是常态，同一个梗只留互动最高的一条。

```python
similarity = max(字符3gram_jaccard, 词级_jaccard)   # 阈值 0.7
```

- 中文 3-gram 无需分词即有效；词级按空白/标点粗切，主要管中英混排。不引入 jieba。
- 比对范围：批内互查 + 与库内近 14 天素材比对（prepared 文本缓存，几百条量级 O(n×m) 毫秒级）。
- 撞重保留互动分高者：新条目分更高 → 旧条目 `status='duplicate'`（不物理删除）；否则丢弃新条目。

---

## 神回复子管道（reply_scout.py）

**预算与限流（第一约束）**：
- 每轮 ref_collect 后，本批新入库且 score ≥ `ref_reply_scout_threshold`（默认 70）的父帖按分数取 top 5
- 每父帖一次 `feedgrab.fetchers.twitter_thread.fetch_tweet_detail(tweet_id, cookies)`，只取首屏回复不翻页；cookies 用 `load_twitter_cookies()` 现有模式，feedgrab 自带 cookie 轮换/限流标记
- 「已侦察」标记复用 RefSeen 账本：`platform='x_replies', source_id=父帖id`——零模型改动防重复侦察

**回复清洗（通用规则 + 回复特有三条）**：
1. 剥离开头连续 @mentions 链后再判长度（<10 字符丢）
2. likes ≥ `ref_reply_min_likes`（默认 100）才算候选
3. 按 likes 降序取 top 3 入库

**入库形态**：正常 RefMaterial 条目，`platform='x'`、`source_id=回复 tweet_id`（唯一约束天然成立），同打分/同 seen/同近重复去重/同分类队列；`parent_source_id` 列标记父帖。

**模型改动（仅此一处）**：
```sql
ALTER TABLE ref_materials ADD COLUMN parent_source_id VARCHAR;
```
（项目无迁移框架，线上 Postgres 需手动执行；SQLite dev 库由 create_all 对新库生效，已有 dev 库同样手动 ALTER。）

---

## 低频 LLM 分类（ref_classify）

- 调度：job 改名 `ref_classify`，config 新增 `ref_classify_interval_minutes`（默认 60）；旧 `ref_clean_interval_minutes` 从 DEFAULTS 移除（DB 残留无害）
- 入队：`score ≥ ref_classify_min_score（默认 60）` 且 `category=''` 且 `status='active'`，每批 `clean_batch_size`（保留，默认 20）
- LLM 输出仅 `{source_id → category, scene_tags}`；prompt 从旧版大幅缩短（剥掉 keep/score/text_clean 职责）
- 失败：记日志，category 留空下轮自然重试

---

## 移除/重写清单

| 对象 | 处置 |
|---|---|
| `llm.classify_ref_posts` + `_classify_ref_chunk` | 重写为轻量 `classify_ref_categories`（只分类）；`RefClassifyError` 保留 |
| `ref_collector.clean_batch` | 重写为 `classify_batch` |
| raw→material 二态升级逻辑（`_upsert_raw`/`_upsert_material`） | 合一：采集即产出最终条目，无中间态 |
| `POST /materials/clean-batch` 端点 | 改为手动触发分类 |
| scheduler `ref_clean` job | 改为 `ref_classify` job |
| `test_ref_classify.py` ×2、`test_ref_collector.py` ×2 既存失败测试 | 随重写消化清零 |

---

## 新增 config（DEFAULTS）

| key | 默认 | 含义 |
|---|---|---|
| `ref_score_scale` | 18.5 | 打分对数刻度系数 |
| `ref_reply_scout_threshold` | 70 | 父帖抓评论的分数线 |
| `ref_reply_min_likes` | 100 | 神回复最低赞数 |
| `ref_classify_min_score` | 60 | 进 LLM 分类队列的分数线 |
| `ref_classify_interval_minutes` | 60 | 分类任务间隔 |

---

## 新增模块

| 文件 | 职责 |
|---|---|
| `backend/text_dedupe.py` | 3-gram + 词级 Jaccard 近重复检测（纯函数） |
| `backend/ref_signals.py` | log1p 加权互动打分（纯函数） |
| `backend/reply_scout.py` | 神回复抓取/清洗/入库子管道 |

---

## UI 最小连动（MaterialsClient）

- min_score 滑块语义变为本地信号分，文案微调
- 有 `parent_source_id` 的条目显示「神回复」徽章
- 其余不动（category 筛选保留，标签逐步由低频分类填充）

---

## 测试策略

- 打分公式、去重、回复清洗规则：纯函数单测
- 采集/分类流程：mock feedgrab + mock LLM，沿用现有 fixture 风格
- 既存 4 个失败测试随重写消化

---

## Out of Scope

- Reddit / 其他源接入新清洗线（接口预留）
- 写稿派发时的评论富化（另一条线，未来复用 reply_scout 的抓取/清洗函数）
- /materials 评论预览 UI
- 跨源统一 SourceItem schema 与选题生成漏斗（last30days 完整形态的路线图项）
