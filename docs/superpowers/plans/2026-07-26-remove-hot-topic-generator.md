# Remove Hot Topic Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Completely remove the hot-topic generator runtime, cached data, and X-response conversion path while keeping daily-plan creation and enqueue behavior intact.

**Architecture:** Add one idempotent database cleanup boundary that migrates historical X-response state and removes the obsolete cache table before current metadata is created. Then remove the backend/frontend feature surfaces and move the two daily-plan content constants into the surviving daily-plan module. Historical design documents remain as project records.

**Tech Stack:** FastAPI, SQLAlchemy async, PostgreSQL/SQLite, Next.js 16, React 19, TypeScript, Pytest, Vitest.

## Global Constraints

- Delete `topic_generator_cache` and all cached rows.
- Migrate every historical `x_response_decisions.workflow_status = 'converted'` row to `used`.
- Keep daily-plan generation and draft-job enqueue behavior.
- Keep historical files under `docs/superpowers/specs` and `docs/superpowers/plans`.
- Do not delete existing `PipelineTask`, content-job, draft, publication, or publishing history.
- Preserve the user-owned untracked `.superpowers/brainstorm/` directory.

---

### Task 1: Remove the obsolete database schema and data

**Files:**
- Create: `backend/tests/test_database_hot_topic_removal.py`
- Modify: `backend/database.py`
- Modify: `backend/models.py`

**Interfaces:**
- Produces: `async def migrate_removed_hot_topic_schema(conn) -> None`
- Consumes: an SQLAlchemy `AsyncConnection` for SQLite or PostgreSQL.

- [ ] **Step 1: Write the failing migration tests**

Create `backend/tests/test_database_hot_topic_removal.py`:

```python
import asyncio

from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import create_async_engine


def test_removed_hot_topic_schema_migrates_state_drops_cache_and_is_idempotent(tmp_path):
    from database import migrate_removed_hot_topic_schema

    engine = create_async_engine(
        f"sqlite+aiosqlite:///{tmp_path / 'hot-topic-removal.db'}",
    )

    async def run():
        async with engine.begin() as connection:
            await connection.execute(text(
                "CREATE TABLE x_response_decisions "
                "(id INTEGER PRIMARY KEY, workflow_status VARCHAR NOT NULL)"
            ))
            await connection.execute(text(
                "INSERT INTO x_response_decisions (id, workflow_status) "
                "VALUES (1, 'converted'), (2, 'ignored')"
            ))
            await connection.execute(text(
                "CREATE TABLE topic_generator_cache "
                "(id INTEGER PRIMARY KEY, topics JSON)"
            ))
            await migrate_removed_hot_topic_schema(connection)
            await migrate_removed_hot_topic_schema(connection)
            statuses = (
                await connection.execute(text(
                    "SELECT id, workflow_status FROM x_response_decisions ORDER BY id"
                ))
            ).all()
            tables = set(await connection.run_sync(
                lambda sync_connection: inspect(sync_connection).get_table_names()
            ))
        await engine.dispose()
        return statuses, tables

    statuses, tables = asyncio.run(run())

    assert statuses == [(1, "used"), (2, "ignored")]
    assert "topic_generator_cache" not in tables


def test_removed_hot_topic_schema_accepts_database_without_legacy_tables(tmp_path):
    from database import migrate_removed_hot_topic_schema

    engine = create_async_engine(
        f"sqlite+aiosqlite:///{tmp_path / 'empty.db'}",
    )

    async def run():
        async with engine.begin() as connection:
            await migrate_removed_hot_topic_schema(connection)
        await engine.dispose()

    asyncio.run(run())
```

- [ ] **Step 2: Run the migration tests and verify RED**

Run:

```bash
cd backend
conda run --no-capture-output -n wems python -m pytest \
  tests/test_database_hot_topic_removal.py -q
```

Expected: FAIL because `migrate_removed_hot_topic_schema` does not exist.

- [ ] **Step 3: Implement the idempotent cleanup**

Add to `backend/database.py`:

```python
async def migrate_removed_hot_topic_schema(conn) -> None:
    """Remove the retired topic generator while preserving processed history."""
    from sqlalchemy import inspect, text

    tables = set(await conn.run_sync(
        lambda sync_connection: inspect(sync_connection).get_table_names()
    ))
    if "x_response_decisions" in tables:
        await conn.execute(text(
            "UPDATE x_response_decisions "
            "SET workflow_status = 'used' "
            "WHERE workflow_status = 'converted'"
        ))
    await conn.execute(text("DROP TABLE IF EXISTS topic_generator_cache"))
```

Call it in `init_db()` before `Base.metadata.create_all`:

```python
await migrate_removed_hot_topic_schema(conn)
await conn.run_sync(Base.metadata.create_all)
```

