# Release Draft Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the GitHub scheduler detects that the latest release of a tracked repo has no draft yet, automatically call an LLM to generate tech-facing and/or product-facing `ArticleDraft` records with fine-grained `[TODO: ...]` annotations embedded per change point.

**Architecture:** A new `release_drafter.py` module (mirroring `github_analyzer.py`) handles all generation logic. The scheduler calls `generate_pending_drafts()` after `collect_all_repos()`. Three new DB columns track opt-in configuration and idempotency. Frontend shows a draft-ready badge on release cards and draft-type toggles in the repo management dialog.

**Tech Stack:** Python/SQLAlchemy (async), FastAPI, OpenAI-compatible LLM via existing `llm._call()`, pytest + SQLite for tests, React/TypeScript/shadcn for UI.

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Modify | `backend/models.py` | Add 3 columns: `GithubRelease.draft_generated_at`, `GithubRepo.release_draft_enabled`, `GithubRepo.release_draft_types` |
| Modify | `backend/schemas.py` | Expose new columns in `GithubReleaseOut`, `GithubRepoOut`, `GithubRepoUpdate` |
| Modify | `backend/llm.py` | Add `generate_release_article()` |
| Create | `backend/release_drafter.py` | `generate_release_drafts()` + `generate_pending_drafts()` |
| Create | `backend/tests/test_release_drafter.py` | Unit tests for drafter logic |
| Modify | `backend/scheduler.py` | Call `generate_pending_drafts()` after collect |
| Modify | `backend/routers/github.py` | PATCH handler uses new `GithubRepoUpdate` fields |
| Modify | `web/lib/types.ts` | Add new fields to `GithubRelease` and `GithubRepo` interfaces |
| Modify | `web/lib/api/github.ts` | Extend `updateGithubRepo` body type |
| Modify | `web/app/github/GithubClient.tsx` | Draft badge on release cards + draft settings in repo dialog |

---

## Task 1: DB Migration

**Files:**
- (No file — run SQL directly against the Postgres DB)

Run these three `ALTER TABLE` statements. The project has no migration framework — schema changes must be applied manually.

- [ ] **Step 1: Connect to the database and run the migrations**

```bash
conda run -n wems python -c "
import asyncio, os
from sqlalchemy.ext.asyncio import create_async_engine

url = os.getenv('DATABASE_URL', 'postgresql+asyncpg://localhost/ediora')

async def migrate():
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.execute(__import__('sqlalchemy').text(
            'ALTER TABLE github_releases ADD COLUMN IF NOT EXISTS draft_generated_at TIMESTAMPTZ'
        ))
        await conn.execute(__import__('sqlalchemy').text(
            'ALTER TABLE github_repos ADD COLUMN IF NOT EXISTS release_draft_enabled BOOLEAN NOT NULL DEFAULT TRUE'
        ))
        await conn.execute(__import__('sqlalchemy').text(
            \"ALTER TABLE github_repos ADD COLUMN IF NOT EXISTS release_draft_types JSONB NOT NULL DEFAULT '[\\\"tech\\\",\\\"product\\\"]'\"
        ))
        print('Migration complete')
    await engine.dispose()

asyncio.run(migrate())
"
```

Expected output: `Migration complete`

- [ ] **Step 2: Commit**

```bash
git commit --allow-empty -m "chore: db migration — release draft columns"
```

---

## Task 2: Python Model Changes

**Files:**
- Modify: `backend/models.py` (lines 192–205 for `GithubRelease`, lines 127–140 for `GithubRepo`)

- [ ] **Step 1: Add `draft_generated_at` to `GithubRelease`**

In `backend/models.py`, find the `GithubRelease` class (around line 192). After the `collected_at` field, add:

```python
    draft_generated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, default=None)
```

The class should now end with:
```python
    published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    collected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    draft_generated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, default=None)
```

- [ ] **Step 2: Add draft config fields to `GithubRepo`**

In the `GithubRepo` class (around line 127), after the `created_at` field, add:

```python
    release_draft_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    release_draft_types: Mapped[list] = mapped_column(JSON, default=lambda: ["tech", "product"])
```

- [ ] **Step 3: Commit**

```bash
git add backend/models.py
git commit -m "feat(models): add release draft columns to GithubRelease and GithubRepo"
```

---

## Task 3: Schema Changes

**Files:**
- Modify: `backend/schemas.py` (lines 479–542)

- [ ] **Step 1: Update `GithubRepoUpdate`** (around line 479)

