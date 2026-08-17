#!/usr/bin/env bash

set -uo pipefail

ROOT_DIR=$(cd -- "$(dirname -- "$0")/.." && pwd)
INSTALLER_SOURCE="$ROOT_DIR/install.sh"
TOTAL=0
FAILED=0
CASE_DIR=''

fail() {
  printf 'FAIL: %s\n' "$*"
  FAILED=$((FAILED + 1))
}

pass() {
  printf 'PASS: %s\n' "$*"
}

assert_contains() {
  local path=$1
  local pattern=$2
  local message=$3
  if ! grep -Fq -- "$pattern" "$path"; then
    fail "$message (missing '$pattern')"
    return 1
  fi
}

assert_not_contains() {
  local path=$1
  local pattern=$2
  local message=$3
  if grep -Fq -- "$pattern" "$path"; then
    fail "$message (found '$pattern')"
    return 1
  fi
}

assert_file_exists() {
  local path=$1
  local message=$2
  if [[ ! -f "$path" ]]; then
    fail "$message ($path is missing)"
    return 1
  fi
}

assert_log_contains() {
  assert_contains "$EDIORA_COMMAND_LOG" "$1" "$2"
}

assert_log_not_contains() {
  assert_not_contains "$EDIORA_COMMAND_LOG" "$1" "$2"
}

assert_log_order() {
  local first=$1
  local second=$2
  local message=$3
  local first_line second_line
  first_line=$(grep -n -F -- "$first" "$EDIORA_COMMAND_LOG" | head -n 1 | cut -d: -f1)
  second_line=$(grep -n -F -- "$second" "$EDIORA_COMMAND_LOG" | head -n 1 | cut -d: -f1)
  if [[ -z "$first_line" || -z "$second_line" || "$first_line" -ge "$second_line" ]]; then
    fail "$message (expected '$first' before '$second')"
    return 1
  fi
}

write_executable() {
  local path=$1
  local content=$2
  printf '%s\n' "$content" > "$path"
  chmod +x "$path"
}

setup_case() {
  CASE_DIR=$(mktemp -d "${TMPDIR-/tmp}/ediora-installer.XXXXXX")
  mkdir -p "$CASE_DIR/bin" "$CASE_DIR/home" "$CASE_DIR/keyrings" "$CASE_DIR/backend" "$CASE_DIR/web"
  printf '%s\n' 'NAME="Ubuntu"' 'ID=ubuntu' 'VERSION_ID="22.04"' 'VERSION_CODENAME=jammy' > "$CASE_DIR/os-release"
  : > "$CASE_DIR/commands.log"
  rm -f "$CASE_DIR/docker.state"
  cp "$ROOT_DIR/docker-compose.yml" "$CASE_DIR/docker-compose.yml"
  if [[ -f "$INSTALLER_SOURCE" ]]; then
    cp "$INSTALLER_SOURCE" "$CASE_DIR/install.sh"
    chmod +x "$CASE_DIR/install.sh"
  fi

  export CASE_DIR
  export HOME="$CASE_DIR/home"
  export XDG_CONFIG_HOME="$CASE_DIR/home/.config"
  export EDIORA_OS_RELEASE="$CASE_DIR/os-release"
  export EDIORA_COMMAND_LOG="$CASE_DIR/commands.log"
  export EDIORA_DOCKER_STATE="$CASE_DIR/docker.state"
  export EDIORA_DOCKER_KEYRING_DIR="$CASE_DIR/keyrings"
  export EDIORA_DOCKER_REPO_FILE="$CASE_DIR/docker.list"
  export EDIORA_FAKE_PULL_FAIL=0
  export EDIORA_FAKE_HTTP_FAIL=0
  export EDIORA_FAKE_SYSTEMCTL_NO_DOCKER=0
  export EDIORA_HOST_OS=Linux
  export PATH="$CASE_DIR/bin:/usr/bin:/bin"

  write_executable "$CASE_DIR/bin/sudo" '#!/usr/bin/env bash
set -u
printf "sudo %s\n" "$*" >> "$EDIORA_COMMAND_LOG"
case "${1:-}" in
  docker)
    shift
    exec docker "$@"
    ;;
  install)
    shift
    exec /usr/bin/install "$@"
    ;;
  chmod)
    shift
    exec /bin/chmod "$@"
    ;;
  gpg)
    shift
    exec gpg "$@"
    ;;
  tee)
    shift
    exec /usr/bin/tee "$@"
    ;;
  apt-get|systemctl)
    exec "$@"
    ;;
  *)
    exec "$@"
    ;;
