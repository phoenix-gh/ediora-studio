# 写作方案 → 创作目标与流程 设计

日期:2026-05-30
状态:已确认设计,待写实现计划

## 背景与动机

`WritingPlan`(写作方案)目前是「形态无关」的容器:只有 `title / brief / sources / tags / priority / status`,不携带「这篇写成长文还是短文」「封面/插图怎么统一」的信息。真正带形态的是产物层 `ArticleDraft.draft_type`(`article | script`)。

用户的实际诉求:

1. **写作方案是一套长期复用的策略** —— 一种选题视角 + 数据采集方式的容器(此为现状描述,非本期新建能力)。
2. **同一方案对封面/插图有一致性要求** —— 方案级的设计要求应当**覆盖账号默认**。
3. **发给 agent 处理前要先拍板「这次任务的最终目标」** —— 长/短、目标账号、产物类型、切入角度、本次设计覆盖。

结论:把「形态决策 + 设计覆盖」从产物层上提。形态(长/短)是**每次发起任务时拍板的目标**,不是方案固有属性;设计一致性(封面/插图)是**方案级**的、可覆盖账号默认的属性。

## 关键决策(已与用户确认)

- **方案 ↔ 长短文 = 一对多**:方案是容器,长/短是每次 dispatch 才决定的目标。一个方案可派生多种形态产物。
- **长短文 = 同一条链换参数(非不同链路)**:pipeline 形状不变,仍是 `scout → editor → writer → illustrator`,长/短只作为参数喂给 writer。
- **设计覆盖只到「封面/插图」**:方案层不碰 length/tone/word_range;tone/word_range 的任务级覆盖本期 YAGNI 不做。

## 架构总览

```
PublishAccount(账号默认)  ── cover_style / image_style / word_range / tone / positioning ...
        ▲ 覆盖
WritingPlan(写作方案)     ── 选题lens + 采集方式(现状) + [可选覆盖] cover_style / image_style
        ▲ 覆盖 / 补充
单次创作任务(dispatch)    ── 最终目标: length_target(长/短) + 目标账号 + draft_type + angle + [可选]设计覆盖
        │
        ▼  resolve_effective_config(账号, 方案, 任务) → 一份 effective config
   scout → editor → writer → illustrator   (同一条链,吃 length_target / angle / effective design)
```

## 详细设计

### ① 数据模型(改动最小,不新建表)

`WritingPlan` 新增两个「覆盖」字段,空值表示继承账号默认:

| 字段 | 类型 | 默认 | 含义 |
|------|------|------|------|
| `cover_style` | JSON | `{}` | 方案级封面风格覆盖(空=继承账号) |
| `image_style` | Text | `""` | 方案级插图风格覆盖(空=继承账号) |

> 方案层只管「设计一致性」一件事;长/短、角度、产物类型都是任务级决策,不落在方案上。

无迁移框架,上线需手动 `ALTER TABLE writing_plans ADD COLUMN ...`(见项目记忆 `project_db_no_migrations`)。

dispatch 的「最终目标」不新建表:复用并扩展现有 `EnqueueIn` 入参,并把目标字段留痕到现有 `PipelineTask` 记录。

### ② 三层继承 → effective config

新增纯函数(建议放 `backend/routers/studio.py` 或独立 helper 模块):

```python
def resolve_effective_config(account, plan, task) -> dict:
    """对每个设计字段按 任务 > 方案 > 账号 取第一个非空值。"""
```

取值规则(`✓` = 该层可提供该字段):

| 字段 | 账号 | 方案 | 任务 | 备注 |
|------|:--:|:--:|:--:|------|
| `cover_style` | ✓默认 | ✓可覆盖 | ✓可临时覆盖 | dict 级合并,任务/方案的非空键覆盖低层 |
| `image_style` | ✓默认 | ✓可覆盖 | ✓可临时覆盖 | 字符串整体覆盖 |
| `length_target` | — | — | ✓ | 仅任务级 |
| `angle` | — | — | ✓ | 仅任务级 |
| `draft_type` | — | — | ✓ | 仅任务级 |

产出是现有 `account_profile` dict 的增强版,继续作为 `ctx["account_profile"]` 喂给 pipeline,另把 `length_target / angle / draft_type` 平铺进 `ctx`。

`cover_style` 的 dict 合并保留现有 `enqueue`/`regenerate-cover` 中「对账号默认做 diff」的语义(`studio.py` 现有 `cover_style_diff` 逻辑),即只把与下层不同的键作为覆盖,便于 agent body 精简。

### ③ Dispatch 入参扩展

`EnqueueIn`(`backend/routers/studio.py` + `wemedia-studio/lib/api/studio.ts`)新增:

| 字段 | 类型 | 必填 | 说明 |
|------|------|:--:|------|
| `writing_plan_id` | int? | 否 | 关联的写作方案;带出方案的设计默认 |
| `length_target` | `"long" \| "short"` | 是 | 形态 |
| `draft_type` | `"article" \| "script"` | 是 | 产物类型,默认 `article` |
| `angle` | str? | 否 | 一句话切入点,给 scout/editor 作种子 |
| `cover_style` | CoverStyle? | 否 | 本次任务级封面覆盖 |
| `image_style` | str? | 否 | 本次任务级插图覆盖 |

`account_id` 已存在。`enqueue_scout_task` 改动:
- 加载 `writing_plan_id` 对应的 `WritingPlan`(可空);
- 用 `resolve_effective_config(acc, plan, payload)` 替换现在直接拼 `account_profile` 的代码;
- 把 `length_target / angle / draft_type` 塞进 `ctx`;
- 创建 `PipelineTask` 时记下 `writing_plan_id`(字段已存在)及目标字段(放入现有 JSON 列或新增轻量列),便于「更新历史」展示与复跑。

### ④ Pipeline 模板吃参数(A 路线)

`backend/pipeline_template.py`,链路形状不变,只改各步 body 模板文案:

- **writer**:读 `ctx["length_target"]`。`long` → 深度展开,字数走 `word_range` 高位;`short` → 凝练,走低位/上限收紧。
- **scout / editor**:读 `ctx["angle"]`(若有)作为切入点种子。
- **illustrator**:读已 merge 好的 `cover_style` / `image_style`(无需自己再 merge)。

### ⑤ 前端

发起任务弹窗(studio enqueue 对应 UI)新增:

- **选择写作方案**:选中后带出方案的 `cover_style` / `image_style` 作为预填(方案空则回退账号默认)。
- **长 / 短** 切换 → `length_target`。
- **article / script** 切换 → `draft_type`。
- **angle** 输入框。
- **可展开「本次封面/插图覆盖」**:复用 `components/features/CoverStyleEditor`(`PublishAccountsSection` 已在用)。

写作方案管理页(topics/plans)新增方案级 `cover_style` / `image_style` 编辑,同样复用 `CoverStyleEditor`。

## 范围之外(本期不做)

- 写作方案的自动选题 / 自动采集(属于方案「是什么」的既有描述,非本次新建能力)。
- 任务级覆盖 `tone` / `word_range`(YAGNI,待有需求再加,继承函数已预留扩展位)。
- 长短文走不同 agent 链路(已决策为同链换参数)。

## 测试要点

- `resolve_effective_config`:纯函数单测,覆盖三层各种空/非空组合、`cover_style` dict 部分键覆盖、`length_target/angle/draft_type` 仅任务级生效。
- `enqueue`:带 `writing_plan_id` 与不带、长/短、article/script 各路径产出的 `ctx` 正确;`PipelineTask` 留痕字段正确。
- pipeline 模板:long/short 两种 `ctx` 渲染出的 writer body 差异符合预期。