Replace:
```python
class GithubRepoUpdate(BaseModel):
    group: Optional[str] = None
    muted: Optional[bool] = None
    collect_interval_minutes: Optional[int] = None
```

With:
```python
class GithubRepoUpdate(BaseModel):
    group: Optional[str] = None
    muted: Optional[bool] = None
    collect_interval_minutes: Optional[int] = None
    release_draft_enabled: Optional[bool] = None
    release_draft_types: Optional[list[str]] = None
```

- [ ] **Step 2: Update `GithubRepoOut`** (around line 485)

Replace:
```python
class GithubRepoOut(BaseModel):
    id: str
    owner: str
    repo: str
    description: str
    stars: int
    language: str
    group: str
    muted: bool
    collect_interval_minutes: int
    last_collected_at: Optional[datetime] = None

    model_config = {"from_attributes": True}
```

With:
```python
class GithubRepoOut(BaseModel):
    id: str
    owner: str
    repo: str
    description: str
    stars: int
    language: str
    group: str
    muted: bool
    collect_interval_minutes: int
    last_collected_at: Optional[datetime] = None
    release_draft_enabled: bool = True
    release_draft_types: list = []

    model_config = {"from_attributes": True}
```

- [ ] **Step 3: Update `GithubReleaseOut`** (around line 531)

Replace:
```python
class GithubReleaseOut(BaseModel):
    id: str
    repo_id: str
    tag_name: str
    name: str
    body: str
    is_prerelease: bool
    is_draft: bool
    html_url: str
    published_at: datetime

    model_config = {"from_attributes": True}
```

With:
```python
class GithubReleaseOut(BaseModel):
    id: str
    repo_id: str
    tag_name: str
    name: str
    body: str
    is_prerelease: bool
    is_draft: bool
    html_url: str
    published_at: datetime
    draft_generated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}
```

- [ ] **Step 4: Update PATCH router to handle new fields**

In `backend/routers/github.py`, find `update_repo` (around the PATCH handler). Add handling for the two new fields after the existing `if body.collect_interval_minutes is not None:` block:

```python
    if body.release_draft_enabled is not None:
        repo.release_draft_enabled = body.release_draft_enabled
    if body.release_draft_types is not None and len(body.release_draft_types) > 0:
        repo.release_draft_types = [t for t in body.release_draft_types if t in ("tech", "product")]
```

- [ ] **Step 5: Commit**

```bash
git add backend/schemas.py backend/routers/github.py
git commit -m "feat(schemas): expose release draft fields in Github schemas and PATCH handler"
```

---

## Task 4: LLM Function

**Files:**
- Modify: `backend/llm.py` (append after `analyze_github_pain_points`, around line 207)

- [ ] **Step 1: Add `_extract_json_object` helper**

In `backend/llm.py`, after `_extract_json_array` (around line 137), add:

```python
def _extract_json_object(text: str) -> dict:
    start = text.find("{")
    end = text.rfind("}") + 1
    if start >= 0 and end > start:
        return json.loads(text[start:end])
    return {}
```

- [ ] **Step 2: Add `generate_release_article` function**

After the `analyze_github_pain_points` function (around line 207), add:

