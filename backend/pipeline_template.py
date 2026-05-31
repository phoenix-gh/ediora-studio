"""
Pipeline templates — 把"流程"从 agent SOUL.md 里挪出来集中管理。

Hermes-native 范式：流程 = 任务图结构，靠 dispatcher 跟 parent→child 自动驱动，
不靠 agent 主动派下游。`/studio/enqueue` 按 flow 字段查这里的蓝图，循环建 N 个任务，
前一棒做完 dispatcher 自动 promote 下一棒。

关键约束：`hermes kanban create` 不支持 `--metadata`（task-level metadata 在 Hermes
里只能由 worker `kanban_complete()` 写到 run 上）。所以：
- 账号画像 / 流程参数 → 直接渲染进每个 task 的 body（markdown 形式）
- 上游产出（draft_id / brief_md / cover_id）→ 上游 agent 完成时塞 run metadata，
  下游通过 `worker_context.parents[0].metadata` 自动拿

要改流程顺序、加棒、改 body，改这一个文件即可，不必动 SOUL.md。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Callable

RenderCtx = dict[str, Any]

def _normalize_material(text: str) -> str:
    """Convert raw material (HTML / plain text / markdown) to clean markdown."""
    if not text:
        return ""
    # Drop <script>/<style> blocks *with their contents* before markdownify
    # (markdownify's strip= removes the tags but keeps inner text).
    text = re.sub(r"<(script|style)\b[^>]*>.*?</\1>", "", text, flags=re.I | re.S)
    from markdownify import markdownify as _md
    out = _md(text, heading_style="ATX")
    return re.sub(r"\n{3,}", "\n\n", out).strip()


@dataclass
class PipelineStep:
    """单棒任务蓝图。enqueue 时按 ctx 渲染成真实 task。"""
    role: str                              # 逻辑角色（scout/editor/writer/illustrator）
    assignee: str                          # hermes profile（wms_scout/wms_editor/...）
    title: Callable[[RenderCtx], str]      # 任务标题渲染
    body: Callable[[RenderCtx], str]       # 任务 body（agent kanban_show 看到的内容）


# ── 画像渲染（按角色只给各自需要的字段）────────────────────────────

def _wr_str(p: dict[str, Any]) -> str:
    wr = p.get("word_range") or {}
    if isinstance(wr, dict):
        return f"{wr.get('min', '?')}-{wr.get('max', '?')} 字"
    return str(wr)


def render_profile_scout(profile: dict[str, Any]) -> str:
    """scout 只需校验选题是否踩禁区，只给 name/platform/topic_focus/taboo。"""
    p = profile
    lines = [
        "## 账号选题约束",
        f"- **name**: {p.get('name', '')}（{p.get('platform', '')}）",
    ]
    topic_focus = p.get("topic_focus") or []
    if topic_focus:
        lines.append("- **topic_focus**（选题范围，素材须落在此范围内）:")
        for it in topic_focus:
            lines.append(f"  - {it}")
    taboo = p.get("taboo") or []
    if taboo:
        lines.append("- **taboo**（禁区，触碰即 block）:")
        for it in taboo:
            lines.append(f"  - {it}")
    return "\n".join(lines)


def render_profile_editor(profile: dict[str, Any]) -> str:
    """editor 出 brief，需要定位/受众/字数/图风/语气/选题/禁区。"""
    p = profile
    lines = [
        "## 账号画像（brief 须完全对齐）",
        f"- **name**: {p.get('name', '')}（{p.get('platform', '')}）",
        f"- **positioning**: {p.get('positioning', '') or '(未填)'}",
        f"- **audience**: {p.get('audience', '') or '(未填)'}",
        f"- **tone**: {p.get('tone', '') or '(未填)'}",
        f"- **word_range**: {_wr_str(p)}",
        f"- **image_style**: {p.get('image_style', '') or '(未填)'}",
    ]
    topic_focus = p.get("topic_focus") or []
    if topic_focus:
        lines.append("- **topic_focus**（选题范围）:")
        for it in topic_focus:
            lines.append(f"  - {it}")
    taboo = p.get("taboo") or []
    if taboo:
        lines.append("- **taboo**（禁区）:")
        for it in taboo:
            lines.append(f"  - {it}")
    return "\n".join(lines)


def render_profile_writer(profile: dict[str, Any]) -> str:
    """writer 写稿，需要语气/受众/字数/voice_samples/style_rules/taboo。"""
    p = profile
    lines = [
        "## 账号写作约束",
        f"- **name**: {p.get('name', '')}（{p.get('platform', '')}）",
        f"- **tone**: {p.get('tone', '') or '(未填)'}",
        f"- **audience**: {p.get('audience', '') or '(未填)'}",
        f"- **word_range**: {_wr_str(p)}",
    ]
    taboo = p.get("taboo") or []
    if taboo:
        lines.append("- **taboo**（禁区，绝不能碰）:")
        for it in taboo:
            lines.append(f"  - {it}")
    style_rules = p.get("style_rules") or []
    if style_rules:
        lines.append("- **style_rules**（账号级硬规则，逐条遵守，优先于通用反 AI 腔）:")
        for it in style_rules:
            lines.append(f"  - {it}")
    voice_samples = p.get("voice_samples") or []
    if voice_samples:
        lines.append("- **voice_samples**（必读，模仿句长/口吻/节奏）:")
        for i, vs in enumerate(voice_samples, 1):
            lines.append(f"  {i}. > {vs}")
    return "\n".join(lines)


def _render_cover_style_override(override: dict | None) -> str:
    """Render an optional per-task cover_style override block. Returns ''
    when there's nothing to override (so the body template stays clean)."""
    if not override:
        return ""
    return (
        "\n## 用户本次覆盖的 cover_style 字段（仅列出与账号默认不同的，未列出的字段沿用上方账号默认）\n"
        "```json\n"
        + json.dumps(override, ensure_ascii=False, indent=2)
        + "\n```"
    )


