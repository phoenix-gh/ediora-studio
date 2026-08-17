# 选题库重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the topic library from a tree-folder system into a content-brief system with multi-tags, a markdown brief editor, linked drafts view, and one-click Hermes dispatch.

**Architecture:** Backend adds `TopicTag` + `ContentTopicTag` models and a `brief` text column on `ContentTopic`; router switches from tree-building to a flat list with tag-filter, plus tag CRUD, drafts list, and dispatch endpoints. Frontend replaces the tree+detail layout with a card-list + tag chips on the left, and a three-tab detail (Brief / 线索 / 产出) on the right.

**Tech Stack:** FastAPI + SQLAlchemy async, PostgreSQL (SQLite in tests), Next.js 15, shadcn/ui, Tailwind CSS, `HermesKanbanClient`

All `conda run -n wems` or `source ~/.zshrc` prefixes are needed when running commands in this project.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `backend/models.py` | Modify | Add `TopicTag`, `ContentTopicTag`; add `brief` to `ContentTopic` |
| `backend/database.py` | Modify | Add `ALTER TABLE` migration for `brief`; idempotent create of tag tables |
| `backend/schemas.py` | Modify | Add `TopicTagCreate/Out`, `ArticleDraftSummary`, `DispatchResponse`; update ContentTopic schemas |
| `backend/routers/content_topics.py` | Modify | Flat list + tag filter; tag CRUD; drafts endpoint; dispatch |
| `backend/tests/test_content_topics.py` | Create | Tag CRUD, flat list + filter, drafts list, dispatch (mocked Hermes) |
| `web/lib/api/content-topics.ts` | Modify | Update types; add tag/dispatch/drafts API functions |
| `web/app/topics/page.tsx` | Modify | Fetch topics + all tags; pass both to client |
| `web/app/topics/TopicsClient.tsx` | Modify | Full redesign: card list + tag filter + Brief/Sources/Drafts tabs |

---

## Task 1: Backend Models

**Files:**
- Modify: `backend/models.py`

- [ ] **Step 1: Add `brief` field and tag models**

Open `backend/models.py`. Find the `ContentTopic` class (around line 291) and add the `brief` field after `description`:

```python
class ContentTopic(Base):
    """User-managed content topics (flat, multi-tag)."""
    __tablename__ = "content_topics"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str] = mapped_column(Text, default="")  # kept for migration rollback
    brief: Mapped[str] = mapped_column(Text, default="")
    parent_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)  # kept, unused after migration
    priority: Mapped[int] = mapped_column(Integer, default=3)
    status: Mapped[str] = mapped_column(String, default="active", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)
```

Then add these two new models **after** `TopicSource` (which follows `ContentTopic`):

```python
class TopicTag(Base):
    """Tags for grouping content topics (replaces tree hierarchy)."""
    __tablename__ = "topic_tags"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    color: Mapped[str] = mapped_column(String, default="#6366f1")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class ContentTopicTag(Base):
    """Many-to-many join between ContentTopic and TopicTag."""
    __tablename__ = "content_topic_tags"

    topic_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tag_id: Mapped[int] = mapped_column(Integer, primary_key=True)
```

- [ ] **Step 2: Verify models load without errors**

```bash
source ~/.zshrc && conda run -n wems python -c "
import sys, os
os.environ['DATABASE_URL'] = 'sqlite+aiosqlite:///./tmp_check.db'
import models
print('TopicTag:', models.TopicTag.__tablename__)
print('ContentTopicTag:', models.ContentTopicTag.__tablename__)
print('ContentTopic has brief:', hasattr(models.ContentTopic, 'brief'))
" && rm -f tmp_check.db
```

Expected output:
```
TopicTag: topic_tags
ContentTopicTag: content_topic_tags
ContentTopic has brief: True
```

- [ ] **Step 3: Commit**

```bash
git add backend/models.py
git commit -m "feat(models): add TopicTag, ContentTopicTag; add brief to ContentTopic"
```

---

## Task 2: Database Migration

**Files:**
- Modify: `backend/database.py`

- [ ] **Step 1: Add migration statements to `init_db()`**

Open `backend/database.py`. After the existing `ALTER TABLE` blocks (before the end of `init_db()`), add:

```python
        # Topic library brief field (added in redesign; idempotent)
        await conn.execute(text(
            "ALTER TABLE content_topics ADD COLUMN IF NOT EXISTS brief TEXT NOT NULL DEFAULT ''"
        ))
        # Copy description → brief for existing rows that have no brief yet
        await conn.execute(text(
            "UPDATE content_topics SET brief = description WHERE brief = '' AND description <> ''"
        ))
        # Reset parent_id — tree hierarchy replaced by tag model
        await conn.execute(text(
            "UPDATE content_topics SET parent_id = NULL WHERE parent_id IS NOT NULL"
        ))
```

`topic_tags` and `content_topic_tags` are created automatically by `Base.metadata.create_all` (which runs just before these statements), so no `CREATE TABLE IF NOT EXISTS` is needed for them.

- [ ] **Step 2: Verify migration runs cleanly**

```bash
source ~/.zshrc && conda run -n wems python -c "
import asyncio, os
os.environ['DATABASE_URL'] = 'sqlite+aiosqlite:///./tmp_migrate.db'
import database, models
asyncio.run(database.init_db())
print('Migration OK')
" && rm -f tmp_migrate.db
```

Expected: `Migration OK` with no errors.

- [ ] **Step 3: Commit**

```bash
git add backend/database.py
git commit -m "feat(db): add brief migration and tag table creation"
```

---

## Task 3: Backend Schemas

**Files:**
- Modify: `backend/schemas.py`

- [ ] **Step 1: Replace the ContentTopic schema block**

Find the `# ── ContentTopic ──` section (around line 251) and replace everything from `class ContentTopicCreate` to `ContentTopicOut.model_rebuild()` with:

```python
# ── ContentTopic ──────────────────────────────────────────────────────────────

class TopicTagCreate(BaseModel):
    name: str


class TopicTagOut(BaseModel):
    id: int
    name: str
    color: str

    model_config = {"from_attributes": True}


class ContentTopicCreate(BaseModel):
    title: str
    brief: str = ""
    tags: list[str] = []
    priority: int = 3


class ContentTopicUpdate(BaseModel):
    title: Optional[str] = None
    brief: Optional[str] = None
    tags: Optional[list[str]] = None
    priority: Optional[int] = None
    status: Optional[str] = None


class TopicSourceCreate(BaseModel):
    topic_id: int
    url: str = ""
    title: str = ""
    content: str = ""
    note: str = ""
    platform: str = "manual"
    draft_id: Optional[int] = None


class TopicSourceOut(BaseModel):
    id: int
    topic_id: int
    url: str
    title: str
    content: str = ""
    note: str
    platform: str
    draft_id: Optional[int] = None
    created_at: datetime

    model_config = {"from_attributes": True}


class ContentTopicOut(BaseModel):
    id: int
    title: str
    brief: str
    description: str  # legacy field, kept for backwards compat
    priority: int
    status: str
    created_at: datetime
    updated_at: datetime
    tags: list[TopicTagOut] = []
    sources: list[TopicSourceOut] = []
    source_count: int = 0
    draft_count: int = 0

    model_config = {"from_attributes": True}


class ArticleDraftSummary(BaseModel):
    id: int
    title: str
    status: str
    draft_type: str
    created_at: datetime

    model_config = {"from_attributes": True}


class DispatchResponse(BaseModel):
    task_id: str
    kanban_url: str
```

- [ ] **Step 2: Verify schemas import cleanly**

```bash
source ~/.zshrc && conda run -n wems python -c "
from schemas import (ContentTopicCreate, ContentTopicUpdate, ContentTopicOut,
                     TopicTagCreate, TopicTagOut, ArticleDraftSummary, DispatchResponse)
print('All schemas OK')
"
```

Expected: `All schemas OK`

- [ ] **Step 3: Commit**

```bash
git add backend/schemas.py
git commit -m "feat(schemas): update ContentTopic schemas; add Tag, DraftSummary, DispatchResponse"
```

---

## Task 4: Router Rewrite

**Files:**
- Modify: `backend/routers/content_topics.py`

- [ ] **Step 1: Write the new router**

Replace the entire contents of `backend/routers/content_topics.py` with:

