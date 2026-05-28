# 选题库重构设计文档

**日期**: 2026-05-28  
**状态**: 待实现

---

## 背景与问题

当前选题库（`/topics`）是一个**树形文件夹系统**：主题最多三层嵌套，每个主题可挂参考线索，可从线索开草稿。但这个设计有以下问题：

1. **Topic 只是一个名字**，装不下一份完整的调研简报（research brief）
2. **树形层级**对内容策划来说过于笨重，用户实际上只需要标签来分组
3. **没有"派发"机制**，brief 写完了没有出口连接到 agent
4. **产出（草稿）不可见**，只有一个数字，无法在选题视角回顾已产出什么
5. **`/trend-topics` 和选题库完全断开**

用户期望的选题是一份**内容提案（content brief）**，描述：要研究什么主题、搜索哪些关键词、从素材中提取什么信息、建议什么叙事角度——可以直接派发给 agent 执行。

---

## 目标

将选题从"文件夹/分类"改造为"内容提案（content brief）"：

- 每个选题是一份活文档，包含 brief、参考线索、已产出草稿
- 用标签替代层级，支持多标签
- Brief 可一键派发给 Hermes agent 作为调研任务

---

## 数据模型

### ContentTopic（改动）

移除 `parent_id` 字段，新增 `brief` 字段：

```
id           int PK
title        str
brief        text   # markdown 格式调研简报（原 description 内容迁移至此）
description  text   # 保留不删，供迁移回滚
priority     int    # 1=最高 5=最低，保留
status       str    # active / archived，保留
created_at   datetime
updated_at   datetime
```

### TopicTag（新增）

```
id     int PK
name   str UNIQUE（大小写不敏感）
color  str  # hex color，前端着色用
```

### ContentTopicTag（新增关联表）

```
topic_id  int FK → content_topics
tag_id    int FK → topic_tags
PRIMARY KEY (topic_id, tag_id)
```

### TopicSource、ArticleDraft

不改动。`ArticleDraft.content_topic_id` 外键保留。

---

## 迁移策略

部署时执行一次性迁移脚本：

1. **子主题 → 标签**：对所有 `parent_id IS NOT NULL` 的子主题，以父主题 `title` 创建（或复用）同名标签，挂到该子主题；父主题本身不自动加标签
2. **description → brief**：将 `description` 内容复制到 `brief`；`description` 字段保留（不删列），以防回滚
3. **parent_id 置 NULL**：迁移完成后将所有记录的 `parent_id` 置 NULL（但保留列，待确认稳定后再删）

---

## API

### Topics

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/content-topics` | 返回平铺列表，每条带 `tags[]`、`source_count`、`draft_count`；支持 `?tags=a,b` 多标签过滤（AND 逻辑） |
| `POST` | `/content-topics` | 创建，接受 `{title, brief, tags[], priority}` |
| `GET` | `/content-topics/{id}` | 单条详情 |
| `PATCH` | `/content-topics/{id}` | 更新 `title`、`brief`、`tags[]`、`priority`、`status` |
| `DELETE` | `/content-topics/{id}` | 删除 topic、关联 sources、关联 tag 关系；草稿的 `content_topic_id` 置 null |

### 标签

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/content-topics/tags` | 列出全部标签 |
| `POST` | `/content-topics/tags` | 创建标签（name）；颜色由后端从预设色盘循环分配；同名直接返回已有 |
| `DELETE` | `/content-topics/tags/{id}` | 删除标签，解除关联，不删 topic |

### 产出

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/content-topics/{id}/drafts` | 列出关联草稿，返回 `{id, title, status, draft_type, created_at}` |

### 派发

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/content-topics/{id}/dispatch` | 以 brief 内容在 Hermes 创建 kanban task，返回 `{task_id, kanban_url}` |

Sources 端点（`/content-topics/{id}/sources`）不变。

---

## 前端 UI

### 整体布局

左右两栏：

- **左侧**（固定宽度）：标签过滤器 + 选题卡片列表
- **右侧**：选中选题的详情面板

### 左侧

- 顶部：搜索框 + "新建选题"按钮
- 标签过滤器：横排 chips，可多选，选中高亮，点 × 取消；"全部"为默认态
- 选题卡片列表，每张卡片：
  - 标题
  - 标签 chips（最多显示 3 个，超出 +N）
  - Brief 前两行预览（灰色小字，truncate）
  - 右下角：线索数 badge、草稿数 badge

### 右侧详情

**Header**：
- 标题（inline 编辑，点击进入编辑态）
- 优先级徽章（P1–P5）
- 标签多选编辑（combobox，可创建新标签）
- 归档 / 删除按钮

**三个 Tab**：

**Brief tab**：
- 全宽 markdown textarea（高度自适应，至少 12 行）
- 底部工具栏：保存按钮 + **"派发给 Agent"** 按钮
- 点击派发 → 确认弹窗：brief 内容预填（可编辑）、确认后调用 dispatch API，toast 显示"已派发"并附看板链接

**线索 tab**：
- 与现有 SourceRow 完全一致，不改

**产出 tab**：
- 列出关联草稿：标题、类型（文章/脚本）、状态（drafting/published）、创建时间
- 点击跳转 `/drafts?draft={id}`
- 空态提示"暂无产出"

---

## 错误处理

| 场景 | 处理 |
|------|------|
| 创建同名标签 | 返回已有标签，不报错 |
| 删除标签 | 解除 topic 关联，不删 topic |
| 删除 topic | 级联删除 sources 和 tag 关联；草稿的 `content_topic_id` 置 null |
| dispatch 失败（Hermes 不可用） | toast 报错，topic 本身不受影响 |

---

## 测试

**后端**：
- Tag CRUD（创建、去重、删除解关联）
- Topic 平铺列表 + 标签过滤
- `/content-topics/{id}/drafts` 端点
- `/content-topics/{id}/dispatch` 端点（mock Hermes MCP）
- 迁移脚本（子主题正确转标签，brief 正确迁移）

**前端**：
- 更新 `TopicsClient` 相关测试为新数据结构（如有）

---

## 不在本次范围内

- `/trend-topics` 与选题库的整合（独立任务）
- Chrome 插件收集线索
- Brief 模板库
