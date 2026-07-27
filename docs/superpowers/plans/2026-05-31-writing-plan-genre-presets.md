# 写作方案 · 文体预设(genre) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `WritingPlan` 加一个方案级 `genre`(教程/评论/故事/测评),让它在 `dispatch_plan` 时驱动 writer 规则分流 —— 选「教程」就出中立编号步骤,不再被无条件注入第一人称感受/humanizer/长文结构;`commentary` 完全等于现状(回归基线)。

**Architecture:** 在 `pipeline_template.py` 建 `GENRE_PROFILES` 注册表(每文体一套结构块 + first_person/humanizer 开关);`writer_rules_md` 与 writer body 渲染按 `ctx["genre"]` 查表分流(缺省 commentary);`dispatch_plan` 读 `plan.genre` 透传进 ctx/goal/editor body。与 `draft_type` 正交。

**Tech Stack:** FastAPI + SQLAlchemy async + Pydantic v2(后端,conda env `wems`);Next.js + shadcn/ui(前端,pnpm)。

> 环境:所有后端命令加 `conda run -n wems` 前缀;Bash 先 `source ~/.zshrc`。无迁移框架,线上 Postgres 需手动 ALTER(测试库 `create_all` 自动建列)。

---

## File Structure

- `backend/models.py` — `WritingPlan` 加 `genre` 列
- `backend/schemas.py` — `WritingPlanCreate/Update/Out` 加 `genre`
- `backend/pipeline_template.py` — `GenreProfile` + `GENRE_PROFILES` + `_genre_profile`;`writer_rules_md` 分流;writer body 三个渲染 helper;`plan_editor_task_block` 纯函数
- `backend/routers/writing_plans.py` — `create_plan` 持久化 genre;`dispatch_plan` 透传 genre 进 ctx/goal/editor body
- `backend/tests/test_genre_profiles.py` — 新建,纯函数单测
- `backend/tests/test_writing_plans.py` — 追加 dispatch 集成测试
- `wemedia-studio/lib/api/writing-plans.ts` — 接口加 `genre`
- `wemedia-studio/app/writing-plans/WritingPlansClient.tsx` — genre `Select` + 卡片徽章

---

## Task 1: 模型 + schema 字段

**Files:**
- Modify: `backend/models.py`(`WritingPlan`,`image_style` 行后)
- Modify: `backend/schemas.py`(`WritingPlanCreate:265`、`WritingPlanUpdate:274`、`WritingPlanOut:308`)

- [ ] **Step 1: WritingPlan 加 genre 列**

`backend/models.py` 的 `WritingPlan` 里,`image_style` 那行(`:303`)后插入:

```python
    genre: Mapped[str] = mapped_column(String, default="commentary")  # tutorial/commentary/story/review
```

(`String` 已在文件顶部 import。)

- [ ] **Step 2: 三个 schema 加 genre**

`backend/schemas.py`:

`WritingPlanCreate`(`:265`)在 `image_style: str = ""` 后加:
```python
    genre: str = "commentary"
```

`WritingPlanUpdate`(`:274`)在 `image_style: Optional[str] = None` 后加:
```python
    genre: Optional[str] = None
```

`WritingPlanOut`(`:308`)在 `image_style: str = ""` 后加:
```python
    genre: str = "commentary"
```

- [ ] **Step 3: create_plan 持久化 genre**

`backend/routers/writing_plans.py` 的 `create_plan`(`:202`),`WritingPlan(...)` 构造里 `image_style=body.image_style,` 后加一行:
```python
        genre=body.genre,
```
(`update_plan` 用 `model_dump(exclude_none=True)` + `setattr`,genre 自动生效,无需改。)

- [ ] **Step 4: 验证导入**

Run: `cd backend && conda run -n wems python -c "import models, schemas; print(models.WritingPlan.genre, schemas.WritingPlanOut.model_fields['genre'])"`
Expected: 打印一个 InstrumentedAttribute + 一个 FieldInfo,无报错。

- [ ] **Step 5: Commit**

```bash
git add backend/models.py backend/schemas.py backend/routers/writing_plans.py
git commit -m "feat(model): add genre to WritingPlan + schemas

Prod migration (run manually):
  ALTER TABLE writing_plans ADD COLUMN genre VARCHAR DEFAULT 'commentary';"
```

---