def render_profile_illustrator(profile: dict[str, Any]) -> str:
    """illustrator 出封面，只需 image_style 和 cover_style。"""
    p = profile
    lines = [
        "## 账号视觉约束",
        f"- **name**: {p.get('name', '')}（{p.get('platform', '')}）",
        f"- **image_style**: {p.get('image_style', '') or '(未填)'}",
    ]
    cover_style = p.get("cover_style") or {}
    if cover_style:
        lines.append("- **cover_style**（封面硬约束，逐字段执行）:")
        lines.append("  ```json")
        lines.append(f"  {json.dumps(cover_style, ensure_ascii=False, indent=2)}")
        lines.append("  ```")
    return "\n".join(lines)


# 通用反 AI 腔约束 + 节奏要求 ── 注入 writer body（task-level 硬约束，
# 比 SOUL.md 距离当下任务更近，命中率更稳）。账号级 style_rules 可以覆盖单条。
#
# 拆成两块：词汇 / 语气 / 节奏（与篇幅无关，长短文都适用）和结构规则（长短文不同）。
# 长文沿用原有「段落长度强制不均（≥250 字段落）」等规则；短文案（如写作方案里的
# 100-200 字短帖）必须作废这些长文结构规则，否则物理上无法满足。
_WRITER_WORDING_RULES_MD = """
## 通用反 AI 腔（硬约束，账号 style_rules 可单条放行）
下列词汇 / 句式**全文禁用**，一次都不要出现：

- 套话：作为一个 AI、在这个数字化时代、综上所述、值得我们深思、毋庸置疑、不可否认、值得注意的是、众所周知、随着……的发展、在……的同时、与此同时
- 商业黑话：赋能、打造、生态、闭环、抓手、底层逻辑、深度、维度、范式、本质上、底层、向上
- 万能形容词：强大的、卓越的、前沿的、革命性的、颠覆性的、令人瞩目的、备受关注的
- 三段平行结构：「首先……其次……最后」「一方面……另一方面」「不仅……而且……更」
- 虚指连词收尾：不要以「因此」「所以」「总之」「由此可见」开新段

## 节奏要求（硬性）
- **句长参差**：相邻 3 句不允许长度都在 20-35 字区间；必须穿插 ≤12 字短句
- **具体 > 抽象**：每 300 字至少 1 处具体细节（人名 / 数字 / 时间 / 地名 / 引语 / 场景动作）
- **少用「的」**：单句「的」字 ≤ 2 个；3 个就重写
- **首段钩子**：前 50 字必须是场景 / 反差 / 数字 / 反问之一；禁概括式开场（「近年来」「在 X 领域」）

## 禁互动话术结尾
- 除非 voice_samples 出现过，否则禁：一键三连 / 点赞收藏 / 求关注 / 各位觉得有用 / 评论区聊聊 / 欢迎留言
- 默认结尾留白，或写一个**具体的、下一步会做的动作**（"明天我会拿它扫 2019 年的标记"），不喊话

## 增补禁词（一次都不准出现）
- 值得一提的是、通用考量、一部分拼图、生长/长出来、并行拉取、跨书关联、主题聚类
- 这一步用户看不到、但很重要 / 但同样重要 / 这是关键的一步
- "覆盖了 X、Y、Z 三个场景"（标准 AI 总结句）
""".strip()

