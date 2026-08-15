# Remove Publication Records Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Completely remove the publication-record page, API, model, and stored statistics while preserving draft publishing and publish-account profiles.

**Architecture:** Add an idempotent startup migration that drops the obsolete `publications` table before current metadata is created. Remove the backend CRUD surface and the best-effort record write from WeChat publishing, then delete the frontend record-management page and navigation entry without changing the retained publish dialog.

**Tech Stack:** FastAPI, SQLAlchemy async, PostgreSQL/SQLite, Pytest, Next.js 16, React 19, TypeScript, Vitest.

## Global Constraints

- Delete the `publications` table and every historical publication-record row.
- Remove the `/api/published-articles` API and `/published` page.
- Preserve the draft-box "发布" button and unified publishing dialog.
- Preserve WeChat draft upload, X long-form copying, and Blog submission.
- Preserve publish-account profiles, credentials, voice/style settings, and all account-selection consumers.
- Preserve drafts, writing plans, content jobs, assets, and platform-side content.
- Do not remove information-source `published_at` fields.
- Preserve historical files under `docs/superpowers/specs` and `docs/superpowers/plans`.
- Preserve the user-owned untracked `.superpowers/brainstorm/` directory.

---

### Task 1: Remove the publication-record database schema

**Files:**
- Create: `backend/tests/test_database_publication_removal.py`
- Modify: `backend/database.py`

**Interfaces:**
- Produces: `async def migrate_removed_publication_schema(conn) -> None`
- Consumes: an SQLAlchemy `AsyncConnection` for SQLite or PostgreSQL.

- [ ] **Step 1: Write the failing migration tests**

Create `backend/tests/test_database_publication_removal.py`:

```python
import asyncio

from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import create_async_engine


def test_removed_publication_schema_drops_rows_and_is_idempotent(tmp_path):
    from database import migrate_removed_publication_schema

    engine = create_async_engine(
        f"sqlite+aiosqlite:///{tmp_path / 'publication-removal.db'}",
    )

    async def run():
        async with engine.begin() as connection:
            await connection.execute(text(
                "CREATE TABLE publications "
                "(id INTEGER PRIMARY KEY, title VARCHAR NOT NULL)"
            ))
            await connection.execute(text(
                "INSERT INTO publications (id, title) VALUES (1, '历史记录')"
            ))
            await migrate_removed_publication_schema(connection)
            await migrate_removed_publication_schema(connection)
            tables = set(await connection.run_sync(
                lambda sync_connection: inspect(sync_connection).get_table_names()
            ))
        await engine.dispose()
        return tables

    assert "publications" not in asyncio.run(run())


def test_removed_publication_schema_accepts_database_without_legacy_table(tmp_path):
    from database import migrate_removed_publication_schema

    engine = create_async_engine(
        f"sqlite+aiosqlite:///{tmp_path / 'empty.db'}",
    )

    async def run():
        async with engine.begin() as connection:
            await migrate_removed_publication_schema(connection)
        await engine.dispose()

    asyncio.run(run())
```

- [ ] **Step 2: Run the migration tests and verify RED**

Run:

```bash
cd backend
conda run --no-capture-output -n wems python -m pytest \
  tests/test_database_publication_removal.py -q
```

Expected: collection fails because
`migrate_removed_publication_schema` is not defined.

- [ ] **Step 3: Implement the idempotent cleanup**

Add to `backend/database.py`:

```python
async def migrate_removed_publication_schema(conn) -> None:
    """Remove the retired publication-record and statistics store."""
    from sqlalchemy import text

    await conn.execute(text("DROP TABLE IF EXISTS publications"))
```

Do not call the migration from `init_db()` yet and do not remove the model in
this task. Wiring the migration before removing the model would cause
`Base.metadata.create_all` to recreate the table; removing the model before its
router consumers would temporarily break backend imports. Task 2 performs those
dependent changes atomically.

- [ ] **Step 4: Run migration and schema tests and verify GREEN**

Run:

