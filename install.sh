#!/bin/sh

set -eu
umask 077

AUTO_CONFIRM=0
SHOW_HELP=0
CHECKOUT_DIR=''
TARGET_EXISTS=0
ENV_FILE=''
COMPOSE_PROJECT_NAME=''
OS_RELEASE_FILE=${EDIORA_OS_RELEASE-/etc/os-release}
HOST_OS=''
OS_ID=''
OS_VERSION=''
UBUNTU_CODENAME=''
INPUT_SOURCE=''
INPUT_IS_TTY=0
INPUT_OPENED=0
DOCKER_USE_SUDO=0
SCRIPT_SOURCE=''

die() {
  printf '错误: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage: ./install.sh [--yes]
       curl -fsSL https://raw.githubusercontent.com/phoenix-gh/ediora-studio/main/install.sh | sh
       curl -fsSLo install.sh https://raw.githubusercontent.com/phoenix-gh/ediora-studio/main/install.sh
       chmod +x install.sh && ./install.sh

Options:
  --yes    Skip the Docker installation confirmation prompt.
           With a pipe, pass it as: sh -s -- --yes
  --help   Show this help.
USAGE
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --yes)
        AUTO_CONFIRM=1
        ;;
      --help|-h)
        SHOW_HELP=1
        ;;
      --)
        shift
        [ "$#" -eq 0 ] || die "未知参数: $1"
        return 0
        ;;
      *)
        usage >&2
        die "未知参数: $1"
        ;;
    esac
    shift
  done
}

require_bootstrap_commands() {
  for command_name in awk basename chmod cp curl dirname grep head id install mkdir mktemp mv od rm sed sleep stty tr uname wc; do
    command -v "$command_name" >/dev/null 2>&1 || die "缺少系统命令: $command_name"
  done
}

read_linux_metadata() {
  OS_ID='unknown'
  OS_VERSION='unknown'
  UBUNTU_CODENAME=''
  if [ -r "$OS_RELEASE_FILE" ]; then
    OS_ID=$(sed -n 's/^ID=//p' "$OS_RELEASE_FILE" | head -n 1 | tr -d '"' | tr -d '\015')
    OS_VERSION=$(sed -n 's/^VERSION_ID=//p' "$OS_RELEASE_FILE" | head -n 1 | tr -d '"' | tr -d '\015')
    UBUNTU_CODENAME=$(sed -n 's/^VERSION_CODENAME=//p' "$OS_RELEASE_FILE" | head -n 1 | tr -d '"' | tr -d '\015')
    [ -n "$OS_ID" ] || OS_ID=unknown
    [ -n "$OS_VERSION" ] || OS_VERSION=unknown
  fi
}

detect_platform() {
  HOST_OS=${EDIORA_HOST_OS-}
  [ -n "$HOST_OS" ] || HOST_OS=$(uname -s)
  case "$HOST_OS" in
    Linux)
      read_linux_metadata
      ;;
    Darwin)
      OS_ID=macos
      if command -v sw_vers >/dev/null 2>&1; then
        OS_VERSION=$(sw_vers -productVersion 2>/dev/null || printf 'unknown')
      else
        OS_VERSION=unknown
      fi
      ;;
    *)
      die "仅支持 Linux 和 macOS，检测到: $HOST_OS"
      ;;
  esac
}

ubuntu_docker_install_supported() {
  [ "$HOST_OS" = Linux ] || return 1
  [ "$OS_ID" = ubuntu ] || return 1
  case "$OS_VERSION" in
    22.04)
      [ -n "$UBUNTU_CODENAME" ] || UBUNTU_CODENAME=jammy
      ;;
    24.04)
      [ -n "$UBUNTU_CODENAME" ] || UBUNTU_CODENAME=noble
      ;;
    *)
      return 1
      ;;
  esac
}

is_ediora_source_checkout() {
  checkout_dir=$1
  [ -f "$checkout_dir/install.sh" ] &&
    [ -f "$checkout_dir/docker-compose.yml" ] &&
    [ -d "$checkout_dir/backend" ] &&
    [ -d "$checkout_dir/web" ]
}

is_ediora_compose_file() {
  candidate_file=$1
  [ -f "$candidate_file" ] &&
    grep -Fq 'x-app-image:' "$candidate_file" &&
    grep -Fq 'services:' "$candidate_file"
}

