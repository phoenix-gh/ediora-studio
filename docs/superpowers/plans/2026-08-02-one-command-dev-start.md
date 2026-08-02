# One-Command Development Startup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `./dev.sh` load the repository `.env`, ensure the configured development PostgreSQL container is reachable, and then start the existing local runtime without manual setup.

**Architecture:** Keep orchestration in the existing Bash entrypoint. Load `.env` before deriving runtime configuration while snapshotting and restoring variables explicitly present in the invoking environment; model PostgreSQL as an external dependency checked before any Redis or application-unit mutation. Extend the existing subprocess-based runtime tests with a fake Docker CLI and real loopback TCP listener so ordering and failure behavior are exercised through the public script.

**Tech Stack:** Bash, Docker CLI, Python pytest/subprocess/socket fixtures, Markdown.

## Global Constraints

- The default container is `wms-dev-postgres-copy`.
- The default PostgreSQL endpoint is `127.0.0.1:55432`.
- Explicit process environment variables override values loaded from `.env`.
- Secret values must never be printed.
- PostgreSQL remains external: `./dev.sh stop` and startup rollback never stop it.
- Preserve all existing Redis, API, Worker, and Web ownership behavior.
- Modify and stage only `dev.sh`, `backend/tests/test_dev_runtime.py`, `README.md`, and this plan.

---

### Task 1: Environment loading and precedence

**Files:**
- Modify: `backend/tests/test_dev_runtime.py`
- Modify: `dev.sh`

**Interfaces:**
- Consumes: repository root path computed from `BASH_SOURCE[0]` and optional `WMS_DEV_ENV_FILE` test/config override.
- Produces: `load_dev_environment() -> shell status`, exporting `.env` variables while restoring every variable that was already present in the caller environment.

- [ ] **Step 1: Write failing environment tests**

Add tests that create a temporary `.env`, remove `WMS_WORKER_TOKEN` from the subprocess environment, and assert the token hash observed by the fake API matches the file. Add a second test with a different explicit token and assert it wins. Add a missing-file test asserting the error names `.env.example` and contains no token value.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_dev_runtime.py -k 'loads_root_env or explicit_environment or missing_env' -v
```

Expected: failures because `dev.sh` does not load `WMS_DEV_ENV_FILE` and does not reject a missing environment file.

- [ ] **Step 3: Implement environment loading before configuration derivation**

In `dev.sh`, compute `ROOT`, set `DEV_ENV_FILE="${WMS_DEV_ENV_FILE:-$ROOT/.env}"`, collect keys assigned by the file, snapshot only keys already set in the invoking environment, source with `set -a`, then restore the caller values using safely quoted `declare -p` snapshots. Reject a missing file with `Create it from $ROOT/.env.example` and never echo values.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the command from Step 2 and require all selected tests to pass.

- [ ] **Step 5: Commit the environment-loading slice**

```bash
git add dev.sh backend/tests/test_dev_runtime.py
git commit -m "feat: load development environment automatically"
```

---

### Task 2: PostgreSQL container preparation

**Files:**
- Modify: `backend/tests/test_dev_runtime.py`
- Modify: `dev.sh`

**Interfaces:**
- Consumes: `WMS_DEV_POSTGRES_CONTAINER`, `WMS_DEV_POSTGRES_HOST`, `WMS_DEV_POSTGRES_PORT`, `WMS_DEV_READY_TIMEOUT_SECONDS`, and `WMS_DEV_POLL_INTERVAL_SECONDS`.
- Produces: `postgres_tcp_ready() -> shell status`, `postgres_container_state() -> running|stopped|missing|unavailable`, and `ensure_postgres_ready() -> shell status`.

- [ ] **Step 1: Add a fake Docker CLI and failing orchestration tests**

Extend `_fake_runtime_tools()` with a `docker` executable whose state files represent missing, stopped, running, daemon-unavailable, and start-failure cases. Use a loopback TCP fixture for ready cases. Assert a stopped container emits `start:postgres` before `start:api`, a running container is not restarted, failures create no application metadata, readiness timeout reports the configured endpoint, and `stop` never calls Docker stop.

- [ ] **Step 2: Run PostgreSQL tests and verify RED**

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_dev_runtime.py -k postgres -v
```

