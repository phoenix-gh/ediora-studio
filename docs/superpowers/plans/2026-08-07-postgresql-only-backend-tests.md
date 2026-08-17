# PostgreSQL-only Backend Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every SQLite-backed backend test with an isolated PostgreSQL test database and remove unsupported SQLite runtime compatibility.

**Architecture:** A test-only utility creates one uniquely named `wemedia_test_<hex>` database per database-backed pytest test, yields its async SQLAlchemy URL, terminates leftover sessions, and drops only safety-validated test databases. Existing module-reload fixtures consume that URL through `DATABASE_URL`; schema migration tests construct PostgreSQL legacy schemas directly and then invoke the real migration code.

**Tech Stack:** Python 3.11, pytest, SQLAlchemy async, asyncpg, FastAPI TestClient, PostgreSQL 16.

## Global Constraints

- Never create, truncate, alter, or drop the development database named `wemedia`.
- A cleanup target must match `^wemedia_test_[0-9a-f]{12}$` before any termination or drop statement is issued.
- The administrative URL defaults to `postgresql+asyncpg://wemedia:wemedia@127.0.0.1:55432/postgres` and is overridable only through `TEST_DATABASE_ADMIN_URL`.
- Every database-backed test gets a unique database; the design must remain safe under pytest-xdist parallel execution.
- Use `/home/violet/miniconda3/envs/wems/bin/python -m pytest` for backend verification.
- Preserve unrelated changes in the dirty worktree and stage only files named by the active task.
- Do not retain SQLite-specific tests as dormant compatibility tests.

---

### Task 1: Safe PostgreSQL Test Database Lifecycle

**Files:**
- Create: `backend/tests/postgres_test_db.py`
- Create: `backend/tests/conftest.py`
- Create: `backend/tests/test_postgres_test_db.py`

**Interfaces:**
- Produces: `validate_test_database_name(name: str) -> str`
- Produces: `replace_database_name(url: str, database_name: str) -> str`
- Produces: `create_test_database(admin_url: str, database_name: str) -> None`
- Produces: `drop_test_database(admin_url: str, database_name: str, *, missing_ok: bool = False) -> None`
- Produces fixture: `postgres_database_url: str`
- Produces fixture: `postgres_env: str`, which sets `DATABASE_URL` and `DISABLE_SCHEDULER=1`

- [ ] **Step 1: Write safety tests before the helper exists**

```python
import pytest

from tests.postgres_test_db import (
    replace_database_name,
    validate_test_database_name,
)


@pytest.mark.parametrize("name", [
    "wemedia",
    "postgres",
    "wemedia_test_",
    "wemedia_test_deadbeef;drop database wemedia",
    "other_test_deadbeef0000",
])
def test_cleanup_rejects_every_non_generated_database_name(name):
    with pytest.raises(ValueError, match="unsafe PostgreSQL test database"):
        validate_test_database_name(name)


def test_cleanup_accepts_generated_database_name():
    assert validate_test_database_name("wemedia_test_012345abcdef") == (
        "wemedia_test_012345abcdef"
    )


def test_database_url_replacement_preserves_driver_and_credentials():
    actual = replace_database_name(
        "postgresql+asyncpg://wemedia:secret@127.0.0.1:55432/postgres",
        "wemedia_test_012345abcdef",
    )
    assert actual == (
        "postgresql+asyncpg://wemedia:secret@127.0.0.1:55432/"
        "wemedia_test_012345abcdef"
    )
```

- [ ] **Step 2: Run the safety tests and verify RED**

Run: `/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_postgres_test_db.py -q`

Expected: collection fails because `tests.postgres_test_db` does not exist.

- [ ] **Step 3: Implement name and URL validation**

```python
import re
from sqlalchemy.engine import make_url

TEST_DATABASE_PATTERN = re.compile(r"^wemedia_test_[0-9a-f]{12}$")


def validate_test_database_name(name: str) -> str:
    if not TEST_DATABASE_PATTERN.fullmatch(name):
        raise ValueError(f"unsafe PostgreSQL test database: {name!r}")
    return name


def replace_database_name(url: str, database_name: str) -> str:
    validate_test_database_name(database_name)
    parsed = make_url(url)
    if parsed.drivername != "postgresql+asyncpg":
        raise ValueError("TEST_DATABASE_ADMIN_URL must use postgresql+asyncpg")
    return parsed.set(database=database_name).render_as_string(hide_password=False)
```

