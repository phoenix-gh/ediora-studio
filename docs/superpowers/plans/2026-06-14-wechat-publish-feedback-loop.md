# 公众号发布效果回流（Phase 1）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 记录公众号发布、手动回填阅读/点赞/在看/分享，并通过 MCP 工具把近期表现喂给 8 点总编，闭合「选题→创作→发布→效果→选题」环。

**Architecture:** 新增 `Publication` 表作发布记录锚点；公众号发布成功后自动 upsert 一条；新 `/published-articles` 路由做 CRUD；前端 `/published` 页录入+表现榜合一；MCP `get_recent_performance` 接进 `DAILY_PLAN_PIPELINE` 总编指令。

**Tech Stack:** FastAPI + SQLAlchemy async（conda env `wems`，命令加 `conda run -n wems`）、Pydantic v2、pytest（sqlite+aiosqlite）、Next.js App Router + shadcn/ui。

**约定：** 所有 Bash 先 `source ~/.zshrc`；后端命令在 `backend/` 下加 `WMS_DISABLE_SCHEDULER=1 conda run -n wems`；前端在 `wemedia-studio/` 下 `pnpm`。设计见 `docs/superpowers/specs/2026-06-14-wechat-publish-feedback-loop-design.md`。

---

## File Structure

- `backend/models.py` — +`Publication` 模型
- `backend/schemas.py` — +`PublicationCreate/Update/Out`
- `backend/routers/published.py` — 新建，CRUD/列表（prefix `/published-articles`）
- `backend/main.py` — 挂 `published` 路由
- `backend/routers/drafts.py` — 公众号发布成功后 upsert `Publication`
- `backend/mcp_server.py` — +`get_recent_performance` 工具
- `backend/pipeline_template.py` — `DAILY_PLAN_PIPELINE` 总编指令加一步
- `backend/tests/test_published.py` — 新建，路由/模型测试
- `backend/tests/test_wechat_publish.py` — +发布自动建记录测试
- `backend/tests/test_mcp_daily_plan_tools.py` — +`get_recent_performance` 测试
- `wemedia-studio/lib/api/published.ts` — 新建，API 客户端
- `wemedia-studio/app/published/page.tsx` + `PublishedClient.tsx` — 新建，发布表现页
- `wemedia-studio/components/features/Sidebar.tsx` — 导航加「发布」

---

## Task 1: Publication 模型 + schemas

**Files:**
- Modify: `backend/models.py`（在 `class ArticleDraft` 之后新增）
- Modify: `backend/schemas.py`（文件末尾新增）

- [ ] **Step 1: 加 Publication 模型**

在 `backend/models.py` 的 `class ArticleDraft(Base):` 整块之后插入：

```python
class Publication(Base):
    """一次「草稿→平台」的发布记录；效果回流（阅读/点赞）的锚点。"""
    __tablename__ = "publications"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    draft_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    account_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    platform: Mapped[str] = mapped_column(String, default="wechat")
    title: Mapped[str] = mapped_column(String, default="")
    external_id: Mapped[str] = mapped_column(String, default="")  # 微信 media_id
    url: Mapped[str] = mapped_column(String, default="")          # 公开文章 URL（群发后回填）
    status: Mapped[str] = mapped_column(String, default="draft_box", index=True)  # draft_box | published
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    read_count: Mapped[int] = mapped_column(Integer, default=0)
    like_count: Mapped[int] = mapped_column(Integer, default=0)
    look_count: Mapped[int] = mapped_column(Integer, default=0)
    share_count: Mapped[int] = mapped_column(Integer, default=0)
    stats_as_of: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)
```

- [ ] **Step 2: 加 schemas**

在 `backend/schemas.py` 末尾追加：

