#!/usr/bin/env bash
#
# Local runtime for Redis, FastAPI, the content-job worker, and Next.js.
# Usage: ./dev.sh {start|stop|restart|status|logs}
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT/backend"
FRONTEND_DIR="$ROOT/wemedia-studio"
LOG_DIR="${WMS_DEV_LOG_DIR:-$ROOT/logs}"
RUN_DIR="${WMS_DEV_RUN_DIR:-$ROOT/.run}"
CONDA_ENV="${WMS_CONDA_ENV:-wems}"

REDIS_PORT="${WMS_REDIS_PORT:-6379}"
API_PORT="${WMS_API_PORT:-8000}"
WEB_PORT="${WMS_WEB_PORT:-3000}"
HOST_REDIS_URL="redis://127.0.0.1:${REDIS_PORT}/0"
HOST_API_ROOT="http://127.0.0.1:${API_PORT}"
HOST_API_URL="${HOST_API_ROOT}/api"
HOST_WEB_URL="http://127.0.0.1:${WEB_PORT}"

source "$ROOT/scripts/dev-runtime.sh"

metadata_path() {
  printf '%s/%s.meta\n' "$RUN_DIR" "$1"
}

log_path() {
  printf '%s/%s.log\n' "$LOG_DIR" "$1"
}

validate_port() {
  local label="$1" value="$2"
  if ! [[ "$value" =~ ^[0-9]+$ ]] || [ "$value" -lt 1 ] || [ "$value" -gt 65535 ]; then
    printf '%s must be an integer between 1 and 65535\n' "$label" >&2
    return 1
  fi
}

validate_runtime_ports() {
  validate_port WMS_REDIS_PORT "$REDIS_PORT" \
    && validate_port WMS_API_PORT "$API_PORT" \
    && validate_port WMS_WEB_PORT "$WEB_PORT"
}

validate_runtime_tools() {
  local tool
  for tool in bash setsid ps awk grep tr sha256sum conda pnpm; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      printf '%s is required on PATH to start the local runtime\n' "$tool" >&2
      return 1
    fi
  done
  if ! command -v curl >/dev/null 2>&1 \
    && ! command -v python3 >/dev/null 2>&1; then
    printf 'curl or python3 is required for HTTP readiness checks\n' >&2
    return 1
  fi
  if ! command -v redis-cli >/dev/null 2>&1 \
    && ! command -v python3 >/dev/null 2>&1; then
    printf 'redis-cli or python3 is required for Redis readiness checks\n' >&2
    return 1
  fi
}

validate_worker_token() {
  local token="${WMS_WORKER_TOKEN:-}"
  if [ "${#token}" -lt 32 ]; then
    printf 'WMS_WORKER_TOKEN must contain at least 32 characters\n' >&2
    return 1
  fi
}

redis_ping() {
  local output
  if command -v redis-cli >/dev/null 2>&1; then
    output="$(
      redis-cli -h 127.0.0.1 -p "$REDIS_PORT" ping 2>/dev/null
    )" || return 1
    [ "$output" = PONG ]
    return
  fi
  command -v python3 >/dev/null 2>&1 || return 1
  python3 - "$REDIS_PORT" <<'PY' >/dev/null 2>&1
import socket
import sys

with socket.create_connection(("127.0.0.1", int(sys.argv[1])), timeout=1) as client:
    client.sendall(b"*1\r\n$4\r\nPING\r\n")
    if not client.recv(64).startswith(b"+PONG"):
        raise SystemExit(1)
PY
}

http_ready() {
  local url="$1"
  if command -v curl >/dev/null 2>&1; then
    curl --fail --silent --show-error --max-time 1 "$url" >/dev/null 2>&1
    return
  fi
  command -v python3 >/dev/null 2>&1 || return 1
  python3 - "$url" <<'PY' >/dev/null 2>&1
import sys
import urllib.request

with urllib.request.urlopen(sys.argv[1], timeout=1) as response:
    if not 200 <= response.status < 300:
        raise SystemExit(1)
PY
}

worker_ready() {
  dev_owned_identity_matches worker "$(metadata_path worker)"
}

runtime_fingerprint() {
  printf '%s\0' "$@" | sha256sum | awk '{ print $1 }'
}

api_owned_http_ready() {
  dev_owned_identity_matches api "$(metadata_path api)" \
    && http_ready "${HOST_API_ROOT}/health"
}

