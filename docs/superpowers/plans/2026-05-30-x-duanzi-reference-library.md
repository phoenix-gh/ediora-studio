# 统一参考文案库（X 泛流量段子 + 金句库合并）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 X Top 搜索打捞的泛流量段子，经规则粗筛 + LLM 精筛，沉淀进一个统一的「参考文案库」；同时把现有金句库整体并入同一张表。

**Architecture:** 一张 `ref_materials` 表承载两类条目——手工金句(`platform` in manual/agent，从 `quotes` 迁移) + 采集段子(`platform=x`)，用 `platform` 判别。两个正交维度：`category`(内容分类) + `scene_tags`(使用场景)。采集走 feedgrab operator-only Top 搜索(已 spike 验证)，`RefSeen` 账本去重避免重复过 LLM。MCP `list_quotes`/`save_quote` 重指到统一表、行为不变。

**Tech Stack:** FastAPI + SQLAlchemy(async) + Postgres(prod)/SQLite(test)、feedgrab 0.1.0、多 Provider LLM 层(`llm.py`)、APScheduler、Next.js(shadcn/ui + tailwind + sonner + lucide)。

**关键约定（务必遵守）：**
- 所有 python/pytest 命令加前缀：`source ~/.zshrc && cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest ...`
- 后端无迁移框架：新表靠 `Base.metadata.create_all`（在 `database.py:init_db`）自动建；金句数据迁移放进 `init_db` 的幂等 raw SQL（沿用现有 `ALTER ... IF NOT EXISTS` / `UPDATE ... WHERE` 风格）。
- API 前缀 `/api`。测试沿用 `tests/test_x_router.py` 的 inline `client` fixture（sqlite + `WMS_DISABLE_SCHEDULER=1`）。
- spec：`docs/superpowers/specs/2026-05-30-x-hot-duanzi-reference-library-design.md`；spike：`docs/superpowers/spikes/2026-05-30-x-top-search-operator-only.md`。
- 前端无测试框架 → 前端任务用「跑 dev server 手工验证」代替单测。先读 `wemedia-studio/AGENTS.md`（Next.js 有 breaking changes）。

---

## File Structure

**后端（新建）**
- `backend/ref_collector.py` — 粗筛 + 调 LLM 精筛 + upsert + 写 seen + 逐规则采集。
- `backend/routers/materials.py` — 条目 + 采集规则的 REST API。
- `backend/tests/test_ref_search_top.py` / `test_ref_collector.py` / `test_materials_router.py` / `test_ref_migrate.py`

**后端（修改）**
- `backend/models.py` — 加 `RefMaterial` / `RefCollectRule` / `RefSeen`。
- `backend/feedgrab_client.py` — 加 `search_top()`；`ParsedPost` 加 `possibly_sensitive`；parser 提取它。
- `backend/llm.py` — 加 `classify_ref_posts()`。
- `backend/config.py` — `DEFAULTS` 加 `ref_categories`。
- `backend/scheduler.py` — 加 `scheduled_ref_collect()` + 注册。
- `backend/database.py` — `init_db` 末尾加幂等金句迁移。
- `backend/mcp_server.py` — `list_quotes`/`save_quote` 重指 `RefMaterial`。
- `backend/main.py` — include `materials.router`；移除 `quotes.router`。
- `backend/routers/quotes.py` — 删除。

**前端（新建/修改）**
- `wemedia-studio/lib/api/materials.ts`（新）、`app/materials/page.tsx`（新）、`app/materials/MaterialsClient.tsx`（新）
- `components/features/Sidebar.tsx`（改名 + 路由）；删 `app/quotes/*`、`lib/api/quotes.ts`

---

## Phase 1 — 后端核心（采集 + 存储 + API）

### Task 1: 数据模型 RefMaterial / RefCollectRule / RefSeen

**Files:**
- Modify: `backend/models.py`（文件末尾追加；确认顶部已 `from sqlalchemy import ... UniqueConstraint`，没有则加）
- Test: `backend/tests/test_ref_models.py`

- [ ] **Step 1: 写失败测试**

```python
# backend/tests/test_ref_models.py
import sys, asyncio, pytest

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


def test_ref_material_roundtrip(db_session):
    from models import RefMaterial
    async def _run():
        async with db_session() as db:
            m = RefMaterial(platform="x", source_id="111", text="段子",
                            category="沙雕搞笑", scene_tags=["resonance"],
                            likes=9000, score=88)
            db.add(m)
            await db.commit()
            await db.refresh(m)
            assert m.id > 0 and m.status == "active" and m.scene_tags == ["resonance"]
    asyncio.new_event_loop().run_until_complete(_run())


def test_ref_material_unique_platform_source(db_session):
    from models import RefMaterial
    from sqlalchemy.exc import IntegrityError
    async def _run():
        async with db_session() as db:
            db.add(RefMaterial(platform="x", source_id="dup", text="a"))
            await db.commit()
        async with db_session() as db:
            db.add(RefMaterial(platform="x", source_id="dup", text="b"))
            with pytest.raises(IntegrityError):
                await db.commit()
    asyncio.new_event_loop().run_until_complete(_run())
```

- [ ] **Step 2: 跑测试确认失败**

Run: `source ~/.zshrc && cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_ref_models.py -v`
Expected: FAIL — `ImportError: cannot import name 'RefMaterial'`

- [ ] **Step 3: 实现模型**

在 `backend/models.py` 末尾追加（确认顶部 import 含 `UniqueConstraint`；`now_utc` 已在本文件定义）：

```python
class RefMaterial(Base):
    """统一参考文案条目：手工金句(platform=manual/agent) + 采集段子(platform=x)。"""
    __tablename__ = "ref_materials"
    __table_args__ = (
        UniqueConstraint("platform", "source_id", name="uq_ref_materials_platform_source"),
    )
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    platform: Mapped[str] = mapped_column(String, default="manual", index=True)
    source_id: Mapped[str | None] = mapped_column(String, nullable=True)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    text_clean: Mapped[str] = mapped_column(Text, default="")
    author: Mapped[str] = mapped_column(String, default="")
    handle: Mapped[str] = mapped_column(String, default="")
    source: Mapped[str] = mapped_column(String, default="")
    source_url: Mapped[str] = mapped_column(String, default="")
    cover_image: Mapped[str] = mapped_column(String, default="")
    likes: Mapped[int] = mapped_column(Integer, default=0)
    reposts: Mapped[int] = mapped_column(Integer, default=0)
    replies: Mapped[int] = mapped_column(Integer, default=0)
    views: Mapped[int] = mapped_column(Integer, default=0)
    score: Mapped[int] = mapped_column(Integer, default=0, index=True)
    category: Mapped[str] = mapped_column(String, default="", index=True)
    scene_tags: Mapped[list] = mapped_column(JSON, default=list)
    tags: Mapped[list] = mapped_column(JSON, default=list)
    writing_plan_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    rule_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status: Mapped[str] = mapped_column(String, default="active", index=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)


class RefCollectRule(Base):
    """采集规则 —— 一条 X Top 搜索 saved query。"""
    __tablename__ = "ref_collect_rules"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    label: Mapped[str] = mapped_column(String, default="")
    platform: Mapped[str] = mapped_column(String, default="x")
    min_faves: Mapped[int] = mapped_column(Integer, default=1500)
    min_retweets: Mapped[int] = mapped_column(Integer, default=0)
    lang: Mapped[str] = mapped_column(String, default="zh")
    days: Mapped[int] = mapped_column(Integer, default=2)
    exclude_sensitive: Mapped[bool] = mapped_column(Boolean, default=True)
    extra_terms: Mapped[str] = mapped_column(String, default="")
    raw_query: Mapped[str] = mapped_column(String, default="")
    sort: Mapped[str] = mapped_column(String, default="top")
    max_results: Mapped[int] = mapped_column(Integer, default=100)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    last_collected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error: Mapped[str] = mapped_column(String, default="")
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, index=True)


class RefSeen(Base):
    """去重账本：已评估的 source_id，避免重复爆款二次过 LLM。"""
    __tablename__ = "ref_seen"
    __table_args__ = (
        UniqueConstraint("platform", "source_id", name="uq_ref_seen_platform_source"),
    )
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    platform: Mapped[str] = mapped_column(String, default="x")
    source_id: Mapped[str] = mapped_column(String, nullable=False)
    verdict: Mapped[str] = mapped_column(String, default="rejected")
    seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `source ~/.zshrc && cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_ref_models.py -v`
Expected: PASS（2 passed）

- [ ] **Step 5: 提交**

```bash
cd /workspace/projects/WeMediaStudio && git add backend/models.py backend/tests/test_ref_models.py
git commit -m "feat(models): RefMaterial/RefCollectRule/RefSeen for reference library"
```

---

### Task 2: config 加 `ref_categories` 默认

**Files:**
- Modify: `backend/config.py`（`DEFAULTS` dict）

- [ ] **Step 1: 加默认值**

在 `backend/config.py` 的 `DEFAULTS` 里加一行（逗号分隔，前端/路由按 `,` split）：

```python
    "ref_categories": "吐槽锐评,沙雕搞笑,温情共鸣,反转梗,金句格言,冷知识科普,热点观点,生活观察,职场打工,情感两性,其他",
