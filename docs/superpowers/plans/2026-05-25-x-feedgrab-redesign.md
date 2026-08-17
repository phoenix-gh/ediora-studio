# X 模块重构（feedgrab）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除现有 X 模块（twitterapi.io / tl1.com / 分类 / 二创 / metrics 历史），基于 feedgrab 重建最小可用 X 模块：订阅列表每小时自动采集 + 关键词实时搜索。

**Architecture:** 后端 SQLAlchemy 双表（`x_subscriptions` / `x_posts`，外键级联），feedgrab Python import 同步 API 由 `asyncio.to_thread` 包裹。FastAPI 路由 + APScheduler 每小时跑一次全量采集。前端 Next.js `/x` 页两 Tab（订阅 / 搜索），设置页保留极简状态指示。

**Tech Stack:** Python 3.11 (wems conda env) · FastAPI · SQLAlchemy 2.0 (async) · asyncpg · APScheduler · feedgrab · Next.js · Ant Design · pytest (with `DISABLE_SCHEDULER=1`).

**Spec:** `docs/superpowers/specs/2026-05-25-x-feedgrab-redesign-design.md`

**Project conventions:**
- 所有 python / pip 命令前缀：`conda run -n wems`
- 所有 Bash 命令开头：`source ~/.zshrc`
- DB 是 Postgres，schema 通过 `database.init_db()` 自动 `create_all` + 手写 `ALTER TABLE IF NOT EXISTS`（无 Alembic）

**File map:**
- Create: `backend/feedgrab_client.py`（feedgrab 适配 + Markdown 解析）
- Create: `backend/tests/test_feedgrab_client.py`
- Create: `backend/tests/test_x_router.py`
- Create: `docs/superpowers/spikes/feedgrab-python-api.md`（spike 笔记）
- Modify: `backend/models.py`（drop XBloggerCandidate / XPost / XPostMetrics，新建 XSubscription / XPost）
- Modify: `backend/database.py`（init_db 增加 DROP 旧表语句）
- Modify: `backend/routers/x.py`（整体重写，约 150 行）
- Modify: `backend/scheduler.py`（删 3 个旧 job，加 1 个新 job）
- Modify: `backend/config.py`（删 X 字段）
- Modify: `backend/routers/settings.py`（删 X 字段）
- Modify: `backend/main.py`（如有 X import 清理）
- Delete: `backend/x_collector.py`
- Delete: `backend/post_classifier.py`（确认仅 X 使用后）
- Rewrite: `web/app/x/XClient.tsx`
- Rewrite: `web/app/x/XPostsPanel.tsx`（拆成 SubscriptionsTab + SearchTab + PostList 三个组件）
- Modify: `web/app/x/page.tsx`（简化 props）
- Rewrite: `web/app/settings/sections/XSection.tsx`（极简）

---

## Task 1: Spike — 验证 feedgrab Python API

**目标：** 在 wems env 装 feedgrab，确认其 Python 入口、返回结构、auth 取自哪里。结果写到 spike 笔记。

**Files:**
- Create: `docs/superpowers/spikes/feedgrab-python-api.md`

- [ ] **Step 1: 安装 feedgrab 到 wems env**

```bash
source ~/.zshrc
conda run -n wems pip install "feedgrab[all] @ git+https://github.com/iBigQiang/feedgrab.git"
```

预期：安装成功；如果失败记录错误。

- [ ] **Step 2: 探查可导入入口**

```bash
source ~/.zshrc
conda run -n wems python -c "import feedgrab; print(dir(feedgrab))"
conda run -n wems python -c "from feedgrab import UniversalReader; help(UniversalReader)" 2>&1 | head -80
```

记录：所有顶层 symbol、`UniversalReader` 的方法签名（如有）。

- [ ] **Step 3: 探查 X 相关入口**

```bash
source ~/.zshrc
conda run -n wems python -c "
import feedgrab, pkgutil
for m in pkgutil.walk_packages(feedgrab.__path__, prefix='feedgrab.'):
    if 'x' in m.name.lower() or 'twitter' in m.name.lower():
        print(m.name)
"
```

记录：所有与 X/twitter 相关的子模块路径。

- [ ] **Step 4: 试跑一次真实 timeline 调用（无 auth 也先看错误形态）**

```bash
source ~/.zshrc
conda run -n wems python <<'PY'
try:
    from feedgrab import UniversalReader
    r = UniversalReader()
    result = r.read_url("https://x.com/elonmusk")
    print("type:", type(result))
    print("repr:", repr(result)[:500])
except Exception as e:
    import traceback; traceback.print_exc()
PY
```

记录：返回类型、字段、Markdown 结构示例（前 500 字符）。如果报错是缺 cookie，记录提示文案。

- [ ] **Step 5: 写 spike 笔记**

把上述发现整理写入 `docs/superpowers/spikes/feedgrab-python-api.md`，包含：
- Python 入口：能直接 import 的函数/类与签名
- Timeline 返回结构（关键字段 + 一个示例片段）
- Keyword 搜索入口（如有 Python 接口；如果只有 CLI，记录 CLI 用法）
- Auth 配置路径与文件
- **决策：** Python import 可行 / 部分可行（哪些功能）/ 需要 subprocess 兜底

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/spikes/feedgrab-python-api.md
git commit -m "$(cat <<'EOF'
docs: feedgrab Python API spike

Document available imports, return shapes, auth path, and decision
on whether to use direct import vs subprocess for X integration.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: 删除旧 X 后端代码（保留模型，下个任务再换）

**目标：** 把不再使用的代码删掉，但**先保留** `models.py` 的旧表定义（防止 import 链炸）。下一个任务再原子替换模型。

**Files:**
- Delete: `backend/x_collector.py`
- Delete: `backend/post_classifier.py`
- Modify: `backend/routers/x.py` → 改为最小空 router（占位）
- Modify: `backend/scheduler.py` → 删除 X 相关 jobs

- [ ] **Step 1: 确认 post_classifier 仅被 X 引用**

```bash
source ~/.zshrc
grep -rn "post_classifier" backend --include="*.py" | grep -v __pycache__
```

预期：仅 `scheduler.py` 与 `routers/x.py`（旧版）引用。

- [ ] **Step 2: 删除 x_collector.py 与 post_classifier.py**

```bash
rm backend/x_collector.py backend/post_classifier.py
```

- [ ] **Step 3: 把 `backend/routers/x.py` 改为占位空 router**

完全覆盖文件内容：

```python
from fastapi import APIRouter

router = APIRouter(prefix="/x", tags=["x"])

# 旧实现已删除，重建中（见 docs/superpowers/plans/2026-05-25-x-feedgrab-redesign.md）。
```

- [ ] **Step 4: scheduler.py 删除 X 相关函数与 jobs**

在 `backend/scheduler.py` 中：
- 删除 `scheduled_tl1_users`、`scheduled_tl1`、`scheduled_classify_posts`、`scheduled_x` 四个函数定义。
- 在 `register_jobs` 的 jobs 列表中删除这 5 行：
  - `(scheduled_x,                   dict(trigger="interval", minutes=1,           id="x_collect")),`
  - `(scheduled_tl1,                 dict(trigger="interval", seconds=tl1_sec,     id="tl1_collect")),`
  - `(scheduled_tl1_users,           dict(trigger="cron",     hour=0, minute=0,    id="tl1_users_collect")),`
  - `(scheduled_classify_posts,      dict(trigger="interval", minutes=5,           id="x_classify")),`
