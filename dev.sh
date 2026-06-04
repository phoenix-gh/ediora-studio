#!/usr/bin/env bash
#
# WeMedia Studio 本地开发服务管理脚本
#   ./dev.sh start    启动后端(:8000) + 前端(:3000)
#   ./dev.sh stop     停止两个服务
#   ./dev.sh restart  重启
#   ./dev.sh status   查看运行状态
#   ./dev.sh logs     跟随查看日志 (Ctrl-C 退出)
#
set -o pipefail

# 加载工具链路径(node/npm 走 asdf shims,conda 走 miniconda3)
export PATH="$HOME/.asdf/shims:$HOME/miniconda3/bin:$PATH"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT/backend"
FRONTEND_DIR="$ROOT/wemedia-studio"
LOG_DIR="$ROOT/logs"
RUN_DIR="$ROOT/.run"
CONDA_ENV="wems"
BACKEND_PORT=8000
FRONTEND_PORT=3000

mkdir -p "$LOG_DIR" "$RUN_DIR"

# ---- 颜色 ----
c_g() { printf '\033[32m%s\033[0m' "$1"; }
c_r() { printf '\033[31m%s\033[0m' "$1"; }
c_y() { printf '\033[33m%s\033[0m' "$1"; }

# 启动一个服务: <name> <dir> <pidfile> <logfile> <cmd...>
start_one() {
  local name="$1" dir="$2" pidfile="$3" logfile="$4"; shift 4
  if running "$pidfile"; then
    echo "  $(c_y "•") $name 已在运行 (pid $(cat "$pidfile"))"
    return
  fi
  # setsid 起一个新会话的 bash:它成为进程组组长,把自身 $$ 写进 pidfile,
  # 再 exec 目标命令(PID 不变,仍是组长)。停止时 kill -- -PGID 可整组回收
  # (含 conda run/uvicorn --reload/next 派生的全部子进程)。
  setsid bash -c 'echo $$ >"$1"; cd "$2" || exit 1; shift 2; exec "$@"' \
    _ "$pidfile" "$dir" "$@" >"$logfile" 2>&1 &
  sleep 0.5
  if running "$pidfile"; then
    echo "  $(c_g "✓") $name 启动中 (pid $(cat "$pidfile")) → $logfile"
  else
    echo "  $(c_r "✗") $name 启动失败,见日志: $logfile"
  fi
}

# 进程是否存活
running() {
  local pidfile="$1"
  [ -f "$pidfile" ] || return 1
  local pid; pid="$(cat "$pidfile" 2>/dev/null)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

# 停止一个服务(连同整个进程组)
stop_one() {
  local name="$1" pidfile="$2"
  if ! running "$pidfile"; then
    echo "  $(c_y "•") $name 未运行"
    rm -f "$pidfile"
    return
  fi
  local pid; pid="$(cat "$pidfile")"
  # 杀整个进程组
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.2
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null
  fi
  rm -f "$pidfile"
  echo "  $(c_g "✓") $name 已停止"
}

cmd_start() {
  echo "启动 WeMedia Studio 开发服务..."
  start_one "后端 (:$BACKEND_PORT)" "$BACKEND_DIR" \
    "$RUN_DIR/backend.pid" "$LOG_DIR/backend.log" \
    conda run --no-capture-output -n "$CONDA_ENV" \
    uvicorn main:app --host 0.0.0.0 --port "$BACKEND_PORT" --reload
  start_one "前端 (:$FRONTEND_PORT)" "$FRONTEND_DIR" \
    "$RUN_DIR/frontend.pid" "$LOG_DIR/frontend.log" \
    npm run dev
  echo
  echo "  后端:  http://localhost:$BACKEND_PORT  (docs: /docs)"
  echo "  前端:  http://localhost:$FRONTEND_PORT"
  echo "  日志:  ./dev.sh logs    停止: ./dev.sh stop"
}

cmd_stop() {
  echo "停止 WeMedia Studio 开发服务..."
  stop_one "前端" "$RUN_DIR/frontend.pid"
  stop_one "后端" "$RUN_DIR/backend.pid"
}

cmd_status() {
  local b f
  running "$RUN_DIR/backend.pid"  && b="$(c_g 运行中) (pid $(cat "$RUN_DIR/backend.pid"))"  || b="$(c_r 已停止)"
  running "$RUN_DIR/frontend.pid" && f="$(c_g 运行中) (pid $(cat "$RUN_DIR/frontend.pid"))" || f="$(c_r 已停止)"
  echo "  后端 (:$BACKEND_PORT):  $b"
  echo "  前端 (:$FRONTEND_PORT):  $f"
}

cmd_logs() {
  echo "跟随日志 (Ctrl-C 退出)..."
  tail -n 40 -F "$LOG_DIR/backend.log" "$LOG_DIR/frontend.log"
}

case "${1:-start}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_stop; echo; cmd_start ;;
  status)  cmd_status ;;
  logs)    cmd_logs ;;
  *) echo "用法: $0 {start|stop|restart|status|logs}"; exit 1 ;;
esac