## Task 2: GenreProfile + GENRE_PROFILES 注册表(TDD)

**Files:**
- Modify: `backend/pipeline_template.py`(在 `WRITER_ANTI_AI_RULES_MD`(`:223`)之后、`_is_short_spec`(`:226`)之前插入)
- Test: `backend/tests/test_genre_profiles.py`(新建)

- [ ] **Step 1: 写失败测试**

新建 `backend/tests/test_genre_profiles.py`:

```python
from pipeline_template import GENRE_PROFILES, _genre_profile


def test_four_genres_present():
    assert set(GENRE_PROFILES) == {"commentary", "tutorial", "story", "review"}


def test_commentary_flags():
    p = GENRE_PROFILES["commentary"]
    assert p.first_person is True and p.humanizer is True
    assert p.label == "评论"


def test_tutorial_flags_and_structure():
    p = GENRE_PROFILES["tutorial"]
    assert p.first_person is False and p.humanizer is False
    assert "编号步骤" in p.structure_md
    assert "禁令对本文体作废" in p.structure_md  # 平行结构作废


def test_review_flags():
    p = GENRE_PROFILES["review"]
    assert p.first_person is False and p.humanizer is False


def test_genre_profile_defaults_to_commentary():
    assert _genre_profile({}).key == "commentary"
    assert _genre_profile({"genre": None}).key == "commentary"
    assert _genre_profile({"genre": "nope"}).key == "commentary"
    assert _genre_profile({"genre": "tutorial"}).key == "tutorial"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && conda run -n wems pytest tests/test_genre_profiles.py -v`
Expected: FAIL — `ImportError: cannot import name 'GENRE_PROFILES'`。

- [ ] **Step 3: 实现注册表**

`backend/pipeline_template.py`,在 `WRITER_ANTI_AI_RULES_MD = ...`(`:223`)之后插入:

```python
_WRITER_TUTORIAL_STRUCTURE_MD = """
## 教程 / 操作指南结构（硬性，最高优先级）
本文是**操作教程**，目标是让读者照着做成一件事。上方「段落长度强制不均 / ≥250 字段落 / 第一人称当下感受」类规则**全部作废**。

- **第二人称**：用「你」，直接给指令。禁第一人称经历、当下感受、个人观点立场（不要「我试了」「我觉得」「说实话」）。
- **编号步骤**：正文主体是有序步骤（第一步 / 第二步… 或 1. 2. 3.），每步聚焦**一个**具体动作 + 预期结果（做完会看到什么）。
- **解除平行禁令**：上方「三段平行结构」禁令对本文体作废——允许「首先 / 其次」「第一步 / 第二步」式并列、等重结构。
- **前置先列清单**：开头用一个清单列出需要的条件 / 材料 / 账号 / 工具。
- **关键步骤给判断与坑**：在容易出错的步骤后，简短给「怎么判断成功」或「常见坑 / 注意」，一两句即可，不展开。
- **清楚 > 有趣**：不绕弯、不抒情、不堆背景。读者要的是照做能成，不是读一篇随笔。
""".strip()

_WRITER_REVIEW_STRUCTURE_MD = """
## 测评 / 盘点结构（硬性，最高优先级）
本文是**测评 / 清单盘点**，目标是用结构化信息帮读者做判断。上方「段落长度强制不均 / 第一人称当下感受」类规则**全部作废**。

- **结构化**：按**维度**横向对比，或按**对象**列点盘点；允许子标题、允许列点（`-` / 数字）。
- **解除平行禁令**：上方「三段平行结构」禁令对本文体作废——允许并列、等重的维度 / 条目结构。
- **证据优先**：每个对象 / 维度给**具体证据**（数字 / 规格 / 实测细节 / 价格 / 来源），不要空泛形容。
- **弱抒情、弱第一人称**：不写个人当下感受；要有观点也是**基于证据的结论 / 推荐**（给谁、为什么），不是情绪。
- **结论明确**：让读者快速拿到「选哪个 / 适合谁」。
""".strip()

_WRITER_STORY_STRUCTURE_MD = _WRITER_LONGFORM_STRUCTURE_MD + """

## 叙事侧重（硬性）
本文以**叙事**为主：一个具体的人 / 事 / 瞬间为核，按时间线推进，可顺叙、可留白结尾；少下论断，多给画面。
""".rstrip()


@dataclass(frozen=True)
class GenreProfile:
    key: str
    label: str            # 中文名（前端 / 留痕）
    structure_md: str     # 结构规则块（替代原长 / 短结构块）
    first_person: bool    # 是否注入第一人称当下动作 / 感受锚点
    humanizer: bool       # 是否启用 humanizer 技能


GENRE_PROFILES: dict[str, "GenreProfile"] = {
    "commentary": GenreProfile("commentary", "评论", _WRITER_LONGFORM_STRUCTURE_MD, True, True),
    "tutorial": GenreProfile("tutorial", "教程", _WRITER_TUTORIAL_STRUCTURE_MD, False, False),
    "story": GenreProfile("story", "故事", _WRITER_STORY_STRUCTURE_MD, True, True),
    "review": GenreProfile("review", "测评", _WRITER_REVIEW_STRUCTURE_MD, False, False),
}


def _genre_profile(c: RenderCtx) -> "GenreProfile":
    """按 ctx['genre'] 查 profile，缺省 / 非法 → commentary（保证其它流程不变）。"""
    return GENRE_PROFILES.get(c.get("genre") or "commentary", GENRE_PROFILES["commentary"])
```