- [ ] **Step 4: Run the safety tests and verify GREEN**

Run: `/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_postgres_test_db.py -q`

Expected: 7 tests pass.

- [ ] **Step 5: Add a real lifecycle test**

```python
import asyncio
import asyncpg
import pytest
from sqlalchemy.engine import make_url

from tests.postgres_test_db import create_test_database, drop_test_database


def _asyncpg_dsn(url: str) -> str:
    return make_url(url).set(drivername="postgresql").render_as_string(
        hide_password=False,
    )


def test_create_and_drop_real_postgresql_database():
    admin_url = (
        "postgresql+asyncpg://wemedia:wemedia@127.0.0.1:55432/postgres"
    )
    name = "wemedia_test_012345abcdef"
    test_url = replace_database_name(admin_url, name)

    async def scenario():
        await drop_test_database(admin_url, name, missing_ok=True)
        await create_test_database(admin_url, name)
        connection = await asyncpg.connect(_asyncpg_dsn(test_url))
        try:
            assert await connection.fetchval("select current_database()") == name
        finally:
            await connection.close()
        await drop_test_database(admin_url, name)
        admin = await asyncpg.connect(_asyncpg_dsn(admin_url))
        try:
            assert not await admin.fetchval(
                "select exists(select 1 from pg_database where datname=$1)",
                name,
            )
        finally:
            await admin.close()

    asyncio.run(scenario())
```

- [ ] **Step 6: Run the lifecycle test and verify RED**

Run: `/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_postgres_test_db.py::test_create_and_drop_real_postgresql_database -q`

Expected: FAIL because lifecycle functions are not defined.

- [ ] **Step 7: Implement lifecycle functions and fixtures**

Use `asyncpg.connect()` with the driver-normalized administrative DSN. Execute
`CREATE DATABASE "<validated_name>"`; on cleanup first execute
`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid <> pg_backend_pid()`
and then `DROP DATABASE IF EXISTS "<validated_name>"`. In `conftest.py`, generate
the name from `uuid.uuid4().hex[:12]`, call create with `asyncio.run`, yield the
replaced URL, and always call drop in `finally`. The `postgres_env` fixture sets
both required environment variables with `monkeypatch` before yielding the URL.

- [ ] **Step 8: Run all lifecycle tests and inspect for leftovers**

Run: `/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_postgres_test_db.py -q`

Run: `docker exec wms-dev-postgres-copy psql -U wemedia -d postgres -Atc "select datname from pg_database where datname like 'wemedia_test_%' order by datname"`

Expected: tests pass and the second command prints no database names.

- [ ] **Step 9: Commit Task 1 files only**

```bash
git add backend/tests/postgres_test_db.py backend/tests/conftest.py backend/tests/test_postgres_test_db.py
git commit -m "test: add isolated PostgreSQL database fixture"
```

---

### Task 2: Convert the Hanging WeChat Collection Test

**Files:**
- Modify: `backend/tests/test_wechat_collect_all.py`
- Test: `backend/tests/test_wechat_collect_all.py`

**Interfaces:**
- Consumes fixture: `postgres_env: str`
- Keeps production interface: `routers.wechat._run_collect_all(delay_seconds: float)`

- [ ] **Step 1: Replace the two SQLite fixtures with `postgres_env` while leaving the old multi-loop setup unchanged**

The test fixtures must stop accepting `tmp_path`; set module state only after
`postgres_env` has set `DATABASE_URL`. Keep the first run intentionally on
the old loop structure to prove the prior SQLite-specific setup is the failure
boundary.

- [ ] **Step 2: Run the file with a timeout and verify RED**

Run: `timeout 60 /home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_wechat_collect_all.py -q`

Expected: a PostgreSQL cross-loop/pooling error or timeout from the old fixture,
not an SQLite/aiosqlite error.

