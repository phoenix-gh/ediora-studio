# 写作方案 · 文体预设(genre)设计

日期:2026-05-31
状态:已确认设计(用户 "go"),待写实现计划

## 背景与动机

用户用「写作方案」派 agent 写《跨境金融账户远程开通教程》,只想要个简单教程,产出却是带大量个人观点/感受的复杂长文。

根因(已核实,见 `pipeline_template.py` / `writing_plans.py`):整条 `editor → writer → illustrator` 流水线是「策划型评论文章」生产机,**每一层都无条件**把输入往「有观点、有第一人称、起伏长文」推:

- writer 正文模板无条件要求第一人称当下感受锚点(`pipeline_template.py:384`、`:207`)
- 无条件 `使用技能: humanizer`(`:393`)
- 无字数规格时默认 1500-2200 字长文 + 反模板长文结构(`:236` / `:244`)
- 反 AI 腔通用规则禁用「首先…其次…最后」(`:172`)—— 恰恰是教程该有的结构
- editor(写作方案路径)把 brief 框成「找今天的热点案例 + 第一人称锚点」(`writing_plans.py:355-370`)

系统里没有「教程/操作指南」这个体裁,任何输入都掉进评论长文默认档。

之前试过的缓解(在 brief 里写「400 字以内」/「中立」)失败,因为那只是叠加一条指令,跟上面的无条件硬规则打架,硬规则赢。

## 决策(已与用户确认)

- 形态:**命名文体预设**(选一个,整套替换 writer 规则),不是独立开关调参台。
- 文体集合(起步 4 个):**教程 tutorial / 评论 commentary / 故事 story / 测评 review**。
- 位置:**方案级**字段(`WritingPlan.genre`),纯方案级 —— 派发时不加一次性覆盖。
- 与 `draft_type`(article/script,产物格式)**正交**,不动 draft_type。
- 默认 `commentary` = 现状行为,保证现有方案 / 其它流程零变化,并作为回归基线。

## 架构总览

```
WritingPlan.genre ──dispatch_plan──▶ ctx["genre"] ──▶ GENRE_PROFILES 查表
                                                          │
        ┌─────────────────────────────────────────────────┤
        ▼                          ▼                        ▼
 writer_rules_md             writer body 渲染            editor body 渲染
 (结构块按文体)           (first_person/humanizer gate)  (按文体调 brief 框)
```

不在 ctx 里带 genre 的流程(topic_long / full / rewrite_only)→ `genre` 缺省 `commentary` → 行为不变。

## 详细设计

### ① 数据模型

`WritingPlan`(`backend/models.py:291`)新增:

| 字段 | 类型 | 默认 | 含义 |
|------|------|------|------|
| `genre` | String | `"commentary"` | 文体预设:tutorial / commentary / story / review |

`PipelineTask.goal`(JSON,已存在 `{angle, draft_type}`)增加 `genre` 键留痕(无需 schema 变更)。

`ArticleDraft` 不加列(YAGNI;rewrite 继承见「已知限制」)。

无迁移框架,上线手动:

```sql
ALTER TABLE writing_plans ADD COLUMN genre VARCHAR DEFAULT 'commentary';
```

测试库 `create_all` 自动建列。

### ② 文体规则注册表 GENRE_PROFILES

`backend/pipeline_template.py` 新增:

```python
@dataclass(frozen=True)
class GenreProfile:
    key: str
    label: str            # 中文名(前端 / 留痕)
    structure_md: str     # 结构规则块(替代原长 / 短结构块)
    first_person: bool    # 是否注入第一人称当下动作 / 感受锚点
    humanizer: bool       # 是否启用 humanizer 技能
```

四个 profile(结构块意图,文案实现时定稿):

- **commentary**:`structure_md` = 现有 `_WRITER_LONGFORM_STRUCTURE_MD`(现状,不加任何作废行);`first_person=True`;`humanizer=True`。**= 今天行为,逐字不变。**
- **tutorial**:第二人称「你」;编号步骤,每步一个具体动作 + 预期结果;前置准备先列清单;关键步骤给「如何判断成功 / 常见坑」,简短;中立客观,**禁**个人经历 / 当下感受 / 观点立场;**允许**并列等重结构(解除平行禁令、解除「段落长度强制不均」);清楚 > 有趣。`first_person=False`;`humanizer=False`。
- **story**:第一人称叙事;一个具体的人 / 事 / 瞬间为核;场景、细节、情绪、时间线;允许顺叙与留白结尾;保留具体化锚点。`first_person=True`;`humanizer=True`。
- **review**:结构化按维度对比 / 列点盘点(允许子标题、列点);信息密度优先,弱抒情;每对象 / 维度给具体证据(数字 / 规格 / 实测);结论 / 推荐基于证据;解除平行禁令。`first_person=False`;`humanizer=False`。

