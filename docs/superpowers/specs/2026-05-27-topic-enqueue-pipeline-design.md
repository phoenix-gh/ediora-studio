# 热点选题入队完整工作流设计

**日期**: 2026-05-27  
**状态**: 待实现

## 问题

`/topic-generator/enqueue` 目前对每条选题只创建一个孤立的 `wms_editor` 任务，没有父子链，没有 PipelineTask 记录，writer/illustrator 不会被自动触发。

## 目标

选中选题并入队后，按体裁自动建立完整的 Hermes kanban 任务链，与 `/studio/enqueue` 的行为对齐。

## 链路设计

| type | 链路 |
|------|------|
| `long` | editor → writer → illustrator |
| `short` | writer（单棒交付） |
| `story` | writer（单棒交付） |
| `share` | writer（单棒交付） |

账号必选。无账号则前端锁定入队按钮，后端返回 400。

---

## Section 1 — pipeline_template.py

### 新增 `TOPIC_LONG_PIPELINE`

三棒：editor → writer → illustrator

**editor step body**（与 FULL_PIPELINE 的差异）：
- 无「用户提交的原始素材」块
- 改为「热点选题来源」块：列出 source_posts（X 帖子：用户名、内容摘要、链接）
- 明确指令：「角度已由 AI 给定（见下），你的职责是扩充具体锚点，网搜补充细节，然后按标准格式出 brief」
- `content_type`/`word_range` 作为约束注入（覆盖账号默认 word_range）
- 角度字段 `angle`、体裁 `content_type_label`（长文/短文/微故事/发现）显式列出

**writer / illustrator steps**：与现有 FULL_PIPELINE 完全一致，继承 editor `brief_md` / `core_point`。

### 新增 `TOPIC_SHORT_PIPELINE`

单棒：writer

**writer step body**：
- 账号写作约束（`render_profile_writer`，同 FULL_PIPELINE）
- 体裁要求（按 type 渲染）：
  - `story`：只写 5-6 句话，真实生活瞬间，有细节有情绪
  - `share`：只写 3-5 句话 + 一句「为什么值得关注」
  - `short`：200-500 字，X 风格，一个核心观点，语气犀利
- 直接给出 `angle`（跳过 editor brief）
- source_posts 作为参考（可选查原链接）
- 完成工作流：`save_draft(title, content, topic_id='agent', status='drafting', pipeline_task_id=...)` → `kanban_complete(summary='...', metadata={draft_id, wordcount})`

### Pipeline 注册

```python
PIPELINES: dict[str, list[PipelineStep]] = {
    "full": FULL_PIPELINE,
    "cover_only": COVER_ONLY_PIPELINE,
    "rewrite_only": REWRITE_ONLY_PIPELINE,
    "topic_long": TOPIC_LONG_PIPELINE,    # 新增
    "topic_short": TOPIC_SHORT_PIPELINE,  # 新增
}
```

### 新 RenderCtx 字段（topic-origin 专用）

```python
ctx = {
    "title": topic.title,
    "account_id": account_id,
    "account_profile": account_profile,   # 完整画像 dict
    "content_type": topic.type,           # long/short/story/share
    "content_type_label": ...,            # 长文/短文/微故事/发现
    "word_range": word_range,             # 从 type 派生
    "angle": topic.angle,
    "source_posts": topic.source_posts,   # list[SourcePost]
    "pipeline_task_id": pt.id,
}
```

---

## Section 2 — backend/routers/topic_generator.py

### EnqueueRequest

```python
class EnqueueRequest(BaseModel):
    account_id: str            # 必填，空字符串返回 400
    topics: list[TopicSuggestion]
```

### EnqueueResponse

```python
class EnqueueResponse(BaseModel):
    enqueued: int
    task_ids: list[str]              # 每条选题的首棒 kanban task ID（兼容现有前端）
    pipeline_task_ids: list[int]     # 每条选题的 PipelineTask.id（新增，供前端跳转）
```

### 新入队逻辑（每条选题循环）

```
1. 校验 account_id 非空，加载 PublishAccount（404 → 400）
2. 按 topic.type 选链路：
     long  → get_pipeline("topic_long")
     其余  → get_pipeline("topic_short")
3. 创建 PipelineTask(account_id, title, source_url='', task_ids={})
4. 渲染 ctx（含 pipeline_task_id=pt.id）
5. 循环 steps：_kanban_create(title, assignee, body, parent=prev_tid)
6. 回写 task_ids_map 到 PipelineTask
7. 收集首棒 task_id 和 pipeline_task_id 到 response
```

直接使用 `HermesKanbanClient.create_task`（已封装 board env，无需额外处理）。

---

## Section 3 — 前端 TopicGeneratorClient.tsx

### 入队按钮锁定条件

```
disabled={selectedCount === 0 || enqueueing || accountId === '__none__'}
```

未选账号时按钮旁显示 tooltip 或 inline hint："请先选择账号再入队"。

### 入队成功 toast

```
已入队 N 条选题 · [查看看板 →]
```

"查看看板 →" 是指向 `/studio` 的链接，使用 sonner 的 `toast.success(message, { action: { label, onClick } })` 形式。

### EnqueueRequest 类型更新

`account_id` 从 `string | null` 改为 `string`（账号已必选）。

---

## 文件变更列表

| 文件 | 变更 |
|------|------|
| `backend/pipeline_template.py` | 新增 `TOPIC_LONG_PIPELINE`、`TOPIC_SHORT_PIPELINE`，注册到 `PIPELINES` |
| `backend/routers/topic_generator.py` | `EnqueueRequest.account_id` 必填，入队逻辑改用完整 pipeline 链，`EnqueueResponse` 增加 `pipeline_task_ids` |
| `wemedia-studio/lib/api/topic-generator.ts` | `EnqueueRequest` 类型更新，`EnqueueResponse` 增加 `pipeline_task_ids` |
| `wemedia-studio/app/trend-topics/TopicGeneratorClient.tsx` | 入队按钮增加账号校验，成功 toast 增加「查看看板」跳转 |

---

## 不在本次范围内

- 前端展示每条选题的 pipeline 进度（kanban task 状态轮询）
- topic-origin 任务在 `/studio` 看板的特殊标识
- `short` 类型是否需要 illustrator（当前决策：不需要）
