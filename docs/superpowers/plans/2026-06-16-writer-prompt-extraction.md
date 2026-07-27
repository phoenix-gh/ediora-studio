# Writer 提示词外置为 markdown 片段 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `backend/pipeline_template.py` 里 writer 角色的手艺规则（反 AI 词汇、文体结构、第一人称锚点、结构指令、字数指令）从硬编码常量抽到 `backend/prompts/writer/*.md`，使改提示词文本无需动 Python，且 agent 看到的 body 逐字不变。

**Architecture:** 先用当前代码把各 ctx 组合的 writer 装配输出快照成 golden 文件（安全网）。再加一个极简加载器 `prompt_templates.py`（`load`/`render`，每次读盘、无缓存）。把规则文本逐字搬进 `prompts/writer/*.md`。最后改装 `pipeline_template.py` 的装配器从文件读文本（**挑块逻辑保留在 Python**），golden 测试保持全绿证明零行为差异。

**Tech Stack:** Python 3.11 (conda env `wems`，所有 python/pytest 命令加 `conda run -n wems` 前缀)、pytest（`asyncio_mode=auto`）、纯文件 IO，无新依赖。

**约定:** 所有命令在 `backend/` 下运行。提交前若仍在 `main` 分支，先开特性分支（仓库习惯）。

---

## File Structure

- **Create** `backend/prompt_templates.py` — 片段加载器（`load`/`render`）。唯一职责：从 `prompts/` 读 markdown、替换 `{{占位符}}`。
- **Create** `backend/prompts/writer/*.md`（14 个）— 每个一块 writer 规则文本。纯内容，可独立编辑。
- **Create** `backend/tests/test_prompt_templates.py` — 加载器单测。
- **Create** `backend/tests/test_writer_prompts_golden.py` + `backend/tests/snapshots/writer/*.md` — 行为快照安全网。
- **Modify** `backend/pipeline_template.py` — 删 `_WRITER_*` 内联常量与两个 `_writer_*` 函数；`GenreProfile.structure_md`→`structure_files`；装配器改用加载器。

---

## Task 1: Golden 快照安全网（锁住当前行为）

**Files:**
- Test: `backend/tests/test_writer_prompts_golden.py`
- Create: `backend/tests/snapshots/writer/*.md`（由测试生成）

- [ ] **Step 1: 写快照测试**

`backend/tests/test_writer_prompts_golden.py`:

```python
"""Golden snapshot of the writer rule assemblers — locks current output so the
markdown-extraction refactor can be proven byte-identical.

Intended change? Regenerate:
    UPDATE_WRITER_SNAPSHOTS=1 conda run -n wems python -m pytest tests/test_writer_prompts_golden.py
"""
import os
from pathlib import Path

import pytest

import pipeline_template as pt

SNAP_DIR = Path(__file__).parent / "snapshots" / "writer"

# name -> ctx. Covers genre × {long, short} × {plan spec, default} × humanizer on/off.
COMBOS: dict[str, dict] = {
    "commentary_long":         {"genre": "commentary"},
    "commentary_short_plan":   {"genre": "commentary", "word_spec": {"min": 100, "max": 200, "raw": "100-200 字"}},
    "commentary_spec_default": {"genre": "commentary", "word_spec": {"min": 1500, "max": 2200}},
    "tutorial_long":           {"genre": "tutorial"},
    "tutorial_short_plan":     {"genre": "tutorial", "word_spec": {"max": 300, "raw": "300 字以内"}},
    "story_long":              {"genre": "story"},
    "review_long":             {"genre": "review"},
}


def _bundle(ctx: dict) -> str:
    """Concatenate every writer assembler's output for one ctx into one snapshot."""
    return "\n\n===SECTION===\n\n".join([
        pt.writer_rules_md(ctx),
        pt.writer_first_person_anchor_md(ctx),
        pt.writer_structure_directive_md(ctx),
        pt.writer_word_directive_md(ctx),
        pt.writer_humanizer_line_md(ctx),
    ])


@pytest.mark.parametrize("name", list(COMBOS))
def test_writer_rule_bundle_matches_snapshot(name):
    actual = _bundle(COMBOS[name])
    snap = SNAP_DIR / f"{name}.md"
    if os.environ.get("UPDATE_WRITER_SNAPSHOTS"):
        snap.parent.mkdir(parents=True, exist_ok=True)
        snap.write_text(actual, encoding="utf-8")
        pytest.skip(f"snapshot written: {snap.name}")
    assert snap.exists(), f"missing snapshot {snap}; run with UPDATE_WRITER_SNAPSHOTS=1 first"
    assert actual == snap.read_text(encoding="utf-8")
```