```

- [ ] **Step 2: 验证可读**

Run: `source ~/.zshrc && cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -c "from config import DEFAULTS; print(DEFAULTS['ref_categories'].split(','))"`
Expected: 打印 11 个分类的列表。

- [ ] **Step 3: 提交**

```bash
cd /workspace/projects/WeMediaStudio && git add backend/config.py
git commit -m "feat(config): add ref_categories default vocabulary"
```

---

### Task 3: feedgrab `search_top()` + ParsedPost.possibly_sensitive

**Files:**
- Modify: `backend/feedgrab_client.py`
- Test: `backend/tests/test_ref_search_top.py`

- [ ] **Step 1: 写失败测试**

```python
# backend/tests/test_ref_search_top.py
import asyncio


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


# ── 纯函数：查询构建（无 I/O，不碰 cookies）─────────────────────────────
def test_build_top_query_operator_only():
    import feedgrab_client as fc
    q = fc._build_top_query(min_faves=1500, min_retweets=0, lang="zh", days=2, extra_terms="")
    assert "min_faves:1500" in q and "lang:zh" in q
    assert "-filter:replies" in q and "-filter:links" in q and "-filter:retweets" in q
    assert "since:" in q
    assert "min_retweets" not in q          # 0 → 省略


def test_build_top_query_with_seed_and_no_since():
    import feedgrab_client as fc
    q = fc._build_top_query(min_faves=0, min_retweets=50, lang="", days=0, extra_terms="哈哈")
    assert q.startswith("哈哈") and "min_retweets:50" in q
    assert "since:" not in q and "lang:" not in q


# ── search_top：query 选择 + 解析（patch 同步 fetch，绕开 cookies/事件循环）──
def test_search_top_uses_raw_query_and_parses(monkeypatch):
    import feedgrab_client as fc
    captured = {}
    def fake_fetch(query, limit, sort):
        captured.update(query=query, limit=limit, sort=sort)
        return [{"id": "1", "text": "hi", "author": "a", "likes": 9000,
                 "possibly_sensitive": True}]
    monkeypatch.setattr(fc, "_fetch_search_top_raw", fake_fetch)
    posts = _run(fc.search_top(raw_query="min_faves:9 lang:zh", sort="top", limit=20))
    assert captured["query"] == "min_faves:9 lang:zh"
    assert captured["sort"] == "top" and captured["limit"] == 20
    assert len(posts) == 1 and posts[0].tweet_id == "1" and posts[0].possibly_sensitive is True


def test_search_top_builds_query_when_no_raw(monkeypatch):
    import feedgrab_client as fc
    captured = {}
    def fake_fetch(query, limit, sort):
        captured.update(query=query)
        return []
    monkeypatch.setattr(fc, "_fetch_search_top_raw", fake_fetch)
    _run(fc.search_top(raw_query="", min_faves=1500, lang="zh", days=2, extra_terms="哈哈"))
    assert "哈哈" in captured["query"] and "min_faves:1500" in captured["query"]


# ── 透传到 feedgrab：patch cookies + search_twitter_keyword（均为模块级名）──
def test_search_top_passthrough_to_feedgrab(monkeypatch):
    import feedgrab_client as fc
    captured = {}
    async def fake_search(**kwargs):
        captured.update(kwargs)
        return {"tweets": []}
    monkeypatch.setattr(fc, "load_twitter_cookies", lambda: {"auth_token": "x", "ct0": "y"})
    monkeypatch.setattr(fc, "search_twitter_keyword", fake_search)
    _run(fc.search_top(raw_query="q1", sort="top", limit=15))
    assert captured["keyword"] == "q1" and captured["raw"] is True
    assert captured["sort"] == "top" and captured["max_results"] == 15
    assert captured["save_tweets"] is False and captured["skip_summary"] is True
```

- [ ] **Step 2: 跑测试确认失败**

Run: `source ~/.zshrc && cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_ref_search_top.py -v`
Expected: FAIL — `AttributeError: module 'feedgrab_client' has no attribute 'search_top'`

- [ ] **Step 3: 实现**

(a) 在 `feedgrab_client.py` 的 `ParsedPost` dataclass 末尾加字段：

```python
    possibly_sensitive: bool = False