web_owned_http_ready() {
  dev_owned_identity_matches web "$(metadata_path web)" \
    && http_ready "${HOST_WEB_URL}/"
}

record_started_service() {
  [ "${DEV_LAST_START_CREATED:-0}" -eq 1 ] || return 0
  STARTED_THIS_RUN+=("$1")
}

rollback_start() {
  local index service
  [ "${#STARTED_THIS_RUN[@]}" -gt 0 ] || return 0
  printf 'Startup failed; rolling back newly owned services...\n' >&2
  for ((index = ${#STARTED_THIS_RUN[@]} - 1; index >= 0; index -= 1)); do
    service="${STARTED_THIS_RUN[$index]}"
    case "$service" in
      web) dev_stop_owned_service web Web "$(metadata_path web)" ;;
      worker) dev_stop_owned_service worker Worker "$(metadata_path worker)" ;;
      api) dev_stop_owned_service api API "$(metadata_path api)" ;;
      redis) dev_stop_owned_service redis Redis "$(metadata_path redis)" ;;
    esac
  done
}

ensure_redis_ready() {
  local redis_metadata
  redis_metadata="$(metadata_path redis)"

  if dev_owned_identity_matches redis "$redis_metadata"; then
    if ! dev_config_fingerprint_matches \
      "$redis_metadata" "$REDIS_CONFIG_FINGERPRINT"; then
      dev_stop_owned_service redis Redis "$redis_metadata"
    elif redis_ping; then
      printf '  ✓ Redis ready (owned pid %s)\n' \
        "$(dev_meta_value "$redis_metadata" pid)"
      return 0
    else
      dev_stop_owned_service redis Redis "$redis_metadata"
    fi
  elif [ -e "$redis_metadata" ]; then
    rm -f -- "$redis_metadata"
  fi

  if redis_ping; then
    printf '  ✓ Redis ready (external; it will not be stopped)\n'
    return 0
  fi

  if ! command -v redis-server >/dev/null 2>&1; then
    printf 'redis-server is required when no healthy external Redis is available\n' >&2
    return 1
  fi
  dev_start_owned_service \
    redis Redis "$ROOT" "$redis_metadata" "$(log_path redis)" \
    "$REDIS_CONFIG_FINGERPRINT" \
    redis-server --bind 127.0.0.1 --port "$REDIS_PORT" \
    --save "" --appendonly no || return 1
  record_started_service redis

  if ! dev_wait_for \
    "${WMS_DEV_READY_TIMEOUT_SECONDS:-30}" \
    "${WMS_DEV_POLL_INTERVAL_SECONDS:-0.1}" \
    redis_ping; then
    printf 'Redis did not answer PING before the readiness timeout\n' >&2
    return 1
  fi
  printf '  ✓ Redis ready (owned)\n'
}

ensure_api_ready() {
  local api_metadata
  api_metadata="$(metadata_path api)"

  if dev_owned_identity_matches api "$api_metadata"; then
    if ! dev_config_fingerprint_matches \
      "$api_metadata" "$RUNTIME_CONFIG_FINGERPRINT"; then
      dev_stop_owned_service api API "$api_metadata"
    elif api_owned_http_ready; then
      printf '  ✓ API ready (owned pid %s)\n' "$(dev_meta_value "$api_metadata" pid)"
      return 0
    else
      dev_stop_owned_service api API "$api_metadata"
    fi
  elif [ -e "$api_metadata" ]; then
    rm -f -- "$api_metadata"
  fi

  dev_start_owned_service \
    api API "$BACKEND_DIR" "$api_metadata" "$(log_path api)" \
    "$RUNTIME_CONFIG_FINGERPRINT" \
    conda run --no-capture-output -n "$CONDA_ENV" \
    uvicorn main:app --host 0.0.0.0 --port "$API_PORT" --reload || return 1
  record_started_service api
  if ! dev_wait_for \
    "${WMS_DEV_READY_TIMEOUT_SECONDS:-30}" \
    "${WMS_DEV_POLL_INTERVAL_SECONDS:-0.1}" \
    api_owned_http_ready; then
    printf 'API did not become HTTP-ready before the readiness timeout; see %s\n' \
      "$(log_path api)" >&2
    return 1
  fi
  sleep "${WMS_DEV_HTTP_SETTLE_SECONDS:-0.2}"
  if ! api_owned_http_ready; then
    printf 'API lost process ownership or HTTP readiness during startup; see %s\n' \
      "$(log_path api)" >&2
    return 1
  fi
  printf '  ✓ API HTTP ready\n'
}