esac'

  write_executable "$CASE_DIR/bin/curl" '#!/bin/bash
set -u
printf "curl %s\n" "$*" >> "$EDIORA_COMMAND_LOG"
if [[ "$*" == *"download.docker.com"* || "$*" == *"docker.com/linux/ubuntu/gpg"* ]]; then
  printf "fake-docker-gpg\n"
  exit 0
fi
if [[ "$*" == *"main.tar.gz"* ]]; then
  output=""
  while (($#)); do
    if [[ "$1" == "-o" ]]; then
      output=${2:-}
      shift 2
    else
      shift
    fi
  done
  if [[ -n "$output" && -n "${EDIORA_FAKE_ARCHIVE:-}" ]]; then
    cp "$EDIORA_FAKE_ARCHIVE" "$output"
  fi
  exit 0
fi
if [[ "$*" == *"http://"* || "$*" == *"https://"* ]]; then
  if [[ "${EDIORA_FAKE_HTTP_FAIL:-0}" == 1 ]]; then
    exit 22
  fi
  exit 0
fi
exit 0'

  write_executable "$CASE_DIR/bin/gpg" '#!/usr/bin/env bash
set -u
printf "gpg %s\n" "$*" >> "$EDIORA_COMMAND_LOG"
output=""
while (($#)); do
  if [[ "$1" == "-o" || "$1" == "--output" ]]; then
    output=${2:-}
    shift 2
  else
    shift
  fi
done
if [[ -n "$output" ]]; then
  printf "fake-docker-key\n" > "$output"
else
  cat >/dev/null
fi'

  write_executable "$CASE_DIR/bin/apt-get" '#!/usr/bin/env bash
set -u
printf "apt-get %s\n" "$*" >> "$EDIORA_COMMAND_LOG"
exit 0'

  write_executable "$CASE_DIR/bin/systemctl" '#!/usr/bin/env bash
set -u
printf "systemctl %s\n" "$*" >> "$EDIORA_COMMAND_LOG"
if [[ "${EDIORA_FAKE_SYSTEMCTL_NO_DOCKER:-0}" != 1 ]]; then
  touch "$EDIORA_DOCKER_STATE"
fi
exit 0'

  write_executable "$CASE_DIR/bin/docker" '#!/usr/bin/env bash
set -u
printf "docker %s\n" "$*" >> "$EDIORA_COMMAND_LOG"
if [[ "${1:-}" == "version" ]]; then
  [[ -f "$EDIORA_DOCKER_STATE" ]]
  exit $?
fi
if [[ "${1:-}" != "compose" ]]; then
  if [[ "${1:-}" == "inspect" ]]; then
    if [[ "$*" == *"Health.Status"* ]]; then
      printf "healthy\n"
    else
      printf "running\n"
    fi
  fi
  exit 0
fi
shift
if [[ "${1:-}" == "version" ]]; then
  [[ -f "$EDIORA_DOCKER_STATE" ]]
  exit $?
fi
action=""
while (($#)); do
  case "$1" in
    --project-name|--env-file|-f)
      shift 2
      ;;
    --profile)
      shift 2
      ;;
    --*)
      shift
      ;;
    *)
      action=$1
      shift
      break
      ;;
  esac
done
case "$action" in
  pull)
    printf "compose-action pull\n" >> "$EDIORA_COMMAND_LOG"
    if [[ "${EDIORA_FAKE_PULL_FAIL:-0}" == 1 ]]; then
      exit 17
    fi
    ;;
  build)
    printf "compose-action build %s\n" "$*" >> "$EDIORA_COMMAND_LOG"
    ;;
  up)
    printf "compose-action up %s\n" "$*" >> "$EDIORA_COMMAND_LOG"
    ;;
  ps)
    service=service
    while (($#)); do
      service=$1
      shift
    done
    printf "fake-%s\n" "$service"
    ;;
esac
exit 0'
}

teardown_case() {
  if [[ -n "$CASE_DIR" && -d "$CASE_DIR" ]]; then
    rm -rf "$CASE_DIR"
  fi
  CASE_DIR=''
}

make_input() {
  local path=$1
  shift
  printf '%s\n' "$@" > "$path"
  export EDIORA_INPUT_FILE="$path"
}

make_blank_input() {
  local path=$1
  : > "$path"
  for _ in {1..24}; do
    printf '\n' >> "$path"
  done
  export EDIORA_INPUT_FILE="$path"
}

run_installer() {
  local output=$1
  shift
  (
    cd "$CASE_DIR" || exit 99
    sh "$CASE_DIR/install.sh" "$@"
  ) > "$output" 2>&1
}

run_test() {
  local name=$1
  shift
  TOTAL=$((TOTAL + 1))
  setup_case
  local before=$FAILED
  "$@"
  local status=$?
  if ((status == 0 && FAILED == before)); then
    pass "$name"
  else
    fail "$name"
  fi
  teardown_case
}

test_declining_docker_installation_stops_before_apt() {
  local output="$CASE_DIR/output.log"
  make_input "$CASE_DIR/input" n
  if run_installer "$output"; then
    fail 'declining Docker installation should fail'
    return 1
  fi
  assert_log_not_contains 'apt-get ' 'declining Docker installation must not run apt-get'
  assert_log_not_contains 'gpg ' 'declining Docker installation must not run gpg'
  assert_log_not_contains 'systemctl ' 'declining Docker installation must not run systemctl'
}

test_confirmed_docker_installation_runs_apt_before_compose() {
  local output="$CASE_DIR/output.log"
  make_input "$CASE_DIR/input" y '' '' '' '' '' '' '' '' '' '' '' ''
  if ! run_installer "$output"; then
    cat "$output" >&2
    return 1
  fi
  assert_log_contains 'apt-get update' 'confirmed installation must update apt metadata'
  assert_log_contains 'apt-get install' 'confirmed installation must install Docker packages'
  assert_log_contains 'compose-action' 'confirmed installation must invoke Compose'
  assert_log_order 'apt-get install' 'compose-action' 'Docker packages must be installed before Compose'
}

test_docker_installation_requires_post_install_daemon_check() {
  local output="$CASE_DIR/output.log"
  export EDIORA_FAKE_SYSTEMCTL_NO_DOCKER=1
  make_input "$CASE_DIR/input" y '' '' '' '' '' '' '' '' '' '' ''
  if run_installer "$output"; then
    fail 'Docker installation without a usable daemon should fail'
    return 1
  fi
  assert_log_contains 'apt-get install' 'post-install check case must install Docker packages'
  assert_log_not_contains 'compose-action' 'post-install check failure must not start Compose'
}

test_existing_env_values_are_preserved_and_missing_values_appended() {
  local output="$CASE_DIR/output.log"
  local original prefix
  touch "$EDIORA_DOCKER_STATE"
  printf '%s\n' \
    'POSTGRES_PASSWORD=existing-db' \
    'WORKER_TOKEN=existing-worker-token-012345678901234567890123' \
    'X_SESSION_KEY=existing-session-key' \
    'API_PORT=18000' \
    '# keep this comment' > "$CASE_DIR/.env"
  original=$(cat "$CASE_DIR/.env")
  make_blank_input "$CASE_DIR/input"
  if ! run_installer "$output"; then
    cat "$output" >&2
    return 1
  fi
  prefix=$(head -n 5 "$CASE_DIR/.env")
  [[ "$prefix" == "$original" ]] || fail 'existing .env bytes must remain at the beginning'
  assert_contains "$CASE_DIR/.env" 'WEB_PORT=' 'missing WEB_PORT must be appended'
  assert_contains "$CASE_DIR/.env" 'APP_IMAGE=ghcr.io/phoenix-gh/ediora-studio' 'missing APP_IMAGE must be appended'
}

test_generated_secrets_are_not_printed_and_env_mode_is_600() {
  local output="$CASE_DIR/output.log"
  make_blank_input "$CASE_DIR/input"
  touch "$EDIORA_DOCKER_STATE"
  if ! run_installer "$output"; then
    cat "$output" >&2
    return 1
  fi
  local db worker session mode
  db=$(sed -n 's/^POSTGRES_PASSWORD=//p' "$CASE_DIR/.env")
  worker=$(sed -n 's/^WORKER_TOKEN=//p' "$CASE_DIR/.env")
  session=$(sed -n 's/^X_SESSION_KEY=//p' "$CASE_DIR/.env")
  mode=$(stat -c '%a' "$CASE_DIR/.env")
  [[ -n "$db" && -n "$worker" && -n "$session" ]] || fail 'generated secrets must be non-empty'
  [[ "$mode" == 600 ]] || fail ".env must be mode 600 (got $mode)"
  assert_not_contains "$output" "$db" 'database password must not be printed'
  assert_not_contains "$output" "$worker" 'worker token must not be printed'
  assert_not_contains "$output" "$session" 'session key must not be printed'
}

test_installer_creates_data_directories() {
  local output="$CASE_DIR/output.log"
  local relative mode
  touch "$EDIORA_DOCKER_STATE"
  make_blank_input "$CASE_DIR/input"
  if ! run_installer "$output"; then
    cat "$output" >&2
    return 1
  fi
  for relative in \
    data/postgres \
    data/redis \
    data/uploads \
    data/sessions \
    data/web-runtime \
    data/scheduler \
    data/avatars \
    data/wechat-images \
    data/local-asr-models; do
    [[ -d "$CASE_DIR/$relative" ]] || fail "installer must create $relative"
  done
  mode=$(stat -c '%a' "$CASE_DIR/data/sessions")
  [[ "$mode" == 700 ]] || fail "data/sessions must be mode 700 (got $mode)"
}

test_default_flow_pulls_then_starts_without_build() {
  local output="$CASE_DIR/output.log"
  touch "$EDIORA_DOCKER_STATE"
  make_blank_input "$CASE_DIR/input"
  if ! run_installer "$output"; then
    cat "$output" >&2
    return 1
  fi
  assert_log_contains 'compose-action pull' 'default flow must pull images'
  assert_log_contains 'compose-action up' 'default flow must start the stack'
  assert_log_contains 'compose-action up -d --no-build' 'default flow must start without building'
  assert_log_not_contains 'compose-action build' 'default flow must not build locally'
  assert_log_not_contains 'local-asr' 'default flow must not start local ASR'
  assert_log_order 'compose-action pull' 'compose-action up' 'default flow must pull before start'
}

test_build_flag_skips_pull_and_builds_explicitly() {
  local output="$CASE_DIR/output.log"
  touch "$EDIORA_DOCKER_STATE"
  make_blank_input "$CASE_DIR/input"
  if ! run_installer "$output" --build; then
    cat "$output" >&2
    return 1
  fi
  assert_log_contains 'compose-action build' '--build must build the application image'
  assert_log_not_contains 'compose-action pull' '--build must not pull before local build'
  assert_log_contains 'compose-action up' '--build must still start the stack'
}

test_pull_failure_does_not_run_compose_down() {
  local output="$CASE_DIR/output.log"
  touch "$EDIORA_DOCKER_STATE"
  export EDIORA_FAKE_PULL_FAIL=1
  make_blank_input "$CASE_DIR/input"
  if run_installer "$output"; then
    fail 'pull failure should return non-zero'
    return 1
  fi
  assert_log_not_contains 'compose-action down' 'pull failure must not run compose down'
}

test_readiness_timeout_returns_nonzero_without_cleanup() {
  local output="$CASE_DIR/output.log"
  touch "$EDIORA_DOCKER_STATE"
  export EDIORA_FAKE_HTTP_FAIL=1
  export EDIORA_READY_ATTEMPTS=1
  export EDIORA_READY_INTERVAL=0
  make_blank_input "$CASE_DIR/input"
  if run_installer "$output"; then
    fail 'readiness timeout should return non-zero'
    return 1
  fi
  assert_contains "$output" '仍未就绪' 'readiness timeout must explain the failure'
  assert_log_not_contains 'compose-action down' 'readiness timeout must not run compose down'
}

write_valid_env() {
  printf '%s\n' \
    'POSTGRES_PASSWORD=valid-db-password' \
    'WORKER_TOKEN=valid-worker-token-012345678901234567890123' \
    'X_SESSION_KEY=valid-session-key' \
    'API_PORT=18000' \
    'WEB_PORT=18001' \
    'NEXT_PUBLIC_API_URL=http://localhost:18000/api' \
    'CORS_ORIGINS=http://localhost:18001' \
    'APP_IMAGE=ghcr.io/phoenix-gh/ediora-studio' \
    'IMAGE_TAG=latest' > "$CASE_DIR/.env"
}

test_invalid_ports_fail_before_compose() {
  local output="$CASE_DIR/output.log"
  touch "$EDIORA_DOCKER_STATE"
  write_valid_env
  sed -i 's/^WEB_PORT=.*/WEB_PORT=18000/' "$CASE_DIR/.env"
  make_blank_input "$CASE_DIR/input"
  if run_installer "$output"; then
    fail 'duplicate host ports should return non-zero'
    return 1
  fi
  assert_contains "$output" '不能相同' 'duplicate host ports must explain the validation error'
  assert_log_not_contains 'compose-action' 'invalid ports must fail before Compose'
}

test_short_worker_token_fails_before_compose() {
  local output="$CASE_DIR/output.log"
  touch "$EDIORA_DOCKER_STATE"
  write_valid_env
  sed -i 's/^WORKER_TOKEN=.*/WORKER_TOKEN=too-short/' "$CASE_DIR/.env"
  make_blank_input "$CASE_DIR/input"
  if run_installer "$output"; then
    fail 'short worker token should return non-zero'
    return 1
  fi
  assert_contains "$output" '至少需要 32' 'short worker token must explain the validation error'
  assert_log_not_contains 'compose-action' 'short worker token must fail before Compose'
}

test_second_run_preserves_generated_secrets() {
  local first_output="$CASE_DIR/first.log"
  local second_output="$CASE_DIR/second.log"
  local first_db first_worker first_session second_db second_worker second_session
  touch "$EDIORA_DOCKER_STATE"
  make_blank_input "$CASE_DIR/input"
  if ! run_installer "$first_output"; then
    cat "$first_output" >&2
    return 1
  fi
  first_db=$(sed -n 's/^POSTGRES_PASSWORD=//p' "$CASE_DIR/.env")
  first_worker=$(sed -n 's/^WORKER_TOKEN=//p' "$CASE_DIR/.env")
  first_session=$(sed -n 's/^X_SESSION_KEY=//p' "$CASE_DIR/.env")
  : > "$CASE_DIR/second-input"
  export EDIORA_INPUT_FILE="$CASE_DIR/second-input"
  if ! run_installer "$second_output"; then
    cat "$second_output" >&2
    return 1
  fi
  second_db=$(sed -n 's/^POSTGRES_PASSWORD=//p' "$CASE_DIR/.env")
  second_worker=$(sed -n 's/^WORKER_TOKEN=//p' "$CASE_DIR/.env")
  second_session=$(sed -n 's/^X_SESSION_KEY=//p' "$CASE_DIR/.env")
  [[ "$first_db" == "$second_db" && "$first_worker" == "$second_worker" && "$first_session" == "$second_session" ]] || fail 'second run must preserve generated secrets'
}

test_noninteractive_missing_input_fails_before_env_creation() {
  local output="$CASE_DIR/output.log"
  rm -f "$CASE_DIR/.env"
  if (cd "$CASE_DIR" && env -u EDIORA_INPUT_FILE EDIORA_OS_RELEASE="$EDIORA_OS_RELEASE" sh "$CASE_DIR/install.sh" </dev/null) > "$output" 2>&1; then
    fail 'missing non-interactive input should return non-zero'
    return 1
  fi
  [[ ! -f "$CASE_DIR/.env" ]] || fail 'non-interactive failure must not create .env'
}

test_unsupported_ubuntu_fails_before_docker() {
  local output="$CASE_DIR/output.log"
  printf '%s\n' 'NAME="Ubuntu"' 'ID=ubuntu' 'VERSION_ID="20.04"' 'VERSION_CODENAME=focal' > "$CASE_DIR/os-release"
  make_blank_input "$CASE_DIR/input"
  if run_installer "$output"; then
    fail 'unsupported Ubuntu should return non-zero'
    return 1
  fi
  assert_log_not_contains 'apt-get ' 'unsupported Ubuntu must not invoke apt-get'
}

test_help_does_not_require_docker() {
  local output="$CASE_DIR/output.log"
  if ! run_installer "$output" --help; then
    cat "$output" >&2
    return 1
  fi
  assert_contains "$output" 'Usage:' '--help must print usage'
  assert_log_not_contains 'docker ' '--help must not invoke Docker'
}

test_unknown_option_is_rejected() {
  local output="$CASE_DIR/output.log"
  if run_installer "$output" --not-an-option; then
    fail 'unknown options should return non-zero'
    return 1
  fi
  assert_contains "$output" 'Usage:' 'unknown options must print usage'
}

test_posix_installer_runs_from_piped_stdin() {
  local output="$CASE_DIR/output.log"
  if ! (
    cat "$ROOT_DIR/install.sh" | sh -s -- --help
  ) > "$output" 2>&1; then
    cat "$output" >&2
    return 1
  fi
  assert_contains "$output" 'Usage:' 'piped sh execution must print installer usage'
  assert_log_not_contains 'docker ' 'piped help must not invoke Docker'
}

test_posix_installer_parses_with_sh() {
  sh -n "$ROOT_DIR/install.sh"
}

test_linux_with_existing_docker_does_not_require_ubuntu() {
  local output="$CASE_DIR/output.log"
  printf '%s\n' 'NAME="Debian GNU/Linux"' 'ID=debian' 'VERSION_ID="12"' > "$CASE_DIR/os-release"
  export EDIORA_HOST_OS=Linux
  touch "$EDIORA_DOCKER_STATE"
  make_blank_input "$CASE_DIR/input"
  if ! run_installer "$output"; then
    cat "$output" >&2
    return 1
  fi
  assert_log_contains 'compose-action pull' 'Linux with an existing Docker daemon must run Compose'
  assert_log_not_contains 'apt-get ' 'Linux with an existing Docker daemon must not run apt-get'
}

test_macos_without_docker_explains_docker_desktop_requirement() {
  local output="$CASE_DIR/output.log"
  export EDIORA_HOST_OS=Darwin
  make_blank_input "$CASE_DIR/input"
  if run_installer "$output"; then
    fail 'macOS without Docker must fail before Compose'
    return 1
  fi
  assert_contains "$output" 'Docker Desktop' 'macOS failure must explain the Docker Desktop requirement'
  assert_log_not_contains 'apt-get ' 'macOS must not run apt-get'
}

test_remote_piped_install_reexecutes_from_downloaded_checkout() {
  local output="$CASE_DIR/output.log"
  local archive="$CASE_DIR/archive.tar.gz"
  local target="$CASE_DIR/remote"
  mkdir -p "$CASE_DIR/archive-root/ediora-studio-main/backend" "$CASE_DIR/archive-root/ediora-studio-main/web"
  cp "$CASE_DIR/install.sh" "$CASE_DIR/docker-compose.yml" "$CASE_DIR/archive-root/ediora-studio-main/"
  tar -czf "$archive" -C "$CASE_DIR/archive-root" ediora-studio-main
  export EDIORA_FAKE_ARCHIVE="$archive"
  export EDIORA_INSTALL_DIR="$target"
  touch "$EDIORA_DOCKER_STATE"
  make_blank_input "$CASE_DIR/input"
  if ! (
    cd "$CASE_DIR" || exit 99
    cat "$INSTALLER_SOURCE" | sh -s
  ) > "$output" 2>&1; then
    cat "$output" >&2
    return 1
  fi
  assert_file_exists "$target/install.sh" 'remote mode must create a checkout'
  assert_contains "$output" 'Ediora 已启动' 'remote mode must re-execute the downloaded installer'
  assert_log_not_contains 'raw.githubusercontent.com/phoenix-gh/ediora-studio/main/install.sh' 'remote mode must not download the installer itself'
}

test_remote_piped_install_accepts_custom_install_dir() {
  local output="$CASE_DIR/output.log"
  local archive="$CASE_DIR/archive.tar.gz"
  local target="$CASE_DIR/custom/ediora"
  mkdir -p "$CASE_DIR/archive-root/ediora-studio-main/backend" "$CASE_DIR/archive-root/ediora-studio-main/web"
  cp "$CASE_DIR/install.sh" "$CASE_DIR/docker-compose.yml" "$CASE_DIR/archive-root/ediora-studio-main/"
  tar -czf "$archive" -C "$CASE_DIR/archive-root" ediora-studio-main
  export EDIORA_FAKE_ARCHIVE="$archive"
  unset EDIORA_INSTALL_DIR
  touch "$EDIORA_DOCKER_STATE"
  make_input "$CASE_DIR/input" "$target" '' '' '' '' '' '' '' '' '' '' '' ''
  if ! (
    cd "$CASE_DIR" || exit 99
    cat "$INSTALLER_SOURCE" | sh -s
  ) > "$output" 2>&1; then
    cat "$output" >&2
    return 1
  fi
  assert_file_exists "$target/install.sh" 'remote mode must install into the user-selected directory'
  assert_contains "$output" "目录: $target" 'remote mode must report the user-selected directory'
}

test_downloaded_standalone_script_prompts_for_install_dir() {
  local output="$CASE_DIR/output.log"
  local archive="$CASE_DIR/archive.tar.gz"
  local target="$CASE_DIR/standalone"
  local standalone="$CASE_DIR/standalone"
  mkdir -p "$standalone"
  cp "$CASE_DIR/install.sh" "$standalone/"
  mkdir -p "$CASE_DIR/archive-root/ediora-studio-main/backend" "$CASE_DIR/archive-root/ediora-studio-main/web"
  cp "$CASE_DIR/install.sh" "$CASE_DIR/docker-compose.yml" "$CASE_DIR/archive-root/ediora-studio-main/"
  tar -czf "$archive" -C "$CASE_DIR/archive-root" ediora-studio-main
  export EDIORA_FAKE_ARCHIVE="$archive"
  unset EDIORA_INSTALL_DIR
  touch "$EDIORA_DOCKER_STATE"
  make_input "$CASE_DIR/input" "$target" '' '' '' '' '' '' '' '' '' '' '' ''
  if ! (
    cd "$standalone" || exit 99
    ./install.sh
  ) > "$output" 2>&1; then
    cat "$output" >&2
    return 1
  fi
  assert_file_exists "$target/install.sh" 'a downloaded standalone installer must create the selected checkout'
  assert_contains "$output" "目录: $target" 'a downloaded standalone installer must use the selected directory'
}

test_external_checkout_script_uses_selected_working_directory() {
  local output="$CASE_DIR/output.log"
  local archive="$CASE_DIR/archive.tar.gz"
  local runner="$CASE_DIR/external-runner"
  mkdir -p "$runner"
  mkdir -p "$CASE_DIR/archive-root/ediora-studio-main/backend" "$CASE_DIR/archive-root/ediora-studio-main/web"
  cp "$CASE_DIR/install.sh" "$CASE_DIR/docker-compose.yml" "$CASE_DIR/archive-root/ediora-studio-main/"
  tar -czf "$archive" -C "$CASE_DIR/archive-root" ediora-studio-main
  export EDIORA_FAKE_ARCHIVE="$archive"
  unset EDIORA_INSTALL_DIR
  touch "$EDIORA_DOCKER_STATE"
  make_input "$CASE_DIR/input" "$runner" '' '' '' '' '' '' '' '' '' '' '' ''
  if ! (
    cd "$runner" || exit 99
    sh "$CASE_DIR/install.sh"
  ) > "$output" 2>&1; then
    cat "$output" >&2
    return 1
  fi
  assert_file_exists "$runner/install.sh" 'an external installer invocation must install into the selected working directory'
  assert_contains "$output" "目录: $runner" 'an external installer invocation must report the selected working directory'
}

test_repository_installation_contract() {
  [[ -x "$INSTALLER_SOURCE" ]] || fail 'install.sh must be executable'
  [[ ! -e "$ROOT_DIR/install.bash" ]] || fail 'repository must not add a separate install.bash'
  assert_contains "$ROOT_DIR/README.md" 'curl -fsSL https://raw.githubusercontent.com/phoenix-gh/ediora-studio/main/install.sh | sh' 'README must document the POSIX remote installer command'
  assert_contains "$ROOT_DIR/docs/self-hosted.md" 'curl -fsSL https://raw.githubusercontent.com/phoenix-gh/ediora-studio/main/install.sh | sh' 'self-hosted docs must document the POSIX remote installer command'
  assert_contains "$ROOT_DIR/docs/self-hosted.md" './install.sh --build' 'self-hosted docs must document the build opt-in'
  assert_contains "$ROOT_DIR/README.md" 'EDIORA_INSTALL_DIR=/srv/ediora' 'README must document the install directory override'
  assert_contains "$ROOT_DIR/docs/self-hosted.md" 'EDIORA_INSTALL_DIR=/srv/ediora' 'self-hosted docs must document the install directory override'
  assert_contains "$ROOT_DIR/README.md" 'curl -fsSLo install.sh' 'README must document downloading the standalone installer'
  assert_contains "$ROOT_DIR/docs/self-hosted.md" 'curl -fsSLo install.sh' 'self-hosted docs must document downloading the standalone installer'
  assert_not_contains "$INSTALLER_SOURCE" 'INSTALLER_URL' 'installer must not contain a self-download URL variable'
  assert_not_contains "$INSTALLER_SOURCE" 'OPENAI_API_KEY' 'installer must not collect provider API keys'
  assert_not_contains "$INSTALLER_SOURCE" 'HEYGEN_API_KEY' 'installer must not collect HeyGen API keys'
}

if [[ ! -f "$INSTALLER_SOURCE" ]]; then
  fail 'install.sh is not present; installer contract cannot pass yet'
  printf 'Installer contract baseline is red until install.sh is implemented.\n' >&2
  exit 1
fi

run_test 'declining Docker installation stops before apt' test_declining_docker_installation_stops_before_apt
run_test 'confirmed Docker installation runs apt before Compose' test_confirmed_docker_installation_runs_apt_before_compose
run_test 'Docker installation requires a post-install daemon check' test_docker_installation_requires_post_install_daemon_check
run_test 'existing environment values are preserved and missing values appended' test_existing_env_values_are_preserved_and_missing_values_appended
run_test 'generated secrets are redacted and .env is mode 600' test_generated_secrets_are_not_printed_and_env_mode_is_600
run_test 'installer creates the project data directories' test_installer_creates_data_directories
run_test 'default flow pulls then starts without build' test_default_flow_pulls_then_starts_without_build
run_test 'build flag skips pull and builds explicitly' test_build_flag_skips_pull_and_builds_explicitly
run_test 'pull failure does not run compose down' test_pull_failure_does_not_run_compose_down
run_test 'readiness timeout returns non-zero without cleanup' test_readiness_timeout_returns_nonzero_without_cleanup
run_test 'invalid ports fail before Compose' test_invalid_ports_fail_before_compose
run_test 'short worker token fails before Compose' test_short_worker_token_fails_before_compose
run_test 'second run preserves generated secrets' test_second_run_preserves_generated_secrets
run_test 'non-interactive missing input fails before env creation' test_noninteractive_missing_input_fails_before_env_creation
run_test 'unsupported Ubuntu fails before Docker' test_unsupported_ubuntu_fails_before_docker
run_test 'help does not require Docker' test_help_does_not_require_docker
run_test 'unknown options are rejected' test_unknown_option_is_rejected
run_test 'remote piped install re-executes from downloaded checkout' test_remote_piped_install_reexecutes_from_downloaded_checkout
run_test 'remote piped install accepts a custom install directory' test_remote_piped_install_accepts_custom_install_dir
run_test 'downloaded standalone script prompts for install directory' test_downloaded_standalone_script_prompts_for_install_dir
run_test 'external checkout script uses the selected working directory' test_external_checkout_script_uses_selected_working_directory
run_test 'POSIX installer runs from piped stdin' test_posix_installer_runs_from_piped_stdin
run_test 'POSIX installer parses with sh' test_posix_installer_parses_with_sh
run_test 'Linux with existing Docker does not require Ubuntu' test_linux_with_existing_docker_does_not_require_ubuntu
run_test 'macOS without Docker explains the Docker Desktop requirement' test_macos_without_docker_explains_docker_desktop_requirement
run_test 'repository installation contract is documented' test_repository_installation_contract

printf '\n%d tests, %d failures\n' "$TOTAL" "$FAILED"
if ((FAILED > 0)); then
  exit 1
fi