directory_can_receive_checkout() {
  directory=$1
  for entry in "$directory"/* "$directory"/.[!.]* "$directory"/..?*; do
    if [ -e "$entry" ] || [ -L "$entry" ]; then
      [ "$(basename "$entry")" = install.sh ] || return 1
    fi
  done
  return 0
}

resolve_checkout() {
  SCRIPT_SOURCE=$0
  working_dir=$(CDPATH= cd -P . && pwd)
  if [ -f "$SCRIPT_SOURCE" ]; then
    script_dir=$(CDPATH= cd -P "$(dirname "$SCRIPT_SOURCE")" && pwd)
    SCRIPT_SOURCE="$script_dir/$(basename "$SCRIPT_SOURCE")"
    if [ "$working_dir" = "$script_dir" ] && is_ediora_source_checkout "$script_dir"; then
      CHECKOUT_DIR=$script_dir
      return 0
    fi
  else
    SCRIPT_SOURCE=''
  fi

  if [ -n "${EDIORA_INSTALL_DIR-}" ]; then
    target=$EDIORA_INSTALL_DIR
  else
    [ -n "${HOME-}" ] || die '无法确定安装目录，请设置 EDIORA_INSTALL_DIR'
    select_install_target
  fi
  case "$target" in
    /*) ;;
    *) target=$(pwd)/$target ;;
  esac

  TARGET_EXISTS=0
  if [ -e "$target" ]; then
    if is_ediora_compose_file "$target/docker-compose.yml"; then
      CHECKOUT_DIR=$(CDPATH= cd -P "$target" && pwd)
      return 0
    fi
    [ -d "$target" ] && directory_can_receive_checkout "$target" || die "安装目录已存在但不是 Ediora checkout 或空目录: $target"
    TARGET_EXISTS=1
  fi

  if [ "$TARGET_EXISTS" -eq 1 ]; then
    CHECKOUT_DIR=$(CDPATH= cd -P "$target" && pwd)
  else
    CHECKOUT_DIR=$target
  fi
}

ensure_compose_file() {
  compose_file="$CHECKOUT_DIR/docker-compose.yml"
  if [ -f "$compose_file" ]; then
    is_ediora_compose_file "$compose_file" || die "安装目录中的 docker-compose.yml 不是 Ediora Compose 配置: $compose_file"
    return 0
  fi

  [ "$TARGET_EXISTS" -eq 1 ] || mkdir -p "$CHECKOUT_DIR"
  temp_file=$(mktemp "${TMPDIR:-/tmp}/ediora-compose.XXXXXX")
  printf '正在下载 Ediora Compose 配置到 %s\n' "$CHECKOUT_DIR" >&2
  if ! curl -fsSL 'https://raw.githubusercontent.com/phoenix-gh/ediora-studio/main/docker-compose.yml' -o "$temp_file"; then
    rm -f "$temp_file"
    die '下载 Ediora Compose 配置失败'
  fi
  if ! is_ediora_compose_file "$temp_file"; then
    rm -f "$temp_file"
    die '下载的 docker-compose.yml 不是有效的 Ediora Compose 配置'
  fi
  cp "$temp_file" "$compose_file"
  rm -f "$temp_file"
}

open_input() {
  [ "$INPUT_OPENED" -eq 1 ] && return 0
  if [ -n "${EDIORA_INPUT_FILE-}" ]; then
    INPUT_SOURCE=$EDIORA_INPUT_FILE
    [ -r "$INPUT_SOURCE" ] || die "无法读取 EDIORA_INPUT_FILE"
    exec 3< "$INPUT_SOURCE" || die "无法读取 EDIORA_INPUT_FILE"
  elif [ -r /dev/tty ] && { [ -t 0 ] || [ -t 1 ]; }; then
    INPUT_SOURCE=/dev/tty
    INPUT_IS_TTY=1
    exec 3<>/dev/tty || die '无法打开终端输入'
  else
    INPUT_SOURCE=/dev/stdin
    exec 3<&0 || die '非交互环境没有可用输入；请通过终端运行安装器'
  fi
  INPUT_OPENED=1
}

read_answer() {
  secret=$1
  if [ "$INPUT_IS_TTY" -eq 1 ] && [ "$secret" -eq 1 ]; then
    stty -echo <&3 || die '无法关闭终端回显'
    if IFS= read -r ANSWER <&3; then
      read_status=0
    else
      read_status=$?
    fi
    stty echo <&3 || true
    printf '\n' >&2
    [ "$read_status" -eq 0 ] || die '读取输入失败'
  else
    IFS= read -r ANSWER <&3 || die '读取输入失败；请重新运行并完成配置'
  fi
}

prompt_value() {
  prompt=$1
  secret=$2
  printf '%s' "$prompt" >&2
  read_answer "$secret"
  printf '%s' "$ANSWER"
}

select_install_target() {
  default_target=$HOME/ediora-studio
  open_input
  printf '\n请选择 Ediora 安装目录：\n' >&2
  printf '  1) 当前目录: %s\n' "$working_dir" >&2
  printf '  2) Home 目录: %s\n' "$default_target" >&2
  printf '  3) 自定义目录\n' >&2
  answer=$(prompt_value '请输入选项 [2]: ' 0)
  [ -n "$answer" ] || answer=2
  case "$answer" in
    1)
      target=$working_dir
      ;;
    2)
      target=$default_target
      ;;
    3)
      target=$(prompt_value '请输入自定义安装目录: ' 0)
      [ -n "$target" ] || die '自定义安装目录不能为空'
      ;;
    *)
      die '无效的安装目录选项，请输入 1、2 或 3'
      ;;
  esac
}

confirm_docker_install() {
  [ "$AUTO_CONFIRM" -eq 1 ] && return 0
  printf '\n未检测到可用的 Docker Engine/Compose v2。\n' >&2
  printf '接下来将通过 Docker 官方 Ubuntu apt 仓库安装 Docker Engine、Buildx 和 Compose 插件，并使用 sudo。\n' >&2
  answer=$(prompt_value '确认安装 Docker？请输入 y/yes 继续，其他输入取消: ' 0)
  answer=$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]')
  case "$answer" in
    y|yes) ;;
    *) die '已取消 Docker 安装' ;;
  esac
}

random_token() {
  if command -v openssl >/dev/null 2>&1; then
    value=$(openssl rand -hex 32 2>/dev/null) && {
      printf '%s' "$value"
      return 0
    }
  fi
  value=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
  [ "$(printf '%s' "$value" | wc -c)" -eq 64 ] || die '无法生成安全随机令牌'
  printf '%s' "$value"
}

random_fernet_key() {
  if command -v openssl >/dev/null 2>&1; then
    value=$(openssl rand -base64 32 2>/dev/null | tr '+/' '-_' | tr -d '\n') && {
      printf '%s' "$value"
      return 0
    }
  fi
  if command -v base64 >/dev/null 2>&1; then
    value=$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '\n') && {
      printf '%s' "$value"
      return 0
    }
  fi
  die '无法生成 X_SESSION_KEY；请安装 openssl 后重试'
}

env_value() {
  key=$1
  value=$(awk -v target="$key" 'index($0, target "=") == 1 { value = substr($0, length(target) + 2) } END { printf "%s", value }' "$ENV_FILE")
  value=$(printf '%s' "$value" | sed -e 's/\r$//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
  printf '%s' "$value"
}

dotenv_value() {
  value=$1
  case "$value" in
    *[!A-Za-z0-9._:/@%+,-]*)
      escaped=$(printf '%s' "$value" | sed 's/[\\]/\\&/g; s/"/\\"/g')
      printf '"%s"' "$escaped"
      ;;
    *)
      printf '%s' "$value"
      ;;
  esac
}

append_env_value() {
  key=$1
  value=$2
  current=$(env_value "$key")
  [ -n "$current" ] && return 0
  if [ ! -f "$ENV_FILE" ]; then
    : > "$ENV_FILE"
  elif [ -s "$ENV_FILE" ]; then
    printf '\n' >> "$ENV_FILE"
  fi
  printf '%s=%s\n' "$key" "$(dotenv_value "$value")" >> "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

env_has_key() {
  key=$1
  awk -v target="$key" 'index($0, target "=") == 1 { found = 1 } END { exit found ? 0 : 1 }' "$ENV_FILE"
}

replace_env_value() {
  key=$1
  value=$2
  encoded_value=$(dotenv_value "$value")
  temp_env=$(mktemp "$ENV_FILE.XXXXXX")
  if ! awk -v target="$key" -v replacement="$encoded_value" '
    index($0, target "=") == 1 && replaced == 0 {
      print target "=" replacement
      replaced = 1
      next
    }
    { print }
    END { if (!replaced) exit 1 }
  ' "$ENV_FILE" > "$temp_env"; then
    rm -f "$temp_env"
    die "无法更新 $key"
  fi
  chmod 600 "$temp_env"
  mv "$temp_env" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

ensure_value() {
  key=$1
  label=$2
  default_value=$3
  secret=$4
  current=$(env_value "$key")
  [ -n "$current" ] && return 0
  if [ "$secret" -eq 1 ]; then
    printf '%s [回车自动生成]\n' "$label" >&2
  else
    printf '%s [%s]\n' "$label" "$default_value" >&2
  fi
  answer=$(prompt_value '> ' "$secret")
  [ -n "$answer" ] || answer=$default_value
  append_env_value "$key" "$answer"
}

ensure_derived_value() {
  key=$1
  default_value=$2
  current=$(env_value "$key")
  if [ -z "$current" ]; then
    if env_has_key "$key"; then
      replace_env_value "$key" "$default_value"
    else
      append_env_value "$key" "$default_value"
    fi
    return 0
  fi

  case "$key" in
    NEXT_PUBLIC_API_URL)
      case "$current" in
        http://localhost:8000/api|http://127.0.0.1:8000/api)
          replace_env_value "$key" "$default_value"
          ;;
      esac
      ;;
    CORS_ORIGINS)
      case "$current" in
        http://localhost:3000|http://localhost:3000,http://127.0.0.1:3000|http://127.0.0.1:3000,http://localhost:3000)
          replace_env_value "$key" "$default_value"
          ;;
      esac
      ;;
  esac
}

ensure_fixed_value() {
  append_env_value "$1" "$2"
}

collect_env() {
  ENV_FILE="$CHECKOUT_DIR/.env"
  [ -f "$ENV_FILE" ] || : > "$ENV_FILE"
  chmod 600 "$ENV_FILE"

  ensure_value POSTGRES_PASSWORD 'PostgreSQL 密码' "$(random_token)" 1
  ensure_value WORKER_TOKEN 'Worker 内部令牌（至少 32 个字符）' "$(random_token)" 1
  ensure_value X_SESSION_KEY 'X 会话加密密钥' "$(random_fernet_key)" 1
  ensure_value API_PORT 'API 主机端口' '8000' 0
  ensure_value WEB_PORT 'Web 主机端口' '3000' 0
  api_port=$(env_value API_PORT)
  web_port=$(env_value WEB_PORT)
  ensure_derived_value NEXT_PUBLIC_API_URL "http://localhost:${api_port}/api"
  ensure_derived_value NEXT_PUBLIC_DEVELOPER_MODE "0"
  ensure_derived_value CORS_ORIGINS "http://127.0.0.1:${web_port},http://localhost:${web_port}"
  ensure_value APP_IMAGE '应用镜像' 'ghcr.io/phoenix-gh/ediora-studio' 0
  ensure_value IMAGE_TAG '镜像标签' 'latest' 0
  ensure_fixed_value WORKER_QUEUE 'content-jobs'
  ensure_fixed_value VIDEO_WORKER_QUEUE 'content-jobs:video'
}

validate_no_control() {
  key=$1
  value=$2
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

  [ -n "$POSTGRES_PASSWORD_VALUE" ] || die 'POSTGRES_PASSWORD 不能为空'
  [ "${#WORKER_TOKEN_VALUE}" -ge 32 ] || die 'WORKER_TOKEN 至少需要 32 个字符'
  [ -n "$X_SESSION_KEY_VALUE" ] || die 'X_SESSION_KEY 不能为空'
  case "$API_PORT_VALUE" in ''|*[!0-9]*) die 'API_PORT 必须是 1-65535 的端口' ;; esac
  case "$WEB_PORT_VALUE" in ''|*[!0-9]*) die 'WEB_PORT 必须是 1-65535 的端口' ;; esac
  [ "$API_PORT_VALUE" -ge 1 ] && [ "$API_PORT_VALUE" -le 65535 ] || die 'API_PORT 必须是 1-65535 的端口'
  [ "$WEB_PORT_VALUE" -ge 1 ] && [ "$WEB_PORT_VALUE" -le 65535 ] || die 'WEB_PORT 必须是 1-65535 的端口'
  [ "$API_PORT_VALUE" -ne "$WEB_PORT_VALUE" ] || die 'API_PORT 和 WEB_PORT 不能相同'
  case "$NEXT_PUBLIC_API_URL_VALUE" in http://*|https://*) ;; *) die 'NEXT_PUBLIC_API_URL 必须是 HTTP(S) URL' ;; esac
  [ -n "$CORS_ORIGINS_VALUE" ] || die 'CORS_ORIGINS 不能为空'
  case "$APP_IMAGE_VALUE" in ''|[!A-Za-z0-9]*|*[!A-Za-z0-9._:/-]*) die 'APP_IMAGE 不是有效镜像引用' ;; esac
  case "$IMAGE_TAG_VALUE" in ''|[!A-Za-z0-9]*|*[!A-Za-z0-9._-]*) die 'IMAGE_TAG 不是有效标签' ;; esac
}

prepare_data_directories() {
  data_dir="$CHECKOUT_DIR/data"
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

docker_cmd() {
  if [ "$DOCKER_USE_SUDO" -eq 1 ]; then
    sudo docker "$@"
  else
    docker "$@"
  fi
}

docker_ready() {
  allow_sudo=$1
  if command -v docker >/dev/null 2>&1 && docker version >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    DOCKER_USE_SUDO=0
    return 0
  fi
  command -v sudo >/dev/null 2>&1 || return 1
  if [ "$allow_sudo" -eq 1 ]; then
    if sudo docker version >/dev/null 2>&1 && sudo docker compose version >/dev/null 2>&1; then
      DOCKER_USE_SUDO=1
      printf '将使用 sudo docker 访问 Docker；如需免 sudo，请重新登录以加载 docker 组权限。\n' >&2
      return 0
    fi
  elif sudo -n docker version >/dev/null 2>&1 && sudo -n docker compose version >/dev/null 2>&1; then
    DOCKER_USE_SUDO=1
    return 0
  fi
  return 1
}

docker_architecture() {
  if command -v dpkg >/dev/null 2>&1; then
    dpkg --print-architecture
    return 0
  fi
  case "$(uname -m)" in
    x86_64) printf 'amd64' ;;
    aarch64|arm64) printf 'arm64' ;;
    armv7l) printf 'armhf' ;;
    *) die "不支持的 CPU 架构: $(uname -m)" ;;
  esac
}

install_docker() {
  ubuntu_docker_install_supported || die '当前系统不能自动安装 Docker；请先手动安装 Docker Engine/Compose v2 后重试'
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
  base=$(basename "$CHECKOUT_DIR")
  COMPOSE_PROJECT_NAME=$(printf '%s' "$base" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]/-/g; s/^[^a-z0-9]*//; s/[^a-z0-9]*$//')
  [ -n "$COMPOSE_PROJECT_NAME" ] || COMPOSE_PROJECT_NAME=ediora
}

