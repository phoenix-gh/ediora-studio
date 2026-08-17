# 统一 X 采集 / 参考库下游消费 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把参考库的搜索式「采集规程」并入 X 订阅管理（新增 search 订阅类型，落 raw 帖入 x_posts），参考库改为从 x_posts 取数精炼，两边彻底解耦。

**Architecture:** X 订阅成为唯一 raw 采集层，`_collect_one` 按 `kind` 分支（timeline=grab_timeline / search=search_top）。参考库 `collect_rule` 数据源从 `search_top` 换成查 `XPost`，LLM 精炼管线零改动。幂等迁移把旧规则转成「search 订阅 + 指向它的选取规则」。

**Tech Stack:** FastAPI + SQLAlchemy async（后端，conda env `wems`），Next.js + shadcn/ui（前端）。所有 python/pytest 命令加 `conda run -n wems` 前缀。

---

## 约定

- 后端测试运行：`cd backend && conda run -n wems python -m pytest <path> -v`
- 所有 Bash 命令先 `source ~/.zshrc`。
- 前端校验：`cd web && npm run build`（无单测框架，用 build/tsc 把关）。

---

## Task 1: 数据模型加字段 + init_db 幂等迁移

**Files:**
- Modify: `backend/models.py`（`XSubscription` 217-227、`XPost` 230-248、`RefCollectRule` 712-730）
- Modify: `backend/database.py:42-66`（init_db 的 ADD COLUMN IF NOT EXISTS 块）
- Test: `backend/tests/test_models_schema.py`（新建）

- [ ] **Step 1: 写失败测试**

新建 `backend/tests/test_models_schema.py`：

```python
import sys, asyncio, pytest


@pytest.fixture
def db_session(monkeypatch, tmp_path):
    db_file = tmp_path / "t.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite+aiosqlite:///{db_file}")
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


def test_new_columns_exist_with_defaults(db_session):
    from models import XSubscription, XPost, RefCollectRule
    from datetime import datetime, timezone

    async def _run():
        async with db_session() as db:
            sub = XSubscription(url=None, label="s", kind="search",
                                raw_query="min_faves:1", added_at=datetime.now(timezone.utc))
            db.add(sub); await db.commit(); await db.refresh(sub)
            assert sub.kind == "search" and sub.raw_query == "min_faves:1"
            assert sub.sort == "top" and sub.max_results == 100

            post = XPost(tweet_id="t1", subscription_id=sub.id, username="u",
                         published_at=datetime.now(timezone.utc), possibly_sensitive=True)
            db.add(post); await db.commit(); await db.refresh(post)
            assert post.possibly_sensitive is True

            rule = RefCollectRule(label="r", source_subscription_id=sub.id,
                                  added_at=datetime.now(timezone.utc))
            db.add(rule); await db.commit(); await db.refresh(rule)
            assert rule.source_subscription_id == sub.id
    asyncio.new_event_loop().run_until_complete(_run())
```

- [ ] **Step 2: 运行确认失败**

Run: `cd backend && conda run -n wems python -m pytest tests/test_models_schema.py -v`
Expected: FAIL（`kind` / `possibly_sensitive` / `source_subscription_id` 不存在，或 `url=None` 违反 NOT NULL）

- [ ] **Step 3: 改 `XSubscription`（models.py 217-227）**

把 `url` 改可空，并加 `kind` + 搜索参数。替换整个类体字段为：

```python
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    url: Mapped[str | None] = mapped_column(String, unique=True, nullable=True, index=True)
    label: Mapped[str] = mapped_column(String, default="")
    kind: Mapped[str] = mapped_column(String, default="timeline")  # timeline | search
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    # search-only params (kind == "search")
    raw_query: Mapped[str] = mapped_column(String, default="")
    min_faves: Mapped[int] = mapped_column(Integer, default=0)
    min_retweets: Mapped[int] = mapped_column(Integer, default=0)
    lang: Mapped[str] = mapped_column(String, default="")
    days: Mapped[int] = mapped_column(Integer, default=1)
    extra_terms: Mapped[str] = mapped_column(String, default="")
    sort: Mapped[str] = mapped_column(String, default="top")
    max_results: Mapped[int] = mapped_column(Integer, default=100)
    last_collected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error: Mapped[str] = mapped_column(String, default="")
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, index=True)
```

