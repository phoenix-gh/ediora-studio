# Content-to-Topic Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户在选题库 UI 粘贴文章 URL 或文本，派发给 Hermes scout agent；scout 搜索现有选题，决策更新/跳过/新建，并写入 `topic_updates` 变更历史。

**Architecture:** 新增 `TopicUpdate` 模型 + 3 个 REST 端点（analyze/search/updates）；更新 3 个 MCP 工具 + 新增 3 个；给 wms_scout SOUL.md 加 content-to-topic 章节；前端加"分析文章" dialog + "更新历史" tab。

**Tech Stack:** FastAPI + SQLAlchemy async, SQLite+aiosqlite (tests), Next.js 15, shadcn/ui, Tailwind CSS, HermesKanbanClient, FastMCP

All `conda run -n wems` or `source ~/.zshrc` prefixes are needed when running commands in this project.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `backend/models.py` | Modify | Add `TopicUpdate` model |
| `backend/database.py` | Modify | Add `CREATE TABLE IF NOT EXISTS topic_updates` DDL |
| `backend/schemas.py` | Modify | Add `TopicUpdateOut`, `AnalyzeRequest`, `AnalyzeResponse` |
| `backend/routers/content_topics.py` | Modify | Add `/analyze`, `/search`, `/{id}/updates` endpoints |
| `backend/mcp_server.py` | Modify | Update 3 existing tools; add `search_topics_by_keywords`, `update_content_topic`, `add_topic_update` |
| `/home/violet/.hermes/profiles/wms_scout/SOUL.md` | Modify | Add content-to-topic capability section |
| `backend/tests/test_content_topics.py` | Modify | Add tests for search, analyze, updates endpoints |
| `wemedia-studio/lib/api/content-topics.ts` | Modify | Add `TopicUpdate`, analyze/updates API functions |
| `wemedia-studio/app/topics/TopicsClient.tsx` | Modify | Add analyze dialog + updates tab |

---

## Task 1: Backend Model + Migration

**Files:**
- Modify: `backend/models.py`
- Modify: `backend/database.py`

- [ ] **Step 1: Add `TopicUpdate` model to `backend/models.py`**

After the `ContentTopicTag` class, insert:

```python
class TopicUpdate(Base):
    """Changelog entry written by scout agent when processing a content-to-topic task."""
    __tablename__ = "topic_updates"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    topic_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    source_url: Mapped[str] = mapped_column(Text, default="")
    description: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
```

- [ ] **Step 2: Add DDL migration to `backend/database.py`**

In the `init_db()` async function (inside the `async with engine.begin() as conn:` block), add after existing ALTER TABLE statements:

```python
await conn.execute(text("""
    CREATE TABLE IF NOT EXISTS topic_updates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic_id INTEGER NOT NULL,
        source_url TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT (datetime('now'))
    )
"""))
```

- [ ] **Step 3: Verify the model is importable**

```bash
source ~/.zshrc && conda run -n wems python -c "from models import TopicUpdate; print('OK')" 
```
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
cd /workspace/projects/WeMediaStudio
git add backend/models.py backend/database.py
git commit -m "feat(models): add TopicUpdate model and migration"
```

---

## Task 2: Backend Schemas

**Files:**
- Modify: `backend/schemas.py`

- [ ] **Step 1: Add new schemas to `backend/schemas.py`**

After `DispatchResponse`, add:

```python
class TopicUpdateOut(BaseModel):
    id: int
    topic_id: int
    source_url: str
    description: str
    created_at: datetime
    model_config = {"from_attributes": True}

class AnalyzeRequest(BaseModel):
    url: Optional[str] = None
    content: Optional[str] = None

class AnalyzeResponse(BaseModel):
    task_id: str
    kanban_url: str
```

- [ ] **Step 2: Verify import**

```bash
source ~/.zshrc && conda run -n wems python -c "from schemas import TopicUpdateOut, AnalyzeRequest, AnalyzeResponse; print('OK')"
```
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
cd /workspace/projects/WeMediaStudio
git add backend/schemas.py
git commit -m "feat(schemas): add TopicUpdateOut, AnalyzeRequest, AnalyzeResponse"
```

---

## Task 3: Backend Router — Three New Endpoints

**Files:**
- Modify: `backend/routers/content_topics.py`

- [ ] **Step 1: Add imports at top of router file**

Ensure `TopicUpdate`, `TopicUpdateOut`, `AnalyzeRequest`, `AnalyzeResponse` are imported. Open `backend/routers/content_topics.py`, check/add to imports:

