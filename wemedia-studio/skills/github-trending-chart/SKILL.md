---
name: github-trending-chart
description: "Use when the user asks for the current GitHub daily Trending ranking, a GitHub daily leaderboard, or a flashy ranking infographic that must include project introductions and short recommendation notes."
---

# GitHub Daily Trending Chart

把系统已经采集的 GitHub 当日榜整理成一张包含项目简介和推荐语的专业榜单图，并保存到多媒体资产的“临时文件”目录。

## 固定工作流

1. 首先调用无参数工具 `get_github_daily_trending`。只使用工具返回的最新 `period=daily` 快照；禁止调用 weekly、网页搜索或沿用旧图里的示例项目。
2. 默认处理排名前 10 个项目。保留每项的 `rank`、`full_name`、`url`、`description`、`language`、`stars`、`stars_gained`、`forks`、`previous_rank`、`rank_delta` 和 `is_new`。
3. 在调用生图工具前，为每个项目先整理两个短字段：
   - `project_intro`：根据项目名和 `description` 说明它解决什么问题；不要添加工具没有提供的功能、用户、公司、性能或案例事实。
   - `recommendation`：一句简短的编辑判断，解释为什么今天值得关注；使用“值得关注/适合留意/建议观察”等判断措辞，不把推测写成项目事实。
4. 只有在数据已经整理完成后调用一次 `generateImage`。参数必须符合以下约束：
   - `title`：`GitHub 日榜 YYYY-MM-DD`，日期使用工具的 `trending_date`。
   - `directory`：严格填写 `临时文件`。
   - `prompt`：包含真实榜单数据、每项的 `project_intro` 和 `recommendation`，以及下面的构图规则。
5. 生成成功后返回日榜日期、图片任务 ID/状态，并说明图片已保存到多媒体资产 `临时文件`。不要自动创建草稿或发布。

## 图像提示词必须包含的构图

要求图像模型制作 4:5 竖版、深色科技感、专业高端的信息图；日期是唯一的时间信息，不显示周榜或 weekly。

- Top 1 放在中心王座，使用金色/绿色，视觉权重最高。
- Top 2 放在左侧，使用银色/青色盾牌。
- Top 3 放在右侧，使用铜色/紫色晶体。
- Top 4-10 放在下半区双列卡片。
- 每张卡必须显示项目名、极短 `project_intro`、极短 `recommendation`，并尽量显示 Stars、今日增长和语言。
- `is_new=true` 时显示 `NEW`；有 `previous_rank` 时显示上升/下降名次；没有上一日快照时不要虚构 NEW 或排名变化。
- 底部可以显示日榜摘要、新进数量和 Top 语言；只使用工具返回的指标。
- 文案尽量短，优先保证项目名、简介和推荐语可见；不得出现占位符、示例仓库、虚构数字或“本周/周榜”。

## 事实边界

- `description` 是项目原始简介；`project_intro` 是基于它的压缩改写，不是新的事实来源。
- `recommendation` 必须是明确的编辑判断，可以参考排名、Stars 增长、语言和简介，但不能声称项目已经流行、盈利、稳定、安全或经过实测，除非工具数据直接支持。
- 没有 daily 数据时不要生成图片，直接说明系统暂无可用日榜。
- 不要为了填满版面编造项目介绍、排名变化、增长数字或时间。
