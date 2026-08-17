# PostgreSQL-only backend tests

## Goal

Remove SQLite from the backend test suite. Database-backed tests must exercise
the same PostgreSQL dialect and async driver used by the application, while
remaining isolated from development data and from one another.

## Scope

- Replace every `sqlite+aiosqlite` backend test fixture and helper with the
  shared PostgreSQL test database facility.
- Cover router, service, scheduler, model, and schema-migration tests.
- Remove SQLite-specific test files, expectations, dependencies, and production
  compatibility branches once no supported runtime or test path uses them.
- Keep non-database unit tests independent of PostgreSQL.
- Do not change the development database (`wemedia`) or its data.

## Test database lifecycle

Database-backed tests receive a unique database named
`wemedia_test_<random_identifier>`. The fixture connects to an administrative
database, creates the test database, yields an async SQLAlchemy URL, and drops
the database during teardown.

Before dropping a database, the fixture must verify that:

1. the parsed database name starts with `wemedia_test_`;
2. it is not the administrative database;
3. it is not the configured application database;
4. the target is a database name, not an unresolved environment value.

Teardown disposes test engines, terminates remaining sessions connected to the
specific test database, and then drops only that database. Cleanup is attempted
even when a test fails. A stale database from a killed test process is safe but
may remain until an explicit cleanup command removes test-prefixed databases.

## Configuration

The fixture reads `TEST_DATABASE_ADMIN_URL`. Its local default is the
existing development PostgreSQL service:

```text
postgresql+asyncpg://wemedia:wemedia@127.0.0.1:55432/postgres
```

The configured role must have `CREATEDB`; the current local `wemedia` role has
that capability. CI can provide a different administrative URL without changing
tests. Application modules receive a URL for the newly created test database
through `DATABASE_URL` before those modules are imported or reloaded.

The host does not need the `psql` executable for normal test execution. Database
creation and cleanup use the installed PostgreSQL Python driver. `psql` remains
useful only for manual inspection or cleanup and is available inside the local
PostgreSQL container.

## Shared test API

`backend/tests/conftest.py` owns the session-independent PostgreSQL helpers and
pytest fixtures. Tests consume a small interface rather than constructing URLs:

- a fixture yielding a unique test database URL;
- a fixture/helper that sets `DATABASE_URL` before reloading database-bound
  modules;
- a helper for creating model metadata when the behavior under test does not run
  application initialization;
- an explicit legacy-schema setup path for migration tests.

The helper owns lifecycle and safety checks. Production modules do not gain
test-only cleanup methods.

## Migration strategy

The migration proceeds in behavior groups so failures remain attributable:

1. Add and test the PostgreSQL database lifecycle fixture.
2. Convert the previously hanging WeChat collection test and verify it no longer
   depends on SQLite event-loop behavior.
3. Convert shared router/module-reload fixtures.
4. Convert direct SQLAlchemy service fixtures.
5. Convert schema migration tests to build their legacy state with PostgreSQL
   DDL.
6. Remove SQLite-only engine tests and compatibility code after repository-wide
   search confirms no supported usage remains.

Tests that intentionally validate SQLite-specific behavior are deleted or
rewritten to validate the PostgreSQL production contract; they are not retained
as dormant compatibility tests.

## Failure behavior

- If PostgreSQL is unavailable, database-backed tests fail immediately with a
  message naming the administrative URL host and the required configuration.
- If the role cannot create databases, the fixture reports the missing
  `CREATEDB` capability.
- Any unsafe cleanup target raises an error instead of issuing `DROP DATABASE`.
- Cleanup errors are reported and do not silently convert a failed teardown into
  a passing test run.

## Verification

The migration is complete only when:

- repository search finds no backend test use of `sqlite`, `aiosqlite`, or
  `sqlite+aiosqlite`;
- the PostgreSQL fixture's safety and lifecycle tests pass;
- the WeChat collection tests pass without timeout;
- all backend tests pass against PostgreSQL;
- no test-created database remains after a successful run;
- the application still starts against the existing PostgreSQL development
  database.

Because the working tree already contains unrelated changes, implementation and
verification must preserve them and stage only files belonging to this
migration.
