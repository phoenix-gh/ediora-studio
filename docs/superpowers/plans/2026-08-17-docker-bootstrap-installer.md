# Ediora Docker Bootstrap Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an idempotent Ubuntu installer that confirms and installs Docker when needed, collects the runtime `.env`, pulls the published Ediora image, and starts the existing Compose stack.

**Architecture:** Keep `docker-compose.yml` as the only service-topology source. Add a root `install.sh` that resolves a local or remote checkout, selects either direct Docker or `sudo docker`, writes only missing `.env` values, pulls the configured images, starts the default Compose services without building, and polls readiness. Add a shell mock harness that exercises the installer without changing the host Docker daemon.

**Tech Stack:** Bash 5, Ubuntu apt/systemd, Docker Engine, Docker Compose v2, GHCR, existing PostgreSQL/Redis/Next.js/FastAPI Compose stack, Bash mock tests.

## Global Constraints

- Support Ubuntu 22.04 and 24.04 only; reject other operating systems and distributions before any package or Compose operation.
- Keep the installer Docker-first. Do not install Python, Node.js, PostgreSQL, Redis, Chromium, or other application dependencies directly on the host.
- Require an explicit `y` or `yes` confirmation before any Docker package installation that can invoke `sudo`; `--yes` is the non-interactive equivalent for an already approved invocation.
- Default to `APP_IMAGE=ghcr.io/phoenix-gh/ediora-studio`, `IMAGE_TAG=latest`, `docker compose pull`, and `docker compose up -d --no-build`. Only `--build` may select a local application-image build.
- Preserve an existing `.env` byte-for-byte and append only missing assignments. Never source it as shell code, print it, delete it, or replace volumes.
- Do not prompt for or write provider API keys. Provider credentials remain configured in Ediora Settings after the stack is available.
- Use `set -Eeuo pipefail`, `umask 077`, bounded readiness polling, non-secret diagnostics, and non-destructive retry behavior.
- Refuse execution when the installer itself is launched as root (`sudo ./install.sh`); use `sudo` only inside the Docker package and service helpers.
- Keep the default Compose service set unchanged; do not start the optional `local-asr` profile.
- Run each test command listed below after the corresponding implementation change and record failures before moving to the next task.

## Task 1: Add the installer mock harness and failing contract tests

**Files:** Create `scripts/test-install.sh`.

- [ ] Build a self-contained Bash test harness that creates a temporary checkout, a fake `PATH`, a command log, fake Docker state, and isolated HOME/XDG directories. Do not contact a Docker daemon or modify the host package manager.
- [ ] Add helpers for assertions, command-log matching, temporary `.env` creation, fake `sudo`, `apt-get`, `systemctl`, `curl`, `gpg`, and `docker` commands, and cleanup through an exit trap.
- [ ] Add contract cases for:
  - declining Docker installation exits non-zero and logs no `apt-get`, `gpg`, or `systemctl` operation;
  - confirmed Docker installation runs the repository setup and package/service commands before any Compose command;
  - existing `.env` values remain unchanged while missing values are appended;
  - generated secrets are absent from stdout/stderr and the resulting file mode is `0600`;
  - the default flow calls Compose `pull` before `up -d --no-build` and never calls `build`;
  - `--build` skips `pull` and calls the explicit local build path;
  - pull failure returns non-zero and does not call `docker compose down` or remove data;
  - unsupported Ubuntu versions fail before Docker or Compose commands.
- [ ] Run `bash scripts/test-install.sh`. It must fail because `install.sh` has not been implemented yet; capture the failing contract as the baseline.
- [ ] Run `git diff --check` and commit the test contract as `test: specify Docker installer contract`.

## Task 2: Implement source resolution, CLI options, and Ubuntu checks

**Files:** Create `install.sh`; extend `scripts/test-install.sh` with source-resolution fixtures.

- [ ] Add the executable Bash entrypoint with `#!/usr/bin/env bash`, `set -Eeuo pipefail`, `umask 077`, a non-secret error trap, and a `usage()` function.
- [ ] Implement `parse_args()` for `--help`, `--yes`, and `--build`; reject unknown options with usage text and a non-zero exit.
- [ ] Implement `resolve_checkout()`:
  - when `install.sh` is run from a checkout containing `docker-compose.yml`, use that directory without overwriting files;
  - when run through a pipe or outside a checkout, download the public `main` archive from `https://github.com/phoenix-gh/ediora-studio/archive/refs/heads/main.tar.gz` into `${EDIORA_INSTALL_DIR:-$HOME/ediora-studio}`;
  - create the target only when absent, copy archive contents with `cp -a "$source"/. "$target"/`, and re-execute `$target/install.sh` with the original arguments;
  - refuse to overwrite a non-Ediora target and retain a failed temporary download for a clear retry error.