_WRITER_LONGFORM_STRUCTURE_MD = """
## 反模板结构（硬性）
AI 写作最明显的特征之一是结构对称、篇幅均摊。以下全部禁止：

- **禁对称大纲**：不要写「引言 → 4 层拆解 → 反方声音 → 建议」这类等深结构。真实文章里有的点只值一句话，有的值 600 字，深度天然不均。
- **禁过渡归纳句**：段落之间不要用句子归纳上文或引出下文。不要写「以上说明了 X」「接下来看 Y」「这就是为什么 Z 很重要」。直接跳。
- **禁归因总结**：不要写「X 解决了 Y 的痛点」「Z 的本质是 W」「这套机制让 A 得以 B」——这类句子是 AI 在帮读者"消化"，真实作者不这么干。
- **禁均匀分配**：如果有 3 个论点，允许第 1 个占 60% 篇幅，第 2 个两句带过，第 3 个干脆砍掉。不要"每个都照顾到"。
- **允许跳跃**：可以突然换话题不铺垫，可以提出问题不收口，可以同一个词连用两次不换同义词。真实写作有毛刺。

## 段落长度强制不均（关键，单独自检）
- 全文必须存在 ≥1 段 ≤ 40 字，且 ≥1 段 ≥ 250 字
- 不允许相邻 3 段字数都落在 80-180 区间
- brief 里有 N 个点，**不要写成 N 个等长段**——核心点占 ≥40%，次要点两句带过或砍掉

## 强制具体化（在「具体 > 抽象」之上加权）
- 全文至少 2 处第一人称当下动作 + 当下感受：「我点了 X，看到 Y，愣了一下」
- 这类锚点散在中段，不能都堆在首尾
""".strip()


def _writer_shortform_structure_md(max_chars: int) -> str:
    return f"""
## 短文案结构（硬性，最高优先级）
本文是 **≤ {max_chars} 字的短文案**，上方「段落长度强制不均」「≥250 字段落」类长文结构规则**全部作废**。
- **总字数严格 ≤ {max_chars} 字**：宁短勿长，超出即不合格；写完数一遍字数再交。
- 不分小标题、不写引言/结语、不堆砌段落；一个核心案例 + 一句洞察收尾即可。
- 至少 1 处具体细节（人名 / 数字 / 时间 / 引语），但不要为凑字数注水。
""".strip()


# 长文的完整反 AI 腔规则（词汇 + 长文结构）── 既有 full / topic_long 流程沿用。
WRITER_ANTI_AI_RULES_MD = _WRITER_WORDING_RULES_MD + "\n\n" + _WRITER_LONGFORM_STRUCTURE_MD


# ── 文体预设（genre）：每文体一套结构块 + first_person/humanizer 开关 ──────────
# writer_rules_md / writer body / editor body 都按 ctx['genre'] 查表分流。
# 缺省 / 非法 genre → commentary（= 现状，保证 topic/rewrite 等无 genre 流程不变）。
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


def _is_short_spec(spec: dict | None, threshold: int = 500) -> bool:
    return bool(spec and spec.get("max") and spec["max"] <= threshold)


def writer_word_directive_md(c: RenderCtx) -> str:
    """writer body 的「字数」一行：方案给了字数就以方案为准，否则回退账号 word_range。"""
    spec = c.get("word_spec")
    if spec and spec.get("raw"):
        return (f"严格 **{spec['raw']}**（写作方案硬规格，**超出即不合格**；"
                f"忽略上方画像 word_range）")
    return "遵从画像 `word_range`（默认 1500-2200）"


def writer_rules_md(c: RenderCtx) -> str:
    """按篇幅选反 AI 腔规则块：短文案用短结构，否则用长文结构。"""
    spec = c.get("word_spec")
    if _is_short_spec(spec):
        return _WRITER_WORDING_RULES_MD + "\n\n" + _writer_shortform_structure_md(spec["max"])
    return WRITER_ANTI_AI_RULES_MD


_WORD_RANGE_RE = re.compile(r"(\d{2,4})\s*[-~–—至到]\s*(\d{2,4})\s*字")
_WORD_BOUND_RE = re.compile(r"(?:不超过|最多|上限|≤|<=)?\s*(\d{2,4})\s*字(?:以内|以下|左右|上限)?")