```python
class PublicationCreate(BaseModel):
    draft_id: int
    account_id: str
    title: str
    platform: str = "wechat"
    external_id: str = ""
    url: str = ""
    status: str = "draft_box"


class PublicationUpdate(BaseModel):
    status: Optional[str] = None
    url: Optional[str] = None
    published_at: Optional[datetime] = None
    read_count: Optional[int] = None
    like_count: Optional[int] = None
    look_count: Optional[int] = None
    share_count: Optional[int] = None


class PublicationOut(BaseModel):
    id: int
    draft_id: int
    account_id: str
    account_name: str = ""
    platform: str
    title: str
    external_id: str
    url: str
    status: str
    published_at: Optional[datetime] = None
    read_count: int
    like_count: int
    look_count: int
    share_count: int
    stats_as_of: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
```

- [ ] **Step 3: 导入冒烟**

Run: `cd backend && WMS_DISABLE_SCHEDULER=1 conda run -n wems python -c "import models, schemas; print(models.Publication.__tablename__, schemas.PublicationOut.__name__)"`
Expected: 打印 `publications PublicationOut`

- [ ] **Step 4: Commit**

```bash
git add backend/models.py backend/schemas.py
git commit -m "feat(publish-feedback): Publication 模型 + schemas"
```

---

## Task 2: published 路由（CRUD/列表）+ 挂载

**Files:**
- Create: `backend/routers/published.py`
- Modify: `backend/main.py`
- Test: `backend/tests/test_published.py`

- [ ] **Step 1: 写失败测试**

新建 `backend/tests/test_published.py`：

```python
import sys
import asyncio
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch, tmp_path):
    db_file = tmp_path / "test.db"
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{db_file}")
    monkeypatch.setenv("WMS_DISABLE_SCHEDULER", "1")
    for mod in list(sys.modules):
        if mod.startswith(("database", "models", "main", "routers", "config", "scheduler", "logger")):
            sys.modules.pop(mod, None)
    from database import engine, Base
    import models  # noqa: F401

    async def _create():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    asyncio.new_event_loop().run_until_complete(_create())
    from main import app
    return TestClient(app)


def _seed_account(client, acc_id="gzh", name="主号"):
    r = client.post("/api/publish-accounts", json={"id": acc_id, "name": name, "platform": "wechat"})
    assert r.status_code == 201, r.text


def _create_pub(client, **over):
    body = {"draft_id": 1, "account_id": "gzh", "title": "测试文章"}
    body.update(over)
    r = client.post("/api/published-articles", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def test_create_returns_account_name_and_defaults(client):
    _seed_account(client)
    pub = _create_pub(client)
    assert pub["account_name"] == "主号"
    assert pub["status"] == "draft_box"
    assert pub["read_count"] == 0
    assert pub["published_at"] is None


def test_patch_stats_sets_stats_as_of(client):
    _seed_account(client)
    pub = _create_pub(client)
    assert pub["stats_as_of"] is None
    r = client.patch(f"/api/published-articles/{pub['id']}", json={"read_count": 1234, "like_count": 56})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["read_count"] == 1234
    assert body["like_count"] == 56
    assert body["stats_as_of"] is not None


def test_mark_published_sets_published_at(client):
    _seed_account(client)
    pub = _create_pub(client)
    r = client.patch(f"/api/published-articles/{pub['id']}", json={"status": "published"})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "published"
    assert r.json()["published_at"] is not None


def test_negative_stat_rejected(client):
    _seed_account(client)
    pub = _create_pub(client)
    r = client.patch(f"/api/published-articles/{pub['id']}", json={"read_count": -5})
    assert r.status_code == 400


def test_list_sorted_by_read_desc(client):
    _seed_account(client)
    _create_pub(client, title="低", read_count=0)  # read_count 不在 Create 里 → 用 patch
    a = _create_pub(client, title="A")
    b = _create_pub(client, title="B")
    client.patch(f"/api/published-articles/{a['id']}", json={"read_count": 10})
    client.patch(f"/api/published-articles/{b['id']}", json={"read_count": 99})
    rows = client.get("/api/published-articles").json()
    assert [r["title"] for r in rows][:2] == ["B", "A"]


def test_delete(client):
    _seed_account(client)
    pub = _create_pub(client)
    assert client.delete(f"/api/published-articles/{pub['id']}").status_code == 204
    assert client.get("/api/published-articles").json() == []
```

