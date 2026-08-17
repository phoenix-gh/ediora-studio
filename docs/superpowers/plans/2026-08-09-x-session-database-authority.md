# X Session Database Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the database-stored X account session the source of truth and restore the feedgrab session files before any X collection when the current runtime directory is missing or stale.

**Architecture:** Store an encrypted `{auth_token, ct0}` payload on each managed `XCredentialAccount`. Reuse the existing atomic `CredentialFileStore` as a derived-file writer, and extend the account reconciliation boundary so database values restore the current `FEEDGRAB_DATA_DIR`; legacy files are imported only when the database backup is empty. All X collection entry points call one preflight synchronizer before invoking feedgrab.

**Tech Stack:** FastAPI, SQLAlchemy async/PostgreSQL, Fernet encryption from `cryptography`, feedgrab, pytest.

## Global Constraints

- Database session values are authoritative; current `x_<slot>.json` files are derived feedgrab caches.
- Complete credentials never appear in API responses, frontend state, task payloads, or logs.
- Existing external feedgrab sessions remain readable and are never modified by managed-account synchronization.
- Use `/home/violet/miniconda3/envs/wems/bin/python -m pytest` for backend verification.
- Use TDD: every production change starts with a focused failing test and is verified green before the next behavior.
- Preserve unrelated dirty worktree changes; do not reset, checkout, or clean files.

---

### Task 1: Add encrypted database-session primitives

**Files:**
- Modify: `backend/requirements.txt`
- Modify: `backend/models.py:1-40`
- Modify: `backend/database.py:1005-1075`
- Modify: `.env.example`
- Modify: `docker-compose.yml` API environment
- Test: `backend/tests/test_x_credential_store.py`
- Test: `backend/tests/test_database_init_postgres.py`

**Interfaces:**
- Produces `XCredentialAccount.session_ciphertext: str`, persisted as a nullable-compatible `TEXT` column with an empty-string default for existing databases.
- Produces `CredentialSessionVault.encrypt(pair: CredentialPair) -> str` and `CredentialSessionVault.decrypt(ciphertext: str) -> CredentialPair`.
- `CredentialSessionVault` reads `X_SESSION_KEY`; if absent it derives a Fernet key from the existing `WORKER_TOKEN`; it raises `CredentialFileError` when neither source is available or ciphertext is invalid.

- [ ] **Step 1: Write the failing encryption and schema tests**

  Add tests showing that `CredentialSessionVault` can round-trip a `CredentialPair`, that the ciphertext contains neither raw credential, and that `XCredentialAccount` exposes `session_ciphertext`. Add `session_ciphertext` to the PostgreSQL initialization snapshot assertion.

- [ ] **Step 2: Run the focused tests and verify the expected red failure**

  Run:

  ```bash
  /home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_x_credential_store.py backend/tests/test_database_init_postgres.py -q
  ```

  Expected failure: `CredentialSessionVault` and/or `session_ciphertext` are not defined.

- [ ] **Step 3: Add the encryption dependency and minimal vault implementation**

  Add `cryptography` to `backend/requirements.txt`. In `backend/x_credential_store.py`, derive a stable Fernet key from `WORKER_TOKEN` only as the fallback, prefer the explicit `X_SESSION_KEY`, encrypt a compact JSON payload, and validate decrypted fields as non-empty strings. Do not log key material, ciphertext, or decrypted values.

- [ ] **Step 4: Add the model field and idempotent migration**

  Add `session_ciphertext` to `XCredentialAccount` and call `_add_columns` from `init_db()` with `TEXT NOT NULL DEFAULT ''`. Add the environment variable comment to `.env.example` and pass `X_SESSION_KEY` through the Docker API environment.

- [ ] **Step 5: Run the focused tests and verify green**

  Re-run the command from Step 2. Expected: the credential-store and database schema tests pass.

- [ ] **Step 6: Commit the isolated task**

  ```bash
  git add backend/requirements.txt backend/models.py backend/database.py backend/x_credential_store.py backend/tests/test_x_credential_store.py backend/tests/test_database_init_postgres.py .env.example docker-compose.yml
  git commit -m "feat(x): persist encrypted session credentials"
  ```

  If `.git` remains read-only, leave the files unstaged and report that limitation without touching unrelated changes.

### Task 2: Make account CRUD and reconciliation database-authoritative

**Files:**
- Modify: `backend/routers/x_accounts.py:145-320`
- Modify: `backend/x_credential_store.py`
- Test: `backend/tests/test_x_accounts_router.py`

**Interfaces:**
- Produces `async def reconcile_x_credential_accounts(db: AsyncSession, store: CredentialFileStore) -> list[str]` with database-first restoration and legacy-file import.
- Produces `async def ensure_x_credential_sessions(db: AsyncSession, store: CredentialFileStore | None = None) -> None`, which raises `CredentialFileError` if any enabled managed account cannot be materialized into the current session directory.

- [ ] **Step 1: Write failing reconciliation tests**

  Add cases that create an account, delete its current `x_<slot>.json`, call reconciliation, and assert the file is restored from `session_ciphertext`; overwrite the local file with different credentials and assert the database value replaces it; create an account with an empty ciphertext but an existing file and assert reconciliation backfills the encrypted field; clear both sources and assert the account is failed.

