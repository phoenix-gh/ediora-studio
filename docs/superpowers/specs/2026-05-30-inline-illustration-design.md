# 长文正文配图（inline illustration）设计

日期:2026-05-30
状态:已确认设计,待写实现计划

## 背景与动机

现有创作链路 `editor → writer → illustrator` 中,illustrator 只出**封面**(挂进 DraftImage 图库,不进正文)。用户希望长文能**在正文里插入配图**:agent 分析文章章节 → 判断需要几张 → 按风格生成 → 上传 → 插入正文对应位置。

所有底层能力已具备,本期只新增「正文配图」的编排步骤 + 一个幂等标记约定:

| 步骤 | 现成能力 |
|------|---------|
| 读正文分析章节 | `get_draft(draft_id)` → 完整 Markdown |
| 生成插图 | illustrator 已在用的 `baoyu-cover-image` 技能(codex_imagegen 后端) |
| 上传 | `upload_image_from_path(path, draft_id)` → url + 自动登记 DraftImage 图库 |
| 插入正文 | `update_draft(draft_id, content=...)` 覆盖正文 |

## 决策(已与用户确认)

- **触发形态 = 草稿箱按需单棒(B)**:不进自动链路。用户在草稿箱对某篇手动触发,复刻现有 `cover_only` / `rewrite_only` 的手动单棒流程。长文短文由用户自行决定要不要点,不做自动门槛。
- **数量/位置 = 用户给护栏,agent 范围内决定(B)**:触发时给 `max_images`(默认 4),agent 按章节内容决定实际几张、插哪。位置在**小节(H2/段落)边界**,不打断句子中间。
- **重跑 = 先清后插,幂等(A)**:系统插入的图用注释壳标记,重跑先剥旧块再重配。手写图 / 封面不受影响;图库旧记录不动。

## 架构总览

```
草稿箱「自动配图」按钮
   │  POST /studio/illustrate-body {draft_id, account_id, max_images, note?, image_style?}
   ▼
studio 端点
   1. strip_inline_illus(draft.content) → 剥掉所有 <!-- wms-illus --> 旧块
   2. update_draft 存回干净正文           ← 幂等的关键，服务端做、不靠 agent
   3. resolve_effective_design 取 image_style（账号 ← 方案 ← 本次覆盖）
   4. 建单棒 kanban 任务(assignee=wms_illustrator, flow=illustrate_body)
   ▼
wms_illustrator agent（单棒）
   get_draft → 分析 H2 小节 → 挑 ≤max_images 个边界点
     → 每点：baoyu-cover-image 生成内容插图 → upload_image_from_path 拿 url
     → 组装新正文（每图裹 wms-illus 注释壳）→ 一次 update_draft → kanban_complete
```

## 详细设计

### ① 幂等标记约定

系统自动插入的每张图,在 Markdown 里裹一层 HTML 注释壳:

```markdown
<!-- wms-illus -->
![<alt 文本>](<url>)
<!-- /wms-illus -->
```

- 手写图、封面**无此标记**,永不被清理。
- `alt` 由 agent 按该小节主题填(便于无障碍 + 失图时可读)。

### ② `strip_inline_illus` 纯函数

新增纯函数(放 `backend/pipeline_template.py`,与其它渲染/解析纯函数同源,便于单测):

```python
def strip_inline_illus(md: str) -> str:
    """剥掉所有 <!-- wms-illus -->...<!-- /wms-illus --> 块（含包裹的图片与前后多余空行），
    返回干净正文。无标记时原样返回。"""
```

- 正则 `<!-- wms-illus -->.*?<!-- /wms-illus -->`(DOTALL,非贪婪)。
- 清理后把残留的 3+ 连续空行折叠为 2 行(沿用 `_normalize_material` 的 `\n{3,}` 处理风格)。

### ③ 端点 `POST /studio/illustrate-body`

镜像现有 `/studio/regenerate-cover`(`backend/routers/studio.py`)。

请求模型 `IllustrateBodyIn`:

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `draft_id` | int | — | 目标草稿 |
| `account_id` | str | — | 决定继承哪套 image_style |
| `max_images` | int | 4 | 护栏上限 |
| `note` | str? | None | 本次额外指令(给 agent) |
| `image_style` | str? | None | 本次临时覆盖插图风格 |

端点逻辑(顺序即幂等保证):
1. 取 draft;`update_draft` 存 `strip_inline_illus(draft.content)`(先清)。
2. 解析有效 `image_style`:`resolve_effective_design(account.cover_style, account.image_style, plan.cover_style, plan.image_style, None, payload.image_style)` 取返回的 image 部分;`plan` 经 `draft.writing_plan_id` 取(可空)。仅用 image_style,封面 cover_style 不参与正文配图。
3. 建单棒任务:`get_pipeline("illustrate_body")`,渲染 ctx(`draft_id` / `account_id` / `image_style` / `max_images` / `note`),走与 `regenerate-cover` 相同的派发机制。
4. 返回 `{task_id}`。

### ④ pipeline `illustrate_body`(单棒)

`backend/pipeline_template.py` 新增 `INLINE_ILLUS_PIPELINE`(单个 `wms_illustrator` step),注册进 `PIPELINES["illustrate_body"]`。body 要点:
- 读 `get_draft(draft_id)`(服务端已清干净)。
- 分析 H2 小节 / 段落结构,在**小节边界**挑 ≤ `max_images` 个插图点;短小节可不配;不打断句子。
- 每点:按 `image_style` + 该小节主题调 `baoyu-cover-image` 生成**内容插图**——**不套 cover_style 模板、不放标题文字、aspect_ratio 默认 16:9**,以内容相关性为先(参考现有 `TOPIC_SHORT` illustrator「宽松、贴内容」的措辞)。
- `upload_image_from_path(path, filename_hint='illus.png', draft_id)` 拿 url。
- 组装新正文:每张图按 §① 注释壳插入选定边界。
- **一次** `update_draft(draft_id, content=新正文)`。
- 失败:单张生成失败 → 跳过该点继续;全失败 → `kanban_block(reason=...)`。
- 完成:`kanban_complete(summary='正文配图 N 张', metadata={"draft_id":..., "image_count":N})`。

### ⑤ 前端

草稿箱「重画封面」动作旁新增「自动配图」:小弹窗(账号选择 + `max_images` 数字,默认 4 + 可选 note)→ 调 `/studio/illustrate-body` → toast 带看板链接。复用 `lib/api/studio.ts` 既有 `regenerateCover` 同款封装新增 `illustrateBody()`。

## 范围之外(本期不做)

- 自动链路内配图(A 档,改 dispatch 让长文自动加配图棒)。
- 插图位置的可视化拖拽 / 手动调整。
- 图库孤儿清理(重跑只保正文干净,被剥除图的 DraftImage 记录暂留)。
- 短文门槛判断(手动触发,用户自决)。

## 测试要点

- `strip_inline_illus`:纯函数单测——单块 / 多块 / 块前后空行折叠 / 无标记原样 / 与手写 `![]()` 共存(只剥带标记的)/ 嵌套或畸形标记的稳健性。
- 端点:先 `strip` 再 `update_draft` 再派发的顺序;`max_images` 进 task body;`image_style` 合并取值正确(账号/方案/本次覆盖);`draft.writing_plan_id` 为空时回退账号。
- pipeline:`get_pipeline("illustrate_body")` 返回单棒、assignee=`wms_illustrator`;ctx 渲染含 `max_images` / `image_style` / wms-illus 壳约定。