ensure_worker_ready() {
  local worker_metadata
  worker_metadata="$(metadata_path worker)"

  if dev_owned_identity_matches worker "$worker_metadata" \
    && dev_config_fingerprint_matches \
      "$worker_metadata" "$RUNTIME_CONFIG_FINGERPRINT"; then
    printf '  ✓ Worker process alive (owned pid %s)\n' \
      "$(dev_meta_value "$worker_metadata" pid)"
    return 0
  fi
  if dev_owned_identity_matches worker "$worker_metadata"; then
    dev_stop_owned_service worker Worker "$worker_metadata"
  elif [ -e "$worker_metadata" ]; then
    rm -f -- "$worker_metadata"
  fi

  dev_start_owned_service \
    worker Worker "$FRONTEND_DIR" "$worker_metadata" "$(log_path worker)" \
    "$RUNTIME_CONFIG_FINGERPRINT" \
    pnpm jobs:worker || return 1
  record_started_service worker
  sleep "${WMS_DEV_WORKER_SETTLE_SECONDS:-0.5}"
  if ! worker_ready; then
    printf 'Worker exited during its readiness window; see %s\n' \
      "$(log_path worker)" >&2
    return 1
  fi
  printf '  ✓ Worker process alive (content-jobs queue)\n'
}

ensure_web_ready() {
  local web_metadata
  web_metadata="$(metadata_path web)"

  if dev_owned_identity_matches web "$web_metadata"; then
    if ! dev_config_fingerprint_matches \
      "$web_metadata" "$WEB_CONFIG_FINGERPRINT"; then
      dev_stop_owned_service web Web "$web_metadata"
    elif web_owned_http_ready; then
      printf '  ✓ Web ready (owned pid %s)\n' "$(dev_meta_value "$web_metadata" pid)"
      return 0
    else
      dev_stop_owned_service web Web "$web_metadata"
    fi
  elif [ -e "$web_metadata" ]; then
    rm -f -- "$web_metadata"
  fi

  dev_start_owned_service \
    web Web "$FRONTEND_DIR" "$web_metadata" "$(log_path web)" \
    "$WEB_CONFIG_FINGERPRINT" \
    pnpm exec next dev --hostname 0.0.0.0 --port "$WEB_PORT" || return 1
  record_started_service web
  if ! dev_wait_for \
    "${WMS_DEV_READY_TIMEOUT_SECONDS:-30}" \
    "${WMS_DEV_POLL_INTERVAL_SECONDS:-0.1}" \
    web_owned_http_ready; then
    printf 'Web did not become HTTP-ready before the readiness timeout; see %s\n' \
      "$(log_path web)" >&2
    return 1
  fi
  sleep "${WMS_DEV_HTTP_SETTLE_SECONDS:-0.2}"
  if ! web_owned_http_ready; then
    printf 'Web lost process ownership or HTTP readiness during startup; see %s\n' \
      "$(log_path web)" >&2
    return 1
  fi
  printf '  ✓ Web HTTP ready\n'
}

cmd_start() {
  validate_worker_token || return 1
  validate_runtime_ports || return 1
  validate_runtime_tools || return 1
  mkdir -p -- "$LOG_DIR" "$RUN_DIR"

  export WMS_REDIS_URL="$HOST_REDIS_URL"
  export WMS_API_URL="$HOST_API_URL"
  export NEXT_PUBLIC_API_URL="$HOST_API_URL"
  export WMS_WORKER_QUEUE="${WMS_WORKER_QUEUE:-content-jobs}"
  REDIS_CONFIG_FINGERPRINT="$(runtime_fingerprint "$HOST_REDIS_URL")"
  RUNTIME_CONFIG_FINGERPRINT="$(
    runtime_fingerprint \
      "$HOST_REDIS_URL" "$WMS_WORKER_QUEUE" "$WMS_WORKER_TOKEN" "$HOST_API_URL"
  )"
  WEB_CONFIG_FINGERPRINT="$(runtime_fingerprint "$HOST_API_URL" "$HOST_WEB_URL")"
  STARTED_THIS_RUN=()

  printf 'Starting WeMedia Studio local runtime...\n'
  ensure_redis_ready || { rollback_start; return 1; }
  ensure_api_ready || { rollback_start; return 1; }
  ensure_worker_ready || { rollback_start; return 1; }
  ensure_web_ready || { rollback_start; return 1; }

  printf '\n'
  printf '  Web:    %s\n' "$HOST_WEB_URL"
  printf '  API:    %s (docs: /docs)\n' "$HOST_API_ROOT"
  printf '  Worker: %s\n' "$WMS_WORKER_QUEUE"
  printf '  Redis:  %s\n' "$HOST_REDIS_URL"
  printf '  Logs:   ./dev.sh logs    Stop: ./dev.sh stop\n'
}