- [ ] **Step 2: 生成快照（对当前未重构代码）**

Run: `UPDATE_WRITER_SNAPSHOTS=1 conda run -n wems python -m pytest tests/test_writer_prompts_golden.py -q`
Expected: 7 skipped（每个组合写出一个 `snapshots/writer/<name>.md`）。

- [ ] **Step 3: 正常跑一遍确认快照自洽**

Run: `conda run -n wems python -m pytest tests/test_writer_prompts_golden.py -q`
Expected: 7 passed.

- [ ] **Step 4: Commit**

```bash
git add tests/test_writer_prompts_golden.py tests/snapshots/writer/
git commit -m "test(pipeline): golden snapshot of writer rule assemblers"
```

---

## Task 2: 片段加载器 `prompt_templates.py`

**Files:**
- Create: `backend/prompt_templates.py`
- Test: `backend/tests/test_prompt_templates.py`

- [ ] **Step 1: 写失败测试**

`backend/tests/test_prompt_templates.py`:

```python
import pytest

import prompt_templates as ptpl


def test_load_reads_and_strips(tmp_path, monkeypatch):
    d = tmp_path / "writer"
    d.mkdir()
    (d / "x.md").write_text("\n  hello world  \n", encoding="utf-8")
    monkeypatch.setattr(ptpl, "_PROMPTS_DIR", tmp_path)
    assert ptpl.load("writer/x.md") == "hello world"


def test_render_substitutes_placeholders(tmp_path, monkeypatch):
    (tmp_path / "t.md").write_text("max {{max_chars}} 字, raw={{raw}}", encoding="utf-8")
    monkeypatch.setattr(ptpl, "_PROMPTS_DIR", tmp_path)
    assert ptpl.render("t.md", max_chars=200, raw="100-200 字") == "max 200 字, raw=100-200 字"


def test_load_missing_file_raises(tmp_path, monkeypatch):
    monkeypatch.setattr(ptpl, "_PROMPTS_DIR", tmp_path)
    with pytest.raises(FileNotFoundError):
        ptpl.load("nope.md")
```

- [ ] **Step 2: 跑测试确认失败**

Run: `conda run -n wems python -m pytest tests/test_prompt_templates.py -q`
Expected: FAIL（`ModuleNotFoundError: No module named 'prompt_templates'`）。

- [ ] **Step 3: 写最小实现**

`backend/prompt_templates.py`:

```python
"""Load prompt fragments from markdown files so the rule *text* can be edited
without touching Python.

Read each call (no cache): enqueue is infrequent, and reading fresh means a
markdown edit takes effect on the next enqueue without restarting the backend.
"""
from pathlib import Path

_PROMPTS_DIR = Path(__file__).parent / "prompts"


def load(rel: str) -> str:
    """Return the stripped contents of prompts/<rel> (e.g. 'writer/wording_rules.md')."""
    return (_PROMPTS_DIR / rel).read_text(encoding="utf-8").strip()


def render(rel: str, **values: object) -> str:
    """load() then substitute {{key}} placeholders with the given values."""
    text = load(rel)
    for key, value in values.items():
        text = text.replace("{{" + key + "}}", str(value))
    return text
```

- [ ] **Step 4: 跑测试确认通过**