- [ ] **Step 3: Put schema creation, seeding, job execution, assertions, and engine disposal on one event loop per test**

Use a single `asyncio.run(scenario())` inside `_run_job`. For endpoint tests,
allow the real FastAPI lifespan to initialize the schema; if seed data is needed,
seed and call `await engine.dispose()` before constructing `TestClient` so no
asyncpg connection crosses loops. Remove comments about naive SQLite datetimes.

- [ ] **Step 4: Verify the formerly hanging file is GREEN**

Run: `timeout 60 /home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_wechat_collect_all.py -q`

Expected: 7 tests pass before the timeout.

- [ ] **Step 5: Run the scoped WeChat suite**

Run: `/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_wechat_collect_all.py backend/tests/test_wechat_direct_network.py backend/tests/test_wechat_eager_body_collection.py backend/tests/test_wechat_article_detail.py backend/tests/test_wechat_collector.py -q`

Expected: all scoped tests pass.

- [ ] **Step 6: Commit the converted WeChat test only**

```bash
git add backend/tests/test_wechat_collect_all.py
git commit -m "test: run WeChat collection tests on PostgreSQL"
```

---

### Task 3: Convert Module-reload Router and Settings Fixtures

**Files:**
- Modify: `backend/tests/test_agent_executions_router.py`
- Modify: `backend/tests/test_asset_directories_router.py`
- Modify: `backend/tests/test_blog_publish.py`
- Modify: `backend/tests/test_chat_router.py`
- Modify: `backend/tests/test_collection_proxy_lifespan.py`
- Modify: `backend/tests/test_content_jobs.py`
- Modify: `backend/tests/test_daily_creation_rules_router.py`
- Modify: `backend/tests/test_daily_creation_scheduler.py`
- Modify: `backend/tests/test_dashboard.py`
- Modify: `backend/tests/test_dev_runtime.py`
- Modify: `backend/tests/test_digital_human_assets.py`
- Modify: `backend/tests/test_digital_human_end_to_end.py`
- Modify: `backend/tests/test_digital_human_service.py`
- Modify: `backend/tests/test_digital_humans_router.py`
- Modify: `backend/tests/test_drafts_router.py`
- Modify: `backend/tests/test_github_collector.py`
- Modify: `backend/tests/test_heygen_settings.py`
- Modify: `backend/tests/test_job_reconciliation.py`
- Modify: `backend/tests/test_job_reconciliation_lifespan.py`
- Modify: `backend/tests/test_job_worker.py`
- Modify: `backend/tests/test_jobs_router.py`
- Modify: `backend/tests/test_log_redaction.py`
- Modify: `backend/tests/test_mcp_creative_asset_tools.py`
- Modify: `backend/tests/test_mcp_daily_creation_tools.py`
- Modify: `backend/tests/test_mcp_draft_images.py`
- Modify: `backend/tests/test_models_schema.py`
- Modify: `backend/tests/test_reddit_router.py`
- Modify: `backend/tests/test_release_drafter.py`
- Modify: `backend/tests/test_responses_router.py`
- Modify: `backend/tests/test_responses_worker_context.py`
- Modify: `backend/tests/test_speech_settings.py`
- Modify: `backend/tests/test_talking_videos_router.py`
- Modify: `backend/tests/test_text_video_master_routes.py`
- Modify: `backend/tests/test_text_video_template_settings.py`
- Modify: `backend/tests/test_text_videos_router.py`
- Modify: `backend/tests/test_topic_source_rule_contract.py`
- Modify: `backend/tests/test_topic_source_rule_migration.py`
- Modify: `backend/tests/test_topic_source_service.py`
- Modify: `backend/tests/test_web_search_settings.py`
- Modify: `backend/tests/test_wechat_publish.py`
- Modify: `backend/tests/test_x_accounts_router.py`
- Modify: `backend/tests/test_x_router.py`
- Modify: `backend/tests/test_x_subscription_interval_contract.py`
- Modify: `backend/tests/test_youtube_cookie_settings.py`
- Modify: `backend/tests/text_video_factories.py`

**Interfaces:**
- Consumes fixture: `postgres_env: str`
- Consumes fixture: `postgres_database_url: str`
- Existing `fresh_session_factory(...)` keeps its name but accepts a URL instead of `tmp_path` and `database_name`.