def parse_word_spec(text: str) -> dict | None:
    """从写作方案 / brief 自由文本里解析字数规格。

    支持「100-200字」「200字以内」「不超过 300 字」等写法。
    返回 {min, max, raw}（min 可能为 None）；解析不到返回 None（writer 回退 word_range）。
    """
    if not text:
        return None
    m = _WORD_RANGE_RE.search(text)
    if m:
        lo, hi = sorted((int(m.group(1)), int(m.group(2))))
        return {"min": lo, "max": hi, "raw": f"{lo}-{hi} 字"}
    m = _WORD_BOUND_RE.search(text)
    if m:
        n = int(m.group(1))
        return {"min": None, "max": n, "raw": f"{n} 字以内"}
    return None


def resolve_effective_design(
    account_cover: dict | None, account_image: str,
    plan_cover: dict | None, plan_image: str,
    task_cover: dict | None = None, task_image: str | None = None,
) -> tuple[dict, str]:
    """Merge cover_style / image_style across account < plan < task layers.

    cover_style: per-key overlay — 高层的非空值逐键覆盖低层（空 dict / 空值不动）。
    image_style: 取 task > plan > account 第一个非空字符串。
    """
    cover: dict = dict(account_cover or {})
    for layer in (plan_cover, task_cover):
        for k, v in (layer or {}).items():
            if v not in (None, "", [], {}):
                cover[k] = v
    image = next((s for s in (task_image, plan_image, account_image) if s), "")
    return cover, image


_INLINE_ILLUS_RE = re.compile(r"<!-- wms-illus -->.*?<!-- /wms-illus -->", re.S)


def strip_inline_illus(md: str) -> str:
    """剥掉所有 <!-- wms-illus -->...<!-- /wms-illus --> 块（系统自动插入的正文配图），
    折叠残留空行。无标记时原样返回（保留末尾换行等）。"""
    if not md or "<!-- wms-illus -->" not in md:
        return md
    out = _INLINE_ILLUS_RE.sub("", md)
    return re.sub(r"\n{3,}", "\n\n", out).strip()


def _user_body_md(ctx: RenderCtx) -> str:
    """渲染用户提交的原始素材块（scout 棒用）。"""
    parts: list[str] = []
    if ctx.get("summary"):
        parts.append(ctx["summary"])
    if ctx.get("content"):
        content = _normalize_material(ctx["content"])
        if ctx.get("content_truncated"):
            content = content + "\n…(已截断)"
        parts.append(content)
    if ctx.get("note"):
        parts.append(f"\n---\n用户备注：{ctx['note']}")
    return "\n\n".join(parts) if parts else "(用户未附正文，仅链接)"