- 删除 `tl1_sec     = max(10, int(cfg.get("tl1_collect_interval_seconds", 30)))` 这一行。

- [ ] **Step 5: 启动后端确认无 import 报错**

```bash
source ~/.zshrc
conda run -n wems python -c "import sys; sys.path.insert(0, 'backend'); from main import app; print('ok', len(app.routes))"
```

预期：打印 `ok <number>`，不抛异常。

- [ ] **Step 6: 跑现有测试确认未破坏**

```bash
source ~/.zshrc
cd backend && DISABLE_SCHEDULER=1 conda run -n wems pytest -x
```

预期：现有测试全部通过（`test_profile_manager.py`、`test_profiles_router.py`）。

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(x): strip old X backend (twitterapi.io / tl1 / classifier)

Delete x_collector.py, post_classifier.py; reduce routers/x.py to
empty placeholder; remove 4 X-related scheduler jobs. Old DB models
left in place — replaced in next task.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: 替换数据模型 + drop 旧表

**目标：** 在 `models.py` 删旧三表，加 `XSubscription` + `XPost`；在 `init_db()` 加 `DROP TABLE IF EXISTS` 清理旧表（开发库，无需迁移数据）。

**Files:**
- Modify: `backend/models.py`
- Modify: `backend/database.py`

- [ ] **Step 1: 在 `backend/models.py` 删除旧三表**

定位并删除 `class XBloggerCandidate`、`class XPost`、`class XPostMetrics` 三个类定义（约 217~258 行）。

- [ ] **Step 2: 添加新模型**

在原三个类的位置插入：

```python
class XSubscription(Base):
    """User-curated X subscription source. URL points to an X profile or list."""
    __tablename__ = "x_subscriptions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    url: Mapped[str] = mapped_column(String, unique=True, nullable=False, index=True)
    label: Mapped[str] = mapped_column(String, default="")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    last_collected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error: Mapped[str] = mapped_column(String, default="")
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, index=True)


class XPost(Base):
    """Posts collected from subscribed X URLs via feedgrab."""
    __tablename__ = "x_posts"

    tweet_id: Mapped[str] = mapped_column(String, primary_key=True)
    subscription_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    username: Mapped[str] = mapped_column(String, nullable=False, index=True)
    display_name: Mapped[str] = mapped_column(String, default="")
    content: Mapped[str] = mapped_column(Text, default="")
    url: Mapped[str] = mapped_column(String, default="")
    published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    collected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    replies: Mapped[int] = mapped_column(Integer, default=0)
    reposts: Mapped[int] = mapped_column(Integer, default=0)
    likes: Mapped[int] = mapped_column(Integer, default=0)
    views: Mapped[int] = mapped_column(Integer, default=0)
    raw_markdown: Mapped[str] = mapped_column(Text, default="")
```

注意：FK 在应用层处理级联（删订阅时显式 DELETE 关联 posts），不在 Base 加 ForeignKey 关系，以保持与现有 model 风格一致。

- [ ] **Step 3: 在 `backend/database.py` 的 `init_db()` 加 DROP 旧表**

在 `await conn.run_sync(Base.metadata.create_all)` 之前插入（注意顺序：先 DROP，再 create_all 才能建新的同名 `x_posts`）：

```python
        # Drop legacy X tables (replaced by new schema). Dev DB only.
        await conn.execute(text("DROP TABLE IF EXISTS x_post_metrics CASCADE"))
        await conn.execute(text("DROP TABLE IF EXISTS x_blogger_candidates CASCADE"))
        await conn.execute(text("DROP TABLE IF EXISTS x_posts CASCADE"))
```

注意：`text` 已在 init_db 内 import，无需新增。

- [ ] **Step 4: 启动后端，确认表正确建立**

```bash
source ~/.zshrc
conda run -n wems python <<'PY'
import asyncio, sys
sys.path.insert(0, 'backend')
from database import init_db, engine
from sqlalchemy import text
async def main():
    await init_db()
    async with engine.begin() as conn:
        rows = (await conn.execute(text(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_name LIKE 'x_%'"))).all()
        print(rows)
asyncio.run(main())
PY
```

预期：输出包含 `x_subscriptions`、`x_posts`，**不包含** `x_blogger_candidates` / `x_post_metrics`。

- [ ] **Step 5: 跑测试确认未破坏**

```bash
source ~/.zshrc
cd backend && DISABLE_SCHEDULER=1 conda run -n wems pytest -x
```

预期：全部通过。

- [ ] **Step 6: Commit**

```bash
git add backend/models.py backend/database.py
git commit -m "$(cat <<'EOF'
refactor(x): replace X data model with subscription + post

Drop x_blogger_candidates / x_post_metrics / legacy x_posts.
Add x_subscriptions (user-curated source) and new x_posts (FK by
subscription_id, no metrics history).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: feedgrab_client — dataclass + 解析

**目标：** 封装 feedgrab 调用 + 解析为 `ParsedPost`。基于 Task 1 spike 决策选择 Python import 或 subprocess。本任务先写**纯解析逻辑**（与 IO 无关，可单测）。

**Files:**
- Create: `backend/feedgrab_client.py`
- Create: `backend/tests/test_feedgrab_client.py`

- [ ] **Step 1: 写测试 — `ParsedPost` dataclass + 解析单条 Markdown**

`backend/tests/test_feedgrab_client.py`：

```python
from datetime import datetime, timezone
from feedgrab_client import ParsedPost, parse_markdown_post

SAMPLE_MD = """---
tweet_id: "1234567890123456789"
username: elonmusk
display_name: Elon Musk
url: https://x.com/elonmusk/status/1234567890123456789
published_at: 2026-05-20T14:30:00Z
replies: 100
reposts: 500
likes: 3000
views: 200000
---

Mars by 2030 or bust.
Buying more rocket fuel.
"""

def test_parses_post_with_frontmatter():
    post = parse_markdown_post(SAMPLE_MD)
    assert isinstance(post, ParsedPost)
    assert post.tweet_id == "1234567890123456789"
    assert post.username == "elonmusk"
    assert post.display_name == "Elon Musk"
    assert post.url == "https://x.com/elonmusk/status/1234567890123456789"
    assert post.published_at == datetime(2026, 5, 20, 14, 30, tzinfo=timezone.utc)
    assert post.replies == 100
    assert post.reposts == 500
    assert post.likes == 3000
    assert post.views == 200000
    assert "Mars by 2030" in post.content
    assert post.raw_markdown == SAMPLE_MD

def test_parse_returns_none_for_missing_tweet_id():
    bad_md = "---\nusername: foo\n---\nbody"
    assert parse_markdown_post(bad_md) is None
```

注意：spike 阶段若发现 feedgrab 真实输出 frontmatter 字段名不同（例如 `tweet-id` 而非 `tweet_id`），用真实字段名替换上面所有 key 与下方实现。**spike 决定后即更新此处。**

- [ ] **Step 2: 运行测试确认失败**

```bash
source ~/.zshrc
cd backend && DISABLE_SCHEDULER=1 conda run -n wems pytest tests/test_feedgrab_client.py -v
```

预期：ImportError（模块不存在）。

- [ ] **Step 3: 实现 `feedgrab_client.py`（dataclass + 解析）**

```python
"""Adapter between Ediora and feedgrab for X/Twitter content.

Two public coroutines:
  - grab_timeline(url): collect posts from a subscription URL
  - search_x(query):    real-time keyword search (not persisted)

Auth is fully delegated to feedgrab (env vars X_AUTH_TOKEN/X_CT0 or
sessions/twitter.json). This module does not handle cookies.
"""
from __future__ import annotations

