# Single-File `curl | sh` Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the one-file Ediora installer executable directly through POSIX `sh` on Linux and macOS.

**Architecture:** Rewrite the existing root `install.sh` in POSIX shell. The script runs directly from piped stdin, downloads only the repository archive when it needs a checkout, and re-executes the same `install.sh` from that checkout. Docker detection is shared across platforms; only supported Ubuntu releases enter the automatic apt installation path.

**Tech Stack:** POSIX `sh`, Docker Compose v2, existing Bash contract tests, GitHub source archive.

## Global Constraints

- The only installer file is `install.sh`; do not add `install.bash`.
- `curl -fsSL https://raw.githubusercontent.com/phoenix-gh/ediora-studio/main/install.sh | sh` must work.
- `./install.sh`, `sh ./install.sh`, `--yes`, `--build`, and `--help` remain supported.
- Linux Docker auto-install remains limited to Ubuntu 22.04/24.04 and requires confirmation unless `--yes` is supplied.
- macOS never runs the Linux apt path and requires Docker Desktop/Compose v2.
- Existing `.env`, `data/`, GHCR defaults, Compose startup, and Settings configuration boundaries remain unchanged.

---

### Task 1: Establish the failing POSIX and platform tests

**Files:**
- Modify: `scripts/test-install.sh`

- [ ] **Step 1: Add tests for the direct `sh` contract**

Cover `sh -n install.sh`, `cat install.sh | sh -s -- --help`, and the existing
repository-archive fixture. The piped help case must not invoke Docker or download
anything because help is handled before checkout resolution.

- [ ] **Step 2: Add platform tests**

Use `EDIORA_HOST_OS=Linux` with a Debian fixture and a usable fake Docker daemon to
prove an existing Docker installation works without Ubuntu metadata. Use
`EDIORA_HOST_OS=Darwin` without Docker to assert a Docker Desktop message and no apt
command. Keep the existing Ubuntu auto-install tests.

- [ ] **Step 3: Run the tests and observe the expected failure**

Run:

```bash
bash scripts/test-install.sh
```

Expected: the current Bash-only installer fails `sh -n`, piped execution cannot parse
the script, and the new platform cases fail before implementation.

### Task 2: Rewrite `install.sh` as POSIX shell

**Files:**
- Modify: `install.sh`

- [ ] **Step 1: Replace Bash-only syntax with POSIX equivalents**

Use POSIX functions, `case`, `[ ]`, file descriptor 3 for input, `stty` for hidden
terminal secrets, scalar `DOCKER_USE_SUDO` state instead of arrays, and `docker_cmd()`
instead of Bash array expansion. Remove Bash-only `BASH_SOURCE`, `[[ ]]`, `(( ))`,
`local`, `pipefail`, `ERR` traps, process substitution, and `%q` formatting.

- [ ] **Step 2: Preserve remote checkout behavior without self-download**

Use `$0` only to identify a local checkout. When running from stdin, resolve the
default `EDIORA_INSTALL_DIR`, download `main.tar.gz`, verify it contains
`install.sh` and `docker-compose.yml`, copy it, and run the copied `install.sh` with
the original arguments. The script must never download `install.sh` as a second copy.

- [ ] **Step 3: Implement platform branches**

Detect `Linux`/`Darwin` with `uname -s`. Parse `/etc/os-release` only on Linux. Permit
existing Docker on any Linux; permit apt bootstrap only on Ubuntu 22.04/24.04; and
produce Docker Desktop guidance on macOS when Docker is missing.

- [ ] **Step 4: Run the focused green tests**

Run:

```bash
sh -n install.sh
bash scripts/test-install.sh
```

Expected: the POSIX syntax, piped terminal, remote archive, Ubuntu, Linux, macOS,
environment, data-directory, pull/build, and readiness tests all pass.

### Task 3: Finish documentation and validation

**Files:**
- Modify: `README.md`
- Modify: `docs/self-hosted.md`
- Modify: `scripts/test-install.sh`

- [ ] **Step 1: Document the actual user-facing command**

Use `curl -fsSL .../install.sh | sh` in both documents. Explain that Ubuntu can
bootstrap Docker, other Linux needs Docker preinstalled, and macOS needs Docker
Desktop. Document `sh -s -- --yes` for piped non-interactive confirmation.

- [ ] **Step 2: Run final checks**

```bash
sh -n install.sh
bash -n scripts/test-install.sh
bash scripts/test-install.sh
DOCKER_CONFIG=/tmp/ediora-publish-docker-config docker compose --env-file .env.example config --quiet
git diff --check
```

- [ ] **Step 3: Commit the implementation**

```bash
git add install.sh scripts/test-install.sh README.md docs/self-hosted.md
git commit -m "feat: support single-file curl sh installer"
```