注：`_create_pub` 的 `read_count` 经由 `PublicationCreate` 时会被忽略（Create 无该字段），故用 patch 设置——上面 `test_list_sorted` 已按此写。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && WMS_DISABLE_SCHEDULER=1 conda run -n wems python -m pytest tests/test_published.py -q -p no:cacheprovider`
Expected: FAIL（404 / 路由不存在）

- [ ] **Step 3: 写 published 路由**

新建 `backend/routers/published.py`：

```python
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import Publication, PublishAccount
from schemas import PublicationCreate, PublicationUpdate, PublicationOut

router = APIRouter(prefix="/published-articles", tags=["published"])

_STAT_FIELDS = {"read_count", "like_count", "look_count", "share_count"}


def _out(pub: Publication, account_name: str = "") -> PublicationOut:
    out = PublicationOut.model_validate(pub)
    out.account_name = account_name or ""
    return out


@router.get("", response_model=list[PublicationOut])
async def list_publications(
    status: str | None = None,
    account_id: str | None = None,
    db: AsyncSession = Depends(get_db),
):
    q = select(Publication, PublishAccount.name).join(
        PublishAccount, Publication.account_id == PublishAccount.id, isouter=True
    )
    if status:
        q = q.where(Publication.status == status)
    if account_id:
        q = q.where(Publication.account_id == account_id)
    q = q.order_by(desc(Publication.read_count), desc(Publication.created_at))
    rows = (await db.execute(q)).all()
    return [_out(pub, name) for pub, name in rows]


@router.post("", response_model=PublicationOut, status_code=201)
async def create_publication(body: PublicationCreate, db: AsyncSession = Depends(get_db)):
    pub = Publication(**body.model_dump())
    db.add(pub)
    await db.commit()
    await db.refresh(pub)
    acc = await db.get(PublishAccount, pub.account_id)
    return _out(pub, acc.name if acc else "")


@router.patch("/{pub_id}", response_model=PublicationOut)
async def update_publication(pub_id: int, body: PublicationUpdate, db: AsyncSession = Depends(get_db)):
    pub = await db.get(Publication, pub_id)
    if not pub:
        raise HTTPException(404, "发布记录不存在")
    data = body.model_dump(exclude_unset=True)
    for k in _STAT_FIELDS & set(data):
        if data[k] is not None and data[k] < 0:
            raise HTTPException(400, f"{k} 不能为负")
    if _STAT_FIELDS & {k for k, v in data.items() if v is not None}:
        pub.stats_as_of = datetime.now(timezone.utc)
    for k, v in data.items():
        setattr(pub, k, v)
    if data.get("status") == "published" and pub.published_at is None:
        pub.published_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(pub)
    acc = await db.get(PublishAccount, pub.account_id)
    return _out(pub, acc.name if acc else "")


@router.delete("/{pub_id}", status_code=204)
async def delete_publication(pub_id: int, db: AsyncSession = Depends(get_db)):
    pub = await db.get(Publication, pub_id)
    if not pub:
        raise HTTPException(404, "发布记录不存在")
    await db.delete(pub)
    await db.commit()