```bash
cd backend
conda run --no-capture-output -n wems python -m pytest \
  tests/test_database_publication_removal.py \
  tests/test_database_hot_topic_removal.py -q
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit the database removal**

```bash
git add backend/database.py backend/tests/test_database_publication_removal.py
git commit -m "refactor(db): remove publication records"
```

---

### Task 2: Remove the publication API without breaking WeChat publishing

**Files:**
- Modify: `backend/tests/test_wechat_publish.py`
- Modify: `backend/database.py`
- Modify: `backend/models.py`
- Modify: `backend/main.py`
- Modify: `backend/mcp_server.py`
- Modify: `backend/routers/drafts.py`
- Modify: `backend/schemas.py`
- Modify: `backend/tests/test_mcp_daily_plan_tools.py`
- Delete: `backend/routers/published.py`
- Delete: `backend/tests/test_published.py`

**Interfaces:**
- Consumes: `async def migrate_removed_publication_schema(conn) -> None`.
- Removes: all methods under `/api/published-articles`.
- Preserves: `POST /api/write/drafts/{draft_id}/publish/wechat`.
- Preserves: `WechatPublishResponse(media_id: str)`.

- [ ] **Step 1: Change the WeChat test to specify the surviving behavior and removed API**

In `backend/tests/test_wechat_publish.py`, replace
`test_publish_creates_publication_record` and
`test_publish_record_failure_is_non_fatal` with:

```python
def test_publish_succeeds_without_publication_record_api(
    client, uploads_dir, wx_mock
):
    draft, img = _setup_draft_with_image(client)
    html = f'<section><p>正文</p><img src="{img["url"]}"></section>'

    response = client.post(
        f"/api/write/drafts/{draft['id']}/publish/wechat",
        json={
            "account_id": "gzh",
            "title": "测试文章",
            "digest": "摘要",
            "html": html,
            "cover_image_id": img["id"],
        },
    )

    assert response.status_code == 200, response.text
    assert response.json()["media_id"] == "DRAFT_MEDIA_1"
    assert client.get("/api/published-articles").status_code == 404
    assert client.post(
        "/api/published-articles",
        json={"draft_id": draft["id"], "account_id": "gzh", "title": "测试文章"},
    ).status_code == 404
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd backend
conda run --no-capture-output -n wems python -m pytest \
  tests/test_wechat_publish.py::test_publish_succeeds_without_publication_record_api \
  -q
```

Expected: FAIL because `/api/published-articles` still returns HTTP 200/201.

- [ ] **Step 3: Remove the backend record-management layer**

In `backend/main.py`:

- Remove `published` from the `from routers import ...` list.
- Remove `app.include_router(published.router, prefix="/api")`.

Delete `backend/routers/published.py`.

In `backend/database.py`, call the migration after
`migrate_removed_hot_topic_schema(conn)` and before metadata creation:

```python
await migrate_removed_hot_topic_schema(conn)
await migrate_removed_publication_schema(conn)
await conn.run_sync(Base.metadata.create_all)
```

Delete the complete `Publication` model from `backend/models.py`. With the
migration wired before metadata creation and the model absent, the table cannot
be recreated.

Delete `PublicationCreate`, `PublicationUpdate`, and `PublicationOut` from
`backend/schemas.py`.

Delete the `get_recent_performance` MCP tool from `backend/mcp_server.py` and
its two publication-backed tests from
`backend/tests/test_mcp_daily_plan_tools.py`.

In `backend/routers/drafts.py`:

- Remove `Publication` from the models import.
- Delete the complete best-effort publication-record block after
  `media_id = await wx.add_draft(...)`.
- Return `WechatPublishResponse(media_id=media_id)` immediately after the
  existing WeChat/network exception handlers.

The resulting tail of the WeChat endpoint must be:

```python
    except wx.WechatApiError as e:
        raise HTTPException(502, str(e))
    except httpx.HTTPError as e:
        raise HTTPException(502, f"微信接口网络请求失败: {e}")
    return WechatPublishResponse(media_id=media_id)
```

Delete `backend/tests/test_published.py` because the CRUD contract it tests no
longer exists.

- [ ] **Step 4: Run focused backend tests and verify GREEN**

Run:

```bash
cd backend
conda run --no-capture-output -n wems python -m pytest \
  tests/test_database_publication_removal.py \
  tests/test_models_schema.py \
  tests/test_wechat_publish.py \
  tests/test_blog_publish.py \
  tests/test_mcp_daily_plan_tools.py -q
```

Expected: all selected tests pass. This proves the removed record API does not
remove publish-account or actual publishing behavior.

- [ ] **Step 5: Scan the backend for retired runtime references**

Run:

```bash
rg -n "Publication(Create|Update|Out)?|published-articles|routers import.*published" \
  backend --glob '!backend/tests/**' \
  --glob '!**/__pycache__/**'
```

Expected: no runtime matches. Test-only 404 request strings remain excluded.

- [ ] **Step 6: Commit the backend removal**

```bash
git add backend/database.py backend/models.py backend/main.py \
  backend/mcp_server.py backend/routers/drafts.py backend/schemas.py \
  backend/tests/test_mcp_daily_plan_tools.py backend/tests/test_wechat_publish.py