- [ ] Implement `require_bootstrap_commands()` for the minimal pre-Docker commands (`awk`, `curl`, `install`, `mktemp`, `sed`, `tar`, and `uname`) and report the missing command.
- [ ] Implement `require_ubuntu()` by reading `/etc/os-release`, accepting `VERSION_ID=22.04` or `24.04`, and reporting the detected platform before exiting for anything else.
- [ ] Ensure the installer exits before source or environment mutation when `EUID=0`; keep checkout and `.env` ownership with the invoking user, and invoke `sudo` only from Docker package/service helpers.
- [ ] Add tests for local-checkout execution, piped/remote source resolution, repeated execution against an existing target, `--help`, unknown arguments, and supported/unsupported Ubuntu values.
- [ ] Run `bash -n install.sh`, `bash scripts/test-install.sh`, and `git diff --check`; commit as `feat: add installer bootstrap and platform checks`.

## Task 3: Implement Docker detection, consent, and installation

**Files:** Modify `install.sh`; extend `scripts/test-install.sh` with Docker-state and package-order fixtures.

- [ ] Implement `docker_ready()` to require a working Docker CLI and a working Compose v2 plugin by checking `docker version` and `docker compose version`.
- [ ] Implement `select_docker_runner()` so the installer first tries direct Docker access, then uses `sudo docker` only when the daemon is available through sudo; clearly state when a new login is needed for docker-group access.
- [ ] Implement `confirm_docker_install()` using `y`/`yes` from `/dev/tty` for interactive runs and standard input for test/non-TTY runs. Declining must return non-zero before any privileged command.
- [ ] Implement `install_docker()` using Docker’s official Ubuntu apt repository only:
  1. install `/etc/apt/keyrings`;
  2. fetch Docker’s GPG key and install it as `/etc/apt/keyrings/docker.gpg`;
  3. add the repository using the detected Ubuntu codename and architecture;
  4. run `apt-get update`;
  5. install `ca-certificates curl gnupg git docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin`;
  6. run `systemctl enable --now docker`;
  7. verify Docker and Compose again.
- [ ] Keep every package/service command behind the consent gate and use `sudo` only for package, keyring, repository, and service operations.
- [ ] Add tests proving decline stops before `apt-get`, confirmation preserves installation ordering, a post-install daemon check is required, and Compose is never invoked before Docker is ready.
- [ ] Run `bash -n install.sh`, `bash scripts/test-install.sh`, and `git diff --check`; commit as `feat: bootstrap Docker for Ediora installer`.

## Task 4: Collect and validate the secure runtime environment

**Files:** Modify `install.sh`; extend `scripts/test-install.sh` with environment fixtures; use `.env.example` and `docker-compose.yml` as the contract references.

- [ ] Implement `env_value(KEY)` to read the first exact dotenv assignment without executing arbitrary shell code; support existing quoted values needed by the current Compose contract.
- [ ] Implement `append_env_value(KEY, VALUE)` to append a safely escaped dotenv assignment only when the key is absent, preserving all existing bytes and comments.
- [ ] Implement `random_token()` using a cryptographically secure source such as `openssl rand -hex 32` or `/dev/urandom` with a validated fallback; implement `random_fernet_key()` as a stable URL-safe Fernet key.
- [ ] Implement `prompt_value()` so interactive prompts read from `/dev/tty` when available and non-interactive execution fails with setup instructions rather than silently selecting secrets.
- [ ] Implement `collect_env()` in this order: `POSTGRES_PASSWORD`, `WORKER_TOKEN`, `X_SESSION_KEY`, host `API_PORT`, host `WEB_PORT`, `NEXT_PUBLIC_API_URL`, `CORS_ORIGINS`, `APP_IMAGE`, and `IMAGE_TAG`. Show defaults without displaying generated secret values and do not ask for provider credentials.
- [ ] Apply these defaults when the user accepts them: generated non-empty `POSTGRES_PASSWORD`, generated `WORKER_TOKEN` of at least 32 characters, generated stable `X_SESSION_KEY`, `content-jobs`, `content-jobs:video`, `http://localhost:3000`, `8000`, `3000`, `http://localhost:8000/api`, `ghcr.io/phoenix-gh/ediora-studio`, and `latest`.
- [ ] Ensure the required queue and runtime assignments exist, set `.env` mode to `0600`, and create the file with the invoking user’s ownership.
- [ ] Implement `validate_env()` for non-empty database password, worker-token length, valid and distinct host ports, HTTP(S) API URL, image reference, and image tag. Reject newline/control-character injection in values.
- [ ] Add tests for byte-preserving existing values, missing-value append behavior, stable secrets across a second run, mode `0600`, secret redaction, invalid ports/tokens/URLs, and non-interactive failure.
- [ ] Run `bash -n install.sh`, `bash scripts/test-install.sh`, and `git diff --check`; commit as `feat: collect Ediora installer environment`.