- [ ] **Step 4: 改 `XPost`（models.py 230-248）**

在 `cover_image` 行后、`raw_markdown` 前加一行：

```python
    possibly_sensitive: Mapped[bool] = mapped_column(Boolean, default=False)
```

- [ ] **Step 5: 改 `RefCollectRule`（models.py 712-730）**

在 `platform` 字段行后加一行：

```python
    source_subscription_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
```

- [ ] **Step 6: 接入 init_db 幂等迁移（database.py，紧跟 x_posts 的 ADD COLUMN 块后，约第 48 行后）**

在 `cover_image` 那条 ALTER 之后插入（这些只在 Postgres 生效；sqlite 新库由 create_all 覆盖，故包在 `if not DATABASE_URL.startswith("sqlite")` 里）：

```python
        if not DATABASE_URL.startswith("sqlite"):
            await conn.execute(text("ALTER TABLE x_posts ADD COLUMN IF NOT EXISTS possibly_sensitive BOOLEAN NOT NULL DEFAULT FALSE"))
            await conn.execute(text("ALTER TABLE x_subscriptions ADD COLUMN IF NOT EXISTS kind VARCHAR NOT NULL DEFAULT 'timeline'"))
            await conn.execute(text("ALTER TABLE x_subscriptions ADD COLUMN IF NOT EXISTS raw_query VARCHAR NOT NULL DEFAULT ''"))
            await conn.execute(text("ALTER TABLE x_subscriptions ADD COLUMN IF NOT EXISTS min_faves INTEGER NOT NULL DEFAULT 0"))
            await conn.execute(text("ALTER TABLE x_subscriptions ADD COLUMN IF NOT EXISTS min_retweets INTEGER NOT NULL DEFAULT 0"))
            await conn.execute(text("ALTER TABLE x_subscriptions ADD COLUMN IF NOT EXISTS lang VARCHAR NOT NULL DEFAULT ''"))
            await conn.execute(text("ALTER TABLE x_subscriptions ADD COLUMN IF NOT EXISTS days INTEGER NOT NULL DEFAULT 1"))
            await conn.execute(text("ALTER TABLE x_subscriptions ADD COLUMN IF NOT EXISTS extra_terms VARCHAR NOT NULL DEFAULT ''"))
            await conn.execute(text("ALTER TABLE x_subscriptions ADD COLUMN IF NOT EXISTS sort VARCHAR NOT NULL DEFAULT 'top'"))
            await conn.execute(text("ALTER TABLE x_subscriptions ADD COLUMN IF NOT EXISTS max_results INTEGER NOT NULL DEFAULT 100"))
            await conn.execute(text("ALTER TABLE x_subscriptions ALTER COLUMN url DROP NOT NULL"))
            await conn.execute(text("ALTER TABLE ref_collect_rules ADD COLUMN IF NOT EXISTS source_subscription_id INTEGER"))
```

（`DATABASE_URL` 已在文件顶部导入；若该名不存在则用现有的判断变量，与第 33 行 `if not DATABASE_URL.startswith("sqlite")` 保持一致。）

- [ ] **Step 7: 运行测试确认通过**

Run: `cd backend && conda run -n wems python -m pytest tests/test_models_schema.py -v`
Expected: PASS

- [ ] **Step 8: 跑回归确认没破坏既有**

Run: `cd backend && conda run -n wems python -m pytest tests/test_x_router.py tests/test_ref_collector.py tests/test_ref_migrate.py -v`
Expected: 全 PASS（旧测试仍 mock search_top；本任务未动 collector）

- [ ] **Step 9: 提交**

```bash
git add backend/models.py backend/database.py backend/tests/test_models_schema.py
git commit -m "feat(model): X search subscription fields + XPost.possibly_sensitive + rule.source_subscription_id"
```

---

## Task 2: Raw search 采集（routers/x.py）