```

- [ ] **Step 4: main.py 挂路由**

`backend/main.py`：在 import 行的 `daily_plan` 后加 `published`：

```python
from routers import settings, github, x, papers, personas, upload, drafts, writing_plans, youtube, producthunt, wechat, v2ex, kr, juejin, studio, publish_accounts, profiles, reddit, topic_generator, retro, materials, skills, dashboard, daily_plan, published
```

在 `app.include_router(daily_plan.router, prefix="/api")` 之后加：

```python
app.include_router(published.router, prefix="/api")
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd backend && WMS_DISABLE_SCHEDULER=1 conda run -n wems python -m pytest tests/test_published.py -q -p no:cacheprovider`
Expected: 6 passed

- [ ] **Step 6: Commit**

```bash
git add backend/routers/published.py backend/main.py backend/tests/test_published.py
git commit -m "feat(publish-feedback): published-articles 路由 CRUD/列表"
```

---

## Task 3: 公众号发布成功后自动建 Publication

**Files:**
- Modify: `backend/routers/drafts.py`（import + `publish_draft_to_wechat` 末尾）
- Test: `backend/tests/test_wechat_publish.py`（追加）

- [ ] **Step 1: 写失败测试**

在 `backend/tests/test_wechat_publish.py` 末尾追加（复用本文件已有的 `client`/`wx_mock`/`uploads_dir`/`_setup_draft_with_image`）：

```python
def test_publish_creates_publication_record(client, uploads_dir, wx_mock):
    draft, img = _setup_draft_with_image(client)
    html = f'<section><p>正文</p><img src="{img["url"]}"></section>'
    r = client.post(f"/api/write/drafts/{draft['id']}/publish/wechat", json={
        "account_id": "gzh", "title": "测试文章", "digest": "摘要",
        "html": html, "cover_image_id": img["id"],
    })
    assert r.status_code == 200, r.text

    pubs = client.get("/api/published-articles").json()
    assert len(pubs) == 1
    assert pubs[0]["draft_id"] == draft["id"]
    assert pubs[0]["account_id"] == "gzh"
    assert pubs[0]["external_id"] == "DRAFT_MEDIA_1"
    assert pubs[0]["status"] == "draft_box"

    # 同 draft+account 再发一次：更新而非重复建
    r2 = client.post(f"/api/write/drafts/{draft['id']}/publish/wechat", json={
        "account_id": "gzh", "title": "改了标题", "digest": "摘要",
        "html": html, "cover_image_id": img["id"],
    })
    assert r2.status_code == 200, r2.text
    pubs2 = client.get("/api/published-articles").json()
    assert len(pubs2) == 1
    assert pubs2[0]["title"] == "改了标题"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && WMS_DISABLE_SCHEDULER=1 conda run -n wems python -m pytest tests/test_wechat_publish.py::test_publish_creates_publication_record -q -p no:cacheprovider`
Expected: FAIL（`len(pubs) == 1` 断言失败，实际 0）

- [ ] **Step 3: 实现发布钩子**

`backend/routers/drafts.py` 第 17 行 import 加上 `Publication`：

```python
from models import ArticleDraft, ArticleSeries, DraftImage, PublishAccount, Publication
```

在 `publish_draft_to_wechat` 的 `return WechatPublishResponse(media_id=media_id)`（约第 359 行）之前插入：

```python
    # 发布记录（效果回流锚点）：同 draft+account 已有草稿箱记录则更新，否则新建。
    # 失败不影响发布——media_id 已成功返回。
    try:
        existing = (await db.execute(
            select(Publication).where(
                Publication.draft_id == draft_id,
                Publication.account_id == account.id,
                Publication.platform == "wechat",
                Publication.status == "draft_box",
            )
        )).scalar_one_or_none()
        if existing:
            existing.external_id = media_id
            existing.title = body.title[:200]
        else:
            db.add(Publication(
                draft_id=draft_id, account_id=account.id, platform="wechat",
                title=body.title[:200], external_id=media_id, status="draft_box",
            ))
        await db.commit()
    except Exception as e:
        from logger import log
        await log("publish", "warn", f"发布记录写入失败 draft={draft_id}", str(e))
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && WMS_DISABLE_SCHEDULER=1 conda run -n wems python -m pytest tests/test_wechat_publish.py -q -p no:cacheprovider`
Expected: 全部 passed（含新测试；单文件跑无污染）

- [ ] **Step 5: Commit**

```bash
git add backend/routers/drafts.py backend/tests/test_wechat_publish.py
git commit -m "feat(publish-feedback): 公众号发布成功后 upsert Publication"
```

---

## Task 4: MCP 工具 get_recent_performance

**Files:**
- Modify: `backend/mcp_server.py`（在 `get_topic_candidates` 工具之后新增）
- Test: `backend/tests/test_mcp_daily_plan_tools.py`（追加）

- [ ] **Step 1: 写失败测试**

在 `backend/tests/test_mcp_daily_plan_tools.py` 末尾追加（复用该文件的 `env` fixture、`_seed`、`_run`、`_now`）：

```python
def test_recent_performance_published_only_sorted(env):
    from models import PublishAccount, Publication
    _seed(PublishAccount, id="gzh", name="主号")
    _seed(Publication, draft_id=1, account_id="gzh", title="爆款",
          status="published", published_at=_now(), read_count=9999)
    _seed(Publication, draft_id=2, account_id="gzh", title="一般",
          status="published", published_at=_now(), read_count=10)
    _seed(Publication, draft_id=3, account_id="gzh", title="还没发",
          status="draft_box", read_count=88888)  # 草稿箱态，不该出现
    import mcp_server
    res = _run(mcp_server.get_recent_performance())
    assert [r["title"] for r in res] == ["爆款", "一般"]
    assert res[0]["account_name"] == "主号"
    assert set(res[0]) == {"title", "account_id", "account_name",
                           "read_count", "like_count", "look_count",
                           "share_count", "published_at"}


