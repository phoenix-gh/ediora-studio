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
EFFECTIVE_CORS_ORIGINS="${WMS_CORS_ORIGINS:-${HOST_WEB_URL},http://localhost:${WEB_PORT}}"
WORKER_READY_FILE="$RUN_DIR/worker.ready"

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
  local metadata marker fingerprint ready_marker ready_fingerprint
  metadata="$(metadata_path worker)"
  dev_owned_identity_matches worker "$metadata" || return 1
  marker="$(dev_meta_value "$metadata" marker 2>/dev/null)" || return 1
  fingerprint="$(
    dev_meta_value "$metadata" config_fingerprint 2>/dev/null
  )" || return 1
  if [ -n "${APPLICATION_CONFIG_FINGERPRINT:-}" ] \
    && [ "$fingerprint" != "$APPLICATION_CONFIG_FINGERPRINT" ]; then
    return 1
  fi
  ready_marker="$(
    dev_meta_value "$WORKER_READY_FILE" marker 2>/dev/null
  )" || return 1
  ready_fingerprint="$(
    dev_meta_value "$WORKER_READY_FILE" config_fingerprint 2>/dev/null
  )" || return 1
  [ "$ready_marker" = "$marker" ] \
    && [ "$ready_fingerprint" = "$fingerprint" ]
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
  local index service failed=0
  [ "${#STARTED_THIS_RUN[@]}" -gt 0 ] || return 0
  printf 'Startup failed; rolling back newly owned services...\n' >&2
  for ((index = ${#STARTED_THIS_RUN[@]} - 1; index >= 0; index -= 1)); do
    service="${STARTED_THIS_RUN[$index]}"
    case "$service" in
      web)
        dev_stop_owned_service web Web "$(metadata_path web)" || failed=1
        ;;
      worker)
        dev_stop_owned_service worker Worker "$(metadata_path worker)" \
          || failed=1
        rm -f -- "$WORKER_READY_FILE"
        ;;
      api)
        dev_stop_owned_service api API "$(metadata_path api)" || failed=1
        ;;
      redis)
        dev_stop_owned_service redis Redis "$(metadata_path redis)" || failed=1
        ;;
    esac
  done
  return "$failed"
}

application_unit_has_state() {
  [ -e "$(metadata_path api)" ] \
    || [ -e "$(metadata_path worker)" ] \
    || [ -e "$(metadata_path web)" ] \
    || [ -e "$WORKER_READY_FILE" ]
}

application_unit_ready() {
  local service metadata
  for service in api worker web; do
    metadata="$(metadata_path "$service")"
    dev_owned_identity_matches "$service" "$metadata" || return 1
    dev_config_fingerprint_matches \
      "$metadata" "$APPLICATION_CONFIG_FINGERPRINT" || return 1
  done
  api_owned_http_ready \
    && worker_ready \
    && web_owned_http_ready
}

stop_application_unit() {
  local failed=0
  dev_stop_owned_service web Web "$(metadata_path web)" || failed=1
  dev_stop_owned_service worker Worker "$(metadata_path worker)" || failed=1
  rm -f -- "$WORKER_READY_FILE"
  dev_stop_owned_service api API "$(metadata_path api)" || failed=1
  return "$failed"
}

prepare_application_unit() {
  APPLICATION_UNIT_REUSED=0
  if application_unit_ready; then
    APPLICATION_UNIT_REUSED=1
    printf '  ✓ API HTTP ready (owned pid %s)\n' \
      "$(dev_meta_value "$(metadata_path api)" pid)"
    printf '  ✓ Worker ready handshake valid (owned pid %s)\n' \
      "$(dev_meta_value "$(metadata_path worker)" pid)"
    printf '  ✓ Web HTTP ready (owned pid %s)\n' \
      "$(dev_meta_value "$(metadata_path web)" pid)"
    return 0
  fi
  if application_unit_has_state; then
    printf '  • Replacing the coordinated API/Worker/Web unit\n'
    stop_application_unit || return 1
  fi
  rm -f -- "$WORKER_READY_FILE"
}

redis_transport_reusable() {
  local redis_metadata
  redis_metadata="$(metadata_path redis)"
  if dev_owned_identity_matches redis "$redis_metadata"; then
    dev_config_fingerprint_matches \
      "$redis_metadata" "$REDIS_CONFIG_FINGERPRINT" \
      && redis_ping
    return
  fi
  redis_ping
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

  dev_start_owned_service \
    api API "$BACKEND_DIR" "$api_metadata" "$(log_path api)" \
    "$APPLICATION_CONFIG_FINGERPRINT" \
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

  rm -f -- "$WORKER_READY_FILE"
  dev_start_owned_service \
    worker Worker "$FRONTEND_DIR" "$worker_metadata" "$(log_path worker)" \
    "$APPLICATION_CONFIG_FINGERPRINT" \
    pnpm jobs:worker || return 1
  record_started_service worker
  if ! dev_wait_for \
    "${WMS_DEV_READY_TIMEOUT_SECONDS:-30}" \
    "${WMS_DEV_POLL_INTERVAL_SECONDS:-0.1}" \
    worker_ready; then
    printf 'Worker did not publish its current ready handshake; see %s\n' \
      "$(log_path worker)" >&2
    return 1
  fi
  printf '  ✓ Worker ready handshake valid (content-jobs queue)\n'
}

