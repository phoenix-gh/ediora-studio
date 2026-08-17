# Compose data 目录持久化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Ediora Compose 的全部运行时持久化数据改为 `docker-compose.yml` 同目录下的 `data/` bind mounts，并在不迁移旧卷的前提下完成全新隔离安装验证。

**Architecture:** Compose 使用 `./data/<purpose>` 到容器数据目录的相对 bind mount；应用镜像内容不挂载。调度器状态通过环境变量写入独立 runtime 目录，Web 上传 Skill 使用独立 runtime bind mount；安装脚本在启动前创建目录并保护 X session 目录权限。

**Tech Stack:** Docker Compose v2、PostgreSQL 16、Redis 7、FastAPI/Python、Next.js/Node、Bash installer、pytest。

## Global Constraints

- 不读取、复制、删除或改名既有 Docker 命名卷。
- PostgreSQL、上传资产、X/feedgrab session、Web runtime Skill 状态必须持久化。
- Redis、调度器状态、头像缓存、微信图片缓存和 local-asr 模型缓存均使用 `data/` 下目录。
- `local-asr` 保持 profile 可选，不进入默认安装或默认启动。
- provider API keys 继续只从 Settings/PostgreSQL 读取，不加入 `.env` 或 Compose 环境变量。

---

### Task 1: Lock the bind-mount contract with tests

**Files:**
- Modify: `backend/tests/test_compose_x_sessions.py`
- Modify: `backend/tests/test_local_asr_compose.py`
- Modify: `scripts/test-install.sh`

**Interfaces:**
- Consumes: current Compose JSON output and installer fake Docker harness.
- Produces: failing assertions for `./data` bind sources, scheduler runtime path, local-asr cache path, and installer-created directories.

- [ ] **Step 1: Change the Compose contract assertions**

Assert that API mounts resolve to `ROOT/data/uploads`, `ROOT/data/sessions`, `ROOT/data/avatars`, and `ROOT/data/wechat-images`; assert `FEEDGRAB_DATA_DIR=/app/sessions`, `SCHEDULER_STATE_FILE=/app/.runtime/scheduler_state.json`, and `/app/.runtime` is mounted from `ROOT/data/scheduler`. Assert the Web service mounts `ROOT/data/web-runtime` to `/app/web/.runtime` and PostgreSQL/Redis use `ROOT/data/postgres` and `ROOT/data/redis`.

- [ ] **Step 2: Change the local-asr cache assertion**

Keep the profile/GPU assertions and require a bind mount whose source is `ROOT/data/local-asr-models` and target is `/home/ubuntu/.cache/huggingface/hub`.

- [ ] **Step 3: Add an installer data-directory assertion**

Run the fake installer with a usable Docker state and blank input, then assert these directories exist under the checkout: `data/postgres`, `data/redis`, `data/uploads`, `data/sessions`, `data/web-runtime`, `data/scheduler`, `data/avatars`, `data/wechat-images`, and `data/local-asr-models`. Assert `data/sessions` is mode `700`.

- [ ] **Step 4: Run the focused tests and verify they fail**

Run:

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_compose_x_sessions.py backend/tests/test_local_asr_compose.py -q
bash scripts/test-install.sh
```

Expected: the current named-volume Compose and installer fail the new data-directory assertions.

### Task 2: Implement Compose and runtime path changes

**Files:**
- Modify: `docker-compose.yml`
- Modify: `backend/scheduler.py`
- Modify: `scripts/local-asr.sh`

**Interfaces:**
- Consumes: Task 1 contract.
- Produces: Compose services using relative `./data/...` mounts and scheduler state at `/app/.runtime/scheduler_state.json`.

- [ ] **Step 1: Make scheduler state configurable**

Set `STATE_FILE = os.getenv("SCHEDULER_STATE_FILE", os.path.join(os.path.dirname(__file__), ".scheduler_state.json"))` so existing non-Compose development behavior remains unchanged.

- [ ] **Step 2: Replace named volumes in Compose**

Use the exact mappings from the approved design. Add `SCHEDULER_STATE_FILE` to API environment, add Web runtime mount to the `web` service, and remove the named-volume declarations. Keep the existing API/worker/Web image anchor and local-asr profile unchanged apart from its cache bind mount.

- [ ] **Step 3: Make standalone local-asr use the same data root**

Resolve the repository root in `scripts/local-asr.sh`, default `LOCAL_ASR_CACHE_DIR` to `<repo>/data/local-asr-models`, create it before `docker run`, and mount that host directory. Preserve `LOCAL_ASR_CACHE_VOLUME` only if explicitly supplied as a compatibility override, or use the new directory variable as the default without changing the container interface.

- [ ] **Step 4: Run the focused tests and config validation**

Run:

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_compose_x_sessions.py backend/tests/test_local_asr_compose.py -q
docker compose config --quiet
```

