# Ediora Docker Bootstrap Installer Design

## Goal

Provide one idempotent installer for Ubuntu 22.04 and 24.04 hosts. It must
work when Docker is absent by asking for confirmation, installing Docker
Engine and Compose v2, collecting the required `.env` values, pulling the
published Ediora image, starting the existing Compose stack, and reporting
service readiness.

The installer is Docker-first. It does not install Python, Node.js,
PostgreSQL, Redis, or Chromium directly on the host.

## Supported entry points

The repository root gains `install.sh` with two supported entry points:

```bash
./install.sh
```

from an existing checkout, or:

```bash
curl -fsSL https://raw.githubusercontent.com/phoenix-gh/ediora-studio/main/install.sh | bash
```

When invoked remotely, the script clones the public repository into
`EDIORA_INSTALL_DIR` (default `$HOME/ediora-studio`) and re-executes from
that checkout. When invoked from a checkout, it uses the current repository
and does not clone or overwrite source files.

The first version supports Ubuntu 22.04 and 24.04 only. It exits clearly for
other systems. macOS, Windows, native host dependency installation,
Kubernetes, and remote Docker hosts are out of scope.

## User flow

1. Print the detected OS, checkout, image, and host ports.
2. Check for a working Docker CLI and Compose v2 plugin.
3. If Docker is missing, explain that the script will install Docker Engine,
   Buildx, and Compose through Docker's official Ubuntu apt repository, then
   require explicit `y`/`yes` confirmation before invoking `sudo`.
4. Check for an existing `.env`. Preserve it byte-for-byte and prompt only
   for missing values. Without a terminal, fail with setup instructions
   instead of silently choosing secrets.
5. Generate cryptographically random defaults for secrets when accepted.
   Never print secret values after collection.
6. Write the environment file with mode `0600`.
7. Run `docker compose pull` for the configured application, PostgreSQL, and
   Redis images.
8. Run `docker compose up -d --no-build`; the default path never builds
   locally.
9. Wait for PostgreSQL, Redis, API health, and Web readiness.
10. Print the Web URL, API health URL, checkout path, and safe commands for
    status, logs, and shutdown.

A second run reuses the checkout, preserves `.env`, pulls newer layers, and
reconciles changed services without deleting application volumes.

## Docker installation

The Docker installation path runs only after confirmation. It uses Docker's
official Ubuntu apt repository and installs:

- `ca-certificates`, `curl`, and `gnupg`;
- Docker Engine and CLI;
- `docker-buildx-plugin` and `docker-compose-plugin`.

It enables and starts Docker, then verifies `docker version` and
`docker compose version`. The script must not run Compose before both the
daemon and plugin are usable.

If the current user cannot access the daemon after installation, the script
may use `sudo docker` for the current run and explains that a new login is
needed for docker-group access. It must not pretend an unprivileged command
works. It must not use third-party `curl | sh` package installers.

## Environment contract

The installer writes the root `.env` consumed by the existing
`docker-compose.yml`. Defaults are:

```dotenv
POSTGRES_PASSWORD=<generated>
WORKER_TOKEN=<generated 32+ character token>
X_SESSION_KEY=<generated stable Fernet key>
WORKER_QUEUE=content-jobs
VIDEO_WORKER_QUEUE=content-jobs:video
CORS_ORIGINS=http://localhost:3000
API_PORT=8000
WEB_PORT=3000
NEXT_PUBLIC_API_URL=http://localhost:8000/api
APP_IMAGE=ghcr.io/phoenix-gh/ediora-studio
IMAGE_TAG=latest
```

The script prompts for user-controlled values and accepts safe defaults. It
validates the worker token length, non-empty database password, valid and
distinct host ports, HTTP(S) API URL, image reference, and image tag.

Provider credentials are not prompted for or written to `.env`. After the
stack is ready, LLM, image, speech, and HeyGen keys are entered through the
Ediora Settings page, matching the Settings-only runtime contract.

The installer never overwrites an existing `.env`, echoes its contents, or
includes secret values in errors.

## Image and Compose behavior

Unless already present in `.env` or explicitly overridden, the installer uses
`APP_IMAGE=ghcr.io/phoenix-gh/ediora-studio` and `IMAGE_TAG=latest`. It runs
`docker compose pull` followed by `docker compose up -d --no-build`.

If GHCR authentication is required, preserve the Compose error and add a
hint to run `docker login ghcr.io`; never ask for or store registry passwords.

The `local-asr` profile is not started by default. Completion output points
to `docker compose --profile local-asr up -d`.

The installer does not change database schema, volumes, service names, or
the Compose network contract.

## Failure handling and safety

- Use `set -Eeuo pipefail` and an error trap that omits secret arguments.
- Refuse normal root execution; use `sudo` only for Docker package/service
  operations, while keeping the checkout and `.env` owned by the user.
- Never run `docker compose down -v`, remove volumes, delete a checkout, or
  remove unrelated Docker packages.
- On a later failure, leave `.env` and downloaded images for retry; do not
  automatically tear down a pre-existing Compose project.
- Use a deterministic Compose project derived from the checkout directory.
- Return non-zero for unsupported OS, declined Docker installation, invalid
  input, package failure, pull failure, or readiness timeout.

## Implementation shape

Keep the installer as a standalone Bash script with small functions for
source/argument resolution, Ubuntu detection, Docker installation, daemon
access selection, `.env` prompting and validation, Compose execution, and
readiness polling. Compose remains the single source of truth for topology.

The script supports `--help`, `--yes` for already-confirmed Docker
installation, and `--build` as an explicit opt-in local-build path. The
default remains published-image pull.

## Testing and acceptance

Add shell-level tests that do not modify the host Docker daemon:

- `bash -n install.sh` passes;
- mocked `sudo`, `apt-get`, `systemctl`, `docker`, and `curl` verify Docker
  installation ordering and the confirmation gate;
- declining Docker installation exits before package commands;
- existing `.env` values are preserved and only missing values are added;
- generated secrets are not printed and the file mode is `0600`;
- the Compose sequence is `pull` then `up -d --no-build`;
- pull/readiness failures return non-zero without destructive cleanup;
- `docker compose config --quiet` accepts the generated environment file.

Documentation must include the one-line command, Docker consent prompt,
`.env` behavior, Settings credential step, status/log commands, and optional
local-ASR profile command.