```python
async def generate_release_article(
    repo: str,
    tag: str,
    release_name: str,
    html_url: str,
    body: str,
    draft_types: list[str],
) -> dict:
    """Generate tech and/or product-facing release article drafts with fine-grained TODO annotations."""
    types_str = "、".join(
        "技术向(tech)" if t == "tech" else "产品运营向(product)" for t in draft_types
    )

    if not body.strip():
        empty_body_note = f"该 Release 没有 changelog 正文，请访问 {html_url} 查看详情。"
        sections_stub = json.dumps([{
            "heading": "## 发布说明",
            "content": f"{repo} 发布了 {tag}，暂无 changelog 正文。",
            "todos": [f"[TODO: 访问 {html_url} 查看完整 changelog，补充实际变更内容]"]
        }], ensure_ascii=False)
        result: dict = {}
        for t in draft_types:
            label = "技术解读" if t == "tech" else "更新亮点"
            prefix = "[pre] " if "rc" in tag.lower() or "alpha" in tag.lower() or "beta" in tag.lower() else ""
            result[t] = {
                "title": f"{prefix}[{t}] {repo} {tag} {label}",
                "sections": json.loads(sections_stub),
            }
        return result

    prerelease_hint = ""
    if any(kw in tag.lower() for kw in ("rc", "alpha", "beta", "pre")):
        prerelease_hint = "注意：这是一个预发布版本（pre-release），请在文章标题加 [pre] 前缀，并在开头加一段提示说明这是预发布版本，可能不稳定。"

    prompt = f"""你是中文科技自媒体内容专家。现在需要为 GitHub 项目 {repo} 的 {tag} 版本（发布名称：{release_name}）撰写发布解读文章。

GitHub Release 页面：{html_url}
Changelog 原文（Markdown）：
---
{body[:4000]}
---

{prerelease_hint}

请生成以下类型的文章草稿：{types_str}

输出 JSON 对象，每个请求的类型作为顶层 key（"tech" 和/或 "product"），值为：
{{
  "title": "文章标题",
  "sections": [
    {{
      "heading": "## 章节标题",
      "content": "章节正文（中文，200-400字）",
      "todos": ["[TODO: 具体描述需要补充的素材，如截图/录屏/对比图]"]
    }}
  ]
}}

关键要求：
1. tech 版本：面向开发者，保留技术细节、API 变更、性能数字、breaking changes
2. product 版本：面向普通用户/运营，把技术变更翻译成"用户能感知的变化"，功能亮点优先
3. [TODO: ...] 必须针对每个具体变更点推断所需素材，例如：
   - "[TODO: 截图 - 新版 UI 界面，对比旧版布局变化]"
   - "[TODO: 录制 GIF - xxx 功能的完整操作演示，展示从触发到结果的全流程]"
   - "[TODO: 截图 - 性能对比数据表格或基准测试结果图]"
   不要写泛化的 "[TODO: 补充截图]"
4. 章节数量：3-6 个，每节对应 changelog 中一个独立功能/修复
5. 只输出 JSON 对象，不要任何 markdown 代码块或其他文字"""

    try:
        raw = await _call(prompt, max_tokens=4000)
        return _extract_json_object(raw)
    except Exception as e:
        print(f"[llm] generate_release_article error: {e}")
        return {}
```

- [ ] **Step 3: Commit**

```bash
git add backend/llm.py
git commit -m "feat(llm): add generate_release_article for release draft generation"
```

---

## Task 5: `release_drafter.py` Module

**Files:**
- Create: `backend/release_drafter.py`

- [ ] **Step 1: Create the file**

```python
"""Generate ArticleDraft records from new GitHub releases."""
import json
from datetime import datetime, timezone, timedelta
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc

from models import GithubRepo, GithubRelease, ArticleDraft

_SKIP_OLDER_THAN_DAYS = 30


async def generate_release_drafts(release: GithubRelease, repo: GithubRepo, db: AsyncSession) -> int:
    """Generate tech/product ArticleDraft records for a single release. Returns count created."""
    import llm

    draft_types: list[str] = repo.release_draft_types or ["tech", "product"]
    if not draft_types:
        release.draft_generated_at = datetime.now(timezone.utc)
        await db.commit()
        return 0

    result = await llm.generate_release_article(
        repo=repo.id,
        tag=release.tag_name,
        release_name=release.name or release.tag_name,
        html_url=release.html_url,
        body=release.body or "",
        draft_types=draft_types,
    )

    count = 0
    for dtype in draft_types:
        data = result.get(dtype)
        if not data:
            continue

        topic_id = f"release:{repo.id}:{release.tag_name}"
        title = data.get("title") or f"[{dtype}] {repo.id} {release.tag_name}"

        # Belt-and-suspenders: skip if draft for this release+type already exists
        existing = (await db.execute(
            select(ArticleDraft).where(
                ArticleDraft.topic_id == topic_id,
                ArticleDraft.title == title,
            )
        )).scalar_one_or_none()
        if existing:
            continue

        sections = data.get("sections") or []
        content_parts = []
        for sec in sections:
            content_parts.append(sec.get("heading", ""))
            content_parts.append(sec.get("content", ""))
            for todo in sec.get("todos") or []:
                content_parts.append(f"\n{todo}")
            content_parts.append("")

        content = "\n\n".join(p for p in content_parts if p is not None)

        db.add(ArticleDraft(
            topic_id=topic_id,
            title=title,
            content=content,
            status="drafting",
            draft_type="article",
            sources=[{"url": release.html_url, "title": release.tag_name, "note": ""}],
        ))
        count += 1

    release.draft_generated_at = datetime.now(timezone.utc)
    await db.commit()
    return count


async def generate_pending_drafts(db: AsyncSession) -> int:
    """For each enabled repo, check its latest release and generate drafts if not yet done."""
    repos = (
        await db.execute(
            select(GithubRepo).where(
                GithubRepo.release_draft_enabled == True,  # noqa: E712
                GithubRepo.muted == False,  # noqa: E712
            )
        )
    ).scalars().all()

    cutoff = datetime.now(timezone.utc) - timedelta(days=_SKIP_OLDER_THAN_DAYS)
    total = 0

    for repo in repos:
        latest = (
            await db.execute(
                select(GithubRelease)
                .where(GithubRelease.repo_id == repo.id)
                .order_by(desc(GithubRelease.published_at))
                .limit(1)
            )
        ).scalar_one_or_none()

        if not latest:
            continue
        if latest.draft_generated_at is not None:
            continue

        pub = latest.published_at
        if pub.tzinfo is None:
            pub = pub.replace(tzinfo=timezone.utc)

        if pub < cutoff:
            # Too old — mark as skipped without generating
            latest.draft_generated_at = datetime.now(timezone.utc)
            await db.commit()
            continue

        try:
            n = await generate_release_drafts(latest, repo, db)
            total += n
        except Exception as e:
            print(f"[release_drafter] failed for {repo.id}: {e}")

    return total
```