```

(b) 在 `_tweet_dict_to_parsed_post` 的 `return ParsedPost(` 调用里加一项（紧跟 `raw_markdown=raw_markdown,`）：

```python
        possibly_sensitive=bool(d.get("possibly_sensitive", False)),
```

(c) 在 I/O 层（文件末尾、`auth_status` 之前）加 `search_top`。注意顶部已 `import asyncio`，需要 `from datetime import date, timedelta`（`datetime` 已导入，补 `date`/`timedelta`）：

```python
from datetime import date as _date, timedelta as _timedelta  # noqa: E402


def _build_top_query(*, min_faves: int, min_retweets: int, lang: str,
                     days: int, extra_terms: str) -> str:
    parts: list[str] = []
    if extra_terms.strip():
        parts.append(extra_terms.strip())
    if min_faves > 0:
        parts.append(f"min_faves:{min_faves}")
    if min_retweets > 0:
        parts.append(f"min_retweets:{min_retweets}")
    if lang:
        parts.append(f"lang:{lang}")
    parts += ["-filter:replies", "-filter:links", "-filter:retweets"]
    if days > 0:
        since = (_date.today() - _timedelta(days=days)).isoformat()
        parts.append(f"since:{since}")
    return " ".join(parts)


def _fetch_search_top_raw(query: str, limit: int, sort: str) -> list[dict]:
    # load_twitter_cookies / search_twitter_keyword 为模块级名（见 (d)），方便测试 patch
    cookies = load_twitter_cookies()
    if not (cookies.get("auth_token") and cookies.get("ct0")):
        raise RuntimeError("X 未登录 — 请在 backend 工作目录运行：feedgrab login twitter")
    loop = asyncio.new_event_loop()
    try:
        result = loop.run_until_complete(search_twitter_keyword(
            keyword=query, raw=True, sort=sort, max_results=limit,
            save_tweets=False, skip_summary=True,
        ))
    finally:
        loop.close()
    return list(result.get("tweets") or [])


async def search_top(raw_query: str = "", *, min_faves: int = 0, min_retweets: int = 0,
                     lang: str = "", days: int = 1, extra_terms: str = "",
                     sort: str = "top", limit: int = 100) -> list[ParsedPost]:
    """X Top 搜索（互动度排序）。raw_query 非空时原样用作 operator-only 查询；
    否则用结构化参数构建一条 operator 查询。两路都走 raw=True。"""
    query = raw_query.strip() or _build_top_query(
        min_faves=min_faves, min_retweets=min_retweets, lang=lang,
        days=days, extra_terms=extra_terms,
    )
    raw = await asyncio.to_thread(_fetch_search_top_raw, query, limit, sort)
    out: list[ParsedPost] = []
    for d in raw:
        if isinstance(d, dict):
            p = _tweet_dict_to_parsed_post(d)
            if p:
                out.append(p)
    return out
```

(d) 让 `load_twitter_cookies` 与 `search_twitter_keyword` 成为 `feedgrab_client` 的**模块级名字**，这样测试能 `monkeypatch.setattr(fc, "...", ...)`。在 I/O 层顶部（`import asyncio` 附近）加：

```python
from feedgrab.fetchers.twitter_cookies import load_twitter_cookies  # noqa: E402
from feedgrab.fetchers.twitter_keyword_search import search_twitter_keyword  # noqa: E402
```

`_fetch_search_top_raw` 直接用这两个模块级名（已无局部 import）。其它老函数（`_fetch_timeline_raw` / `_fetch_search_raw` 等）保留各自的局部 import，互不影响（局部名会在各自函数内遮蔽模块名）。

- [ ] **Step 4: 跑测试确认通过**

Run: `source ~/.zshrc && cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_ref_search_top.py -v`
Expected: PASS（3 passed）

- [ ] **Step 5: 跑现有 feedgrab 测试确认没回归**

Run: `source ~/.zshrc && cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_feedgrab_client.py -v`
Expected: PASS（possibly_sensitive 默认 False，向后兼容）

- [ ] **Step 6: 提交**

```bash
cd /workspace/projects/WeMediaStudio && git add backend/feedgrab_client.py backend/tests/test_ref_search_top.py
git commit -m "feat(feedgrab): add search_top + ParsedPost.possibly_sensitive"
```

---

### Task 4: LLM 精筛 `classify_ref_posts()`

**Files:**
- Modify: `backend/llm.py`（文件末尾追加；`_call`/`_extract_json_array` 已存在）
- Test: `backend/tests/test_ref_classify.py`

- [ ] **Step 1: 写失败测试**

```python
# backend/tests/test_ref_classify.py
import asyncio, json
from unittest.mock import patch


def test_classify_ref_posts_maps_by_source_id():
    import llm
    fake = json.dumps([
        {"source_id": "1", "keep": True, "score": 90, "category": "沙雕搞笑",
         "scene_tags": ["resonance"], "tags": ["梗"], "text_clean": "干净版"},
        {"source_id": "2", "keep": False, "score": 10, "category": "其他",
         "scene_tags": [], "tags": [], "text_clean": ""},
    ])
    async def fake_call(prompt, max_tokens=2048):
        return fake
    posts = [{"source_id": "1", "text": "段子1", "likes": 9000},
             {"source_id": "2", "text": "广告2", "likes": 8000}]
    with patch("llm._call", new=fake_call):
        res = asyncio.new_event_loop().run_until_complete(
            llm.classify_ref_posts(posts, categories=["沙雕搞笑", "其他"],
                                   scene_tags=["resonance"]))
    by_id = {r["source_id"]: r for r in res}
    assert by_id["1"]["keep"] is True and by_id["1"]["score"] == 90
    assert by_id["1"]["category"] == "沙雕搞笑"
    assert by_id["2"]["keep"] is False


def test_classify_ref_posts_empty_input_no_llm_call():
    import llm
    called = {"n": 0}
    async def fake_call(prompt, max_tokens=2048):
        called["n"] += 1
        return "[]"
    with patch("llm._call", new=fake_call):
        res = asyncio.new_event_loop().run_until_complete(
            llm.classify_ref_posts([], categories=["其他"], scene_tags=[]))
    assert res == [] and called["n"] == 0
```

- [ ] **Step 2: 跑测试确认失败**

Run: `source ~/.zshrc && cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_ref_classify.py -v`
Expected: FAIL — `AttributeError: module 'llm' has no attribute 'classify_ref_posts'`

- [ ] **Step 3: 实现**

在 `backend/llm.py` 末尾追加：

```python
async def classify_ref_posts(
    posts: list[dict],
    categories: list[str],
    scene_tags: list[str],
) -> list[dict]:
    """批量判定爆款帖是否值得作参考文案 + 打分 + 归类 + 标使用场景 + 清洗。
    posts[i]: {source_id, text, likes, ...}
    返回 [{source_id, keep, score, category, scene_tags, tags, text_clean}]。
    解析失败/空 → 返回 []（调用方据此整批跳过）。"""
    if not posts:
        return []

    posts_text = "\n\n".join(
        f"[{p['source_id']}] 赞{p.get('likes', 0)}：{(p.get('text') or '')[:400]}"
        for p in posts[:40]
    )
    cat_list = "、".join(categories)
    scene_list = "、".join(scene_tags)

    prompt = f"""你是中文自媒体的「参考文案」筛选与归类 AI。下面是一批 X 平台高赞帖子，
判断每条是否值得收进「参考文案库」（有梗、有共鸣、有观点、可复用为写作素材即 keep=true；
广告/带货/纯导流/无信息量/低俗无价值 → keep=false）。

帖子（格式 [id] 赞数：正文）：
{posts_text}

对每条输出一个对象，组成 JSON 数组，字段：
- source_id: 原样回传方括号里的 id（字符串）
- keep: true/false
- score: 0-100，参考价值/段子分
- category: 从[{cat_list}]中选一个；不确定填「其他」
- scene_tags: 从[{scene_list}]中选 0 个或多个（写作中的使用场景）
- tags: 2-4 个自由细标签（字符串数组）
- text_clean: 去掉 @提及/链接尾巴/多余 emoji 后的干净参考文案（保留原意）

只输出 JSON 数组，不要其他文字。"""

    try:
        result = _extract_json_array(await _call(prompt, max_tokens=3000))
    except Exception as e:
        print(f"[llm] classify_ref_posts error: {e}")
        return []
    return result if isinstance(result, list) else []
```

- [ ] **Step 4: 跑测试确认通过**

Run: `source ~/.zshrc && cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_ref_classify.py -v`
Expected: PASS（2 passed）

- [ ] **Step 5: 提交**

```bash
cd /workspace/projects/WeMediaStudio && git add backend/llm.py backend/tests/test_ref_classify.py
git commit -m "feat(llm): add classify_ref_posts for reference-material refining"
```

---

### Task 5: `ref_collector.py`（粗筛 + 精筛 + 入库 + seen）

**Files:**
- Create: `backend/ref_collector.py`
- Test: `backend/tests/test_ref_collector.py`

- [ ] **Step 1: 写失败测试（粗筛规则）**

```python
# backend/tests/test_ref_collector.py
import sys, asyncio, pytest
from unittest.mock import patch, AsyncMock


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


def _post(tid, text="这是一个挺好笑的段子内容哈哈", sensitive=False, likes=9000):
    from feedgrab_client import ParsedPost
    from datetime import datetime, timezone
    return ParsedPost(tweet_id=tid, username="u", display_name="U", content=text,
                      url=f"https://x.com/u/status/{tid}",
                      published_at=datetime.now(timezone.utc),
                      replies=1, reposts=2, likes=likes, views=likes*10,
                      possibly_sensitive=sensitive)


def test_prefilter_drops_sensitive_short_link_mention():
    from ref_collector import _prefilter
    posts = [
        _post("ok"),                                   # keep
        _post("sens", sensitive=True),                 # drop: sensitive
        _post("short", text="哈"),                      # drop: too short
        _post("link", text="好物推荐 http://t.co/x"),    # drop: link
        _post("at", text="@a @b @c @d"),                # drop: mention-heavy
    ]
    kept = _prefilter(posts, exclude_sensitive=True)
    assert [p.tweet_id for p in kept] == ["ok"]
```

- [ ] **Step 2: 跑测试确认失败**

Run: `source ~/.zshrc && cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_ref_collector.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'ref_collector'`

- [ ] **Step 3: 实现粗筛 + 采集主流程**

```python
# backend/ref_collector.py
"""把 X Top 搜索结果提炼成参考文案：规则粗筛 → LLM 精筛 → 入库 + seen。"""
from __future__ import annotations
import re
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.dialects.postgresql import insert as _pg_insert
from sqlalchemy.dialects.sqlite import insert as _sl_insert

from models import RefMaterial, RefCollectRule, RefSeen
from feedgrab_client import ParsedPost, search_top
from llm import classify_ref_posts
from config import get_config

_URL_RE = re.compile(r"https?://")


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


def _insert(stmt_table, dialect: str):
    return _sl_insert(stmt_table) if dialect == "sqlite" else _pg_insert(stmt_table)


async def _already_seen(db: AsyncSession, source_ids: list[str]) -> set[str]:
    if not source_ids:
        return set()
    rows = (await db.execute(
        select(RefSeen.source_id).where(
            RefSeen.platform == "x", RefSeen.source_id.in_(source_ids))
    )).scalars().all()
    return set(rows)


async def _mark_seen(db: AsyncSession, source_id: str, verdict: str):
    dialect = db.bind.dialect.name if db.bind else "postgresql"
    stmt = _insert(RefSeen, dialect).values(
        platform="x", source_id=source_id, verdict=verdict,
        seen_at=datetime.now(timezone.utc),
    ).on_conflict_do_nothing(index_elements=["platform", "source_id"])
    await db.execute(stmt)


async def _upsert_material(db: AsyncSession, rule_id: int, p: ParsedPost, v: dict):
    dialect = db.bind.dialect.name if db.bind else "postgresql"
    stmt = _insert(RefMaterial, dialect).values(
        platform="x", source_id=p.tweet_id, text=p.content,
        text_clean=(v.get("text_clean") or ""), author=p.display_name,
        handle=p.username, source_url=p.url, cover_image=p.cover_image,
        likes=p.likes, reposts=p.reposts, replies=p.replies, views=p.views,
        score=int(v.get("score") or 0), category=(v.get("category") or ""),
        scene_tags=list(v.get("scene_tags") or []), tags=list(v.get("tags") or []),
        rule_id=rule_id, status="active", published_at=p.published_at,
        created_at=datetime.now(timezone.utc), updated_at=datetime.now(timezone.utc),
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=["platform", "source_id"],
        set_={"likes": stmt.excluded.likes, "reposts": stmt.excluded.reposts,
              "replies": stmt.excluded.replies, "views": stmt.excluded.views,
              "score": stmt.excluded.score, "category": stmt.excluded.category,
              "scene_tags": stmt.excluded.scene_tags, "updated_at": stmt.excluded.updated_at},
    )
    await db.execute(stmt)


async def collect_rule(db: AsyncSession, rule: RefCollectRule) -> int:
    """采集一条规则，返回新入库/更新的条目数。异常写 rule.last_error 后抛出。"""
    try:
        posts = await search_top(
            raw_query=rule.raw_query, min_faves=rule.min_faves,
            min_retweets=rule.min_retweets, lang=rule.lang, days=rule.days,
            extra_terms=rule.extra_terms, sort=rule.sort, limit=rule.max_results,
        )
    except Exception as e:
        rule.last_error = str(e)[:500]
        await db.commit()
        raise

    seen = await _already_seen(db, [p.tweet_id for p in posts])
    fresh = [p for p in posts if p.tweet_id not in seen]
    survivors = _prefilter(fresh, exclude_sensitive=rule.exclude_sensitive)

    # 被粗筛掉的 fresh 也记 seen（rejected），避免下次重复处理
    survivor_ids = {p.tweet_id for p in survivors}
    for p in fresh:
        if p.tweet_id not in survivor_ids:
            await _mark_seen(db, p.tweet_id, "rejected")

    kept = 0
    if survivors:
        cfg = await get_config()
        categories = [c for c in cfg.get("ref_categories", "").split(",") if c]
        scene_tags = ["opener", "closer", "argument", "twist", "resonance", "warning"]
        payload = [{"source_id": p.tweet_id, "text": p.content, "likes": p.likes}
                   for p in survivors]
        verdicts = await classify_ref_posts(payload, categories, scene_tags)
        vmap = {str(v.get("source_id")): v for v in verdicts}
        by_id = {p.tweet_id: p for p in survivors}
        for sid, p in by_id.items():
            v = vmap.get(sid)
            if v and v.get("keep"):
                await _upsert_material(db, rule.id, p, v)
                await _mark_seen(db, sid, "kept")
                kept += 1
            elif v is not None:
                await _mark_seen(db, sid, "rejected")
            # v is None（LLM 没回这条/整批失败）→ 不记 seen，下次再试

    rule.last_collected_at = datetime.now(timezone.utc)
    rule.last_error = ""
    await db.commit()
    return kept


async def collect_all(db: AsyncSession) -> dict:
    rules = (await db.execute(
        select(RefCollectRule).where(RefCollectRule.enabled == True)  # noqa: E712
    )).scalars().all()
    total, failed = 0, []
    for rule in rules:
        try:
            total += await collect_rule(db, rule)
        except Exception as e:
            failed.append(f"{rule.label}: {e}")
    return {"checked": len(rules), "new_materials": total, "failed": failed}
```

- [ ] **Step 4: 跑粗筛测试确认通过**

Run: `source ~/.zshrc && cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_ref_collector.py -v`
Expected: PASS（1 passed）

- [ ] **Step 5: 写采集流程测试（seen 去重 + 仅 kept 入库 + 批失败不污染）**

追加到 `tests/test_ref_collector.py`：

```python
def _rule(db_session):
    from models import RefCollectRule
    async def _mk():
        async with db_session() as db:
            r = RefCollectRule(label="t", raw_query="min_faves:1 lang:zh",
                               exclude_sensitive=True, max_results=20)
            db.add(r); await db.commit(); await db.refresh(r)
            return r.id
    return asyncio.new_event_loop().run_until_complete(_mk())


def test_collect_rule_only_keeps_kept_and_writes_seen(db_session, monkeypatch):
    monkeypatch.setenv("LLM_FAKE", "1")
    import ref_collector as rc
    from models import RefMaterial, RefSeen
    rid = _rule(db_session)

    async def fake_search(**kw):
        return [_post("k1"), _post("d1")]
    async def fake_classify(posts, categories, scene_tags):
        return [{"source_id": "k1", "keep": True, "score": 80, "category": "沙雕搞笑",
                 "scene_tags": ["resonance"], "tags": ["a"], "text_clean": "净"},
                {"source_id": "d1", "keep": False, "score": 5, "category": "其他",
                 "scene_tags": [], "tags": [], "text_clean": ""}]
    async def fake_cfg():
        return {"ref_categories": "沙雕搞笑,其他"}

    async def _run():
        async with db_session() as db:
            from models import RefCollectRule
            rule = await db.get(RefCollectRule, rid)
            with patch.object(rc, "search_top", new=fake_search), \
                 patch.object(rc, "classify_ref_posts", new=fake_classify), \
                 patch.object(rc, "get_config", new=fake_cfg):
                kept = await rc.collect_rule(db, rule)
            assert kept == 1
            mats = (await db.execute(__import__("sqlalchemy").select(RefMaterial))).scalars().all()
            assert {m.source_id for m in mats} == {"k1"}
            seen = (await db.execute(__import__("sqlalchemy").select(RefSeen))).scalars().all()
            assert {s.source_id: s.verdict for s in seen} == {"k1": "kept", "d1": "rejected"}
    asyncio.new_event_loop().run_until_complete(_run())


def test_collect_rule_skips_seen_ids(db_session):
    import ref_collector as rc
    from models import RefCollectRule, RefSeen
    rid = _rule(db_session)

    async def fake_search(**kw):
        return [_post("already")]
    async def boom_classify(*a, **k):
        raise AssertionError("should not classify a seen id")
    async def fake_cfg():
        return {"ref_categories": "其他"}

    async def _run():
        async with db_session() as db:
            db.add(RefSeen(platform="x", source_id="already", verdict="rejected"))
            await db.commit()
            rule = await db.get(RefCollectRule, rid)
            with patch.object(rc, "search_top", new=fake_search), \
                 patch.object(rc, "classify_ref_posts", new=boom_classify), \
                 patch.object(rc, "get_config", new=fake_cfg):
                kept = await rc.collect_rule(db, rule)
            assert kept == 0
    asyncio.new_event_loop().run_until_complete(_run())
```

- [ ] **Step 6: 跑全部 collector 测试确认通过**

Run: `source ~/.zshrc && cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_ref_collector.py -v`
Expected: PASS（3 passed）

- [ ] **Step 7: 提交**

```bash
cd /workspace/projects/WeMediaStudio && git add backend/ref_collector.py backend/tests/test_ref_collector.py
git commit -m "feat(collector): ref_collector — prefilter + LLM refine + upsert + seen"
```

---

### Task 6: `routers/materials.py`（条目 + 采集规则 API）

**Files:**
- Create: `backend/routers/materials.py`
- Modify: `backend/main.py`（import + include + 移除 quotes 见 Task 10）
- Test: `backend/tests/test_materials_router.py`

- [ ] **Step 1: 写失败测试**

```python
# backend/tests/test_materials_router.py
import sys, asyncio, pytest
from unittest.mock import patch, AsyncMock
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch, tmp_path):
    db_file = tmp_path / "test.db"
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{db_file}")
    monkeypatch.setenv("WMS_DISABLE_SCHEDULER", "1")
    for mod in list(sys.modules):
        if mod.startswith(("database", "models", "main", "routers", "config")):
            sys.modules.pop(mod, None)
    from database import engine, Base
    import models  # noqa
    async def _create():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    asyncio.new_event_loop().run_until_complete(_create())
    from main import app
    return TestClient(app)