import re
import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

import yaml


@dataclass
class ParsedPost:
    tweet_id: str
    username: str
    display_name: str
    content: str
    url: str
    published_at: datetime
    replies: int = 0
    reposts: int = 0
    likes: int = 0
    views: int = 0
    raw_markdown: str = ""


_FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n?(.*)$", re.DOTALL)


def parse_markdown_post(md: str) -> Optional[ParsedPost]:
    """Parse a single feedgrab Markdown document into ParsedPost.

    Returns None if frontmatter is missing or tweet_id is absent.
    """
    m = _FRONTMATTER_RE.match(md.strip() + "\n")
    if not m:
        return None
    try:
        meta = yaml.safe_load(m.group(1)) or {}
    except yaml.YAMLError:
        return None
    body = m.group(2).strip()

    tweet_id = str(meta.get("tweet_id") or "").strip()
    if not tweet_id:
        return None

    pub_raw = meta.get("published_at") or meta.get("date") or ""
    if isinstance(pub_raw, datetime):
        pub_at = pub_raw if pub_raw.tzinfo else pub_raw.replace(tzinfo=timezone.utc)
    else:
        try:
            pub_at = datetime.fromisoformat(str(pub_raw).replace("Z", "+00:00"))
        except Exception:
            pub_at = datetime.now(timezone.utc)

    return ParsedPost(
        tweet_id=tweet_id,
        username=str(meta.get("username") or "").lower().strip(),
        display_name=str(meta.get("display_name") or meta.get("name") or "").strip(),
        content=body,
        url=str(meta.get("url") or "").strip(),
        published_at=pub_at,
        replies=int(meta.get("replies") or 0),
        reposts=int(meta.get("reposts") or meta.get("retweets") or 0),
        likes=int(meta.get("likes") or 0),
        views=int(meta.get("views") or 0),
        raw_markdown=md,
    )


# Public coroutines filled in by Task 5.
async def grab_timeline(url: str) -> list[ParsedPost]:
    raise NotImplementedError("Implemented in Task 5")


async def search_x(query: str, limit: int = 20) -> list[ParsedPost]:
    raise NotImplementedError("Implemented in Task 5")
```

注意：`yaml` 已是项目依赖（profiles 用 ruamel.yaml；PyYAML 通常已装）。若 `import yaml` 报错，先 `conda run -n wems pip install pyyaml` 并把它加进 `backend/requirements.txt`。

- [ ] **Step 4: 运行测试确认通过**

```bash
source ~/.zshrc
cd backend && DISABLE_SCHEDULER=1 conda run -n wems pytest tests/test_feedgrab_client.py -v
```

预期：两个测试 PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/feedgrab_client.py backend/tests/test_feedgrab_client.py
git commit -m "$(cat <<'EOF'
feat(x): feedgrab_client parser + ParsedPost dataclass

Parses feedgrab Markdown with YAML frontmatter into ParsedPost.
grab_timeline / search_x stubs raise NotImplementedError until Task 5.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: feedgrab_client — IO 实现

**目标：** 实现 `grab_timeline` 与 `search_x`，基于 Task 1 spike 决策。

**Files:**
- Modify: `backend/feedgrab_client.py`
- Modify: `backend/tests/test_feedgrab_client.py`

- [ ] **Step 1: 写测试 — mock feedgrab 调用，验证 `grab_timeline` 聚合**

在 `tests/test_feedgrab_client.py` 追加：

```python
import pytest
from unittest.mock import patch, MagicMock

POST_A = """---
tweet_id: "111"
username: foo
display_name: Foo
url: https://x.com/foo/status/111
published_at: 2026-05-20T10:00:00Z
likes: 5
---
hello world
"""
POST_B = POST_A.replace('"111"', '"222"').replace("hello world", "second post")

@pytest.mark.asyncio
async def test_grab_timeline_returns_parsed_posts():
    """grab_timeline 把 feedgrab 返回的多条原文 Markdown 解析为 ParsedPost 列表。"""
    from feedgrab_client import grab_timeline

    with patch("feedgrab_client._fetch_timeline_raw", return_value=[POST_A, POST_B]):
        posts = await grab_timeline("https://x.com/foo")

    assert len(posts) == 2
    assert {p.tweet_id for p in posts} == {"111", "222"}

@pytest.mark.asyncio
async def test_grab_timeline_skips_unparseable():
    from feedgrab_client import grab_timeline

    with patch("feedgrab_client._fetch_timeline_raw", return_value=["garbage", POST_A]):
        posts = await grab_timeline("https://x.com/foo")

    assert len(posts) == 1
    assert posts[0].tweet_id == "111"

@pytest.mark.asyncio
async def test_search_x_returns_parsed_posts():
    from feedgrab_client import search_x

    with patch("feedgrab_client._fetch_search_raw", return_value=[POST_A]):
        posts = await search_x("hello")

    assert len(posts) == 1
    assert posts[0].tweet_id == "111"
```

注意：`pytest-asyncio` 标记。若项目未配置，在 `backend/pytest.ini` 或 `pyproject.toml` 加 `[tool.pytest.ini_options]\nasyncio_mode = "auto"`。先确认：

```bash
source ~/.zshrc
cd backend && conda run -n wems python -c "import pytest_asyncio; print(pytest_asyncio.__version__)"
```

若 import 失败：`conda run -n wems pip install pytest-asyncio` 并在 `backend/pyproject.toml` 加 `[tool.pytest.ini_options]\nasyncio_mode = "auto"`。

- [ ] **Step 2: 运行测试确认失败（NotImplementedError 或 import 错）**

```bash
source ~/.zshrc
cd backend && DISABLE_SCHEDULER=1 conda run -n wems pytest tests/test_feedgrab_client.py -v
```

预期：3 个新测试 FAIL（NotImplementedError）。

- [ ] **Step 3: 实现 `_fetch_timeline_raw` / `_fetch_search_raw` + 公开 API**

在 `backend/feedgrab_client.py` 替换尾部 stub。**根据 spike 决策填入真实 feedgrab API**。下方为 Python import 方案模板；若 spike 决定走 subprocess，把内部实现换成 `await asyncio.create_subprocess_exec(...)`。

```python
def _fetch_timeline_raw(url: str) -> list[str]:
    """Sync call into feedgrab. Returns list of per-post Markdown strings.

    Wrapped by asyncio.to_thread in the public coroutine.

    IMPORTANT: This signature reflects the API discovered in the spike at
    docs/superpowers/spikes/feedgrab-python-api.md. Update accordingly.
    """
    from feedgrab import UniversalReader  # type: ignore
    reader = UniversalReader()
    result = reader.read_url(url)
    # Spike-confirmed: result.posts is list[str] of per-post Markdown.
    # If the real shape differs, adapt here.
    return list(getattr(result, "posts", None) or [])


def _fetch_search_raw(query: str, limit: int = 20) -> list[str]:
    from feedgrab import UniversalReader  # type: ignore
    reader = UniversalReader()
    result = reader.search_x(query, limit=limit)
    return list(getattr(result, "posts", None) or [])


async def grab_timeline(url: str) -> list[ParsedPost]:
    raws = await asyncio.to_thread(_fetch_timeline_raw, url)
    out: list[ParsedPost] = []
    for md in raws:
        post = parse_markdown_post(md)
        if post:
            out.append(post)
    return out