Expected: focused tests pass and Compose resolves without named volumes.

### Task 3: Make the installer and documentation create/explain the data root

**Files:**
- Modify: `install.sh`
- Modify: `.gitignore`
- Modify: `README.md`
- Modify: `docs/self-hosted.md`
- Modify: `scripts/test-install.sh`

**Interfaces:**
- Consumes: Task 2 relative bind mount contract.
- Produces: fresh installs with initialized `data/` directories and documented backup/upgrade behavior.

- [ ] **Step 1: Add installer directory initialization**

Create the nine data subdirectories after environment validation and before image pull/build/start. Explicitly `chmod 700` the sessions directory. Do not touch existing files or volumes.

- [ ] **Step 2: Ignore runtime data**

Add `/data/*` and an exception for `/data/.gitkeep` (or equivalent) to `.gitignore`; do not add secrets or runtime files to the repository.

- [ ] **Step 3: Update self-hosted docs**

Replace named-volume wording with the `data/` tree, identify PostgreSQL/uploads/sessions/Skill runtime as required backups, note `.env` and `X_SESSION_KEY`, and state that changing Compose without migration starts from an empty data directory while old named volumes remain untouched.

- [ ] **Step 4: Run installer contract and shell syntax tests**

Run:

```bash
bash -n install.sh scripts/test-install.sh scripts/local-asr.sh
bash scripts/test-install.sh
```

Expected: all installer contract tests pass.

### Task 4: Build and verify a fresh data-directory installation

**Files:**
- No repository file changes.
- Create temporary test checkout: `/tmp/ediora-compose-data-test/`.

**Interfaces:**
- Consumes: updated root Compose, local `ediora-local:dev` image, and a fresh `.env` with non-conflicting ports.
- Produces: live evidence that bind directories are created and services use them.

- [ ] **Step 1: Build the updated local image**

Run `docker compose build api` with `APP_IMAGE=ediora-local`, `IMAGE_TAG=dev`, and the test API URL. Use the temporary Docker config only if the default Docker config is read-only.

- [ ] **Step 2: Prepare a fresh test checkout**

Copy the updated `docker-compose.yml` and `.env.example` into `/tmp/ediora-compose-data-test/`, set `APP_IMAGE=ediora-local`, `IMAGE_TAG=dev`, valid internal secrets, and unused host ports.

- [ ] **Step 3: Start without product pulls or builds**

Run:

```bash
docker compose -p ediora-compose-data-test --env-file .env up -d --no-build --pull never
```

Do not call `docker compose down -v`, do not pull the application image, and do not touch `wemediastudio_*` or `ediora-compose-test_*` volumes.

- [ ] **Step 4: Verify persistence paths and service readiness**

Run `docker compose ps`, inspect the resolved mounts, check API `/health` and Web `/`, and list `data/` directories. Expect API, Worker, Web, PostgreSQL, and Redis running; `local-asr` absent; all expected bind mounts present.

- [ ] **Step 5: Commit the implementation**

```bash
git add docker-compose.yml backend/scheduler.py scripts/local-asr.sh install.sh .gitignore README.md docs/self-hosted.md backend/tests/test_compose_x_sessions.py backend/tests/test_local_asr_compose.py scripts/test-install.sh
git commit -m "feat: persist compose runtime data under data"
```