def test_manual_create_and_list(client):
    r = client.post("/api/materials", json={"text": "一句金句", "scene_tags": ["opener"]})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["platform"] == "manual" and body["text"] == "一句金句"
    items = client.get("/api/materials").json()
    assert len(items) == 1 and items[0]["scene_tags"] == ["opener"]


def test_categories_endpoint(client):
    cats = client.get("/api/materials/categories").json()
    assert "沙雕搞笑" in cats and "其他" in cats


def test_rules_crud_and_collect(client):
    r = client.post("/api/materials/rules", json={"label": "泛流量", "min_faves": 1500})
    assert r.status_code == 201, r.text
    rid = r.json()["id"]
    assert client.get("/api/materials/rules").json()[0]["label"] == "泛流量"

    with patch("routers.materials.collect_rule", new=AsyncMock(return_value=3)):
        c = client.post(f"/api/materials/rules/{rid}/collect")
    assert c.status_code == 200 and c.json()["new_materials"] == 3


def test_browse_filters_by_category_and_min_score(client):
    client.post("/api/materials", json={"text": "高分沙雕", "category": "沙雕搞笑"})
    # 直接造一条带 score 的（手工创建默认 score=0）→ 用 patch 创建段子类
    client.post("/api/materials", json={"text": "吐槽", "category": "吐槽锐评"})
    only = client.get("/api/materials?category=沙雕搞笑").json()
    assert [m["text"] for m in only] == ["高分沙雕"]
