# 参考文案清洗管道重做 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重做 RefMaterial 清洗线——规则+本地信号守门（采集即入库零 LLM 依赖），LLM 降级为低频补分类；新增神回复子管道。

**Architecture:** 三个新纯函数/子管道模块（`ref_signals` 打分、`text_dedupe` 近重复、`reply_scout` 神回复），`ref_collector.collect_rule` 重写为漏斗（prefilter→seen→近重复→打分→入库 active），`clean_batch` 重写为 `classify_batch`（只补 category/scene_tags）。神回复经 `fetch_tweet_detail` 抓回复、同规则清洗后作为带 `parent_source_id` 的独立素材入库。

**Tech Stack:** FastAPI + SQLAlchemy async、feedgrab（twitter_thread/twitter_cookies）、pytest（`conda run -n wems`，cwd=backend）、Next.js 前端（写前端前读 `node_modules/next/dist/docs/`）。

**Spec:** `docs/superpowers/specs/2026-06-10-ref-cleaning-pipeline-design.md`

**前置事实（精读代码已确认）：**
- ref 线数据源是库内 `x_posts` 表（XPost），不直接调 feedgrab 搜索
- `fetch_tweet_detail(tweet_id, cookies)` 返回原始 GraphQL dict；`parse_tweet_entries(resp)` → entries；`_parse_entries_to_tweets(entries)` → tweet dicts，字段：`id/text/author(screen_name)/author_name/in_reply_to_status_id/likes/retweets/replies/views(字符串!)/created_at(Twitter格式)/possibly_sensitive/images`
- cookies 经 `feedgrab.fetchers.twitter_cookies.load_twitter_cookies()`，需 `auth_token`+`ct0`
- 既存失败测试：`test_ref_classify.py` 2 个、`test_ref_collector.py` 2 个——本计划重写这两个文件
- 测试命令前缀：`conda run -n wems python -m pytest`（cwd `/workspace/projects/WeMediaStudio/backend`）

---

## File Structure

| 文件 | 操作 | 职责 |
|---|---|---|
| `backend/ref_signals.py` | 新建 | log1p 加权互动打分（纯函数） |
| `backend/text_dedupe.py` | 新建 | 3-gram+词级 Jaccard 近重复（纯函数） |
| `backend/reply_scout.py` | 新建 | 神回复抓取/清洗/入库子管道 |
| `backend/models.py` | 修改 | RefMaterial 加 `parent_source_id` |
| `backend/ref_collector.py` | 重写大半 | collect_rule 新漏斗；clean_batch→classify_batch；共享 helpers |
| `backend/llm.py` | 修改 | classify_ref_posts→classify_ref_categories |
| `backend/scheduler.py` | 修改 | ref_clean job→ref_classify；ref_collect 尾部接 scout |
| `backend/config.py` | 修改 | DEFAULTS 增 5 删 1 |
| `backend/routers/settings.py` | 修改 | ref_clean_interval_minutes→ref_classify_interval_minutes |
| `backend/routers/materials.py` | 修改 | clean-batch→classify-batch；collect 返回值；collect-all 接 scout |
| `web/lib/api/materials.ts` | 修改 | classifyBatch/类型连动 |
| `web/lib/api/settings.ts` | 修改 | 字段改名 |
| `web/app/settings/sections/XSection.tsx` | 修改 | 绑定改名后的字段 |
| `web/app/materials/MaterialsClient.tsx` | 修改 | 按钮/徽章/文案 |
| `backend/tests/test_ref_signals.py` | 新建 | 打分单测 |
| `backend/tests/test_text_dedupe.py` | 新建 | 去重单测 |
| `backend/tests/test_reply_scout.py` | 新建 | 神回复单测 |
| `backend/tests/test_ref_classify.py` | 重写 | 轻量分类单测 |
| `backend/tests/test_ref_collector.py` | 重写 | 新漏斗+classify_batch 单测 |

依赖序：Task 1/2 独立 → Task 3（模型）→ Task 4（llm）→ Task 5（collect 漏斗，依赖 1/2/3）→ Task 6（classify_batch+router，依赖 4/5）→ Task 7（reply_scout，依赖 5）→ Task 8（scheduler/config/settings）→ Task 9（前端）→ Task 10（回归+清理）。

---

## Task 1: ref_signals.py 打分纯函数

**Files:**
- Create: `backend/ref_signals.py`
- Test: `backend/tests/test_ref_signals.py`

- [ ] **Step 1: 写失败测试**

Create `backend/tests/test_ref_signals.py`:

```python
from ref_signals import engagement_score


def test_zero_engagement_is_zero():
    assert engagement_score(0, 0, 0, 0) == 0


def test_monotonic_in_likes():
    low = engagement_score(100, 0, 0, 0)
    high = engagement_score(10_000, 0, 0, 0)
    assert 0 < low < high


def test_anchor_points_default_scale():
    # 纯 likes 单维锚点：1 千赞 ≈ 57，1 万赞 ≈ 76（容差 ±3）
    assert abs(engagement_score(1_000, 0, 0, 0) - 57) <= 3
    assert abs(engagement_score(10_000, 0, 0, 0) - 76) <= 3


def test_capped_at_100():
    assert engagement_score(10**9, 10**9, 10**9, 10**9) == 100


def test_views_dampened():
    # views 单独贡献远小于同数值的 likes
    assert engagement_score(0, 0, 0, 10_000) < engagement_score(10_000, 0, 0, 0)


def test_negative_inputs_treated_as_zero():
    assert engagement_score(-5, -1, -1, -100) == 0


def test_scale_configurable():
    assert engagement_score(1_000, 0, 0, 0, scale=10.0) < engagement_score(1_000, 0, 0, 0, scale=18.5)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `conda run -n wems python -m pytest tests/test_ref_signals.py -v`
Expected: FAIL（`ModuleNotFoundError: No module named 'ref_signals'`）

- [ ] **Step 3: 实现**

Create `backend/ref_signals.py`:

```python
"""本地互动信号打分：log1p 加权 + 绝对对数刻度，跨批可比。

权重沿用 last30days signals.py 的 X 配方，外加 views 维度。
绝对刻度（而非批内 min-max）：流式采集下保证不同批次的分数语义一致。
锚点（scale=18.5，纯 likes 单维）：1 千赞≈57、1 万赞≈76、10 万赞≈95。
"""
from __future__ import annotations
import math

DEFAULT_SCALE = 18.5


def engagement_score(
    likes: int, reposts: int, replies: int, views: int,
    *, scale: float = DEFAULT_SCALE,
) -> int:
    raw = (
        0.45 * math.log1p(max(0, likes or 0))
        + 0.25 * math.log1p(max(0, reposts or 0))
        + 0.15 * math.log1p(max(0, replies or 0))
        + 0.15 * math.log1p(max(0, views or 0) / 100)
    )
    return round(min(100.0, scale * raw))
```

- [ ] **Step 4: 跑测试确认通过**

Run: `conda run -n wems python -m pytest tests/test_ref_signals.py -v`
Expected: 7 passed

- [ ] **Step 5: Commit**

```bash
git -C /workspace/projects/WeMediaStudio add backend/ref_signals.py backend/tests/test_ref_signals.py
git -C /workspace/projects/WeMediaStudio commit -m "feat(ref): 本地互动信号打分模块 ref_signals"
```

---

## Task 2: text_dedupe.py 近重复检测

**Files:**
- Create: `backend/text_dedupe.py`
- Test: `backend/tests/test_text_dedupe.py`

- [ ] **Step 1: 写失败测试**

Create `backend/tests/test_text_dedupe.py`:

```python
from text_dedupe import PreparedText, similarity, normalize_text


def test_normalize_strips_punct_and_lowercases():
    assert normalize_text("Hello, 世界！！World") == "hello 世界 world"


def test_identical_chinese_is_1():
    a = PreparedText("今天的打工人语录：上班是为了下班")
    assert similarity(a, a) == 1.0


def test_near_duplicate_chinese_above_threshold():
    # 洗稿场景：同一个段子小改几个字
    a = PreparedText("打工人的尽头是带薪拉屎，一天不拉浑身难受")
    b = PreparedText("打工人的尽头就是带薪拉屎，一天不拉感觉浑身难受")
    assert similarity(a, b) >= 0.7


def test_different_texts_below_threshold():
    a = PreparedText("今天股市大跌，韭菜们瑟瑟发抖")
    b = PreparedText("程序员的浪漫就是给女朋友写个小程序")
    assert similarity(a, b) < 0.3


