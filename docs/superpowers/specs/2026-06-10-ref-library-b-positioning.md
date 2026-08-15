# 素材库 B 定位落地 — Design Spec

**Date:** 2026-06-10
**Status:** Approved（对话中逐项确认）

## 背景

参考文案库（RefMaterial）实际收录内容已从「中文表达参考」演变为「AI 信息素材」（英文热点观点/工具实战为主，与活跃账号 MK@Phoenix 的 AI 定位对口）。决策：承认演变（定位 B），词表按信息维度重做，并打通第一条消费链路（MCP 查询工具）。

## 改动

1. **词表切换**：`config.py` DEFAULTS `ref_categories` → `产品动态,观点争论,工具实战,翻车吐槽,数据事实,行业八卦,其他`。scene_tags（opener/argument/...）保留不动——「用在文章什么位置」语义在信息库下仍成立。
2. **存量重分类**：78 条 active 的 category 清空，由 `ref_classify` 用新词表重跑（一次性运维操作 + 手动触发数把）。
3. **MCP 工具** `search_ref_materials(q, category, scene_tag, min_score=60, limit=10)`：status=active、score≥min_score，category 走 SQL，scene_tag/q 内存过滤（JSON 列跨 SQLite/PG 兼容），score 降序。返回 text(clean 优先)/score/category/scene_tags/likes/source_url/is_reply。
4. agent 侧自动生效（挂现有 web MCP server）；x-post 技能引导提示后续迭代。

## Out of Scope

派发时自动注入素材进任务 body；x-post SKILL.md 更新。