```python
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, delete, update as sa_update

from database import get_db
from models import ContentTopic, TopicSource, TopicTag, ContentTopicTag, ArticleDraft
from schemas import (
    ContentTopicCreate, ContentTopicUpdate, ContentTopicOut,
    TopicTagCreate, TopicTagOut,
    TopicSourceCreate, TopicSourceOut,
    ArticleDraftSummary, DispatchResponse,
)

router = APIRouter(prefix="/content-topics", tags=["content-topics"])

_TAG_COLORS = [
    "#6366f1", "#8b5cf6", "#ec4899", "#f59e0b",
    "#10b981", "#3b82f6", "#ef4444", "#14b8a6",
]


def _color_for_name(name: str) -> str:
    return _TAG_COLORS[sum(ord(c) for c in name) % len(_TAG_COLORS)]


async def _get_or_create_tag(db: AsyncSession, name: str) -> TopicTag:
    normalized = name.strip().lower()
    existing = (await db.execute(
        select(TopicTag).where(func.lower(TopicTag.name) == normalized)
    )).scalar_one_or_none()
    if existing:
        return existing
    tag = TopicTag(name=name.strip(), color=_color_for_name(name))
    db.add(tag)
    await db.flush()
    return tag


async def _set_topic_tags(db: AsyncSession, topic_id: int, tag_names: list[str]) -> None:
    await db.execute(
        delete(ContentTopicTag).where(ContentTopicTag.topic_id == topic_id)
    )
    for name in tag_names:
        if name.strip():
            tag = await _get_or_create_tag(db, name)
            db.add(ContentTopicTag(topic_id=topic_id, tag_id=tag.id))


async def _enrich_topics(db: AsyncSession, topics: list[ContentTopic]) -> list[ContentTopicOut]:
    if not topics:
        return []

    ids = [t.id for t in topics]

    tag_rows = (await db.execute(
        select(ContentTopicTag.topic_id, TopicTag)
        .join(TopicTag, ContentTopicTag.tag_id == TopicTag.id)
        .where(ContentTopicTag.topic_id.in_(ids))
        .order_by(TopicTag.name)
    )).all()
    tags_by_topic: dict[int, list] = {i: [] for i in ids}
    for topic_id, tag in tag_rows:
        tags_by_topic[topic_id].append(tag)

    source_rows = (await db.execute(
        select(TopicSource)
        .where(TopicSource.topic_id.in_(ids))
        .order_by(TopicSource.created_at.desc())
    )).scalars().all()
    sources_by_topic: dict[int, list] = {i: [] for i in ids}
    for s in source_rows:
        sources_by_topic[s.topic_id].append(s)

    draft_counts = (await db.execute(
        select(ArticleDraft.content_topic_id, func.count())
        .where(ArticleDraft.content_topic_id.in_(ids))
        .group_by(ArticleDraft.content_topic_id)
    )).all()
    dc_map = {row[0]: row[1] for row in draft_counts}

    result = []
    for t in topics:
        out = ContentTopicOut.model_validate(t)
        out.tags = [TopicTagOut.model_validate(tag) for tag in tags_by_topic[t.id]]
        out.sources = [TopicSourceOut.model_validate(s) for s in sources_by_topic[t.id]]
        out.source_count = len(sources_by_topic[t.id])
        out.draft_count = dc_map.get(t.id, 0)
        result.append(out)
    return result


# ── Tag endpoints (must be registered before /{topic_id} to avoid routing conflict) ──

@router.get("/tags", response_model=list[TopicTagOut])
async def list_tags(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(
        select(TopicTag).order_by(TopicTag.name)
    )).scalars().all()
    return rows


@router.post("/tags", response_model=TopicTagOut, status_code=201)
async def create_tag(body: TopicTagCreate, db: AsyncSession = Depends(get_db)):
    tag = await _get_or_create_tag(db, body.name)
    await db.commit()
    await db.refresh(tag)
    return tag


@router.delete("/tags/{tag_id}", status_code=204)
async def delete_tag(tag_id: int, db: AsyncSession = Depends(get_db)):
    tag = await db.get(TopicTag, tag_id)
    if not tag:
        raise HTTPException(404, "Tag not found")
    await db.execute(delete(ContentTopicTag).where(ContentTopicTag.tag_id == tag_id))
    await db.delete(tag)
    await db.commit()


# ── Topic endpoints ────────────────────────────────────────────────────────────

@router.get("", response_model=list[ContentTopicOut])
async def list_topics(tags: str | None = None, db: AsyncSession = Depends(get_db)):
    q = select(ContentTopic).order_by(ContentTopic.priority, ContentTopic.created_at.desc())

    if tags:
        tag_names = [t.strip().lower() for t in tags.split(",") if t.strip()]
        if tag_names:
            # OR filter: return topics that have ANY of the given tags
            q = q.where(
                ContentTopic.id.in_(
                    select(ContentTopicTag.topic_id)
                    .join(TopicTag, ContentTopicTag.tag_id == TopicTag.id)
                    .where(func.lower(TopicTag.name).in_(tag_names))
                )
            )

    rows = (await db.execute(q)).scalars().all()
    return await _enrich_topics(db, list(rows))


@router.post("", response_model=ContentTopicOut, status_code=201)
async def create_topic(body: ContentTopicCreate, db: AsyncSession = Depends(get_db)):
    obj = ContentTopic(
        title=body.title,
        brief=body.brief,
        priority=body.priority,
    )
    db.add(obj)
    await db.flush()
    await _set_topic_tags(db, obj.id, body.tags)
    await db.commit()
    await db.refresh(obj)
    return (await _enrich_topics(db, [obj]))[0]


@router.get("/{topic_id}", response_model=ContentTopicOut)
async def get_topic(topic_id: int, db: AsyncSession = Depends(get_db)):
    obj = await db.get(ContentTopic, topic_id)
    if not obj:
        raise HTTPException(404, "Topic not found")
    return (await _enrich_topics(db, [obj]))[0]


@router.patch("/{topic_id}", response_model=ContentTopicOut)
async def update_topic(topic_id: int, body: ContentTopicUpdate, db: AsyncSession = Depends(get_db)):
    obj = await db.get(ContentTopic, topic_id)
    if not obj:
        raise HTTPException(404, "Topic not found")
    for field, val in body.model_dump(exclude_none=True, exclude={"tags"}).items():
        setattr(obj, field, val)
    if body.tags is not None:
        await _set_topic_tags(db, obj.id, body.tags)
    await db.commit()
    await db.refresh(obj)
    return (await _enrich_topics(db, [obj]))[0]


@router.delete("/{topic_id}", status_code=204)
async def delete_topic(topic_id: int, db: AsyncSession = Depends(get_db)):
    obj = await db.get(ContentTopic, topic_id)
    if not obj:
        raise HTTPException(404, "Topic not found")
    # Detach drafts instead of deleting them
    await db.execute(
        sa_update(ArticleDraft)
        .where(ArticleDraft.content_topic_id == topic_id)
        .values(content_topic_id=None)
    )
    await db.execute(delete(ContentTopicTag).where(ContentTopicTag.topic_id == topic_id))
    await db.execute(delete(TopicSource).where(TopicSource.topic_id == topic_id))
    await db.delete(obj)
    await db.commit()


# ── Drafts list ───────────────────────────────────────────────────────────────

@router.get("/{topic_id}/drafts", response_model=list[ArticleDraftSummary])
async def list_topic_drafts(topic_id: int, db: AsyncSession = Depends(get_db)):
    obj = await db.get(ContentTopic, topic_id)
    if not obj:
        raise HTTPException(404, "Topic not found")
    rows = (await db.execute(
        select(ArticleDraft)
        .where(ArticleDraft.content_topic_id == topic_id)
        .order_by(ArticleDraft.created_at.desc())
    )).scalars().all()
    return rows


# ── Dispatch ──────────────────────────────────────────────────────────────────

@router.post("/{topic_id}/dispatch", response_model=DispatchResponse)
async def dispatch_topic(topic_id: int, db: AsyncSession = Depends(get_db)):
    obj = await db.get(ContentTopic, topic_id)
    if not obj:
        raise HTTPException(404, "Topic not found")
    if not obj.brief.strip():
        raise HTTPException(400, "Brief is empty — add a research brief before dispatching")

    from hermes_kanban_client import HermesKanbanClient, HermesKanbanError
    try:
        kanban = HermesKanbanClient()
        task_id = await kanban.create_task(
            title=f"[调研] {obj.title}",
            body=obj.brief,
            assignee="scout",
        )
    except HermesKanbanError as e:
        raise HTTPException(502, f"Hermes 不可用: {e}")

    return DispatchResponse(task_id=task_id, kanban_url="/studio")


# ── Sources (unchanged) ───────────────────────────────────────────────────────

@router.get("/{topic_id}/sources", response_model=list[TopicSourceOut])
async def list_sources(topic_id: int, db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(
        select(TopicSource).where(TopicSource.topic_id == topic_id)
        .order_by(TopicSource.created_at.desc())
    )).scalars().all()
    return rows


@router.post("/{topic_id}/sources", response_model=TopicSourceOut, status_code=201)
async def add_source(topic_id: int, body: TopicSourceCreate, db: AsyncSession = Depends(get_db)):
    obj = await db.get(ContentTopic, topic_id)
    if not obj:
        raise HTTPException(404, "Topic not found")
    source = TopicSource(**{**body.model_dump(), "topic_id": topic_id})
    db.add(source)

    if body.draft_id is not None:
        draft = await db.get(ArticleDraft, body.draft_id)
        if not draft:
            raise HTTPException(404, "Draft not found")
        existing = list(draft.sources or [])
        existing.append({"url": body.url, "title": body.title, "note": body.note})
        draft.sources = existing

    await db.commit()
    await db.refresh(source)
    return source


@router.delete("/{topic_id}/sources/{source_id}", status_code=204)
async def delete_source(topic_id: int, source_id: int, db: AsyncSession = Depends(get_db)):
    obj = await db.get(TopicSource, source_id)
    if not obj or obj.topic_id != topic_id:
        raise HTTPException(404, "Source not found")
    await db.delete(obj)
    await db.commit()


@router.post("/sources/quick-save", response_model=TopicSourceOut, status_code=201)
async def quick_save_source(body: TopicSourceCreate, db: AsyncSession = Depends(get_db)):
    obj = await db.get(ContentTopic, body.topic_id)
    if not obj:
        raise HTTPException(404, "Topic not found")
    source = TopicSource(**body.model_dump())
    db.add(source)
    await db.commit()
    await db.refresh(source)
    return source
```