ensure_web_ready() {
  local web_metadata
  web_metadata="$(metadata_path web)"

  dev_start_owned_service \
    web Web "$FRONTEND_DIR" "$web_metadata" "$(log_path web)" \
    "$APPLICATION_CONFIG_FINGERPRINT" \
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
  export WMS_CORS_ORIGINS="$EFFECTIVE_CORS_ORIGINS"
  export WMS_WORKER_READY_FILE="$WORKER_READY_FILE"
  REDIS_CONFIG_FINGERPRINT="$(runtime_fingerprint "$HOST_REDIS_URL")"
  APPLICATION_CONFIG_FINGERPRINT="$(
    runtime_fingerprint \
      "$HOST_REDIS_URL" \
      "$WMS_WORKER_QUEUE" \
      "$WMS_WORKER_TOKEN" \
      "$HOST_API_URL" \
      "$HOST_WEB_URL" \
      "$WMS_CORS_ORIGINS"
  )"
  STARTED_THIS_RUN=()

  printf 'Starting WeMedia Studio local runtime...\n'
  if ! redis_transport_reusable && application_unit_has_state; then
    printf '  • Stopping API/Worker/Web before replacing Redis\n'
    stop_application_unit || { rollback_start; return 1; }
  fi
  ensure_redis_ready || { rollback_start; return 1; }
  prepare_application_unit || { rollback_start; return 1; }
  if [ "$APPLICATION_UNIT_REUSED" -eq 1 ]; then
    print_runtime_summary
    return 0
  fi
  ensure_api_ready || { rollback_start; return 1; }
  ensure_worker_ready || { rollback_start; return 1; }
  ensure_web_ready || { rollback_start; return 1; }

  print_runtime_summary
}

print_runtime_summary() {
  printf '\n'
  printf '  Web:    %s\n' "$HOST_WEB_URL"
  printf '  API:    %s (docs: /docs)\n' "$HOST_API_ROOT"
  printf '  Worker: %s\n' "$WMS_WORKER_QUEUE"
  printf '  Redis:  %s\n' "$HOST_REDIS_URL"
  printf '  Logs:   ./dev.sh logs    Stop: ./dev.sh stop\n'
}

cmd_stop() {
  local failed=0
  validate_runtime_ports || return 1
  printf 'Stopping WeMedia Studio local runtime...\n'
  stop_application_unit || failed=1
  if [ -e "$(metadata_path redis)" ]; then
    dev_stop_owned_service redis Redis "$(metadata_path redis)" || failed=1
  elif redis_ping; then
    printf '  • Redis is external and was left running\n'
  else
    printf '  • Redis is not running\n'
  fi
  return "$failed"
}

service_status() {
  local service="$1" name="$2" readiness_kind="$3" ready_target="${4:-}"
  local metadata pid
  metadata="$(metadata_path "$service")"
  if ! dev_owned_identity_matches "$service" "$metadata"; then
    if [ -e "$metadata" ] \
      && dev_owned_group_matches_service "$service" "$metadata"; then
      printf '  %-7s orphaned owned process group remains; run ./dev.sh stop\n' \
        "$name"
      return 1
    fi
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
    worker)
      worker_ready \
        && printf '  %-7s ready handshake valid (owned pid %s)\n' "$name" "$pid" \
        || printf '  %-7s process alive but ready handshake invalid (owned pid %s)\n' "$name" "$pid"
      ;;
  esac
}

cmd_status() {
  local unhealthy=0 redis_metadata
  validate_runtime_ports || return 1
  redis_metadata="$(metadata_path redis)"
  if dev_owned_identity_matches redis "$redis_metadata" \
    || dev_owned_group_matches_service redis "$redis_metadata"; then
    service_status redis Redis redis || unhealthy=1
  elif redis_ping; then
    [ ! -e "$redis_metadata" ] || rm -f -- "$redis_metadata"
    printf '  Redis   ready (external; not owned)\n'
  else
    service_status redis Redis redis || unhealthy=1
  fi
  service_status api API http "${HOST_API_ROOT}/health" || unhealthy=1
  service_status worker Worker worker || unhealthy=1
  service_status web Web http "${HOST_WEB_URL}/" || unhealthy=1
  return "$unhealthy"
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
