# X 选题生成器 设计文档

**日期**：2026-05-27  
**状态**：已确认，待实现

---

## 概述

在 Ediora 新增「一键生成选题」功能：读取过去 24 小时已采集的 X 帖子，调 LLM 聚合分析，生成 10 条候选选题（区分长文 / 短文），用户勾选后一键入队到 Hermes Kanban 链路。

---

## 1. 数据层

**来源**：`x_posts` 表（`XPost` model）  
**查询条件**：`published_at >= now - 24h`，按互动量（`likes + reposts`）降序，取前 50 条作为 LLM 输入素材。  
**互动量不足时**（< 5 条）：接口返回 `warning` 字段，前端提示用户在 X 设置补充关键词，仍可继续调用（LLM 以现有数据尽力生成）。

用到的字段：`username`、`display_name`、`content`、`url`、`published_at`、`likes`、`reposts`、`replies`。

---

## 2. 后端接口

### `POST /api/topics/generate`

**Request body**：
```json
{
  "account_id": "pub_xxx",
  "sources": ["x"]
}
```

`sources` 字段为将来接入微博/知乎等平台预留，当前只处理 `"x"`。

**处理流程**：
1. 查 `x_posts` 表，拉取 24h 数据（最多 50 条）
2. 拼 prompt，调 `llm._call()`（使用系统已配置的模型，默认 mimo-v2.5）
3. 解析 LLM 返回的 JSON，构造 `TopicSuggestion` 列表
4. 返回结果；LLM JSON parse 失败时返回 HTTP 500 + 原始文本供 debug

**Response body**：
```json
{
  "warning": null,
  "topics": [
    {
      "title": "标题",
      "angle": "一句话切入角度",
      "type": "long | short",
      "source_posts": [
        { "username": "@xxx", "content": "摘要...", "url": "https://..." }
      ]
    }
  ]
}
```

**超时**：LLM 调用上限 60s（FastAPI 异步，不阻塞其他请求）。前端如 30s 无响应可提示用户重试。

---

## 3. LLM Prompt 设计

**系统 prompt**（中文）：
> 你是资深自媒体策划，擅长从社交媒体热点中提炼有价值的创作选题。

**用户 prompt** 结构：
1. 原始帖子列表（逐条：账号 + 内容 + 互动数）
2. 目标账号画像（通过 `get_account_profile(account_id)` 查库注入）
3. 要求：输出严格 JSON 数组，10 条，每条含 `title / angle / type / source_indices`。`type` 只能是 `long`（1500-3000 字深度文章）或 `short`（200-500 字 X 风格短帖）。

后端在 prompt 里明确要求 JSON-only 输出，parse 失败时 fallback 为 500 error。

---

## 4. 前端 UI

**路由**：`/topics`（新增侧边栏入口，图标：Lightbulb）

**页面布局**：
- **顶部工具栏**：账号选择下拉（`PublishAccount` 列表）+ 「生成选题」按钮（loading 期间禁用 + spinner）
- **主区域**：10 张选题卡片，grid 布局（2 列）
  - 体裁标签 badge：长文（蓝色）/ 短文（绿色）
  - 标题（加粗）
  - 切入角度（灰色副文本）
  - 折叠面板「参考帖子」（展开看原帖摘要 + 链接）
  - 右上角勾选框
- **底部操作栏**：显示「已选 N 条」 + 「入队选中项」按钮（0 条时禁用）
- **空状态**：未生成时显示引导文案；数据不足警告用 Toast 提示

---

## 5. 入队逻辑

用户点「入队选中项」后，对每条勾选的选题调用 `HermesKanbanClient.create_task()`：

```python
task = await kanban.create_task(
    title=topic["title"],
    assignee="wms_editor",   # scout 棒跳过，选题即 scout 产出
    metadata={
        "account_id": account_id,
        "angle": topic["angle"],
        "content_type": topic["type"],          # "long" | "short"
        "word_range": "1500-3000" if topic["type"] == "long" else "200-500",
        "source_posts": topic["source_posts"],
        "generated_by": "topic_generator",
    }
)
```

`long` 和 `short` 路由到同一个 `wms_editor`，通过 `content_type` + `word_range` 在 metadata 区分，editor 的 SOUL.md 读到字段后调整 brief 规格。**不需要新建 agent profile。**

入队完成后前端 Toast 提示「已入队 N 条选题」，已入队的卡片标记为「已入队」badge（灰显，不可重复入队）。

---

## 6. 文件变更清单

| 类型 | 路径 | 说明 |
|------|------|------|
| 新增 | `backend/routers/topics.py` | `POST /api/topics/generate` |
| 修改 | `backend/main.py` | 注册新 router |
| 新增 | `web/app/topics/page.tsx` | 选题生成页面（Server Component 壳） |
| 新增 | `web/app/topics/TopicsClient.tsx` | 客户端交互组件 |
| 新增 | `web/lib/api/topics.ts` | 前端 API 封装 |
| 修改 | `web/components/sidebar.tsx` | 新增 /topics 导航入口 |
| 修改 | `~/.hermes/profiles/wms_editor/SOUL.md` | 新增「读 content_type / word_range」步骤 |

---

## 7. 不在本期范围内

- 定时自动跑（cron 触发）——留作 Phase 2，后端接口已可复用
- 多平台聚合（微博/知乎）——`sources` 字段已预留，后端按 source 分支查库
- 选题历史记录 / 持久化——本期生成结果只在内存/前端状态，不落库
- wms_editor SOUL.md 对 `content_type` 的深度适配——由使用情况决定后续迭代