Expected: failures because PostgreSQL is not inspected, started, or probed.

- [ ] **Step 3: Implement validation, Docker state handling, and TCP readiness**

Add the three default PostgreSQL variables beside existing port configuration. Validate `WMS_DEV_POSTGRES_PORT`; require `docker` and `python3` for startup; use `docker inspect --format '{{.State.Running}}'`, start only a stopped existing container, and use a short Python `socket.create_connection()` probe within `dev_wait_for`. Emit distinct errors for absent CLI, daemon/inspect failure, missing container, start failure, and TCP timeout.

- [ ] **Step 4: Ensure PostgreSQL before any mutable runtime action**

Call `ensure_postgres_ready` in `cmd_start` after validation and directory creation but before `redis_transport_reusable`. Do not append PostgreSQL to `STARTED_THIS_RUN`, `rollback_start`, `stop_application_unit`, or `cmd_stop`.

- [ ] **Step 5: Run PostgreSQL tests and verify GREEN**

Run the command from Step 2 and require all selected tests to pass.

- [ ] **Step 6: Commit the PostgreSQL slice**

```bash
git add dev.sh backend/tests/test_dev_runtime.py
git commit -m "feat: prepare postgres for local development"
```

---

### Task 3: Status, summary, documentation, and regression verification

**Files:**
- Modify: `backend/tests/test_dev_runtime.py`
- Modify: `dev.sh`
- Modify: `README.md`

**Interfaces:**
- Consumes: PostgreSQL container-state and TCP-readiness helpers from Task 2.
- Produces: `postgres_status() -> shell status`, a PostgreSQL line in startup summary/status, and documented one-command workflow.

- [ ] **Step 1: Write failing status and output tests**

Update the runtime summary/status test to require `Postgres`, the container name, and `127.0.0.1:<configured port>`. Add stopped, missing, and unavailable status cases and assert `status` never starts a container.

- [ ] **Step 2: Run focused output tests and verify RED**

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_dev_runtime.py -k 'status or summary' -v
```

Expected: failures because current output covers only Redis, API, Worker, and Web.

- [ ] **Step 3: Implement PostgreSQL status and startup summary**

Print `Postgres: <container> (<host>:<port>)` from `print_runtime_summary`. In `cmd_status`, inspect without mutation and distinguish ready, running-but-unreachable, stopped, missing, and Docker-unavailable states; include an unhealthy return code for every state except ready.

- [ ] **Step 4: Update README startup instructions**

Replace the manual token export with instructions to create/configure root `.env` and run only `./dev.sh`. Document `.env` auto-export, explicit-variable precedence, the three PostgreSQL overrides, automatic container start, startup order, and the fact that `stop` leaves PostgreSQL running.

- [ ] **Step 5: Run the complete runtime test module**

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_dev_runtime.py -v
```

Expected: all tests pass, including prior ownership, replacement, rollback, real-socket, and Compose coverage.

- [ ] **Step 6: Run static checks**

```bash
bash -n dev.sh
git diff --check -- dev.sh backend/tests/test_dev_runtime.py README.md docs/superpowers/plans/2026-08-02-one-command-dev-start.md
```

Expected: both commands exit 0 with no diagnostics.

- [ ] **Step 7: Verify the real development runtime**

Run `./dev.sh restart` without manually sourcing `.env`, followed by `./dev.sh status`, `curl --fail http://127.0.0.1:8000/health`, and `curl --fail http://127.0.0.1:3000/`. Confirm PostgreSQL, Redis, API, Worker, and Web are ready and the two HTTP checks succeed.

- [ ] **Step 8: Commit documentation and final behavior**

```bash
git add dev.sh backend/tests/test_dev_runtime.py README.md docs/superpowers/plans/2026-08-02-one-command-dev-start.md
git commit -m "docs: simplify local development startup"
```
