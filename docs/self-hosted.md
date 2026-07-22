# Self-hosted deployment

WeMedia Studio runs as a single-user application with no login requirement.
It does not require Hermes, agent profiles, a Kanban board, or a local terminal
agent.

## Start

```bash
cp .env.example .env
# Set POSTGRES_PASSWORD and WMS_LLM_API_KEY in .env.
docker compose up --build
```

Open `http://localhost:3000`. The API health endpoint is
`http://localhost:8000/health`.

## Services

- `web`: Next.js UI, Jobs page, and Vercel AI SDK orchestration.
- `worker`: Node worker that consumes content jobs and calls the configured LLM.
- `api`: Python collection, publishing, assets, and durable job-state service.
- `postgres`: persistent business and job data.
- `redis`: work-queue transport only; job state remains in Postgres.

## Model configuration

Set these server-only values in `.env`:

```dotenv
WMS_LLM_API_KEY=...
WMS_LLM_MODEL=gpt-4o-mini
# Optional OpenAI-compatible endpoint:
WMS_LLM_BASE_URL=
# Image jobs can use a separate OpenAI-compatible image provider; otherwise
# they reuse WMS_LLM_API_KEY and WMS_LLM_BASE_URL.
WMS_IMAGE_API_KEY=
WMS_IMAGE_MODEL=gpt-image-1
WMS_IMAGE_BASE_URL=
```

Do not use `NEXT_PUBLIC_` for credentials. Publishing remains an explicit
operation from the draft UI; content-job execution never publishes by itself.

## Recovery

Failed job steps are visible in **创作任务** and may be retried. The job and
event records are durable, so restarting the worker does not erase history.
Back up the `postgres-data` volume before upgrades.

## First open-source version scope

The worker supports draft, cover, inline illustration, and daily-plan jobs.
Image jobs require an image-capable configured provider. Jobs never publish as
a side effect of generation.