- [ ] **Step 2: Commit**

```bash
git add backend/release_drafter.py
git commit -m "feat: add release_drafter module — generate ArticleDraft from new releases"
```

---

## Task 6: Tests

**Files:**
- Create: `backend/tests/test_release_drafter.py`

- [ ] **Step 1: Write the tests**

```python
import sys
import asyncio
import json
from datetime import datetime, timezone, timedelta
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch, tmp_path):
    db_file = tmp_path / "test.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite+aiosqlite:///{db_file}")
    monkeypatch.setenv("DISABLE_SCHEDULER", "1")

    for mod in list(sys.modules):
        if mod.startswith(("database", "models", "main", "routers", "config",
                            "llm", "release_drafter", "schemas")):
            sys.modules.pop(mod, None)

    from database import engine, Base
    import models  # noqa: F401

    async def _create():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    asyncio.new_event_loop().run_until_complete(_create())

    from main import app
    return TestClient(app)


def _make_llm_response(types: list[str]) -> dict:
    result = {}
    for t in types:
        result[t] = {
            "title": f"[{t}] testrepo v1.0.0 发布",
            "sections": [
                {
                    "heading": "## 新特性",
                    "content": "新增了 xxx 功能。",
                    "todos": ["[TODO: 截图 - 新功能界面展示]"],
                }
            ],
        }
    return result


def test_generate_release_drafts_creates_two_drafts(client, monkeypatch, tmp_path):
    """generate_release_drafts creates one draft per type in release_draft_types."""
    import asyncio
    from database import SessionLocal
    import models

    async def _setup():
        async with SessionLocal() as db:
            repo = models.GithubRepo(
                id="owner/testrepo",
                owner="owner",
                repo="testrepo",
                release_draft_enabled=True,
                release_draft_types=["tech", "product"],
            )
            db.add(repo)
            release = models.GithubRelease(
                id="owner/testrepo:v1.0.0",
                repo_id="owner/testrepo",
                tag_name="v1.0.0",
                name="Version 1.0.0",
                body="- Added feature X\n- Fixed bug Y",
                html_url="https://github.com/owner/testrepo/releases/tag/v1.0.0",
                published_at=datetime.now(timezone.utc),
            )
            db.add(release)
            await db.commit()
            return repo.id, release.id

    async def _run(repo_id, release_id):
        import llm as llm_mod
        monkeypatch.setattr(
            llm_mod, "generate_release_article",
            lambda **kw: asyncio.coroutine(lambda: _make_llm_response(["tech", "product"]))()
        )
        from release_drafter import generate_release_drafts
        async with SessionLocal() as db:
            repo = await db.get(models.GithubRepo, repo_id)
            release = await db.get(models.GithubRelease, release_id)
            n = await generate_release_drafts(release, repo, db)
        return n

    loop = asyncio.new_event_loop()
    repo_id, release_id = loop.run_until_complete(_setup())

    async def _patch_and_run():
        import llm as llm_mod

        async def fake_generate(**kw):
            return _make_llm_response(["tech", "product"])

        monkeypatch.setattr(llm_mod, "generate_release_article", fake_generate)
        from release_drafter import generate_release_drafts
        async with SessionLocal() as db:
            repo = await db.get(models.GithubRepo, repo_id)
            release = await db.get(models.GithubRelease, release_id)
            return await generate_release_drafts(release, repo, db)

    n = loop.run_until_complete(_patch_and_run())
    assert n == 2


def test_generate_pending_drafts_skips_old_releases(client, monkeypatch):
    """Releases older than 30 days are skipped (draft_generated_at set, no ArticleDraft created)."""
    import asyncio
    from database import SessionLocal
    import models
    from sqlalchemy import select

    async def _setup():
        async with SessionLocal() as db:
            repo = models.GithubRepo(
                id="owner/oldrepo",
                owner="owner",
                repo="oldrepo",
                release_draft_enabled=True,
                release_draft_types=["tech"],
            )
            db.add(repo)
            old_date = datetime.now(timezone.utc) - timedelta(days=60)
            release = models.GithubRelease(
                id="owner/oldrepo:v0.1.0",
                repo_id="owner/oldrepo",
                tag_name="v0.1.0",
                name="Old version",
                body="Some old changelog",
                html_url="https://github.com/owner/oldrepo/releases/tag/v0.1.0",
                published_at=old_date,
            )
            db.add(release)
            await db.commit()

    async def _run():
        import llm as llm_mod

        async def fake_generate(**kw):
            raise AssertionError("Should not call LLM for old releases")

        monkeypatch.setattr(llm_mod, "generate_release_article", fake_generate)
        from release_drafter import generate_pending_drafts
        async with SessionLocal() as db:
            n = await generate_pending_drafts(db)

        async with SessionLocal() as db:
            release = await db.get(models.GithubRelease, "owner/oldrepo:v0.1.0")
            drafts = (await db.execute(select(models.ArticleDraft))).scalars().all()
        return n, release.draft_generated_at, len(drafts)

    loop = asyncio.new_event_loop()
    loop.run_until_complete(_setup())
    n, generated_at, draft_count = loop.run_until_complete(_run())

    assert n == 0
    assert generated_at is not None  # marked as skipped
    assert draft_count == 0


def test_generate_pending_drafts_skips_disabled_repos(client, monkeypatch):
    """Repos with release_draft_enabled=False are not processed."""
    import asyncio
    from database import SessionLocal
    import models
    from sqlalchemy import select

    async def _setup():
        async with SessionLocal() as db:
            repo = models.GithubRepo(
                id="owner/disabledrepo",
                owner="owner",
                repo="disabledrepo",
                release_draft_enabled=False,
                release_draft_types=["tech"],
            )
            db.add(repo)
            release = models.GithubRelease(
                id="owner/disabledrepo:v1.0.0",
                repo_id="owner/disabledrepo",
                tag_name="v1.0.0",
                name="v1.0.0",
                body="changelog",
                html_url="https://github.com/owner/disabledrepo/releases/tag/v1.0.0",
                published_at=datetime.now(timezone.utc),
            )
            db.add(release)
            await db.commit()

    async def _run():
        import llm as llm_mod

        async def fake_generate(**kw):
            raise AssertionError("Should not call LLM for disabled repos")

        monkeypatch.setattr(llm_mod, "generate_release_article", fake_generate)
        from release_drafter import generate_pending_drafts
        async with SessionLocal() as db:
            return await generate_pending_drafts(db)

    loop = asyncio.new_event_loop()
    loop.run_until_complete(_setup())
    n = loop.run_until_complete(_run())
    assert n == 0


def test_generate_release_drafts_idempotent(client, monkeypatch):
    """Calling generate_release_drafts twice does not create duplicate drafts."""
    import asyncio
    from database import SessionLocal
    import models
    from sqlalchemy import select

    async def _setup():
        async with SessionLocal() as db:
            repo = models.GithubRepo(
                id="owner/idrepo",
                owner="owner",
                repo="idrepo",
                release_draft_enabled=True,
                release_draft_types=["tech"],
            )
            db.add(repo)
            release = models.GithubRelease(
                id="owner/idrepo:v2.0.0",
                repo_id="owner/idrepo",
                tag_name="v2.0.0",
                name="v2.0.0",
                body="- New thing",
                html_url="https://github.com/owner/idrepo/releases/tag/v2.0.0",
                published_at=datetime.now(timezone.utc),
            )
            db.add(release)
            await db.commit()

    async def _run_twice():
        import llm as llm_mod

        async def fake_generate(**kw):
            return _make_llm_response(["tech"])

        monkeypatch.setattr(llm_mod, "generate_release_article", fake_generate)
        from release_drafter import generate_release_drafts
        async with SessionLocal() as db:
            repo = await db.get(models.GithubRepo, "owner/idrepo")
            release = await db.get(models.GithubRelease, "owner/idrepo:v2.0.0")
            await generate_release_drafts(release, repo, db)
        async with SessionLocal() as db:
            repo = await db.get(models.GithubRepo, "owner/idrepo")
            release = await db.get(models.GithubRelease, "owner/idrepo:v2.0.0")
            release.draft_generated_at = None  # reset to simulate second call
            await db.commit()
        async with SessionLocal() as db:
            repo = await db.get(models.GithubRepo, "owner/idrepo")
            release = await db.get(models.GithubRelease, "owner/idrepo:v2.0.0")
            await generate_release_drafts(release, repo, db)
        async with SessionLocal() as db:
            drafts = (await db.execute(select(models.ArticleDraft))).scalars().all()
        return len(drafts)

    loop = asyncio.new_event_loop()
    loop.run_until_complete(_setup())
    count = loop.run_until_complete(_run_twice())
    assert count == 1
```