async def search_x(query: str, limit: int = 20) -> list[ParsedPost]:
    raws = await asyncio.to_thread(_fetch_search_raw, query, limit)
    out: list[ParsedPost] = []
    for md in raws:
        post = parse_markdown_post(md)
        if post:
            out.append(post)
    return out


def auth_status() -> dict:
    """Return {ready, hint}. ready=True iff feedgrab has X session credentials.

    Cheap check: env vars OR sessions/twitter.json exists.
    """
    import os
    from pathlib import Path

    if os.getenv("X_AUTH_TOKEN") and os.getenv("X_CT0"):
        return {"ready": True, "hint": "via env vars X_AUTH_TOKEN / X_CT0"}

    candidates = [
        Path.cwd() / "sessions" / "twitter.json",
        Path.home() / ".feedgrab" / "sessions" / "twitter.json",
    ]
    for p in candidates:
        if p.exists():
            return {"ready": True, "hint": f"via {p}"}

    return {
        "ready": False,
        "hint": "未登录。请在 backend 工作目录运行：feedgrab login twitter",
    }
```

- [ ] **Step 4: 运行测试确认通过**

```bash
source ~/.zshrc
cd backend && DISABLE_SCHEDULER=1 conda run -n wems pytest tests/test_feedgrab_client.py -v
```

预期：5 个测试全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/feedgrab_client.py backend/tests/test_feedgrab_client.py
git commit -m "$(cat <<'EOF'
feat(x): feedgrab_client grab_timeline / search_x / auth_status

Wraps feedgrab UniversalReader calls in asyncio.to_thread; surfaces
auth_status from env vars or sessions/twitter.json.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: 路由 — 订阅 CRUD

**目标：** 在 `routers/x.py` 实现订阅增删改查。

**Files:**
- Modify: `backend/routers/x.py`
- Create: `backend/tests/test_x_router.py`

- [ ] **Step 1: 写订阅 CRUD 的测试**

`backend/tests/test_x_router.py`：

```python
import pytest
from fastapi.testclient import TestClient

@pytest.fixture
def client(monkeypatch, tmp_path):
    # Use a per-test sqlite db
    monkeypatch.setenv("DATABASE_URL",
                       f"sqlite+aiosqlite:///{tmp_path}/test.db")
    monkeypatch.setenv("DISABLE_SCHEDULER", "1")
    # Force re-import so engine picks up new URL
    import sys
    for mod in list(sys.modules):
        if mod.startswith(("database", "models", "main", "routers")):
            sys.modules.pop(mod, None)
    from main import app
    from database import init_db
    import asyncio
    asyncio.get_event_loop().run_until_complete(init_db())
    return TestClient(app)


def test_list_empty(client):
    r = client.get("/x/subscriptions")
    assert r.status_code == 200
    assert r.json() == []


def test_create_subscription(client):
    r = client.post("/x/subscriptions", json={"url": "https://x.com/elonmusk"})
    assert r.status_code == 200
    body = r.json()
    assert body["url"] == "https://x.com/elonmusk"
    assert body["label"] == "@elonmusk"
    assert body["enabled"] is True
    assert body["post_count"] == 0


def test_create_duplicate_url_rejected(client):
    client.post("/x/subscriptions", json={"url": "https://x.com/a"})
    r = client.post("/x/subscriptions", json={"url": "https://x.com/a"})
    assert r.status_code == 400


def test_patch_enabled_and_label(client):
    sub = client.post("/x/subscriptions",
                      json={"url": "https://x.com/a"}).json()
    r = client.patch(f"/x/subscriptions/{sub['id']}",
                     json={"enabled": False, "label": "A"})
    assert r.status_code == 200
    assert r.json()["enabled"] is False
    assert r.json()["label"] == "A"


def test_delete_subscription(client):
    sub = client.post("/x/subscriptions",
                      json={"url": "https://x.com/a"}).json()
    r = client.delete(f"/x/subscriptions/{sub['id']}")
    assert r.status_code == 200
    assert client.get("/x/subscriptions").json() == []
```

注意：测试用 sqlite。需要 `aiosqlite`：

```bash
source ~/.zshrc
conda run -n wems python -c "import aiosqlite" 2>&1 | tail -1
```

若缺：`conda run -n wems pip install aiosqlite`。

- [ ] **Step 2: 运行测试确认失败**

```bash
source ~/.zshrc
cd backend && conda run -n wems pytest tests/test_x_router.py -v
```

预期：所有测试 FAIL（404 或 500）。

- [ ] **Step 3: 实现 `routers/x.py` 订阅 CRUD**

完全覆盖 `backend/routers/x.py`：

```python
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func, desc, delete
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import XSubscription, XPost

router = APIRouter(prefix="/x", tags=["x"])


# ─── Schemas ─────────────────────────────────────────────────────────────────

class SubscriptionOut(BaseModel):
    id: int
    url: str
    label: str
    enabled: bool
    last_collected_at: Optional[datetime]
    last_error: str
    added_at: datetime
    post_count: int = 0
    model_config = {"from_attributes": True}


class SubscriptionCreate(BaseModel):
    url: str
    label: Optional[str] = None


class SubscriptionPatch(BaseModel):
    enabled: Optional[bool] = None
    label: Optional[str] = None


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _default_label(url: str) -> str:
    url = url.strip().rstrip("/")
    if "/i/lists/" in url:
        return "list-" + url.rsplit("/", 1)[-1]
    return "@" + url.rsplit("/", 1)[-1]


async def _to_out(db: AsyncSession, sub: XSubscription) -> SubscriptionOut:
    cnt = (await db.execute(
        select(func.count(XPost.tweet_id))
        .where(XPost.subscription_id == sub.id)
    )).scalar() or 0
    return SubscriptionOut(
        id=sub.id, url=sub.url, label=sub.label, enabled=sub.enabled,
        last_collected_at=sub.last_collected_at, last_error=sub.last_error,
        added_at=sub.added_at, post_count=int(cnt),
    )


# ─── Subscriptions CRUD ──────────────────────────────────────────────────────

@router.get("/subscriptions", response_model=list[SubscriptionOut])
async def list_subscriptions(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(
        select(XSubscription).order_by(desc(XSubscription.added_at))
    )).scalars().all()
    return [await _to_out(db, r) for r in rows]


@router.post("/subscriptions", response_model=SubscriptionOut)
async def create_subscription(
    body: SubscriptionCreate, db: AsyncSession = Depends(get_db),
):
    url = body.url.strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "URL 必须以 http(s):// 开头")
    existing = (await db.execute(
        select(XSubscription).where(XSubscription.url == url)
    )).scalars().first()
    if existing:
        raise HTTPException(400, "该 URL 已订阅")
    sub = XSubscription(
        url=url, label=(body.label or _default_label(url)),
        enabled=True, added_at=datetime.now(timezone.utc),
    )
    db.add(sub)
    await db.commit()
    await db.refresh(sub)
    return await _to_out(db, sub)


@router.patch("/subscriptions/{sub_id}", response_model=SubscriptionOut)
async def patch_subscription(
    sub_id: int, body: SubscriptionPatch,
    db: AsyncSession = Depends(get_db),
):
    sub = await db.get(XSubscription, sub_id)
    if not sub:
        raise HTTPException(404, "订阅不存在")
    if body.enabled is not None:
        sub.enabled = body.enabled
    if body.label is not None:
        sub.label = body.label
    await db.commit()
    await db.refresh(sub)
    return await _to_out(db, sub)