- [ ] **Step 2: Verify the router imports cleanly**

```bash
source ~/.zshrc && conda run -n wems python -c "
import sys, os
os.environ['DATABASE_URL'] = 'sqlite+aiosqlite:///./tmp_check.db'
import models  # ensure models loaded
from routers.content_topics import router
print('Router OK, routes:', [r.path for r in router.routes])
" && rm -f tmp_check.db
```

Expected: prints list of route paths including `/tags`, `/{topic_id}/drafts`, `/{topic_id}/dispatch`.

- [ ] **Step 3: Commit**

```bash
git add backend/routers/content_topics.py
git commit -m "feat(router): rewrite content_topics — flat list, tags, drafts, dispatch"
```

---

## Task 5: Backend Tests

**Files:**
- Create: `backend/tests/test_content_topics.py`

- [ ] **Step 1: Write the test file**

Create `backend/tests/test_content_topics.py`:

```python
import sys
import asyncio
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch, tmp_path):
    db_file = tmp_path / "test.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite+aiosqlite:///{db_file}")
    monkeypatch.setenv("DISABLE_SCHEDULER", "1")

    for mod in list(sys.modules):
        if mod.startswith(("database", "models", "main", "routers", "config",
                            "schemas", "hermes_kanban_client")):
            sys.modules.pop(mod, None)

    from database import engine, Base
    import models  # noqa: F401

    async def _create():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    asyncio.new_event_loop().run_until_complete(_create())

    from main import app
    return TestClient(app)


# ── Tag CRUD ──────────────────────────────────────────────────────────────────

def test_create_tag(client):
    r = client.post("/api/content-topics/tags", json={"name": "AI"})
    assert r.status_code == 201
    data = r.json()
    assert data["name"] == "AI"
    assert data["color"].startswith("#")
    assert "id" in data


def test_create_tag_duplicate_case_insensitive(client):
    r1 = client.post("/api/content-topics/tags", json={"name": "AI"})
    assert r1.status_code == 201
    r2 = client.post("/api/content-topics/tags", json={"name": "ai"})
    assert r2.status_code == 201
    assert r1.json()["id"] == r2.json()["id"]


def test_list_tags(client):
    client.post("/api/content-topics/tags", json={"name": "创业"})
    client.post("/api/content-topics/tags", json={"name": "AI"})
    r = client.get("/api/content-topics/tags")
    assert r.status_code == 200
    names = [t["name"] for t in r.json()]
    assert "AI" in names
    assert "创业" in names


def test_delete_tag_removes_associations(client):
    tag_r = client.post("/api/content-topics/tags", json={"name": "TechTag"})
    tag_id = tag_r.json()["id"]
    topic_r = client.post("/api/content-topics", json={"title": "测试选题", "tags": ["TechTag"]})
    topic_id = topic_r.json()["id"]

    del_r = client.delete(f"/api/content-topics/tags/{tag_id}")
    assert del_r.status_code == 204

    # Topic still exists, but has no tags
    get_r = client.get(f"/api/content-topics/{topic_id}")
    assert get_r.status_code == 200
    assert get_r.json()["tags"] == []


# ── Topic CRUD ────────────────────────────────────────────────────────────────

def test_create_topic_with_tags(client):
    r = client.post("/api/content-topics", json={
        "title": "AI 一人公司",
        "brief": "调研 AI 创业案例",
        "tags": ["AI", "创业"],
        "priority": 1,
    })
    assert r.status_code == 201
    data = r.json()
    assert data["title"] == "AI 一人公司"
    assert data["brief"] == "调研 AI 创业案例"
    assert len(data["tags"]) == 2
    tag_names = {t["name"] for t in data["tags"]}
    assert tag_names == {"AI", "创业"}


def test_list_topics_flat(client):
    client.post("/api/content-topics", json={"title": "选题A", "tags": ["AI"]})
    client.post("/api/content-topics", json={"title": "选题B", "tags": ["创业"]})
    r = client.get("/api/content-topics")
    assert r.status_code == 200
    titles = {t["title"] for t in r.json()}
    assert "选题A" in titles
    assert "选题B" in titles


def test_list_topics_filter_by_tag(client):
    client.post("/api/content-topics", json={"title": "AI选题", "tags": ["AI"]})
    client.post("/api/content-topics", json={"title": "创业选题", "tags": ["创业"]})
    r = client.get("/api/content-topics?tags=AI")
    assert r.status_code == 200
    titles = [t["title"] for t in r.json()]
    assert "AI选题" in titles
    assert "创业选题" not in titles


def test_list_topics_filter_multi_tag_or_logic(client):
    client.post("/api/content-topics", json={"title": "AI选题", "tags": ["AI"]})
    client.post("/api/content-topics", json={"title": "创业选题", "tags": ["创业"]})
    client.post("/api/content-topics", json={"title": "其他选题", "tags": ["其他"]})
    r = client.get("/api/content-topics?tags=AI,创业")
    assert r.status_code == 200
    titles = {t["title"] for t in r.json()}
    assert "AI选题" in titles
    assert "创业选题" in titles
    assert "其他选题" not in titles


def test_update_topic_tags(client):
    r = client.post("/api/content-topics", json={"title": "选题", "tags": ["AI"]})
    topic_id = r.json()["id"]
    patch_r = client.patch(f"/api/content-topics/{topic_id}", json={"tags": ["创业", "产品"]})
    assert patch_r.status_code == 200
    tag_names = {t["name"] for t in patch_r.json()["tags"]}
    assert tag_names == {"创业", "产品"}


def test_delete_topic_detaches_sources(client):
    r = client.post("/api/content-topics", json={"title": "选题", "tags": []})
    topic_id = r.json()["id"]
    client.post(f"/api/content-topics/{topic_id}/sources", json={
        "topic_id": topic_id, "url": "https://example.com", "title": "来源"
    })
    del_r = client.delete(f"/api/content-topics/{topic_id}")
    assert del_r.status_code == 204
    get_r = client.get(f"/api/content-topics/{topic_id}")
    assert get_r.status_code == 404


# ── Drafts list ───────────────────────────────────────────────────────────────

def test_list_topic_drafts_empty(client):
    r = client.post("/api/content-topics", json={"title": "选题", "tags": []})
    topic_id = r.json()["id"]
    dr = client.get(f"/api/content-topics/{topic_id}/drafts")
    assert dr.status_code == 200
    assert dr.json() == []


def test_list_topic_drafts_returns_linked_drafts(client):
    from database import SessionLocal
    from models import ArticleDraft
    import asyncio

    topic_r = client.post("/api/content-topics", json={"title": "选题", "tags": []})
    topic_id = topic_r.json()["id"]

    async def _seed_draft():
        async with SessionLocal() as db:
            d = ArticleDraft(
                topic_id="manual",
                content_topic_id=topic_id,
                title="草稿标题",
                draft_type="article",
                status="drafting",
            )
            db.add(d)
            await db.commit()
            return d.id

    draft_id = asyncio.new_event_loop().run_until_complete(_seed_draft())
    dr = client.get(f"/api/content-topics/{topic_id}/drafts")
    assert dr.status_code == 200
    assert len(dr.json()) == 1
    assert dr.json()[0]["id"] == draft_id
    assert dr.json()[0]["title"] == "草稿标题"


# ── Dispatch ──────────────────────────────────────────────────────────────────

def test_dispatch_empty_brief_returns_400(client):
    r = client.post("/api/content-topics", json={"title": "选题", "brief": "", "tags": []})
    topic_id = r.json()["id"]
    dr = client.post(f"/api/content-topics/{topic_id}/dispatch")
    assert dr.status_code == 400
    assert "empty" in dr.json()["detail"].lower() or "Brief" in dr.json()["detail"]


def test_dispatch_creates_hermes_task(client, monkeypatch):
    import routers.content_topics as ct_router

    async def _mock_create_task(self, *, title, body, assignee, parents=None):
        assert "[调研]" in title
        assert body.strip() != ""
        assert assignee == "scout"
        return "mock-task-123"

    from hermes_kanban_client import HermesKanbanClient
    monkeypatch.setattr(HermesKanbanClient, "create_task", _mock_create_task)

    r = client.post("/api/content-topics", json={
        "title": "AI 案例调研",
        "brief": "## 调研主题\nAI 一人公司成功案例",
        "tags": [],
    })
    topic_id = r.json()["id"]
    dr = client.post(f"/api/content-topics/{topic_id}/dispatch")
    assert dr.status_code == 200
    data = dr.json()
    assert data["task_id"] == "mock-task-123"
    assert data["kanban_url"] == "/studio"
```