## Task 5: Pull/build/start Compose and wait for readiness

**Files:** Modify `install.sh`; extend `scripts/test-install.sh` with Compose-order and readiness fixtures.

- [ ] Implement deterministic `compose_project_name()` from the checkout directory basename, sanitized to Compose’s project-name rules. Pass `--project-name` and `--env-file` on every Compose invocation.
- [ ] Implement `compose()` as the single wrapper around the selected Docker runner and the existing `docker-compose.yml`.
- [ ] Implement `pull_images()` to run `docker compose pull api worker web postgres redis`; preserve GHCR errors and add a hint to run `docker login ghcr.io` when authentication is required.
- [ ] Implement `build_image()` for the explicit `--build` path only, calling `docker compose build api` so the shared application-image tag is produced by the existing Compose build definition.
- [ ] Implement `start_stack()` as `docker compose up -d --no-build` for the default service set. Never include `--profile local-asr` in the default command.
- [ ] Implement bounded `wait_for_ready()` with a two-second interval and a 60-attempt limit. Check Postgres and Redis health, API `/health`, Web HTTP readiness, and that the worker is running; print service names and statuses only, not environment contents.
- [ ] Implement `print_success()` with the Web URL, API health URL, checkout path, status/log/shutdown commands, a rerun command, and the optional `docker compose --profile local-asr up -d` command. Do not print secret values.
- [ ] Add tests proving default `pull -> up -d --no-build`, explicit `--build` behavior, no local-ASR startup, readiness timeout propagation, pull failure without destructive cleanup, and safe final output.
- [ ] Run `bash -n install.sh`, `bash scripts/test-install.sh`, and `git diff --check`; commit as `feat: start Ediora from pulled Compose images`.

## Task 6: Document the supported installation workflow

**Files:** Modify `README.md` and `docs/self-hosted.md`; extend `scripts/test-install.sh` with repository-documentation assertions.

- [ ] Add the canonical local command `./install.sh` and the remote command `curl -fsSL https://raw.githubusercontent.com/phoenix-gh/ediora-studio/main/install.sh | bash`.
- [ ] Document Ubuntu 22.04/24.04 scope, the Docker consent prompt, the official Docker installation path, the generated `.env`, `0600` permissions, and the fact that provider API keys are configured from Ediora Settings.
- [ ] Document the default GHCR pull/no-build behavior, `--yes`, `--build`, rerunning safely, `docker login ghcr.io` for private packages, and the status/log/shutdown commands printed by the installer.
- [ ] Document that `local-asr` is optional and separate from the default install, with its explicit Compose profile command.
- [ ] Keep existing manual Compose and GitHub Actions/GHCR documentation accurate, including the build-time behavior of `NEXT_PUBLIC_API_URL`.
- [ ] Add shell assertions that `install.sh` is executable, both canonical commands exist in documentation, and provider keys are not collected by the installer.
- [ ] Run `bash -n install.sh`, `bash scripts/test-install.sh`, `docker compose config --quiet`, `docker compose --env-file .env.example config --quiet`, and `git diff --check`; commit as `docs: add one-click Docker installation`.

## Task 7: Run live, non-destructive validation and hand off

**Files:** No expected source changes; inspect the final working tree and generated test artifacts only.

- [ ] Run `./install.sh --help` from the repository checkout and verify the usage output does not expose secrets or require Docker.
- [ ] Run the mock harness from a clean temporary directory and verify every contract case passes.
- [ ] If a Docker daemon and network are available, run the installer against an isolated Compose project with a temporary environment and the existing local image or published image, without deleting volumes or calling `docker compose down -v`. If the environment cannot safely run this check, record the exact blocked condition.
- [ ] Verify `docker compose config --quiet` with `.env.example`, the final `git diff --check`, executable mode for `install.sh`, and `git status --short`.
- [ ] Report shell-contract, Compose-config, live-Docker, and blocked-environment evidence separately. Do not claim a live deployment if only mocked tests passed.
