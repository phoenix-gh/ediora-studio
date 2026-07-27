# Writer 提示词外置为 markdown 片段（试点）

**日期**: 2026-06-16
**状态**: 设计已确认，待实现
**范围**: 仅 writer 角色的"手艺规则"。editor / illustrator / scout 不在本轮。

## 目标

把 `backend/pipeline_template.py` 里硬编码在 f-string / 模块常量中的 **writer 编辑手艺规则**（反 AI 词汇、文体结构、第一人称锚点、结构指令、字数指令）抽到 **仓库 markdown 文件**，使得：

- **改提示词文本 = 改 markdown，零 Python 改动**（核心诉求）。
- git 跟踪变更，可 diff / 回滚 / 复用。
- agent 实际看到的任务 body **保持逐字不变**（确定性不退化，内容质量不回归）。

## 已确认的决策（来自 brainstorming）

1. 痛点：改 prompt 不用动 Python。
2. 存储：仓库 markdown 文件。
3. 消费模型：**render-in** —— enqueue 时后端读文件、填变量、渲染进 body。**不**走"body 只引用 skill 名、交 agent 自动加载"（那样丢确定性）。
4. 范围：试点只做 writer 手艺规则。
5. 安全网：golden 测试保证重构后渲染输出与当前逐字相等。

## 非目标 / 边界

- **不**把片段放进 `skills/`。`skills/` 会被 symlink 进 agent 目录并被其 Claude Code 自动发现；本片段是确定性注入文本，混入会导致 agent 双重加载。用独立目录 `backend/prompts/`。
- 改规则**文本** = 零 Python ✓；但**新增文体**、改"什么时候用哪块"的**装配逻辑** = 仍要动 Python（装配逻辑留在 Python，是刻意的）。
- 不动 editor / illustrator / scout 的 body，也不动任何编排胶水（account_id、调哪个 MCP 工具、kanban_complete metadata 形状、≤3 turn 流程）。

## 架构

### 1. 新目录 `backend/prompts/writer/`

逐块抽成文件（文本逐字搬运自现有常量）：

| 文件 | 来源 | 类型 |
|---|---|---|
| `wording_rules.md` | `_WRITER_WORDING_RULES_MD` (line 153) | 静态 |
| `structure_longform.md` | `_WRITER_LONGFORM_STRUCTURE_MD` (179) | 静态 |
| `structure_tutorial.md` | `_WRITER_TUTORIAL_STRUCTURE_MD` (217) | 静态 |
| `structure_review.md` | `_WRITER_REVIEW_STRUCTURE_MD` (229) | 静态 |
| `structure_story_extra.md` | `_WRITER_STORY_STRUCTURE_MD` 的"叙事侧重"尾段 (240+) | 静态；story = longform + 它 |
| `structure_shortform.md` | `_writer_shortform_structure_md` (200) | 带 `{{max_chars}}` |
| `wordcap.md` | `_writer_wordcap_md` (282) | 带 `{{max_chars}}` |
| `first_person_on.md` | `writer_first_person_anchor_md` first_person 分支 | 静态 |
| `first_person_off.md` | 同上 非 first_person 分支 | 静态 |
| `structure_directive_asymmetric.md` | `writer_structure_directive_md` commentary/story 分支 | 静态 |
| `structure_directive_even.md` | 同上 tutorial/review 分支 | 静态 |
| `word_directive_plan.md` | `writer_word_directive_md` 有方案规格分支 | 带 `{{raw}}` |
| `word_directive_default.md` | 同上 回退分支 | 静态 |
| `humanizer_line.md` | `writer_humanizer_line_md` 的 bullet 行 | 静态 |

### 2. 加载器 `backend/prompt_templates.py`

```python
from pathlib import Path
_PROMPTS_DIR = Path(__file__).parent / "prompts"

def load(rel: str) -> str:
    """读一个片段（rel 如 'writer/wording_rules.md'）。每次读盘——enqueue 频率低，
    改 md 立即生效、不必重启。"""
    return (_PROMPTS_DIR / rel).read_text(encoding="utf-8").strip()

def render(rel: str, **vars) -> str:
    """load 后把 {{key}} 占位符替换为 vars 值。"""
    text = load(rel)
    for k, v in vars.items():
        text = text.replace("{{" + k + "}}", str(v))
    return text
```

占位符用 `{{key}}`：被抽取的规则文本里没有字面 `{{`（带花括号的 JSON 示例都在编排 body 里，不在本次抽取范围），安全。

### 3. 改装 `pipeline_template.py`

- `GenreProfile.structure_md`（内联文本字段）→ `structure_files: tuple[str, ...]`：
  - `commentary = ("writer/structure_longform.md",)`
  - `tutorial = ("writer/structure_tutorial.md",)`
  - `review = ("writer/structure_review.md",)`
  - `story = ("writer/structure_longform.md", "writer/structure_story_extra.md")`
  - 取结构文本：`"\n\n".join(load(f) for f in profile.structure_files)`（longform 仍是单一来源）。
- `WRITER_ANTI_AI_RULES_MD` → 调用时 `load("writer/wording_rules.md") + "\n\n" + load("writer/structure_longform.md")`。
- 装配器**保留挑块逻辑**，文本改为 `load()/render()`：
  - `writer_rules_md(c)`：按 genre/word_spec 选块（逻辑不变），文本来自文件；短文案 `render(structure_shortform, max_chars=...)`、`render(wordcap, max_chars=...)`。
  - `writer_first_person_anchor_md(c)`：按 `first_person` 标志 `load` on/off 文件。
  - `writer_structure_directive_md(c)`：按 genre `load` asymmetric/even 文件。
  - `writer_word_directive_md(c)`：有 `raw` 则 `render(word_directive_plan, raw=...)`，否则 `load(word_directive_default)`。
  - `writer_humanizer_line_md(c)`：humanizer 文体 `load(humanizer_line)`，否则 `""`。
- 删除被抽走的 `_WRITER_*_MD` 内联常量。

## Blast radius

- `routers/studio.py` 仅用 `GENRE_PROFILES[k].label` 与 key 校验，不碰 `structure_md` → 安全。
- `tests/test_genre_profiles.py` 仅验 key / first_person / humanizer / label → 安全（不依赖结构文本字段名）。需顺带确认它不引用 `structure_md`；若引用则改读新字段。

## 测试

1. **重构前**：用当前代码对各 ctx 组合（4 文体 × {长, 短} × {有方案字数, 默认} + humanizer on/off）跑装配器，把每个组合的输出快照写到 `backend/tests/snapshots/writer/<combo>.md` 并提交（一次性捕获脚本，或手工跑一次存盘）。
2. **重构后**：测试遍历快照目录，断言重构后装配器对同一 ctx 的输出与对应快照文件**逐字相等** → 保证 agent body 一字不差。
3. 加载器单测：`load` 读对文件、`render` 正确替换 `{{max_chars}}` / `{{raw}}`、缺文件抛清晰错误。

## 风险与缓解

- **文本漂移**：抽取时手抄出错 → golden 逐字比对兜底。
- **改 md 不生效**：加载器每次读盘（不缓存），dev 下编辑即时生效；无需重启。
- **路径问题**（cwd 差异）：加载器用 `Path(__file__).parent` 绝对定位，不依赖 cwd。

## 本轮之外（后续轮次）

editor brief 规则、illustrator 封面法、scout/editor 画像渲染，以及其它 flow（topic_long / manual_topic / github / daily_plan / rewrite 等）的同类抽取——验证机制后按同一模式推广。