def test_mixed_language_token_side():
    a = PreparedText("用 ChatGPT 写周报 真香")
    b = PreparedText("用 ChatGPT 写周报，真香！")
    assert similarity(a, b) >= 0.7


def test_empty_text_zero():
    assert similarity(PreparedText(""), PreparedText("非空")) == 0.0
```

- [ ] **Step 2: 跑测试确认失败**

Run: `conda run -n wems python -m pytest tests/test_text_dedupe.py -v`
Expected: FAIL（ModuleNotFoundError）

- [ ] **Step 3: 实现**

Create `backend/text_dedupe.py`:

```python
"""近重复文本检测：字符 3-gram Jaccard 与词级 Jaccard 取 max。

中文 3-gram 无需分词即有效；词级按空白粗切管中英混排。
移植自 last30days dedupe.py 的混合策略。阈值约定 0.7。
"""
from __future__ import annotations
import re

_NON_WORD_RE = re.compile(r"[^\w\s]", re.UNICODE)
_WS_RE = re.compile(r"\s+")

DEFAULT_THRESHOLD = 0.7


def normalize_text(text: str) -> str:
    text = _NON_WORD_RE.sub(" ", (text or "").lower())
    return _WS_RE.sub(" ", text).strip()


def _char_ngrams(norm: str, n: int = 3) -> frozenset[str]:
    compact = norm.replace(" ", "")
    if not compact:
        return frozenset()
    if len(compact) < n:
        return frozenset({compact})
    return frozenset(compact[i:i + n] for i in range(len(compact) - n + 1))