**Files:**
- Modify: `backend/routers/x.py`（`SubscriptionOut` 17-26、`SubscriptionCreate` 29-31、create 70-100、`_to_out` 48-57、`_upsert_post_stmt` 184-210、`_collect_one` 234-249）
- Test: `backend/tests/test_x_router.py`（追加）

- [ ] **Step 1: 写失败测试（追加到 test_x_router.py 末尾）**

```python
def test_create_search_subscription(client):
    r = client.post(BASE, json={
        "kind": "search", "label": "泛流量",
        "raw_query": "min_faves:1500 lang:zh", "max_results": 50,
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["kind"] == "search"
    assert body["label"] == "泛流量"
    assert body["url"] in (None, "")


def test_search_subscription_collect_calls_search_top(client):
    sub = client.post(BASE, json={
        "kind": "search", "raw_query": "min_faves:1500 lang:zh",
        "min_faves": 1500, "lang": "zh", "days": 2, "max_results": 30,
    }).json()

    mock = AsyncMock(return_value=[_fake_post("s1"), _fake_post("s2")])
    with patch("routers.x.search_top", new=mock):
        r = client.post(f"/api/x/subscriptions/{sub['id']}/collect-sync")
    assert r.status_code == 200, r.text
    assert r.json()["new_posts"] == 2

    # search_top got the stored params; grab_timeline NOT involved
    _, kwargs = mock.await_args
    assert kwargs["raw_query"] == "min_faves:1500 lang:zh"
    assert kwargs["limit"] == 30

    posts = client.get(f"/api/x/posts?subscription_id={sub['id']}").json()
    assert {p["tweet_id"] for p in posts} == {"s1", "s2"}


def test_search_subscription_create_requires_query(client):
    r = client.post(BASE, json={"kind": "search", "raw_query": ""})
    assert r.status_code == 400
```

- [ ] **Step 2: 运行确认失败**

Run: `cd backend && conda run -n wems python -m pytest tests/test_x_router.py -k "search_subscription or create_search" -v`
Expected: FAIL（create 不认 kind / search_top 未被调用）

- [ ] **Step 3: 扩展 schema（routers/x.py 17-36）**

`SubscriptionOut` 加字段（在 `url` 后）：

```python
    kind: str = "timeline"
    raw_query: str = ""
    min_faves: int = 0
    min_retweets: int = 0
    lang: str = ""
    days: int = 1
    extra_terms: str = ""
    sort: str = "top"
    max_results: int = 100
```

且 `url: Optional[str] = None`（改原 `url: int`/`str` 行为可空）。

`SubscriptionCreate` 整体替换为：

```python
class SubscriptionCreate(BaseModel):
    kind: str = "timeline"
    url: Optional[str] = None
    label: Optional[str] = None
    raw_query: str = ""
    min_faves: int = 0
    min_retweets: int = 0
    lang: str = ""
    days: int = 1
    extra_terms: str = ""
    sort: str = "top"
    max_results: int = 100
```

- [ ] **Step 4: `_to_out` 带出新字段（routers/x.py 48-57）**

替换 `_to_out` 的 return 为：

```python
    return SubscriptionOut(
        id=sub.id, url=sub.url, label=sub.label, kind=sub.kind, enabled=sub.enabled,
        raw_query=sub.raw_query, min_faves=sub.min_faves, min_retweets=sub.min_retweets,
        lang=sub.lang, days=sub.days, extra_terms=sub.extra_terms, sort=sub.sort,
        max_results=sub.max_results,
        last_collected_at=sub.last_collected_at, last_error=sub.last_error,
        added_at=sub.added_at, post_count=int(cnt),
    )
```

- [ ] **Step 5: create_subscription 分支（routers/x.py 70-100）**

整体替换函数体为：