cmd_stop() {
  validate_runtime_ports || return 1
  printf 'Stopping WeMedia Studio local runtime...\n'
  dev_stop_owned_service web Web "$(metadata_path web)"
  dev_stop_owned_service worker Worker "$(metadata_path worker)"
  dev_stop_owned_service api API "$(metadata_path api)"
  if [ -e "$(metadata_path redis)" ]; then
    dev_stop_owned_service redis Redis "$(metadata_path redis)"
  elif redis_ping; then
    printf '  • Redis is external and was left running\n'
  else
    printf '  • Redis is not running\n'
  fi
}

service_status() {
  local service="$1" name="$2" readiness_kind="$3" ready_target="${4:-}"
  local metadata pid
  metadata="$(metadata_path "$service")"
  if ! dev_owned_identity_matches "$service" "$metadata"; then
    if [ -e "$metadata" ]; then
      rm -f -- "$metadata"
      printf '  %-7s stale ownership metadata removed\n' "$name"
    else
      printf '  %-7s stopped\n' "$name"
    fi
    return
  fi
  pid="$(dev_meta_value "$metadata" pid)"
  case "$readiness_kind" in
    redis)
      redis_ping \
        && printf '  %-7s ready (owned pid %s)\n' "$name" "$pid" \
        || printf '  %-7s process alive but PING failed (owned pid %s)\n' "$name" "$pid"
      ;;
    http)
      http_ready "$ready_target" \
        && printf '  %-7s HTTP ready (owned pid %s)\n' "$name" "$pid" \
        || printf '  %-7s process alive but HTTP not ready (owned pid %s)\n' "$name" "$pid"
      ;;
    process)
      printf '  %-7s process alive (owned pid %s)\n' "$name" "$pid"
      ;;
  esac
}

cmd_status() {
  validate_runtime_ports || return 1
  if dev_owned_identity_matches redis "$(metadata_path redis)"; then
    service_status redis Redis redis
  elif redis_ping; then
    [ ! -e "$(metadata_path redis)" ] || rm -f -- "$(metadata_path redis)"
    printf '  Redis   ready (external; not owned)\n'
  else
    service_status redis Redis redis
  fi
  service_status api API http "${HOST_API_ROOT}/health"
  service_status worker Worker process
  service_status web Web http "${HOST_WEB_URL}/"
}

print_log_snapshot() {
  local service="$1" name="$2" file
  file="$(log_path "$service")"
  printf '\n===== %s =====\n' "$name"
  if [ -s "$file" ]; then
    tail -n 40 -- "$file"
  else
    printf '(no log output)\n'
  fi
}

cmd_logs() {
  local follow="${1:-}"
  mkdir -p -- "$LOG_DIR"
  print_log_snapshot redis Redis
  print_log_snapshot api API
  print_log_snapshot worker Worker
  print_log_snapshot web Web
  if [ "$follow" = "--no-follow" ]; then
    return 0
  fi
  printf '\nFollowing logs (Ctrl-C to exit)...\n'
  touch -- "$(log_path redis)" "$(log_path api)" "$(log_path worker)" "$(log_path web)"
  tail -n 0 -F -- \
    "$(log_path redis)" "$(log_path api)" "$(log_path worker)" "$(log_path web)"
}

case "${1:-start}" in
  start)
    cmd_start
    ;;
  stop)
    cmd_stop
    ;;
  restart)
    validate_worker_token \
      && validate_runtime_ports \
      && validate_runtime_tools \
      && cmd_stop \
      && printf '\n' \
      && cmd_start
    ;;
  status)
    cmd_status
    ;;
  logs)
    cmd_logs "${2:-}"
    ;;
  *)
    printf 'Usage: %s {start|stop|restart|status|logs [--no-follow]}\n' "$0" >&2
    exit 1
    ;;
esac