Run: `conda run -n wems python -m pytest tests/test_prompt_templates.py -q`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add prompt_templates.py tests/test_prompt_templates.py
git commit -m "feat(prompts): add markdown prompt-fragment loader"
```

---

## Task 3: 抽出 writer 规则片段文件

**Files:**
- Create: `backend/prompts/writer/` 下 14 个 `.md`

> 文本必须与现有常量**逐字一致**（Task 1 的 golden 会在 Task 4 兜底校验）。静态大块直接从 `pipeline_template.py` 指定行复制三引号内的正文；参数化块把 f-string 的 `{max_chars}` / `{spec['raw']}` 改成 `{{max_chars}}` / `{{raw}}`。

- [ ] **Step 1: 静态规则块（从源文件逐字复制）**

逐字复制每个常量三引号内、`.strip()` 后的正文到对应文件：

- `prompts/writer/wording_rules.md` ← `_WRITER_WORDING_RULES_MD`（`pipeline_template.py:153` 起的三引号正文）
- `prompts/writer/structure_longform.md` ← `_WRITER_LONGFORM_STRUCTURE_MD`（`:179` 起）
- `prompts/writer/structure_tutorial.md` ← `_WRITER_TUTORIAL_STRUCTURE_MD`（`:217` 起）
- `prompts/writer/structure_review.md` ← `_WRITER_REVIEW_STRUCTURE_MD`（`:229` 起）

- [ ] **Step 2: story 尾段**

`prompts/writer/structure_story_extra.md`（即 `_WRITER_STORY_STRUCTURE_MD` 在 longform 之后追加的部分，去掉前导空行）:

```
## 叙事侧重（硬性）
本文以**叙事**为主：一个具体的人 / 事 / 瞬间为核，按时间线推进，可顺叙、可留白结尾；少下论断，多给画面。
```

- [ ] **Step 3: 参数化块**

`prompts/writer/structure_shortform.md`（`_writer_shortform_structure_md`，两处 `{max_chars}`→`{{max_chars}}`）:

```
## 短文案结构（硬性，最高优先级）
本文是 **≤ {{max_chars}} 字的短文案**，上方「段落长度强制不均」「≥250 字段落」类长文结构规则**全部作废**。
- **总字数严格 ≤ {{max_chars}} 字**：宁短勿长，超出即不合格；写完数一遍字数再交。
- 不分小标题、不写引言/结语、不堆砌段落；一个核心案例 + 一句洞察收尾即可。
- 至少 1 处具体细节（人名 / 数字 / 时间 / 引语），但不要为凑字数注水。
```

`prompts/writer/wordcap.md`（`_writer_wordcap_md`）:

```
## 字数封顶（硬性）
总字数严格 ≤ {{max_chars}} 字，宁短勿长，超出即不合格；写完数一遍再交。
```

`prompts/writer/word_directive_plan.md`（`writer_word_directive_md` 有方案规格分支，`{spec['raw']}`→`{{raw}}`，单行）:

```
严格 **{{raw}}**（写作方案硬规格，**超出即不合格**；忽略上方画像 word_range）
```

- [ ] **Step 4: 单行/双变体块**

各文件单行、无尾换行（`load()` 会 strip）：

`prompts/writer/word_directive_default.md`:
```
遵从画像 `word_range`（默认 1500-2200）
```

`prompts/writer/first_person_on.md`:
```
brief 里的"候选锚点"要至少用 2 个写成第一人称的当下动作 / 反应，散在中段，不要堆在首尾。
```

`prompts/writer/first_person_off.md`:
```
brief 里的"候选锚点"是写作素材，挑最能把事讲清楚的用；本文体**不写第一人称经历 / 当下感受 / 个人观点**，保持中立。
```

`prompts/writer/structure_directive_asymmetric.md`:
```
- **结构**：不要按 brief 的提纲"等比例翻译"成文章——brief 是素材清单，不是文章骨架。落笔前先决定哪一个点是核心，其余点围着它转或直接丢掉。拒绝每节等深等宽的对称结构。
```

`prompts/writer/structure_directive_even.md`:
```
- **结构**：按上面的体裁结构块组织；步骤 / 维度该等重就等重，不必制造长短起伏。
```

`prompts/writer/humanizer_line.md`:
```
- **使用技能**: humanizer
```

- [ ] **Step 5: Commit**

```bash
git add prompts/writer/
git commit -m "feat(prompts): extract writer rule text into markdown fragments"
```

---

## Task 4: 改装 `pipeline_template.py` 从文件读文本

**Files:**
- Modify: `backend/pipeline_template.py`（导入、`GenreProfile`、`GENRE_PROFILES`、5 个 writer 装配器；删 `_WRITER_*` 常量与 `_writer_shortform_structure_md`/`_writer_wordcap_md`）
- 安全网: `backend/tests/test_writer_prompts_golden.py`、`backend/tests/test_genre_profiles.py`

- [ ] **Step 1: 确认 `structure_md` 无其他读取者**

Run: `grep -rn "structure_md" backend --include=*.py | grep -v __pycache__`
Expected: 仅 `pipeline_template.py` 自身（`GenreProfile`/`writer_rules_md`）。若 `tests/test_genre_profiles.py` 引用了 `structure_md`，本任务末尾一并改读 `structure_files`。

- [ ] **Step 2: 加导入**

在 `pipeline_template.py` 顶部 import 区加：

```python
from prompt_templates import load, render
```

- [ ] **Step 3: 删除被抽走的内联常量与函数**

删除这些定义（文本已搬进 `prompts/writer/`）：
- `_WRITER_WORDING_RULES_MD`（`:153`）
- `_WRITER_LONGFORM_STRUCTURE_MD`（`:179`）
- `_writer_shortform_structure_md`（函数，`:200`）
- `WRITER_ANTI_AI_RULES_MD`（`:211`）
- `_WRITER_TUTORIAL_STRUCTURE_MD`（`:217`）
- `_WRITER_REVIEW_STRUCTURE_MD`（`:229`）
- `_WRITER_STORY_STRUCTURE_MD`（`:240`）
- `_writer_wordcap_md`（函数，`:282`）

- [ ] **Step 4: 改 `GenreProfile` 与 `GENRE_PROFILES`**

`GenreProfile` 的 `structure_md: str` 改为：

```python
@dataclass(frozen=True)
class GenreProfile:
    key: str
    label: str
    structure_files: tuple[str, ...]   # writer/ 下结构块文件，按序拼接
    first_person: bool
    humanizer: bool
