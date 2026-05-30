# 写作方案 → 创作目标与设计覆盖 设计

日期:2026-05-30(2026-05-30 校正:对齐现有代码)
状态:已确认设计,待写实现计划

## 背景与动机

用户希望「写作方案(`WritingPlan`)」承载创作策略,并在派给 agent 前确定本次任务的最终目标。讨论中明确:

1. 写作方案是一套长期复用的策略(选题视角 + 数据采集方式)。
2. 同一方案对**封面 / 插图有一致性要求**,应当**覆盖账号默认**。
3. 发给 agent 前要拍板本次目标。

## 与现有代码对齐(关键:很多已存在)

摸过代码后确认,核心机制已落地,本设计只补真正的缺口:

- **长 / 短文已由写作方案决定(保持现状,A 路线)**:`POST /writing-plans/{plan_id}/dispatch`(`backend/routers/writing_plans.py:271` 的 `dispatch_plan`)读方案 `brief`,用 `parse_word_spec()`(`pipeline_template.py:251`)解析字数(如「100-200字」「300字以内」),把 `word_spec` 放进 `ctx`。writer 步骤已有的 `writer_word_directive_md` / `writer_rules_md`(`pipeline_template.py:230/239`)据此**自动切换长文结构 / 短文案结构**。→ 长短文是方案属性,不在 dispatch 时显式选(用户已确认选 A)。
- **创作链路 = `editor → writer → illustrator`**(`FULL_PIPELINE`,`pipeline_template.py:288`;scout 已移除)。`dispatch_plan` 复用 `FULL_PIPELINE[1]`(writer)、`FULL_PIPELINE[2]`(illustrator),editor 棒 body 由 `dispatch_plan` 现场拼。
- **illustrator 已读 `profile["cover_style"]` / `profile["image_style"]`**(`render_profile_illustrator`,`pipeline_template.py:142`)。

### 真正的缺口(本设计要做的)

1. **方案级 `cover_style` / `image_style` 无法覆盖账号默认。** `dispatch_plan` 直接用 `account.cover_style` / `account.image_style`(`writing_plans.py:291`),`WritingPlan` 上根本没有这两个字段。← 核心诉求,缺失。
2. **dispatch 时无法拍板「本次目标」。** `DispatchPlanRequest`(`schemas.py:331`)只有 `account_id`;没有 `angle`(本次切入点)、`draft_type`、以及本次临时的设计覆盖。

## 决策(已与用户确认)

- 长 / 短保持 brief 驱动(A),dispatch 不加长短开关。
- 设计覆盖走三层:**任务 dispatch override > 方案 > 账号默认**。
- 方案层只新增 `cover_style` / `image_style` 两个覆盖字段,不碰 length / tone / word_range。

## 架构总览

```
PublishAccount(账号默认)  ── cover_style / image_style / word_range / tone ...
        ▲ 覆盖
WritingPlan(写作方案)     ── brief(含写作模式 → 决定长短) + [新增] cover_style / image_style
        ▲ 覆盖 / 补充
dispatch_plan 请求         ── [新增] angle? / draft_type? / cover_style? / image_style?(本次临时覆盖)
        │
        ▼  resolve_effective_design(账号, 方案, 请求) → profile.cover_style / image_style
   editor → writer → illustrator   (链路不变;writer 吃 brief 的 word_spec,illustrator 吃 merged design)
```

## 详细设计

### ① 数据模型

`WritingPlan`(`backend/models.py:291`)新增两个覆盖字段,空值=继承账号:

| 字段 | 类型 | 默认 | 含义 |
|------|------|------|------|
| `cover_style` | JSON | `{}` | 方案级封面风格覆盖 |
| `image_style` | Text | `""` | 方案级插图风格覆盖 |

无迁移框架,上线需手动 `ALTER TABLE writing_plans ADD COLUMN cover_style JSON DEFAULT '{}'::json` 等(见记忆 `project_db_no_migrations`)。测试库走 `create_all` 自动建列。