- [ ] **Step 2: Run the tests**

```bash
source ~/.zshrc && cd backend && conda run -n wems pytest tests/test_content_topics.py -v 2>&1 | tail -40
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add backend/tests/test_content_topics.py
git commit -m "test(content_topics): add tag CRUD, flat list, drafts, dispatch tests"
```

---

## Task 6: Frontend API Layer

**Files:**
- Modify: `web/lib/api/content-topics.ts`

- [ ] **Step 1: Replace the file contents**

```typescript
import { apiFetch } from './client'

export interface TopicTag {
  id: number
  name: string
  color: string
}

export interface TopicSource {
  id: number
  topic_id: number
  url: string
  title: string
  content: string
  note: string
  platform: string
  draft_id: number | null
  created_at: string
}

export interface ContentTopic {
  id: number
  title: string
  brief: string
  description: string
  priority: number
  status: string
  created_at: string
  updated_at: string
  tags: TopicTag[]
  sources: TopicSource[]
  source_count: number
  draft_count: number
}

export interface ContentTopicCreate {
  title: string
  brief?: string
  tags?: string[]
  priority?: number
}

export interface ContentTopicUpdate {
  title?: string
  brief?: string
  tags?: string[]
  priority?: number
  status?: string
}

export interface TopicSourceCreate {
  topic_id: number
  url?: string
  title?: string
  content?: string
  note?: string
  platform?: string
  draft_id?: number | null
}

export interface DraftSummary {
  id: number
  title: string
  status: string
  draft_type: string
  created_at: string
}

export interface DispatchResult {
  task_id: string
  kanban_url: string
}

export const PLATFORMS = [
  { value: 'x',      label: 'X / Twitter' },
  { value: 'github', label: 'GitHub' },
  { value: 'wechat', label: '微信公众号' },
  { value: 'manual', label: '手动录入' },
  { value: 'self',   label: '自己发布' },
]

export async function getTopics(tags?: string[]): Promise<ContentTopic[]> {
  const params = tags?.length ? `?tags=${tags.join(',')}` : ''
  return apiFetch<ContentTopic[]>(`/content-topics${params}`)
}

export async function getTags(): Promise<TopicTag[]> {
  return apiFetch<TopicTag[]>('/content-topics/tags')
}

export async function createTag(name: string): Promise<TopicTag> {
  return apiFetch<TopicTag>('/content-topics/tags', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
}

export async function deleteTag(id: number): Promise<void> {
  await apiFetch(`/content-topics/tags/${id}`, { method: 'DELETE' })
}

export async function createTopic(body: ContentTopicCreate): Promise<ContentTopic> {
  return apiFetch<ContentTopic>('/content-topics', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function updateTopic(id: number, body: ContentTopicUpdate): Promise<ContentTopic> {
  return apiFetch<ContentTopic>(`/content-topics/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export async function deleteTopic(id: number): Promise<void> {
  await apiFetch(`/content-topics/${id}`, { method: 'DELETE' })
}

export async function getTopicDrafts(topicId: number): Promise<DraftSummary[]> {
  return apiFetch<DraftSummary[]>(`/content-topics/${topicId}/drafts`)
}

export async function dispatchTopic(topicId: number): Promise<DispatchResult> {
  return apiFetch<DispatchResult>(`/content-topics/${topicId}/dispatch`, {
    method: 'POST',
  })
}

export async function addSource(topicId: number, body: Omit<TopicSourceCreate, 'topic_id'>): Promise<TopicSource> {
  return apiFetch<TopicSource>(`/content-topics/${topicId}/sources`, {
    method: 'POST',
    body: JSON.stringify({ ...body, topic_id: topicId }),
  })
}

export async function deleteSource(topicId: number, sourceId: number): Promise<void> {
  await apiFetch(`/content-topics/${topicId}/sources/${sourceId}`, { method: 'DELETE' })
}
```

- [ ] **Step 2: Commit**

```bash
git add web/lib/api/content-topics.ts
git commit -m "feat(frontend): update content-topics API types and add tag/dispatch/drafts functions"
```

---

## Task 7: Frontend Page + UI Redesign

**Files:**
- Modify: `web/app/topics/page.tsx`
- Modify: `web/app/topics/TopicsClient.tsx`

- [ ] **Step 1: Update `page.tsx` to fetch topics and tags**

Replace `web/app/topics/page.tsx` with:

```tsx
import { getTopics, getTags } from '@/lib/api/content-topics'
import { TopicsClient } from './TopicsClient'

export const dynamic = 'force-dynamic'

export default async function TopicsPage() {
  const [topics, allTags] = await Promise.all([getTopics(), getTags()])
  return <TopicsClient initialTopics={topics} initialTags={allTags} />
}
```

- [ ] **Step 2: Rewrite `TopicsClient.tsx`**

Replace the entire contents of `web/app/topics/TopicsClient.tsx` with:

```tsx
'use client'

import { useState, useEffect, useRef, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import {
  Plus, Trash2, Pencil, Check, X, RefreshCw,
  BookMarked, Loader2, Tag, FileText, PenLine,
  Link2, ExternalLink, SendHorizonal, Rocket,
} from 'lucide-react'
import { marked } from 'marked'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  ContentTopic, TopicTag, TopicSource, DraftSummary,
  getTopics, getTags, createTopic, updateTopic, deleteTopic,
  addSource, deleteSource, getTopicDrafts, dispatchTopic, createTag,
  PLATFORMS,
} from '@/lib/api/content-topics'
import { createDraft } from '@/lib/api/drafts'
import { PushToStudioPopover } from '@/components/features/PushToStudioPopover'

marked.setOptions({ breaks: true, gfm: true })

