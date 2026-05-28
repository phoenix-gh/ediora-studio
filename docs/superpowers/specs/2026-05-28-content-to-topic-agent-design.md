# Content-to-Topic Agent 设计文档

**日期**：2026-05-28  
**状态**：已确认，待实现

---

## 概述

用户提供一篇文章的 URL 或粘贴正文，点击"派发给 Scout"后，创建一个 Hermes Kanban 任务交给 `wms_scout` 处理。Scout 读取文章，搜索已有选题库，判断相似度：有相似且有新角度 → 更新选题并记录变更；有相似但无新内容 → 跳过并记录原因；无匹配 → 新建选题。变更历史可在选题库 UI 的"更新历史" Tab 查看。

---

## 1. 数据层

### 新表 `topic_updates`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | INTEGER PK autoincrement | |
| `topic_id` | INTEGER FK → content_topics.id (CASCADE DELETE) | |
| `source_url` | TEXT | 文章来源 URL（可空，粘贴文本时为空） |
| `description` | TEXT | Agent 生成的变更说明（含跳过原因） |
| `created_at` | DATETIME | |

### 新 API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/content-topics/analyze` | 接受 `{url?, content?}`，派 kanban 任务给 scout，返回 `{task_id, kanban_url}` |
| `GET` | `/content-topics/search?q=keyword` | 关键词全文检索 title+brief，供 MCP 工具调用，返回前 10 条匹配 |
| `GET` | `/content-topics/{id}/updates` | 返回该选题的更新历史列表（按 created_at 降序） |

Dispatch 给 scout 的任务 body 格式：

```
## 任务类型
content-to-topic

## 输入
URL: <url>（或）内容: <粘贴的文本>

## 指令
1. 读取文章，提取 3-5 个主题关键词
2. 调 search_topics_by_keywords 检索候选选题
3. LLM 判断相似度：
   - 相似且有新角度 → update_content_topic + add_topic_update（记录新增了什么）
   - 相似但无新内容 → add_topic_update（记录跳过原因）
   - 无匹配 → create_content_topic + add_topic_update（记录新建原因）
```

---

## 2. MCP 工具层

### 更新现有工具

| 工具 | 变更 |
|------|------|
| `list_content_topics` | 返回 `brief`（替换 `description`），加 `tags` 列表，去掉 `parent_id` |
| `get_content_topic` | 同上，加 `tags` 和 `updates` 历史列表 |
| `create_content_topic` | 参数改为 `title, brief, tags[]`，去掉 `description/parent_id` |

### 新增工具

**`search_topics_by_keywords(keywords: list[str]) -> list[dict]`**  
对 `content_topics.title + brief` 做 SQLite LIKE OR 匹配，返回前 10 条（包含 `id, title, brief前200字, tags`）。

**`update_content_topic(topic_id: int, brief?: str, tags?: list[str], title?: str) -> dict`**  
PATCH 选题字段，tags 传入时全量替换。

**`add_topic_update(topic_id: int, description: str, source_url?: str) -> dict`**  
向 `topic_updates` 插一条变更记录。

### Scout 工作流调用顺序

```
search_topics_by_keywords(keywords)
  → 候选列表
  → LLM 判断
      ├─ 有相似 + 有新内容 → update_content_topic + add_topic_update(description="新增角度：...")
      ├─ 有相似 + 无新内容 → add_topic_update(description="无新增角度，跳过：...")
      └─ 无匹配 → create_content_topic + add_topic_update(description="新建，原因：...")
```

---

## 3. UI 变更

### 选题库页面：新增"分析文章"入口

顶部操作栏加"分析文章"按钮，点击展开 Sheet/Dialog：
- Tab 切换：**URL** / **粘贴文本**
- URL 模式：单行 input
- 文本模式：多行 textarea（min 4 行）
- "派发给 Scout"按钮 → 调 `POST /content-topics/analyze` → 成功后 toast + 看板链接

### 选题详情面板：新增"更新历史" Tab

Brief / 线索 / 产出 后加第四个 Tab **更新历史**：
- 切换时调 `GET /content-topics/{id}/updates`
- 每条：日期 + description + source_url（可点击）
- 空状态："暂无更新记录"

---

## 4. Scout Agent 配置

在 `/home/violet/.hermes/profiles/wms_scout/SOUL.md` 补充"选题管理"能力段落，说明 `content-to-topic` 任务的处理流程和可用 MCP 工具。