- [ ] **Step 2: Run the tests and verify they fail (no implementation yet in this task — implementation is in prior tasks)**

```bash
cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_release_drafter.py -v 2>&1 | tail -20
```

The tests should now pass since the implementation is already written. If any test fails, diagnose and fix before proceeding.

- [ ] **Step 3: Commit**

```bash
git add backend/tests/test_release_drafter.py
git commit -m "test: add release_drafter tests — skips, idempotency, draft count"
```

---

## Task 7: Scheduler Integration

**Files:**
- Modify: `backend/scheduler.py` (lines 60–97)

- [ ] **Step 1: Add `generate_pending_drafts` call after `collect_all_repos`**

In `scheduled_github()`, replace the block from `async with SessionLocal() as db:` through `release_new = sum(...)`:

Before (around lines 70–78):
```python
        async with SessionLocal() as db:
            if do_trending:
                try:
                    trending_new = await collect_trending(db)
                except Exception as te:
                    trending_error = str(te)
            repo_results = await collect_all_repos(db)
        issue_new = sum(r["new_issues"] for r in repo_results)
        release_new = sum(r.get("new_releases", 0) for r in repo_results)
```

After:
```python
        draft_new = 0
        async with SessionLocal() as db:
            if do_trending:
                try:
                    trending_new = await collect_trending(db)
                except Exception as te:
                    trending_error = str(te)
            repo_results = await collect_all_repos(db)
        issue_new = sum(r["new_issues"] for r in repo_results)
        release_new = sum(r.get("new_releases", 0) for r in repo_results)
        if release_new > 0:
            try:
                from release_drafter import generate_pending_drafts
                async with SessionLocal() as db:
                    draft_new = await generate_pending_drafts(db)
            except Exception as de:
                detail_parts.append("draft: " + str(de))
```