def _jaccard(a: frozenset[str], b: frozenset[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


class PreparedText:
    """预计算文本表示，供重复比对循环复用。"""
    __slots__ = ("ngrams", "tokens")

    def __init__(self, raw: str) -> None:
        norm = normalize_text(raw)
        self.ngrams = _char_ngrams(norm)
        self.tokens = frozenset(t for t in norm.split() if len(t) > 1)


def similarity(a: PreparedText, b: PreparedText) -> float:
    return max(_jaccard(a.ngrams, b.ngrams), _jaccard(a.tokens, b.tokens))
```

- [ ] **Step 4: 跑测试确认通过**

Run: `conda run -n wems python -m pytest tests/test_text_dedupe.py -v`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git -C /workspace/projects/WeMediaStudio add backend/text_dedupe.py backend/tests/test_text_dedupe.py
git -C /workspace/projects/WeMediaStudio commit -m "feat(ref): 近重复检测模块 text_dedupe（3-gram+词级 Jaccard）"
```

---

## Task 3: RefMaterial.parent_source_id 列

**Files:**
- Modify: `backend/models.py`（RefMaterial 类，~722 行 `rule_id` 之后）

- [ ] **Step 1: 加模型字段**

`backend/models.py` RefMaterial 中，`rule_id` 行后插入：

```python
    parent_source_id: Mapped[str | None] = mapped_column(String, nullable=True)
```

- [ ] **Step 2: 对运行库执行 ALTER**

先探测当前数据库（项目无迁移框架，create_all 不改已有表）：

```bash
grep -E "WMS_DATABASE_URL|DATABASE" /workspace/projects/WeMediaStudio/backend/.env
```

- Postgres：`psql <连接串> -c "ALTER TABLE ref_materials ADD COLUMN IF NOT EXISTS parent_source_id VARCHAR;"`
- SQLite dev 库：`sqlite3 <db文件> "ALTER TABLE ref_materials ADD COLUMN parent_source_id VARCHAR;"`

验证：查询 `SELECT parent_source_id FROM ref_materials LIMIT 1;` 不报错。

- [ ] **Step 3: 既有测试不破**

Run: `conda run -n wems python -m pytest tests/test_models_schema.py -v`
Expected: passed（测试库由 create_all 新建，自动带新列）

- [ ] **Step 4: Commit**

```bash
git -C /workspace/projects/WeMediaStudio add backend/models.py
git -C /workspace/projects/WeMediaStudio commit -m "feat(ref): RefMaterial 增加 parent_source_id 列（神回复父帖标记）"
```

---

## Task 4: llm.classify_ref_categories（重写分类）

**Files:**
- Modify: `backend/llm.py`（替换 `_classify_ref_chunk`、`classify_ref_posts`，~440-562 行；`RefClassifyError` 保留）
- Test: 重写 `backend/tests/test_ref_classify.py`（整文件替换）

- [ ] **Step 1: 重写测试文件**

Overwrite `backend/tests/test_ref_classify.py`:

```python
import asyncio, json
import pytest
from unittest.mock import patch


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def test_classify_categories_maps_by_source_id():
    import llm
    fake = json.dumps([
        {"source_id": "1", "category": "沙雕搞笑", "scene_tags": ["resonance"]},
        {"source_id": "2", "category": "其他", "scene_tags": []},
    ])
    async def fake_call(prompt, max_tokens=2048):
        return fake
    posts = [{"source_id": "1", "text": "段子1"}, {"source_id": "2", "text": "文案2"}]
    with patch("llm._call", new=fake_call):
        res = _run(llm.classify_ref_categories(
            posts, categories=["沙雕搞笑", "其他"], scene_tags=["resonance"]))
    by_id = {r["source_id"]: r for r in res}
    assert by_id["1"]["category"] == "沙雕搞笑"
    assert by_id["1"]["scene_tags"] == ["resonance"]
    assert by_id["2"]["category"] == "其他"


def test_classify_categories_empty_input_no_llm_call():
    import llm
    called = {"n": 0}
    async def fake_call(prompt, max_tokens=2048):
        called["n"] += 1
        return "[]"
    with patch("llm._call", new=fake_call):
        res = _run(llm.classify_ref_categories([], categories=["其他"], scene_tags=[]))
    assert res == [] and called["n"] == 0


def test_classify_categories_raises_on_all_chunks_failed():
    import llm
    async def fake_call(prompt, max_tokens=2048):
        return ""  # 空输出 → RefClassifyError
    posts = [{"source_id": "1", "text": "x"}]
    with patch("llm._call", new=fake_call):
        with pytest.raises(llm.RefClassifyError):
            _run(llm.classify_ref_categories(posts, categories=["其他"], scene_tags=[]))


def test_classify_categories_partial_success_keeps_good_chunks():
    import llm
    calls = {"n": 0}
    async def fake_call(prompt, max_tokens=2048):
        calls["n"] += 1
        if calls["n"] == 1:
            return json.dumps([{"source_id": "1", "category": "其他", "scene_tags": []}])
        return "not json"
    # chunk 大小为 5：6 条 → 2 块，第二块失败
    posts = [{"source_id": str(i), "text": f"t{i}"} for i in range(1, 7)]
    with patch("llm._call", new=fake_call):
        res = _run(llm.classify_ref_categories(posts, categories=["其他"], scene_tags=[]))
    assert len(res) == 1 and res[0]["source_id"] == "1"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `conda run -n wems python -m pytest tests/test_ref_classify.py -v`
Expected: FAIL（`AttributeError: module 'llm' has no attribute 'classify_ref_categories'`）

- [ ] **Step 3: 实现（llm.py 替换旧函数）**

删除 `_classify_ref_chunk` 与 `classify_ref_posts`（含 `_REF_CLASSIFY_CHUNK = 1` 行），原位替换为：

```python
# 单次分类的文案数。输出极短（每条仅 category+scene_tags），但推理模型
# token 不足时 content 会被 reasoning 吃光（见 deepseek-v4-flash 踩坑），
# 保守用小块。
_REF_CLASSIFY_CHUNK = 5


async def _classify_category_chunk(
    posts: list[dict], cat_list: str, scene_list: str,
) -> list[dict]:
    """给一小块文案补分类标签。失败（调用异常/空/非 JSON）→ 抛 RefClassifyError。"""
    posts_text = "\n\n".join(
        f"[{p['source_id']}] {(p.get('text') or '')[:300]}"
        for p in posts
    )
    prompt = f"""你是中文自媒体「参考文案库」的归类 AI。下面每条文案已确认入库，
只需为它选分类和使用场景标签。

文案（格式 [id] 正文）：
{posts_text}

对每条输出一个对象，组成 JSON 数组，字段：
- source_id: 原样回传方括号里的 id（字符串）
- category: 从[{cat_list}]中选一个；不确定填「其他」
- scene_tags: 从[{scene_list}]中选 0 个或多个（写作中的使用场景）

只输出 JSON 数组，不要其他文字。"""

    max_tokens = min(4000, 300 * len(posts) + 500)
    try:
        raw = await _call(prompt, max_tokens=max_tokens)
    except Exception as e:
        raise RefClassifyError(f"LLM 调用失败：{str(e)[:200]}") from e

    raw = (raw or "").strip()
    if not raw:
        raise RefClassifyError("LLM 返回空内容（可能被安全策略拦截或限流）")

    start, end = raw.find("["), raw.rfind("]") + 1
    if not (start >= 0 and end > start):
        raise RefClassifyError(f"LLM 未返回 JSON 数组：{raw[:120]}")
    try:
        result = json.loads(raw[start:end])
    except Exception as e:
        raise RefClassifyError(f"LLM 输出 JSON 解析失败（疑似截断）：{raw[:120]}") from e
    if not isinstance(result, list):
        raise RefClassifyError("LLM 输出不是 JSON 数组")
    return result


async def classify_ref_categories(
    posts: list[dict],
    categories: list[str],
    scene_tags: list[str],
) -> list[dict]:
    """批量补分类标签（不判 keep、不打分、不改文本）。
    posts[i]: {source_id, text}；返回 [{source_id, category, scene_tags}]。

    按 _REF_CLASSIFY_CHUNK 拆块逐块调用：
    - 任一块成功 → 累加其结果（部分成功；失败块下次重试）。
    - 全部块失败 → 抛第一个 RefClassifyError。"""
    if not posts:
        return []

    cat_list = "、".join(categories)
    scene_list = "、".join(scene_tags)

    results: list[dict] = []
    errors: list[RefClassifyError] = []
    for i in range(0, len(posts), _REF_CLASSIFY_CHUNK):
        chunk = posts[i:i + _REF_CLASSIFY_CHUNK]
        try:
            results.extend(await _classify_category_chunk(chunk, cat_list, scene_list))
        except RefClassifyError as e:
            errors.append(e)

    if not results and errors:
        raise errors[0]
    return results
```

注意：此步后 `ref_collector.py` 顶部 `from llm import classify_ref_posts` 会 ImportError——Task 5/6 一起修。本 task 只验证 `tests/test_ref_classify.py`。

- [ ] **Step 4: 跑测试确认通过**

Run: `conda run -n wems python -m pytest tests/test_ref_classify.py -v`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git -C /workspace/projects/WeMediaStudio add backend/llm.py backend/tests/test_ref_classify.py
git -C /workspace/projects/WeMediaStudio commit -m "refactor(ref): classify_ref_posts 重写为轻量 classify_ref_categories（只分类）"
```

---

## Task 5: ref_collector 新漏斗（collect_rule 重写）

**Files:**
- Modify: `backend/ref_collector.py`（大部重写）
- Test: 重写 `backend/tests/test_ref_collector.py`

- [ ] **Step 1: 重写测试文件**

Overwrite `backend/tests/test_ref_collector.py`（fixture 沿用原文件模式）:

```python
import sys, asyncio, pytest
from sqlalchemy import select


@pytest.fixture
def db_session(monkeypatch, tmp_path):
    db_file = tmp_path / "t.db"
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{db_file}")
    for mod in list(sys.modules):
        if mod.startswith(("database", "models", "config")):
            sys.modules.pop(mod, None)
    from database import engine, Base, SessionLocal
    import models  # noqa
    async def _setup():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    asyncio.new_event_loop().run_until_complete(_setup())
    return SessionLocal


def _rule(db_session, **kw):
    from models import RefCollectRule
    async def _mk():
        async with db_session() as db:
            r = RefCollectRule(label="t", source_subscription_id=1,
                               min_faves=1, exclude_sensitive=True, days=7, max_results=20, **kw)
            db.add(r); await db.commit(); await db.refresh(r)
            db.expunge(r)
            return r
    return asyncio.new_event_loop().run_until_complete(_mk())


def _seed_xpost(db_session, tid, *, likes=9000, sensitive=False, sub_id=1,
                text="这是一个挺好笑的段子内容哈哈"):
    from models import XPost
    from datetime import datetime, timezone
    async def _mk():
        async with db_session() as db:
            db.add(XPost(tweet_id=tid, subscription_id=sub_id, username="u",
                         display_name="U", content=text,
                         url=f"https://x.com/u/status/{tid}",
                         published_at=datetime.now(timezone.utc),
                         replies=1, reposts=2, likes=likes, views=likes * 10,
                         possibly_sensitive=sensitive))
            await db.commit()
    asyncio.new_event_loop().run_until_complete(_mk())


def _collect(db_session, rule):
    from ref_collector import collect_rule
    async def _go():
        async with db_session() as db:
            merged = await db.merge(rule)
            return await collect_rule(db, merged)
    return asyncio.new_event_loop().run_until_complete(_go())


def _materials(db_session):
    from models import RefMaterial
    async def _q():
        async with db_session() as db:
            return list((await db.execute(select(RefMaterial))).scalars().all())
    return asyncio.new_event_loop().run_until_complete(_q())


def _seen_verdicts(db_session):
    from models import RefSeen
    async def _q():
        async with db_session() as db:
            rows = (await db.execute(select(RefSeen))).scalars().all()
            return {(r.platform, r.source_id): r.verdict for r in rows}
    return asyncio.new_event_loop().run_until_complete(_q())


def test_prefilter_drops_sensitive_short_link_mention():
    from ref_collector import _prefilter
    from feedgrab_client import ParsedPost
    from datetime import datetime, timezone
    def p(tid, text, sensitive=False):
        return ParsedPost(tweet_id=tid, username="u", display_name="U", content=text,
                          url="", published_at=datetime.now(timezone.utc),
                          possibly_sensitive=sensitive)
    posts = [
        p("1", "这是一条足够长的正常段子内容"),
        p("2", "太短"),
        p("3", "看这个链接 https://t.co/x 快点"),
        p("4", "@a @b @c 冲"),
        p("5", "这条其实还行但是敏感", sensitive=True),
    ]
    out = _prefilter(posts, exclude_sensitive=True)
    assert [x.tweet_id for x in out] == ["1"]


def test_collect_inserts_active_with_local_score(db_session):
    rule = _rule(db_session)
    _seed_xpost(db_session, "t1", likes=9000)
    created = _collect(db_session, rule)
    assert len(created) == 1
    mats = _materials(db_session)
    assert len(mats) == 1
    m = mats[0]
    assert m.status == "active"
    assert m.score > 0           # 本地信号分，非 LLM
    assert m.category == ""      # 待低频分类
    assert m.text_clean != ""    # 规则清洗文本
    assert _seen_verdicts(db_session)[("x", "t1")] == "active"


def test_collect_clean_text_strips_trailing_tags(db_session):
    rule = _rule(db_session)
    _seed_xpost(db_session, "t1", text="正经段子内容在这里！！！！ #搞笑 #日常")
    _collect(db_session, rule)
    m = _materials(db_session)[0]
    assert "#搞笑" not in m.text_clean
    assert "！！！！" not in m.text_clean   # 重复标点压缩
    assert m.text.startswith("正经段子内容")  # 原文保留


def test_collect_dedup_within_batch_keeps_higher_score(db_session):
    rule = _rule(db_session)
    _seed_xpost(db_session, "hi", likes=50000,
                text="打工人的尽头是带薪拉屎，一天不拉浑身难受")
    _seed_xpost(db_session, "lo", likes=1000,
                text="打工人的尽头就是带薪拉屎，一天不拉感觉浑身难受")
    created = _collect(db_session, rule)
    assert len(created) == 1 and created[0].source_id == "hi"
    assert _seen_verdicts(db_session)[("x", "lo")] == "duplicate"


def test_collect_dedup_against_db_replaces_lower(db_session):
    rule = _rule(db_session)
    _seed_xpost(db_session, "old", likes=1000,
                text="程序员的快乐就是下班前十分钟修好了 bug")
    _collect(db_session, rule)
    _seed_xpost(db_session, "new", likes=80000,
                text="程序员的快乐，就是下班前十分钟修好了bug！")
    created = _collect(db_session, rule)
    assert len(created) == 1 and created[0].source_id == "new"
    by_sid = {m.source_id: m for m in _materials(db_session)}
    assert by_sid["old"].status == "duplicate"
    assert by_sid["new"].status == "active"


def test_collect_dedup_against_db_drops_lower_newcomer(db_session):
    rule = _rule(db_session)
    _seed_xpost(db_session, "old", likes=80000,
                text="程序员的快乐就是下班前十分钟修好了 bug")
    _collect(db_session, rule)
    _seed_xpost(db_session, "new", likes=500,
                text="程序员的快乐，就是下班前十分钟修好了bug！")
    created = _collect(db_session, rule)
    assert created == []
    by_sid = {m.source_id: m for m in _materials(db_session)}
    assert "new" not in by_sid
    assert by_sid["old"].status == "active"
    assert _seen_verdicts(db_session)[("x", "new")] == "duplicate"


def test_collect_skips_already_seen(db_session):
    rule = _rule(db_session)
    _seed_xpost(db_session, "t1")
    _collect(db_session, rule)
    created2 = _collect(db_session, rule)   # 二次跑同一条
    assert created2 == []
    assert len(_materials(db_session)) == 1
```

- [ ] **Step 2: 跑测试确认失败**

Run: `conda run -n wems python -m pytest tests/test_ref_collector.py -v`
Expected: FAIL（import 错误或断言失败——旧 collect_rule 产出 status='raw' score=0）

- [ ] **Step 3: 重写 ref_collector.py**

整文件替换为：

```python
"""参考文案采集漏斗：规则粗筛 → seen 去重 → 近重复去重 → 本地信号打分 → 入库 active。

LLM 不再守门（旧 raw→LLM 精筛→入库 模式已移除）：素材入库零 LLM 依赖，
低频 classify_batch 只给高分素材补 category/scene_tags。
"""
from __future__ import annotations
import re
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.dialects.postgresql import insert as _pg_insert
from sqlalchemy.dialects.sqlite import insert as _sl_insert

from models import RefMaterial, RefCollectRule, RefSeen, XPost
from feedgrab_client import ParsedPost
from llm import classify_ref_categories, RefClassifyError  # noqa: F401 (router 复用 RefClassifyError)
from config import get_config
from ref_signals import engagement_score, DEFAULT_SCALE
from text_dedupe import PreparedText, similarity, DEFAULT_THRESHOLD

_URL_RE = re.compile(r"https?://")
_TRAILING_TAG_RE = re.compile(r"(?:\s*#\S+)+\s*$")
_REPEAT_PUNCT_RE = re.compile(r"([!！?？。.~～，,])\1{2,}")

# 使用场景受控词表（与 routers/materials.SCENE_TAGS、前端保持一致）
SCENE_TAGS = ["opener", "closer", "argument", "twist", "resonance", "warning"]

# 近重复比对的库内回看窗口
_DEDUP_LOOKBACK_DAYS = 14


def _prefilter(posts: list[ParsedPost], *, exclude_sensitive: bool) -> list[ParsedPost]:
    out: list[ParsedPost] = []
    for p in posts:
        t = (p.content or "").strip()
        if exclude_sensitive and p.possibly_sensitive:
            continue
        if len(t) < 10:
            continue
        if _URL_RE.search(t):
            continue
        tokens = t.split()
        mentions = sum(1 for tok in tokens if tok.startswith("@"))
        if tokens and mentions / len(tokens) > 0.5:
            continue
        out.append(p)
    return out


def _clean_text(text: str) -> str:
    """规则文本清洗：去尾部纯 #tag 串、压缩 3+ 连续重复标点为 2。"""
    t = _TRAILING_TAG_RE.sub("", (text or "").strip())
    t = _REPEAT_PUNCT_RE.sub(r"\1\1", t)
    return t.strip()


def _insert(table, dialect: str):
    return _sl_insert(table) if dialect == "sqlite" else _pg_insert(table)


async def _already_seen(db: AsyncSession, source_ids: list[str], platform: str = "x") -> set[str]:
    if not source_ids:
        return set()
    rows = (await db.execute(
        select(RefSeen.source_id).where(
            RefSeen.platform == platform, RefSeen.source_id.in_(source_ids))
    )).scalars().all()
    return set(rows)


async def _mark_seen(db: AsyncSession, source_id: str, verdict: str, platform: str = "x"):
    dialect = db.bind.dialect.name if db.bind else "postgresql"
    stmt = _insert(RefSeen, dialect).values(
        platform=platform, source_id=source_id, verdict=verdict,
        seen_at=datetime.now(timezone.utc),
    ).on_conflict_do_nothing(index_elements=["platform", "source_id"])
    await db.execute(stmt)


async def _upsert_active(
    db: AsyncSession, p: ParsedPost, *,
    score: int, text_clean: str,
    rule_id: int | None = None, parent_source_id: str | None = None,
):
    """统一入库：主线素材（rule_id）与神回复（parent_source_id）共用。"""
    dialect = db.bind.dialect.name if db.bind else "postgresql"
    stmt = _insert(RefMaterial, dialect).values(
        platform="x", source_id=p.tweet_id, text=p.content,
        text_clean=text_clean, author=p.display_name,
        handle=p.username, source_url=p.url, cover_image=p.cover_image,
        likes=p.likes, reposts=p.reposts, replies=p.replies, views=p.views,
        score=score, category="", scene_tags=[], tags=[],
        rule_id=rule_id, parent_source_id=parent_source_id,
        status="active", published_at=p.published_at,
        created_at=datetime.now(timezone.utc), updated_at=datetime.now(timezone.utc),
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=["platform", "source_id"],
        set_={"likes": stmt.excluded.likes, "reposts": stmt.excluded.reposts,
              "replies": stmt.excluded.replies, "views": stmt.excluded.views,
              "score": stmt.excluded.score, "updated_at": stmt.excluded.updated_at},
    )
    await db.execute(stmt)


async def _load_recent_prepared(db: AsyncSession) -> list[tuple[int, int, PreparedText]]:
    """库内近 _DEDUP_LOOKBACK_DAYS 天 active 素材的 (id, score, PreparedText)。"""
    since = datetime.now(timezone.utc) - timedelta(days=_DEDUP_LOOKBACK_DAYS)
    rows = (await db.execute(
        select(RefMaterial.id, RefMaterial.score, RefMaterial.text).where(
            RefMaterial.platform == "x",
            RefMaterial.status == "active",
            RefMaterial.created_at >= since,
        )
    )).all()
    return [(r.id, r.score, PreparedText(r.text)) for r in rows]


async def _dedup_survivors(
    db: AsyncSession, survivors: list[ParsedPost], scale: float,
) -> list[tuple[ParsedPost, int]]:
    """近重复去重。返回 (post, score) 接受列表；重复者写 seen=duplicate。

    高分先处理：批内撞重时后来的低分者被丢；撞库内条目时分高者替换
    （旧条目 status='duplicate'），分低者丢弃。
    """
    existing = await _load_recent_prepared(db)
    scored = sorted(
        ((p, engagement_score(p.likes, p.reposts, p.replies, p.views, scale=scale)) for p in survivors),
        key=lambda x: x[1], reverse=True,
    )
    accepted: list[tuple[ParsedPost, int]] = []
    accepted_preps: list[PreparedText] = []
    for p, score in scored:
        prep = PreparedText(p.content)
        if any(similarity(prep, ap) >= DEFAULT_THRESHOLD for ap in accepted_preps):
            await _mark_seen(db, p.tweet_id, "duplicate")
            continue
        db_dup = next(
            ((mid, mscore) for mid, mscore, ep in existing if similarity(prep, ep) >= DEFAULT_THRESHOLD),
            None,
        )
        if db_dup is not None:
            mid, mscore = db_dup
            if score > mscore:
                old = await db.get(RefMaterial, mid)
                if old is not None:
                    old.status = "duplicate"
                    old.updated_at = datetime.now(timezone.utc)
            else:
                await _mark_seen(db, p.tweet_id, "duplicate")
                continue
        accepted.append((p, score))
        accepted_preps.append(prep)
    return accepted


def _xpost_to_parsed(x: XPost) -> ParsedPost:
    return ParsedPost(
        tweet_id=x.tweet_id, username=x.username, display_name=x.display_name,
        content=x.content, url=x.url, published_at=x.published_at,
        replies=x.replies, reposts=x.reposts, likes=x.likes, views=x.views,
        author_avatar=x.author_avatar, cover_image=x.cover_image,
        raw_markdown=x.raw_markdown, possibly_sensitive=x.possibly_sensitive,
    )


async def collect_rule(db: AsyncSession, rule: RefCollectRule) -> list[RefMaterial]:
    """从 x_posts 取候选 → 漏斗（粗筛/seen/近重复/打分）→ 入库 active。
    返回本轮新入库的 RefMaterial 列表。异常写 rule.last_error 后抛出。"""
    since = datetime.now(timezone.utc) - timedelta(days=max(1, rule.days))
    stmt = (
        select(XPost)
        .where(XPost.published_at >= since, XPost.likes >= rule.min_faves)
        .order_by(XPost.published_at.desc())
        .limit(max(1, rule.max_results))
    )
    if rule.source_subscription_id is not None:
        stmt = stmt.where(XPost.subscription_id == rule.source_subscription_id)
    try:
        rows = (await db.execute(stmt)).scalars().all()
    except Exception as e:
        rule.last_error = str(e)[:500]
        await db.commit()
        raise
    posts = [_xpost_to_parsed(x) for x in rows]

    seen = await _already_seen(db, [p.tweet_id for p in posts])
    fresh = [p for p in posts if p.tweet_id not in seen]
    survivors = _prefilter(fresh, exclude_sensitive=rule.exclude_sensitive)

    # 被粗筛掉的 fresh 也记 seen（rejected），避免下次重复处理
    survivor_ids = {p.tweet_id for p in survivors}
    for p in fresh:
        if p.tweet_id not in survivor_ids:
            await _mark_seen(db, p.tweet_id, "rejected")

    cfg = await get_config()
    scale = float(cfg.get("ref_score_scale", DEFAULT_SCALE))
    accepted = await _dedup_survivors(db, survivors, scale)

    for p, score in accepted:
        await _upsert_active(db, p, score=score, text_clean=_clean_text(p.content), rule_id=rule.id)
        await _mark_seen(db, p.tweet_id, "active")

    rule.last_collected_at = datetime.now(timezone.utc)
    rule.last_error = ""
    await db.commit()

    if not accepted:
        return []
    ids = [p.tweet_id for p, _ in accepted]
    created = (await db.execute(
        select(RefMaterial).where(RefMaterial.platform == "x", RefMaterial.source_id.in_(ids))
    )).scalars().all()
    return list(created)


async def classify_batch(db: AsyncSession, size: int) -> dict:
    """给高分未分类素材批量补 category/scene_tags。
    LLM 全批失败抛 RefClassifyError；失败素材 category 留空下轮自然重试。"""
    cfg = await get_config()
    min_score = int(cfg.get("ref_classify_min_score", 60))
    items = list((await db.execute(
        select(RefMaterial).where(
            RefMaterial.status == "active",
            RefMaterial.category == "",
            RefMaterial.score >= min_score,
        ).order_by(RefMaterial.score.desc()).limit(size)
    )).scalars().all())

    if not items:
        return {"processed": 0, "classified": 0, "remaining": 0}

    categories = [c for c in cfg.get("ref_categories", "").split(",") if c]
    payload = [{"source_id": str(m.id), "text": m.text_clean or m.text} for m in items]

    verdicts = await classify_ref_categories(payload, categories, SCENE_TAGS)
    vmap = {str(v.get("source_id")): v for v in verdicts}

    classified = 0
    now = datetime.now(timezone.utc)
    for m in items:
        v = vmap.get(str(m.id))
        if v is None:
            continue  # LLM 漏回 → 下轮重试
        m.category = (v.get("category") or "其他")
        m.scene_tags = list(v.get("scene_tags") or [])
        m.updated_at = now
        classified += 1

    await db.commit()
    remaining = await db.scalar(
        select(func.count()).where(
            RefMaterial.status == "active",
            RefMaterial.category == "",
            RefMaterial.score >= min_score,
        )
    )
    return {"processed": len(items), "classified": classified, "remaining": remaining or 0}


async def collect_all(db: AsyncSession) -> dict:
    rules = (await db.execute(
        select(RefCollectRule).where(RefCollectRule.enabled == True)  # noqa: E712
    )).scalars().all()
    total, failed = 0, []
    for rule in rules:
        try:
            total += len(await collect_rule(db, rule))
        except Exception as e:
            failed.append(f"{rule.label}: {e}")
    return {"checked": len(rules), "new": total, "failed": failed}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `conda run -n wems python -m pytest tests/test_ref_collector.py -v`
Expected: 7 passed

- [ ] **Step 5: Commit**

```bash
git -C /workspace/projects/WeMediaStudio add backend/ref_collector.py backend/tests/test_ref_collector.py
git -C /workspace/projects/WeMediaStudio commit -m "feat(ref): collect_rule 重写为本地漏斗（prefilter→seen→近重复→打分→入库）"
```

---

## Task 6: classify_batch 路由连动（materials router）

**Files:**
- Modify: `backend/routers/materials.py`（clean-batch 端点 ~244-252、collect 端点 ~224-238、import 行 ~12）
- Test: `backend/tests/test_ref_collector.py` 追加 classify_batch 测试

- [ ] **Step 1: 追加失败测试**

`backend/tests/test_ref_collector.py` 末尾追加：

```python
def test_classify_batch_fills_category_for_high_score(db_session):
    from unittest.mock import patch
    import json as _json
    rule = _rule(db_session)
    _seed_xpost(db_session, "t1", likes=90000)   # 高分，进分类队列
    _collect(db_session, rule)

    async def fake_call(prompt, max_tokens=2048):
        import llm  # noqa
        mid = _materials(db_session)[0].id
        return _json.dumps([{"source_id": str(mid), "category": "沙雕搞笑", "scene_tags": ["resonance"]}])

    from ref_collector import classify_batch
    async def _go():
        async with db_session() as db:
            with patch("llm._call", new=fake_call):
                return await classify_batch(db, 10)
    r = asyncio.new_event_loop().run_until_complete(_go())
    assert r["processed"] == 1 and r["classified"] == 1 and r["remaining"] == 0
    m = _materials(db_session)[0]
    assert m.category == "沙雕搞笑"
    assert m.scene_tags == ["resonance"]
    assert m.status == "active"


def test_classify_batch_skips_low_score(db_session):
    rule = _rule(db_session)
    _seed_xpost(db_session, "t1", likes=2)   # 低分（< ref_classify_min_score 60）
    _collect(db_session, rule)
    from ref_collector import classify_batch
    async def _go():
        async with db_session() as db:
            return await classify_batch(db, 10)
    r = asyncio.new_event_loop().run_until_complete(_go())
    assert r == {"processed": 0, "classified": 0, "remaining": 0}
```

Run: `conda run -n wems python -m pytest tests/test_ref_collector.py -v`
Expected: 新增 2 个中 `test_classify_batch_fills_category_for_high_score` 可能 PASS（Task 5 已实现 classify_batch）；低分 case PASS。若都 PASS 直接进 Step 2（实现已就位，测试补登记）。

- [ ] **Step 2: 改 materials router**

`backend/routers/materials.py`：

(a) import 行（~12）：
```python
from ref_collector import collect_rule, collect_all, classify_batch
```

(b) collect 单规则端点（~224-232）返回值连动（`collect_rule` 现返回 list）：
```python
@router.post("/rules/{rid}/collect")
async def collect_one_rule(rid: int, db: AsyncSession = Depends(get_db)):
    rule = await db.get(RefCollectRule, rid)
    if not rule:
        raise HTTPException(404, "rule not found")
    try:
        created = await collect_rule(db, rule)
    except Exception as e:
        raise HTTPException(502, f"采集失败：{str(e)[:200]}")
    return {"ok": True, "new": len(created)}
```
（保留原函数体里已有的 404/异常结构，仅改 `collect_rule` 返回值的使用与响应字段 `new_raw`→`new`。）

(c) collect-all 端点（~236-238）：`collect_all` 返回 dict 字段 `new_raw`→`new` 已在 Task 5 完成，端点透传即可；尾部追加 reply scout（Task 7 接入后生效，此处先留：本 task 端点只透传 collect_all 结果）。

(d) clean-batch 端点（~244-252）替换为：
```python
@router.post("/classify-batch")
async def classify_batch_endpoint(body: CleanBatchBody, db: AsyncSession = Depends(get_db)):
    cfg = await get_config()
    size = body.size or int(cfg.get("clean_batch_size", 20))
    try:
        result = await classify_batch(db, size)
    except Exception as e:
        raise HTTPException(502, f"LLM 分类失败：{str(e)[:200]}")
    return {"ok": True, **result}
```
（`CleanBatchBody` 类名保留不动，删除旧 `/clean-batch` 路由。）

- [ ] **Step 3: 跑测试**

Run: `conda run -n wems python -m pytest tests/test_ref_collector.py tests/test_materials_router.py -v`
Expected: 全 passed（若 test_materials_router 引用了 /clean-batch 或 new_raw，按新接口同步修该测试）

- [ ] **Step 4: Commit**

```bash
git -C /workspace/projects/WeMediaStudio add backend/routers/materials.py backend/tests/
git -C /workspace/projects/WeMediaStudio commit -m "feat(ref): classify-batch 端点替换 clean-batch，collect 返回值连动"
```

---

## Task 7: reply_scout 神回复子管道

**Files:**
- Create: `backend/reply_scout.py`
- Test: `backend/tests/test_reply_scout.py`
- Modify: `backend/routers/materials.py`（collect-all 端点尾部接 scout）

- [ ] **Step 1: 写失败测试**

Create `backend/tests/test_reply_scout.py`:

```python
import sys, asyncio, pytest
from unittest.mock import patch
from sqlalchemy import select


@pytest.fixture
def db_session(monkeypatch, tmp_path):
    db_file = tmp_path / "t.db"
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{db_file}")
    for mod in list(sys.modules):
        if mod.startswith(("database", "models", "config")):
            sys.modules.pop(mod, None)
    from database import engine, Base, SessionLocal
    import models  # noqa
    async def _setup():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    asyncio.new_event_loop().run_until_complete(_setup())
    return SessionLocal


def _seed_parent(db_session, sid="p1", score=90):
    from models import RefMaterial
    from datetime import datetime, timezone
    async def _mk():
        async with db_session() as db:
            m = RefMaterial(platform="x", source_id=sid, text="父帖段子内容好笑极了",
                            text_clean="父帖段子内容好笑极了", score=score, status="active",
                            published_at=datetime.now(timezone.utc))
            db.add(m); await db.commit(); await db.refresh(m)
            db.expunge(m)
            return m
    return asyncio.new_event_loop().run_until_complete(_mk())


def _reply(rid, parent_id, *, text="这条神回复实在太有梗了哈哈", likes=500, author="rep"):
    return {
        "id": rid, "text": text, "author": author, "author_name": "Rep",
        "in_reply_to_status_id": parent_id, "likes": likes, "retweets": 3,
        "replies": 1, "views": "12000", "created_at": "Wed Oct 10 20:19:24 +0000 2018",
        "possibly_sensitive": False, "images": [],
    }


def test_clean_reply_text_strips_leading_mentions():
    from reply_scout import clean_reply_text
    assert clean_reply_text("@a @b 这条回复剥掉前缀后还很长很有梗") == "这条回复剥掉前缀后还很长很有梗"
    assert clean_reply_text("@a @b 短") is None          # 剥后过短
    assert clean_reply_text("看链接 https://t.co/x 哈哈哈哈") is None   # 含 URL
    assert clean_reply_text("") is None


def test_filter_replies_excludes_parent_and_nonreplies():
    from reply_scout import filter_replies
    tweets = [
        {"id": "p1", "text": "父帖自己", "in_reply_to_status_id": ""},
        _reply("r1", "p1"),
        _reply("r2", "other"),          # 回复别的帖
        {"id": "r3", "text": "无关推文", "in_reply_to_status_id": ""},
    ]
    out = filter_replies(tweets, "p1")
    assert [t["id"] for t in out] == ["r1"]


def _run_scout(db_session, tweets_by_parent, cookies=None):
    import reply_scout
    async def _go():
        async with db_session() as db:
            with patch.object(reply_scout, "_load_cookies",
                              return_value=cookies if cookies is not None else {"auth_token": "a", "ct0": "c"}), \
                 patch.object(reply_scout, "_fetch_thread_tweets",
                              side_effect=lambda tid, ck: tweets_by_parent.get(tid)):
                return await reply_scout.scout_replies(db)
    return asyncio.new_event_loop().run_until_complete(_go())


def _materials(db_session):
    from models import RefMaterial
    async def _q():
        async with db_session() as db:
            return list((await db.execute(select(RefMaterial))).scalars().all())
    return asyncio.new_event_loop().run_until_complete(_q())


def test_scout_inserts_top_replies_with_parent_mark(db_session):
    _seed_parent(db_session, "p1", score=90)
    replies = [
        _reply("r1", "p1", likes=900, text="最高赞神回复必须有足够长度"),
        _reply("r2", "p1", likes=500, text="第二高赞神回复也挺好笑的呀"),
        _reply("r3", "p1", likes=300, text="第三条神回复勉强够格入库了"),
        _reply("r4", "p1", likes=200, text="第四条不该入库因为只取前三"),
        _reply("r5", "p1", likes=50, text="低于点赞门槛的回复不该入库"),
    ]
    r = _run_scout(db_session, {"p1": [{"id": "p1", "text": "父帖", "in_reply_to_status_id": ""}] + replies})
    assert r["scouted"] == 1 and r["new_replies"] == 3
    mats = _materials(db_session)
    reply_mats = [m for m in mats if m.parent_source_id == "p1"]
    assert sorted(m.source_id for m in reply_mats) == ["r1", "r2", "r3"]
    assert all(m.status == "active" and m.score > 0 for m in reply_mats)


def test_scout_skips_when_no_cookies(db_session):
    _seed_parent(db_session, "p1", score=90)
    r = _run_scout(db_session, {}, cookies={})
    assert r == {"scouted": 0, "new_replies": 0}


def test_scout_respects_seen_ledger(db_session):
    _seed_parent(db_session, "p1", score=90)
    payload = {"p1": [_reply("r1", "p1", likes=900, text="最高赞神回复必须有足够长度")]}
    r1 = _run_scout(db_session, payload)
    r2 = _run_scout(db_session, payload)   # 第二轮：父帖已 scouted
    assert r1["scouted"] == 1
    assert r2["scouted"] == 0 and r2["new_replies"] == 0


def test_scout_ignores_low_score_parents(db_session):
    _seed_parent(db_session, "p1", score=30)   # 低于 ref_reply_scout_threshold 70
    r = _run_scout(db_session, {"p1": [_reply("r1", "p1", likes=900)]})
    assert r["scouted"] == 0


def test_scout_fetch_failure_not_marked_scouted(db_session):
    _seed_parent(db_session, "p1", score=90)
    r1 = _run_scout(db_session, {"p1": None})   # fetch 失败
    assert r1["scouted"] == 0
    # 下一轮成功 → 仍可抓
    r2 = _run_scout(db_session, {"p1": [_reply("r1", "p1", likes=900, text="最高赞神回复必须有足够长度")]})
    assert r2["scouted"] == 1 and r2["new_replies"] == 1
```

- [ ] **Step 2: 跑测试确认失败**

Run: `conda run -n wems python -m pytest tests/test_reply_scout.py -v`
Expected: FAIL（ModuleNotFoundError: reply_scout）

- [ ] **Step 3: 实现**

Create `backend/reply_scout.py`:

```python
"""神回复子管道：高分爆款帖抓评论串，高赞回复经规则清洗后作为独立素材入库。

依赖单向：reply_scout → ref_collector（复用 seen/入库/打分 helpers）。
触发点在 scheduler 与 materials collect-all 端点（不在 collect_all 内，避免环）。
"""
from __future__ import annotations
import asyncio
import re
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models import RefMaterial, RefSeen
from feedgrab_client import ParsedPost
from config import get_config
from ref_signals import engagement_score, DEFAULT_SCALE
from ref_collector import _already_seen, _mark_seen, _upsert_active, _clean_text

_URL_RE = re.compile(r"https?://")
_LEADING_MENTIONS_RE = re.compile(r"^(?:@\S+\s+)+")
_TW_DATE_FMT = "%a %b %d %H:%M:%S %z %Y"

# 每轮最多侦察的父帖数（限流第一道闸）
_PARENT_BUDGET = 5
# 每父帖最多入库的神回复数
_TOP_REPLIES = 3
# 父帖候选回看窗口（只侦察最近入库的）
_PARENT_LOOKBACK_HOURS = 24


def clean_reply_text(text: str) -> str | None:
    """回复清洗：剥开头 @链 → 长度/URL 校验。通过返回干净文本，否则 None。"""
    t = _LEADING_MENTIONS_RE.sub("", (text or "").strip()).strip()
    if len(t) < 10:
        return None
    if _URL_RE.search(t):
        return None
    return t


def filter_replies(tweets: list[dict], parent_id: str) -> list[dict]:
    """从 TweetDetail 解析结果中筛出对 parent_id 的直接回复（排除父帖自身）。"""
    return [
        t for t in tweets
        if t.get("id") != parent_id and str(t.get("in_reply_to_status_id") or "") == str(parent_id)
    ]


def _load_cookies() -> dict:
    try:
        from feedgrab.fetchers.twitter_cookies import load_twitter_cookies
        return load_twitter_cookies() or {}
    except Exception:
        return {}


def _fetch_thread_tweets(tweet_id: str, cookies: dict) -> list[dict] | None:
    """同步：TweetDetail 一次抓取 → tweet dicts。失败返回 None（调用方决定重试）。"""
    try:
        from feedgrab.fetchers.twitter_thread import (
            fetch_tweet_detail, parse_tweet_entries, _parse_entries_to_tweets,
        )
        resp = fetch_tweet_detail(tweet_id, cookies)
        if not resp:
            return None
        return _parse_entries_to_tweets(parse_tweet_entries(resp))
    except Exception:
        return None


def _parse_tw_date(raw: str) -> datetime:
    try:
        return datetime.strptime(raw, _TW_DATE_FMT)
    except (ValueError, TypeError):
        return datetime.now(timezone.utc)


def _reply_to_parsed(r: dict, text: str) -> ParsedPost:
    rid = str(r.get("id") or "")
    author = str(r.get("author") or "")
    try:
        views = int(str(r.get("views") or "0").replace(",", ""))
    except ValueError:
        views = 0
    images = r.get("images") or []
    return ParsedPost(
        tweet_id=rid, username=author, display_name=str(r.get("author_name") or author),
        content=text, url=f"https://x.com/{author}/status/{rid}" if author and rid else "",
        published_at=_parse_tw_date(str(r.get("created_at") or "")),
        replies=int(r.get("replies") or 0), reposts=int(r.get("retweets") or 0),
        likes=int(r.get("likes") or 0), views=views,
        cover_image=str(images[0]) if images else "",
        possibly_sensitive=bool(r.get("possibly_sensitive")),
    )


async def _pick_parents(db: AsyncSession, threshold: int) -> list[RefMaterial]:
    """近 24h 入库、score 达标、非神回复自身、未侦察过的父帖，按分取 top。"""
    since = datetime.now(timezone.utc) - timedelta(hours=_PARENT_LOOKBACK_HOURS)
    rows = (await db.execute(
        select(RefMaterial).where(
            RefMaterial.platform == "x",
            RefMaterial.status == "active",
            RefMaterial.score >= threshold,
            RefMaterial.parent_source_id.is_(None),
            RefMaterial.created_at >= since,
        ).order_by(RefMaterial.score.desc()).limit(_PARENT_BUDGET * 4)
    )).scalars().all()
    if not rows:
        return []
    scouted = (await db.execute(
        select(RefSeen.source_id).where(
            RefSeen.platform == "x_replies",
            RefSeen.source_id.in_([m.source_id for m in rows]),
        )
    )).scalars().all()
    scouted_set = set(scouted)
    return [m for m in rows if m.source_id not in scouted_set][:_PARENT_BUDGET]


async def scout_replies(db: AsyncSession) -> dict:
    """对近期高分父帖抓神回复并入库。任何失败只降级，不抛出。"""
    cookies = _load_cookies()
    if not (cookies.get("auth_token") and cookies.get("ct0")):
        return {"scouted": 0, "new_replies": 0}

    cfg = await get_config()
    threshold = int(cfg.get("ref_reply_scout_threshold", 70))
    min_likes = int(cfg.get("ref_reply_min_likes", 100))
    scale = float(cfg.get("ref_score_scale", DEFAULT_SCALE))

    parents = await _pick_parents(db, threshold)
    scouted = new_count = 0
    for parent in parents:
        tweets = await asyncio.to_thread(_fetch_thread_tweets, parent.source_id, cookies)
        if tweets is None:
            continue  # fetch 失败：不标 scouted，下轮重试
        await _mark_seen(db, parent.source_id, "scouted", platform="x_replies")
        scouted += 1

        candidates: list[tuple[dict, str, int]] = []
        for r in filter_replies(tweets, parent.source_id):
            if r.get("possibly_sensitive"):
                continue
            text = clean_reply_text(str(r.get("text") or ""))
            if text is None:
                continue
            likes = int(r.get("likes") or 0)
            if likes < min_likes:
                continue
            candidates.append((r, text, likes))
        candidates.sort(key=lambda x: x[2], reverse=True)

        for r, text, _likes in candidates[:_TOP_REPLIES]:
            rid = str(r.get("id") or "")
            if not rid:
                continue
            if await _already_seen(db, [rid]):
                continue
            p = _reply_to_parsed(r, text)
            score = engagement_score(p.likes, p.reposts, p.replies, p.views, scale=scale)
            await _upsert_active(
                db, p, score=score, text_clean=_clean_text(text),
                parent_source_id=parent.source_id,
            )
            await _mark_seen(db, rid, "active")
            new_count += 1

    await db.commit()
    return {"scouted": scouted, "new_replies": new_count}
```

- [ ] **Step 4: collect-all 端点接入 scout**

`backend/routers/materials.py` collect-all 端点（~236）改为：

```python
@router.post("/collect-all")
async def collect_all_rules(db: AsyncSession = Depends(get_db)):
    result = await collect_all(db)
    from reply_scout import scout_replies
    try:
        scout = await scout_replies(db)
    except Exception as e:
        scout = {"scouted": 0, "new_replies": 0, "scout_error": str(e)[:200]}
    return {"ok": True, **result, **scout}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `conda run -n wems python -m pytest tests/test_reply_scout.py tests/test_ref_collector.py -v`
Expected: 全 passed

- [ ] **Step 6: Commit**

```bash
git -C /workspace/projects/WeMediaStudio add backend/reply_scout.py backend/tests/test_reply_scout.py backend/routers/materials.py
git -C /workspace/projects/WeMediaStudio commit -m "feat(ref): 神回复子管道 reply_scout（高分父帖抓高赞回复入库）"
```

---

## Task 8: scheduler + config + settings 连动

**Files:**
- Modify: `backend/config.py`（DEFAULTS，~25-62）
- Modify: `backend/scheduler.py`（scheduled_ref_clean ~359-372、job 注册表 ~497 附近）
- Modify: `backend/routers/settings.py`（SettingsOut/SettingsUpdate/GET/PUT 中 ref_clean_interval_minutes）

- [ ] **Step 1: config DEFAULTS 增删**

`backend/config.py` DEFAULTS：删除 `"ref_clean_interval_minutes": "30",` 行，新增：

```python
    "ref_classify_interval_minutes": "60",
    "ref_score_scale": "18.5",
    "ref_reply_scout_threshold": "70",
    "ref_reply_min_likes": "100",
    "ref_classify_min_score": "60",
```

- [ ] **Step 2: scheduler 改造**

`backend/scheduler.py`：

(a) `scheduled_ref_clean` 整函数替换为：

```python
async def scheduled_ref_classify():
    """定时：给高分未分类素材补 category/scene_tags；间隔 ref_classify_interval_minutes。"""
    from config import get_config
    async with SessionLocal() as db:
        cfg = await get_config()
        minutes = max(5, int(cfg.get("ref_classify_interval_minutes", 60)))
        if not _should_run("ref_classify", minutes * 60):
            return
        size = int(cfg.get("clean_batch_size", 20))
        from ref_collector import classify_batch
        try:
            result = await classify_batch(db, size)
            if result["processed"]:
                print(f"[scheduler] ref_classify: {result}")
        except Exception as e:
            print(f"[scheduler] ref_classify failed: {e}")
```
（保留原函数的日志/异常风格——以实际文件为准微调。）

(b) `scheduled_ref_collect` 尾部（collect_all 调用之后）追加：

```python
        from reply_scout import scout_replies
        try:
            scout = await scout_replies(db)
            if scout["scouted"]:
                print(f"[scheduler] reply_scout: {scout}")
        except Exception as e:
            print(f"[scheduler] reply_scout failed: {e}")
```

(c) job 注册表中 `scheduled_ref_clean` 行替换为：

```python
        (scheduled_ref_classify,        dict(trigger="interval", minutes=10,          id="ref_classify",      next_run_time=_first_run(10,  "ref_classify"))),
```
（对齐原表格式；轮询间隔 10min，真实节流由 `_should_run("ref_classify", ...)` 控制。）

- [ ] **Step 3: settings router 字段改名**

`backend/routers/settings.py`：`ref_clean_interval_minutes` 全部出现处（SettingsOut 字段、SettingsUpdate 字段、GET 组装、PUT 写入）改名为 `ref_classify_interval_minutes`。用 grep 找全：

```bash
grep -n "ref_clean_interval_minutes" backend/routers/settings.py
```

- [ ] **Step 4: 全后端相关测试回归**

Run: `conda run -n wems python -m pytest tests/test_ref_collector.py tests/test_ref_classify.py tests/test_reply_scout.py tests/test_ref_scheduler.py tests/test_materials_router.py -v`
Expected: 全 passed（`test_ref_scheduler.py` 若引用 `scheduled_ref_clean`/`ref_clean_interval_minutes`，同步改名修复）

- [ ] **Step 5: Commit**

```bash
git -C /workspace/projects/WeMediaStudio add backend/config.py backend/scheduler.py backend/routers/settings.py backend/tests/
git -C /workspace/projects/WeMediaStudio commit -m "feat(ref): ref_classify 调度 + scout 接入 + config/settings 连动"
```

---

## Task 9: 前端连动

**Files:**
- Modify: `web/lib/api/materials.ts`（cleanBatch ~92-105、getRawCount ~87-91、collectRule/collectAll ~80-86）
- Modify: `web/lib/api/settings.ts`（ref_clean_interval_minutes 字段）
- Modify: `web/app/settings/sections/XSection.tsx`（绑定改名）
- Modify: `web/app/materials/MaterialsClient.tsx`（按钮/计数/徽章/文案）

写前端代码前先读 `web/node_modules/next/dist/docs/` 中相关约定（项目 AGENTS.md 要求）。

- [ ] **Step 1: materials.ts 接口连动**

```typescript
export async function collectRule(id: number): Promise<{ new: number }> {
  return apiFetch(`/materials/rules/${id}/collect`, { method: 'POST' })
}
export async function collectAll(): Promise<{ new: number; failed: string[]; scouted?: number; new_replies?: number }> {
  return apiFetch('/materials/collect-all', { method: 'POST' })
}

export async function getUnclassifiedCount(): Promise<number> {
  const items = await apiFetch<Material[]>('/materials?status=active&limit=1000')
  return items.filter(m => !m.category && m.score >= 60).length
}

export interface ClassifyBatchResult {
  processed: number
  classified: number
  remaining: number
}

export async function classifyBatch(size?: number): Promise<ClassifyBatchResult> {
  return apiFetch('/materials/classify-batch', {
    method: 'POST',
    body: JSON.stringify(size !== undefined ? { size } : {}),
  })
}
```
（删除 `getRawCount`/`cleanBatch`/`CleanBatchResult`；`Material` 接口补 `parent_source_id?: string | null`；`new` 是合法属性名可直接用。）

- [ ] **Step 2: MaterialsClient.tsx 连动**

- import 行：`getRawCount, cleanBatch` → `getUnclassifiedCount, classifyBatch`
- 刷新逻辑（~367）：`getRawCount()` → `getUnclassifiedCount()`；state 命名 rawCount 可保留或改 unclassifiedCount（小范围，跟着现名走也行——选改名，含义准确）
- `handleCleanBatch`（~374-386）改为：
```tsx
  async function handleClassifyBatch() {
    setCleaning(true)
    try {
      const r = await classifyBatch()
      toast.success(`分类完成：${r.classified} 条已归类，剩余 ${r.remaining} 条待分类`)
      setUnclassifiedCount(r.remaining)
      setMaterials(await getMaterials({ limit: 500 }))
    } catch {
      toast.error('分类失败，请重试')
    } finally {
      setCleaning(false)
    }
  }
```
- 触发按钮文案：原「清洗」按钮改「补分类」，旁边计数文案改「N 条待分类」（grep `rawCount` 找到展示处）
- 「段子分」文案（~78-80、~482）改「热度分」
- 神回复徽章：列表项渲染处（~78 附近的 score 徽章旁）追加：
```tsx
            {m.parent_source_id && (
              <span className="text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">神回复</span>
            )}
```

- [ ] **Step 3: settings.ts + XSection.tsx 改名**

```bash
grep -rn "ref_clean_interval_minutes" web/lib/api/settings.ts web/app/settings/
```
全部 `ref_clean_interval_minutes` → `ref_classify_interval_minutes`；XSection 中对应 label 文案「清洗间隔」→「分类间隔」（以实际文案为准）。

- [ ] **Step 4: 类型检查**

Run: `cd /workspace/projects/WeMediaStudio/web && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 5: Commit**

```bash
git -C /workspace/projects/WeMediaStudio add web/
git -C /workspace/projects/WeMediaStudio commit -m "feat(ref): 前端连动——补分类按钮/神回复徽章/热度分文案/设置项改名"
```

---

## Task 10: 残留清理 + 全量回归

**Files:**
- 全仓 grep 残留引用

- [ ] **Step 1: 残留引用清零**

```bash
grep -rn "classify_ref_posts\|clean_batch\|clean-batch\|new_raw\|ref_clean" \
  /workspace/projects/WeMediaStudio/backend /workspace/projects/WeMediaStudio/web \
  --include="*.py" --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v __pycache__
```
Expected: 仅剩 `clean_batch_size`（保留的 config key）与历史注释；其余出现处逐一修复。

- [ ] **Step 2: 后端全量测试**

Run: `conda run -n wems python -m pytest 2>&1 | tail -5`
Expected: **0 failed**（既存 13 失败中：writing_plans 9 个不属于本计划——若仍失败属 pre-existing，单列报告；ref 系 4 个必须清零）
注：跑全量约 6 分钟，放后台跑。

- [ ] **Step 3: 前端 tsc**

Run: `cd /workspace/projects/WeMediaStudio/web && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: 手动冒烟（真实环境）**

```bash
cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -c "
import asyncio
from database import SessionLocal
from ref_collector import collect_all, classify_batch
async def go():
    async with SessionLocal() as db:
        print('collect_all:', await collect_all(db))
asyncio.run(go())
"
```
Expected: 正常返回 dict（new/failed），无异常。

- [ ] **Step 5: Commit（如有清理改动）**

```bash
git -C /workspace/projects/WeMediaStudio add -u
git -C /workspace/projects/WeMediaStudio commit -m "chore(ref): 清理旧清洗线残留引用"
```

---

## Self-Review

**Spec 覆盖核对：**
- 漏斗五步（prefilter/seen/近重复/打分/text_clean→active）→ Task 5 ✅
- 打分公式+绝对刻度+config scale → Task 1 + Task 5/8 ✅
- 近重复（3-gram+词、14 天窗口、高分替换低分）→ Task 2 + Task 5 ✅
- 神回复（预算 5/top3/likes 门槛/x_replies 账本/parent_source_id/失败不标）→ Task 3 + Task 7 ✅
- 低频分类（min_score 60/只 category+scene_tags/失败留空重试）→ Task 4 + Task 6 + Task 8 ✅
- 移除清单（classify_ref_posts/clean_batch/raw 二态/clean-batch 端点/ref_clean job/4 个失败测试）→ Task 4/5/6/8/10 ✅
- 5 个新 config → Task 8 ✅；settings 连动 → Task 8/9 ✅
- UI（补分类按钮/神回复徽章/热度分/分类间隔文案）→ Task 9 ✅
- ALTER 语句 → Task 3 ✅

**类型一致性：** `engagement_score(likes, reposts, replies, views, *, scale)`（Task 1 定义，5/7 一致引用）；`PreparedText/similarity/DEFAULT_THRESHOLD`（Task 2 定义，5 引用）；`classify_ref_categories(posts, categories, scene_tags)`（Task 4 定义，5 的 import 与 6 的 classify_batch 一致）；`collect_rule → list[RefMaterial]`（Task 5 定义，6 router len() 一致）；`scout_replies(db) → {scouted, new_replies}`（Task 7 定义，7/8 调用点一致）；`_mark_seen(db, source_id, verdict, platform="x")` 签名扩展（Task 5），Task 7 关键字调用一致。

**占位符扫描：** 无 TBD/TODO；所有代码步骤含完整代码；"以实际文件为准微调"仅出现在保留既有日志风格的指引处，属合理执行弹性。

**已知风险：** test_materials_router/test_ref_scheduler 可能引用旧接口名——Task 6/8 内置了同步修复指引。
