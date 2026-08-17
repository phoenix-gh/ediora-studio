# Docker Compose 可用构建 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with review checkpoints.

**Goal:** Build one unified application image for the Python API, Node worker, and Next.js Web, while keeping them as independent Compose services and making local-asr optional.

**Architecture:** A root multi-stage `Dockerfile` combines Python 3.11 dependencies, Node 22 dependencies, the Next.js bundle, ffmpeg, and Chromium. Compose uses that image for `api`, `worker`, and `web`; only `api` owns the build definition. PostgreSQL, Redis, and profile-gated local-asr remain separate images.

**Tech Stack:** Docker Compose, Docker multi-stage builds, Python 3.11, FastAPI/Uvicorn, Node 22, pnpm, Next.js 16, Chromium, GitHub Actions.

## Global Constraints

- Default Compose startup must not require NVIDIA GPU, CUDA, or local-asr.
- local-asr must remain available with `docker compose --profile local-asr up --build`.
- `api`, `worker`, and `web` must resolve to one image tag; PostgreSQL, Redis, and local-asr are not bundled.
- `NEXT_PUBLIC_API_URL` is a build argument with default `http://localhost:8000/api`; `WMS_API_URL` remains `http://api:8000/api`.
- Preserve `/app` for API files, `/app/web` for Node services, `/app/uploads`, and `/app/sessions`.
- Do not stage or modify unrelated digital-human/ComfyUI worktree changes.
- Use `/home/violet/miniconda3/envs/wems/bin/python -m pytest` for backend tests.

---

### Task 1: Add failing Compose contract tests

**Files:** Modify `backend/tests/test_local_asr_compose.py`.

**Interfaces:** The tests consume `docker compose config --format json` and produce assertions for the profile, shared image, root build, working directories, and build argument.

- [ ] **Step 1: Require the optional profile.** Keep the current GPU, healthcheck, and cache assertions and add `assert service["profiles"] == ["local-asr"]`.
- [ ] **Step 2: Add one shared-image test.** Assert `api["image"] == worker["image"] == web["image"]`, API build context equals `str(REPOSITORY_ROOT)`, API Dockerfile equals `Dockerfile`, API build arg `NEXT_PUBLIC_API_URL` equals `http://localhost:8000/api`, worker/Web have no `build`, and both have `working_dir == "/app/web"`.
- [ ] **Step 3: Verify RED.** Run `/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_local_asr_compose.py -q`. It must fail against the current Compose because the profile, root build context, shared image, and working directories do not exist. A Docker socket permission error is an environment failure and must be reported separately.

### Task 2: Create the unified application image

**Files:** Create `Dockerfile` and `.dockerignore`.

**Interfaces:** The image consumes `backend/requirements.txt`, `web/package.json`, `web/pnpm-lock.yaml`, backend source, and Web source; it produces `ediora-studio:local` with API files at `/app`, Node files at `/app/web`, Python venv at `/opt/venv`, and a built Next.js bundle.

- [ ] **Step 1: Create `.dockerignore`.** Include `.git`, `.github`, `.next`, `node_modules`, coverage/log/cache/bytecode paths, `.env`, `.env.*`, `backend/uploads`, `backend/sessions`, and the exception `!.env.example`.
- [ ] **Step 2: Create the four-stage Dockerfile.** Use `python:3.11-slim` to create `/opt/venv` from `backend/requirements.txt`; use `node:22-bookworm-slim` to install pnpm dependencies from the Web lockfile; build Web with `ARG NEXT_PUBLIC_API_URL=http://localhost:8000/api`, `ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}`, and `next build`; use a Node 22 runtime that installs `python3`, `python3-venv`, `ffmpeg`, `chromium`, CJK/emoji fonts, copies the venv, backend into `/app`, Web into `/app/web`, Node modules and `.next`, exposes 8000/3000, and defaults to `uvicorn main:app --host 0.0.0.0 --port 8000`.
- [ ] **Step 3: Build the image.** Run `docker build --build-arg NEXT_PUBLIC_API_URL=http://localhost:8000/api -t ediora-studio:local .`; expect exit 0 and a successful `docker image inspect ediora-studio:local`.

### Task 3: Make Compose reuse one image and keep local-asr optional

**Files:** Modify `docker-compose.yml`, `docker-compose.dev.yml`, `.env.example`, and `backend/tests/test_local_asr_compose.py` as needed by the new contract.

**Interfaces:** Compose consumes `ediora-studio:local` or `${WMS_APP_IMAGE}:${WMS_IMAGE_TAG}` and produces independent API/worker/Web containers sharing that image.