- [ ] **Step 1: Convert one representative router fixture and run it RED against an empty PostgreSQL database**

In `test_dashboard.py`, replace the generated SQLite URL with the `postgres_env`
fixture and remove `tmp_path`. Run before changing initialization.

Run: `/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_dashboard.py -q`

Expected: FAIL if the fixture relied on SQLite's file-created empty state or
cross-loop connection behavior.

- [ ] **Step 2: Make the representative fixture initialize and dispose PostgreSQL correctly**

Create metadata or invoke `init_db()` on one loop, dispose the imported engine,
and only then build `TestClient`. Keep all test assertions unchanged.

Run: `/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_dashboard.py -q`

Expected: all dashboard tests pass.

- [ ] **Step 3: Apply the proven fixture shape to the listed router/settings files**

For each fixture that currently assigns `sqlite+aiosqlite`, depend on
`postgres_env` and delete only the URL construction and `tmp_path` argument when
it has no other use. For tests that intentionally pass a database URL to a
subprocess/environment dictionary, depend on `postgres_database_url` and place
that exact URL in the dictionary. Do not share a database between tests.

- [ ] **Step 4: Convert `text_video_factories.fresh_session_factory`**

Change its signature to:

```python
def fresh_session_factory(monkeypatch, postgres_database_url):
    monkeypatch.setenv("DATABASE_URL", postgres_database_url)
    # existing module purge/import behavior follows
```

Update every caller to pass the fixture URL and remove SQLite filename values.

- [ ] **Step 5: Run this task's files in four bounded batches**

Run each batch with `/home/violet/miniconda3/envs/wems/bin/python -m pytest <files> -q`:

1. agent, asset, chat, content-job, response, and MCP files;
2. dashboard, collector, proxy, settings, and X files;
3. digital-human and talking-video files;
4. text-video router/master/template files.

Expected: every batch passes; failures must not mention SQLite or aiosqlite.

- [ ] **Step 6: Commit only the converted fixture group**

Stage the files listed in this task and commit:

```bash
git commit -m "test: move backend router fixtures to PostgreSQL"
```

---

### Task 4: Convert Direct-engine Service Tests

**Files:**
- Modify: `backend/tests/test_agent_execution_service.py`
- Modify: `backend/tests/test_content_response_handoff.py`
- Modify: `backend/tests/test_content_response_models.py`
- Modify: `backend/tests/test_content_response_service.py`
- Modify: `backend/tests/test_daily_creation_rule_schema.py`
- Modify: `backend/tests/test_daily_creation_service.py`
- Modify: `backend/tests/test_text_video_audio.py`
- Modify: `backend/tests/test_text_video_master_commit.py`

**Interfaces:**
- Consumes fixture: `postgres_database_url: str`
- Direct async engines use `create_async_engine(postgres_database_url)` and are always disposed in `finally`.
- Synchronous ORM tests are converted to async tests because the supported PostgreSQL dependency is asyncpg.

- [ ] **Step 1: Convert one direct-engine service test and verify its old assumptions fail**

Convert the first `test_content_response_service.py` fixture to use
`postgres_database_url`, preserving its assertions and adding engine disposal.

Run: `/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_content_response_service.py -q`

Expected: any dialect assumption fails visibly before DDL/default assertions are
updated; the test must connect to a `wemedia_test_` database.

- [ ] **Step 2: Convert all async direct-engine tests**

Replace every SQLite URL with `postgres_database_url`. Keep schema creation,
sessions, and assertions on one async test loop. Replace in-memory SQLite branches
in text-video tests with a second engine against the same isolated per-test
database after disposing the first engine; those tests require independent
connections, not an independently named database.

- [ ] **Step 3: Convert synchronous model/schema tests to async PostgreSQL tests**

Use `create_async_engine`, `async_sessionmaker`, and `await conn.run_sync(Base.metadata.create_all)`.
Use PostgreSQL inspection through `await conn.run_sync(lambda sync_conn: inspect(sync_conn)...)`
instead of SQLite `create_engine` or file inspection.