const PRIORITY_LABELS: Record<number, { label: string; cls: string }> = {
  1: { label: 'P1', cls: 'bg-red-100 text-red-600 dark:bg-red-950/40 dark:text-red-400' },
  2: { label: 'P2', cls: 'bg-orange-100 text-orange-600 dark:bg-orange-950/40 dark:text-orange-400' },
  3: { label: 'P3', cls: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400' },
  4: { label: 'P4', cls: 'bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500' },
  5: { label: 'P5', cls: 'bg-zinc-100 text-zinc-300 dark:bg-zinc-800 dark:text-zinc-600' },
}

function formatDate(iso: string) {
  const d = new Date(iso)
  const now = new Date()
  const diff = (now.getTime() - d.getTime()) / 1000
  if (diff < 3600) return `${Math.floor(diff / 60) || 1} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

function platformLabel(p: string) {
  return PLATFORMS.find(x => x.value === p)?.label ?? p
}

// ── Tag chip ──────────────────────────────────────────────────────────────────

function TagChip({ tag, onRemove }: { tag: TopicTag; onRemove?: () => void }) {
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full font-medium"
      style={{ backgroundColor: tag.color + '22', color: tag.color }}
    >
      {tag.name}
      {onRemove && (
        <button onClick={onRemove} className="hover:opacity-70 leading-none">×</button>
      )}
    </span>
  )
}

// ── Source row (unchanged from original) ──────────────────────────────────────

function SourceRow({ source, onDelete, onPreview, onCreateDraft, isActive, creating }: {
  source: TopicSource
  onDelete: () => void
  onPreview: (s: TopicSource) => void
  onCreateDraft: (s: TopicSource, type: string) => void
  isActive: boolean
  creating: string | false
}) {
  return (
    <div
      onClick={() => onPreview(source)}
      className={cn(
        'flex items-start gap-3 px-4 py-3 border-b border-zinc-100 dark:border-zinc-800 group transition-colors cursor-pointer',
        isActive ? 'bg-indigo-50/60 dark:bg-indigo-950/20' : 'hover:bg-zinc-50 dark:hover:bg-zinc-900/50'
      )}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400">
            {platformLabel(source.platform)}
          </span>
          <span className="text-[10px] text-zinc-400">{formatDate(source.created_at)}</span>
          {source.content && <FileText className="w-3 h-3 text-zinc-300 dark:text-zinc-600 ml-auto flex-shrink-0" />}
        </div>
        {source.title && <p className="text-xs font-medium text-zinc-800 dark:text-zinc-200 truncate">{source.title}</p>}
        {source.note && <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-0.5 italic">{source.note}</p>}
      </div>
      <div className="flex items-center gap-0.5 flex-shrink-0">
        {source.url && source.title && (
          <div onClick={e => e.stopPropagation()} className="opacity-0 group-hover:opacity-100 transition-opacity">
            <PushToStudioPopover url={source.url} title={source.title} content={source.content || ''} platform={source.platform} summary={source.note || ''} className="w-6 h-6" />
          </div>
        )}
        <button
          onClick={e => { e.stopPropagation(); onCreateDraft(source, 'article') }}
          disabled={!!creating}
          className="opacity-0 group-hover:opacity-100 transition-opacity disabled:cursor-wait text-zinc-400 hover:text-indigo-500 dark:hover:text-indigo-400 p-0.5"
          title="创作文章"
        >
          {creating === 'article' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PenLine className="w-3.5 h-3.5" />}
        </button>
        <button
          onClick={e => { e.stopPropagation(); onDelete() }}
          className="opacity-0 group-hover:opacity-100 transition-opacity text-zinc-300 hover:text-red-500 dark:text-zinc-600 dark:hover:text-red-400 p-0.5"
          title="删除"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
    </div>
  )
}

// ── Source preview panel ──────────────────────────────────────────────────────

function SourcePreview({ source, onClose }: { source: TopicSource; onClose: () => void }) {
  const html = useMemo(() => marked(source.content || '') as string, [source.content])
  return (
    <div className="w-96 flex-shrink-0 border-l border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-100 dark:border-zinc-800 flex-shrink-0">
        <FileText className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />
        <span className="flex-1 text-xs font-semibold text-zinc-700 dark:text-zinc-300 truncate">{source.title || '原文预览'}</span>
        {source.url && (
          <a href={source.url} target="_blank" rel="noopener noreferrer" className="text-zinc-400 hover:text-indigo-500 flex-shrink-0">
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        )}
        <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 flex-shrink-0">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-5 py-4">
        <div
          className="prose prose-sm dark:prose-invert max-w-none prose-headings:font-semibold prose-p:text-zinc-700 dark:prose-p:text-zinc-300 prose-p:leading-relaxed prose-a:text-indigo-500 prose-a:no-underline hover:prose-a:underline prose-code:text-pink-500 prose-code:bg-zinc-100 dark:prose-code:bg-zinc-800 prose-code:px-1 prose-code:rounded prose-pre:bg-zinc-100 dark:prose-pre:bg-zinc-900 prose-pre:rounded-lg prose-strong:text-zinc-900 dark:prose-strong:text-zinc-100"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

interface AddSourceForm {
  url: string; title: string; content: string; note: string; platform: string
}

type ActiveTab = 'brief' | 'sources' | 'drafts'

export function TopicsClient({ initialTopics, initialTags }: {
  initialTopics: ContentTopic[]
  initialTags: TopicTag[]
}) {
  const router = useRouter()
  const [topics, setTopics] = useState<ContentTopic[]>(initialTopics)
  const [allTags, setAllTags] = useState<TopicTag[]>(initialTags)
  const [selected, setSelected] = useState<ContentTopic | null>(initialTopics[0] ?? null)
  const [filterTagNames, setFilterTagNames] = useState<string[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [activeTab, setActiveTab] = useState<ActiveTab>('brief')
  const [refreshing, setRefreshing] = useState(false)

  // Brief editing
  const [briefDraft, setBriefDraft] = useState('')
  const [savingBrief, setSavingBrief] = useState(false)
  const [dispatching, setDispatching] = useState(false)
  const [showDispatchConfirm, setShowDispatchConfirm] = useState(false)
  const [dispatchBrief, setDispatchBrief] = useState('')

  // Title editing
  const [editingTitle, setEditingTitle] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const [editPriority, setEditPriority] = useState(3)
  const [savingMeta, setSavingMeta] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)

  // New topic
  const [showNewForm, setShowNewForm] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newPriority, setNewPriority] = useState(3)
  const [creating, setCreating] = useState(false)
  const newTitleRef = useRef<HTMLInputElement>(null)

  // Tag editing on selected topic
  const [tagInput, setTagInput] = useState('')
  const tagInputRef = useRef<HTMLInputElement>(null)

  // Source form
  const [showSourceForm, setShowSourceForm] = useState(false)
  const [sourceForm, setSourceForm] = useState<AddSourceForm>({ url: '', title: '', content: '', note: '', platform: 'manual' })
  const [addingSource, setAddingSource] = useState(false)
  const [previewSource, setPreviewSource] = useState<TopicSource | null>(null)
  const [creatingDraft, setCreatingDraft] = useState<{ id: number; type: string } | null>(null)

  // Drafts tab
  const [drafts, setDrafts] = useState<DraftSummary[]>([])
  const [loadingDrafts, setLoadingDrafts] = useState(false)

  // Deleting
  const [deleting, setDeleting] = useState(false)

  // Sync selected topic when topics list refreshes
  useEffect(() => {
    if (!selected) return
    const fresh = topics.find(t => t.id === selected.id)
    if (fresh) setSelected(fresh)
  }, [topics])

  // Sync brief draft when topic changes
  useEffect(() => {
    setBriefDraft(selected?.brief ?? '')
  }, [selected?.id])

  useEffect(() => {
    if (editingTitle) titleRef.current?.focus()
  }, [editingTitle])

  useEffect(() => {
    if (showNewForm) newTitleRef.current?.focus()
  }, [showNewForm])

  // Load drafts when tab switches to 'drafts'
  useEffect(() => {
    if (activeTab !== 'drafts' || !selected) return
    setLoadingDrafts(true)
    getTopicDrafts(selected.id)
      .then(setDrafts)
      .catch(() => toast.error('加载产出失败'))
      .finally(() => setLoadingDrafts(false))
  }, [activeTab, selected?.id])

  // Derived: visible topics after search + tag filter
  const visibleTopics = useMemo(() => {
    let list = topics
    if (filterTagNames.length > 0) {
      list = list.filter(t =>
        filterTagNames.some(name => t.tags.some(tag => tag.name === name))
      )
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      list = list.filter(t =>
        t.title.toLowerCase().includes(q) || t.brief.toLowerCase().includes(q)
      )
    }
    return list
  }, [topics, filterTagNames, searchQuery])

  // Derived: unique tags across all topics + allTags
  const availableTags = useMemo(() => {
    const byName = new Map<string, TopicTag>()
    allTags.forEach(t => byName.set(t.name, t))
    topics.forEach(topic => topic.tags.forEach(tag => byName.set(tag.name, tag)))
    return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name))
  }, [topics, allTags])

  async function handleRefresh() {
    setRefreshing(true)
    try {
      const [freshTopics, freshTags] = await Promise.all([getTopics(), getTags()])
      setTopics(freshTopics)
      setAllTags(freshTags)
    } catch { toast.error('刷新失败') }
    finally { setRefreshing(false) }
  }

  function toggleFilterTag(name: string) {
    setFilterTagNames(prev =>
      prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]
    )
  }

  function handleSelectTopic(t: ContentTopic) {
    setSelected(t)
    setPreviewSource(null)
    setActiveTab('brief')
  }

  // ── Title / meta editing ─────────────────────────────────────────

  function openEdit() {
    if (!selected) return
    setEditTitle(selected.title)
    setEditPriority(selected.priority)
    setEditingTitle(true)
  }

  async function handleSaveMeta() {
    if (!selected) return
    setSavingMeta(true)
    try {
      const updated = await updateTopic(selected.id, {
        title: editTitle.trim() || selected.title,
        priority: editPriority,
      })
      replaceInList(updated)
      setEditingTitle(false)
    } catch { toast.error('保存失败') }
    finally { setSavingMeta(false) }
  }

  // ── Tag editing on selected topic ────────────────────────────────

  async function handleAddTagToTopic(name: string) {
    if (!selected || !name.trim()) return
    const newNames = [...selected.tags.map(t => t.name), name.trim()]
    try {
      const updated = await updateTopic(selected.id, { tags: newNames })
      replaceInList(updated)
      // Refresh allTags in case new tag was created
      getTags().then(setAllTags).catch(() => {})
    } catch { toast.error('添加标签失败') }
    setTagInput('')
  }

  async function handleRemoveTagFromTopic(tagName: string) {
    if (!selected) return
    const newNames = selected.tags.filter(t => t.name !== tagName).map(t => t.name)
    try {
      const updated = await updateTopic(selected.id, { tags: newNames })
      replaceInList(updated)
    } catch { toast.error('移除标签失败') }
  }

  // ── Brief ────────────────────────────────────────────────────────

  async function handleSaveBrief() {
    if (!selected) return
    setSavingBrief(true)
    try {
      const updated = await updateTopic(selected.id, { brief: briefDraft })
      replaceInList(updated)
      toast.success('已保存')
    } catch { toast.error('保存失败') }
    finally { setSavingBrief(false) }
  }

  function openDispatchConfirm() {
    setDispatchBrief(briefDraft)
    setShowDispatchConfirm(true)
  }

  async function handleDispatch() {
    if (!selected) return
    // Save dispatchBrief (modal may differ from briefDraft if user edited it in the modal)
    if (dispatchBrief !== selected.brief) {
      try {
        const updated = await updateTopic(selected.id, { brief: dispatchBrief })
        replaceInList(updated)
        setBriefDraft(dispatchBrief)  // keep briefDraft in sync
      } catch { toast.error('保存 brief 失败'); return }
    }
    setDispatching(true)
    try {
      const result = await dispatchTopic(selected.id)
      setShowDispatchConfirm(false)
      toast.success('已派发给 Agent', {
        action: { label: '查看看板', onClick: () => router.push(result.kanban_url) },
      })
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : '派发失败')
    } finally { setDispatching(false) }
  }

  // ── Archive / Delete ─────────────────────────────────────────────

  async function handleArchive() {
    if (!selected) return
    try {
      const updated = await updateTopic(selected.id, {
        status: selected.status === 'archived' ? 'active' : 'archived',
      })
      replaceInList(updated)
    } catch { toast.error('操作失败') }
  }

  async function handleDelete() {
    if (!selected) return
    if (!confirm(`确定删除「${selected.title}」及其所有线索？`)) return
    setDeleting(true)
    try {
      await deleteTopic(selected.id)
      const fresh = await getTopics()
      setTopics(fresh)
      setSelected(fresh[0] ?? null)
    } catch { toast.error('删除失败') }
    finally { setDeleting(false) }
  }

  // ── New topic ────────────────────────────────────────────────────

  async function handleCreate() {
    const title = newTitle.trim()
    if (!title) return
    setCreating(true)
    try {
      await createTopic({ title, priority: newPriority, tags: [] })
      const fresh = await getTopics()
      setTopics(fresh)
      setSelected(fresh.find(t => t.title === title) ?? fresh[0])
      setShowNewForm(false)
      setNewTitle('')
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : '创建失败')
    } finally { setCreating(false) }
  }

  // ── Sources ──────────────────────────────────────────────────────

  async function handleAddSource() {
    if (!selected) return
    setAddingSource(true)
    try {
      const src = await addSource(selected.id, {
        url: sourceForm.url.trim(),
        title: sourceForm.title.trim(),
        content: sourceForm.content.trim(),
        note: sourceForm.note.trim(),
        platform: sourceForm.platform,
      })
      setSelected(prev => prev ? { ...prev, sources: [src, ...prev.sources], source_count: prev.source_count + 1 } : prev)
      setSourceForm({ url: '', title: '', content: '', note: '', platform: 'manual' })
      setShowSourceForm(false)
      toast.success('线索已添加')
    } catch { toast.error('添加失败') }
    finally { setAddingSource(false) }
  }

  async function handleDeleteSource(source: TopicSource) {
    if (!selected) return
    try {
      await deleteSource(selected.id, source.id)
      setSelected(prev => prev ? {
        ...prev,
        sources: prev.sources.filter(s => s.id !== source.id),
        source_count: prev.source_count - 1,
      } : prev)
      if (previewSource?.id === source.id) setPreviewSource(null)
    } catch { toast.error('删除失败') }
  }

  async function handleCreateDraft(source: TopicSource, draftType = 'article') {
    setCreatingDraft({ id: source.id, type: draftType })
    try {
      const draft = await createDraft({
        topic_id: 'manual',
        title: source.title || '',
        content: source.content || '',
        draft_type: draftType,
        content_topic_id: selected?.id ?? null,
        sources: source.url ? [{ url: source.url, title: source.title, note: source.note }] : [],
      })
      router.push(`/drafts?draft=${draft.id}&chat=1`)
    } catch { toast.error('创建草稿失败') }
    finally { setCreatingDraft(null) }
  }

  // ── Helpers ──────────────────────────────────────────────────────

  function replaceInList(updated: ContentTopic) {
    setTopics(prev => prev.map(t => t.id === updated.id ? updated : t))
    if (selected?.id === updated.id) setSelected(updated)
  }

  // ── Render ───────────────────────────────────────────────────────

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── Left: tag filter + card list ─────────────────────────── */}
      <aside className="w-72 flex-shrink-0 border-r border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 flex flex-col">
        {/* Header */}
        <div className="px-4 py-4 border-b border-zinc-100 dark:border-zinc-800 space-y-3">
          <div className="flex items-center gap-2">
            <Tag className="w-4 h-4 text-indigo-500" />
            <span className="font-semibold text-sm text-zinc-900 dark:text-zinc-100">选题库</span>
            <div className="ml-auto flex items-center gap-1">
              <button onClick={handleRefresh} disabled={refreshing} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 disabled:opacity-40">
                <RefreshCw className={cn('w-3.5 h-3.5', refreshing && 'animate-spin')} />
              </button>
              <button onClick={() => setShowNewForm(true)} className="text-zinc-400 hover:text-indigo-500 transition-colors">
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
          {/* Search */}
          <input
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="搜索选题…"
            className="w-full text-xs px-2.5 py-1.5 border border-zinc-200 dark:border-zinc-700 rounded-lg bg-transparent outline-none focus:border-indigo-400 text-zinc-700 dark:text-zinc-300 placeholder:text-zinc-400"
          />
          {/* Tag filter chips */}
          {availableTags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {availableTags.map(tag => (
                <button
                  key={tag.id}
                  onClick={() => toggleFilterTag(tag.name)}
                  className={cn(
                    'text-[10px] px-2 py-0.5 rounded-full font-medium transition-all border',
                    filterTagNames.includes(tag.name)
                      ? 'border-transparent'
                      : 'border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400 hover:border-zinc-300'
                  )}
                  style={filterTagNames.includes(tag.name) ? {
                    backgroundColor: tag.color + '33',
                    color: tag.color,
                    borderColor: tag.color + '66',
                  } : {}}
                >
                  {tag.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Card list */}
        <div className="flex-1 overflow-y-auto py-2 px-2 space-y-1">
          {visibleTopics.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-zinc-400 gap-2">
              <BookMarked className="w-8 h-8 opacity-20" />
              <p className="text-xs">暂无选题</p>
              <button onClick={() => setShowNewForm(true)} className="text-xs text-indigo-500 hover:underline">新建选题</button>
            </div>
          ) : (
            visibleTopics.map(t => {
              const p = PRIORITY_LABELS[t.priority] ?? PRIORITY_LABELS[3]
              const isSelected = selected?.id === t.id
              return (
                <div
                  key={t.id}
                  onClick={() => handleSelectTopic(t)}
                  className={cn(
                    'px-3 py-2.5 rounded-lg cursor-pointer transition-colors border',
                    isSelected
                      ? 'bg-indigo-50 dark:bg-indigo-950/30 border-indigo-200 dark:border-indigo-800'
                      : 'bg-white dark:bg-zinc-950 border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900'
                  )}
                >
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className={cn('text-[9px] px-1.5 py-0.5 rounded font-bold flex-shrink-0', p.cls)}>{p.label}</span>
                    <span className="text-xs font-medium text-zinc-800 dark:text-zinc-200 truncate flex-1">{t.title}</span>
                    {t.status === 'archived' && (
                      <span className="text-[9px] text-zinc-400">归档</span>
                    )}
                  </div>
                  {t.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-1">
                      {t.tags.slice(0, 3).map(tag => (
                        <TagChip key={tag.id} tag={tag} />
                      ))}
                      {t.tags.length > 3 && (
                        <span className="text-[10px] text-zinc-400">+{t.tags.length - 3}</span>
                      )}
                    </div>
                  )}
                  {t.brief && (
                    <p className="text-[11px] text-zinc-400 dark:text-zinc-500 line-clamp-2 leading-relaxed">{t.brief.slice(0, 100)}</p>
                  )}
                  <div className="flex items-center gap-2 mt-1.5">
                    {t.source_count > 0 && (
                      <span className="text-[10px] text-zinc-400"><span className="font-medium text-zinc-600 dark:text-zinc-400">{t.source_count}</span> 条线索</span>
                    )}
                    {t.draft_count > 0 && (
                      <span className="text-[10px] text-zinc-400"><span className="font-medium text-zinc-600 dark:text-zinc-400">{t.draft_count}</span> 篇产出</span>
                    )}
                  </div>
                </div>
              )
            })
          )}
        </div>
      </aside>

      {/* ── Right: detail ─────────────────────────────────────────── */}
      {selected ? (
        <div className="flex-1 flex flex-col overflow-hidden bg-white dark:bg-zinc-950">
          {/* Header */}
          <div className="flex items-start gap-3 px-6 py-4 border-b border-zinc-100 dark:border-zinc-800 flex-shrink-0">
            {editingTitle ? (
              <div className="flex-1 flex items-start gap-2">
                <div className="flex-1 space-y-2">
                  <input
                    ref={titleRef}
                    value={editTitle}
                    onChange={e => setEditTitle(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleSaveMeta(); if (e.key === 'Escape') setEditingTitle(false) }}
                    className="w-full text-lg font-bold bg-transparent border-b border-indigo-400 outline-none text-zinc-900 dark:text-zinc-100"
                  />
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-zinc-500">优先级</span>
                    {[1,2,3,4,5].map(p => {
                      const { label, cls } = PRIORITY_LABELS[p]
                      return (
                        <button key={p} onClick={() => setEditPriority(p)}
                          className={cn('text-[11px] px-2 py-0.5 rounded font-semibold transition-all', editPriority === p ? cls : 'bg-zinc-50 text-zinc-400 dark:bg-zinc-900')}
                        >{label}</button>
                      )
                    })}
                  </div>
                </div>
                <div className="flex gap-1 flex-shrink-0 pt-1">
                  <button onClick={handleSaveMeta} disabled={savingMeta} className="text-indigo-500 hover:text-indigo-600 p-1">
                    {savingMeta ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  </button>
                  <button onClick={() => setEditingTitle(false)} className="text-zinc-400 hover:text-zinc-600 p-1"><X className="w-4 h-4" /></button>
                </div>
              </div>
            ) : (
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-2">
                  <h1 className="text-lg font-bold text-zinc-900 dark:text-zinc-100 truncate">{selected.title}</h1>
                  <span className={cn('text-[10px] px-1.5 py-0.5 rounded font-semibold flex-shrink-0', PRIORITY_LABELS[selected.priority]?.cls)}>
                    {PRIORITY_LABELS[selected.priority]?.label}
                  </span>
                  {selected.status === 'archived' && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-400 dark:bg-zinc-800">已归档</span>
                  )}
                  <button onClick={openEdit} className="ml-1 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 p-1 rounded hover:bg-zinc-50 dark:hover:bg-zinc-900">
                    <Pencil className="w-3 h-3" />
                  </button>
                  <div className="ml-auto flex items-center gap-1.5 flex-shrink-0">
                    <Button variant="outline" size="sm" onClick={handleArchive} className="text-xs h-7">
                      {selected.status === 'archived' ? '恢复' : '归档'}
                    </Button>
                    <Button variant="outline" size="sm" onClick={handleDelete} disabled={deleting}
                      className="text-xs h-7 text-red-500 hover:text-red-600 hover:border-red-300">
                      {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                    </Button>
                  </div>
                </div>
                {/* Tags */}
                <div className="flex flex-wrap items-center gap-1">
                  {selected.tags.map(tag => (
                    <TagChip key={tag.id} tag={tag} onRemove={() => handleRemoveTagFromTopic(tag.name)} />
                  ))}
                  <input
                    ref={tagInputRef}
                    value={tagInput}
                    onChange={e => setTagInput(e.target.value)}
                    onKeyDown={e => {
                      if ((e.key === 'Enter' || e.key === ',') && tagInput.trim()) {
                        e.preventDefault()
                        handleAddTagToTopic(tagInput.trim())
                      }
                    }}
                    placeholder="添加标签…"
                    className="text-[10px] px-1.5 py-0.5 border border-dashed border-zinc-300 dark:border-zinc-600 rounded-full outline-none focus:border-indigo-400 bg-transparent text-zinc-500 placeholder:text-zinc-400 w-20"
                    list="tag-suggestions"
                  />
                  <datalist id="tag-suggestions">
                    {availableTags.map(t => <option key={t.id} value={t.name} />)}
                  </datalist>
                </div>
              </div>
            )}
          </div>

          {/* Tabs */}
          <div className="flex border-b border-zinc-100 dark:border-zinc-800 px-6 flex-shrink-0">
            {(['brief', 'sources', 'drafts'] as ActiveTab[]).map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={cn(
                  'text-xs py-2.5 px-1 mr-6 font-medium border-b-2 transition-colors',
                  activeTab === tab
                    ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                    : 'border-transparent text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
                )}
              >
                {tab === 'brief' ? 'Brief' : tab === 'sources' ? `线索 (${selected.source_count})` : `产出 (${selected.draft_count})`}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-hidden flex">
            {activeTab === 'brief' && (
              <div className="flex-1 flex flex-col p-6 overflow-hidden">
                <textarea
                  value={briefDraft}
                  onChange={e => setBriefDraft(e.target.value)}
                  placeholder={`## 调研主题\n\n## 搜索范围\n\n## 提取要求\n\n## 输出格式`}
                  className="flex-1 text-sm font-mono bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg px-4 py-3 outline-none focus:border-indigo-400 resize-none text-zinc-800 dark:text-zinc-200 placeholder:text-zinc-300 dark:placeholder:text-zinc-600 leading-relaxed"
                />
                <div className="flex items-center gap-2 mt-3 flex-shrink-0">
                  <Button size="sm" onClick={handleSaveBrief} disabled={savingBrief || briefDraft === selected.brief} className="gap-1 text-xs h-8">
                    {savingBrief ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} 保存
                  </Button>
                  <Button size="sm" variant="outline" onClick={openDispatchConfirm} disabled={!briefDraft.trim()} className="gap-1 text-xs h-8 text-indigo-600 border-indigo-300 hover:bg-indigo-50">
                    <Rocket className="w-3.5 h-3.5" /> 派发给 Agent
                  </Button>
                  <span className="text-[11px] text-zinc-400 ml-auto">
                    {briefDraft !== selected.brief ? '未保存' : ''}
                  </span>
                </div>
              </div>
            )}

            {activeTab === 'sources' && (
              <div className="flex-1 overflow-y-auto flex flex-col">
                <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-100 dark:border-zinc-800 flex-shrink-0">
                  <span className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">参考线索</span>
                  <button
                    onClick={() => setShowSourceForm(v => !v)}
                    className="ml-auto flex items-center gap-1 text-xs text-indigo-500 hover:text-indigo-600"
                  >
                    <Plus className="w-3.5 h-3.5" /> 添加线索
                  </button>
                </div>
                {showSourceForm && (
                  <div className="px-4 py-3 border-b border-zinc-100 dark:border-zinc-800 bg-indigo-50/40 dark:bg-indigo-950/10 space-y-2">
                    <div className="flex gap-2">
                      <input value={sourceForm.url} onChange={e => setSourceForm(f => ({ ...f, url: e.target.value }))} placeholder="链接 URL（可选）"
                        className="flex-1 text-xs px-2 py-1.5 border border-zinc-200 dark:border-zinc-700 rounded bg-white dark:bg-zinc-900 outline-none focus:border-indigo-400" />
                      <select value={sourceForm.platform} onChange={e => setSourceForm(f => ({ ...f, platform: e.target.value }))}
                        className="text-xs px-2 py-1.5 border border-zinc-200 dark:border-zinc-700 rounded bg-white dark:bg-zinc-900 outline-none focus:border-indigo-400">
                        {PLATFORMS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                      </select>
                    </div>
                    <input value={sourceForm.title} onChange={e => setSourceForm(f => ({ ...f, title: e.target.value }))} placeholder="标题（可选）"
                      className="w-full text-xs px-2 py-1.5 border border-zinc-200 dark:border-zinc-700 rounded bg-white dark:bg-zinc-900 outline-none focus:border-indigo-400" />
                    <textarea value={sourceForm.content} onChange={e => setSourceForm(f => ({ ...f, content: e.target.value }))} placeholder="线索正文内容…" rows={4}
                      className="w-full text-xs px-2 py-1.5 border border-zinc-200 dark:border-zinc-700 rounded bg-white dark:bg-zinc-900 outline-none focus:border-indigo-400 resize-y" />
                    <textarea value={sourceForm.note} onChange={e => setSourceForm(f => ({ ...f, note: e.target.value }))} placeholder="备注…" rows={2}
                      className="w-full text-xs px-2 py-1.5 border border-zinc-200 dark:border-zinc-700 rounded bg-white dark:bg-zinc-900 outline-none focus:border-indigo-400 resize-none" />
                    <div className="flex gap-2">
                      <Button size="sm" onClick={handleAddSource} disabled={addingSource} className="text-xs h-7 gap-1">
                        {addingSource ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} 保存
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setShowSourceForm(false)} className="text-xs h-7">取消</Button>
                    </div>
                  </div>
                )}
                {selected.sources.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-40 text-zinc-400 gap-2">
                    <Link2 className="w-8 h-8 opacity-20" />
                    <p className="text-xs">暂无线索</p>
                  </div>
                ) : (
                  selected.sources.map(s => (
                    <SourceRow key={s.id} source={s}
                      onDelete={() => handleDeleteSource(s)}
                      onPreview={src => setPreviewSource(prev => prev?.id === src.id ? null : src)}
                      onCreateDraft={handleCreateDraft}
                      isActive={previewSource?.id === s.id}
                      creating={creatingDraft?.id === s.id ? creatingDraft.type : false}
                    />
                  ))
                )}
              </div>
            )}

            {activeTab === 'drafts' && (
              <div className="flex-1 overflow-y-auto">
                {loadingDrafts ? (
                  <div className="flex items-center justify-center h-40">
                    <Loader2 className="w-6 h-6 animate-spin text-zinc-400" />
                  </div>
                ) : drafts.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-40 text-zinc-400 gap-2">
                    <FileText className="w-8 h-8 opacity-20" />
                    <p className="text-xs">暂无产出</p>
                    <p className="text-[11px] text-zinc-300">从线索创作草稿，或在草稿页关联此选题</p>
                  </div>
                ) : (
                  <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                    {drafts.map(d => (
                      <div
                        key={d.id}
                        onClick={() => router.push(`/drafts?draft=${d.id}`)}
                        className="flex items-center gap-3 px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-900/50 cursor-pointer group"
                      >
                        <FileText className="w-4 h-4 text-zinc-300 dark:text-zinc-600 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200 truncate">
                            {d.title || '（无标题）'}
                          </p>
                          <p className="text-[11px] text-zinc-400 mt-0.5">
                            {d.draft_type === 'article' ? '文章' : '脚本'} · {d.status} · {formatDate(d.created_at)}
                          </p>
                        </div>
                        <ExternalLink className="w-3.5 h-3.5 text-zinc-300 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {activeTab === 'sources' && previewSource && (
              <SourcePreview source={previewSource} onClose={() => setPreviewSource(null)} />
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center text-zinc-400 gap-3">
          <BookMarked className="w-12 h-12 opacity-20" />
          <p className="text-sm">选择一个选题查看详情</p>
          <button onClick={() => setShowNewForm(true)} className="text-xs text-indigo-500 hover:underline flex items-center gap-1">
            <Plus className="w-3.5 h-3.5" /> 新建第一个选题
          </button>
        </div>
      )}

      {/* ── Dispatch confirm modal ─────────────────────────────────── */}
      {showDispatchConfirm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setShowDispatchConfirm(false)}>
          <div className="bg-white dark:bg-zinc-900 rounded-xl shadow-xl p-6 w-[560px] space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <Rocket className="w-4 h-4 text-indigo-500" />
              <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">派发给 Scout Agent</h3>
            </div>
            <p className="text-xs text-zinc-500">以下 brief 将作为 Hermes kanban 任务发送给 scout。可在下方编辑后再派发。</p>
            <textarea
              value={dispatchBrief}
              onChange={e => setDispatchBrief(e.target.value)}
              rows={10}
              className="w-full text-xs font-mono px-3 py-2 border border-zinc-200 dark:border-zinc-700 rounded-lg bg-zinc-50 dark:bg-zinc-900 outline-none focus:border-indigo-400 resize-none"
            />
            <div className="flex gap-2 justify-end pt-1">
              <Button variant="outline" onClick={() => setShowDispatchConfirm(false)} className="text-xs h-8">取消</Button>
              <Button onClick={handleDispatch} disabled={dispatching || !dispatchBrief.trim()} className="text-xs h-8 gap-1">
                {dispatching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <SendHorizonal className="w-3.5 h-3.5" />} 确认派发
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── New topic modal ─────────────────────────────────────────── */}
      {showNewForm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setShowNewForm(false)}>
          <div className="bg-white dark:bg-zinc-900 rounded-xl shadow-xl p-6 w-96 space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">新建选题</h3>
            <input
              ref={newTitleRef}
              value={newTitle}
              onChange={e => setNewTitle(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setShowNewForm(false) }}
              placeholder="选题名称…"
              className="w-full px-3 py-2 border border-zinc-200 dark:border-zinc-700 rounded-lg bg-transparent outline-none focus:border-indigo-400 text-sm"
            />
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-500">优先级</span>
              {[1,2,3,4,5].map(p => {
                const { label, cls } = PRIORITY_LABELS[p]
                return (
                  <button key={p} onClick={() => setNewPriority(p)}
                    className={cn('text-[11px] px-2 py-0.5 rounded font-semibold transition-all', newPriority === p ? cls : 'bg-zinc-50 text-zinc-400 dark:bg-zinc-900')}
                  >{label}</button>
                )
              })}
            </div>
            <div className="flex gap-2 pt-1">
              <Button onClick={handleCreate} disabled={creating || !newTitle.trim()} className="flex-1 gap-1">
                {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} 创建
              </Button>
              <Button variant="outline" onClick={() => setShowNewForm(false)}>取消</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Check TypeScript compiles**

```bash
source ~/.zshrc && cd web && npm run build 2>&1 | grep -E "error|Error|warning" | head -30
```

Fix any TypeScript errors before continuing.

- [ ] **Step 4: Commit**

```bash
git add web/app/topics/page.tsx web/app/topics/TopicsClient.tsx
git commit -m "feat(frontend): redesign topic library — cards, tags, brief editor, dispatch, drafts tab"
```

---

## Task 8: Verify End-to-End

- [ ] **Step 1: Run all backend tests**

```bash
source ~/.zshrc && cd backend && conda run -n wems pytest tests/test_content_topics.py -v 2>&1 | tail -30
```

Expected: all tests pass.

- [ ] **Step 2: Start the dev server and verify the UI**

```bash
source ~/.zshrc && cd web && npm run dev
```

Open http://localhost:3000/topics and verify:
- Left panel shows search + tag filter chips + topic cards
- Creating a topic opens the modal; new topic appears in the list
- Selecting a topic shows Brief / 线索 / 产出 tabs
- Brief tab: can type and save; "派发给 Agent" button disabled when brief is empty
- Sources tab: can add / delete sources, source preview panel opens
- Drafts tab: shows linked drafts (or empty state)
- Tag filter chips filter the card list correctly
- Archived topics show "已归档" badge

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "chore: topic library redesign complete"
```