# ── full：标准创作流程 editor → writer → illustrator ───────────────────
# scout 已移除：素材由用户在 UI 上手动挑入，已经过人工筛选，不需要 agent 再做选题校验。
# editor 直接读原始素材并抽取锚点（原 scout 的活），后续步骤不变。
FULL_PIPELINE: list[PipelineStep] = [
    PipelineStep(
        role="editor",
        assignee="wms_editor",
        title=lambda c: f"策划：{c['title']}",
        body=lambda c: f"""account_id: {c['account_id']}
platform: {c.get('platform') or 'unknown'}
source_url: {c.get('source_url') or ''}

# {c['title']}

{render_profile_editor(c['account_profile'])}

## 原始素材（用户从 UI 手动挑入，已过人工筛选）
{_user_body_md(c)}

## 这棒任务（editor · 直接读原始素材，抽锚点 + 出 brief）
先从原始素材里抽**具体锚点 ≥ 3 个**（任选：原文里的数字 / 人名 / 时间 / 地名 / 引语 / 动作场景）——
下游 writer 靠这些锚点写"我看到 X 时 Y"，缺它就只能写 AI 味的概括。如需查原文链接可调 web 工具。

**重要：brief 是给 writer 的素材清单，不是文章骨架。**
writer 不会照搬 brief 的小节顺序逐节展开 —— 你也不要把 brief 写成"等比例 7 节"诱导他这么做。
明确一个**核心点**，其余素材围绕它转或允许被砍。

按上方画像写 brief，要点（不必都用，按需取舍）：

- **angle**（核心角度，对齐 audience，≤ 30 字）
- **core_point**（本文唯一最重要的点，写一句话；writer 必须把它当主线，篇幅 ≥40%）
- **secondary_points**（次要点 ≤ 3 个，每个标注权重：keep / mention / drop_ok）
- **必须出现的事实** 3-5 条（每条带原始链接 + 一个具体细节：数字 / 人名 / 时间 / 场景）
- **反方/补充观点** ≥ 1 条
- **候选锚点**（具体的、可第一人称代入的场景或动作，≥ 2 个，writer 拿来做"我看到 X"那种锚句）
- **平台与字数**：用 word_range
- **配图思路**：贴合 image_style
- **候选标题** ≥ 3（语气贴 tone）
- **候选金句**（list_quotes 挑 1-2，只作备选，writer 可不用）
- **禁区提醒**（画像 taboo）

**brief 写作禁忌：**
- 不要写"开头—4 层拆解—结尾"这种对称大纲
- 不要给 writer 列"每段写什么"的逐段提纲
- 不要写"建议结构：…"——结构由 writer 现场决定

完成时：
- `kanban_complete(summary='brief 完成: <一句话角度>', metadata={{"topic_id": ..., "brief_md": "<完整 brief markdown>", "brief_chars": N, "core_point": "<一句话>"}})`
""".strip(),
    ),
    PipelineStep(
        role="writer",
        assignee="wms_writer",
        title=lambda c: f"写稿：{c['title']}",
        body=lambda c: f"""account_id: {c['account_id']}
pipeline_task_id: {c['pipeline_task_id']}

# {c['title']}

{render_profile_writer(c['account_profile'])}

## Editor Brief
从 `metadata['brief_md']` 读取完整 brief Markdown。
从 `metadata['core_point']` 读取主线一句话（篇幅必须 ≥40%）。

## 这棒任务（writer · 出初稿）
**brief 是素材清单，不是骨架。** 不要把 brief 的小节顺序当大纲逐节展开。
落笔前先决定：哪一个点是核心（用 core_point），其余点围着它转或直接丢掉（看 secondary_points 的 drop_ok 标记）。
brief 里的"候选锚点"要至少用 2 个写成第一人称的当下动作 / 反应，散在中段，不要堆在首尾。

按 brief + 上方画像写 Markdown 初稿：

- **字数**：{writer_word_directive_md(c)}，整篇 Markdown，**不要拆 thread / 短帖串**
- **句长 / 口吻 / 节奏**：严格贴 `voice_samples`，模仿其句长起伏
- **硬约束**：逐条遵守 `style_rules`（账号级规则优先于下方通用反 AI 腔）
- **避开** `taboo`（话题 / 词汇 / 立场）
- **标题**：从 brief 候选挑或综合自创（贴 `tone`）
- **使用技能**: humanizer
- **写作习惯**: 逗号,句号全用半角, 句号后面偶尔会连续两三个空格.
- **结构**：不要按 brief 的提纲"等比例翻译"成文章——brief 是素材清单，不是文章骨架。落笔前先决定哪一个点是核心，其余点围着它转或直接丢掉。拒绝每节等深等宽的对称结构。

{writer_rules_md(c)}

## 工作流（硬性，省 turn）
本任务**没有 file / code_execution / terminal 工具**，全部在 message 中完成：

1. 在 message 里**一次性**写出完整 Markdown 终稿（不要落本地文件，不要 patch 迭代，不要先发初稿再修订）
2. `save_draft(title, content, topic_id='agent', status='drafting', pipeline_task_id={c['pipeline_task_id']}, draft_type='{c.get('draft_type', 'article')}')` 拿 `draft_id`
3. `kanban_complete(summary='<标题> 初稿 N 字', metadata={{"draft_id": ..., "wordcount": N}})`

目标：从写稿到 complete **≤ 3 turn**。
""".strip(),
    ),
    PipelineStep(
        role="illustrator",
        assignee="wms_illustrator",
        title=lambda c: f"配图：{c['title']}",
        body=lambda c: f"""account_id: {c['account_id']}

# {c['title']}

{render_profile_illustrator(c['account_profile'])}

## 这棒任务（illustrator · 链路尾段，出封面即交付）
`draft_id` 从 `worker_context.parents[0].metadata['draft_id']` 读取（writer 完成时写入）。
用 `get_draft(<draft_id>)` 读正文 title + 前 1000 字定调。

按上方 `cover_style`（若空回退 `image_style`）调 cover-image 技能：
- 把 `cover_style.type / palette / rendering / text / mood / aspect_ratio` 灌进 prompt
- `signature_motifs` 每条**逐字嵌入** prompt（账号视觉一致性的关键）
- `negative` 每条加进 negative 段
- 公众号 / X 都用 16:9，视频号 1:1

调用 `baoyu-cover-image` 技能生成封面（技能内部 backend 固定为 codex_imagegen，禁用 image_generate）。
失败时 `kanban_block(reason='封面生成失败: <err>')`。
得到本地文件路径后，用 `upload_image_from_path(path=<本地路径>, filename_hint='cover.png', draft_id=<draft_id>)` 挂到 draft 图库。

完成即整条链路交付：
- **不要 `update_draft`**（draft 保持 writer 设置的 `drafting` 状态）
- 用户在草稿箱手动复审
- `kanban_complete(summary='封面已生成 <type/palette>，链路交付', metadata={{"draft_id": ..., "cover_url": ..., "cover_image_id": ...}})`
""".strip(),
    ),
]