```python
@router.post("/subscriptions", response_model=SubscriptionOut)
async def create_subscription(
    body: SubscriptionCreate, db: AsyncSession = Depends(get_db),
):
    if body.kind == "search":
        if not body.raw_query.strip():
            raise HTTPException(400, "搜索订阅需要 raw_query")
        label = body.label or f"搜索:{body.raw_query[:24]}"
        sub = XSubscription(
            kind="search", url=None, label=label, enabled=True,
            raw_query=body.raw_query.strip(), min_faves=body.min_faves,
            min_retweets=body.min_retweets, lang=body.lang, days=body.days,
            extra_terms=body.extra_terms, sort=body.sort, max_results=body.max_results,
            added_at=datetime.now(timezone.utc),
        )
        db.add(sub)
        await db.commit()
        await db.refresh(sub)
        return await _to_out(db, sub)

    url = (body.url or "").strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "URL 必须以 http(s):// 开头")
    existing = (await db.execute(
        select(XSubscription).where(XSubscription.url == url)
    )).scalars().first()
    if existing:
        raise HTTPException(400, "该 URL 已订阅")
    if body.label:
        label = body.label
    else:
        from feedgrab_client import resolve_subscription_label
        import asyncio
        label = await asyncio.to_thread(resolve_subscription_label, url)
        if not label:
            label = _default_label(url)
    sub = XSubscription(
        kind="timeline", url=url, label=label,
        enabled=True, added_at=datetime.now(timezone.utc),
    )
    db.add(sub)
    await db.commit()
    await db.refresh(sub)
    return await _to_out(db, sub)
```

- [ ] **Step 6: `_upsert_post_stmt` 带 possibly_sensitive（routers/x.py 184-210）**

在 `.values(...)` 里加一行 `possibly_sensitive=getattr(p, "possibly_sensitive", False),`（紧跟 `raw_markdown=p.raw_markdown,` 前）。on-conflict 的 `set_` 无需更新它（保留首采值即可）。

- [ ] **Step 7: `_collect_one` 按 kind 分支（routers/x.py 234-249）**

把 import 行（215）改为 `from feedgrab_client import grab_timeline, search_x, search_top, auth_status`。

替换 `_collect_one` 为：

```python
async def _collect_one(db: AsyncSession, sub: XSubscription) -> int:
    try:
        if sub.kind == "search":
            posts = await search_top(
                raw_query=sub.raw_query, min_faves=sub.min_faves,
                min_retweets=sub.min_retweets, lang=sub.lang, days=sub.days,
                extra_terms=sub.extra_terms, sort=sub.sort, limit=sub.max_results,
            )
        else:
            cutoff = await _compute_collect_cutoff(db, sub.id)
            posts = await grab_timeline(sub.url, since=cutoff)
    except Exception as e:
        sub.last_error = str(e)[:500]
        await db.commit()
        raise
    for p in posts:
        await db.execute(_upsert_post_stmt(db, sub.id, p))
    sub.last_collected_at = datetime.now(timezone.utc)
    sub.last_error = ""
    await db.commit()
    return len(posts)
```

- [ ] **Step 8: 运行新测试确认通过**

Run: `cd backend && conda run -n wems python -m pytest tests/test_x_router.py -v`
Expected: 全 PASS（含新增 3 个 + 旧的 timeline 用例）

- [ ] **Step 9: 提交**

```bash
git add backend/routers/x.py backend/tests/test_x_router.py
git commit -m "feat(x): search subscription kind -> search_top into x_posts; persist possibly_sensitive"
```

---

## Task 3: 参考库从 x_posts 取数精炼（ref_collector.py）

**Files:**
- Modify: `backend/ref_collector.py`（import 11-12、`collect_rule` 85-135）
- Test: `backend/tests/test_ref_collector.py`（改写 fixture 与用例的数据源）

- [ ] **Step 1: 改写测试，源从 mock search_top 换成 seed XPost**

替换 `test_ref_collector.py` 中三个 `collect_rule` 用例（`test_collect_rule_only_keeps_kept_and_writes_seen` / `_records_last_error_on_classify_failure` / `_skips_seen_ids`）所依赖的数据注入方式。新增一个 helper 并改用例：

```python
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
```

`_rule` 改为带 `source_subscription_id`：

```python
def _rule(db_session):
    from models import RefCollectRule
    async def _mk():
        async with db_session() as db:
            r = RefCollectRule(label="t", source_subscription_id=1,
                               min_faves=1, exclude_sensitive=True, days=7, max_results=20)
            db.add(r); await db.commit(); await db.refresh(r)
            return r.id
    return asyncio.new_event_loop().run_until_complete(_mk())
```