- [ ] **Step 4: Run direct-engine tests**

Run: `/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_agent_execution_service.py backend/tests/test_content_response_handoff.py backend/tests/test_content_response_models.py backend/tests/test_content_response_service.py backend/tests/test_daily_creation_rule_schema.py backend/tests/test_daily_creation_service.py backend/tests/test_text_video_audio.py backend/tests/test_text_video_master_commit.py -q`

Expected: all listed files pass and all engines are disposed.

- [ ] **Step 5: Commit this conversion group**

```bash
git add backend/tests/test_agent_execution_service.py backend/tests/test_content_response_handoff.py backend/tests/test_content_response_models.py backend/tests/test_content_response_service.py backend/tests/test_daily_creation_rule_schema.py backend/tests/test_daily_creation_service.py backend/tests/test_text_video_audio.py backend/tests/test_text_video_master_commit.py
git commit -m "test: run backend service tests on PostgreSQL"
```

---

### Task 5: Rewrite Schema Migration Tests for PostgreSQL

**Files:**
- Rename: `backend/tests/test_database_init_sqlite.py` to `backend/tests/test_database_init_postgres.py`
- Modify: `backend/tests/test_database_content_response_migration.py`
- Modify: `backend/tests/test_database_draft_adaptation_removal.py`
- Modify: `backend/tests/test_database_hot_topic_removal.py`
- Modify: `backend/tests/test_database_publication_removal.py`
- Modify: `backend/tests/test_database_text_video_migration.py`
- Modify: `backend/tests/test_database_x_response_migration.py`

**Interfaces:**
- Consumes fixture: `postgres_env: str`
- Legacy schemas are created with SQLAlchemy `text()` on the unique PostgreSQL database.
- Schema assertions use SQLAlchemy `inspect()` or PostgreSQL `information_schema`, never `sqlite_master` or PRAGMA.

- [ ] **Step 1: Rename the central init test and keep its SQLite setup to establish RED**

Run: `/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_database_init_postgres.py -q`

Expected: FAIL because SQLite file/PRAGMA setup no longer matches
`postgres_env` and because the old file-specific assumptions are unsupported.

- [ ] **Step 2: Rewrite legacy setup as PostgreSQL DDL**

Execute legacy `CREATE TABLE`, `ALTER TABLE`, and seed statements inside
`async with engine.begin()`. Replace `_columns(sqlite3.Connection, ...)` with:

```python
async def table_columns(connection, table_name: str) -> set[str]:
    return set(await connection.run_sync(
        lambda sync_connection: {
            column["name"]
            for column in inspect(sync_connection).get_columns(table_name)
        }
    ))
```

Replace `sqlite_master` table/index checks with SQLAlchemy inspector calls.

- [ ] **Step 3: Rewrite each focused migration test file**

For every listed file, build only the minimum legacy table state required by the
migration, invoke the real migration twice to prove idempotency, and assert the
PostgreSQL columns, constraints, indexes, preserved rows, and removed tables.
Rename test functions containing `sqlite` to `postgres` or dialect-neutral names.

- [ ] **Step 4: Run the migration suite**

Run: `/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_database_init_postgres.py backend/tests/test_database_content_response_migration.py backend/tests/test_database_draft_adaptation_removal.py backend/tests/test_database_hot_topic_removal.py backend/tests/test_database_publication_removal.py backend/tests/test_database_text_video_migration.py backend/tests/test_database_x_response_migration.py -q`

Expected: all migration tests pass on PostgreSQL and remain idempotent.

- [ ] **Step 5: Commit the migration tests**

```bash
git add backend/tests/test_database_init_sqlite.py backend/tests/test_database_init_postgres.py backend/tests/test_database_content_response_migration.py backend/tests/test_database_draft_adaptation_removal.py backend/tests/test_database_hot_topic_removal.py backend/tests/test_database_publication_removal.py backend/tests/test_database_text_video_migration.py backend/tests/test_database_x_response_migration.py
git commit -m "test: validate database migrations on PostgreSQL"
```

---

### Task 6: Remove SQLite Runtime Compatibility and Dependency