```

- [ ] **Step 2: 跑测试确认失败**

Run: `source ~/.zshrc && cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_materials_router.py -v`
Expected: FAIL（materials 路由不存在 → 404/连接失败）

- [ ] **Step 3: 实现 router**

```python
# backend/routers/materials.py
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, desc, asc, delete
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import RefMaterial, RefCollectRule
from config import get_config
from ref_collector import collect_rule, collect_all

router = APIRouter(prefix="/materials", tags=["materials"])

SCENE_TAGS = ["opener", "closer", "argument", "twist", "resonance", "warning"]


# ── Schemas ───────────────────────────────────────────────────────────────────
class MaterialOut(BaseModel):
    id: int
    platform: str
    source_id: Optional[str] = None
    text: str
    text_clean: str = ""
    author: str = ""
    handle: str = ""
    source: str = ""
    source_url: str = ""
    cover_image: str = ""
    likes: int = 0
    reposts: int = 0
    replies: int = 0
    views: int = 0
    score: int = 0
    category: str = ""
    scene_tags: list[str] = []
    tags: list[str] = []
    writing_plan_id: Optional[int] = None
    status: str = "active"
    published_at: Optional[datetime] = None
    created_at: datetime
    model_config = {"from_attributes": True}


class MaterialCreate(BaseModel):
    text: str
    author: str = ""
    source: str = ""
    source_url: str = ""
    category: str = ""
    scene_tags: list[str] = []
    tags: list[str] = []
    writing_plan_id: Optional[int] = None


class MaterialPatch(BaseModel):
    text: Optional[str] = None
    category: Optional[str] = None
    scene_tags: Optional[list[str]] = None
    tags: Optional[list[str]] = None
    status: Optional[str] = None
    writing_plan_id: Optional[int] = None


class RuleOut(BaseModel):
    id: int
    label: str
    min_faves: int
    min_retweets: int
    lang: str
    days: int
    exclude_sensitive: bool
    extra_terms: str
    raw_query: str
    sort: str
    max_results: int
    enabled: bool
    last_collected_at: Optional[datetime]
    last_error: str
    model_config = {"from_attributes": True}


class RuleCreate(BaseModel):
    label: str = ""
    min_faves: int = 1500
    min_retweets: int = 0
    lang: str = "zh"
    days: int = 2
    exclude_sensitive: bool = True
    extra_terms: str = ""
    raw_query: str = ""
    max_results: int = 100


class RulePatch(BaseModel):
    label: Optional[str] = None
    min_faves: Optional[int] = None
    min_retweets: Optional[int] = None
    lang: Optional[str] = None
    days: Optional[int] = None
    exclude_sensitive: Optional[bool] = None
    extra_terms: Optional[str] = None
    raw_query: Optional[str] = None
    max_results: Optional[int] = None
    enabled: Optional[bool] = None


# ── Categories / scene tags ─────────────────────────────────────────────────
@router.get("/categories", response_model=list[str])
async def get_categories():
    cfg = await get_config()
    return [c for c in cfg.get("ref_categories", "").split(",") if c]


@router.get("/scene-tags", response_model=list[str])
async def get_scene_tags():
    return SCENE_TAGS


# ── Materials browse / CRUD ─────────────────────────────────────────────────
@router.get("", response_model=list[MaterialOut])
async def list_materials(
    platform: str = "", category: str = "", scene_tag: str = "",
    min_score: int = 0, q: str = "", sort: str = "time",
    plan_id: int = 0, limit: int = 100, offset: int = 0,
    db: AsyncSession = Depends(get_db),
):
    stmt = select(RefMaterial).where(RefMaterial.status == "active")
    if platform:
        stmt = stmt.where(RefMaterial.platform == platform)
    if category:
        stmt = stmt.where(RefMaterial.category == category)
    if min_score > 0:
        stmt = stmt.where(RefMaterial.score >= min_score)
    if plan_id:
        stmt = stmt.where(RefMaterial.writing_plan_id == plan_id)
    order = {"score": desc(RefMaterial.score), "views": desc(RefMaterial.views),
             "time": desc(RefMaterial.created_at)}.get(sort, desc(RefMaterial.created_at))
    stmt = stmt.order_by(order).limit(1000)
    rows = list((await db.execute(stmt)).scalars().all())
    if scene_tag:
        rows = [r for r in rows if scene_tag in (r.scene_tags or [])]
    if q:
        s = q.lower()
        rows = [r for r in rows if s in r.text.lower() or s in (r.author or "").lower()]
    return rows[offset:offset + max(1, min(limit, 500))]


@router.post("", response_model=MaterialOut, status_code=201)
async def create_material(body: MaterialCreate, db: AsyncSession = Depends(get_db)):
    obj = RefMaterial(platform="manual", **body.model_dump())
    db.add(obj)
    await db.commit()
    await db.refresh(obj)
    return obj


@router.patch("/{mid}", response_model=MaterialOut)
async def patch_material(mid: int, body: MaterialPatch, db: AsyncSession = Depends(get_db)):
    obj = await db.get(RefMaterial, mid)
    if not obj:
        raise HTTPException(404, "条目不存在")
    for f, v in body.model_dump(exclude_none=True).items():
        setattr(obj, f, v)
    await db.commit()
    await db.refresh(obj)
    return obj


@router.delete("/{mid}", status_code=204)
async def delete_material(mid: int, db: AsyncSession = Depends(get_db)):
    obj = await db.get(RefMaterial, mid)
    if not obj:
        raise HTTPException(404, "条目不存在")
    await db.delete(obj)
    await db.commit()


# ── Collect rules ────────────────────────────────────────────────────────────
@router.get("/rules", response_model=list[RuleOut])
async def list_rules(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(
        select(RefCollectRule).order_by(desc(RefCollectRule.added_at)))).scalars().all()
    return rows


@router.post("/rules", response_model=RuleOut, status_code=201)
async def create_rule(body: RuleCreate, db: AsyncSession = Depends(get_db)):
    obj = RefCollectRule(**body.model_dump(), added_at=datetime.now(timezone.utc))
    db.add(obj)
    await db.commit()
    await db.refresh(obj)
    return obj


@router.patch("/rules/{rid}", response_model=RuleOut)
async def patch_rule(rid: int, body: RulePatch, db: AsyncSession = Depends(get_db)):
    obj = await db.get(RefCollectRule, rid)
    if not obj:
        raise HTTPException(404, "规则不存在")
    for f, v in body.model_dump(exclude_none=True).items():
        setattr(obj, f, v)
    await db.commit()
    await db.refresh(obj)
    return obj


@router.delete("/rules/{rid}")
async def delete_rule(rid: int, db: AsyncSession = Depends(get_db)):
    obj = await db.get(RefCollectRule, rid)
    if not obj:
        raise HTTPException(404, "规则不存在")
    await db.delete(obj)
    await db.commit()
    return {"ok": True}


@router.post("/rules/{rid}/collect")
async def collect_one_rule(rid: int, db: AsyncSession = Depends(get_db)):
    rule = await db.get(RefCollectRule, rid)
    if not rule:
        raise HTTPException(404, "规则不存在")
    try:
        n = await collect_rule(db, rule)
    except Exception as e:
        raise HTTPException(502, str(e))
    return {"ok": True, "new_materials": n}


@router.post("/collect-all")
async def collect_all_rules(db: AsyncSession = Depends(get_db)):
    return {"ok": True, **(await collect_all(db))}
```

- [ ] **Step 4: 在 main.py 注册 router**

`backend/main.py`：在第 13 行 import 末尾加 `materials`（与其它 router 并列）：
```python
from routers import accounts, collect, settings, github, x, papers, personas, upload, drafts, writing_plans, quotes, synthesize, youtube, producthunt, wechat, v2ex, kr, juejin, studio, publish_accounts, profiles, reddit, topic_generator, retro, materials
```
在 include 区（`reddit` 那批附近）加：
```python
app.include_router(materials.router, prefix="/api")
```
（`quotes` 的移除留到 Task 10，避免本任务测试因金句路由缺失而牵连。）

- [ ] **Step 5: 跑测试确认通过**

Run: `source ~/.zshrc && cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_materials_router.py -v`
Expected: PASS（4 passed）

- [ ] **Step 6: 提交**

```bash
cd /workspace/projects/WeMediaStudio && git add backend/routers/materials.py backend/main.py backend/tests/test_materials_router.py
git commit -m "feat(api): /materials router — items + collect rules"
```

---

### Task 7: scheduler 每日采集作业

**Files:**
- Modify: `backend/scheduler.py`
- Test: `backend/tests/test_ref_scheduler.py`

- [ ] **Step 1: 写失败测试**

```python
# backend/tests/test_ref_scheduler.py
import sys, asyncio, pytest
from unittest.mock import patch, AsyncMock


