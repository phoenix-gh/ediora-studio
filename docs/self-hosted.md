# Self-hosted deployment

Ediora runs as a single-user application with no login requirement.
It does not require Hermes, agent profiles, a Kanban board, or a local terminal
agent.

## One-click install

Supported hosts are Linux and macOS. Ubuntu 22.04/24.04 can receive the optional
Docker package bootstrap; other Linux distributions must already have Docker
Engine/Compose v2, and macOS must already have Docker Desktop installed and running.
From an existing checkout run:

```bash
./install.sh
```

On a new host, run:

```bash
curl -fsSL https://raw.githubusercontent.com/phoenix-gh/ediora-studio/main/install.sh | sh
```

The installer checks Docker Engine and Compose v2 first. On Ubuntu 22.04/24.04,
if either is not usable, it explains the official Docker apt installation and
waits for an explicit `y`/`yes` confirmation before using `sudo`. On macOS it
reports the Docker Desktop prerequisite; it does not run apt or install Docker
Desktop. Other Linux distributions must have Docker installed by the operator.
The installer does not install the application's Python, Node.js, PostgreSQL,
or Redis dependencies directly on the host.

It creates or completes `.env` interactively, preserves existing assignments,
sets mode `0600`, creates the Compose-local `data/` persistence directories,
and generates safe defaults for the required internal secrets. Provider API
keys are not collected or stored in `.env`; configure
LLM, image, speech, and HeyGen credentials from Ediora **Settings** after the
Web service is ready. Re-running the installer preserves `.env` and the
Compose-local `data/` directory. It does not migrate or delete existing Docker
named volumes. Use `--build` only when a local application-image build is intended;
the default is the published GHCR image and `docker compose pull` followed by
`docker compose up -d --no-build`.

Useful options and commands:

```bash
./install.sh --yes       # skip only the Docker installation confirmation
./install.sh --build     # build the shared application image locally
# For a piped command, append: sh -s -- --yes
docker compose ps
docker compose logs -f api worker web
docker compose stop
```

All self-hosted runtime data is stored beside `docker-compose.yml`:

```text
data/postgres         PostgreSQL business and job data
data/redis            Redis queue data
data/uploads          uploaded and generated media
data/sessions         X/feedgrab sessions (mode 700)
data/web-runtime      uploaded Skills and their enabled state
data/scheduler        scheduler throttle state
data/avatars          avatar cache
data/wechat-images    WeChat image cache
data/local-asr-models optional local-ASR model cache
```

Back up at least `data/postgres`, `data/uploads`, `data/sessions`,
`data/web-runtime`, and `.env` before upgrades. Keep `X_SESSION_KEY` in `.env`
with `data/sessions`; changing it makes encrypted X session files unreadable.
The cache directories can be rebuilt, and Redis is queue transport rather than
the authoritative job store.

If the GHCR package is private, authenticate first with `docker login ghcr.io`.
The optional GPU-backed local ASR service is not started by the installer:

```bash
docker compose --profile local-asr up -d
```

## Manual start

```bash
cp .env.example .env
# Set POSTGRES_PASSWORD and WORKER_TOKEN in .env; configure provider keys in Settings.
docker compose up --build
```

Open `http://localhost:3000`. The API health endpoint is
`http://localhost:8000/health`.

The API, worker, and Web services share one application image built from the
root `Dockerfile`; Postgres and Redis remain separate services. The optional
GPU-backed local ASR service is not started by default. Enable it explicitly:

```bash
docker compose --profile local-asr up --build
```

`NEXT_PUBLIC_API_URL` is embedded into the Next.js browser bundle at build
time, so changing it requires rebuilding the application image.

If host ports `8000` or `3000` are already in use, set `API_PORT` or
`WEB_PORT` in `.env`; the container ports remain unchanged.

## GitHub Actions and GHCR

Pull requests and non-`main` pushes run build verification only. A push to
`main` publishes the unified image using the repository `GITHUB_TOKEN`:

```text
ghcr.io/phoenix-gh/ediora-studio:latest
ghcr.io/phoenix-gh/ediora-studio:sha-<commit>
```

You can also manually run the workflow on `main` and enable `Publish the image
to GHCR`. To use the published image locally, set these values in `.env`:

```dotenv
APP_IMAGE=ghcr.io/phoenix-gh/ediora-studio
IMAGE_TAG=latest
```

Then run `docker compose up -d --no-build`. Authenticate with
`docker login ghcr.io` first if the package is private.

## Services

- `web`: Next.js UI, Jobs page, and Vercel AI SDK orchestration.
- `worker`: Node worker that consumes content jobs and calls the configured LLM. Long video jobs (`digital_human_shot_render`, `digital_human_stitch`, `digital_human_render`, `text_video_render`) go to `VIDEO_WORKER_QUEUE` (`content-jobs:video` by default) so they do not block drafts, daily creation, or image jobs. The same worker process listens to both queues.
- `api`: Python collection, publishing, assets, and durable job-state service.
- `postgres`: persistent business and job data in `data/postgres`.
- `redis`: work-queue transport in `data/redis`; job state remains in Postgres.

## Model configuration

Configure LLM, image, speech, and HeyGen provider credentials from the
Settings page. They are persisted in PostgreSQL and are not read from `.env`
or injected into the Compose services.

Do not use `NEXT_PUBLIC_` for credentials. Publishing remains an explicit
operation from the draft UI; content-job execution never publishes by itself.

## Recovery

Failed job steps are visible in **创作任务** and may be retried. The job and
event records are durable, so restarting the worker does not erase history.
Back up `data/postgres` before upgrades; do not use `docker compose down -v`
when the data must be retained.

## Backend tests

Backend tests require PostgreSQL and never fall back to an embedded database.
Each database test creates an isolated database named
`wemedia_test_<random suffix>` and drops it during fixture cleanup, so the
development database is never reused or truncated.

Set the administrative connection when it differs from the local development
default. The connected role must have `CREATEDB` permission:

```dotenv
TEST_DATABASE_ADMIN_URL=postgresql+asyncpg://wemedia:wemedia@127.0.0.1:55432/postgres
```

Run the suite from the repository root:

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests -q
```

## First open-source version scope

The worker supports draft, cover, inline illustration, and reusable creation-rule jobs.
Image jobs require an image-capable configured provider. Jobs never publish as
a side effect of generation.