Remove `TopicGeneratorCache` from `backend/models.py` so `create_all` cannot recreate the table.

- [ ] **Step 4: Run migration and schema tests and verify GREEN**

Run:

```bash
cd backend
conda run --no-capture-output -n wems python -m pytest \
  tests/test_database_hot_topic_removal.py \
  tests/test_database_x_response_migration.py \
  tests/test_models_schema.py -q
```

Expected: all tests pass.

- [ ] **Step 5: Commit the schema removal**

```bash
git add backend/database.py backend/models.py \
  backend/tests/test_database_hot_topic_removal.py
git commit -m "refactor(db): remove hot topic generator cache"
```

---

### Task 2: Remove backend routes and decouple daily plans

**Files:**
- Modify: `backend/tests/test_x_responses_router.py`
- Modify: `backend/tests/test_daily_plan_router.py`
- Modify: `backend/main.py`
- Modify: `backend/routers/x_responses.py`
- Modify: `backend/routers/daily_plan.py`
- Delete: `backend/routers/topic_generator.py`

**Interfaces:**
- Removes: `/api/topic-generator/generate`, `/api/topic-generator/cached`, `/api/topic-generator/enqueue`
- Removes: `POST /api/x/responses/{decision_id}/convert-to-topic`
- Preserves: `POST /api/daily-plan/{plan_id}/enqueue`

- [ ] **Step 1: Change tests to specify the removed routes and surviving daily plan**

Replace the conversion assertions in
`backend/tests/test_x_responses_router.py::test_feedback_and_convert_are_idempotent`
with:

```python
def test_feedback_is_idempotent_and_convert_route_is_removed(client):
    decision = client.post(
        "/api/x/responses/internal/t1/decision",
        json=_decision_body(),
    ).json()

    used = client.post(
        f"/api/x/responses/{decision['id']}/feedback",
        json={"status": "used"},
    )
    assert used.status_code == 200
    assert used.json()["workflow_status"] == "used"
    assert client.post(
        f"/api/x/responses/{decision['id']}/feedback",
        json={"status": "used"},
    ).status_code == 200

    converted = client.post(
        f"/api/x/responses/{decision['id']}/convert-to-topic",
    )
    assert converted.status_code == 404
```

Add to the existing daily-plan enqueue test after capturing the dispatched
context:

```python
assert captured[0][1]["content_type_label"]
assert captured[0][1]["word_range"]
```

- [ ] **Step 2: Run targeted backend tests and verify RED**

Run:

```bash
cd backend
conda run --no-capture-output -n wems python -m pytest \
  tests/test_x_responses_router.py \
  tests/test_daily_plan_router.py -q
```

Expected: the conversion route test fails with HTTP 200 instead of 404.

- [ ] **Step 3: Remove the backend feature**

In `backend/main.py`, remove `topic_generator` from the router import and remove:

```python
app.include_router(topic_generator.router, prefix="/api")
```

Delete `backend/routers/topic_generator.py`.

Delete `convert_to_topic()` and its route decorator from
`backend/routers/x_responses.py`.

In `backend/routers/daily_plan.py`, define:

```python
_WORD_RANGE: dict[str, str] = {
    "long": "1500-3000 字",
    "short": "200-500 字",
    "story": "5-6 句话",
    "share": "3-5 句话",
}

_TYPE_LABEL: dict[str, str] = {
    "long": "长文",
    "short": "短文",
    "story": "微故事",
    "share": "发现",
}
```

Remove the local import:

```python
from routers.topic_generator import _TYPE_LABEL, _WORD_RANGE
```

- [ ] **Step 4: Run targeted backend tests and verify GREEN**

Run:

```bash
cd backend
conda run --no-capture-output -n wems python -m pytest \
  tests/test_x_responses_router.py \
  tests/test_daily_plan_router.py \
  tests/test_daily_plan_models.py -q
```

Expected: all tests pass.

- [ ] **Step 5: Commit backend route removal**

```bash
git add backend/main.py backend/routers/daily_plan.py \
  backend/routers/x_responses.py backend/tests/test_x_responses_router.py \
  backend/tests/test_daily_plan_router.py
git rm backend/routers/topic_generator.py
git commit -m "refactor(api): remove hot topic generator routes"
```

---

### Task 3: Remove frontend feature surfaces

**Files:**
- Modify: `web/app/x-responses/x-responses-layout.test.tsx`
- Modify: `web/app/x-responses/XResponsesClient.tsx`
- Modify: `web/lib/api/x-responses.ts`
- Modify: `web/components/features/Sidebar.tsx`
- Modify: `README.md`
- Delete: `web/app/trend-topics/TopicGeneratorClient.tsx`
- Delete: `web/app/trend-topics/page.tsx`
- Delete: `web/app/trend-topics/converted-responses.ts`
- Delete: `web/app/trend-topics/converted-responses.test.ts`
- Delete: `web/lib/api/topic-generator.ts`