@pytest.fixture
def env(monkeypatch, tmp_path):
    db_file = tmp_path / "t.db"
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{db_file}")
    for mod in list(sys.modules):
        if mod.startswith(("database", "models", "config", "scheduler")):
            sys.modules.pop(mod, None)
    from database import engine, Base
    import models  # noqa
    async def _setup():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    asyncio.new_event_loop().run_until_complete(_setup())


def test_ref_collect_job_registered(env):
    import scheduler
    class FakeSched:
        def __init__(self): self.jobs = []
        def add_job(self, func, **kw): self.jobs.append(kw.get("id"))
    fs = FakeSched()
    scheduler.register_jobs(fs, {})
    assert "ref_collect_daily" in fs.jobs


def test_scheduled_ref_collect_runs(env):
    import scheduler
    with patch("ref_collector.collect_all", new=AsyncMock(return_value={"checked": 1, "new_materials": 2, "failed": []})):
        asyncio.new_event_loop().run_until_complete(scheduler.scheduled_ref_collect())
    # 不抛异常即通过
```

- [ ] **Step 2: 跑测试确认失败**

Run: `source ~/.zshrc && cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_ref_scheduler.py -v`
Expected: FAIL — `AttributeError: module 'scheduler' has no attribute 'scheduled_ref_collect'`

- [ ] **Step 3: 实现**

在 `backend/scheduler.py` 加作业函数（仿 `scheduled_x_collect`，放其后）：

```python
async def scheduled_ref_collect():
    """每日：跑所有启用的采集规则，提炼段子入参考文案库。"""
    from logger import log
    try:
        from ref_collector import collect_all
        async with SessionLocal() as db:
            result = await collect_all(db)
        if result["failed"]:
            await log("materials", "warn",
                      f"参考文案采集完成，新增 {result['new_materials']} 条",
                      "; ".join(result["failed"]))
        else:
            await log("materials", "ok",
                      f"参考文案采集完成，新增 {result['new_materials']} 条")
    except Exception as e:
        await log("materials", "error", "参考文案采集异常", str(e))
```

在 `register_jobs()` 的 `jobs` 列表里加一行（`reddit` 那行后）：
```python
        (scheduled_ref_collect,         dict(trigger="interval", hours=24,            id="ref_collect_daily")),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `source ~/.zshrc && cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_ref_scheduler.py -v`
Expected: PASS（2 passed）

- [ ] **Step 5: 提交**

```bash
cd /workspace/projects/WeMediaStudio && git add backend/scheduler.py backend/tests/test_ref_scheduler.py
git commit -m "feat(scheduler): daily ref_collect job"
```

---

## Phase 2 — 金句库合并

### Task 8: 金句数据迁移（init_db 内幂等）

**Files:**
- Create: `backend/ref_migrate.py`
- Modify: `backend/database.py`（`init_db` 末尾调用）
- Test: `backend/tests/test_ref_migrate.py`

- [ ] **Step 1: 写失败测试**

```python
# backend/tests/test_ref_migrate.py
import sys, asyncio, pytest


@pytest.fixture
def env(monkeypatch, tmp_path):
    db_file = tmp_path / "t.db"
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{db_file}")
    for mod in list(sys.modules):
        if mod.startswith(("database", "models", "config", "ref_migrate")):
            sys.modules.pop(mod, None)
    from database import engine, Base
    import models  # noqa
    async def _setup():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    asyncio.new_event_loop().run_until_complete(_setup())


def test_migrate_quotes_idempotent(env):
    from database import SessionLocal
    from models import Quote, RefMaterial
    from ref_migrate import migrate_quotes_to_materials
    from sqlalchemy import select

    async def _run():
        async with SessionLocal() as db:
            db.add(Quote(text="金句A", author="鲁迅", scene_tags=["opener"], platform="manual"))
            db.add(Quote(text="金句B", scene_tags=[], platform="agent"))
            await db.commit()
        # 跑两次，应只迁移一次
        async with SessionLocal() as db:
            await migrate_quotes_to_materials(db)
        async with SessionLocal() as db:
            await migrate_quotes_to_materials(db)
        async with SessionLocal() as db:
            mats = (await db.execute(select(RefMaterial))).scalars().all()
        texts = sorted(m.text for m in mats)
        assert texts == ["金句A", "金句B"]
        a = next(m for m in mats if m.text == "金句A")
        assert a.platform == "manual" and a.scene_tags == ["opener"] and a.author == "鲁迅"
    asyncio.new_event_loop().run_until_complete(_run())
```

- [ ] **Step 2: 跑测试确认失败**

Run: `source ~/.zshrc && cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_ref_migrate.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'ref_migrate'`

- [ ] **Step 3: 实现迁移（用 AppSetting flag 保证幂等）**

```python
# backend/ref_migrate.py
"""一次性把 quotes 表迁移进 ref_materials（platform 沿用 manual/agent）。
幂等：用 AppSetting 'ref_quotes_migrated' 标志位，跑过就跳过。"""
from datetime import datetime, timezone
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

_FLAG = "ref_quotes_migrated"


async def migrate_quotes_to_materials(db: AsyncSession) -> int:
    from models import Quote, RefMaterial, AppSetting

    flag = await db.get(AppSetting, _FLAG)
    if flag and flag.value == "1":
        return 0

    quotes = (await db.execute(select(Quote))).scalars().all()
    n = 0
    for q in quotes:
        db.add(RefMaterial(
            platform=q.platform or "manual",
            source_id=None,
            text=q.text,
            author=q.author or "",
            source=q.source or "",
            source_url=q.source_url or "",
            category="",
            scene_tags=list(q.scene_tags or []),
            tags=[],
            writing_plan_id=q.writing_plan_id,
            status="active",
            created_at=q.created_at or datetime.now(timezone.utc),
            updated_at=q.updated_at or datetime.now(timezone.utc),
        ))
        n += 1

    if flag:
        flag.value = "1"
    else:
        db.add(AppSetting(key=_FLAG, value="1"))
    await db.commit()
    return n
```

- [ ] **Step 4: 跑测试确认通过**

Run: `source ~/.zshrc && cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_ref_migrate.py -v`
Expected: PASS（1 passed）

- [ ] **Step 5: 在 init_db 末尾调用**

`backend/database.py`：在 `init_db()` 的 `async with engine.begin() as conn:` 块**之后**（函数末尾，连接已提交、表已建）追加：

```python
    # One-off: migrate legacy quotes into unified ref_materials (idempotent)
    try:
        from ref_migrate import migrate_quotes_to_materials
        async with SessionLocal() as db:
            await migrate_quotes_to_materials(db)
    except Exception as e:
        print(f"[init_db] quotes→materials migration skipped: {e}")
```

> 说明：放在 `engine.begin()` 块外、用 `SessionLocal()` 走 ORM，避免和块内 raw DDL 混用事务。生产首启会把现有金句搬过来；`quotes` 物理表保留作备份，不 drop。

- [ ] **Step 6: 跑全后端测试确认无回归**

Run: `source ~/.zshrc && cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/ -q`
Expected: 全绿（含既有 test_x_router / test_writing_plans 等）。

- [ ] **Step 7: 提交**

```bash
cd /workspace/projects/WeMediaStudio && git add backend/ref_migrate.py backend/database.py backend/tests/test_ref_migrate.py
git commit -m "feat(migrate): copy quotes into ref_materials on init (idempotent)"
```

---

### Task 9: MCP `list_quotes`/`save_quote` 重指统一表

**Files:**
- Modify: `backend/mcp_server.py`（`list_quotes` ~708-759，`save_quote` ~762-818）
- Test: `backend/tests/test_mcp_quotes_repoint.py`

- [ ] **Step 1: 写失败测试**

```python
# backend/tests/test_mcp_quotes_repoint.py
import sys, asyncio, pytest


@pytest.fixture
def env(monkeypatch, tmp_path):
    db_file = tmp_path / "t.db"
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{db_file}")
    for mod in list(sys.modules):
        if mod.startswith(("database", "models", "config", "mcp_server")):
            sys.modules.pop(mod, None)
    from database import engine, Base
    import models  # noqa
    async def _setup():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    asyncio.new_event_loop().run_until_complete(_setup())


def test_save_quote_writes_ref_materials(env):
    import mcp_server
    from database import SessionLocal
    from models import RefMaterial
    from sqlalchemy import select

    async def _run():
        out = await mcp_server.save_quote.fn(text="测试金句", author="A",
                                             scene_tags=["opener", "bogus"])
        assert out["id"] > 0
        async with SessionLocal() as db:
            rows = (await db.execute(select(RefMaterial))).scalars().all()
        assert len(rows) == 1
        assert rows[0].platform == "agent" and rows[0].scene_tags == ["opener"]
    asyncio.new_event_loop().run_until_complete(_run())


def test_list_quotes_excludes_x_platform(env):
    import mcp_server
    from database import SessionLocal
    from models import RefMaterial

    async def _run():
        async with SessionLocal() as db:
            db.add(RefMaterial(platform="manual", text="金句", scene_tags=["opener"]))
            db.add(RefMaterial(platform="x", source_id="1", text="段子", scene_tags=["opener"]))
            await db.commit()
        res = await mcp_server.list_quotes.fn()
        texts = {r["text"] for r in res}
        assert texts == {"金句"}  # 段子(platform=x)被排除
    asyncio.new_event_loop().run_until_complete(_run())
```