@router.delete("/subscriptions/{sub_id}")
async def delete_subscription(
    sub_id: int, db: AsyncSession = Depends(get_db),
):
    sub = await db.get(XSubscription, sub_id)
    if not sub:
        raise HTTPException(404, "订阅不存在")
    await db.execute(delete(XPost).where(XPost.subscription_id == sub_id))
    await db.delete(sub)
    await db.commit()
    return {"ok": True}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
source ~/.zshrc
cd backend && conda run -n wems pytest tests/test_x_router.py -v
```

预期：5 个 CRUD 测试全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/routers/x.py backend/tests/test_x_router.py
git commit -m "$(cat <<'EOF'
feat(x): subscription CRUD endpoints

GET/POST/PATCH/DELETE /x/subscriptions with post_count aggregation
and URL-derived default labels.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: 路由 — 采集 / 搜索 / posts / auth-status

**目标：** 加 collect、search、posts、auth-status 端点。

**Files:**
- Modify: `backend/routers/x.py`
- Modify: `backend/tests/test_x_router.py`

- [ ] **Step 1: 写测试**

在 `tests/test_x_router.py` 追加：

```python
from unittest.mock import patch, AsyncMock
from datetime import datetime, timezone

def _fake_post(tid="111"):
    from feedgrab_client import ParsedPost
    return ParsedPost(
        tweet_id=tid, username="foo", display_name="Foo",
        content="body", url=f"https://x.com/foo/status/{tid}",
        published_at=datetime(2026, 5, 20, 10, 0, tzinfo=timezone.utc),
        likes=5, raw_markdown="raw",
    )


def test_search_returns_results(client):
    with patch("routers.x.search_x", new=AsyncMock(return_value=[_fake_post()])):
        r = client.get("/x/search", params={"q": "hello"})
    assert r.status_code == 200
    body = r.json()
    assert len(body) == 1
    assert body[0]["tweet_id"] == "111"


def test_search_returns_error_when_unauthed(client):
    with patch("routers.x.search_x",
               new=AsyncMock(side_effect=RuntimeError("no auth"))):
        r = client.get("/x/search", params={"q": "hello"})
    assert r.status_code == 502
    assert "no auth" in r.json()["detail"]


def test_collect_one_subscription(client):
    sub = client.post("/x/subscriptions",
                      json={"url": "https://x.com/foo"}).json()
    with patch("routers.x.grab_timeline",
               new=AsyncMock(return_value=[_fake_post("aaa"), _fake_post("bbb")])):
        r = client.post(f"/x/subscriptions/{sub['id']}/collect-sync")
    assert r.status_code == 200
    assert r.json()["new_posts"] == 2

    posts = client.get("/x/posts").json()
    assert len(posts) == 2
    assert posts[0]["subscription_id"] == sub["id"]


def test_auth_status(client):
    r = client.get("/x/auth-status")
    assert r.status_code == 200
    body = r.json()
    assert "ready" in body and "hint" in body
```

注意 `collect-sync` 是测试用同步路径（避免 BackgroundTasks 的异步等待问题），异步版 `collect` 在前端使用。

- [ ] **Step 2: 跑测试确认失败**

```bash
source ~/.zshrc
cd backend && conda run -n wems pytest tests/test_x_router.py -v
```

预期：新增 4 个测试 FAIL。

- [ ] **Step 3: 在 `routers/x.py` 追加 collect / search / posts / auth-status**

在 `routers/x.py` 文件末尾追加：

```python
# ─── Posts ───────────────────────────────────────────────────────────────────

from sqlalchemy.dialects.postgresql import insert as _pg_insert
from sqlalchemy.dialects.sqlite import insert as _sl_insert
from sqlalchemy import inspect as _sa_inspect


def _upsert_post(db: AsyncSession, sub_id: int, p) -> None:
    """Dialect-aware upsert. Postgres in prod, sqlite in tests."""
    dialect = db.bind.dialect.name if db.bind else "postgresql"
    insert_fn = _sl_insert if dialect == "sqlite" else _pg_insert
    stmt = insert_fn(XPost).values(
        tweet_id=p.tweet_id, subscription_id=sub_id,
        username=p.username, display_name=p.display_name,
        content=p.content, url=p.url,
        published_at=p.published_at,
        collected_at=datetime.now(timezone.utc),
        replies=p.replies, reposts=p.reposts,
        likes=p.likes, views=p.views,
        raw_markdown=p.raw_markdown,
    ).on_conflict_do_update(
        index_elements=["tweet_id"],
        set_={
            "replies": p.replies, "reposts": p.reposts,
            "likes": p.likes, "views": p.views,
        },
    )
    return stmt


class PostOut(BaseModel):
    tweet_id: str
    subscription_id: int
    username: str
    display_name: str
    content: str
    url: str
    published_at: datetime
    collected_at: datetime
    replies: int
    reposts: int
    likes: int
    views: int
    model_config = {"from_attributes": True}