(`dataclass` 已在文件顶部 import(`:21`);`RenderCtx` 已定义(`:24`)。)

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && conda run -n wems pytest tests/test_genre_profiles.py -v`
Expected: 5 passed。

- [ ] **Step 5: Commit**

```bash
git add backend/pipeline_template.py backend/tests/test_genre_profiles.py
git commit -m "feat(pipeline): add GENRE_PROFILES registry (tutorial/commentary/story/review)"
```

---

## Task 3: writer_rules_md 按文体分流(TDD)

**Files:**
- Modify: `backend/pipeline_template.py`(`writer_rules_md`,`:239`;新增 `_writer_wordcap_md`)
- Test: `backend/tests/test_genre_profiles.py`(追加)

- [ ] **Step 1: 写失败测试**

追加到 `backend/tests/test_genre_profiles.py`:

```python
from pipeline_template import writer_rules_md, WRITER_ANTI_AI_RULES_MD


def test_commentary_long_is_exact_regression():
    # commentary 长文 == 旧行为逐字
    assert writer_rules_md({"genre": "commentary"}) == WRITER_ANTI_AI_RULES_MD
    assert writer_rules_md({}) == WRITER_ANTI_AI_RULES_MD  # 缺省也走 commentary


def test_commentary_short_keeps_shortform():
    out = writer_rules_md({"genre": "commentary", "word_spec": {"max": 200, "raw": "100-200 字"}})
    assert "短文案结构" in out
    assert "≤ 200 字" in out


def test_tutorial_uses_tutorial_block_not_longform():
    out = writer_rules_md({"genre": "tutorial"})
    assert "教程 / 操作指南结构" in out
    assert "第一人称当下动作" not in out  # 长文强制具体化块不在
    assert "通用反 AI 腔" in out          # 通用词汇块仍在


def test_tutorial_short_appends_wordcap():
    out = writer_rules_md({"genre": "tutorial", "word_spec": {"max": 400, "raw": "400 字以内"}})
    assert "≤ 400 字" in out
    assert "教程 / 操作指南结构" in out
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && conda run -n wems pytest tests/test_genre_profiles.py -k "regression or shortform or tutorial" -v`
Expected: FAIL —`test_tutorial_uses_tutorial_block_not_longform` 报 AssertionError(现在 tutorial 还走长文)。

- [ ] **Step 3: 改 writer_rules_md + 加 wordcap helper**

`backend/pipeline_template.py`,在 `writer_rules_md`(`:239`)**之前**加:

```python
def _writer_wordcap_md(max_chars: int) -> str:
    return (f"## 字数封顶（硬性）\n"
            f"总字数严格 ≤ {max_chars} 字，宁短勿长，超出即不合格；写完数一遍再交。")