# ── cover_only：仅重画封面（用户在草稿箱手动触发） ──────────────────
COVER_ONLY_PIPELINE: list[PipelineStep] = [
    PipelineStep(
        role="illustrator",
        assignee="wms_illustrator",
        title=lambda c: f"重画封面：draft #{c['draft_id']}",
        body=lambda c: f"""flow: cover_only
run_id: {c.get('run_id') or 'manual'}
draft_id: {c['draft_id']}
account_id: {c['account_id']}

{render_profile_illustrator(c['account_profile'])}

## 这棒任务（单棒交付）
用户从草稿箱手动触发的封面重生成。
`get_draft({c['draft_id']})` 读 title + 前 1000 字定调。
按上方 `cover_style`（含 `aspect_ratio`，若未指定默认 16:9）生成封面，filename=`cover_<timestamp>.png` 挂到 draft 图库。
完成即交付（**不要** `update_draft`）。
{_render_cover_style_override(c.get('cover_style_override'))}

{f"用户备注：{c['note']}" if c.get('note') else ''}

`kanban_complete(summary='封面已重生成', metadata={{"draft_id": {c['draft_id']}}})`
""".strip(),
    ),
]


# ── rewrite_only：用户在草稿箱手动触发，重写正文（继承原 editor brief 上下文）──
REWRITE_ONLY_PIPELINE: list[PipelineStep] = [
    PipelineStep(
        role="writer",
        assignee="wms_writer",
        title=lambda c: f"重写：draft #{c['draft_id']}",
        body=lambda c: f"""flow: rewrite_only
draft_id: {c['draft_id']}
account_id: {c['account_id']}

# {c['title']}

{render_profile_writer(c['account_profile'])}

## Editor Brief（继承自上游 editor）
从 `worker_context.parents[0].metadata` 读 `brief_md` + `core_point`（与首次撰写同源，brief 不变）。

## 这棒任务（writer · 重写正文 → 覆盖原 draft）
**用户从草稿箱手动触发重写**。已有 `draft_id={c['draft_id']}`，**不要 save_draft 新建**，
写完直接 `update_draft` 覆盖原内容（topic_id / 关联关系都保留）。

按 brief + 上方画像重写 Markdown：

- **字数**：{writer_word_directive_md(c)}，整篇 Markdown，**不要拆 thread / 短帖串**
- **句长 / 口吻 / 节奏**：严格贴 `voice_samples`
- **硬约束**：逐条遵守 `style_rules`（账号级规则优先于下方通用反 AI 腔）
- **避开** `taboo`
- **使用技能**: humanizer
- **写作习惯**: 逗号,句号全用半角, 句号后面偶尔会连续两三个空格.
- **结构**：拒绝按 brief 等比例展开，拒绝对称结构。core_point 占 ≥40%。

{writer_rules_md(c)}

{f"## 用户重写说明（必读）{chr(10)}{c['note']}" if c.get('note') else ''}

## 工作流（硬性，省 turn）
本任务**没有 file / code_execution / terminal 工具**，全部在 message 中完成：

1. 在 message 里**一次性**写出完整 Markdown 终稿（不要落本地文件，不要 patch 迭代，不要先发初稿再修订）
2. `update_draft(draft_id={c['draft_id']}, title='<新标题>', content='<新正文>', status='drafting')`
3. `kanban_complete(summary='<标题> 重写 N 字', metadata={{"draft_id": {c['draft_id']}, "wordcount": N, "rewrite": True}})`

目标：从写稿到 complete **≤ 3 turn**。
""".strip(),
    ),
]