`test_collect_rule_only_keeps_kept_and_writes_seen`：删掉 `fake_search` 与对应 `patch.object(rc, "search_top", ...)`，改为在跑 collect 前 `_seed_xpost(db_session, "k1"); _seed_xpost(db_session, "d1")`，其余断言不变。

`test_collect_rule_records_last_error_on_classify_failure`：删 fake_search/patch search_top，改 `_seed_xpost(db_session, "k1")`。

`test_collect_rule_skips_seen_ids`：删 fake_search/patch search_top，改在 RefSeen 之外 `_seed_xpost(db_session, "already")`；断言 `kept == 0` 不变。

`test_prefilter_drops_sensitive_short_link_mention` 保持不变（直接测 `_prefilter`）。

- [ ] **Step 2: 运行确认失败**

Run: `cd backend && conda run -n wems python -m pytest tests/test_ref_collector.py -v`
Expected: FAIL（collect_rule 仍调 search_top，没读 XPost）

- [ ] **Step 3: 改 import（ref_collector.py 11-12）**

```python
from models import RefMaterial, RefCollectRule, RefSeen, XPost
from feedgrab_client import ParsedPost
```

（删掉 `search_top` import。`ParsedPost` 仍用于适配器构造。）

- [ ] **Step 4: 加 XPost→ParsedPost 适配器 + 改 collect_rule 取数（ref_collector.py 85-96）**

在 `collect_rule` 上方加：

```python
def _xpost_to_parsed(x: XPost) -> ParsedPost:
    return ParsedPost(
        tweet_id=x.tweet_id, username=x.username, display_name=x.display_name,
        content=x.content, url=x.url, published_at=x.published_at,
        replies=x.replies, reposts=x.reposts, likes=x.likes, views=x.views,
        author_avatar=x.author_avatar, cover_image=x.cover_image,
        raw_markdown=x.raw_markdown, possibly_sensitive=x.possibly_sensitive,
    )
```

把 `collect_rule` 开头的 try/except search_top 块（85-96）替换为查 XPost：

```python
async def collect_rule(db: AsyncSession, rule: RefCollectRule) -> int:
    """从 x_posts 取候选 → 粗筛 → LLM 精筛 → 入库。返回新入库/更新条目数。"""
    from datetime import timedelta
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
```

其后（原 98 行起）`seen = await _already_seen(...)` 直到函数结尾**保持不变**（变量 `posts` 名沿用）。

- [ ] **Step 5: 运行测试确认通过**

Run: `cd backend && conda run -n wems python -m pytest tests/test_ref_collector.py -v`
Expected: 全 PASS

- [ ] **Step 6: 提交**

```bash
git add backend/ref_collector.py backend/tests/test_ref_collector.py
git commit -m "feat(ref): collect_rule reads candidates from x_posts instead of live search_top"
```

---

## Task 4: 迁移旧规则 → search 订阅（ref_migrate.py）

**Files:**
- Modify: `backend/ref_migrate.py`（追加函数）
- Modify: `backend/database.py:120-126`（init_db 调用新迁移）
- Test: `backend/tests/test_ref_migrate.py`（追加）

- [ ] **Step 1: 写失败测试（追加到 test_ref_migrate.py 末尾）**

```python
def test_migrate_rules_to_search_subs_idempotent(env):
    from database import SessionLocal
    from models import RefCollectRule, XSubscription
    from ref_migrate import migrate_rules_to_search_subs
    from sqlalchemy import select
    from datetime import datetime, timezone

    async def _run():
        async with SessionLocal() as db:
            db.add(RefCollectRule(label="泛流量", raw_query="min_faves:1500 lang:zh",
                                  min_faves=1500, lang="zh", days=2, max_results=50,
                                  enabled=True, added_at=datetime.now(timezone.utc)))
            await db.commit()
        async with SessionLocal() as db:
            await migrate_rules_to_search_subs(db)
        async with SessionLocal() as db:
            await migrate_rules_to_search_subs(db)  # 第二次应 no-op
        async with SessionLocal() as db:
            subs = (await db.execute(select(XSubscription))).scalars().all()
            rules = (await db.execute(select(RefCollectRule))).scalars().all()
        assert len(subs) == 1
        assert subs[0].kind == "search" and subs[0].raw_query == "min_faves:1500 lang:zh"
        assert subs[0].label == "泛流量" and subs[0].url is None
        assert rules[0].source_subscription_id == subs[0].id
    asyncio.new_event_loop().run_until_complete(_run())
```