```

把 `writer_rules_md`(`:239-244`)整体替换为:

```python
def writer_rules_md(c: RenderCtx) -> str:
    """按文体选规则块。commentary 保留原「长/短」分流(逐字回归);
    其它文体 = 通用词汇块 + 文体结构块(+ 短字数封顶)。"""
    profile = _genre_profile(c)
    spec = c.get("word_spec")
    if profile.key == "commentary":
        if _is_short_spec(spec):
            return _WRITER_WORDING_RULES_MD + "\n\n" + _writer_shortform_structure_md(spec["max"])
        return WRITER_ANTI_AI_RULES_MD
    parts = [_WRITER_WORDING_RULES_MD, profile.structure_md]
    if _is_short_spec(spec):
        parts.append(_writer_wordcap_md(spec["max"]))
    return "\n\n".join(parts)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && conda run -n wems pytest tests/test_genre_profiles.py -v`
Expected: 全部 passed。

- [ ] **Step 5: Commit**

```bash
git add backend/pipeline_template.py backend/tests/test_genre_profiles.py
git commit -m "feat(pipeline): writer_rules_md branches by genre (commentary = exact regression)"
```

---

## Task 4: writer body 渲染 helpers + 接入 FULL_PIPELINE[1](TDD)

**Files:**
- Modify: `backend/pipeline_template.py`(新增 3 个 helper;`FULL_PIPELINE[1]` body,`:382-397`)
- Test: `backend/tests/test_genre_profiles.py`(追加)

- [ ] **Step 1: 写失败测试**

追加到 `backend/tests/test_genre_profiles.py`:

```python
from pipeline_template import FULL_PIPELINE

_WRITER_STEP = FULL_PIPELINE[1]

def _writer_body(genre):
    ctx = {
        "title": "T", "account_id": "a", "pipeline_task_id": 1,
        "account_profile": {"name": "n", "platform": "wechat"},
        "genre": genre,
    }
    return _WRITER_STEP.body(ctx)


def test_commentary_body_keeps_humanizer_and_first_person():
    b = _writer_body("commentary")
    assert "使用技能**: humanizer" in b
    assert "第一人称的当下动作" in b
    assert "拒绝每节等深等宽的对称结构" in b


def test_tutorial_body_drops_humanizer_first_person_and_symmetry():
    b = _writer_body("tutorial")
    assert "humanizer" not in b
    assert "第一人称的当下动作" not in b
    assert "拒绝每节等深等宽的对称结构" not in b
    assert "不写第一人称经历" in b           # 中立锚点提示
    assert "步骤 / 维度该等重" in b           # 中立结构提示
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && conda run -n wems pytest tests/test_genre_profiles.py -k body -v`
Expected: FAIL — tutorial body 仍含 humanizer。

- [ ] **Step 3: 加 3 个 helper**

`backend/pipeline_template.py`,在 `writer_rules_md` 之后加:

```python
def writer_first_person_anchor_md(c: RenderCtx) -> str:
    """writer 正文「候选锚点」指令：first_person 文体注入第一人称，否则给中立提示。"""
    if _genre_profile(c).first_person:
        return 'brief 里的"候选锚点"要至少用 2 个写成第一人称的当下动作 / 反应，散在中段，不要堆在首尾。'
    return ('brief 里的"候选锚点"是写作素材，挑最能把事讲清楚的用；'
            '本文体**不写第一人称经历 / 当下感受 / 个人观点**，保持中立。')


def writer_humanizer_line_md(c: RenderCtx) -> str:
    """humanizer 文体才输出该 bullet 行（含换行），否则空串。"""
    return "- **使用技能**: humanizer\n" if _genre_profile(c).humanizer else ""


def writer_structure_directive_md(c: RenderCtx) -> str:
    """结构 bullet：评论/故事走反对称；教程/测评走等重结构。"""
    if _genre_profile(c).key in ("commentary", "story"):
        return ('- **结构**：不要按 brief 的提纲"等比例翻译"成文章——brief 是素材清单，'
                '不是文章骨架。落笔前先决定哪一个点是核心，其余点围着它转或直接丢掉。'
                '拒绝每节等深等宽的对称结构。')
    return '- **结构**：按上面的体裁结构块组织；步骤 / 维度该等重就等重，不必制造长短起伏。'