```

`GENRE_PROFILES` 改为引用文件：

```python
GENRE_PROFILES: dict[str, "GenreProfile"] = {
    "commentary": GenreProfile("commentary", "评论", ("writer/structure_longform.md",), True, True),
    "tutorial":   GenreProfile("tutorial", "教程", ("writer/structure_tutorial.md",), False, False),
    "story":      GenreProfile("story", "故事", ("writer/structure_longform.md", "writer/structure_story_extra.md"), True, True),
    "review":     GenreProfile("review", "测评", ("writer/structure_review.md",), False, False),
}
```

- [ ] **Step 5: 改写 5 个装配器**

替换为：

```python
def _wording_rules() -> str:
    return load("writer/wording_rules.md")


def _genre_structure_md(profile: "GenreProfile") -> str:
    return "\n\n".join(load(f) for f in profile.structure_files)


def writer_word_directive_md(c: RenderCtx) -> str:
    """writer body 的「字数」一行：方案给了字数就以方案为准，否则回退账号 word_range。"""
    spec = c.get("word_spec")
    if spec and spec.get("raw"):
        return render("writer/word_directive_plan.md", raw=spec["raw"])
    return load("writer/word_directive_default.md")


def writer_rules_md(c: RenderCtx) -> str:
    """按文体选规则块。commentary 短文案走 shortform 替换；其它文体 = 通用词汇块 +
    文体结构块（短文案再加字数封顶）。挑块逻辑保留在此，文本来自 prompts/writer/。"""
    profile = _genre_profile(c)
    spec = c.get("word_spec")
    short = _is_short_spec(spec)
    if profile.key == "commentary" and short:
        return _wording_rules() + "\n\n" + render("writer/structure_shortform.md", max_chars=spec["max"])
    parts = [_wording_rules(), _genre_structure_md(profile)]
    if short:
        parts.append(render("writer/wordcap.md", max_chars=spec["max"]))
    return "\n\n".join(parts)


