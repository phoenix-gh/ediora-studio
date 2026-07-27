# 设计：候选池补公众号源（P1）

日期：2026-06-14
状态：设计已确认，待写实现计划
关联：闭环审计 `docs/superpowers/specs/2026-06-14-cleanup-and-creation-loop-audit.md`（P1：候选池盲区——公众号在采却没进选题池）

## 背景与目标

`get_topic_candidates`（每日计划总编的统一候选池）覆盖 x / github_release / paper / kr / juejin / v2ex / reddit / producthunt / youtube / writing_plan，唯独漏了**公众号**：竞品公众号文章一直在采（`WechatArticle` 表），却从不进选题池。竞品「今天写了啥」是很强的选题信号。

**目标**：把近 24h 的 `WechatArticle` 作为一个候选源 `wechat` 加进 `get_topic_candidates`，让总编选题时能看到竞品最新文章。

**成功标准**：默认调用 `get_topic_candidates()`（总编用法）时，返回结果含 `source="wechat"` 的近 24h 公众号文章。

## 非目标

- 跨稿去重——已由 `daily_planner._recent_titles_md`（近 7 天 DailyPlanItem + ArticleDraft 标题 → 总编 prompt「禁止重复选题」）覆盖，本次不动。
- 公众号互动指标（阅读量）——采集器拿不到，不造；`heat` 记 0。
- 前端 / 模型 / 迁移：无改动。

## 改动

仅 `backend/mcp_server.py` 的 `get_topic_candidates`：

1. 函数内 `from models import (...)` 追加 `WechatArticle`。
2. docstring 的 source 列表加 `wechat`。
3. 在 `youtube` 源块之后、`writing_plan` 源块之前，插入：

```python
        if _on("wechat"):
            rows = (await db.execute(
                select(WechatArticle).where(WechatArticle.published_at >= since)
                .order_by(desc(WechatArticle.published_at)).limit(lim)
            )).scalars().all()
            out += [_c("wechat", f"[{a.account_name}] {a.title}", a.digest, a.url, 0, a.published_at)
                    for a in rows]
```

**要点**：
- 与现有源同构（`_c(source, title, summary, url, heat, published_at)`、`since = now-24h`、`lim`）。
- `WechatArticle` 无互动列 → `heat=0`，按 `published_at` 倒序（取近 24h 最新）。标题 `[账号名] 标题`（仿 youtube 源的 `[频道名]` 前缀），summary 用 `digest`。
- 受 `_on`/`want` 既有逻辑控制：总编默认不传 `sources` → 自动纳入 wechat；传子集时按需。

## 数据流

竞品公众号采集（现有 wechat_collector）→ `WechatArticle` → `get_topic_candidates(wechat)` → 每日计划总编选题参考。无新表、无新接口。

## 错误处理

沿用函数现有结构：单源查询在 `async with SessionLocal()` 内；空表自然产出空列表，不报错。

## 测试

`backend/tests/test_mcp_daily_plan_tools.py`（复用 `env`/`_seed`/`_run`/`_now`）：
- seed 一条近 24h `WechatArticle`（account_name/title/digest/url/published_at）→ `get_topic_candidates()` 结果里有一条 `source=="wechat"`，`title` 以 `[账号名]` 开头，`heat==0`，且 6 字段结构 `{source,title,summary,url,heat,published_at}`。
- seed 一条 `published_at = now-48h` 的 → `get_topic_candidates(sources=["wechat"])` 返回 `[]`（24h 窗口排除）。

## 影响的文件

- 修改：`backend/mcp_server.py`（import + 源块 + docstring）
- 修改：`backend/tests/test_mcp_daily_plan_tools.py`（+2 测试）