def test_recent_performance_window(env):
    from datetime import timedelta
    from models import PublishAccount, Publication
    _seed(PublishAccount, id="gzh", name="主号")
    _seed(Publication, draft_id=1, account_id="gzh", title="旧文",
          status="published", published_at=_now() - timedelta(days=40), read_count=5)
    import mcp_server
    assert _run(mcp_server.get_recent_performance(days=30)) == []
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && WMS_DISABLE_SCHEDULER=1 conda run -n wems python -m pytest tests/test_mcp_daily_plan_tools.py::test_recent_performance_published_only_sorted -q -p no:cacheprovider`
Expected: FAIL（`AttributeError: module 'mcp_server' has no attribute 'get_recent_performance'`）

- [ ] **Step 3: 实现工具**

在 `backend/mcp_server.py` 的 `get_topic_candidates` 函数整块之后插入：

```python
@mcp.tool()
async def get_recent_performance(days: int = 30, limit: int = 20) -> list[dict]:
    """
    近 N 天已发布文章的表现（阅读/点赞/在看/分享），按阅读量倒序。
    供每日计划总编判断什么选题/账号有效：复制成功方向、避开重复哑火。
    只含 status=published 的记录；空则返回 []。
    """
    from models import Publication, PublishAccount

    since = datetime.now(timezone.utc) - timedelta(days=max(1, int(days)))
    lim = max(1, min(int(limit), 100))
    async with SessionLocal() as db:
        rows = (await db.execute(
            select(Publication, PublishAccount.name)
            .join(PublishAccount, Publication.account_id == PublishAccount.id, isouter=True)
            .where(Publication.status == "published", Publication.published_at >= since)
            .order_by(desc(Publication.read_count)).limit(lim)
        )).all()
    return [{
        "title": p.title,
        "account_id": p.account_id,
        "account_name": name or "",
        "read_count": p.read_count,
        "like_count": p.like_count,
        "look_count": p.look_count,
        "share_count": p.share_count,
        "published_at": _fmt_dt(p.published_at),
    } for p, name in rows]
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && WMS_DISABLE_SCHEDULER=1 conda run -n wems python -m pytest tests/test_mcp_daily_plan_tools.py -q -p no:cacheprovider`
Expected: 全部 passed

- [ ] **Step 5: Commit**

```bash
git add backend/mcp_server.py backend/tests/test_mcp_daily_plan_tools.py
git commit -m "feat(publish-feedback): MCP get_recent_performance 工具"
```

---

## Task 5: 总编指令接线（DAILY_PLAN_PIPELINE）

**Files:**
- Modify: `backend/pipeline_template.py`（`DAILY_PLAN_PIPELINE` 的「## 工作流」块）

- [ ] **Step 1: 改工作流文本**

把 `backend/pipeline_template.py` 中这段（约 920-933 行）：

```
## 工作流
1. 调 `get_topic_candidates()` 拉取近 24h 候选池（X 热帖 / GitHub release / 论文 / 36氪 /
   掘金 / V2EX / Reddit / Product Hunt / YouTube / 选题库 / 写作方案）