> 注：FastMCP `@mcp.tool()` 装饰后，原函数体可经 `.fn` 访问。如本仓库版本不支持 `.fn`，改为把核心逻辑抽到模块级 `async def _list_quotes_impl(...)` / `_save_quote_impl(...)`，工具函数只做转发，测试直接测 impl。

- [ ] **Step 2: 跑测试确认失败**

Run: `source ~/.zshrc && cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_mcp_quotes_repoint.py -v`
Expected: FAIL（仍写/读 `Quote`，断言不满足；或 `.fn` 不存在 → 按注释改 impl 抽取后再测）

- [ ] **Step 3: 实现重指**

`list_quotes`（~731-759）：把 `from models import Quote` 改 `from models import RefMaterial`，查询改为排除 `platform='x'`，字段映射不变：

```python
    from models import RefMaterial
    limit = max(1, min(limit, 100))
    async with SessionLocal() as db:
        rows = (await db.execute(
            select(RefMaterial)
            .where(RefMaterial.platform != "x")
            .order_by(desc(RefMaterial.created_at)).limit(500)
        )).scalars().all()
    result = list(rows)
    if search:
        s = search.lower()
        result = [r for r in result if s in r.text.lower() or s in (r.author or "").lower() or s in (r.source or "").lower()]
    if scene_tag:
        result = [r for r in result if scene_tag in (r.scene_tags or [])]
    return [
        {"id": q.id, "text": q.text, "author": q.author or "", "source": q.source or "",
         "source_url": q.source_url or "", "scene_tags": q.scene_tags or [],
         "platform": q.platform, "created_at": _fmt_dt(q.created_at)}
        for q in result[:limit]
    ]
```

`save_quote`（~793-818）：把 `Quote(...)` 换成 `RefMaterial(...)`，保留 `platform="agent"`：

```python
    from models import RefMaterial
    valid_tags = {"opener", "closer", "argument", "twist", "resonance", "warning"}
    tags = [t for t in (scene_tags or []) if t in valid_tags]
    async with SessionLocal() as db:
        obj = RefMaterial(
            text=text.strip(), author=author.strip(), source=source.strip(),
            source_url=source_url.strip(), scene_tags=tags,
            writing_plan_id=writing_plan_id, platform="agent",
        )
        db.add(obj); await db.commit(); await db.refresh(obj)
    return {"id": obj.id, "text": obj.text, "author": obj.author or "",
            "scene_tags": obj.scene_tags or [], "created_at": _fmt_dt(obj.created_at)}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `source ~/.zshrc && cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_mcp_quotes_repoint.py -v`
Expected: PASS（2 passed）

- [ ] **Step 5: 提交**

```bash
cd /workspace/projects/WeMediaStudio && git add backend/mcp_server.py backend/tests/test_mcp_quotes_repoint.py
git commit -m "refactor(mcp): repoint list_quotes/save_quote to ref_materials"
```

---

### Task 10: 退休 quotes router + 前端 quotes 模块

**Files:**
- Modify: `backend/main.py`（移除 quotes import + include）
- Delete: `backend/routers/quotes.py`、`wemedia-studio/app/quotes/`、`wemedia-studio/lib/api/quotes.ts`

- [ ] **Step 1: 从 main.py 移除 quotes**

`backend/main.py` 第 13 行 import 去掉 `quotes,`；删掉 `app.include_router(quotes.router, prefix="/api")`（第 68 行）。

- [ ] **Step 2: 删除后端 quotes router**

```bash
cd /workspace/projects/WeMediaStudio && rm backend/routers/quotes.py
```

- [ ] **Step 3: 跑后端全测试确认无回归**

Run: `source ~/.zshrc && cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/ -q`
Expected: 全绿（金句能力已由 /materials + MCP 接管）。

- [ ] **Step 4: 删除前端 quotes 模块（前端将由 Task 12 的 materials 页接管）**

```bash
cd /workspace/projects/WeMediaStudio && rm -rf wemedia-studio/app/quotes wemedia-studio/lib/api/quotes.ts
```

- [ ] **Step 5: 提交**

```bash
cd /workspace/projects/WeMediaStudio && git add -A backend/main.py backend/routers/ wemedia-studio/app wemedia-studio/lib
git commit -m "refactor: retire quotes router/page (absorbed into materials)"
```

---

## Phase 3 — 前端统一「参考文案库」

> 前端无测试框架；每个任务以「跑 dev server 手工验证」收尾。先读 `wemedia-studio/AGENTS.md`、参考 `app/x/XClient.tsx` 与（被删前的）`QuotesClient.tsx` 设计语言（已删的可从 git 历史 `git show HEAD~1:wemedia-studio/app/quotes/QuotesClient.tsx` 取回参考）。

### Task 11: `lib/api/materials.ts`

**Files:**
- Create: `wemedia-studio/lib/api/materials.ts`

- [ ] **Step 1: 实现 API client**

```typescript
// wemedia-studio/lib/api/materials.ts
import { apiFetch } from './client'

export interface Material {
  id: number
  platform: string
  source_id: string | null
  text: string
  text_clean: string
  author: string
  handle: string
  source: string
  source_url: string
  cover_image: string
  likes: number; reposts: number; replies: number; views: number
  score: number
  category: string
  scene_tags: string[]
  tags: string[]
  writing_plan_id: number | null
  status: string
  published_at: string | null
  created_at: string
}

export interface MaterialCreate {
  text: string; author?: string; source?: string; source_url?: string
  category?: string; scene_tags?: string[]; tags?: string[]; writing_plan_id?: number | null
}

export interface CollectRule {
  id: number; label: string; min_faves: number; min_retweets: number
  lang: string; days: number; exclude_sensitive: boolean
  extra_terms: string; raw_query: string; sort: string; max_results: number
  enabled: boolean; last_collected_at: string | null; last_error: string
}