```

- [ ] **Step 4: 接入 writer body**

`backend/pipeline_template.py` 的 `FULL_PIPELINE[1]` body:

(a) 把 `:384` 那一行(`brief 里的"候选锚点"要至少用 2 个写成第一人称的当下动作 / 反应，散在中段，不要堆在首尾。`)整行替换为:
```
{writer_first_person_anchor_md(c)}
```

(b) 把 `:393` 的 `- **使用技能**: humanizer` 行(连同其行尾换行)替换为内联引用——即把这三行:
```
- **标题**：从 brief 候选挑或综合自创（贴 `tone`）
- **使用技能**: humanizer
- **写作习惯**: 逗号,句号全用半角, 句号后面偶尔会连续两三个空格.
```
改成:
```
- **标题**：从 brief 候选挑或综合自创（贴 `tone`）
{writer_humanizer_line_md(c)}- **写作习惯**: 逗号,句号全用半角, 句号后面偶尔会连续两三个空格.
```
(注意:`writer_humanizer_line_md` 返回值自带行尾换行;humanizer 关时返回空串,「写作习惯」直接接在「标题」行之后,不留空行。)

(c) 把 `:395` 的整条 `- **结构**：…拒绝每节等深等宽的对称结构。` 行替换为:
```
{writer_structure_directive_md(c)}
```

- [ ] **Step 5: 跑测试确认通过 + 防回归**

Run: `cd backend && conda run -n wems pytest tests/test_genre_profiles.py -v`
Expected: 全部 passed。

Run: `cd backend && conda run -n wems pytest tests/test_pipeline_template_topic.py -q`
Expected: 全部 passed(topic 流程无 genre → commentary → body 不变;若该文件断言 writer body 文本,确认仍命中)。

- [ ] **Step 6: Commit**

```bash
git add backend/pipeline_template.py backend/tests/test_genre_profiles.py
git commit -m "feat(pipeline): gate writer body first-person/humanizer/structure by genre"
```

---

## Task 5: editor 任务块按文体分流纯函数(TDD)

**Files:**
- Modify: `backend/pipeline_template.py`(新增 `plan_editor_task_block`)
- Test: `backend/tests/test_genre_profiles.py`(追加)

> 说明:把 `dispatch_plan` 里内联的「## 这棒任务（editor）」块抽成纯函数,便于按文体分流 + 单测。commentary/story 复刻现有文案;tutorial/review 换成「讲准流程/对比」框。

- [ ] **Step 1: 写失败测试**

追加到 `backend/tests/test_genre_profiles.py`:

```python
from pipeline_template import plan_editor_task_block


def test_editor_block_commentary_is_hotspot_framing():
    b = plan_editor_task_block("commentary", plan_id=7, word_rule_line="严格按写作模式字数")
    assert "找今天的素材" in b
    assert "add_plan_source(plan_id=7" in b
    assert "第一人称可代入" in b