git add -u backend/routers/published.py backend/tests/test_published.py
git commit -m "refactor(api): remove publication record routes"
```

---

### Task 3: Remove the publication-record frontend

**Files:**
- Modify: `web/components/features/Sidebar.tsx`
- Modify: `README.md`
- Delete: `web/app/published/page.tsx`
- Delete: `web/app/published/PublishedClient.tsx`
- Delete: `web/lib/api/published.ts`

**Interfaces:**
- Removes: the `/published` Next.js route and publication-record API client.
- Preserves: `PublishDialog` and its `wechat`, `x`, and `blog` tabs.

- [ ] **Step 1: Verify the existing page before removal (RED)**

Run:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  http://127.0.0.1:3000/published
```

Expected: `200`, proving the user-visible page exists before the change and
would fail the desired 404 contract.

- [ ] **Step 2: Delete the frontend record-management layer**

- Delete `web/app/published/page.tsx`.
- Delete `web/app/published/PublishedClient.tsx`.
- Delete `web/lib/api/published.ts`.
- Remove the `/published` item from `Sidebar.tsx`.
- Remove the now-unused `Send` import from `Sidebar.tsx`.
- In `README.md`, change the page list from:

```text
今日工作台 / 今日计划 / 创作任务 / AI 助手 / 草稿箱 / 写作模板 / 创作资产 / 待响应 / 发布 / 各信息源 / 设置。
```

to:

```text
今日工作台 / 今日计划 / 创作任务 / AI 助手 / 草稿箱 / 写作模板 / 创作资产 / 待响应 / 各信息源 / 设置。
```

- [ ] **Step 3: Regenerate route types, type-check, and verify GREEN**

Run:

```bash
cd web
pnpm exec next typegen
pnpm exec tsc --noEmit
curl -sS -o /dev/null -w '%{http_code}\n' \
  http://127.0.0.1:3000/published
```

Expected: both build-time commands exit 0, generated route types contain no
`/published` route, and the running development server returns `404`. Because
`DraftsClient` still imports `PublishDialog`, type-checking also protects the
retained draft publishing surface from accidental deletion.

- [ ] **Step 4: Commit the frontend removal**

```bash
git add README.md \
  web/components/features/Sidebar.tsx
git add -u web/app/published \
  web/lib/api/published.ts
git commit -m "refactor(ui): remove publication records page"
```

---

### Task 4: Apply the destructive migration and verify the retained system

**Files:**
- No new product files.
- Verify all files changed in Tasks 1-3.

**Interfaces:**
- Consumes: `migrate_removed_publication_schema(conn)`.
- Produces: a running application with no publication-record surface.

- [ ] **Step 1: Run the real database migration and inspect the schema**

Run:

```bash
cd backend
conda run --no-capture-output -n wems python - <<'PY'
import asyncio
from dotenv import load_dotenv
from sqlalchemy import inspect

load_dotenv(".env")

from database import engine, init_db


async def main():
    await init_db()
    async with engine.connect() as connection:
        tables = set(await connection.run_sync(
            lambda sync_connection: inspect(sync_connection).get_table_names()
        ))
    print(f"publications_present={'publications' in tables}")
    await engine.dispose()


asyncio.run(main())
PY
```

Expected: `publications_present=False`.

- [ ] **Step 2: Run the complete backend suite**

Run:

```bash
cd backend
conda run --no-capture-output -n wems python -m pytest -q
```

Expected: exit 0 with no failures.

- [ ] **Step 3: Run the complete frontend suite and production checks**

Run:

```bash
cd web
pnpm test
pnpm exec next typegen
pnpm exec tsc --noEmit
pnpm build
```

Expected: every command exits 0 and the production route list contains no
`/published`.

- [ ] **Step 4: Verify runtime routes**

With the development backend and frontend running, execute:

```bash
curl -sS -o /dev/null -w 'backend_removed=%{http_code}\n' \
  http://127.0.0.1:8000/api/published-articles
curl -sS -o /dev/null -w 'frontend_removed=%{http_code}\n' \
  http://127.0.0.1:3000/published
curl -sS -o /dev/null -w 'drafts_preserved=%{http_code}\n' \
  http://127.0.0.1:3000/drafts
curl -sS -o /dev/null -w 'publish_accounts_preserved=%{http_code}\n' \
  http://127.0.0.1:8000/api/publish-accounts
```

Expected:

```text
backend_removed=404
frontend_removed=404
drafts_preserved=200
publish_accounts_preserved=200
```

- [ ] **Step 5: Run final source and Git checks**

Run:

```bash
rg -n "published-articles|Publication(Create|Update|Out)?|href: '/published'" \
  backend web README.md \
  --glob '!backend/tests/**' \
  --glob '!**/*.test.*' \
  --glob '!**/.next/**' \
  --glob '!**/node_modules/**'
git diff --check
git status --short --branch
```

Expected:

- No retired runtime references.
- `git diff --check` exits 0.
- The only unrelated status entry is the pre-existing
  `?? .superpowers/brainstorm/`.