// 使用场景（与后端 SCENE_TAGS 一致，沿用金句库配色）
export const SCENE_TAGS = [
  { value: 'opener',    label: '开头用', color: 'bg-blue-100 text-blue-600 dark:bg-blue-950/40 dark:text-blue-400' },
  { value: 'closer',    label: '收尾用', color: 'bg-indigo-100 text-indigo-600 dark:bg-indigo-950/40 dark:text-indigo-400' },
  { value: 'argument',  label: '论据',   color: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400' },
  { value: 'twist',     label: '反转',   color: 'bg-orange-100 text-orange-600 dark:bg-orange-950/40 dark:text-orange-400' },
  { value: 'resonance', label: '共鸣',   color: 'bg-pink-100 text-pink-600 dark:bg-pink-950/40 dark:text-pink-400' },
  { value: 'warning',   label: '警示',   color: 'bg-red-100 text-red-600 dark:bg-red-950/40 dark:text-red-400' },
]
export function sceneTagInfo(v: string) {
  return SCENE_TAGS.find(t => t.value === v) ?? { value: v, label: v, color: 'bg-zinc-100 text-zinc-500' }
}

export async function getMaterials(params: Record<string, string | number> = {}): Promise<Material[]> {
  const qs = new URLSearchParams()
  Object.entries(params).forEach(([k, v]) => { if (v !== '' && v !== 0) qs.set(k, String(v)) })
  return apiFetch<Material[]>(`/materials${qs.toString() ? '?' + qs : ''}`)
}
export async function createMaterial(body: MaterialCreate): Promise<Material> {
  return apiFetch<Material>('/materials', { method: 'POST', body: JSON.stringify(body) })
}
export async function updateMaterial(id: number, body: Partial<MaterialCreate> & { status?: string }): Promise<Material> {
  return apiFetch<Material>(`/materials/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
}
export async function deleteMaterial(id: number): Promise<void> {
  await apiFetch(`/materials/${id}`, { method: 'DELETE' })
}
export async function getCategories(): Promise<string[]> {
  return apiFetch<string[]>('/materials/categories')
}
export async function getRules(): Promise<CollectRule[]> {
  return apiFetch<CollectRule[]>('/materials/rules')
}
export async function createRule(body: Partial<CollectRule>): Promise<CollectRule> {
  return apiFetch<CollectRule>('/materials/rules', { method: 'POST', body: JSON.stringify(body) })
}
export async function updateRule(id: number, body: Partial<CollectRule>): Promise<CollectRule> {
  return apiFetch<CollectRule>(`/materials/rules/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
}
export async function deleteRule(id: number): Promise<void> {
  await apiFetch(`/materials/rules/${id}`, { method: 'DELETE' })
}
export async function collectRule(id: number): Promise<{ new_materials: number }> {
  return apiFetch(`/materials/rules/${id}/collect`, { method: 'POST' })
}
export async function collectAll(): Promise<{ new_materials: number; failed: string[] }> {
  return apiFetch('/materials/collect-all', { method: 'POST' })
}
```

- [ ] **Step 2: 类型检查**

Run: `source ~/.zshrc && cd /workspace/projects/WeMediaStudio/wemedia-studio && npx tsc --noEmit`
Expected: 无 materials.ts 相关报错。

- [ ] **Step 3: 提交**

```bash
cd /workspace/projects/WeMediaStudio && git add wemedia-studio/lib/api/materials.ts
git commit -m "feat(ui-api): materials client"
```

---

### Task 12: `/materials` 页面（浏览 + 双维过滤 + 手工录入 + 采集规则）

**Files:**
- Create: `wemedia-studio/app/materials/page.tsx`
- Create: `wemedia-studio/app/materials/MaterialsClient.tsx`

- [ ] **Step 1: page.tsx（server component，仿 quotes/page.tsx）**

```tsx
// wemedia-studio/app/materials/page.tsx
import { getMaterials, getCategories } from '@/lib/api/materials'
import { getWritingPlans } from '@/lib/api/writing-plans'
import { MaterialsClient } from './MaterialsClient'

export const dynamic = 'force-dynamic'

export default async function MaterialsPage() {
  const [materials, categories, plans] = await Promise.all([
    getMaterials(), getCategories(), getWritingPlans(),
  ])
  return <MaterialsClient initialMaterials={materials} categories={categories} initialPlans={plans} />
}
```

- [ ] **Step 2: MaterialsClient.tsx**

实现一个客户端组件，结构参考被删的 `QuotesClient`（`git show HEAD~3:wemedia-studio/app/quotes/QuotesClient.tsx` 可取回；HEAD 偏移按实际提交数调整）。要点（必须包含）：
- 顶部来源切换：全部 / 手工(`platform=manual,agent` → 前端按 `platform!=='x'` 归为手工，过滤参数用 `platform=manual` 与 `agent` 两次或前端筛) / X(`platform=x`)。简化：来源筛 chips = [全部, 手工, X]，「手工」前端过滤 `m.platform !== 'x'`，「X」过滤 `m.platform === 'x'`。
- 左侧两组过滤：**使用场景**（`SCENE_TAGS`，带计数，沿用配色）+ **内容分类**（`categories`，带计数）。
- 工具栏：搜索框 + 排序下拉（时间/段子分/流量）+「添加文案」按钮 +「采集规则」按钮。
- 卡片：`text_clean || text`（可展开原文）；`platform==='x'` 时显示 ❤likes·🔁reposts·👁views + 段子分徽章 + 配图(cover_image) + 「查看原推」(source_url)；显示 scene_tags + category chip；hover 操作：复制 / 编辑(改 category/scene_tags/归档) / 删除。
- 「添加文案」内联表单：text textarea + author/source/source_url + 使用场景多选 + 内容分类下拉 + 写作方案下拉 → `createMaterial`。
- 「采集规则」抽屉：列出 rules（label/min_faves/lang/days/enable 开关/last_error/上次采集）+ 新增表单（label, min_faves, lang, days, raw_query 可选, exclude_sensitive）+ 每条「立即采集」(`collectRule`) +「全部采集」(`collectAll`)，用 `sonner` toast 反馈结果。

完整组件较长，按上述规格实现（复用 shadcn `Button`、`lucide` 图标、`sonner` toast、`cn`）。状态用 `useState`，操作后乐观更新或重新 `getMaterials()`。

> 实现提示：先用 `git show <quotes-commit>:.../QuotesClient.tsx` 取回原金句组件作骨架，再加：来源 chips、内容分类过滤、X 卡片的流量/段子分/配图/原推、采集规则抽屉。SCENE_TAGS 部分几乎可直接复用。

- [ ] **Step 3: 手工验证**

```bash
# 后端（若未跑）
source ~/.zshrc && cd /workspace/projects/WeMediaStudio/backend && conda run -n wems uvicorn main:app --reload --port 8000 &
# 前端
source ~/.zshrc && cd /workspace/projects/WeMediaStudio/wemedia-studio && npm run dev
```
浏览器开 `/materials`，确认：
- 迁移来的金句以「手工」来源出现，使用场景过滤可用、计数正确。
- 「添加文案」能新增并立即出现。
- 「采集规则」能新增一条 `raw_query=min_faves:1500 lang:zh -filter:replies -filter:links -filter:retweets`，点「立即采集」后 X 段子分门别类入库（带流量/段子分/配图/原推链接）。
- 内容分类 + 使用场景 + 来源三组过滤、排序、搜索均工作。

- [ ] **Step 4: 提交**

```bash
cd /workspace/projects/WeMediaStudio && git add wemedia-studio/app/materials
git commit -m "feat(ui): unified 参考文案库 page (browse + manual + collect rules)"
```

---

### Task 13: Sidebar 改名 + 路由

**Files:**
- Modify: `wemedia-studio/components/features/Sidebar.tsx`

- [ ] **Step 1: 改「创作」组里的金句库项**

把第 33 行
```tsx
      { href: '/quotes',       label: '金句库',   icon: Quote },
```
改为
```tsx
      { href: '/materials',    label: '参考文案库', icon: Quote },
```
（icon 保留 `Quote` 或换 `Sparkles`；若换需在顶部 import 增删。）

- [ ] **Step 2: 手工验证**

dev server 下点侧边栏「参考文案库」→ 跳 `/materials`；旧 `/quotes` 已无入口（直接访问 404，符合预期）。

- [ ] **Step 3: 提交**

```bash
cd /workspace/projects/WeMediaStudio && git add wemedia-studio/components/features/Sidebar.tsx
git commit -m "feat(ui): sidebar 金句库 → 参考文案库 (/materials)"
```

---

### Task 14: 全链路验收

- [ ] **Step 1: 后端全测试**

Run: `source ~/.zshrc && cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/ -q`
Expected: 全绿。

- [ ] **Step 2: 真实采集 smoke（需 X 登录态）**

新建一条真实采集规则（前端或 curl `POST /api/materials/rules`），点「立即采集」，确认：库里出现真实段子，`category`/`scene_tags`/`score` 已填，`source_url` 可点开原推；再点一次采集，**不重复**（seen 去重生效），数量稳定。

- [ ] **Step 3: 金句回归（关键）**

确认金句仍在（来源=手工），且 agent 管道仍可用：
Run: `source ~/.zshrc && cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -c "
import asyncio, mcp_server
async def m():
    r = await mcp_server.list_quotes.fn() if hasattr(mcp_server.list_quotes,'fn') else None
    print('list_quotes ok' if r is not None else 'use impl variant')
asyncio.run(m())"`
Expected: 不报错；返回金句（不含 X 段子）。

- [ ] **Step 4: 收尾提交（如有零散改动）**

```bash
cd /workspace/projects/WeMediaStudio && git add -A && git commit -m "chore: reference library end-to-end verification" || echo "nothing to commit"
```

---

## Self-Review（plan 作者已核）

- **Spec 覆盖**：§2 feedgrab(Task 3) / §3 模型(Task 1) / §4 管道(Task 3-5) / §5 API(Task 6) / §6 词表(Task 2,6) / §7 调度(Task 7) / §8 前端(Task 11-13) / §9 合并(Task 8-10) / §11 测试(各 Task TDD)。全覆盖。
- **类型一致**：`RefMaterial`/`RefCollectRule`/`RefSeen` 字段在模型(Task1)→collector(Task5)→router(Task6)→migrate(Task8)→MCP(Task9)→前端类型(Task11)保持一致；`search_top` 签名(Task3)与 collector 调用(Task5)一致；`classify_ref_posts(posts, categories, scene_tags)` 在 Task4 定义、Task5 调用一致。
- **已知取舍**：①迁移放 `init_db`（项目惯例）而非独立脚本（spec §9 措辞）——更贴合代码库；②scene_tag/q 过滤在内存做（限 1000，沿用 quotes 旧法）——v1 可接受；③前端无单测 → 手工验证。