def test_editor_block_tutorial_is_procedure_framing():
    b = plan_editor_task_block("tutorial", plan_id=7, word_rule_line="严格按写作模式字数")
    assert "找今天的素材" not in b
    assert "把流程" in b or "把这件事讲准" in b
    assert "第一人称" not in b
    assert "add_plan_source(plan_id=7" in b  # 线索库仍可用
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && conda run -n wems pytest tests/test_genre_profiles.py -k editor_block -v`
Expected: FAIL — `ImportError: cannot import name 'plan_editor_task_block'`。

- [ ] **Step 3: 实现 plan_editor_task_block**

`backend/pipeline_template.py` 末尾(`get_pipeline` 之后)加:

```python
def plan_editor_task_block(genre_key: str, plan_id: int, word_rule_line: str) -> str:
    """写作方案路径 editor 棒的「## 这棒任务」块，按文体分流。
    commentary/story = 找今天的热点素材填公式;tutorial/review = 把流程/对比讲准。"""
    src = (f'每找到一条有价值的参考文章/帖子，立即调 '
           f'`add_plan_source(plan_id={plan_id}, url=..., title=..., '
           f'note="一句话说明为什么有价值", platform=...)`，把它存入写作方案的线索库。')
    complete = (f'- `kanban_complete(summary=\'brief 完成: <一句话角度>\', '
                f'metadata={{"plan_id": {plan_id}, "brief_md": "<完整 brief markdown>", '
                f'"brief_chars": N, "core_point": "<一句话>"}})`')
    if genre_key in ("tutorial", "review"):
        kind = "教程" if genre_key == "tutorial" else "测评"
        return "\n".join([
            "## 这棒任务（editor）",
            "",
            f"上方是这个写作方案的**写作模式**。本文体裁是**{kind}**——你的工作不是「找今天的热点」，",
            "而是把这个主题**讲准、讲全**，出 brief 交 writer。",
            "",
            "**Step 1 — 把素材组织清楚**",
            "列出做成 / 讲清这件事需要的：前置条件、关键步骤或对比维度。每条要具体、可核对（数字 / 名称 / 链接）。",
            "若需要核实事实或补料可调 web 工具。" + src,
            "",
            "**Step 2 — 造 ≥3 个候选标题**",
            "说明这篇能帮读者**做成 / 搞清**什么；去掉具体细节后会变空话的，说明不够具体，重写。",
            "",
            "**Step 3 — 出创作 brief**",
            "- **core_point**：一句话（读者读完能做成 / 搞清什么）",
            "- **必须出现的事实** 3-5 条：每条带链接 + 一个具体细节",
            "- **关键步骤 / 维度要点** ≥3：具体、可核对（**不要**第一人称经历 / 感受）",
            "- **候选标题** ≥3",
            f"- **字数/结构**：{word_rule_line}",
            "",
            "完成时：",
            complete,
        ])
    # commentary / story —— 复刻现有热点框架
    return "\n".join([
        "## 这棒任务（editor）",
        "",
        "上方是这个写作方案的**写作模式**——一种固定的文章公式，包含文章结构、标题公式和找素材的方法。",
        "你的工作是：**按模式找今天的素材，把素材填进模式，出 brief 交 writer。**",
        "",
        "**Step 1 — 找今天的素材**",
        "按模式里的搜索方法和关键词，搜索最近发生的真实内容。",
        "目标：找到一个**符合模式判断标准**的具体案例（有人名/数字/时间/来源链接）。",
        src,
        "",
        "**Step 2 — 用模式的标题公式造标题**",
        "把找到的素材填进标题公式，造出 ≥3 个候选标题。",
        "每个标题去掉具体细节后必须变成空话——否则说明细节不够具体，重找。",
        "",
        "**Step 3 — 出创作 brief**",
        "- **core_point**：把素材填进模式后的主线，一句话（含具体人/数/事）",
        "- **必须出现的事实** 3-5 条：每条带原始链接 + 一个具体细节",
        "- **候选锚点** ≥2 个：来自找到的素材，第一人称可代入",
        "- **候选标题** ≥3：用模式里的标题公式填入今天的素材",
        f"- **字数/结构**：{word_rule_line}",
        "",
        "完成时：",
        complete,
    ])
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && conda run -n wems pytest tests/test_genre_profiles.py -k editor_block -v`
Expected: 2 passed。

- [ ] **Step 5: Commit**

```bash
git add backend/pipeline_template.py backend/tests/test_genre_profiles.py
git commit -m "feat(pipeline): plan_editor_task_block branches framing by genre"
```

---

## Task 6: dispatch_plan 接线 genre(TDD 集成)

**Files:**
- Modify: `backend/routers/writing_plans.py`(`dispatch_plan`:editor body 组装 `:347-376`、`ctx` `:378-386`、`goal` `:414`)
- Test: `backend/tests/test_writing_plans.py`(追加)

- [ ] **Step 1: 写失败测试**

在 `backend/tests/test_writing_plans.py` 末尾追加(沿用文件已有 `client` fixture / `SessionLocal` 直插模式;参考同文件 `test_dispatch_merges_plan_design_and_records_goal`):

```python
def test_dispatch_tutorial_genre_flows_to_bodies_and_goal(client, monkeypatch):
    import asyncio
    captured = {}

    async def fake_create_task(self, title, body, assignee, parents=None):
        captured.setdefault("bodies", []).append(body)
        return f"t_{assignee}"

    from hermes_kanban_client import HermesKanbanClient
    monkeypatch.setattr(HermesKanbanClient, "create_task", fake_create_task)

    from database import SessionLocal
    from models import WritingPlan

    async def _seed():
        async with SessionLocal() as db:
            db.add(WritingPlan(id=77, title="跨境开户教程",
                               brief="操作教程：步骤化", genre="tutorial"))
            await db.commit()
    asyncio.new_event_loop().run_until_complete(_seed())

    r = client.post("/api/writing-plans/77/dispatch", json={})
    assert r.status_code == 200

    editor_body, writer_body = captured["bodies"][0], captured["bodies"][1]
    assert "教程" in editor_body and "找今天的素材" not in editor_body
    assert "humanizer" not in writer_body
    assert "第一人称的当下动作" not in writer_body

    async def _goal():
        async with SessionLocal() as db:
            from sqlalchemy import select
            from models import PipelineTask
            pt = (await db.execute(select(PipelineTask))).scalars().first()
            return pt.goal
    goal = asyncio.new_event_loop().run_until_complete(_goal())
    assert goal["genre"] == "tutorial"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && conda run -n wems pytest tests/test_writing_plans.py::test_dispatch_tutorial_genre_flows_to_bodies_and_goal -v`
Expected: FAIL —`goal["genre"]` KeyError / editor body 仍含「找今天的素材」。

- [ ] **Step 3: dispatch_plan 接线**

`backend/routers/writing_plans.py`:

(a) import 增补。把 `:306-308` 的 import 块尾部加 `plan_editor_task_block`:
```python
    from pipeline_template import (
        render_profile_editor, parse_word_spec, FULL_PIPELINE, resolve_effective_design,
        plan_editor_task_block,
    )
