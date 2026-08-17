#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

readonly ORIGINAL_ARGS=("$@")
SCRIPT_SOURCE=${BASH_SOURCE[0]-}
AUTO_CONFIRM=0
DO_BUILD=0
SHOW_HELP=0
CHECKOUT_DIR=''
ENV_FILE=''
COMPOSE_PROJECT_NAME=''
OS_RELEASE_FILE=${EDIORA_OS_RELEASE-/etc/os-release}
OS_ID=''
OS_VERSION=''
UBUNTU_CODENAME=''
INPUT_FD=''
INPUT_IS_TTY=0
DOCKER_RUNNER=()

on_error() {
  local status=$?
  printf '安装失败（第 %s 行，退出码 %s）。请根据上面的非敏感错误信息重试。\n' "$1" "$status" >&2
  exit "$status"
}

trap 'on_error "$LINENO"' ERR

die() {
  printf '错误: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage: ./install.sh [--yes] [--build]
       curl -fsSL https://raw.githubusercontent.com/phoenix-gh/ediora-studio/main/install.sh | bash

Options:
  --yes    Skip the Docker installation confirmation prompt.
  --build  Build the local application image instead of pulling it from GHCR.
  --help   Show this help.
USAGE
}

parse_args() {
  while (($#)); do
    case "$1" in
      --yes) AUTO_CONFIRM=1 ;;
      --build) DO_BUILD=1 ;;
      --help|-h) SHOW_HELP=1 ;;
      --)
        shift
        break
        ;;
      *)
        usage >&2
        die "未知参数: $1"
        ;;
    esac
    shift
  done
  if (($#)); then
    usage >&2
    die "未知参数: $1"
  fi
}

require_bootstrap_commands() {
  local command_name
  for command_name in awk basename chmod cp curl dirname find grep head install mkdir mktemp sed stat sleep tar tr uname; do
    command -v "$command_name" >/dev/null 2>&1 || die "缺少系统命令: $command_name"
  done
}

require_ubuntu() {
  [[ -r "$OS_RELEASE_FILE" ]] || die "无法读取 $OS_RELEASE_FILE"
  OS_ID=$(sed -n 's/^ID=//p' "$OS_RELEASE_FILE" | head -n 1 | tr -d '"\\r')
  OS_VERSION=$(sed -n 's/^VERSION_ID=//p' "$OS_RELEASE_FILE" | head -n 1 | tr -d '"\\r')
  UBUNTU_CODENAME=$(sed -n 's/^VERSION_CODENAME=//p' "$OS_RELEASE_FILE" | head -n 1 | tr -d '"\\r')
  [[ "$OS_ID" == ubuntu ]] || die "仅支持 Ubuntu 22.04/24.04，检测到: $OS_ID"
  case "$OS_VERSION" in
    22.04)
      [[ -n "$UBUNTU_CODENAME" ]] || UBUNTU_CODENAME=jammy
      ;;
    24.04)
      [[ -n "$UBUNTU_CODENAME" ]] || UBUNTU_CODENAME=noble
      ;;
    *)
      die "仅支持 Ubuntu 22.04/24.04，检测到: $OS_VERSION"
      ;;
  esac
}