def writer_first_person_anchor_md(c: RenderCtx) -> str:
    """writer 正文「候选锚点」指令：first_person 文体注入第一人称，否则给中立提示。"""
    name = "first_person_on" if _genre_profile(c).first_person else "first_person_off"
    return load(f"writer/{name}.md")


def writer_humanizer_line_md(c: RenderCtx) -> str:
    """humanizer 文体才输出该 bullet 行（含换行），否则空串。"""
    return load("writer/humanizer_line.md") + "\n" if _genre_profile(c).humanizer else ""


def writer_structure_directive_md(c: RenderCtx) -> str:
    """结构 bullet：评论/故事走反对称；教程/测评走等重结构。"""
    name = "asymmetric" if _genre_profile(c).key in ("commentary", "story") else "even"
    return load(f"writer/structure_directive_{name}.md")
```

> 注意 `writer_humanizer_line_md` 要 `+ "\n"`（原值含尾换行，文件被 `load()` strip 掉了）。

- [ ] **Step 6: golden 测试保持全绿（核心验证）**

Run: `conda run -n wems python -m pytest tests/test_writer_prompts_golden.py -q`
Expected: 7 passed（证明重构后 agent body 与重构前逐字相等）。

- [ ] **Step 7: genre profile 测试通过**

Run: `conda run -n wems python -m pytest tests/test_genre_profiles.py -q`
Expected: all passed（若 Step 1 发现引用 `structure_md`，已改读 `structure_files` 后应通过）。

- [ ] **Step 8: Commit**

```bash
git add pipeline_template.py tests/test_genre_profiles.py
git commit -m "refactor(pipeline): load writer rule text from prompts/, keep selection logic in Python"
```

---

## Task 5: 全量回归验证

**Files:** 无改动，仅验证。

- [ ] **Step 1: 跑 pipeline / studio / genre 相关测试**

Run: `conda run -n wems python -m pytest tests/test_genre_profiles.py tests/test_writer_prompts_golden.py tests/test_prompt_templates.py tests/test_pipeline_template_manual.py tests/test_pipeline_template_daily_plan.py -q`
Expected: all passed。

- [ ] **Step 2: 导入冒烟（确认无断裂引用）**

Run: `WMS_DATABASE_URL="sqlite+aiosqlite:///:memory:" WMS_DISABLE_SCHEDULER=1 conda run -n wems python -c "import pipeline_template, prompt_templates, routers.studio; print('import ok')"`
Expected: `import ok`。

- [ ] **Step 3: 验「改 md 即生效」（手动确认目标达成）**

临时编辑 `prompts/writer/word_directive_default.md` 加一个字 → 重跑 `pytest tests/test_writer_prompts_golden.py`（应有用到 default 的组合失败，证明文件被读取生效）→ 还原文件 → 测试复绿。**不提交此临时改动。**

- [ ] **Step 4: 全套测试基线对照**

Run: `conda run -n wems python -m pytest -q 2>&1 | tail -15`
Expected: 失败集合不超过既有基线（参考记忆：约 11 既存失败 + 2 flake），无本次新引入的失败。

---

## Self-Review

- **Spec coverage:** 目标(文件化+零Python改文本)→Task 3+4；render-in 确定性→Task 1 golden + Task 4 Step 6；加载器→Task 2；不放 skills/→Task 3 用 `prompts/writer/`；不碰 editor/illustrator/scout→范围仅 writer 装配器；改 md 即生效（无缓存）→Task 2 实现 + Task 5 Step 3 验证；blast radius→Task 4 Step 1/7。覆盖完整。
- **Placeholder scan:** 无 TBD/TODO；所有代码步骤含完整代码；抽取步骤给出确切源行号 + 变换规则 + golden 兜底。
- **Type consistency:** `GenreProfile.structure_files: tuple[str,...]` 在 Task 4 Step 4 定义、Step 5 `_genre_structure_md` 使用一致；加载器 `load`/`render` 签名在 Task 2 定义、Task 4 调用一致；占位符统一 `{{max_chars}}`/`{{raw}}`。