Then update the log message line:
```python
        msg = "趋势 +{0}  Issues +{1}  Releases +{2}  草稿 +{3}".format(trending_new, issue_new, release_new, draft_new)
```

Note: `detail_parts` is defined a few lines later in the original code — move the `detail_parts = []` line to before the `draft_new` block, or ensure it is defined before the `except` clause uses it.

Full corrected `scheduled_github` body:

```python
async def scheduled_github():
    from logger import log
    from config import get_config
    from github_collector import collect_all_repos, collect_trending
    try:
        cfg = await get_config()
        trending_hours = max(1, int(cfg.get("github_trending_interval_hours", 6)))
        do_trending = _should_run("github_trending", trending_hours * 3600)
        trending_new = 0
        trending_error = ""
        draft_new = 0
        detail_parts = []
        async with SessionLocal() as db:
            if do_trending:
                try:
                    trending_new = await collect_trending(db)
                except Exception as te:
                    trending_error = str(te)
            repo_results = await collect_all_repos(db)
        issue_new = sum(r["new_issues"] for r in repo_results)
        release_new = sum(r.get("new_releases", 0) for r in repo_results)
        if release_new > 0:
            try:
                from release_drafter import generate_pending_drafts
                async with SessionLocal() as db:
                    draft_new = await generate_pending_drafts(db)
            except Exception as de:
                detail_parts.append("draft: " + str(de))
        errors = [r for r in repo_results if r.get("error")]
        if trending_error:
            detail_parts.append("trending: " + trending_error)
        if errors:
            for r in errors:
                detail_parts.append("{0}: {1}".format(r["repo_id"], r["error"]))
        detail = "; ".join(detail_parts)
        msg = "趋势 +{0}  Issues +{1}  Releases +{2}  草稿 +{3}".format(trending_new, issue_new, release_new, draft_new)
        if trending_error or errors:
            if trending_error:
                msg += "  (趋势抓取失败)"
            if errors:
                msg += "  ({0} 个仓库失败)".format(len(errors))
            await log("github", "warn", msg, detail)
        else:
            await log("github", "ok", msg)
    except Exception as e:
        await log("github", "error", "GitHub 采集异常", str(e))
```