2. 可用 web 工具核实候选热点、补充今天的新动态
3. 按每个账号的画像（定位/受众/选题重点/禁区）和 daily_quota 分配选题，每条给出：
```

替换为：

```
## 工作流
1. 调 `get_topic_candidates()` 拉取近 24h 候选池（X 热帖 / GitHub release / 论文 / 36氪 /
   掘金 / V2EX / Reddit / Product Hunt / YouTube / 选题库 / 写作方案）
2. 调 `get_recent_performance()` 看最近哪些选题/账号阅读表现好或哑火——
   选题时倾向复制成功方向、避开重复哑火的题材
3. 可用 web 工具核实候选热点、补充今天的新动态
4. 按每个账号的画像（定位/受众/选题重点/禁区）和 daily_quota 分配选题，每条给出：
```

- [ ] **Step 2: 验证文本已接入且模块可导入**

Run: `cd backend && WMS_DISABLE_SCHEDULER=1 conda run -n wems python -c "import pipeline_template as p; body=p.DAILY_PLAN_PIPELINE[0].body({'date_str':'x','plan_id':1,'accounts_md':'','recent_titles_md':''}); assert 'get_recent_performance' in body; print('OK')"`
Expected: 打印 `OK`

- [ ] **Step 3: Commit**

```bash
git add backend/pipeline_template.py
git commit -m "feat(publish-feedback): 总编选题前读 get_recent_performance"
```

---

## Task 6: 前端 API 客户端 published.ts

**Files:**
- Create: `wemedia-studio/lib/api/published.ts`

- [ ] **Step 1: 写客户端**

新建 `wemedia-studio/lib/api/published.ts`：

```typescript
import { apiFetch } from './client'

export interface Publication {
  id: number
  draft_id: number
  account_id: string
  account_name: string
  platform: string
  title: string
  external_id: string
  url: string
  status: 'draft_box' | 'published'
  published_at: string | null
  read_count: number
  like_count: number
  look_count: number
  share_count: number
  stats_as_of: string | null
  created_at: string
  updated_at: string
}

export type PublicationPatch = Partial<Pick<Publication,
  'status' | 'url' | 'read_count' | 'like_count' | 'look_count' | 'share_count'>>

export function getPublications(params?: { status?: string; account_id?: string }): Promise<Publication[]> {
  const qs = new URLSearchParams(params as Record<string, string> | undefined).toString()
  return apiFetch<Publication[]>(`/published-articles${qs ? `?${qs}` : ''}`)
}

