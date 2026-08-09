# GitHub 日榜榜单图 Skill 实现计划

## 约束

- 工作区已有用户改动；只修改本计划列出的文件，不 reset、checkout、删除或提交。
- 使用现有 `github_trending` 表、MCP、standalone image job 和 Creative Assets，不引入新的采集器或周榜逻辑。
- 先写回归测试并确认 RED，再实现生产代码，最后运行 focused GREEN 和相关回归。

## 步骤

### 1. RED 契约测试

新增或扩展：

- `backend/tests/test_temporary_asset_directory.py`：测试“临时文件”系统目录幂等创建和同名普通目录升级。
- `backend/tests/test_mcp_github_trending_tools.py`：种入两天 daily 数据和一条 weekly 数据，验证 MCP 只读出最新 daily、排名变化和 NEW，并暴露严格无参数 schema。
- `backend/tests/test_asset_directories_router.py`：验证媒体上传可按目录归档、未知目录被拒绝；保留旧上传调用兼容性。
- `wemedia-studio/lib/skills/bundled-skills.test.ts`：验证 `github-trending-chart` 默认发现、启用、无额外引用，并包含日榜/简介/推荐/工具/目录约束。
- `wemedia-studio/lib/ai/global-chat-tools.test.ts`：验证图片输入 schema 接受严格的 `title`/`directory`，创建任务请求会传递这两个字段且仍拒绝未知字段。

运行后端测试使用 `/home/violet/miniconda3/envs/wems/bin/python`；前端测试使用项目现有 pnpm/Vitest 命令。记录环境导致的 fixture 阻塞，不把阻塞当作通过。

### 2. 媒体系统目录和上传归档

- 新增 `backend/temporary_asset_directory.py`，提供 `ensure_temporary_asset_directory`。
- 在 `backend/main.py` 启动初始化中调用并提交。
- 在 `backend/routers/assets.py` 的上传接口增加 `directory` 查询参数，校验其为现有媒体目录后写入资产。
- 必要时补充上传路由测试；不改动现有多媒体目录 UI，因为它已经能识别 `is_system` 并隐藏目录操作。

### 3. GitHub 日榜 MCP 工具

- 在 `backend/mcp_server.py` 增加 `get_github_daily_trending()`。
- 查询最新 daily 日期和上一日期，按 `position` 返回原始项目字段、排名变化和新进标记。
- 工具不接收 period/URL 等自由参数，固定日榜来源；无数据时返回明确的空结果结构。

### 4. 图片任务目录传递

- 在 `wemedia-studio/lib/ai/global-chat-tools.ts` 扩展图片输入 schema 和 `createImageJob` 参数，保留 strict schema。
- 在 `wemedia-studio/lib/ai/content-job.ts` 读取任务输入中的目录，并将其作为 upload query 参数传给资产 API。
- 保持默认标题/未指定目录的兼容行为，更新对应测试。

### 5. 默认 Skill

- 按 skill-creator 规范运行 `init_skill.py github-trending-chart --path wemedia-studio/skills/github-trending-chart`，然后清理模板中的无关占位文件。
- 用 `wemedia-studio/skills/github-trending-chart/SKILL.md` 写入已确认的 Agent 工作流、图构图、事实边界、工具参数与资产归档要求。
- Skill 使用自动发现，不增加手工注册表；遵循 skill-creator 的标准 frontmatter。

### 6. 验证

- 运行新后端测试、资产目录/上传/MCP 相关回归。
- 运行 bundled Skills、global chat tools 和内容任务相关 Vitest。
- 运行 `quick_validate.py` 或项目对应 Skill 校验脚本，确认 frontmatter 和目录结构合法。
- 检查 git diff 只包含本功能文件与明确的现有测试扩展，报告任何未能执行的验证。