- [ ] **Step 2: Commit**

```bash
git add backend/scheduler.py
git commit -m "feat(scheduler): call generate_pending_drafts after GitHub release collection"
```

---

## Task 8: Frontend Types and API

**Files:**
- Modify: `web/lib/types.ts` (lines 51–101)
- Modify: `web/lib/api/github.ts` (lines 16–25)

- [ ] **Step 1: Update `GithubRepo` interface** in `lib/types.ts`

Replace:
```typescript
export interface GithubRepo {
  id: string
  owner: string
  repo: string
  description: string
  stars: number
  language: string
  group: string
  muted: boolean
  collect_interval_minutes: number
  last_collected_at: string | null
}
```

With:
```typescript
export interface GithubRepo {
  id: string
  owner: string
  repo: string
  description: string
  stars: number
  language: string
  group: string
  muted: boolean
  collect_interval_minutes: number
  last_collected_at: string | null
  release_draft_enabled: boolean
  release_draft_types: string[]
}
```

- [ ] **Step 2: Update `GithubRelease` interface** in `lib/types.ts`

Replace:
```typescript
export interface GithubRelease {
  id: string
  repo_id: string
  tag_name: string
  name: string
  body: string
  is_prerelease: boolean
  is_draft: boolean
  html_url: string
  published_at: string
}
```

With:
```typescript
export interface GithubRelease {
  id: string
  repo_id: string
  tag_name: string
  name: string
  body: string
  is_prerelease: boolean
  is_draft: boolean
  html_url: string
  published_at: string
  draft_generated_at: string | null
}
```

- [ ] **Step 3: Update `updateGithubRepo` type** in `lib/api/github.ts`

Replace:
```typescript
export async function updateGithubRepo(
  owner: string, repo: string,
  body: { group?: string; muted?: boolean; collect_interval_minutes?: number }
): Promise<GithubRepo> {
```

With:
```typescript
export async function updateGithubRepo(
  owner: string, repo: string,
  body: { group?: string; muted?: boolean; collect_interval_minutes?: number; release_draft_enabled?: boolean; release_draft_types?: string[] }
): Promise<GithubRepo> {
```

- [ ] **Step 4: Commit**

```bash
git add web/lib/types.ts web/lib/api/github.ts
git commit -m "feat(frontend): add release draft fields to GithubRepo and GithubRelease types"
```

---

## Task 9: Frontend UI

**Files:**
- Modify: `web/app/github/GithubClient.tsx`

There are two UI changes: (A) draft badge on release cards, (B) draft settings toggles in the repo management dialog.

### Part A — Draft badge on release cards

- [ ] **Step 1: Add the draft badge to each release card**

In `ReleasesTab`, find the release card's header flex row (around line 541 — the `<div className="flex items-center gap-2 mb-1 flex-wrap">`). After the `{rel.is_prerelease && ...}` badge block and before the timestamp `<span className="ml-auto ...">`, add:

```tsx
                      {rel.draft_generated_at && (
                        <a
                          href="/drafts"
                          className="text-[10px] font-medium border px-1.5 py-0.5 rounded-full text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950 border-emerald-200 dark:border-emerald-800 hover:opacity-80 transition-opacity"
                        >
                          草稿已生成
                        </a>
                      )}
```

### Part B — Draft settings in the repo management dialog

The repo management dialog (the `SubscriptionsDialog` component around line 60–200) currently has mute/sync/delete per repo. Add draft settings as a small expandable row below each repo entry.

- [ ] **Step 2: Add `expandedRepoId` state to `SubscriptionsDialog`**

Find the `SubscriptionsDialog` function (around line 60). After the existing `useState` declarations, add:

```tsx
  const [expandedRepoId, setExpandedRepoId] = useState<string | null>(null)
```

- [ ] **Step 3: Add draft toggle and type selector to each repo row**