# ── topic_long：热点选题完整链路 editor → writer → illustrator ─────────────
# 与 FULL_PIPELINE 的差异：editor 接收 AI 给出的选题角度 + X source posts，
# 而非用户提交的原始文章 URL + 正文。writer/illustrator 步骤完全复用 FULL_PIPELINE。

def _render_source_posts_md(source_posts_md: str) -> str:
    return source_posts_md or "（无参考帖子）"


TOPIC_LONG_PIPELINE: list[PipelineStep] = [
    PipelineStep(
        role="editor",
        assignee="wms_editor",
        title=lambda c: f"策划：{c['title']}",
        body=lambda c: f"""account_id: {c['account_id']}
content_type: {c['content_type']}

# {c['title']}

{render_profile_editor(c['account_profile'])}

## 角度（AI 给定，直接用）
{c['angle']}

## 体裁约束
**类型**: {c['content_type_label']}（{c['word_range']}）

## 热点选题来源（X 帖子）
{_render_source_posts_md(c['source_posts_md'])}

## 这棒任务（editor · 扩充锚点 + 出 brief）
角度已由选题生成器给定，**不要重新推导角度**。
你的职责是：
1. 从 source posts 和网络搜索中提取 ≥ 3 个具体锚点（数字/人名/时间/地名/引语/场景动作）
2. 按上方画像出 brief，格式：

- **core_point**（本文唯一最重要的点，一句话；writer 必须把它当主线，篇幅 ≥40%）
- **secondary_points**（次要点 ≤ 3 个，每个标注权重：keep / mention / drop_ok）
- **必须出现的事实** 3-5 条（每条带原始链接 + 一个具体细节）
- **候选锚点** ≥ 2 个（具体的、可第一人称代入的场景或动作）
- **反方/补充观点** ≥ 1 条
- **平台与字数**：{c['word_range']}
- **候选标题** ≥ 3（语气贴 tone）
- **禁区提醒**

完成时：
- `kanban_complete(summary='brief 完成: <一句话角度>', metadata={{"topic_id": ..., "brief_md": "<完整 brief markdown>", "brief_chars": N, "core_point": "<一句话>"}})`
""".strip(),
    ),
    FULL_PIPELINE[1],  # writer — same ctx keys: account_id/title/account_profile/pipeline_task_id
    FULL_PIPELINE[2],  # illustrator — same ctx keys
]


# ── topic_short：热点选题 writer 单棒（short / story / share） ──────────────
def _topic_short_type_requirement(c: RenderCtx) -> str:
    t = c['content_type']
    if t == 'story':
        return "只写 **5-6 句话**。讲一个发生在身边的真实瞬间——有细节、有情绪、让人想转发。不要超过 6 句。"
    if t == 'share':
        return "只写 **3-5 句话** + 一句「为什么值得关注」。格式参考：发现一个…支持…核心亮点是…值得关注的原因是…"
    return "**200-500 字**，X 风格，一个核心观点，语气犀利。不要分节，不要标题，直接开写。"


TOPIC_SHORT_PIPELINE: list[PipelineStep] = [
    PipelineStep(
        role="writer",
        assignee="wms_writer",
        title=lambda c: f"写稿：{c['title']}",
        body=lambda c: f"""account_id: {c['account_id']}
pipeline_task_id: {c['pipeline_task_id']}

# {c['title']}

{render_profile_writer(c['account_profile'])}

## 体裁要求（硬约束）
{_topic_short_type_requirement(c)}

## 角度
{c['angle']}

## 参考帖子（X）
{_render_source_posts_md(c['source_posts_md'])}

## 工作流（硬性，省 turn）
本任务**没有 file / code_execution / terminal 工具**，全部在 message 中完成：

1. 在 message 里**一次性**写出完整文本终稿
2. `save_draft(title='<本文标题>', content='<正文>', topic_id='agent', status='drafting', pipeline_task_id={c['pipeline_task_id']})` 拿 `draft_id`
3. `kanban_complete(summary='<标题> {c['content_type_label']}完成', metadata={{"draft_id": ..., "wordcount": N}})`

目标：从写稿到 complete **≤ 2 turn**。
""".strip(),
    ),
    PipelineStep(
        role="illustrator",
        assignee="wms_illustrator",
        title=lambda c: f"配图：{c['title']}",
        body=lambda c: f"""account_id: {c['account_id']}

# {c['title']}

## 图片风格参考（宽松，优先贴内容而非品牌一致性）
- image_style: {c['account_profile'].get('image_style') or '（未填，自由发挥）'}
- 无需严格套用账号封面模板，以**内容相关性和视觉吸引力**为首要标准

## 这棒任务（illustrator · 链路尾段，出封面即交付）
`draft_id` 从 `worker_context.parents[0].metadata['draft_id']` 读取（writer 完成时写入）。
用 `get_draft(<draft_id>)` 读正文 title + 前 500 字定调。

调用 `baoyu-cover-image` 技能生成封面：
- aspect_ratio: 16:9（公众号 / X 通用）
- prompt 以内容主题为核心，风格参考 `image_style`（若为空则自由发挥）
- **不必**照搬 signature_motifs 或 cover_style 细节

失败时 `kanban_block(reason='封面生成失败: <err>')`。
得到本地文件路径后，用 `upload_image_from_path(path=<本地路径>, filename_hint='cover.png', draft_id=<draft_id>)` 挂到 draft 图库。

完成即整条链路交付：
- **不要 `update_draft`**（draft 保持 writer 设置的 `drafting` 状态）
- `kanban_complete(summary='封面已生成，链路交付', metadata={{"draft_id": ..., "cover_url": ..., "cover_image_id": ...}})`
""".strip(),
    ),
]