- [ ] **Step 2: Run the tests and verify the expected red failure**

  ```bash
  /home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_x_accounts_router.py -q
  ```

  Expected failure: missing session recovery and database ciphertext assertions.

- [ ] **Step 3: Implement database-first synchronization**

  Under the existing credential file lock, decrypt `session_ciphertext` when present and call the existing atomic writer only when the active/disabled file is missing, has the wrong state, or does not match the database pair. If ciphertext is empty, read and validate the managed file once and encrypt it into the database. Keep external files out of this scan. Commit imported ciphertext and failure status after all accounts are examined.

- [ ] **Step 4: Update account mutations and account testing**

  On create and credential replacement, set `session_ciphertext` from the submitted pair before commit. On enable/disable, preserve the ciphertext and only change the derived file state. Before `/api/x/accounts/{id}/test`, call database-first synchronization and then probe the restored pair. Keep existing file/database compensation behavior.

- [ ] **Step 5: Run the focused account tests and verify green**

  Re-run `backend/tests/test_x_accounts_router.py -q`; expected: all existing lifecycle tests plus the new restore/import/failure cases pass, with no raw secrets in response text.

- [ ] **Step 6: Commit the isolated task**

  ```bash
  git add backend/x_credential_store.py backend/routers/x_accounts.py backend/tests/test_x_accounts_router.py
  git commit -m "feat(x): restore managed sessions from database"
  ```

### Task 3: Gate every X collection path on session synchronization

**Files:**
- Modify: `backend/routers/x.py:326-430`
- Modify: `backend/scheduler.py:277-310`
- Test: `backend/tests/test_x_router.py`
- Test: `backend/tests/test_x_subscription_scheduler.py`

**Interfaces:**
- `collect_one_sync`, `collect_one`, `backfill_timeline_subscription`, and `collect_all` call `ensure_x_credential_sessions` before `_collect_one` or feedgrab.
- `scheduled_x_collect` calls the same preflight once after selecting due subscriptions and before the first `_collect_one`.

- [ ] **Step 1: Write failing collection-order tests**

  Remove the managed session file after account creation, invoke manual collection with `grab_timeline` patched, and assert the file exists with the database credentials before the patched collector is awaited. Add a missing-database-session case asserting the endpoint returns the existing collection error response and `grab_timeline` is not called. Add a scheduler test asserting the preflight runs before a due subscription collector.

- [ ] **Step 2: Run the tests and verify the expected red failure**

  ```bash
  /home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_x_router.py backend/tests/test_x_subscription_scheduler.py -q
  ```

  Expected failure: the collector is currently called without restoring the missing file.

- [ ] **Step 3: Add the preflight at all four manual collection boundaries and the scheduled boundary**

  Invoke `ensure_x_credential_sessions` after loading the database rows and before any `grab_timeline`, `search_top`, or `search_x` call. Preserve per-subscription failure isolation only after the global managed-session preflight succeeds; a missing enabled managed account blocks the current X collection cycle because the database-defined account pool is incomplete.

- [ ] **Step 4: Run the focused X tests and verify green**

  Re-run both test files. Expected: existing collection, dispatch, cutoff, interval, and new session-order tests pass.

- [ ] **Step 5: Commit the isolated task**

  ```bash
  git add backend/routers/x.py backend/scheduler.py backend/tests/test_x_router.py backend/tests/test_x_subscription_scheduler.py
  git commit -m "fix(x): restore sessions before collection"
  ```

### Task 4: Full verification and runtime handoff

**Files:**
- Test: `backend/tests/test_x_credential_store.py`
- Test: `backend/tests/test_x_accounts_router.py`
- Test: `backend/tests/test_x_router.py`
- Test: `backend/tests/test_x_subscription_scheduler.py`
- Test: `backend/tests/test_database_init_postgres.py`

- [ ] **Step 1: Run the complete focused backend suite**

  ```bash
  /home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_x_credential_store.py backend/tests/test_x_accounts_router.py backend/tests/test_x_router.py backend/tests/test_x_subscription_scheduler.py backend/tests/test_database_init_postgres.py -q
  ```

- [ ] **Step 2: Run syntax and diff checks**

  ```bash
  /home/violet/miniconda3/envs/wems/bin/python -m py_compile backend/x_credential_store.py backend/models.py backend/database.py backend/routers/x_accounts.py backend/routers/x.py backend/scheduler.py
  git diff --check -- backend/x_credential_store.py backend/models.py backend/database.py backend/routers/x_accounts.py backend/routers/x.py backend/scheduler.py
  ```

- [ ] **Step 3: Confirm runtime health and session materialization**

  Run `./dev.sh status`, then verify the API and Worker are ready. Inspect only managed session filenames and file modes, never file contents. Report existing accounts that require one-time re-entry if no database ciphertext was available.

- [ ] **Step 4: Hand off with exact limits**

  Report test counts, runtime status, whether any account could not be restored, and the required stable key environment variable if the fallback `WORKER_TOKEN` was not used.