`PipelineTask`(`models.py:370`)新增 `goal: JSON = {}`,记 `{angle, draft_type}`,供「更新历史」展示与复跑留痕。`writing_plan_id` 字段已存在。

### ② 设计合并函数

新增纯函数 `resolve_effective_design(account_cover, account_image, plan_cover, plan_image, task_cover, task_image)`(放 `backend/pipeline_template.py`,与渲染逻辑同源,方便单测):

- **`cover_style`(dict)**:从 `account_cover` 起,依次用 `plan_cover`、`task_cover` 里的**非空键**覆盖(逐键 merge,空 dict 不动)。
- **`image_style`(str)**:取 `task_image` → `plan_image` → `account_image` 第一个非空字符串。

返回 `(effective_cover: dict, effective_image: str)`,塞进 `profile["cover_style"]` / `profile["image_style"]`。

### ③ Dispatch 请求扩展

`DispatchPlanRequest`(`schemas.py:331`)新增(全部可选):

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `angle` | str? | None | 本次切入点,注入 editor body 作种子(覆盖「自己找角度」) |
| `draft_type` | str | `"article"` | `article` / `script`,透传给 writer → `save_draft` |
| `cover_style` | dict? | None | 本次临时封面覆盖(优先于方案) |
| `image_style` | str? | None | 本次临时插图覆盖(优先于方案) |

`dispatch_plan` 改动:
- profile 的 `cover_style` / `image_style` 改用 `resolve_effective_design(...)` 结果(account / plan / request 三方)。
- 有 `angle` 时,editor body 增加「## 本次角度(用户指定,直接用)」块,替代「Step 2 自己造角度」语气;无则维持现状。
- `draft_type` 放进 `ctx`,writer body 末尾追加一行目标产物类型说明,并要求 `save_draft(..., draft_type=...)`。
- 落 `PipelineTask.goal = {"angle": ..., "draft_type": ...}`。

### ④ writer 透传 draft_type

`save_draft`(`backend/mcp_server.py:980`)新增参数 `draft_type: str = "article"`,写入 `ArticleDraft.draft_type`。writer 棒 body(`FULL_PIPELINE[1]`)在 `save_draft(...)` 调用示例里带上 `draft_type={c.get('draft_type','article')}`。

> 范围声明:本期只做 `draft_type` 的**透传与打标**(产物正确归类),**不**为 `script` 定制 writer 文风 / 结构(FULL_PIPELINE writer 仍是文章导向)。脚本专属链路是后续独立 spec。

### ⑤ 前端

`writing-plans.ts` 客户端:`WritingPlan` / `WritingPlanCreate` / `WritingPlanUpdate` 接口加 `cover_style?: CoverStyle` / `image_style?: string`;`dispatchPlan` 签名加可选 `{ angle?, draft_type?, cover_style?, image_style? }`。

`app/writing-plans/WritingPlansClient.tsx`:
- 方案编辑表单加 `cover_style` / `image_style` 编辑,复用 `components/features/CoverStyleEditor`(`PublishAccountsSection` 已在用)。
- 派发入口(`dispatchPlan` 调用处)加:`angle` 输入框、`article/script` 选择、可展开「本次封面/插图覆盖」。

## 范围之外(本期不做)

- dispatch 时显式长 / 短开关(已选 A,长短由 brief 决定)。
- `script` 专属 writer 文风 / 结构(仅透传打标,留独立 spec)。
- 任务级覆盖 tone / word_range(YAGNI)。
- 方案自动选题 / 自动采集(既有能力描述,非本期新建)。

## 测试要点

- `resolve_effective_design`:纯函数单测——三层各种空 / 非空组合;`cover_style` 逐键覆盖(plan 改 palette、task 改 type,其余沿用 account);`image_style` 优先级 task>plan>account。
- `dispatch_plan`:带 plan 级 cover_style 时,illustrator body 出现 merged 值;带 request 级 override 时再覆盖;带 angle 时 editor body 含角度块;`PipelineTask.goal` 落值正确。
- `save_draft`:`draft_type="script"` 时 `ArticleDraft.draft_type == "script"`。