After the closing `</div>` of each repo row (the one containing the mute/sync/delete buttons, around line 198), and before the wrapping `</div>` of the `repos.map`, add the expandable draft settings panel:

```tsx
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0"
                    title="草稿设置"
                    onClick={() => setExpandedRepoId(expandedRepoId === r.id ? null : r.id)}>
                    <FileText className="w-3 h-3" />
                  </Button>
```

Add this button to the same flex row as the mute/sync/delete buttons (before the delete button).

Then after the closing `</div>` of the repo row's main flex container, add the expanded panel:

```tsx
                {expandedRepoId === r.id && (
                  <div className="px-2.5 py-2 bg-zinc-50 dark:bg-zinc-900 border-t border-zinc-100 dark:border-zinc-800 flex items-center gap-3 flex-wrap">
                    <span className="text-[11px] text-zinc-500">发布稿</span>
                    <button
                      className={cn(
                        'text-[11px] px-2 py-0.5 rounded border transition-colors',
                        r.release_draft_enabled
                          ? 'bg-indigo-50 border-indigo-200 text-indigo-600 dark:bg-indigo-950 dark:border-indigo-800 dark:text-indigo-400'
                          : 'bg-zinc-100 border-zinc-200 text-zinc-500 dark:bg-zinc-800 dark:border-zinc-700'
                      )}
                      onClick={async () => {
                        const u = await updateGithubRepo(r.owner, r.repo, { release_draft_enabled: !r.release_draft_enabled })
                        onUpdated(u)
                      }}
                    >
                      {r.release_draft_enabled ? '已开启' : '已关闭'}
                    </button>
                    {r.release_draft_enabled && (
                      <>
                        {(['tech', 'product'] as const).map(t => {
                          const active = r.release_draft_types.includes(t)
                          const label = t === 'tech' ? '技术向' : '产品向'
                          return (
                            <button
                              key={t}
                              className={cn(
                                'text-[11px] px-2 py-0.5 rounded border transition-colors',
                                active
                                  ? 'bg-emerald-50 border-emerald-200 text-emerald-600 dark:bg-emerald-950 dark:border-emerald-800 dark:text-emerald-400'
                                  : 'bg-zinc-100 border-zinc-200 text-zinc-500 dark:bg-zinc-800 dark:border-zinc-700'
                              )}
                              onClick={async () => {
                                const next = active
                                  ? r.release_draft_types.filter(x => x !== t)
                                  : [...r.release_draft_types, t]
                                if (next.length === 0) return // must keep at least one
                                const u = await updateGithubRepo(r.owner, r.repo, { release_draft_types: next })
                                onUpdated(u)
                              }}
                            >
                              {label}
                            </button>
                          )
                        })}
                      </>
                    )}
                  </div>
                )}
```

- [ ] **Step 4: Add `FileText` to lucide imports**

In `GithubClient.tsx`, find the lucide-react import line (near the top) and add `FileText` to the import list.

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd /workspace/projects/WeMediaStudio/web && source ~/.zshrc && npm run build 2>&1 | tail -20
```

Fix any TypeScript errors before committing.

- [ ] **Step 6: Commit**

```bash
git add web/app/github/GithubClient.tsx
git commit -m "feat(ui): add release draft badge and per-repo draft settings to GitHub page"
```

---

## Self-Review Checklist

After writing this plan, checking coverage against the spec:

| Spec requirement | Task |
|---|---|
| `draft_generated_at` on `GithubRelease` | Task 1 (migration) + Task 2 (model) |
| `release_draft_enabled` + `release_draft_types` on `GithubRepo` | Task 1 + Task 2 |
| PATCH endpoint handles new fields | Task 3 step 4 |
| LLM generates tech + product drafts with fine-grained `[TODO]` | Task 4 |
| Scheduler: only latest release per repo | Task 5 (`LIMIT 1` + `ORDER BY published_at DESC`) |
| Skip releases older than N days (spec: 30 days) | Task 5 |
| Idempotency (`draft_generated_at` flag) | Task 5 + tested in Task 6 |
| ArticleDraft written with correct `topic_id` / `title` / `sources` | Task 5 |
| Scheduler calls drafter after collect | Task 7 |
| Empty changelog handled gracefully | Task 4 (empty body branch) |
| Prerelease gets `[pre]` prefix | Task 4 |
| Draft badge on release cards (links to `/drafts`) | Task 9 Part A |
| Repo settings: enable/disable + type selection | Task 9 Part B |
| TypeScript types updated | Task 8 |