通用词汇反 AI 腔块**不拆分、不改动**:`_WRITER_WORDING_RULES_MD`(含「三段平行结构」禁令)对所有文体**逐字保留** —— 这样 commentary / story 完全不变。tutorial / review 的 `structure_md` 里加**一行显式作废**:「上方『三段平行结构』禁令对本文体作废 —— 教程 / 测评允许『第一步 / 第二步』『首先 / 其次』式并列等重结构」。更具体的体裁指令覆盖前面的通用禁令,既保住其它文体逐字一致,又不必动通用块。

### ③ writer_rules_md 按文体分流

`writer_rules_md(c)`(`:239`)改为:

```
profile = GENRE_PROFILES[c.get("genre") or "commentary"]
base = _WRITER_WORDING_RULES_MD
short = _is_short_spec(c.get("word_spec"))
# commentary 保留原「短→短结构块」特例(回归);其余文体用 profile.structure_md,
# 短字数时叠加「宁短勿长 ≤N 字」上限(沿用 _writer_shortform_structure_md 的字数封顶部分)
```

关键不变量:`genre=commentary` 时 `writer_rules_md` 输出与今天**逐字一致**。

### ④ writer / editor body gate

writer 模板(`FULL_PIPELINE[1]`,`:366-407`)三处条件化(都按 `profile = GENRE_PROFILES[c.get('genre') or 'commentary']`):

- `:384` 第一人称锚点指令 → 仅 `profile.first_person` 时渲染。
- `:393` `使用技能: humanizer` → 仅 `profile.humanizer` 时渲染。
- `:395` 反对称结构指令 → 仅 commentary / story 渲染;tutorial / review 换成「按上面结构块组织,步骤 / 维度等重即可」。

editor(写作方案路径,`writing_plans.py:347-376`)加 genre:

- body 顶部加一行「本文体裁:<label>」。
- tutorial / review 时:把「Step 1 找今天的素材(搜最近热点)」软化为「把流程 / 对比讲准、抽要点」,并把「候选锚点 第一人称可代入」换成「关键步骤 / 维度要点(具体、可核对)」。
- commentary / story 维持现状框。

`dispatch_plan`(`:273`)读 `obj.genre` → `ctx["genre"]`;落 `pt.goal["genre"]`。`DispatchPlanRequest` **不加** genre 字段。

writer body 默认值保证其它流程(topic / rewrite)无 genre → commentary → 不变。

### ⑤ 前端

`web/lib/api/writing-plans.ts`:`WritingPlan / WritingPlanCreate / WritingPlanUpdate` 接口加 `genre?: string`。

`web/app/writing-plans/WritingPlansClient.tsx`:

- 方案编辑区加 4 选 1 `Select`(教程 / 评论 / 故事 / 测评),`updateWritingPlan({ genre })` 保存。
- 方案卡片挂文体小徽章(label)。
- 用 shadcn/ui `Select`(项目栈是 shadcn,非 antd)。

## 测试要点

- `GENRE_PROFILES` / `writer_rules_md` 单测:
  - `genre=commentary` → 输出与原 `WRITER_ANTI_AI_RULES_MD` 路径逐字一致(回归)。
  - `genre=tutorial` → 不含第一人称感受块、含编号步骤意图、不含平行结构禁令。
- writer body 渲染单测:`genre=tutorial` → 不出现 humanizer 行、不出现第一人称锚点行;`genre=commentary` → 两行都在。
- `dispatch_plan` 集成:`plan.genre=tutorial` → writer body 去两行、editor body 带教程框;`pt.goal["genre"] == "tutorial"`。
- 防回归:`test_pipeline_template_topic.py`、`test_writing_plans.py` 全绿(topic / rewrite 流程行为不变)。

## 范围之外 / 已知限制(本期不做)

- 派发级一次性覆盖文体、账号级文体默认。
- UI 里自定义文体规则(= 方案 B)。
- 为 review 定制封面 / 插图。
- **rewrite_only**(草稿箱重写)暂不继承文体 —— 默认走 commentary;若要「重写保持教程」需给 `ArticleDraft` 加 genre 列,列为后续 follow-up。
- script(视频脚本)文风仍不随文体定制(沿用既有 draft_type 透传声明)。