**Files:**
- Modify: `backend/database.py`
- Modify: `backend/models.py`
- Modify: `backend/routers/dashboard.py`
- Modify: `backend/routers/x.py`
- Modify: `backend/tests/test_database_engine_config.py`
- Modify: `backend/requirements.txt`
- Delete: `backend/migrate_sqlite_to_pg.py`

**Interfaces:**
- `database._database_engine_kwargs` supports PostgreSQL asyncpg only.
- X upserts use `sqlalchemy.dialects.postgresql.insert` only.
- Model partial indexes define only `postgresql_where`.

- [ ] **Step 1: Change the engine contract test to reject non-PostgreSQL URLs**

```python
@pytest.mark.parametrize("url", [
    "sqlite+aiosqlite:////tmp/wemedia.db",
    "mysql+aiomysql://root@example.test/wemedia",
])
def test_database_engine_rejects_unsupported_dialects(url):
    with pytest.raises(ValueError, match="PostgreSQL"):
        _database_engine_kwargs(url, 12.5)
```

- [ ] **Step 2: Run the engine test and verify RED**

Run: `/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_database_engine_config.py -q`

Expected: FAIL because SQLite and generic dialects are still accepted.

- [ ] **Step 3: Remove dialect branches**

Make `_database_engine_kwargs` reject every URL not starting with
`postgresql+asyncpg://`, then return PostgreSQL pooling and command-timeout
options. In migrations, retain only PostgreSQL JSON defaults, DDL, and
`json_build_array`. Remove SQLite imports/upsert selection from `routers/x.py`,
the SQLite timestamp comment from `dashboard.py`, and `sqlite_where` from model
indexes. Delete the one-time migration script because SQLite is no longer a
supported source or runtime.

- [ ] **Step 4: Remove the dependency and verify focused tests**

Delete `aiosqlite>=0.20,<1` from `backend/requirements.txt`.

Run: `/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_database_engine_config.py backend/tests/test_x_router.py backend/tests/test_dashboard.py backend/tests/test_models_schema.py -q`

Expected: all tests pass without importing aiosqlite.

- [ ] **Step 5: Commit runtime cleanup**

```bash
git add backend/database.py backend/models.py backend/routers/dashboard.py backend/routers/x.py backend/tests/test_database_engine_config.py backend/requirements.txt backend/migrate_sqlite_to_pg.py
git commit -m "refactor: make backend PostgreSQL-only"
```

---

### Task 7: Repository-wide Verification and Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/self-hosted.md`

**Interfaces:**
- Documents `TEST_DATABASE_ADMIN_URL` and the local test command.

- [ ] **Step 1: Document PostgreSQL test prerequisites and command**

Add the default admin URL, `CREATEDB` requirement, unique database naming rule,
automatic cleanup behavior, and this command:

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests -q
```

- [ ] **Step 2: Prove SQLite has left supported backend code and tests**

Run: `rg -n "sqlite|aiosqlite" backend --glob '!__pycache__/**'`

Expected: no matches.

- [ ] **Step 3: Run the complete backend test suite**

Run: `/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests -q`

Expected: all backend tests pass against PostgreSQL.

- [ ] **Step 4: Confirm cleanup and development database integrity**

Run: `docker exec wms-dev-postgres-copy psql -U wemedia -d postgres -Atc "select datname from pg_database where datname like 'wemedia_test_%' order by datname"`

Expected: no rows.

Run: `docker exec wms-dev-postgres-copy psql -U wemedia -d wemedia -Atc "select current_database()"`

Expected: exactly `wemedia`.

- [ ] **Step 5: Run application smoke verification**

Run: `./dev.sh status`

Expected: PostgreSQL and API are ready; any pre-existing unrelated worker
readiness issue is reported separately and is not labeled as caused by this
migration without evidence.

- [ ] **Step 6: Commit documentation only**

```bash
git add README.md docs/self-hosted.md
git commit -m "docs: describe PostgreSQL backend test databases"
```

- [ ] **Step 7: Review the final diff without touching unrelated changes**

Run: `git diff --check HEAD~7..HEAD`

Run: `git status --short`

Expected: migration commits contain only the files listed above; unrelated
working-tree changes remain present and unstaged.
