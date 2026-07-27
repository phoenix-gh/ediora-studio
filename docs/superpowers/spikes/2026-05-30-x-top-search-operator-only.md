# Spike: X Top 搜索 — operator-only raw 查询能否抓到热门

**Date:** 2026-05-30
**feedgrab:** 0.1.0（wems env）
**目的:** 验证统一参考文案库设计 (§2) 的核心押注——feedgrab 的 SearchTimeline 能否吃「无关键词、纯算子」的 raw 查询并按 Top 返回。
**结论:** ✅ **成立**。主路径确认，无需种子词退路。

## 测试

`search_twitter_keyword(keyword=<raw>, raw=True, sort="top", max_results=20, save_tweets=False, skip_summary=True)`，登录态 `backend/sessions/twitter.json`。

| # | raw 查询 | 返回 |
|---|---|---|
| A | `min_faves:1000 lang:zh -filter:replies -filter:links -filter:retweets` | **20**（满页） |
| B | `min_faves:5000 lang:zh -filter:replies -filter:links -filter:retweets since:2026-05-27` | **3** |

A 的样本（点赞 6.9k–241k，均中文）含大量真段子：
- 「世界上最恐怖的事情：❌恐怖片 ❌没对象 ✅早上起来咽口水发现嗓子疼」(241k)
- 披萨「πR² → 四个6寸=一个12寸」数学梗、医生抽烟算账梗、机场炸了观察梗…

## 关键发现

1. **operator-only raw + sort=top 可用**：无需关键词。`build_search_url` 原样编码查询，GraphQL SearchTimeline 正常返回。→ spec §2 假设成立，删掉「种子词退路」。
2. **阈值/时间窗极敏感**：`min_faves:1000`(无 since)=满页；`min_faves:5000`+近3天=仅 3 条。
   → **日采集用中等阈值（~1500）+ 不收窄 `since`，靠 seen 账本去重**；收紧时间窗会让单次产出过稀。反向印证 `RefSeen` 必要（不收窄窗口会反复命中同一批 all-time top）。
3. **杂质确凿**：返回混入 NSFW/粗口、带货、教程长贴。→「规则粗筛 + LLM 精筛」必要。
4. **白捡信号 `possibly_sensitive`**：tweet dict 含该 bool → 粗筛直接据此砍 NSFW。
5. **dict 结构吻合**：返回字段（id/text/author/author_name/created_at/likes/retweets/replies/views/images/`possibly_sensitive`/`is_blue_verified`/`lang`/`hashtags`/`quoted_tweet`…）与现有 `feedgrab_client._tweet_dict_to_parsed_post` 完全兼容，`search_top` 可直接复用解析。

## 对设计的回写

- §2：假设标记为「已验证 2026-05-30」，移除种子词退路。
- §3 `RefCollectRule`：默认 `min_faves` 降到 ~1500；新增字段 `exclude_sensitive`（默认 True）。
- §4.2 规则粗筛：加 `possibly_sensitive` 丢弃；明确「日采集不收窄 `since`，靠 seen 去重」。
- §12 风险：operator-only 风险降级为「已验证」。