compose() {
  docker_cmd compose \
    --project-name "$COMPOSE_PROJECT_NAME" \
    --env-file "$ENV_FILE" \
    -f "$CHECKOUT_DIR/docker-compose.yml" \
    "$@"
}

pull_images() {
  if compose pull api worker web postgres redis; then
    return 0
  else
    status=$?
  fi
  printf '拉取镜像失败；如果 GHCR package 为私有，请先运行 docker login ghcr.io。\n' >&2
  return "$status"
}

start_stack() {
  compose up -d --no-build
}

container_id() {
  compose ps -q "$1" 2>/dev/null | head -n 1
}

check_ready_once() {
  postgres_id=$(container_id postgres)
  redis_id=$(container_id redis)
  api_id=$(container_id api)
  web_id=$(container_id web)
  worker_id=$(container_id worker)
  [ -n "$postgres_id" ] && [ -n "$redis_id" ] && [ -n "$api_id" ] && [ -n "$web_id" ] && [ -n "$worker_id" ] || return 1
  postgres_health=$(docker_cmd inspect -f '{{.State.Health.Status}}' "$postgres_id" 2>/dev/null) || return 1
  redis_health=$(docker_cmd inspect -f '{{.State.Health.Status}}' "$redis_id" 2>/dev/null) || return 1
  worker_status=$(docker_cmd inspect -f '{{.State.Status}}' "$worker_id" 2>/dev/null) || return 1
  [ "$postgres_health" = healthy ] && [ "$redis_health" = healthy ] && [ "$worker_status" = running ] || return 1
  curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:$API_PORT_VALUE/health" >/dev/null || return 1
  curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:$WEB_PORT_VALUE/" >/dev/null || return 1
}