- [ ] **Step 2: 运行确认失败**

Run: `cd backend && conda run -n wems python -m pytest tests/test_ref_migrate.py -v`
Expected: FAIL（`migrate_rules_to_search_subs` 不存在）

- [ ] **Step 3: 实现迁移函数（追加到 ref_migrate.py 末尾）**

```python
async def migrate_rules_to_search_subs(db: AsyncSession) -> int:
    """把每条旧 RefCollectRule 的搜索参数迁成一个 kind=search 的 XSubscription，
    并回填 rule.source_subscription_id。幂等：已回填的规则跳过。"""
    from models import RefCollectRule, XSubscription
    from datetime import datetime, timezone

    rules = (await db.execute(select(RefCollectRule))).scalars().all()
    n = 0
    for r in rules:
        if r.source_subscription_id is not None:
            continue
        if not (r.raw_query or "").strip():
            continue
        sub = XSubscription(
            kind="search", url=None, label=r.label or f"搜索:{r.raw_query[:24]}",
            enabled=r.enabled, raw_query=r.raw_query, min_faves=r.min_faves,
            min_retweets=r.min_retweets, lang=r.lang, days=r.days,
            extra_terms=r.extra_terms, sort=r.sort, max_results=r.max_results,
            added_at=datetime.now(timezone.utc),
        )
        db.add(sub)
        await db.flush()  # 拿到 sub.id
        r.source_subscription_id = sub.id
        n += 1
    await db.commit()
    return n
```

确保文件顶部已有 `from sqlalchemy import select`（已存在）和 `from sqlalchemy.ext.asyncio import AsyncSession`（已存在）。

- [ ] **Step 4: init_db 调用（database.py 120-126，在 quotes 迁移之后）**

在 `await migrate_quotes_to_materials(db)` 之后、同一 try 内追加：

```python
        from ref_migrate import migrate_rules_to_search_subs
        async with SessionLocal() as db:
            await migrate_rules_to_search_subs(db)
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd backend && conda run -n wems python -m pytest tests/test_ref_migrate.py -v`
Expected: 全 PASS

- [ ] **Step 6: 全后端回归**

Run: `cd backend && conda run -n wems python -m pytest tests/test_x_router.py tests/test_ref_collector.py tests/test_ref_migrate.py tests/test_models_schema.py tests/test_materials_router.py tests/test_ref_scheduler.py -v`
Expected: 全 PASS

- [ ] **Step 7: 提交**

```bash
git add backend/ref_migrate.py backend/database.py backend/tests/test_ref_migrate.py
git commit -m "feat(migrate): old collect rules -> search subscriptions + backfill source_subscription_id"
```

---

## Task 5: 前端 API 客户端字段（x.ts / materials.ts）

**Files:**
- Modify: `web/lib/api/x.ts`（`XSubscription` interface、create 入参）
- Modify: `web/lib/api/materials.ts`（`CollectRule` interface、create/patch 入参）

- [ ] **Step 1: x.ts — XSubscription 加字段**

在 `XSubscription` interface 的 `url` 后加：

```typescript
  kind: 'timeline' | 'search'
  raw_query: string
  min_faves: number
  min_retweets: number
  lang: string
  days: number
  extra_terms: string
  sort: string
  max_results: number
```

`url` 类型改为 `string | null`。create 函数的入参类型放宽以接受 `kind` 与搜索参数（用 `Partial<...>` 或显式可选字段；保持与后端 `SubscriptionCreate` 一致）。

- [ ] **Step 2: materials.ts — CollectRule 加字段**