@router.get("/posts", response_model=list[PostOut])
async def list_posts(
    subscription_id: Optional[int] = Query(None),
    hours: int = Query(168, ge=1, le=720),
    limit: int = Query(200, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    from datetime import timedelta
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    q = (
        select(XPost)
        .where(XPost.published_at >= since)
        .order_by(desc(XPost.published_at))
        .limit(limit).offset(offset)
    )
    if subscription_id is not None:
        q = q.where(XPost.subscription_id == subscription_id)
    rows = (await db.execute(q)).scalars().all()
    return rows


# ─── Collect ─────────────────────────────────────────────────────────────────

from feedgrab_client import grab_timeline, search_x, auth_status


async def _collect_one(db: AsyncSession, sub: XSubscription) -> int:
    """Returns new+updated post count. Updates sub.last_collected_at / last_error."""
    try:
        posts = await grab_timeline(sub.url)
        for p in posts:
            await db.execute(_upsert_post(db, sub.id, p))
        sub.last_collected_at = datetime.now(timezone.utc)
        sub.last_error = ""
        await db.commit()
        return len(posts)
    except Exception as e:
        sub.last_error = str(e)[:500]
        await db.commit()
        raise


@router.post("/subscriptions/{sub_id}/collect-sync")
async def collect_one_sync(sub_id: int, db: AsyncSession = Depends(get_db)):
    sub = await db.get(XSubscription, sub_id)
    if not sub:
        raise HTTPException(404, "订阅不存在")
    n = await _collect_one(db, sub)
    return {"ok": True, "new_posts": n}


@router.post("/subscriptions/{sub_id}/collect")
async def collect_one(
    sub_id: int, db: AsyncSession = Depends(get_db),
):
    """Same as collect-sync — kept as separate endpoint for future BG variant."""
    return await collect_one_sync(sub_id, db)


@router.post("/collect-all")
async def collect_all(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(
        select(XSubscription).where(XSubscription.enabled == True)
    )).scalars().all()
    new_total = 0
    failed: list[str] = []
    for sub in rows:
        try:
            new_total += await _collect_one(db, sub)
        except Exception as e:
            failed.append(f"{sub.label}: {e}")
    return {"ok": True, "checked": len(rows),
            "new_posts": new_total, "failed": failed}


# ─── Search & auth ───────────────────────────────────────────────────────────

class SearchPostOut(BaseModel):
    tweet_id: str
    username: str
    display_name: str
    content: str
    url: str
    published_at: datetime
    replies: int
    reposts: int
    likes: int
    views: int


@router.get("/search", response_model=list[SearchPostOut])
async def search(q: str = Query(..., min_length=1), limit: int = Query(20, ge=1, le=50)):
    try:
        posts = await search_x(q, limit=limit)
    except Exception as e:
        raise HTTPException(502, str(e))
    return [
        SearchPostOut(
            tweet_id=p.tweet_id, username=p.username, display_name=p.display_name,
            content=p.content, url=p.url, published_at=p.published_at,
            replies=p.replies, reposts=p.reposts, likes=p.likes, views=p.views,
        ) for p in posts
    ]


@router.get("/auth-status")
async def get_auth_status():
    return auth_status()
```

- [ ] **Step 4: 跑测试确认通过**

```bash
source ~/.zshrc
cd backend && conda run -n wems pytest tests/test_x_router.py -v
```

预期：全部 PASS（含原有 5 个 + 新增 4 个 = 9 个）。

- [ ] **Step 5: Commit**

```bash
git add backend/routers/x.py backend/tests/test_x_router.py
git commit -m "$(cat <<'EOF'
feat(x): collect / search / posts / auth-status endpoints

Adds per-subscription collect (sync + async wrapper), collect-all
iteration with per-source error isolation, real-time search proxying
to feedgrab, and an auth status probe.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Scheduler — 每小时全量采集

**目标：** 在 `scheduler.py` 注册一个新 job 调用 `collect_all` 等价逻辑。

**Files:**
- Modify: `backend/scheduler.py`

- [ ] **Step 1: 在 `backend/scheduler.py` 加 `scheduled_x_collect`**

在文件中合适位置（其他 `scheduled_*` 函数附近）加：

```python
async def scheduled_x_collect():
    from logger import log
    from sqlalchemy import select
    from models import XSubscription
    from feedgrab_client import grab_timeline
    from routers.x import _collect_one
    try:
        async with SessionLocal() as db:
            rows = (await db.execute(
                select(XSubscription).where(XSubscription.enabled == True)
            )).scalars().all()
            new_total = 0
            ok = 0
            failed = 0
            for sub in rows:
                try:
                    new_total += await _collect_one(db, sub)
                    ok += 1
                except Exception as e:
                    failed += 1
                    await log("x", "error",
                              f"订阅 {sub.label} 采集失败", str(e))
                await asyncio.sleep(2)  # rate-limit
        await log("x", "ok",
                  f"X 全量采集：{ok} 源成功 / {failed} 源失败，新增 {new_total} 帖")
    except Exception as e:
        await log("x", "error", "X 采集异常", str(e))
```

注意：在 scheduler.py 顶部确保 `import asyncio`（已存在则跳过）。

- [ ] **Step 2: 在 `register_jobs` 加新 job**

在 `register_jobs` 的 jobs 列表末尾加：

```python
        (scheduled_x_collect,           dict(trigger="interval", hours=1,            id="x_collect_hourly")),
```

- [ ] **Step 3: 启动检查**

```bash
source ~/.zshrc
conda run -n wems python -c "
import sys; sys.path.insert(0, 'backend')
from main import app
print('routes ok')
"
```

预期：无报错。

- [ ] **Step 4: 跑全部测试**

```bash
source ~/.zshrc
cd backend && DISABLE_SCHEDULER=1 conda run -n wems pytest -x
```

预期：全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/scheduler.py
git commit -m "$(cat <<'EOF'
feat(x): hourly scheduler job to collect all enabled subscriptions

Iterates enabled XSubscription rows with 2s gap, isolates per-source
failures, logs aggregate summary.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Config + Settings 清理

**目标：** 移除所有旧 X 配置项。

**Files:**
- Modify: `backend/config.py`
- Modify: `backend/routers/settings.py`

- [ ] **Step 1: 删除 `backend/config.py` 中的 X 字段**

在 `DEFAULTS`（或同义 dict）中删除：
- `"x_cookies"`
- `"x_follower_threshold"`
- `"x_search_queries"`
- `"twitterapi_io_key"`
- `"x_post_classify_enabled"`
- `"x_post_classify_prompt"`
- `"x_collect_enabled"`、`"x_collect_interval_minutes"`、`"twitterapi_io_collect_enabled"`
- `"tl1_collect_enabled"`、`"tl1_collect_interval_seconds"`、`"tl1_trending_hours"`

逐一找到对应行删除（用 grep 定位）：

```bash
source ~/.zshrc
grep -n "x_cookies\|x_follower\|x_search_queries\|twitterapi_io\|x_post_classify\|tl1_collect\|tl1_trending\|x_collect" backend/config.py
```

- [ ] **Step 2: 删除 `backend/routers/settings.py` 中的 X 字段**

`grep` 定位所有 X 相关字段（`x_cookies`、`x_follower_threshold`、`x_search_queries`、`twitterapi_io_key*`、`x_post_classify_*`、`x_cookies_set`、`twitterapi_io_key_set`、`tl1_*`）：

```bash
source ~/.zshrc
grep -n "x_cookies\|x_follower\|x_search_queries\|twitterapi_io\|x_post_classify\|tl1_" backend/routers/settings.py
```

在 Pydantic 模型（GET / PATCH 用的 `AppSettings` 与 `SettingsPatch`）与 GET handler 的 dict 构造里，逐一删除这些字段。

- [ ] **Step 3: 启动检查**

```bash
source ~/.zshrc
conda run -n wems python -c "import sys; sys.path.insert(0, 'backend'); from main import app; print('ok')"
```

- [ ] **Step 4: 跑全部测试**

```bash
source ~/.zshrc
cd backend && DISABLE_SCHEDULER=1 conda run -n wems pytest -x
```

- [ ] **Step 5: Commit**

```bash
git add backend/config.py backend/routers/settings.py
git commit -m "$(cat <<'EOF'
chore(x): remove legacy X settings and config defaults

x_cookies / twitterapi_io_key / x_search_queries / tl1_*  /
x_post_classify_* removed. Auth now lives entirely in feedgrab.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: 前端 — 类型 + API client

**目标：** 加 X 相关 TypeScript 类型与 API 客户端函数。

**Files:**
- Modify: `web/lib/api.ts`（或同等位置）

- [ ] **Step 1: 定位现有 api client**

```bash
source ~/.zshrc
grep -rn "fetch\|api/\|export async function" web/lib --include="*.ts" | head
ls web/lib
```

记录现有 api client 文件路径与导出风格。

- [ ] **Step 2: 添加类型与函数**

在 api client 文件（按现有风格）追加：

```typescript
export type XSubscription = {
  id: number
  url: string
  label: string
  enabled: boolean
  last_collected_at: string | null
  last_error: string
  added_at: string
  post_count: number
}

export type XPost = {
  tweet_id: string
  subscription_id: number
  username: string
  display_name: string
  content: string
  url: string
  published_at: string
  collected_at: string
  replies: number
  reposts: number
  likes: number
  views: number
}

export type XSearchPost = Omit<XPost, "subscription_id" | "collected_at">

export type XAuthStatus = { ready: boolean; hint: string }

export const xApi = {
  listSubscriptions: () => fetcher<XSubscription[]>("/x/subscriptions"),
  createSubscription: (url: string, label?: string) =>
    fetcher<XSubscription>("/x/subscriptions", {
      method: "POST",
      body: JSON.stringify({ url, label }),
    }),
  patchSubscription: (id: number, body: Partial<Pick<XSubscription, "enabled" | "label">>) =>
    fetcher<XSubscription>(`/x/subscriptions/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteSubscription: (id: number) =>
    fetcher<{ ok: true }>(`/x/subscriptions/${id}`, { method: "DELETE" }),
  collectOne: (id: number) =>
    fetcher<{ ok: true; new_posts: number }>(
      `/x/subscriptions/${id}/collect`, { method: "POST" }),
  collectAll: () =>
    fetcher<{ ok: true; checked: number; new_posts: number; failed: string[] }>(
      "/x/collect-all", { method: "POST" }),
  listPosts: (params: { subscription_id?: number; hours?: number; limit?: number; offset?: number } = {}) => {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v))
    return fetcher<XPost[]>(`/x/posts?${qs}`)
  },
  search: (q: string, limit = 20) =>
    fetcher<XSearchPost[]>(`/x/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  authStatus: () => fetcher<XAuthStatus>("/x/auth-status"),
}
```

**注意：** `fetcher` 是项目里的现成 helper —— 步骤 1 确认其确切签名 / 名称（可能叫 `apiFetch` / `api` 等），按真实名替换。

- [ ] **Step 3: 启动前端确认 type-check 不报错**

```bash
source ~/.zshrc
cd web && conda run -n wems npm run build 2>&1 | tail -20
```

（如果 build 太慢，可改用 `npx tsc --noEmit` 仅类型检查。）

预期：无 TypeScript 错误。

- [ ] **Step 4: Commit**

```bash
git add web/lib
git commit -m "$(cat <<'EOF'
feat(x): add X API client types and helpers

XSubscription / XPost / XSearchPost / XAuthStatus types plus
xApi.* helpers wrapping the new /x endpoints.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: 前端 — `/x` 页面重写（订阅 Tab）

**目标：** 重写 `XClient.tsx`，实现订阅管理 + 帖子列表。

**Files:**
- Rewrite: `web/app/x/XClient.tsx`
- Modify: `web/app/x/page.tsx`
- Delete: `web/app/x/XPostsPanel.tsx`

- [ ] **Step 1: 简化 `page.tsx`**

```typescript
import { XClient } from './XClient'

export default function XPage() {
  return <XClient />
}
```

- [ ] **Step 2: 删除旧 `XPostsPanel.tsx`**

```bash
rm web/app/x/XPostsPanel.tsx
```

- [ ] **Step 3: 重写 `XClient.tsx` 含订阅 Tab**

完全覆盖 `web/app/x/XClient.tsx`：

```typescript
"use client"
import { useEffect, useState } from "react"
import { Tabs, Card, Input, Button, Switch, Tag, message, Popconfirm, Empty, Select } from "antd"
import { xApi, XSubscription, XPost } from "@/lib/api"

function SubscriptionsTab() {
  const [subs, setSubs] = useState<XSubscription[]>([])
  const [posts, setPosts] = useState<XPost[]>([])
  const [url, setUrl] = useState("")
  const [filterSub, setFilterSub] = useState<number | undefined>(undefined)
  const [hours, setHours] = useState(24)

  const reload = async () => {
    const [s, p] = await Promise.all([
      xApi.listSubscriptions(),
      xApi.listPosts({ subscription_id: filterSub, hours }),
    ])
    setSubs(s); setPosts(p)
  }
  useEffect(() => { reload() }, [filterSub, hours])

  const add = async () => {
    if (!url.trim()) return
    try { await xApi.createSubscription(url.trim()); setUrl(""); reload() }
    catch (e: any) { message.error(e?.message || "添加失败") }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Card title="添加订阅">
        <Input.Search
          value={url} onChange={(e) => setUrl(e.target.value)}
          placeholder="https://x.com/username  或  https://x.com/i/lists/{id}"
          enterButton="添加" onSearch={add}
        />
      </Card>

      <Card title={`订阅列表 (${subs.length})`}
            extra={<Button onClick={async () => {
              const r = await xApi.collectAll()
              message.success(`已采集 ${r.checked} 源，新增 ${r.new_posts} 帖`)
              reload()
            }}>全部采集</Button>}>
        {subs.length === 0 ? <Empty /> : (
          <div style={{ display: "grid", gap: 8 }}>
            {subs.map(s => (
              <div key={s.id} style={{ display: "flex", gap: 12, alignItems: "center",
                                       padding: 8, border: "1px solid #f0f0f0", borderRadius: 4 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500 }}>{s.label}</div>
                  <div style={{ fontSize: 12, color: "#888" }}>{s.url}</div>
                  {s.last_error && <Tag color="red">{s.last_error}</Tag>}
                </div>
                <div style={{ fontSize: 12, color: "#888" }}>
                  {s.post_count} 帖<br/>
                  {s.last_collected_at ? new Date(s.last_collected_at).toLocaleString() : "未采集"}
                </div>
                <Switch checked={s.enabled} onChange={async (v) => {
                  await xApi.patchSubscription(s.id, { enabled: v }); reload()
                }} />
                <Button size="small" onClick={async () => {
                  try { const r = await xApi.collectOne(s.id)
                        message.success(`新增 ${r.new_posts} 帖`); reload() }
                  catch (e: any) { message.error(e?.message || "采集失败") }
                }}>采集</Button>
                <Popconfirm title="确定删除？关联帖子也会被清掉" onConfirm={async () => {
                  await xApi.deleteSubscription(s.id); reload()
                }}>
                  <Button size="small" danger>删除</Button>
                </Popconfirm>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title={`帖子流 (${posts.length})`} extra={
        <div style={{ display: "flex", gap: 8 }}>
          <Select value={filterSub} onChange={setFilterSub} allowClear style={{ width: 160 }}
                  placeholder="全部订阅"
                  options={subs.map(s => ({ value: s.id, label: s.label }))} />
          <Select value={hours} onChange={setHours} style={{ width: 100 }}
                  options={[{value:24,label:"24h"},{value:168,label:"7d"},{value:720,label:"30d"}]} />
        </div>
      }>
        {posts.length === 0 ? <Empty /> : (
          <div style={{ display: "grid", gap: 8 }}>
            {posts.map(p => (
              <div key={p.tweet_id} style={{ padding: 8, border: "1px solid #f0f0f0", borderRadius: 4 }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <div><b>{p.display_name}</b> <span style={{ color: "#888" }}>@{p.username}</span></div>
                  <div style={{ fontSize: 12, color: "#888" }}>{new Date(p.published_at).toLocaleString()}</div>
                </div>
                <div style={{ whiteSpace: "pre-wrap", margin: "4px 0" }}>{p.content}</div>
                <div style={{ fontSize: 12, color: "#888" }}>
                  浏览 {p.views.toLocaleString()} · 转发 {p.reposts} · 点赞 {p.likes} · 回复 {p.replies}
                  <a href={p.url} target="_blank" rel="noreferrer" style={{ marginLeft: 12 }}>查看原推</a>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}

function SearchTab() {
  // Filled in Task 12
  return <Empty description="搜索 Tab 见 Task 12" />
}

export function XClient() {
  return (
    <Tabs items={[
      { key: "subs", label: "订阅", children: <SubscriptionsTab /> },
      { key: "search", label: "实时搜索", children: <SearchTab /> },
    ]}/>
  )
}
```

- [ ] **Step 4: 启动前端，手工浏览 /x 页面**

```bash
source ~/.zshrc
cd web && conda run -n wems npm run dev
```

打开 `http://localhost:3000/x`，验证：
- 订阅 Tab 渲染，无控制台错误
- 添加 URL 后能看到订阅卡片
- 启用开关、删除、采集按钮可点（采集会真实调用 feedgrab，若未登录会报错 — 这是预期）

- [ ] **Step 5: Commit**

```bash
git add web/app/x
git commit -m "$(cat <<'EOF'
feat(x): rewrite /x page with subscriptions tab

Subscription CRUD + post feed with subscription / time-window filters.
Search tab placeholder, implemented in next task.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: 前端 — 关键词搜索 Tab

**目标：** 在 `XClient.tsx` 实现 SearchTab。

**Files:**
- Modify: `web/app/x/XClient.tsx`

- [ ] **Step 1: 替换 `SearchTab` 实现**

```typescript
function SearchTab() {
  const [q, setQ] = useState("")
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<XSearchPost[]>([])
  const [error, setError] = useState<string>("")

  const run = async () => {
    if (!q.trim()) return
    setLoading(true); setError(""); setResults([])
    try {
      setResults(await xApi.search(q.trim()))
    } catch (e: any) {
      setError(e?.message || "搜索失败")
    } finally { setLoading(false) }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Card>
        <div style={{ marginBottom: 8, color: "#888", fontSize: 12 }}>
          实时通过 feedgrab 查询 X，结果不入库、不缓存
        </div>
        <Input.Search value={q} onChange={(e) => setQ(e.target.value)}
                      placeholder="输入关键词，例如：AI agent"
                      enterButton="搜索" loading={loading} onSearch={run} />
      </Card>

      {error && <Card><Tag color="red">{error}</Tag></Card>}

      <Card title={`结果 (${results.length})`}>
        {results.length === 0 ? <Empty /> : (
          <div style={{ display: "grid", gap: 8 }}>
            {results.map(p => (
              <div key={p.tweet_id} style={{ padding: 8, border: "1px solid #f0f0f0", borderRadius: 4 }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <div><b>{p.display_name}</b> <span style={{ color: "#888" }}>@{p.username}</span></div>
                  <div style={{ fontSize: 12, color: "#888" }}>{new Date(p.published_at).toLocaleString()}</div>
                </div>
                <div style={{ whiteSpace: "pre-wrap", margin: "4px 0" }}>{p.content}</div>
                <div style={{ fontSize: 12, color: "#888" }}>
                  浏览 {p.views.toLocaleString()} · 转发 {p.reposts} · 点赞 {p.likes}
                  <a href={p.url} target="_blank" rel="noreferrer" style={{ marginLeft: 12 }}>原推</a>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
```

记得 import `XSearchPost`：在文件顶部 `import { xApi, XSubscription, XPost, XSearchPost } from "@/lib/api"`。

- [ ] **Step 2: 手工浏览**

刷新 `http://localhost:3000/x`，切到「实时搜索」Tab，验证搜索框可用。

- [ ] **Step 3: Commit**

```bash
git add web/app/x/XClient.tsx
git commit -m "$(cat <<'EOF'
feat(x): keyword search tab with live feedgrab queries

Real-time results, no persistence; shows clear "不入库不缓存" hint.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: 前端 — 设置页 X 区块极简化

**目标：** `XSection.tsx` 改成只显示 feedgrab auth 状态 + 登录命令提示。

**Files:**
- Rewrite: `web/app/settings/sections/XSection.tsx`

- [ ] **Step 1: 完全覆盖 `XSection.tsx`**

```typescript
"use client"
import { useEffect, useState } from "react"
import { Card, Tag, Typography } from "antd"
import { xApi, XAuthStatus } from "@/lib/api"

export function XSection() {
  const [status, setStatus] = useState<XAuthStatus | null>(null)
  useEffect(() => { xApi.authStatus().then(setStatus) }, [])
  return (
    <Card title="X / Twitter (feedgrab)">
      <div style={{ marginBottom: 8 }}>
        状态：{status === null ? "..." :
                status.ready ? <Tag color="green">已就绪</Tag> : <Tag color="red">未登录</Tag>}
        <span style={{ marginLeft: 12, color: "#888" }}>{status?.hint}</span>
      </div>
      <Typography.Paragraph type="secondary">
        本项目通过 feedgrab 采集 X 内容，认证完全交由 feedgrab 管理。
        登录方式（任选其一）：
      </Typography.Paragraph>
      <pre style={{ background: "#f5f5f5", padding: 8 }}>
{`# 方法 1：交互式浏览器登录（推荐）
feedgrab login twitter

# 方法 2：环境变量（在 backend 启动前 export）
export X_AUTH_TOKEN=...
export X_CT0=...`}
      </pre>
    </Card>
  )
}
```

- [ ] **Step 2: 更新 `SettingsClient.tsx` 中 XSection 的 props**

定位调用点（旧 props 是 `settings={...} onSaved={...}`）：

```bash
source ~/.zshrc
grep -n "XSection" web/app/settings/SettingsClient.tsx
```

改成 `<XSection />`（移除 props）。

- [ ] **Step 3: build / dev 确认无 TS 报错**

```bash
source ~/.zshrc
cd web && conda run -n wems npx tsc --noEmit
```

预期：无 `XSection`、`xApi`、未用变量相关报错。

- [ ] **Step 4: Commit**

```bash
git add web/app/settings/sections/XSection.tsx web/app/settings/SettingsClient.tsx
git commit -m "$(cat <<'EOF'
feat(x): simplify settings X section to auth-status indicator

Removes cookie / API key / classify / tl1 form fields. Now shows
feedgrab session status and login command hints.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: 端到端手工验证

**目标：** 全链路真实跑一遍。

- [ ] **Step 1: 启动后端**

```bash
source ~/.zshrc
cd backend && conda run -n wems uvicorn main:app --reload --port 8000
```

观察 startup log：无 `x_cookies` / `tl1` / `classifier` 相关警告。`x_collect_hourly` job 出现在调度器输出（如有）。

- [ ] **Step 2: feedgrab 登录**

```bash
source ~/.zshrc
cd backend && conda run -n wems feedgrab login twitter
```

完成浏览器登录。

- [ ] **Step 3: 启动前端**

```bash
source ~/.zshrc
cd web && conda run -n wems npm run dev
```

- [ ] **Step 4: 设置页验证 auth-status**

`http://localhost:3000/settings`，定位 X 区块，确认显示 `已就绪`（绿 tag）+ session 路径。

- [ ] **Step 5: 添加订阅 + 采集**

`http://localhost:3000/x`，「订阅」Tab：
- 添加 `https://x.com/sama`
- 点「采集」按钮 → message 提示新增帖数 > 0
- 帖子流出现新内容

- [ ] **Step 6: 关键词搜索**

切到「实时搜索」Tab，输入 `OpenAI`，点搜索 → 返回多条结果，**不入库**（刷新页面后 `/x/posts` 不增加）。

- [ ] **Step 7: 启用开关 + 删除级联**

- 关闭订阅 → 等下次 cron 不会采集（可不验证，直接看代码逻辑）
- 删除订阅 → 关联帖子从帖子流消失

- [ ] **Step 8: 后端日志确认调度生效**

让后端运行 1 小时，或临时在 `register_jobs` 改成 `minutes=1` 测试一次后改回。观察 `logger` 输出有 `X 全量采集：...` 行。

- [ ] **Step 9: 记录任何 bug 并修复**

如有：开新分支 commit 或在本 plan 任务序列追加临时任务。

- [ ] **Step 10: 最终 commit（如有）**

```bash
git status
# 如果一切干净，本任务无 commit
```

---

## 完成标准

- 所有 backend 测试通过：`pytest -x` 在 `backend/` 下绿。
- `npx tsc --noEmit` 在 `web/` 下无错。
- Task 14 手工验证全部勾选。
- `git log refactor/project-optimization` 看到本计划全部 14 个 commit。
- 旧的 X 文件已物理删除，可通过 `git status` 确认无残留。