wait_for_ready() {
  max_attempts=${EDIORA_READY_ATTEMPTS-60}
  interval=${EDIORA_READY_INTERVAL-2}
  attempt=1
  printf '等待 PostgreSQL、Redis、API、Worker 和 Web 就绪...\n' >&2
  while [ "$attempt" -le "$max_attempts" ]; do
    if check_ready_once; then
      printf '服务已就绪。\n' >&2
      return 0
    fi
    [ "$attempt" -ge "$max_attempts" ] || sleep "$interval"
    attempt=$((attempt + 1))
  done
  die "服务在 ${max_attempts} 次检查后仍未就绪；保留当前容器和数据供排查"
}

print_success() {
  printf '\nEdiora 已启动。\n'
  printf 'Web: http://localhost:%s\n' "$WEB_PORT_VALUE"
  printf 'API 健康检查: http://localhost:%s/health\n' "$API_PORT_VALUE"
  printf '目录: %s\n' "$CHECKOUT_DIR"
  printf '状态: (cd "%s" && docker compose --env-file .env ps)\n' "$CHECKOUT_DIR"
  printf '日志: (cd "%s" && docker compose --env-file .env logs -f api worker web)\n' "$CHECKOUT_DIR"
  printf '停止: (cd "%s" && docker compose --env-file .env stop)\n' "$CHECKOUT_DIR"
  if [ -x "$CHECKOUT_DIR/install.sh" ]; then
    printf '重试安装: (cd "%s" && ./install.sh)\n' "$CHECKOUT_DIR"
  else
    printf '重试安装: curl -fsSL https://raw.githubusercontent.com/phoenix-gh/ediora-studio/main/install.sh | sh\n'
  fi
  printf '可选本地 ASR: (cd "%s" && docker compose --env-file .env --profile local-asr up -d)\n' "$CHECKOUT_DIR"
  printf '模型及第三方 API 凭据请在 Ediora Settings 中配置。\n'
}