在 `CollectRule` interface 加 `source_subscription_id: number | null`；`createRule`/`updateRule` 的入参类型加可选 `source_subscription_id?: number`。

- [ ] **Step 3: typecheck**

Run: `source ~/.zshrc; cd web && npx tsc --noEmit`
Expected: 无新增类型错误（若仓库本就有既存错误，确认未新增与本改动相关者）

- [ ] **Step 4: 提交**

```bash
git add web/lib/api/x.ts web/lib/api/materials.ts
git commit -m "feat(ui-api): X subscription kind+search fields; CollectRule source_subscription_id"
```

---

## Task 6: X 订阅管理抽屉支持「搜索订阅」（XClient.tsx）

**Files:**
- Modify: `web/app/x/XClient.tsx`（订阅管理 Dialog 510+、添加订阅表单、列表项徽标）

- [ ] **Step 1: 在订阅管理 Dialog 里加「类型」切换**

在添加订阅的表单区，加一个 timeline/search 切换（如两个小 Button 或 Tabs）。`kind="timeline"` 时显示现有 URL 输入；`kind="search"` 时显示：`raw_query`（必填，textarea/input）、`min_faves`、`lang`、`days`、`max_results`（可给默认值 1500/zh/2/50）。提交时按 kind 组装 body 调 create。

参考现有 create 调用处（`XClient.tsx` ~55-72）的 `createXSubscription`，把 body 从 `{url, label}` 扩展为按 kind 分支的对象。

- [ ] **Step 2: 列表项显示 kind 徽标**

在订阅列表项（~570-610）label 旁加一个小徽标：`s.kind === 'search' ? '搜索' : '时间线'`（沿用项目既有 badge 样式，如 `text-[10px] px-1 rounded bg-zinc-100`）。

- [ ] **Step 3: 手测 + build**

Run: `source ~/.zshrc; cd web && npm run build`
Expected: build 成功。随后跑起服务（见 dev.sh），在 X 页「订阅管理」新建一个搜索订阅，点「立即采集」，确认 x_posts 有新帖（或 toast 显示新增数）。

- [ ] **Step 4: 提交**

```bash
git add web/app/x/XClient.tsx
git commit -m "feat(ui): X subscription manager supports search-type subscriptions"
```

---

## Task 7: 参考库采集抽屉改为「选取规则」（MaterialsClient.tsx）

**Files:**
- Modify: `web/app/materials/MaterialsClient.tsx`（`RulesDrawer` 180-300）

- [ ] **Step 1: 新建规则表单换成订阅选择器**

`RulesDrawer` 里把 `rawQuery` 输入替换为**来源订阅下拉选择器**（必选一个 X 订阅）。加载订阅列表用 `getXSubscriptions()`（from `@/lib/api/x`）。`createRule` 入参从 `{label, min_faves, lang, days, raw_query}` 改为 `{label, source_subscription_id, min_faves, days, max_results}`。文案「采集规则（X 泛流量）」→「选取规则」，「raw_query」相关说明删除。

- [ ] **Step 2: 列表项显示来源订阅**

每条规则项显示其 `source_subscription_id` 对应订阅的 label（用已加载的订阅列表做 id→label 映射）。「立即采集」按钮文案/语义不变（后端已改为从 x_posts 精炼）。

- [ ] **Step 3: build + 手测**

Run: `source ~/.zshrc; cd web && npm run build`
Expected: build 成功。手测：在参考文案库「选取规则」新建一条指向某搜索订阅的规则，点「立即采集」，确认 toast 显示新增条数、参考库出现精炼条目。

- [ ] **Step 4: 提交**

```bash
git add web/app/materials/MaterialsClient.tsx
git commit -m "feat(ui): materials collect rules -> selection rules picking a source subscription"
```

---

## 收尾验证

- [ ] 全后端测试：`cd backend && conda run -n wems python -m pytest tests/ -q` 全绿
- [ ] 前端 build 成功
- [ ] 端到端手测：新建搜索订阅 → 采集进 x_posts → 选取规则从 x_posts 精炼 → 参考库出条目
- [ ] 用 finishing-a-development-branch 决定合并/PR