export function updatePublication(id: number, patch: PublicationPatch): Promise<Publication> {
  return apiFetch<Publication>(`/published-articles/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export function deletePublication(id: number): Promise<void> {
  return apiFetch<void>(`/published-articles/${id}`, { method: 'DELETE' })
}
```

- [ ] **Step 2: 类型检查**

Run: `cd wemedia-studio && pnpm exec tsc --noEmit`
Expected: 无错误输出

- [ ] **Step 3: Commit**

```bash
git add wemedia-studio/lib/api/published.ts
git commit -m "feat(publish-feedback): 前端 published API 客户端"
```

---

## Task 7: 前端 /published 页（录入 + 表现榜）

**Files:**
- Create: `wemedia-studio/app/published/page.tsx`
- Create: `wemedia-studio/app/published/PublishedClient.tsx`

- [ ] **Step 1: 服务端页面**

新建 `wemedia-studio/app/published/page.tsx`：

```tsx
import { getPublications } from '@/lib/api/published'
import { PublishedClient } from './PublishedClient'

export const dynamic = 'force-dynamic'

export default async function PublishedPage() {
  const initial = await getPublications().catch(() => [])
  return (
    <div className="px-8 py-8">
      <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100 mb-1">发布</h1>
      <p className="text-sm text-zinc-500 mb-6">
        已发布文章的表现回填——阅读 / 点赞 / 在看 / 分享，按阅读量排序。
      </p>
      <PublishedClient initial={initial} />
    </div>
  )
}
```

- [ ] **Step 2: 客户端组件**

新建 `wemedia-studio/app/published/PublishedClient.tsx`：

```tsx
'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Publication, updatePublication } from '@/lib/api/published'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

const STAT_FIELDS: { key: 'read_count' | 'like_count' | 'look_count' | 'share_count'; label: string }[] = [
  { key: 'read_count', label: '阅读' },
  { key: 'like_count', label: '点赞' },
  { key: 'look_count', label: '在看' },
  { key: 'share_count', label: '分享' },
]

export function PublishedClient({ initial }: { initial: Publication[] }) {
  const [rows, setRows] = useState<Publication[]>(initial)
  const [saving, setSaving] = useState<number | null>(null)

  function patchLocal(id: number, patch: Partial<Publication>) {
    setRows(rs => rs.map(r => (r.id === id ? { ...r, ...patch } : r)))
  }

  async function save(row: Publication) {
    setSaving(row.id)
    try {
      const updated = await updatePublication(row.id, {
        url: row.url,
        read_count: row.read_count,
        like_count: row.like_count,
        look_count: row.look_count,
        share_count: row.share_count,
      })
      patchLocal(row.id, updated)
      toast.success('已保存')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(null)
    }
  }

  async function markPublished(row: Publication) {
    setSaving(row.id)
    try {
      const updated = await updatePublication(row.id, { status: 'published' })
      patchLocal(row.id, updated)
      toast.success('已标记发布')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败')
    } finally {
      setSaving(null)
    }
  }

  if (rows.length === 0) {
    return (
      <div className="text-sm text-zinc-400 border border-dashed border-zinc-200 dark:border-zinc-800 rounded-xl p-8 text-center">
        暂无发布记录——从草稿箱发布到公众号后会自动出现在这里。
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {rows.map(row => (
        <div key={row.id} className="border border-zinc-200 dark:border-zinc-800 rounded-xl p-4">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">{row.title || '(无标题)'}</p>
              <p className="text-xs text-zinc-400">
                {row.account_name || row.account_id} · {row.status === 'published' ? '已发布' : '草稿箱'}
                {row.published_at ? ` · ${row.published_at.slice(0, 10)}` : ''}
              </p>
            </div>
            {row.status !== 'published' && (
              <Button size="sm" variant="outline" disabled={saving === row.id} onClick={() => markPublished(row)}>
                标记已发布
              </Button>
            )}
          </div>
          <div className="flex flex-wrap items-end gap-3">
            {STAT_FIELDS.map(f => (
              <label key={f.key} className="text-xs text-zinc-500">
                <span className="block mb-1">{f.label}</span>
                <Input
                  type="number" min={0} value={row[f.key]}
                  onChange={e => patchLocal(row.id, { [f.key]: Math.max(0, Number(e.target.value)) } as Partial<Publication>)}
                  className="h-9 w-24 text-sm"
                />
              </label>
            ))}
            <label className="text-xs text-zinc-500 flex-1 min-w-[200px]">
              <span className="block mb-1">文章 URL（可选）</span>
              <Input
                value={row.url}
                onChange={e => patchLocal(row.id, { url: e.target.value })}
                placeholder="https://mp.weixin.qq.com/s/..."
                className="h-9 text-sm"
              />
            </label>
            <Button size="sm" disabled={saving === row.id} onClick={() => save(row)}>保存</Button>
          </div>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 3: 类型检查**

Run: `cd wemedia-studio && pnpm exec tsc --noEmit`
Expected: 无错误输出（若报 `Input`/`Button` 路径错，确认 `components/ui/input` 与 `components/ui/button` 存在——它们在别处已被引用）

- [ ] **Step 4: Commit**

```bash
git add wemedia-studio/app/published/
git commit -m "feat(publish-feedback): /published 发布表现页"
```

---

## Task 8: 侧边栏导航加「发布」

**Files:**
- Modify: `wemedia-studio/components/features/Sidebar.tsx`

- [ ] **Step 1: 加图标 import**

`wemedia-studio/components/features/Sidebar.tsx` 顶部 lucide 引入里加 `Send`：把

```tsx
  PlaySquare, Rocket, MessageSquare, Globe, Flame, Gem, Bot, UserCog, Hash, Lightbulb, CalendarCheck,
```

改为

```tsx
  PlaySquare, Rocket, MessageSquare, Globe, Flame, Gem, Bot, UserCog, Hash, Lightbulb, CalendarCheck, Send,
```

- [ ] **Step 2: 加导航项到「创作」组**

把「创作」组里这行：

```tsx
      { href: '/trend-topics', label: '热点选题', icon: Lightbulb },
```

改为：

```tsx
      { href: '/trend-topics', label: '热点选题', icon: Lightbulb },
      { href: '/published',    label: '发布',     icon: Send },
```

- [ ] **Step 3: 类型检查**

Run: `cd wemedia-studio && pnpm exec tsc --noEmit`
Expected: 无错误输出

- [ ] **Step 4: Commit**

```bash
git add wemedia-studio/components/features/Sidebar.tsx
git commit -m "feat(publish-feedback): 侧边栏加「发布」入口"
```

---

## 收尾验证

- [ ] **后端全量**：`cd backend && WMS_DISABLE_SCHEDULER=1 conda run -n wems python -m pytest -q --tb=no -p no:cacheprovider` —— 新增 test_published / 发布钩子 / get_recent_performance 全绿；既存 12 个失败不变（writing_plans/wechat_publish/ref flake，参 [[feedback_preexisting_test_failures]]，多为隔离污染，单文件跑均过）。
- [ ] **前端**：`cd wemedia-studio && pnpm exec tsc --noEmit` 零错误。
- [ ] **手动冒烟**：起后端 + 前端，发布一篇到公众号 → /published 出现一条草稿箱记录 → 标已发布 + 填阅读量 → 保存 → 刷新仍在、按阅读排序。

---

## Self-Review（已核对）

- **Spec 覆盖**：Publication 表(Task1) / 发布钩子(Task3) / CRUD(Task2) / get_recent_performance(Task4) / 总编接线(Task5) / /published 页(Task7) / 导航(Task8) / 手动回填+标已发布(Task2 PATCH + Task7) —— spec 各节均有对应任务。Phase 2（统计 API、时间序列、Blog/X、候选池热度）明确不在本计划。
- **占位符**：无 TBD/TODO；每个代码步给了完整代码与确切命令。
- **类型一致**：`Publication` 字段、`PublicationOut.account_name`、`get_recent_performance` 返回键、前端 `Publication` interface 三处字段名一致；路由前缀 `/published-articles` 前后端一致；MCP 工具名 `get_recent_performance` 在 Task4 定义、Task5 文本引用一致。
- **已知风险**：test_wechat_publish 全量跑有隔离污染（单跑通过），Task3 验证用单文件跑。
