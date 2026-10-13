#!/usr/bin/env bash
# One container runs the API, the worker, the web server, and a single Codex app-server.
set -euo pipefail

export CODEX_HOME="${CODEX_HOME:-/codex-home}"
codex_listen="ws://127.0.0.1:4500"

python -c 'import os, sys; ok = len(os.environ.get("WORKER_TOKEN", "")) >= 32; sys.stderr.write("" if ok else "WORKER_TOKEN must contain at least 32 characters\n"); sys.exit(0 if ok else 1)'

pids=()
cleanup() {
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait || true
}
trap cleanup EXIT INT TERM

codex app-server --listen "$codex_listen" &
pids+=("$!")

ready=0
for _ in $(seq 1 100); do
  if python -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:4500/readyz", timeout=0.2).read()' >/dev/null 2>&1; then
    ready=1
    break
  fi
  if ! kill -0 "${pids[0]}" 2>/dev/null; then
    echo "codex app-server exited before ${codex_listen} was ready" >&2
    exit 1
  fi
  sleep 0.1
done
if [[ "$ready" -ne 1 ]]; then
  echo "codex app-server did not accept ${codex_listen}" >&2
  exit 1
fi

cd /app
if [[ "${EDIORA_PROCESS_MODE:-production}" == "development" ]]; then
  uvicorn main:app --host 0.0.0.0 --port 8000 --reload &
else
  uvicorn main:app --host 0.0.0.0 --port 8000 &
fi
pids+=("$!")

api_ready=0
for _ in $(seq 1 150); do
  if python -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=0.2).read()' >/dev/null 2>&1; then
    api_ready=1
    break
  fi
  if ! kill -0 "${pids[1]}" 2>/dev/null; then
    echo "API exited before http://127.0.0.1:8000/health was ready" >&2
    exit 1
  fi
  sleep 0.2
done
if [[ "$api_ready" -ne 1 ]]; then
  echo "API did not accept http://127.0.0.1:8000/health" >&2
  exit 1
fi

cd /app/web
./node_modules/.bin/tsx scripts/content-worker.ts &
pids+=("$!")

if [[ "${EDIORA_PROCESS_MODE:-production}" == "development" ]]; then
  ./node_modules/.bin/next dev --hostname 0.0.0.0 --port 3000 &
else
  ./node_modules/.bin/next start --hostname 0.0.0.0 --port 3000 &
fi
pids+=("$!")

wait -n
exit 1