# ── illustrate_body：正文配图，用户在草稿箱手动触发的单棒 ──────────────
# 服务端在派发前已用 strip_inline_illus 清掉上一轮自动插图，agent 在干净正文上插新图。
def _inline_illus_note_md(c: RenderCtx) -> str:
    return f"5. 用户备注（必读）：{c['note']}\n" if c.get("note") else ""


INLINE_ILLUS_PIPELINE: list[PipelineStep] = [
    PipelineStep(
        role="illustrator",
        assignee="wms_illustrator",
        title=lambda c: f"正文配图：draft #{c['draft_id']}",
        body=lambda c: f"""flow: illustrate_body
draft_id: {c['draft_id']}
account_id: {c['account_id']}

## 视觉约束
- image_style: {c['account_profile'].get('image_style') or '（未填，自由发挥）'}

## 这棒任务（illustrator · 正文配图，单棒交付）
`get_draft({c['draft_id']})` 读正文（系统已清掉上一轮自动插图，正文是干净的）。

1. 分析正文的 H2 小节 / 段落结构，在**小节边界**挑 **≤ {c['max_images']} 个**插图点：
   - 只在内容值得配图的小节配；短小节、过渡段可不配；不要为凑数硬配。
   - 插图点落在小节之间，**绝不插在句子或段落中间**。
2. 每个插图点：按 `image_style` + 该小节主题，调 `baoyu-cover-image` 技能生成**内容插图**：
   - **不套封面 cover_style 模板、不放标题文字**；aspect_ratio 默认 16:9；以内容相关性与视觉吸引力为先。
   - 生成失败就**跳过该点继续**，不要整体中断。
   - 得到本地路径后 `upload_image_from_path(path=<本地路径>, filename_hint='illus.png', draft_id={c['draft_id']})` 拿 `hosted_url`。
3. 组装新正文：每张图在选定边界插入，**必须逐字裹注释壳**（用于幂等重跑）：

<!-- wms-illus -->
![<一句话 alt，描述图意>](<hosted_url>)
<!-- /wms-illus -->

4. **一次** `update_draft(draft_id={c['draft_id']}, content=<带配图的完整新正文>)`（不要多次 patch）。
{_inline_illus_note_md(c)}一张都没成才 `kanban_block(reason='正文配图失败: <err>')`。
完成：`kanban_complete(summary='正文配图 N 张', metadata={{"draft_id": {c['draft_id']}, "image_count": N}})`
""".strip(),
    ),
]


PIPELINES: dict[str, list[PipelineStep]] = {
    "full": FULL_PIPELINE,
    "cover_only": COVER_ONLY_PIPELINE,
    "rewrite_only": REWRITE_ONLY_PIPELINE,
    "topic_long": TOPIC_LONG_PIPELINE,
    "topic_short": TOPIC_SHORT_PIPELINE,
    "illustrate_body": INLINE_ILLUS_PIPELINE,
}


def get_pipeline(flow: str) -> list[PipelineStep]:
    """根据 flow 字段查询蓝图。"""
    if flow not in PIPELINES:
        raise ValueError(f"unknown flow '{flow}'; available: {sorted(PIPELINES)}")
    return PIPELINES[flow]