main() {
  parse_args "$@"
  if [ "$SHOW_HELP" -eq 1 ]; then
    usage
    return 0
  fi
  [ "$(id -u)" -ne 0 ] || die '请使用普通用户运行 install.sh；脚本内部仅对 Docker 包和服务操作使用 sudo'
  require_bootstrap_commands
  detect_platform
  resolve_checkout
  ENV_FILE="$CHECKOUT_DIR/.env"
  compose_project_name
  printf '检测到 %s %s，安装目录: %s\n' "$HOST_OS" "$OS_VERSION" "$CHECKOUT_DIR"

  if ! docker_ready 0; then
    case "$HOST_OS" in
      Darwin)
        die 'macOS 需要先安装并启动 Docker Desktop（https://www.docker.com/products/docker-desktop/）'
        ;;
      Linux)
        ubuntu_docker_install_supported || die '当前 Linux 未检测到 Docker；请先安装 Docker Engine 和 Compose v2 后重试'
        ;;
    esac
  fi

  open_input
  if ! docker_ready 0; then
    confirm_docker_install
    install_docker
  fi

  ensure_compose_file
  collect_env
  validate_env
  prepare_data_directories
  printf '应用镜像: %s:%s；API 端口: %s；Web 端口: %s\n' "$APP_IMAGE_VALUE" "$IMAGE_TAG_VALUE" "$API_PORT_VALUE" "$WEB_PORT_VALUE"

  pull_images
  start_stack
  wait_for_ready
  print_success
}

main "$@"
