# GitHub 日榜榜单图 Skill 设计

## 目标

把系统已经采集的 GitHub 当日 Trending 数据，交给 Agent 自动整理成一张可读、可分享的榜单图，并将生成图片保存到多媒体资产的系统目录“临时文件”。Skill 默认启用，Agent 根据用户上下文自动选择，不增加手工流程。

## 边界

- 只使用数据库中最新的 `period=daily` 快照；不读取或生成 weekly 数据。
- 不使用网页搜索补齐榜单事实；项目事实只来自 `github_trending` 表。
- 不自动创建草稿、发布内容或写入创作资产文章目录。
- 图片是独立的多媒体资产，标题包含榜单日期，目录固定为“临时文件”。

## Agent 工作流

1. 调用无参数的 `get_github_daily_trending`，取得最新日榜和可用的上一日排名。
2. 选择前 10 个项目，保留 `rank`、项目名、链接、原始描述、语言、Stars、今日增长、Forks、排名变化和新进标记。
3. 为每个项目整理两段短文：
   - `project_intro`：只基于原始描述和项目名，说明它解决什么问题。
   - `recommendation`：明确是编辑判断，说明为什么值得关注；不得把推测写成项目事实。
4. 组装一份包含真实数据的单次生图提示词，调用 `generateImage`，参数必须包含：
   - `title`: `GitHub 日榜 YYYY-MM-DD`
   - `directory`: `临时文件`
5. 向用户返回日榜日期、图片任务 ID 和资产归档位置。

## 图像构图

- 4:5 竖版、深色科技感、专业高端信息图；日期是唯一的时间信息。
- Top 1 位于中心王座，金色/绿色主色，视觉权重最高。
- Top 2 位于左侧，银色/青色盾牌形象。
- Top 3 位于右侧，铜色/紫色晶体形象。
- Top 4-10 位于下半区双列卡片，每张卡必须有项目名、极短项目简介、极短推荐语，以及 Stars/今日增长/语言等精简指标。
- 新进项目显示 `NEW`；有上一日数据时显示排名上升/下降，缺少上一日快照时不虚构变化。
- 底部保留“日榜摘要”区域，可展示新进数量和 Top 语言；不出现 weekly、周榜或未提供的指标。
- 控制文字长度，优先保证项目名、简介和推荐语可见；禁止把占位符或示例仓库混入真实图。

## 数据与存储契约

### MCP

新增 `get_github_daily_trending()` 只读工具，返回最新 `daily` 日期、上一可用日期及按排名排序的项目原始字段。工具无自由参数，避免 Agent 误传 weekly 或任意查询条件。

### 资产上传

`POST /api/assets/upload` 增加可选 `directory` 查询参数。指定目录时必须存在且为 `asset_type=media`；生成的 `CreativeAsset.directory` 写入该目录名称。已有调用不传该参数时行为不变。

### 系统目录

增加媒体系统目录：

- 名称：`临时文件`
- `system_key`：`temporary_files`
- `asset_type`：`media`

应用启动时幂等创建；已有同名媒体目录会升级为系统目录。系统目录继续由现有目录 API 禁止重命名和删除，并由现有多媒体资产 UI 显示锁定状态。

### 图片任务

`generateImage` 保持异步独立任务模型，新增可选 `title` 与 `directory` 字段。Agent 传入目录后，standalone image worker 将其带到资产上传接口，避免生成图片落到未分类区。

## 验收标准

- 默认 Skill 能被 `listSkills`、`discoverSkills` 发现并处于启用状态。
- Skill 说明中明确日榜、项目简介、推荐语、`get_github_daily_trending`、`generateImage` 和“临时文件”要求。
- 生图任务请求可以携带标题和目录，并最终把 `CreativeAsset.directory` 写为“临时文件”。
- `get_github_daily_trending` 不返回 weekly 数据，且在有上一日快照时正确计算排名变化和 NEW。
- “临时文件”可在多媒体资产目录列表中看到，系统目录不可重命名/删除。