resolve_checkout() {
  local script_dir target parent temp_dir archive source_dir
  if [[ -n "$SCRIPT_SOURCE" && "$SCRIPT_SOURCE" != /dev/* && -f "$SCRIPT_SOURCE" ]]; then
    script_dir=$(cd -- "$(dirname -- "$SCRIPT_SOURCE")" && pwd)
    if [[ -f "$script_dir/docker-compose.yml" ]]; then
      CHECKOUT_DIR=$script_dir
      return
    fi
  fi

  target=${EDIORA_INSTALL_DIR-${HOME}/ediora-studio}
  [[ -n "$target" ]] || die "EDIORA_INSTALL_DIR 不能为空"
  if [[ "$target" != /* ]]; then
    target="$(pwd)/$target"
  fi

  if [[ -e "$target" ]]; then
    if [[ -f "$target/install.sh" && -f "$target/docker-compose.yml" ]]; then
      CHECKOUT_DIR=$(cd -- "$target" && pwd)
      if [[ "$CHECKOUT_DIR/install.sh" != "$SCRIPT_SOURCE" ]]; then
        exec bash "$CHECKOUT_DIR/install.sh" "${ORIGINAL_ARGS[@]}"
      fi
      return
    fi
    die "安装目录已存在但不是 Ediora checkout: $target"
  fi

  parent=$(dirname -- "$target")
  mkdir -p "$parent"
  temp_dir=$(mktemp -d)
  archive="$temp_dir/ediora-studio.tar.gz"
  printf '正在下载 Ediora 安装源代码到 %s\n' "$target" >&2
  if ! curl -fsSL 'https://github.com/phoenix-gh/ediora-studio/archive/refs/heads/main.tar.gz' -o "$archive"; then
    die "下载 Ediora 源代码失败；临时目录保留在 $temp_dir"
  fi
  [[ -s "$archive" ]] || die "下载的 Ediora 源代码为空；临时目录保留在 $temp_dir"
  tar -xzf "$archive" -C "$temp_dir"
  source_dir=$(find "$temp_dir" -mindepth 1 -maxdepth 1 -type d -name 'ediora-studio-*' -print -quit)
  [[ -n "$source_dir" && -f "$source_dir/install.sh" && -f "$source_dir/docker-compose.yml" ]] || die "下载包中缺少 Ediora 安装文件；临时目录保留在 $temp_dir"
  mkdir "$target"
  cp -a "$source_dir"/. "$target"/
  rm -rf "$temp_dir"
  CHECKOUT_DIR=$(cd -- "$target" && pwd)
  exec bash "$CHECKOUT_DIR/install.sh" "${ORIGINAL_ARGS[@]}"
}

open_input() {
  if [[ -n "${EDIORA_INPUT_FILE-}" ]]; then
    exec {INPUT_FD}<"$EDIORA_INPUT_FILE" || die "无法读取 EDIORA_INPUT_FILE"
  elif [[ -r /dev/tty && ( -t 0 || -t 1 ) ]]; then
    exec {INPUT_FD}<>/dev/tty || die "无法打开终端输入"
    INPUT_IS_TTY=1
  else
    exec {INPUT_FD}<&0 || die "非交互环境没有可用输入；请通过终端运行安装器"
  fi
}

read_answer() {
  local secret=$1
  if ((INPUT_IS_TTY == 1 && secret == 1)); then
    IFS= read -r -s -u "$INPUT_FD" ANSWER || die "读取输入失败"
    printf '\n' >&2
  else
    IFS= read -r -u "$INPUT_FD" ANSWER || die "读取输入失败；请重新运行并完成配置"
  fi
}

prompt_value() {
  local prompt=$1
  local secret=$2
  printf '%s' "$prompt" >&2
  read_answer "$secret"
  printf '%s' "$ANSWER"
}

confirm_docker_install() {
  ((AUTO_CONFIRM == 1)) && return 0
  printf '\n未检测到可用的 Docker Engine/Compose v2。\n' >&2
  printf '接下来将通过 Docker 官方 Ubuntu apt 仓库安装 Docker Engine、Buildx 和 Compose 插件，并使用 sudo。\n' >&2
  local answer
  answer=$(prompt_value '确认安装 Docker？请输入 y/yes 继续，其他输入取消: ' 0)
  case "$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]')" in
    y|yes) ;;
    *) die '已取消 Docker 安装' ;;
  esac
}

random_token() {
  local value
  if command -v openssl >/dev/null 2>&1 && value=$(openssl rand -hex 32 2>/dev/null); then
    printf '%s' "$value"
    return
  fi
  value=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
  [[ "$value" =~ ^[0-9a-f]{64}$ ]] || die '无法生成安全随机令牌'
  printf '%s' "$value"
}

random_fernet_key() {
  local value
  if command -v openssl >/dev/null 2>&1 && value=$(openssl rand -base64 32 2>/dev/null | tr '+/' '-_' | tr -d '\n'); then
    printf '%s' "$value"
    return
  fi
  if command -v base64 >/dev/null 2>&1 && value=$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '\n'); then
    printf '%s' "$value"
    return
  fi
  die '无法生成 X_SESSION_KEY；请安装 openssl 后重试'
}

env_value() {
  local key=$1
  local value
  value=$(awk -v target="$key" 'index($0, target "=") == 1 { value = substr($0, length(target) + 2) } END { printf "%s", value }' "$ENV_FILE")
  value=$(printf '%s' "$value" | sed -e 's/\r$//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
  printf '%s' "$value"
}

dotenv_value() {
  local value=$1
  if [[ "$value" =~ ^[A-Za-z0-9._:/@%+,-]+$ ]]; then
    printf '%s' "$value"
    return
  fi
  local escaped
  escaped=$(printf '%s' "$value" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')
  printf '"%s"' "$escaped"
}

append_env_value() {
  local key=$1
  local value=$2
  local current
  current=$(env_value "$key")
  [[ -n "$current" ]] && return 0
  if [[ ! -f "$ENV_FILE" ]]; then
    : > "$ENV_FILE"
  elif [[ -s "$ENV_FILE" ]]; then
    printf '\n' >> "$ENV_FILE"
  fi
  printf '%s=%s\n' "$key" "$(dotenv_value "$value")" >> "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

ensure_value() {
  local key=$1
  local label=$2
  local default_value=$3
  local secret=$4
  local current answer
  current=$(env_value "$key")
  [[ -n "$current" ]] && return 0
  if ((secret == 1)); then
    printf '%s [回车自动生成]\n' "$label" >&2
  else
    printf '%s [%s]\n' "$label" "$default_value" >&2
  fi
  answer=$(prompt_value '> ' "$secret")
  if [[ -z "$answer" ]]; then
    answer=$default_value
  fi
  append_env_value "$key" "$answer"
}

ensure_fixed_value() {
  local key=$1
  local value=$2
  append_env_value "$key" "$value"
}

collect_env() {
  ENV_FILE="$CHECKOUT_DIR/.env"
  if [[ ! -f "$ENV_FILE" ]]; then
    : > "$ENV_FILE"
  fi
  chmod 600 "$ENV_FILE"

  ensure_value POSTGRES_PASSWORD 'PostgreSQL 密码' "$(random_token)" 1
  ensure_value WORKER_TOKEN 'Worker 内部令牌（至少 32 个字符）' "$(random_token)" 1
  ensure_value X_SESSION_KEY 'X 会话加密密钥' "$(random_fernet_key)" 1
  ensure_value API_PORT 'API 主机端口' '8000' 0
  ensure_value WEB_PORT 'Web 主机端口' '3000' 0
  ensure_value NEXT_PUBLIC_API_URL '浏览器访问的 API URL' 'http://localhost:8000/api' 0
  ensure_value CORS_ORIGINS '允许的浏览器来源' 'http://localhost:3000' 0
  ensure_value APP_IMAGE '应用镜像' 'ghcr.io/phoenix-gh/ediora-studio' 0
  ensure_value IMAGE_TAG '镜像标签' 'latest' 0
  ensure_fixed_value WORKER_QUEUE 'content-jobs'
  ensure_fixed_value VIDEO_WORKER_QUEUE 'content-jobs:video'
}

validate_no_control() {
  local key=$1
  local value=$2
  if printf '%s' "$value" | LC_ALL=C grep -q '[[:cntrl:]]'; then
    die "$key 包含非法控制字符"
  fi
}

validate_env() {
  POSTGRES_PASSWORD_VALUE=$(env_value POSTGRES_PASSWORD)
  WORKER_TOKEN_VALUE=$(env_value WORKER_TOKEN)
  X_SESSION_KEY_VALUE=$(env_value X_SESSION_KEY)
  API_PORT_VALUE=$(env_value API_PORT)
  WEB_PORT_VALUE=$(env_value WEB_PORT)
  NEXT_PUBLIC_API_URL_VALUE=$(env_value NEXT_PUBLIC_API_URL)
  CORS_ORIGINS_VALUE=$(env_value CORS_ORIGINS)
  APP_IMAGE_VALUE=$(env_value APP_IMAGE)
  IMAGE_TAG_VALUE=$(env_value IMAGE_TAG)

  local key value
  for key in POSTGRES_PASSWORD WORKER_TOKEN X_SESSION_KEY API_PORT WEB_PORT NEXT_PUBLIC_API_URL CORS_ORIGINS APP_IMAGE IMAGE_TAG; do
    case "$key" in
      POSTGRES_PASSWORD) value=$POSTGRES_PASSWORD_VALUE ;;
      WORKER_TOKEN) value=$WORKER_TOKEN_VALUE ;;
      X_SESSION_KEY) value=$X_SESSION_KEY_VALUE ;;
      API_PORT) value=$API_PORT_VALUE ;;
      WEB_PORT) value=$WEB_PORT_VALUE ;;
      NEXT_PUBLIC_API_URL) value=$NEXT_PUBLIC_API_URL_VALUE ;;
      CORS_ORIGINS) value=$CORS_ORIGINS_VALUE ;;
      APP_IMAGE) value=$APP_IMAGE_VALUE ;;
      IMAGE_TAG) value=$IMAGE_TAG_VALUE ;;
    esac
    validate_no_control "$key" "$value"
  done

  [[ -n "$POSTGRES_PASSWORD_VALUE" ]] || die 'POSTGRES_PASSWORD 不能为空'
  ((${#WORKER_TOKEN_VALUE} >= 32)) || die 'WORKER_TOKEN 至少需要 32 个字符'
  [[ -n "$X_SESSION_KEY_VALUE" ]] || die 'X_SESSION_KEY 不能为空'
  [[ "$API_PORT_VALUE" =~ ^[0-9]+$ ]] || die 'API_PORT 必须是 1-65535 的端口'
  [[ "$WEB_PORT_VALUE" =~ ^[0-9]+$ ]] || die 'WEB_PORT 必须是 1-65535 的端口'
  ((API_PORT_VALUE >= 1 && API_PORT_VALUE <= 65535)) || die 'API_PORT 必须是 1-65535 的端口'
  ((WEB_PORT_VALUE >= 1 && WEB_PORT_VALUE <= 65535)) || die 'WEB_PORT 必须是 1-65535 的端口'
  ((API_PORT_VALUE != WEB_PORT_VALUE)) || die 'API_PORT 和 WEB_PORT 不能相同'
  [[ "$NEXT_PUBLIC_API_URL_VALUE" =~ ^https?://[^[:space:]]+$ ]] || die 'NEXT_PUBLIC_API_URL 必须是 HTTP(S) URL'
  [[ -n "$CORS_ORIGINS_VALUE" ]] || die 'CORS_ORIGINS 不能为空'
  [[ "$APP_IMAGE_VALUE" =~ ^[A-Za-z0-9][A-Za-z0-9._:/-]*$ ]] || die 'APP_IMAGE 不是有效镜像引用'
  [[ "$IMAGE_TAG_VALUE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die 'IMAGE_TAG 不是有效标签'
}

prepare_data_directories() {
  local data_dir="$CHECKOUT_DIR/data"
  mkdir -p \
    "$data_dir/postgres" \
    "$data_dir/redis" \
    "$data_dir/uploads" \
    "$data_dir/sessions" \
    "$data_dir/web-runtime" \
    "$data_dir/scheduler" \
    "$data_dir/avatars" \
    "$data_dir/wechat-images" \
    "$data_dir/local-asr-models"
  chmod 700 "$data_dir/sessions"
}

docker_ready() {
  local allow_sudo=$1
  if command -v docker >/dev/null 2>&1 && docker version >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    DOCKER_RUNNER=(docker)
    return 0
  fi
  if ! command -v sudo >/dev/null 2>&1; then
    return 1
  fi
  if ((allow_sudo == 1)); then
    if sudo docker version >/dev/null 2>&1 && sudo docker compose version >/dev/null 2>&1; then
      DOCKER_RUNNER=(sudo docker)
      printf '将使用 sudo docker 访问 Docker；如需免 sudo，请重新登录以加载 docker 组权限。\n' >&2
      return 0
    fi
  elif sudo -n docker version >/dev/null 2>&1 && sudo -n docker compose version >/dev/null 2>&1; then
    DOCKER_RUNNER=(sudo -n docker)
    return 0
  fi
  return 1
}

docker_architecture() {
  local machine
  if command -v dpkg >/dev/null 2>&1; then
    dpkg --print-architecture
    return
  fi
  machine=$(uname -m)
  case "$machine" in
    x86_64) printf 'amd64' ;;
    aarch64) printf 'arm64' ;;
    armv7l) printf 'armhf' ;;
    *) die "不支持的 CPU 架构: $machine" ;;
  esac
}

install_docker() {
  local keyring_dir repo_file architecture
  keyring_dir=${EDIORA_DOCKER_KEYRING_DIR-/etc/apt/keyrings}
  repo_file=${EDIORA_DOCKER_REPO_FILE-/etc/apt/sources.list.d/docker.list}
  architecture=$(docker_architecture)
  sudo install -m 0755 -d "$keyring_dir"
  curl -fsSL 'https://download.docker.com/linux/ubuntu/gpg' | sudo gpg --dearmor --yes -o "$keyring_dir/docker.gpg"
  sudo chmod a+r "$keyring_dir/docker.gpg"
  printf 'deb [arch=%s signed-by=%s] https://download.docker.com/linux/ubuntu %s stable\n' "$architecture" "$keyring_dir/docker.gpg" "$UBUNTU_CODENAME" | sudo tee "$repo_file" >/dev/null
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl gnupg git docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo systemctl enable --now docker
  docker_ready 1 || die 'Docker 安装完成但 Docker Engine/Compose v2 仍不可用'
}

compose_project_name() {
  local base
  base=$(basename "$CHECKOUT_DIR")
  COMPOSE_PROJECT_NAME=$(printf '%s' "$base" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]/-/g; s/^[^a-z0-9]*//; s/[^a-z0-9]*$//')
  [[ -n "$COMPOSE_PROJECT_NAME" ]] || COMPOSE_PROJECT_NAME=ediora
}

compose() {
  "${DOCKER_RUNNER[@]}" compose \
    --project-name "$COMPOSE_PROJECT_NAME" \
    --env-file "$ENV_FILE" \
    -f "$CHECKOUT_DIR/docker-compose.yml" \
    "$@"
}

pull_images() {
  local status=0
  compose pull api worker web postgres redis || status=$?
  if ((status != 0)); then
    printf '拉取镜像失败；如果 GHCR package 为私有，请先运行 docker login ghcr.io。\n' >&2
    return "$status"
  fi
}

build_image() {
  compose build api
}

start_stack() {
  compose up -d --no-build
}

container_id() {
  local service=$1
  compose ps -q "$service" 2>/dev/null | head -n 1
}

check_ready_once() {
  local postgres_id redis_id api_id web_id worker_id postgres_health redis_health worker_status
  postgres_id=$(container_id postgres)
  redis_id=$(container_id redis)
  api_id=$(container_id api)
  web_id=$(container_id web)
  worker_id=$(container_id worker)
  [[ -n "$postgres_id" && -n "$redis_id" && -n "$api_id" && -n "$web_id" && -n "$worker_id" ]] || return 1
  postgres_health=$("${DOCKER_RUNNER[@]}" inspect -f '{{.State.Health.Status}}' "$postgres_id" 2>/dev/null) || return 1
  redis_health=$("${DOCKER_RUNNER[@]}" inspect -f '{{.State.Health.Status}}' "$redis_id" 2>/dev/null) || return 1
  worker_status=$("${DOCKER_RUNNER[@]}" inspect -f '{{.State.Status}}' "$worker_id" 2>/dev/null) || return 1
  [[ "$postgres_health" == healthy && "$redis_health" == healthy && "$worker_status" == running ]] || return 1
  curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:$API_PORT_VALUE/health" >/dev/null || return 1
  curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:$WEB_PORT_VALUE/" >/dev/null || return 1
}

wait_for_ready() {
  local max_attempts=${EDIORA_READY_ATTEMPTS-60}
  local interval=${EDIORA_READY_INTERVAL-2}
  local attempt
  printf '等待 PostgreSQL、Redis、API、Worker 和 Web 就绪...\n' >&2
  for ((attempt = 1; attempt <= max_attempts; attempt++)); do
    if check_ready_once; then
      printf '服务已就绪。\n' >&2
      return 0
    fi
    if ((attempt < max_attempts)); then
      sleep "$interval"
    fi
  done
  die "服务在 ${max_attempts} 次检查后仍未就绪；保留当前容器和数据供排查"
}

print_success() {
  printf '\nEdiora 已启动。\n'
  printf 'Web: http://localhost:%s\n' "$WEB_PORT_VALUE"
  printf 'API 健康检查: http://localhost:%s/health\n' "$API_PORT_VALUE"
  printf '目录: %s\n' "$CHECKOUT_DIR"
  printf '状态: (cd %q && docker compose --env-file .env ps)\n' "$CHECKOUT_DIR"
  printf '日志: (cd %q && docker compose --env-file .env logs -f api worker web)\n' "$CHECKOUT_DIR"
  printf '停止: (cd %q && docker compose --env-file .env stop)\n' "$CHECKOUT_DIR"
  printf '重试安装: (cd %q && ./install.sh)\n' "$CHECKOUT_DIR"
  printf '可选本地 ASR: (cd %q && docker compose --env-file .env --profile local-asr up -d)\n' "$CHECKOUT_DIR"
  printf '模型及第三方 API 凭据请在 Ediora Settings 中配置。\n'
}

main() {
  parse_args "$@"
  if ((EUID == 0 && SHOW_HELP == 0)); then
    die '请使用普通用户运行 install.sh；脚本内部仅对 Docker 包和服务操作使用 sudo'
  fi
  require_bootstrap_commands
  require_ubuntu
  resolve_checkout
  if ((SHOW_HELP == 1)); then
    usage
    return 0
  fi
  ENV_FILE="$CHECKOUT_DIR/.env"
  compose_project_name
  printf '检测到 Ubuntu %s，安装目录: %s\n' "$OS_VERSION" "$CHECKOUT_DIR"

  open_input
  if ! docker_ready 0; then
    confirm_docker_install
    install_docker
  fi

  collect_env
  validate_env
  prepare_data_directories
  printf '应用镜像: %s:%s；API 端口: %s；Web 端口: %s\n' "$APP_IMAGE_VALUE" "$IMAGE_TAG_VALUE" "$API_PORT_VALUE" "$WEB_PORT_VALUE"

  if ((DO_BUILD == 1)); then
    build_image
  else
    pull_images
  fi
  start_stack
  wait_for_ready
  print_success
}

main "$@"
