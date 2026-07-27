# 移除热点选题功能设计

## 目标

从当前产品运行时完整移除“热点选题”功能，包括页面、导航、接口、缓存数据和与 X 待响应的转换入口，同时保留独立的“今日计划”能力。

## 删除范围

### 前端

- 删除 `/trend-topics` 页面、客户端组件、转换结果合并逻辑及其测试。
- 删除 `lib/api/topic-generator.ts`。
- 从侧边栏移除“热点选题”入口及不再使用的图标导入。
- 从 X 待响应移除“转为选题”操作、API 客户端方法、`converted` 状态类型和对应展示文案。
- 更新 README 中的现有功能列表。

### 后端

- 删除 `routers/topic_generator.py`，并从 `main.py` 移除导入和路由注册。
- 删除 `TopicGeneratorCache` ORM 模型。
- 删除 `POST /api/x/responses/{id}/convert-to-topic`。
- 将“今日计划”使用的内容类型标签和字数范围常量移入 `routers/daily_plan.py`，避免保留对已删除路由的依赖。

### 数据迁移

在 `database.py` 中增加幂等清理函数，并在 `init_db()` 创建当前模型表之前执行：

1. 若 `x_response_decisions` 表存在，将 `workflow_status = 'converted'` 更新为 `used`。
2. 删除 `topic_generator_cache` 表及其中缓存数据。

清理同时支持 SQLite 和 PostgreSQL。迁移可重复执行，不因目标表不存在而失败。

## 保留范围

- 保留“今日计划”、每日计划条目和创作任务入队链路。
- 保留 X 待响应的“已采用”和“已忽略”反馈。
- 保留历史 Git 记录以及 `docs/superpowers/specs`、`docs/superpowers/plans` 中的既有设计文档；它们不代表当前运行时能力。
- 不删除由热点选题曾经创建的 `PipelineTask` 或内容任务，因为它们已进入通用创作任务历史。

## 错误与兼容行为

- 删除后访问 `/api/topic-generator/*` 返回 404。
- 删除后 `/trend-topics` 不再由 Next.js 构建，不提供兼容重定向。
- 历史 `converted` 记录在迁移后作为“已采用”继续出现在 X 待响应的全部记录中。
- 数据清理仅删除可重新生成的热点选题缓存，不删除创作成果或发布记录。

## 测试与验收

- 数据迁移测试：SQLite 旧表中的 `converted` 被改为 `used`，`topic_generator_cache` 被删除，并验证重复执行安全。
- 后端路由测试：转换接口不再存在；X 响应反馈只接受 `used` 和 `ignored`。
- 每日计划测试：入队仍能生成内容类型标签和字数范围，且不导入 `routers.topic_generator`。
- 前端测试：侧边栏不包含“热点选题”，X 待响应不包含“转为选题”。
- 静态扫描：运行时代码与 README 中不再出现 `topic-generator`、`trend-topics`、`TopicGeneratorCache` 或“转为选题”。
- 完整验证：后端测试、前端测试、TypeScript 检查和生产构建全部通过。