- [ ] **Step 1: Add the shared image anchor.** Add `x-app-image: &app-image` with `image: ${WMS_APP_IMAGE:-ediora-studio}:${WMS_IMAGE_TAG:-local}`, merge it into `api`, `worker`, and `web`, and keep the only build block on API with context `.`, Dockerfile `Dockerfile`, and build arg `${NEXT_PUBLIC_API_URL:-http://localhost:8000/api}`.
- [ ] **Step 2: Set service directories.** Keep API at `/app`; set worker and Web `working_dir: /app/web`. Keep `WMS_API_URL=http://api:8000/api` for server-side requests and the existing API/worker token guard.
- [ ] **Step 3: Gate local-asr.** Add `profiles: [local-asr]` to the existing local-asr service, preserve its CUDA/GPU/cache configuration, and keep it out of `api.depends_on`.
- [ ] **Step 4: Preserve dev mounts.** Keep `./backend:/app`; change Web and worker mounts to `./web:/app/web` plus `/app/web/node_modules`, with `working_dir: /app/web`.
- [ ] **Step 5: Add `NEXT_PUBLIC_API_URL=http://localhost:8000/api` to `.env.example` and run GREEN.** Run `/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_local_asr_compose.py -q` and `docker compose config --quiet`; expect both to pass.

### Task 4: Add GitHub build verification and documentation

**Files:** Create `.github/workflows/docker-build.yml`; modify `README.md`, `docs/self-hosted.md`, and `web/Dockerfile`.

**Interfaces:** The workflow validates Compose, builds one image, verifies Python/Node dependencies without provider secrets or local-asr, and publishes GHCR tags only from `main` or an explicitly enabled manual run.

- [ ] **Step 1: Add the standalone Web build argument.** Before `next build` in `web/Dockerfile`, add `ARG NEXT_PUBLIC_API_URL=http://localhost:8000/api` and `ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}`.
- [ ] **Step 2: Create the workflow.** Use `push`, `pull_request`, and `workflow_dispatch`; keep the validation job at `permissions: contents: read`; set `WMS_APP_IMAGE=ediora-studio`, `WMS_IMAGE_TAG=ci-${{ github.sha }}`, and `NEXT_PUBLIC_API_URL=http://localhost:8000/api`; run `docker compose config --quiet`, `docker compose build api`, `docker compose run --rm --no-deps api python -c "import main"`, and `docker compose run --rm --no-deps worker node -e "console.log(require.resolve('tsx'))"`. Add a dependent publish job gated to `main` pushes or a manually enabled `publish` input, grant it only `contents: read` and `packages: write`, authenticate to `ghcr.io` with `GITHUB_TOKEN`, and use Docker metadata/build-push actions to publish `latest` and `sha-*` tags.
- [ ] **Step 3: Update docs.** Explain that API/worker/Web share one built image, changing `NEXT_PUBLIC_API_URL` requires rebuilding, local-asr requires `docker compose --profile local-asr up --build`, and GHCR pulls use `WMS_APP_IMAGE=ghcr.io/phoenix-gh/ediora-studio` with `WMS_IMAGE_TAG=latest`. Do not add provider credentials.
- [ ] **Step 4: Run static checks.** Run `git diff --check` and `docker compose config --quiet`; expect no whitespace errors and valid Compose.

### Task 5: Build and run the usable local version

**Files:** Verify Tasks 1–4; no additional source files.

**Interfaces:** Produce fresh evidence for the one image, image-level imports, default service startup, API health, Web reachability, and absent default local-asr.

- [ ] **Step 1: Run focused regressions.** Run `/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_local_asr_compose.py backend/tests/test_runtime_config.py -q` and report unrelated baseline failures separately.
- [ ] **Step 2: Build and inspect.** Run `docker compose build api` and `docker image inspect ediora-studio:local`; expect exit 0.
- [ ] **Step 3: Verify imports.** Run `docker compose run --rm --no-deps api python -c "import main"` and `docker compose run --rm --no-deps worker node -e "console.log(require.resolve('tsx'))"`; neither may start PostgreSQL, Redis, or local-asr.
- [ ] **Step 4: Start the default runtime.** Run `docker compose up -d postgres redis api worker web`, `docker compose ps`, `nc -z 127.0.0.1 3000`, and an API `/health` request from inside the API container; expect healthy dependencies, running API/worker/Web, reachable port 3000, and no default local-asr.
- [ ] **Step 5: Report limits.** If Docker or GitHub Actions has not run, report the exact limitation and do not claim that build as passed.