**Interfaces:**
- Removes: `/trend-topics`
- Removes: `convertXResponseToTopic(id)`
- Narrows: `XResponseWorkflowStatus` to `'ready' | 'used' | 'ignored'`

- [ ] **Step 1: Write failing frontend absence assertions**

Update `web/app/x-responses/x-responses-layout.test.tsx` to read the
sidebar and X API sources and assert:

```typescript
expect(inbox).not.toContain('转为选题')
expect(inbox).not.toContain('convertXResponseToTopic')
expect(sidebar).not.toContain('/trend-topics')
expect(sidebar).not.toContain('热点选题')
expect(xResponseApi).not.toContain('convert-to-topic')
expect(xResponseApi).not.toContain("'converted'")
```

- [ ] **Step 2: Run the layout test and verify RED**

Run:

```bash
cd web
pnpm test app/x-responses/x-responses-layout.test.tsx
```

Expected: FAIL because the UI, route, and status still exist.

- [ ] **Step 3: Remove the frontend feature**

Delete the `app/trend-topics` directory and `lib/api/topic-generator.ts`.

In `XResponsesClient.tsx`:

- remove `FileInput`;
- remove `convertXResponseToTopic`;
- remove the `onConvert` prop and mutation;
- remove the “转为选题” button;
- remove the `converted` label branch.

In `lib/api/x-responses.ts`, change:

```typescript
export type XResponseWorkflowStatus = 'ready' | 'used' | 'ignored'
```

Delete `convertXResponseToTopic()`.

In `Sidebar.tsx`, remove the `/trend-topics` item and the unused `Lightbulb`
import.

In `README.md`, remove “热点选题” from the active route list.

- [ ] **Step 4: Run targeted frontend tests and typecheck**

Run:

```bash
cd web
pnpm test app/x-responses/x-responses-layout.test.tsx \
  app/x-responses/x-response-telegram-status.test.tsx
pnpm exec tsc --noEmit
```

Expected: tests and TypeScript check pass.

- [ ] **Step 5: Commit frontend removal**

```bash
git add README.md web/app/x-responses \
  web/lib/api/x-responses.ts \
  web/components/features/Sidebar.tsx
git rm -r web/app/trend-topics \
  web/lib/api/topic-generator.ts
git commit -m "refactor(ui): remove hot topic generator"
```

---

### Task 4: Verify no runtime residue and apply the migration

**Files:**
- Verify only; no planned source changes.

**Interfaces:**
- Confirms the current product has no hot-topic runtime surface.

- [ ] **Step 1: Scan current runtime code and README**

Run:

```bash
rg -n -i \
  "topic-generator|trend-topics|TopicGeneratorCache|转为选题|热点选题" \
  backend web README.md \
  --glob '!**/node_modules/**' --glob '!**/.next/**'
```

Expected: no matches.

- [ ] **Step 2: Run the full backend suite**

Run:

```bash
cd backend
conda run --no-capture-output -n wems python -m pytest -q
```

Expected: all tests pass with zero failures.

- [ ] **Step 3: Run the full frontend suite**

Run:

```bash
cd web
pnpm test
pnpm exec tsc --noEmit
pnpm build
```

Expected: all tests, typecheck, and production build pass; the route table does
not contain `/trend-topics`.

- [ ] **Step 4: Apply and inspect the local development migration**

Restart the backend development service so `init_db()` runs, then inspect the
database without printing secrets:

```bash
cd backend
conda run --no-capture-output -n wems python - <<'PY'
import asyncio
from sqlalchemy import inspect, text
from database import engine

async def main():
    async with engine.connect() as connection:
        tables = set(await connection.run_sync(
            lambda sync_connection: inspect(sync_connection).get_table_names()
        ))
        converted = 0
        if "x_response_decisions" in tables:
            converted = int((await connection.execute(text(
                "SELECT COUNT(*) FROM x_response_decisions "
                "WHERE workflow_status = 'converted'"
            ))).scalar_one())
        print(f"topic_generator_cache_present={'topic_generator_cache' in tables}")
        print(f"converted_rows={converted}")
    await engine.dispose()

asyncio.run(main())
PY
```

Expected:

```text
topic_generator_cache_present=False
converted_rows=0
```

- [ ] **Step 5: Confirm the final diff**

Run:

```bash
git status --short
git diff --check HEAD~3..HEAD
git log -4 --oneline
```

Expected: only the pre-existing `.superpowers/brainstorm/` remains untracked,
the diff check is clean, and the three implementation commits follow the
design commit.