```python
from models import ContentTopic, TopicSource, TopicTag, ContentTopicTag, ArticleDraft, TopicUpdate
from schemas import (
    ContentTopicCreate, ContentTopicUpdate, ContentTopicOut,
    TopicTagCreate, TopicTagOut,
    TopicSourceCreate, TopicSourceOut,
    ArticleDraftSummary, DispatchResponse,
    TopicUpdateOut, AnalyzeRequest, AnalyzeResponse,
)
```

- [ ] **Step 2: Add `/search` endpoint**

Register this BEFORE `/{topic_id}` endpoints (to avoid int-matching conflict). Add after the `/tags` group:

```python
@router.get("/search", response_model=list[ContentTopicOut])
async def search_topics(q: str = "", db=Depends(get_db)):
    if not q.strip():
        return []
    keywords = [k.strip() for k in q.replace(",", " ").split() if k.strip()]
    stmt = select(ContentTopic).where(ContentTopic.status == "active")
    rows = (await db.execute(stmt)).scalars().all()
    matched = []
    for t in rows:
        haystack = (t.title + " " + t.brief).lower()
        if any(kw.lower() in haystack for kw in keywords):
            matched.append(t)
    matched = matched[:10]
    return [await _build_topic_out(db, t) for t in matched]
```

(Assumes `_build_topic_out` helper already exists from the previous redesign. If not, inline the logic or reuse the list endpoint's enrichment.)

- [ ] **Step 3: Add `/{topic_id}/updates` endpoint**

After the existing `/{topic_id}/dispatch` endpoint:

```python
@router.get("/{topic_id}/updates", response_model=list[TopicUpdateOut])
async def list_topic_updates(topic_id: int, db=Depends(get_db)):
    obj = await db.get(ContentTopic, topic_id)
    if not obj:
        raise HTTPException(404, "Topic not found")
    rows = (await db.execute(
        select(TopicUpdate)
        .where(TopicUpdate.topic_id == topic_id)
        .order_by(TopicUpdate.created_at.desc())
    )).scalars().all()
    return rows
```

- [ ] **Step 4: Add `/analyze` endpoint**

Register BEFORE `/{topic_id}` int routes (same as `/search`):

```python
@router.post("/analyze", response_model=AnalyzeResponse)
async def analyze_article(body: AnalyzeRequest):
    if not body.url and not body.content:
        raise HTTPException(400, "url 或 content 至少提供一个")
    task_body_parts = ["## 任务类型\ncontent-to-topic\n\n## 输入"]
    if body.url:
        task_body_parts.append(f"URL: {body.url}")
    if body.content:
        task_body_parts.append(f"内容:\n{body.content[:3000]}")
    task_body_parts.append(
        "\n## 指令\n"
        "1. 读取文章，提取 3-5 个主题关键词\n"
        "2. 调 search_topics_by_keywords 检索候选选题（传入关键词列表）\n"
        "3. 判断相似度：\n"
        "   - 相似且有新角度 → update_content_topic + add_topic_update（记录新增了什么）\n"
        "   - 相似但无新内容 → add_topic_update（记录跳过原因，topic_id 取相似选题 id）\n"
        "   - 无匹配 → create_content_topic + add_topic_update（记录新建原因）"
    )
    task_body = "\n".join(task_body_parts)
    from hermes_kanban_client import HermesKanbanClient, HermesKanbanError
    try:
        kanban = HermesKanbanClient()
        task_id = await kanban.create_task(
            title="[选题整理] 文章分析",
            body=task_body,
            assignee="wms_scout",
        )
    except HermesKanbanError as e:
        raise HTTPException(502, f"Hermes 不可用: {e}")
    return AnalyzeResponse(task_id=task_id, kanban_url="/studio")
```

- [ ] **Step 5: Run existing tests to confirm no regressions**

```bash
source ~/.zshrc && conda run -n wems pytest backend/tests/test_content_topics.py -v
```
Expected: All 14 existing tests pass.

- [ ] **Step 6: Commit**

```bash
cd /workspace/projects/WeMediaStudio
git add backend/routers/content_topics.py
git commit -m "feat(api): add /analyze, /search, /{id}/updates endpoints"
```

---

## Task 4: Tests for New Endpoints

**Files:**
- Modify: `backend/tests/test_content_topics.py`

- [ ] **Step 1: Add search tests**

```python
# ── Search ────────────────────────────────────────────────────────────────────

def test_search_returns_matches(client):
    client.post("/api/content-topics", json={"title": "AI 创业案例", "brief": "调研 AI 一人公司", "tags": []})
    client.post("/api/content-topics", json={"title": "健康饮食", "brief": "调研营养学", "tags": []})
    r = client.get("/api/content-topics/search?q=AI")
    assert r.status_code == 200
    titles = [t["title"] for t in r.json()]
    assert "AI 创业案例" in titles
    assert "健康饮食" not in titles


def test_search_empty_query_returns_empty(client):
    r = client.get("/api/content-topics/search?q=")
    assert r.status_code == 200
    assert r.json() == []
```

- [ ] **Step 2: Add updates tests**

```python
# ── Updates ───────────────────────────────────────────────────────────────────

def test_list_updates_empty(client):
    r = client.post("/api/content-topics", json={"title": "选题", "tags": []})
    topic_id = r.json()["id"]
    ur = client.get(f"/api/content-topics/{topic_id}/updates")
    assert ur.status_code == 200
    assert ur.json() == []


def test_list_updates_returns_entries(client):
    from database import SessionLocal
    from models import TopicUpdate
    import asyncio

    r = client.post("/api/content-topics", json={"title": "选题", "tags": []})
    topic_id = r.json()["id"]

    async def _seed():
        async with SessionLocal() as db:
            db.add(TopicUpdate(topic_id=topic_id, description="新增角度：产品化路径", source_url="https://example.com"))
            await db.commit()

    asyncio.new_event_loop().run_until_complete(_seed())
    ur = client.get(f"/api/content-topics/{topic_id}/updates")
    assert ur.status_code == 200
    assert len(ur.json()) == 1
    assert ur.json()[0]["description"] == "新增角度：产品化路径"
```

- [ ] **Step 3: Add analyze test**

```python
# ── Analyze ───────────────────────────────────────────────────────────────────

def test_analyze_no_input_returns_400(client):
    r = client.post("/api/content-topics/analyze", json={})
    assert r.status_code == 400


def test_analyze_dispatches_task(client, monkeypatch):
    async def _mock_create_task(self, *, title, body, assignee, parents=None):
        assert assignee == "wms_scout"
        assert "content-to-topic" in body
        return "mock-analyze-task-1"

    from hermes_kanban_client import HermesKanbanClient
    monkeypatch.setattr(HermesKanbanClient, "create_task", _mock_create_task)

    r = client.post("/api/content-topics/analyze", json={"url": "https://example.com/article"})
    assert r.status_code == 200
    assert r.json()["task_id"] == "mock-analyze-task-1"
    assert r.json()["kanban_url"] == "/studio"
```

- [ ] **Step 4: Run all tests**

```bash
source ~/.zshrc && conda run -n wems pytest backend/tests/test_content_topics.py -v
```
Expected: All tests pass (14 existing + 6 new = 20 total).

- [ ] **Step 5: Commit**

```bash
cd /workspace/projects/WeMediaStudio
git add backend/tests/test_content_topics.py
git commit -m "test(content-topics): add tests for search, analyze, updates endpoints"
```

---

## Task 5: Update MCP Tools

**Files:**
- Modify: `backend/mcp_server.py`

- [ ] **Step 1: Update `list_content_topics` tool**

Replace the existing `list_content_topics` function body. Key changes: return `brief` instead of `description`, add `tags`, remove `parent_id`:

```python
@mcp.tool()
async def list_content_topics(
    include_archived: bool = False,
) -> list[dict]:
    """
    List all user-managed content topics (选题库) as a flat list.

    Topics are sorted by priority then created_at.

    Args:
        include_archived: Include archived topics (default False).

    Returns a flat list. Each item includes: id, title, brief,
    tags (list of {id, name, color}), priority (1=highest), status,
    source_count, draft_count, created_at.
    """
    from models import ContentTopic, TopicSource, ArticleDraft, TopicTag, ContentTopicTag
    from sqlalchemy import func

    async with SessionLocal() as db:
        q = select(ContentTopic).order_by(ContentTopic.priority, ContentTopic.created_at)
        if not include_archived:
            q = q.where(ContentTopic.status == "active")
        topics = (await db.execute(q)).scalars().all()

        ids = [t.id for t in topics]

        source_counts = dict((await db.execute(
            select(TopicSource.topic_id, func.count())
            .where(TopicSource.topic_id.in_(ids))
            .group_by(TopicSource.topic_id)
        )).all()) if ids else {}

        draft_counts = dict((await db.execute(
            select(ArticleDraft.content_topic_id, func.count())
            .where(ArticleDraft.content_topic_id.in_(ids))
            .group_by(ArticleDraft.content_topic_id)
        )).all()) if ids else {}

        tag_rows = (await db.execute(
            select(ContentTopicTag.topic_id, TopicTag.id, TopicTag.name, TopicTag.color)
            .join(TopicTag, TopicTag.id == ContentTopicTag.tag_id)
            .where(ContentTopicTag.topic_id.in_(ids))
        )).all() if ids else []
        tags_by_topic: dict[int, list[dict]] = {}
        for row in tag_rows:
            tags_by_topic.setdefault(row.topic_id, []).append(
                {"id": row.id, "name": row.name, "color": row.color}
            )

    return [
        {
            "id": t.id,
            "title": t.title,
            "brief": t.brief or "",
            "tags": tags_by_topic.get(t.id, []),
            "priority": t.priority,
            "status": t.status,
            "source_count": source_counts.get(t.id, 0),
            "draft_count": draft_counts.get(t.id, 0),
            "created_at": _fmt_dt(t.created_at),
        }
        for t in topics
    ]
```

- [ ] **Step 2: Update `get_content_topic` tool**

Replace the existing function. Add `brief`, `tags`, `updates`; remove `description`/`parent_id`:

```python
@mcp.tool()
async def get_content_topic(topic_id: int) -> dict:
    """
    Get a specific content topic with its sources, tags, and update history.

    Args:
        topic_id: Integer ID of the topic (from list_content_topics or search_topics_by_keywords).

    Returns: id, title, brief, tags, priority, status, created_at,
             sources list, and updates list (most recent first).
    Raises an error if the topic is not found.
    """
    from models import ContentTopic, TopicSource, TopicTag, ContentTopicTag, TopicUpdate

    async with SessionLocal() as db:
        topic = await db.get(ContentTopic, topic_id)
        if topic is None:
            raise ValueError(f"Topic {topic_id} not found")

        sources = (await db.execute(
            select(TopicSource)
            .where(TopicSource.topic_id == topic_id)
            .order_by(desc(TopicSource.created_at))
        )).scalars().all()

        tag_rows = (await db.execute(
            select(TopicTag)
            .join(ContentTopicTag, ContentTopicTag.tag_id == TopicTag.id)
            .where(ContentTopicTag.topic_id == topic_id)
        )).scalars().all()

        updates = (await db.execute(
            select(TopicUpdate)
            .where(TopicUpdate.topic_id == topic_id)
            .order_by(desc(TopicUpdate.created_at))
            .limit(20)
        )).scalars().all()

    return {
        "id": topic.id,
        "title": topic.title,
        "brief": topic.brief or "",
        "tags": [{"id": t.id, "name": t.name, "color": t.color} for t in tag_rows],
        "priority": topic.priority,
        "status": topic.status,
        "created_at": _fmt_dt(topic.created_at),
        "sources": [
            {
                "id": s.id,
                "url": s.url or "",
                "title": s.title or "",
                "note": s.note or "",
                "platform": s.platform,
                "created_at": _fmt_dt(s.created_at),
            }
            for s in sources
        ],
        "updates": [
            {
                "id": u.id,
                "description": u.description,
                "source_url": u.source_url or "",
                "created_at": _fmt_dt(u.created_at),
            }
            for u in updates
        ],
    }
```

- [ ] **Step 3: Update `create_content_topic` tool**

Replace with new signature (brief + tags, no description/parent_id):

```python
@mcp.tool()
async def create_content_topic(
    title: str,
    brief: str = "",
    tags: Optional[list[str]] = None,
    priority: int = 3,
) -> dict:
    """
    Create a new content topic in the 选题库.

    Args:
        title: Topic name, e.g. "Claude 国内使用教程".
        brief: Markdown brief describing the content angle and research scope (optional).
        tags: List of tag names to attach (will be created if they don't exist).
        priority: 1 (highest) to 5 (lowest). Default 3.

    Returns: id, title, brief, tags, priority, status, created_at.
    """
    from models import ContentTopic, TopicTag, ContentTopicTag
    from sqlalchemy import func, delete

    _TAG_COLORS = ["#6366f1","#8b5cf6","#ec4899","#f59e0b","#10b981","#3b82f6","#ef4444","#14b8a6"]

    async def _get_or_create_tag(db, name: str) -> TopicTag:
        normalized = name.strip().lower()
        existing = (await db.execute(
            select(TopicTag).where(func.lower(TopicTag.name) == normalized)
        )).scalar_one_or_none()
        if existing:
            return existing
        color = _TAG_COLORS[sum(ord(c) for c in name) % len(_TAG_COLORS)]
        tag = TopicTag(name=name.strip(), color=color)
        db.add(tag)
        await db.flush()
        return tag

    async with SessionLocal() as db:
        obj = ContentTopic(
            title=title,
            brief=brief,
            priority=max(1, min(5, priority)),
        )
        db.add(obj)
        await db.flush()

        for name in (tags or []):
            if name.strip():
                tag = await _get_or_create_tag(db, name)
                db.add(ContentTopicTag(topic_id=obj.id, tag_id=tag.id))

        await db.commit()
        await db.refresh(obj)

        tag_rows = (await db.execute(
            select(TopicTag)
            .join(ContentTopicTag, ContentTopicTag.tag_id == TopicTag.id)
            .where(ContentTopicTag.topic_id == obj.id)
        )).scalars().all()

    return {
        "id": obj.id,
        "title": obj.title,
        "brief": obj.brief or "",
        "tags": [{"id": t.id, "name": t.name, "color": t.color} for t in tag_rows],
        "priority": obj.priority,
        "status": obj.status,
        "created_at": _fmt_dt(obj.created_at),
    }
```

- [ ] **Step 4: Add `search_topics_by_keywords` tool**

After `create_content_topic`:

```python
@mcp.tool()
async def search_topics_by_keywords(keywords: list[str]) -> list[dict]:
    """
    Search existing content topics by keywords (full-text match on title + brief).

    Use this as the first step in content-to-topic analysis to find candidate
    topics before asking the LLM to judge similarity.

    Args:
        keywords: List of keywords extracted from the source article, e.g. ["AI", "创业", "一人公司"].

    Returns up to 10 matching topics, each with: id, title, brief (first 200 chars), tags.
    Returns empty list if no matches or keywords is empty.
    """
    from models import ContentTopic, TopicTag, ContentTopicTag

    if not keywords:
        return []

    async with SessionLocal() as db:
        topics = (await db.execute(
            select(ContentTopic).where(ContentTopic.status == "active")
        )).scalars().all()

        matched = []
        for t in topics:
            haystack = (t.title + " " + (t.brief or "")).lower()
            if any(kw.lower() in haystack for kw in keywords if kw.strip()):
                matched.append(t)
        matched = matched[:10]

        if not matched:
            return []

        ids = [t.id for t in matched]
        tag_rows = (await db.execute(
            select(ContentTopicTag.topic_id, TopicTag.id, TopicTag.name, TopicTag.color)
            .join(TopicTag, TopicTag.id == ContentTopicTag.tag_id)
            .where(ContentTopicTag.topic_id.in_(ids))
        )).all()
        tags_by_topic: dict[int, list[dict]] = {}
        for row in tag_rows:
            tags_by_topic.setdefault(row.topic_id, []).append(
                {"id": row.id, "name": row.name, "color": row.color}
            )

    return [
        {
            "id": t.id,
            "title": t.title,
            "brief": (t.brief or "")[:200],
            "tags": tags_by_topic.get(t.id, []),
        }
        for t in matched
    ]
```

- [ ] **Step 5: Add `update_content_topic` tool**

```python
@mcp.tool()
async def update_content_topic(
    topic_id: int,
    title: Optional[str] = None,
    brief: Optional[str] = None,
    tags: Optional[list[str]] = None,
    priority: Optional[int] = None,
) -> dict:
    """
    Update an existing content topic.

    Args:
        topic_id: ID of the topic to update (from list_content_topics or search_topics_by_keywords).
        title: New title, or omit to leave unchanged.
        brief: New full markdown brief, or omit to leave unchanged.
        tags: New tag list (full replacement), or omit to leave unchanged.
        priority: New priority 1-5, or omit to leave unchanged.

    Returns: updated topic with id, title, brief, tags, priority, status, updated_at.
    Raises an error if the topic is not found.
    """
    from models import ContentTopic, TopicTag, ContentTopicTag
    from sqlalchemy import func, delete

    _TAG_COLORS = ["#6366f1","#8b5cf6","#ec4899","#f59e0b","#10b981","#3b82f6","#ef4444","#14b8a6"]

    async def _get_or_create_tag(db, name: str) -> TopicTag:
        normalized = name.strip().lower()
        existing = (await db.execute(
            select(TopicTag).where(func.lower(TopicTag.name) == normalized)
        )).scalar_one_or_none()
        if existing:
            return existing
        color = _TAG_COLORS[sum(ord(c) for c in name) % len(_TAG_COLORS)]
        tag = TopicTag(name=name.strip(), color=color)
        db.add(tag)
        await db.flush()
        return tag

    async with SessionLocal() as db:
        obj = await db.get(ContentTopic, topic_id)
        if obj is None:
            raise ValueError(f"Topic {topic_id} not found")

        if title is not None:
            obj.title = title
        if brief is not None:
            obj.brief = brief
        if priority is not None:
            obj.priority = max(1, min(5, priority))

        if tags is not None:
            await db.execute(delete(ContentTopicTag).where(ContentTopicTag.topic_id == topic_id))
            for name in tags:
                if name.strip():
                    tag = await _get_or_create_tag(db, name)
                    db.add(ContentTopicTag(topic_id=topic_id, tag_id=tag.id))

        await db.commit()
        await db.refresh(obj)

        tag_rows = (await db.execute(
            select(TopicTag)
            .join(ContentTopicTag, ContentTopicTag.tag_id == TopicTag.id)
            .where(ContentTopicTag.topic_id == obj.id)
        )).scalars().all()

    return {
        "id": obj.id,
        "title": obj.title,
        "brief": obj.brief or "",
        "tags": [{"id": t.id, "name": t.name, "color": t.color} for t in tag_rows],
        "priority": obj.priority,
        "status": obj.status,
        "updated_at": _fmt_dt(obj.updated_at),
    }
```

- [ ] **Step 6: Add `add_topic_update` tool**

```python
@mcp.tool()
async def add_topic_update(
    topic_id: int,
    description: str,
    source_url: str = "",
) -> dict:
    """
    Record a changelog entry for a content topic.

    Call this after every content-to-topic action — whether you updated,
    created, or skipped. The description should explain what changed or why
    you skipped, so the user can review the decision.

    Args:
        topic_id: ID of the affected topic.
        description: Human-readable summary of what happened, e.g.
                     "新增角度：产品化路径，补充了 2025 Q1 数据" or
                     "无新增角度，已有选题覆盖相同切入点，跳过".
        source_url: URL of the source article (optional).

    Returns: id, topic_id, description, source_url, created_at.
    """
    from models import ContentTopic, TopicUpdate

    async with SessionLocal() as db:
        topic = await db.get(ContentTopic, topic_id)
        if topic is None:
            raise ValueError(f"Topic {topic_id} not found")

        obj = TopicUpdate(
            topic_id=topic_id,
            description=description.strip(),
            source_url=source_url.strip(),
        )
        db.add(obj)
        await db.commit()
        await db.refresh(obj)

    return {
        "id": obj.id,
        "topic_id": obj.topic_id,
        "description": obj.description,
        "source_url": obj.source_url or "",
        "created_at": _fmt_dt(obj.created_at),
    }
```

- [ ] **Step 7: Verify MCP server imports cleanly**

```bash
source ~/.zshrc && conda run -n wems python -c "import mcp_server; print('MCP OK')"
```
Expected: `MCP OK`

- [ ] **Step 8: Commit**

```bash
cd /workspace/projects/WeMediaStudio
git add backend/mcp_server.py
git commit -m "feat(mcp): update topic tools; add search_topics_by_keywords, update_content_topic, add_topic_update"
```

---

## Task 6: Scout SOUL.md Update

**Files:**
- Modify: `/home/violet/.hermes/profiles/wms_scout/SOUL.md`

- [ ] **Step 1: Read the current SOUL.md**

Read `/home/violet/.hermes/profiles/wms_scout/SOUL.md` to understand existing content.

- [ ] **Step 2: Append content-to-topic section**

Add at the end of the file:

```markdown

---

## 选题库管理（content-to-topic）

当任务 body 包含 `## 任务类型\ncontent-to-topic` 时，按以下步骤处理：

### 步骤

1. **读取文章**
   - 若有 URL：用 fetch 工具抓取页面正文
   - 若是粘贴文本：直接使用 body 中"内容:"段落

2. **提取关键词**
   - 从文章中提取 3-5 个最能代表主题的关键词（中文或英文）

3. **检索现有选题**
   - 调 `search_topics_by_keywords(keywords=[...])` 检索候选选题
   - 仔细阅读返回的 `title` 和 `brief`（前 200 字）

4. **判断并执行**

   **情况 A：找到相似选题，且文章带来了新角度/新数据/新事实**
   - 调 `update_content_topic(topic_id=..., brief=<更新后的完整 brief>)`
   - 在新 brief 中保留原有内容，追加新角度段落
   - 调 `add_topic_update(topic_id=..., description="新增角度：...", source_url=<url>)`

   **情况 B：找到相似选题，但文章没有带来新内容**
   - 不修改选题
   - 调 `add_topic_update(topic_id=..., description="无新增角度，跳过。原因：...", source_url=<url>)`

   **情况 C：未找到相似选题**
   - 调 `create_content_topic(title=<简洁标题>, brief=<从文章提炼的调研 brief>, tags=[...])`
   - 调 `add_topic_update(topic_id=<新建的 id>, description="新建选题。文章提供了：...", source_url=<url>)`

5. **完成**：在任务最终消息中总结执行了哪个情况（A/B/C）及结果。

### 注意
- `brief` 用 Markdown 格式，包含调研主题、核心问题、搜索角度
- `add_topic_update` 的 `description` 要足够清晰，让用户一眼看懂你做了什么决定和原因
- 每次任务最多处理一篇文章；不要批量循环
```

- [ ] **Step 3: Commit**

```bash
cd /workspace/projects/WeMediaStudio
git add /home/violet/.hermes/profiles/wms_scout/SOUL.md 2>/dev/null || true
# SOUL.md is outside the repo — no commit needed, changes are live immediately
echo "SOUL.md updated"
```

Note: SOUL.md is outside the git repo, changes take effect immediately (Hermes reloads SOUL on each message).

---

## Task 7: Frontend TypeScript Types + API Functions

**Files:**
- Modify: `wemedia-studio/lib/api/content-topics.ts`

- [ ] **Step 1: Add `TopicUpdate` interface and new functions**

After the `DispatchResult` interface, add:

```typescript
export interface TopicUpdate {
  id: number
  topic_id: number
  source_url: string
  description: string
  created_at: string
}

export interface AnalyzeRequest {
  url?: string
  content?: string
}

export interface AnalyzeResult {
  task_id: string
  kanban_url: string
}
```

After `dispatchTopic`, add:

```typescript
export async function analyzeTopic(body: AnalyzeRequest): Promise<AnalyzeResult> {
  return apiFetch<AnalyzeResult>('/content-topics/analyze', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function getTopicUpdates(topicId: number): Promise<TopicUpdate[]> {
  return apiFetch<TopicUpdate[]>(`/content-topics/${topicId}/updates`)
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
source ~/.zshrc && cd /workspace/projects/WeMediaStudio/wemedia-studio && npm run build 2>&1 | tail -20
```
Expected: Build succeeds (or only pre-existing errors in StudioClient.tsx).

- [ ] **Step 3: Commit**

```bash
cd /workspace/projects/WeMediaStudio
git add wemedia-studio/lib/api/content-topics.ts
git commit -m "feat(frontend): add TopicUpdate type and analyzeTopic/getTopicUpdates API functions"
```

---

## Task 8: Frontend UI

**Files:**
- Modify: `wemedia-studio/app/topics/TopicsClient.tsx`

- [ ] **Step 1: Read current TopicsClient.tsx**

Read `wemedia-studio/app/topics/TopicsClient.tsx` to understand the current structure before making changes.

- [ ] **Step 2: Add imports**

Add to the top imports:

```typescript
import { analyzeTopic, getTopicUpdates, TopicUpdate, AnalyzeRequest } from '@/lib/api/content-topics'
```

- [ ] **Step 3: Add state for analyze dialog**

In the component body, alongside existing `useState` declarations, add:

```typescript
const [analyzeOpen, setAnalyzeOpen] = useState(false)
const [analyzeTab, setAnalyzeTab] = useState<'url' | 'text'>('url')
const [analyzeUrl, setAnalyzeUrl] = useState('')
const [analyzeText, setAnalyzeText] = useState('')
const [analyzeBusy, setAnalyzeBusy] = useState(false)

const [topicUpdates, setTopicUpdates] = useState<TopicUpdate[]>([])
const [updatesLoading, setUpdatesLoading] = useState(false)
```

- [ ] **Step 4: Add analyze submit handler**

```typescript
async function handleAnalyze() {
  const body: AnalyzeRequest = analyzeTab === 'url'
    ? { url: analyzeUrl.trim() }
    : { content: analyzeText.trim() }
  if (!body.url && !body.content) return
  setAnalyzeBusy(true)
  try {
    const res = await analyzeTopic(body)
    toast.success('已派发给 Scout', {
      description: `任务 ${res.task_id}`,
      action: { label: '查看看板', onClick: () => window.open(res.kanban_url, '_blank') },
    })
    setAnalyzeOpen(false)
    setAnalyzeUrl('')
    setAnalyzeText('')
  } catch {
    toast.error('派发失败')
  } finally {
    setAnalyzeBusy(false)
  }
}
```

- [ ] **Step 5: Add updates fetch on tab switch**

In the tab `onValueChange` handler (or wherever the detail tabs are switched), add logic:

```typescript
async function handleTabChange(tab: string) {
  setActiveTab(tab)
  if (tab === 'updates' && selected) {
    setUpdatesLoading(true)
    try {
      setTopicUpdates(await getTopicUpdates(selected.id))
    } finally {
      setUpdatesLoading(false)
    }
  }
}
```

Also reset `topicUpdates` when `selected` changes:
```typescript
useEffect(() => { setTopicUpdates([]) }, [selected?.id])
```

- [ ] **Step 6: Add "分析文章" button to toolbar**

In the top action bar (near the "新建选题" button), add:

```tsx
<Button variant="outline" size="sm" onClick={() => setAnalyzeOpen(true)}>
  分析文章
</Button>
```

- [ ] **Step 7: Add "分析文章" Dialog/Sheet**

Before the closing `</div>` of the component, add:

```tsx
<Dialog open={analyzeOpen} onOpenChange={setAnalyzeOpen}>
  <DialogContent className="max-w-lg">
    <DialogHeader>
      <DialogTitle>分析文章 → 整理选题</DialogTitle>
    </DialogHeader>
    <div className="space-y-3 py-2">
      <div className="flex gap-2">
        <Button
          variant={analyzeTab === 'url' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setAnalyzeTab('url')}
        >URL</Button>
        <Button
          variant={analyzeTab === 'text' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setAnalyzeTab('text')}
        >粘贴文本</Button>
      </div>
      {analyzeTab === 'url' ? (
        <Input
          placeholder="https://..."
          value={analyzeUrl}
          onChange={e => setAnalyzeUrl(e.target.value)}
        />
      ) : (
        <textarea
          className="w-full min-h-[120px] rounded-md border border-input bg-background px-3 py-2 text-sm resize-y"
          placeholder="粘贴文章正文..."
          value={analyzeText}
          onChange={e => setAnalyzeText(e.target.value)}
        />
      )}
    </div>
    <DialogFooter>
      <Button variant="outline" onClick={() => setAnalyzeOpen(false)}>取消</Button>
      <Button
        onClick={handleAnalyze}
        disabled={analyzeBusy || (analyzeTab === 'url' ? !analyzeUrl.trim() : !analyzeText.trim())}
      >
        {analyzeBusy ? '派发中…' : '派发给 Scout'}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

- [ ] **Step 8: Add "更新历史" Tab to detail panel**

In the right panel's `<Tabs>` component, add a fourth tab value `"updates"`:

```tsx
<TabsList>
  <TabsTrigger value="brief">Brief</TabsTrigger>
  <TabsTrigger value="sources">线索</TabsTrigger>
  <TabsTrigger value="drafts">产出</TabsTrigger>
  <TabsTrigger value="updates">更新历史</TabsTrigger>
</TabsList>
```

Add the content panel:

```tsx
<TabsContent value="updates" className="mt-0">
  {updatesLoading ? (
    <p className="text-sm text-muted-foreground py-4 text-center">加载中…</p>
  ) : topicUpdates.length === 0 ? (
    <p className="text-sm text-muted-foreground py-4 text-center">暂无更新记录</p>
  ) : (
    <div className="space-y-3 py-2">
      {topicUpdates.map(u => (
        <div key={u.id} className="rounded-md border p-3 text-sm space-y-1">
          <p className="text-xs text-muted-foreground">
            {new Date(u.created_at).toLocaleString('zh-CN')}
          </p>
          <p>{u.description}</p>
          {u.source_url && (
            <a
              href={u.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-500 hover:underline break-all"
            >
              {u.source_url}
            </a>
          )}
        </div>
      ))}
    </div>
  )}
</TabsContent>
```

- [ ] **Step 9: Verify TypeScript build**

```bash
source ~/.zshrc && cd /workspace/projects/WeMediaStudio/wemedia-studio && npm run build 2>&1 | tail -30
```
Expected: Build succeeds or only pre-existing errors.

- [ ] **Step 10: Commit**

```bash
cd /workspace/projects/WeMediaStudio
git add wemedia-studio/app/topics/TopicsClient.tsx
git commit -m "feat(ui): add 分析文章 dialog and 更新历史 tab to topics page"
```

---

## Task 9: Final Integration Check

- [ ] **Step 1: Run all backend tests**

```bash
source ~/.zshrc && conda run -n wems pytest backend/tests/test_content_topics.py -v
```
Expected: All ~20 tests pass.

- [ ] **Step 2: Full frontend build**

```bash
source ~/.zshrc && cd /workspace/projects/WeMediaStudio/wemedia-studio && npm run build 2>&1 | grep -E "(error|Error|warn)" | grep -v "StudioClient" | head -20
```
Expected: No new errors beyond the pre-existing StudioClient issue.

- [ ] **Step 3: Commit spec and plan docs**

```bash
cd /workspace/projects/WeMediaStudio
git add docs/superpowers/specs/2026-05-28-content-to-topic-agent-design.md
git add docs/superpowers/plans/2026-05-28-content-to-topic-agent.md
git commit -m "docs: add content-to-topic agent spec and implementation plan"
```