```

(b) editor body:把 `:347-376` 那一整段 `editor_body_parts.extend([...])`(从「## 写作模式（来自写作方案）」一直到结尾的 `kanban_complete` 内联块)替换为——保留「写作模式」原文块,任务块改用纯函数生成:
```python
    editor_body_parts.extend([
        "## 写作模式（来自写作方案）",
        obj.brief,
        "",
        "---",
        "",
        plan_editor_task_block(obj.genre, plan_id, word_rule_line),
    ])
```
(删掉原来 `"## 这棒任务（editor）"` 到结尾 `kanban_complete` 那一长串内联行——它们已搬进 `plan_editor_task_block`;不另加文体标签行,文体已由 `plan_editor_task_block` 在 tutorial/review 分支内声明,commentary/story 分支保持与现状逐字一致。)

(c) ctx 加 genre。`ctx = {...}`(`:378`)里 `"draft_type": body.draft_type,` 后加:
```python
        "genre": obj.genre,
```

(d) goal 落 genre。`:414` 改为:
```python
    pt.goal = {"angle": body.angle or "", "draft_type": body.draft_type, "genre": obj.genre}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && conda run -n wems pytest tests/test_writing_plans.py::test_dispatch_tutorial_genre_flows_to_bodies_and_goal -v`
Expected: PASS。

- [ ] **Step 5: 防回归(整个方案测试文件 + pipeline 模板)**

Run: `cd backend && conda run -n wems pytest tests/test_writing_plans.py tests/test_genre_profiles.py tests/test_pipeline_template_topic.py -q`
Expected: 全部 passed(已有的 commentary 派发用例行为不变)。

- [ ] **Step 6: Commit**

```bash
git add backend/routers/writing_plans.py backend/tests/test_writing_plans.py
git commit -m "feat(dispatch): thread plan.genre into editor/writer body + goal"
```

---

## Task 7: 前端 API 客户端 genre

**Files:**
- Modify: `wemedia-studio/lib/api/writing-plans.ts`

> 提示:前端无 JS 测试框架,Task 7-8 用 `tsc --noEmit` + 手动验证;改动遵循文件既有写法。先 Read 文件确认接口字段顺序。

- [ ] **Step 1: 接口加 genre**

`wemedia-studio/lib/api/writing-plans.ts`:`WritingPlan` 接口里(`cover_style`/`image_style` 同区域)加:
```ts
  genre?: string
```
`WritingPlanCreate` 与 `WritingPlanUpdate` 各加同样一行(可选)。

- [ ] **Step 2: 类型检查**

Run: `cd wemedia-studio && pnpm exec tsc --noEmit`
Expected: 无新错(本文件改动不引入错误)。

- [ ] **Step 3: Commit**

```bash
git add wemedia-studio/lib/api/writing-plans.ts
git commit -m "feat(ui-api): WritingPlan genre field"
```

---

## Task 8: 前端 方案编辑 genre Select + 卡片徽章

**Files:**
- Modify: `wemedia-studio/app/writing-plans/WritingPlansClient.tsx`

> 先 Read 文件:定位方案元信息编辑区(参照 `editPriority` / `image_style` 保存逻辑)与方案卡片渲染处。复用项目已有的 shadcn `Select`(`@/components/ui/select`,看 `PublishAccountsSection` 等既有用法)。

- [ ] **Step 1: 文体常量**

文件顶部(组件外)加:
```ts
const GENRE_OPTIONS = [
  { value: 'tutorial', label: '教程' },
  { value: 'commentary', label: '评论' },
  { value: 'story', label: '故事' },
  { value: 'review', label: '测评' },
] as const
const GENRE_LABEL: Record<string, string> = Object.fromEntries(
  GENRE_OPTIONS.map(o => [o.value, o.label]),
)
```

- [ ] **Step 2: 编辑 state + 回填**

在方案 meta 编辑 state 附近加:
```ts
  const [editGenre, setEditGenre] = useState('commentary')
```
在 `selected` → edit 同步 effect 内回填:
```ts
    setEditGenre(selected?.genre ?? 'commentary')
```

- [ ] **Step 3: 渲染 Select + 保存**

在方案 meta 编辑区(image_style / 视觉设计附近)加:
```tsx
  <div className="space-y-1">
    <div className="text-xs font-medium text-zinc-500">文体（决定 writer 怎么写）</div>
    <Select value={editGenre} onValueChange={async (g) => {
      setEditGenre(g)
      if (!selected) return
      const updated = await updateWritingPlan(selected.id, { genre: g })
      setPlans(ps => ps.map(p => p.id === updated.id ? updated : p))
      setSelected(updated)
      toast.success(`文体已设为「${GENRE_LABEL[g]}」`)
    }}>
      <SelectTrigger className="h-8 text-xs w-32"><SelectValue /></SelectTrigger>
      <SelectContent>
        {GENRE_OPTIONS.map(o => (
          <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  </div>
```
(确认顶部 import 了 `Select, SelectContent, SelectItem, SelectTrigger, SelectValue`,缺则补 `from '@/components/ui/select'`。)

- [ ] **Step 4: 卡片徽章**

在方案卡片标题区(已有 priority / tag 徽章处)加文体徽章:
```tsx
  <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-600">
    {GENRE_LABEL[plan.genre ?? 'commentary']}
  </span>
```
(变量名 `plan` 按卡片 map 的实际项名替换。)

- [ ] **Step 5: 类型检查 + 手动验证**

Run: `cd wemedia-studio && pnpm exec tsc --noEmit`
Expected: 无错。
手动:打开 `/writing-plans` 选一个方案 → 文体下拉改「教程」→ 刷新页面值仍在、卡片徽章显示「教程」。

- [ ] **Step 6: Commit**

```bash
git add wemedia-studio/app/writing-plans/WritingPlansClient.tsx
git commit -m "feat(ui): plan genre selector + card badge"
```

---

## 收尾验证

- [ ] 后端全测:`cd backend && conda run -n wems pytest tests/test_genre_profiles.py tests/test_writing_plans.py tests/test_pipeline_template_topic.py -q` → 全绿
- [ ] 前端类型:`cd wemedia-studio && pnpm exec tsc --noEmit` → 无错
- [ ] 端到端手测:把那篇《跨境金融账户远程开通教程》方案文体设为「教程」→ 派发 → 草稿箱产出应是中立、编号步骤、无「我觉得/当下感受」
- [ ] commentary 回归手测:任一现有评论类方案派发 → 产出风格与改动前一致

## Self-Review 备注(已核对)

- **Spec 覆盖**:① 模型 = Task1;② GENRE_PROFILES = Task2;③ writer_rules_md 分流 = Task3;④ writer body gate = Task4;editor 分流 = Task5;dispatch 透传 = Task6;⑤ 前端 = Task7-8。全覆盖。
- **类型/命名一致**:`_genre_profile`/`GENRE_PROFILES`/`GenreProfile` 在 Task2 定义,Task3-5 复用;`plan_editor_task_block(genre_key, plan_id, word_rule_line)` 在 Task5 定义、Task6 调用签名一致;`writer_*_md(c)` helper 均 Task4 定义、写入 body。
- **回归保障**:commentary / 缺省 genre 路径 `writer_rules_md` 逐字等于旧值(Task3 测试断言);topic/rewrite 流程不带 genre → commentary → 不变(Task4/6 防回归测试)。
- **范围**:rewrite_only 不继承文体(spec 已声明 follow-up);draft_type 不动。
