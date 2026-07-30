from __future__ import annotations

import hashlib
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import textwrap
import time
import urllib.request
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
DEV_SCRIPT = ROOT / "dev.sh"
VALID_TOKEN = "task12-runtime-worker-token-000000000000"
REPLACEMENT_TOKEN = "replacement-worker-token-0000000000000000"


def _write_executable(path: Path, body: str) -> None:
    path.write_text(textwrap.dedent(body).lstrip(), encoding="utf-8")
    path.chmod(0o755)


def _fake_runtime_tools(
    tmp_path: Path,
    *,
    fake_redis: bool = True,
    fake_http: bool = True,
) -> Path:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()

    if fake_redis:
        _write_executable(
            bin_dir / "redis-cli",
            """
            #!/bin/sh
            if [ -f "$WMS_DEV_TEST_STATE/redis.ready" ]; then
              printf 'ready:redis\n' >>"$WMS_DEV_TEST_STATE/events"
              printf 'PONG\n'
              exit 0
            fi
            exit 1
            """,
        )
        _write_executable(
            bin_dir / "redis-server",
            """
            #!/bin/sh
            printf 'start:redis\n' >>"$WMS_DEV_TEST_STATE/events"
            if [ "${WMS_DEV_TEST_FAIL_STAGE:-}" = redis ]; then
              exit 17
            fi
            : >"$WMS_DEV_TEST_STATE/redis.ready"
            trap 'printf "stop:redis\\n" >>"$WMS_DEV_TEST_STATE/events"; rm -f "$WMS_DEV_TEST_STATE/redis.ready"; exit 0' TERM INT
            while :; do sleep 1; done
            """,
        )

    _write_executable(
        bin_dir / "conda",
        """
        #!/bin/sh
        printf 'start:api\n' >>"$WMS_DEV_TEST_STATE/events"
        token_hash="$(printf '%s' "$WMS_WORKER_TOKEN" | sha256sum | awk '{print $1}')"
        printf '%s|%s|%s|%s|%s\n' \
          "$WMS_REDIS_URL" "$WMS_WORKER_QUEUE" "$token_hash" "$WMS_API_URL" \
          "$WMS_CORS_ORIGINS" \
          >"$WMS_DEV_TEST_STATE/api.env"
        if [ "${WMS_DEV_TEST_FAIL_STAGE:-}" = api-bind ]; then
          sleep 0.15
          exit 17
        fi
        if [ "${WMS_DEV_TEST_FAIL_STAGE:-}" != api ]; then
          : >"$WMS_DEV_TEST_STATE/api.ready"
        fi
        trap 'printf "stop:api\\n" >>"$WMS_DEV_TEST_STATE/events"; rm -f "$WMS_DEV_TEST_STATE/api.ready"; exit 0' TERM INT
        while :; do sleep 1; done
        """,
    )
    _write_executable(
        bin_dir / "pnpm",
        """
        #!/bin/sh
        case " $* " in
          *" jobs:worker "*)
            printf 'start:worker\n' >>"$WMS_DEV_TEST_STATE/events"
            token_hash="$(printf '%s' "$WMS_WORKER_TOKEN" | sha256sum | awk '{print $1}')"
            printf '%s|%s|%s|%s|%s\n' \
              "$WMS_REDIS_URL" "$WMS_WORKER_QUEUE" "$token_hash" "$WMS_API_URL" \
              "$WMS_CORS_ORIGINS" \
              >"$WMS_DEV_TEST_STATE/worker.env"
            if [ "${WMS_DEV_TEST_FAIL_STAGE:-}" = worker ]; then
              exit 17
            fi
            if [ "${WMS_DEV_TEST_FAIL_STAGE:-}" != worker-never-ready ] \
              && [ -n "${WMS_WORKER_READY_FILE:-}" ]; then
              ready_tmp="${WMS_WORKER_READY_FILE}.tmp.$$"
              {
                printf 'marker=%s\n' "$WMS_DEV_SERVICE_MARKER"
                printf 'config_fingerprint=%s\n' "$WMS_DEV_CONFIG_FINGERPRINT"
              } >"$ready_tmp"
              mv -f -- "$ready_tmp" "$WMS_WORKER_READY_FILE"
              printf 'ready:worker\n' >>"$WMS_DEV_TEST_STATE/events"
            fi
            trap 'printf "stop:worker\\n" >>"$WMS_DEV_TEST_STATE/events"; exit 0' TERM INT
            while :; do sleep 1; done
            ;;
          *)
            printf 'start:web\n' >>"$WMS_DEV_TEST_STATE/events"
            token_hash="$(printf '%s' "$WMS_WORKER_TOKEN" | sha256sum | awk '{print $1}')"
            printf '%s|%s|%s|%s|%s\n' \
              "$WMS_REDIS_URL" "$WMS_WORKER_QUEUE" "$token_hash" "$WMS_API_URL" \
              "$WMS_CORS_ORIGINS" \
              >"$WMS_DEV_TEST_STATE/web.env"
            if [ "${WMS_DEV_TEST_FAIL_STAGE:-}" != web ]; then
              : >"$WMS_DEV_TEST_STATE/web.ready"
            fi
            trap 'printf "stop:web\\n" >>"$WMS_DEV_TEST_STATE/events"; rm -f "$WMS_DEV_TEST_STATE/web.ready"; exit 0' TERM INT
            while :; do sleep 1; done
            ;;
        esac
        """,
    )
    shutil.copy2(bin_dir / "pnpm", bin_dir / "npm")
    if fake_http:
        _write_executable(
            bin_dir / "curl",
            """
            #!/bin/sh
            url=
            for argument in "$@"; do url="$argument"; done
            case "$url" in
              *":$WMS_API_PORT/health")
                [ -f "$WMS_DEV_TEST_STATE/api.ready" ] || exit 1
                printf 'ready:api\n' >>"$WMS_DEV_TEST_STATE/events"
                ;;
              *":$WMS_WEB_PORT/"*)
                [ -f "$WMS_DEV_TEST_STATE/web.ready" ] || exit 1
                printf 'ready:web\n' >>"$WMS_DEV_TEST_STATE/events"
                ;;
              *)
                exit 1
                ;;
            esac
            """,
        )
    return bin_dir


def _dev_env(tmp_path: Path, bin_dir: Path) -> dict[str, str]:
    state = tmp_path / "state"
    state.mkdir(exist_ok=True)
    env = os.environ.copy()
    env.update(
        {
            "PATH": f"{bin_dir}{os.pathsep}{env['PATH']}",
            "WMS_WORKER_TOKEN": VALID_TOKEN,
            "WMS_DEV_RUN_DIR": str(tmp_path / "run"),
            "WMS_DEV_LOG_DIR": str(tmp_path / "logs"),
            "WMS_DEV_TEST_STATE": str(state),
            "WMS_DEV_READY_TIMEOUT_SECONDS": "0.6",
            "WMS_DEV_STOP_TIMEOUT_SECONDS": "0.6",
            "WMS_DEV_POLL_INTERVAL_SECONDS": "0.05",
            "WMS_DEV_HTTP_SETTLE_SECONDS": "0.2",
            # The fake services do not bind. Real socket tests replace these
            # values with ports held by their server processes.
            "WMS_REDIS_PORT": "46379",
            "WMS_API_PORT": "48000",
            "WMS_WEB_PORT": "43000",
        }
    )
    return env


def _run_dev(
    env: dict[str, str],
    command: str,
    *arguments: str,
    timeout: float = 10,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(DEV_SCRIPT), command, *arguments],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        timeout=timeout,
    )


def _run_dev_with_unsignallable_group(
    env: dict[str, str],
    command: str,
    blocked_pgid: int,
    timeout: float = 10,
) -> subprocess.CompletedProcess[str]:
    harness = r"""
    blocked_pgid="$1"
    dev_script="$2"
    command="$3"
    kill() {
      local last="${@: -1}"
      if { [ "${1:-}" = "-TERM" ] || [ "${1:-}" = "-KILL" ]; } \
        && [ "$last" = "-$blocked_pgid" ]; then
        return 1
      fi
      builtin kill "$@"
    }
    source "$dev_script" "$command"
    """
    return subprocess.run(
        [
            "bash",
            "-c",
            textwrap.dedent(harness),
            "_",
            str(blocked_pgid),
            str(DEV_SCRIPT),
            command,
        ],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        timeout=timeout,
    )


def _events(env: dict[str, str]) -> list[str]:
    path = Path(env["WMS_DEV_TEST_STATE"]) / "events"
    return path.read_text(encoding="utf-8").splitlines() if path.exists() else []


def _metadata_fields(path: Path) -> dict[str, str]:
    return dict(
        line.split("=", 1)
        for line in path.read_text(encoding="utf-8").splitlines()
        if "=" in line
    )


def _metadata_pid(path: Path) -> int:
    return int(_metadata_fields(path)["pid"])


def _process_is_running(pid: int) -> bool:
    stat = Path(f"/proc/{pid}/stat")
    if not stat.exists():
        return False
    return stat.read_text(encoding="utf-8").rsplit(") ", 1)[1].split()[0] != "Z"


def _wait_until(predicate, timeout: float = 3) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.03)
    return predicate()


def _start_http_server() -> tuple[subprocess.Popen[str], int]:
    code = """
import http.server
import socketserver
import sys

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{"status":"external"}')

    def log_message(self, *_args):
        pass

with socketserver.TCPServer(("127.0.0.1", 0), Handler) as server:
    print(server.server_address[1], flush=True)
    server.serve_forever()
"""
    process = subprocess.Popen(
        [sys.executable, "-u", "-c", code],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    assert process.stdout is not None
    port_line = process.stdout.readline().strip()
    assert port_line, "ephemeral HTTP server did not report its bound port"
    return process, int(port_line)


def _start_redis_ping_server() -> tuple[subprocess.Popen[str], int]:
    code = """
import socketserver
import sys

class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.recv(1024)
        self.request.sendall(b"+PONG\\r\\n")

with socketserver.ThreadingTCPServer(("127.0.0.1", 0), Handler) as server:
    print(server.server_address[1], flush=True)
    server.serve_forever()
"""
    process = subprocess.Popen(
        [sys.executable, "-u", "-c", code],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    assert process.stdout is not None
    port_line = process.stdout.readline().strip()
    assert port_line, "ephemeral Redis probe server did not report its bound port"
    return process, int(port_line)


def _start_orphaned_owned_group(
    metadata_path: Path,
    child_pid_path: Path,
    marker: str,
) -> tuple[subprocess.Popen[str], int]:
    code = r"""
import os
import signal
import sys
from pathlib import Path

metadata_path = Path(sys.argv[1])
child_pid_path = Path(sys.argv[2])
marker = sys.argv[3]
pid = os.getpid()
pgid = os.getpgrp()
stat_fields = Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()
metadata_path.write_text(
    "\n".join(
        [
            f"pid={pid}",
            f"pgid={pgid}",
            f"start_ticks={stat_fields[19]}",
            f"marker={marker}",
            "service=api",
            "config_fingerprint=orphan-test",
            "",
        ]
    )
)

child = os.fork()
if child == 0:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    child_pid_path.write_text(str(os.getpid()))
    while True:
        signal.pause()
else:
    os._exit(0)
"""
    env = os.environ.copy()
    env["WMS_DEV_SERVICE_MARKER"] = marker
    leader = subprocess.Popen(
        [
            sys.executable,
            "-u",
            "-c",
            code,
            str(metadata_path),
            str(child_pid_path),
            marker,
        ],
        env=env,
        start_new_session=True,
    )
    assert _wait_until(lambda: child_pid_path.exists())
    child_pid = int(child_pid_path.read_text(encoding="utf-8"))
    assert _wait_until(lambda: leader.poll() is not None)
    return leader, child_pid


def _run_failed_owned_start_with_orphaned_child(
    tmp_path: Path,
    *,
    block_cleanup_signals: bool = False,
) -> tuple[subprocess.CompletedProcess[str], int, Path]:
    metadata = tmp_path / "failed-start.meta"
    log = tmp_path / "failed-start.log"
    child_pid_path = tmp_path / "failed-start-child.pid"
    target = r"""
import os
import signal
import sys

child = os.fork()
if child == 0:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    with open(sys.argv[1], "w", encoding="utf-8") as handle:
        handle.write(str(os.getpid()))
    while True:
        signal.pause()
os._exit(17)
"""
    harness = r"""
    source "$1"
    if [ "$8" = yes ]; then
      kill() {
        if [ "${1:-}" = "-0" ]; then
          builtin kill "$@"
        else
          return 1
        fi
      }
    fi
    export WMS_DEV_READY_TIMEOUT_SECONDS=0.3
    export WMS_DEV_STOP_TIMEOUT_SECONDS=0.1
    export WMS_DEV_POLL_INTERVAL_SECONDS=0.02
    dev_start_owned_service \
      api API "$2" "$3" "$4" failed-start-fingerprint \
      "$5" -c "$6" "$7"
    """
    result = subprocess.run(
        [
            "bash",
            "-c",
            textwrap.dedent(harness),
            "_",
            str(ROOT / "scripts" / "dev-runtime.sh"),
            str(ROOT),
            str(metadata),
            str(log),
            sys.executable,
            target,
            str(child_pid_path),
            "yes" if block_cleanup_signals else "no",
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=3,
    )
    assert _wait_until(child_pid_path.exists)
    return result, int(child_pid_path.read_text(encoding="utf-8")), metadata


def test_short_worker_token_fails_before_spawning_any_child_and_stays_secret(
    tmp_path: Path,
) -> None:
    bin_dir = _fake_runtime_tools(tmp_path)
    env = _dev_env(tmp_path, bin_dir)
    secret = "short-secret"
    env["WMS_WORKER_TOKEN"] = secret

    try:
        result = _run_dev(env, "start")

        assert result.returncode != 0
        assert not _events(env)
        assert not Path(env["WMS_DEV_RUN_DIR"]).exists()
        assert not Path(env["WMS_DEV_LOG_DIR"]).exists()
        assert secret not in result.stdout
        assert secret not in result.stderr
    finally:
        _run_dev(env, "stop")


def test_start_waits_for_each_service_and_stop_reverses_owned_processes(
    tmp_path: Path,
) -> None:
    bin_dir = _fake_runtime_tools(tmp_path)
    env = _dev_env(tmp_path, bin_dir)
    run_dir = Path(env["WMS_DEV_RUN_DIR"])

    try:
        started = _run_dev(env, "start")
        assert started.returncode == 0, started.stdout + started.stderr

        launch_events = _events(env)
        assert launch_events.index("ready:redis") < launch_events.index("start:api")
        assert launch_events.index("ready:api") < launch_events.index("start:worker")
        assert launch_events.index("start:worker") < launch_events.index("ready:worker")
        assert launch_events.index("ready:worker") < launch_events.index("start:web")
        assert launch_events.index("start:web") < launch_events.index("ready:web")
        expected_cors = (
            f"http://127.0.0.1:{env['WMS_WEB_PORT']},"
            f"http://localhost:{env['WMS_WEB_PORT']}"
        )
        expected_environment = "|".join(
            [
                f"redis://127.0.0.1:{env['WMS_REDIS_PORT']}/0",
                "content-jobs",
                hashlib.sha256(VALID_TOKEN.encode()).hexdigest(),
                f"http://127.0.0.1:{env['WMS_API_PORT']}/api",
                expected_cors,
            ]
        )
        state = Path(env["WMS_DEV_TEST_STATE"])
        for service in ("api", "worker", "web"):
            assert (
                state / f"{service}.env"
            ).read_text(encoding="utf-8").strip() == expected_environment

        metadata = [
            run_dir / f"{service}.meta"
            for service in ("redis", "api", "worker", "web")
        ]
        assert all(path.exists() for path in metadata)
        unit_fingerprints = {
            _metadata_fields(run_dir / f"{service}.meta")["config_fingerprint"]
            for service in ("api", "worker", "web")
        }
        assert len(unit_fingerprints) == 1
        worker_ready = run_dir / "worker.ready"
        assert worker_ready.exists()
        assert _metadata_fields(worker_ready) == {
            "marker": _metadata_fields(run_dir / "worker.meta")["marker"],
            "config_fingerprint": next(iter(unit_fingerprints)),
        }
        owned_pids = [_metadata_pid(path) for path in metadata]

        stopped = _run_dev(env, "stop")
        assert stopped.returncode == 0, stopped.stdout + stopped.stderr
        assert all(not path.exists() for path in metadata)
        assert not worker_ready.exists()
        assert _wait_until(lambda: all(not _process_is_running(pid) for pid in owned_pids))

        stopped_events = _events(env)
        assert stopped_events.index("stop:web") < stopped_events.index("stop:worker")
        assert stopped_events.index("stop:worker") < stopped_events.index("stop:api")
        assert stopped_events.index("stop:api") < stopped_events.index("stop:redis")
    finally:
        _run_dev(env, "stop")


@pytest.mark.parametrize("drift", ["token", "api", "cors"])
def test_config_drift_replaces_the_entire_api_worker_web_unit(
    tmp_path: Path,
    drift: str,
) -> None:
    bin_dir = _fake_runtime_tools(tmp_path)
    env = _dev_env(tmp_path, bin_dir)
    run_dir = Path(env["WMS_DEV_RUN_DIR"])
    state = Path(env["WMS_DEV_TEST_STATE"])

    try:
        first = _run_dev(env, "start")
        assert first.returncode == 0, first.stdout + first.stderr
        old_pids = {
            service: _metadata_pid(run_dir / f"{service}.meta")
            for service in ("redis", "api", "worker", "web")
        }
        old_fingerprint = _metadata_fields(run_dir / "api.meta")[
            "config_fingerprint"
        ]
        replacement_env = env.copy()
        if drift == "token":
            replacement_env["WMS_WORKER_TOKEN"] = REPLACEMENT_TOKEN
        elif drift == "api":
            replacement_env["WMS_API_PORT"] = "48001"
        else:
            replacement_env["WMS_CORS_ORIGINS"] = "https://editor.example.test"

        second = _run_dev(replacement_env, "start")
        assert second.returncode == 0, second.stdout + second.stderr
        assert _metadata_pid(run_dir / "redis.meta") == old_pids["redis"]
        assert all(
            _metadata_pid(run_dir / f"{service}.meta") != old_pids[service]
            for service in ("api", "worker", "web")
        )
        fingerprints = {
            _metadata_fields(run_dir / f"{service}.meta")["config_fingerprint"]
            for service in ("api", "worker", "web")
        }
        assert len(fingerprints) == 1
        assert old_fingerprint not in fingerprints

        expected_hash = hashlib.sha256(
            replacement_env["WMS_WORKER_TOKEN"].encode()
        ).hexdigest()
        expected_api = (
            f"http://127.0.0.1:{replacement_env['WMS_API_PORT']}/api"
        )
        expected_cors = replacement_env.get(
            "WMS_CORS_ORIGINS",
            (
                f"http://127.0.0.1:{replacement_env['WMS_WEB_PORT']},"
                f"http://localhost:{replacement_env['WMS_WEB_PORT']}"
            ),
        )
        for service in ("api", "worker", "web"):
            effective = (state / f"{service}.env").read_text(
                encoding="utf-8"
            ).strip()
            assert f"|{expected_hash}|{expected_api}|{expected_cors}" in effective
    finally:
        _run_dev(env, "stop")


@pytest.mark.parametrize("failed_stage", ["api", "worker", "web"])
def test_failed_config_replacement_leaves_no_mixed_application_unit(
    tmp_path: Path,
    failed_stage: str,
) -> None:
    bin_dir = _fake_runtime_tools(tmp_path)
    env = _dev_env(tmp_path, bin_dir)
    run_dir = Path(env["WMS_DEV_RUN_DIR"])

    try:
        first = _run_dev(env, "start")
        assert first.returncode == 0, first.stdout + first.stderr
        old_unit_pids = [
            _metadata_pid(run_dir / f"{service}.meta")
            for service in ("api", "worker", "web")
        ]
        redis_pid = _metadata_pid(run_dir / "redis.meta")
        replacement_env = env | {
            "WMS_WORKER_TOKEN": REPLACEMENT_TOKEN,
            "WMS_DEV_TEST_FAIL_STAGE": failed_stage,
        }

        replaced = _run_dev(replacement_env, "start")

        assert replaced.returncode != 0
        assert all(
            not (run_dir / f"{service}.meta").exists()
            for service in ("api", "worker", "web")
        )
        assert all(
            _wait_until(lambda pid=pid: not _process_is_running(pid))
            for pid in old_unit_pids
        )
        assert _metadata_pid(run_dir / "redis.meta") == redis_pid
        assert _process_is_running(redis_pid)
        assert not (run_dir / "worker.ready").exists()
    finally:
        _run_dev(env, "stop")


def test_failed_redis_config_replacement_stops_the_old_application_unit(
    tmp_path: Path,
) -> None:
    bin_dir = _fake_runtime_tools(tmp_path)
    env = _dev_env(tmp_path, bin_dir)
    run_dir = Path(env["WMS_DEV_RUN_DIR"])

    try:
        first = _run_dev(env, "start")
        assert first.returncode == 0, first.stdout + first.stderr
        old_pids = {
            service: _metadata_pid(run_dir / f"{service}.meta")
            for service in ("redis", "api", "worker", "web")
        }
        replacement_env = env | {
            "WMS_REDIS_PORT": "46380",
            "WMS_DEV_TEST_FAIL_STAGE": "redis",
        }

        replaced = _run_dev(replacement_env, "start")

        assert replaced.returncode != 0
        assert all(
            not (run_dir / f"{service}.meta").exists()
            for service in ("redis", "api", "worker", "web")
        )
        assert all(
            _wait_until(lambda pid=pid: not _process_is_running(pid))
            for pid in old_pids.values()
        )
        assert not (run_dir / "worker.ready").exists()
    finally:
        _run_dev(env, "stop")


def test_worker_without_current_ready_handshake_times_out_and_rolls_back(
    tmp_path: Path,
) -> None:
    bin_dir = _fake_runtime_tools(tmp_path)
    env = _dev_env(tmp_path, bin_dir)
    env["WMS_DEV_TEST_FAIL_STAGE"] = "worker-never-ready"
    run_dir = Path(env["WMS_DEV_RUN_DIR"])

    result = _run_dev(env, "start")

    try:
        assert result.returncode != 0
        assert "ready" in (result.stdout + result.stderr).lower()
        assert not list(run_dir.glob("*.meta"))
        assert not (run_dir / "worker.ready").exists()
    finally:
        _run_dev(env, "stop")


def test_invalid_restart_keeps_existing_owned_services_running(
    tmp_path: Path,
) -> None:
    bin_dir = _fake_runtime_tools(tmp_path)
    env = _dev_env(tmp_path, bin_dir)
    run_dir = Path(env["WMS_DEV_RUN_DIR"])

    try:
        started = _run_dev(env, "start")
        assert started.returncode == 0, started.stdout + started.stderr
        owned = {
            service: _metadata_pid(run_dir / f"{service}.meta")
            for service in ("redis", "api", "worker", "web")
        }
        events_before = _events(env)
        secret = "invalid-restart-secret"
        invalid_env = env | {"WMS_WORKER_TOKEN": secret}

        restarted = _run_dev(invalid_env, "restart")

        assert restarted.returncode != 0
        assert secret not in restarted.stdout
        assert secret not in restarted.stderr
        assert _events(env) == events_before
        assert all(
            _metadata_pid(run_dir / f"{service}.meta") == pid
            and _process_is_running(pid)
            for service, pid in owned.items()
        )
    finally:
        _run_dev(env, "stop")


@pytest.mark.parametrize("failed_stage", ["redis", "api", "worker", "web"])
def test_partial_start_rolls_back_only_new_owned_children_in_reverse_order(
    tmp_path: Path,
    failed_stage: str,
) -> None:
    bin_dir = _fake_runtime_tools(tmp_path)
    env = _dev_env(tmp_path, bin_dir)
    env["WMS_DEV_TEST_FAIL_STAGE"] = failed_stage
    run_dir = Path(env["WMS_DEV_RUN_DIR"])

    try:
        result = _run_dev(env, "start")
        assert result.returncode != 0
        assert not list(run_dir.glob("*.meta"))

        events = _events(env)
        stopped = [event for event in events if event.startswith("stop:")]
        expected = {
            "redis": [],
            "api": ["stop:api", "stop:redis"],
            "worker": ["stop:api", "stop:redis"],
            "web": ["stop:web", "stop:worker", "stop:api", "stop:redis"],
        }[failed_stage]
        assert stopped == expected
    finally:
        _run_dev(env, "stop")


def test_healthy_external_redis_has_no_metadata_and_survives_stop(
    tmp_path: Path,
) -> None:
    bin_dir = _fake_runtime_tools(tmp_path, fake_redis=False)
    env = _dev_env(tmp_path, bin_dir)
    external, redis_port = _start_redis_ping_server()
    env["WMS_REDIS_PORT"] = str(redis_port)

    def redis_ping() -> bool:
        try:
            with socket.create_connection(("127.0.0.1", redis_port), timeout=0.2) as client:
                client.sendall(b"*1\r\n$4\r\nPING\r\n")
                return client.recv(64).startswith(b"+PONG")
        except OSError:
            return False

    try:
        assert _wait_until(redis_ping)
        started = _run_dev(env, "start")
        assert started.returncode == 0, started.stdout + started.stderr
        assert not (Path(env["WMS_DEV_RUN_DIR"]) / "redis.meta").exists()

        stopped = _run_dev(env, "stop")
        assert stopped.returncode == 0, stopped.stdout + stopped.stderr
        assert external.poll() is None
        assert redis_ping()
    finally:
        _run_dev(env, "stop")
        if external.poll() is None:
            os.killpg(external.pid, signal.SIGTERM)
            external.wait(timeout=3)


@pytest.mark.parametrize("forged_field", ["pgid", "start_ticks", "marker"])
def test_stale_metadata_never_signals_a_reused_pid(
    tmp_path: Path,
    forged_field: str,
) -> None:
    bin_dir = _fake_runtime_tools(tmp_path)
    env = _dev_env(tmp_path, bin_dir)
    run_dir = Path(env["WMS_DEV_RUN_DIR"])
    run_dir.mkdir()
    marker = "actual-unrelated-process"
    unrelated_env = os.environ.copy()
    unrelated_env["WMS_DEV_SERVICE_MARKER"] = marker
    unrelated = subprocess.Popen(
        ["sleep", "30"],
        env=unrelated_env,
        start_new_session=True,
    )

    try:
        stat_fields = Path(f"/proc/{unrelated.pid}/stat").read_text(
            encoding="utf-8"
        ).rsplit(") ", 1)[1].split()
        metadata = {
            "pid": str(unrelated.pid),
            "pgid": str(os.getpgid(unrelated.pid)),
            "start_ticks": stat_fields[19],
            "marker": marker,
            "service": "api",
        }
        if forged_field in {"pgid", "start_ticks"}:
            metadata[forged_field] = str(int(metadata[forged_field]) + 1)
        else:
            metadata[forged_field] = "forged-marker"
        (run_dir / "api.meta").write_text(
            "\n".join([f"{key}={value}" for key, value in metadata.items()] + [""]),
            encoding="utf-8",
        )

        stopped = _run_dev(env, "stop")

        assert stopped.returncode == 0, stopped.stdout + stopped.stderr
        assert unrelated.poll() is None
        assert not (run_dir / "api.meta").exists()
    finally:
        if unrelated.poll() is None:
            os.killpg(unrelated.pid, signal.SIGTERM)
            unrelated.wait(timeout=3)


def test_stop_kills_marker_owned_group_member_after_leader_exits(
    tmp_path: Path,
) -> None:
    bin_dir = _fake_runtime_tools(tmp_path)
    env = _dev_env(tmp_path, bin_dir)
    run_dir = Path(env["WMS_DEV_RUN_DIR"])
    run_dir.mkdir()
    metadata = run_dir / "api.meta"
    marker = "owned-orphan-group-marker"
    leader, child_pid = _start_orphaned_owned_group(
        metadata,
        tmp_path / "orphan-child.pid",
        marker,
    )

    try:
        assert leader.poll() is not None
        assert _process_is_running(child_pid)

        stopped = _run_dev(env, "stop")

        assert stopped.returncode == 0, stopped.stdout + stopped.stderr
        assert _wait_until(lambda: not _process_is_running(child_pid))
        assert not metadata.exists()
    finally:
        if _process_is_running(child_pid):
            os.killpg(leader.pid, signal.SIGKILL)
            assert _wait_until(lambda: not _process_is_running(child_pid))


def test_status_preserves_orphaned_owned_group_for_subsequent_stop(
    tmp_path: Path,
) -> None:
    bin_dir = _fake_runtime_tools(tmp_path)
    env = _dev_env(tmp_path, bin_dir)
    run_dir = Path(env["WMS_DEV_RUN_DIR"])
    run_dir.mkdir()
    metadata = run_dir / "api.meta"
    leader, child_pid = _start_orphaned_owned_group(
        metadata,
        tmp_path / "status-orphan-child.pid",
        "status-orphan-group-marker",
    )

    try:
        status = _run_dev(env, "status")

        assert status.returncode != 0
        assert "orphaned owned process group" in status.stdout.lower()
        assert metadata.exists()
        assert _process_is_running(child_pid)

        stopped = _run_dev(env, "stop")

        assert stopped.returncode == 0, stopped.stdout + stopped.stderr
        assert _wait_until(lambda: not _process_is_running(child_pid))
        assert not metadata.exists()
    finally:
        if _process_is_running(child_pid):
            os.killpg(leader.pid, signal.SIGKILL)
            assert _wait_until(lambda: not _process_is_running(child_pid))


@pytest.mark.parametrize("corruption", ["service", "marker", "empty-pgid"])
def test_status_discards_unsafe_or_empty_orphan_metadata_without_signalling(
    tmp_path: Path,
    corruption: str,
) -> None:
    bin_dir = _fake_runtime_tools(tmp_path)
    env = _dev_env(tmp_path, bin_dir)
    run_dir = Path(env["WMS_DEV_RUN_DIR"])
    run_dir.mkdir()
    metadata = run_dir / "api.meta"
    leader, child_pid = _start_orphaned_owned_group(
        metadata,
        tmp_path / f"unsafe-{corruption}-child.pid",
        "actual-status-group-marker",
    )
    fields = _metadata_fields(metadata)
    if corruption == "service":
        fields["service"] = "worker"
    elif corruption == "marker":
        fields["marker"] = "forged-status-group-marker"
    else:
        fields["pid"] = fields["pgid"] = "99999999"
    metadata.write_text(
        "\n".join(f"{key}={value}" for key, value in fields.items()) + "\n",
        encoding="utf-8",
    )

    try:
        status = _run_dev(env, "status")

        assert status.returncode == 0, status.stdout + status.stderr
        assert "orphaned owned process group" not in status.stdout.lower()
        assert not metadata.exists()
        assert _process_is_running(child_pid)

        stopped = _run_dev(env, "stop")
        assert stopped.returncode == 0, stopped.stdout + stopped.stderr
        assert _process_is_running(child_pid)
    finally:
        if _process_is_running(child_pid):
            os.killpg(leader.pid, signal.SIGKILL)
            assert _wait_until(lambda: not _process_is_running(child_pid))


def test_failed_start_kills_marker_owned_group_member_after_leader_exits(
    tmp_path: Path,
) -> None:
    result, child_pid, metadata = _run_failed_owned_start_with_orphaned_child(
        tmp_path
    )

    try:
        assert result.returncode != 0
        assert _wait_until(lambda: not _process_is_running(child_pid))
        assert not metadata.exists()
    finally:
        if _process_is_running(child_pid):
            os.killpg(os.getpgid(child_pid), signal.SIGKILL)
            assert _wait_until(lambda: not _process_is_running(child_pid))


def test_failed_start_retains_metadata_when_owned_group_cannot_be_signalled(
    tmp_path: Path,
) -> None:
    result, child_pid, metadata = _run_failed_owned_start_with_orphaned_child(
        tmp_path,
        block_cleanup_signals=True,
    )

    try:
        assert result.returncode != 0
        assert _process_is_running(child_pid)
        assert metadata.exists()
        assert "ownership retained" in result.stderr
    finally:
        if _process_is_running(child_pid):
            os.killpg(os.getpgid(child_pid), signal.SIGKILL)
            assert _wait_until(lambda: not _process_is_running(child_pid))


def test_stop_retains_metadata_and_fails_when_owned_group_cannot_be_signalled(
    tmp_path: Path,
) -> None:
    bin_dir = _fake_runtime_tools(tmp_path)
    env = _dev_env(tmp_path, bin_dir)
    run_dir = Path(env["WMS_DEV_RUN_DIR"])
    run_dir.mkdir()
    metadata = run_dir / "api.meta"
    marker = "owned-unkillable-group-marker"
    process_env = os.environ.copy()
    process_env["WMS_DEV_SERVICE_MARKER"] = marker
    process = subprocess.Popen(
        ["sleep", "30"],
        env=process_env,
        start_new_session=True,
    )
    stat_fields = Path(f"/proc/{process.pid}/stat").read_text(
        encoding="utf-8"
    ).rsplit(") ", 1)[1].split()
    metadata.write_text(
        "\n".join(
            [
                f"pid={process.pid}",
                f"pgid={os.getpgid(process.pid)}",
                f"start_ticks={stat_fields[19]}",
                f"marker={marker}",
                "service=api",
                "config_fingerprint=unkillable-test",
                "",
            ]
        ),
        encoding="utf-8",
    )
    harness = """
    source "$1"
    kill() {
      if [ "$1" = "-0" ]; then
        builtin kill "$@"
      else
        return 1
      fi
    }
    export WMS_DEV_STOP_TIMEOUT_SECONDS=0.1
    export WMS_DEV_POLL_INTERVAL_SECONDS=0.02
    dev_stop_owned_service api API "$2"
    """

    try:
        stopped = subprocess.run(
            [
                "bash",
                "-c",
                textwrap.dedent(harness),
                "_",
                str(ROOT / "scripts" / "dev-runtime.sh"),
                str(metadata),
            ],
            cwd=ROOT,
            text=True,
            capture_output=True,
            timeout=3,
        )

        assert stopped.returncode != 0
        assert metadata.exists()
        assert process.poll() is None
        assert "ownership retained" in stopped.stderr
        assert "✓ API stopped" not in stopped.stdout
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=3)


@pytest.mark.parametrize("blocked_service", ["web", "worker"])
def test_stop_best_effort_cleans_the_unit_when_one_group_cannot_be_signalled(
    tmp_path: Path,
    blocked_service: str,
) -> None:
    bin_dir = _fake_runtime_tools(tmp_path)
    env = _dev_env(tmp_path, bin_dir)
    run_dir = Path(env["WMS_DEV_RUN_DIR"])
    started = _run_dev(env, "start")
    assert started.returncode == 0, started.stdout + started.stderr
    pids = {
        service: _metadata_pid(run_dir / f"{service}.meta")
        for service in ("redis", "api", "worker", "web")
    }
    blocked_pgid = int(
        _metadata_fields(run_dir / f"{blocked_service}.meta")["pgid"]
    )

    try:
        stopped = _run_dev_with_unsignallable_group(
            env,
            "stop",
            blocked_pgid,
        )

        assert stopped.returncode != 0
        assert (run_dir / f"{blocked_service}.meta").exists()
        assert _process_is_running(pids[blocked_service])
        for service in {"redis", "api", "worker", "web"} - {blocked_service}:
            assert not (run_dir / f"{service}.meta").exists()
            assert _wait_until(
                lambda pid=pids[service]: not _process_is_running(pid)
            )
        assert not (run_dir / "worker.ready").exists()
    finally:
        _run_dev(env, "stop")
        for pid in pids.values():
            if _process_is_running(pid):
                os.killpg(pid, signal.SIGKILL)
        assert _wait_until(
            lambda: all(not _process_is_running(pid) for pid in pids.values())
        )


def test_external_http_cannot_masquerade_as_the_owned_api_process(
    tmp_path: Path,
) -> None:
    bin_dir = _fake_runtime_tools(tmp_path, fake_http=False)
    env = _dev_env(tmp_path, bin_dir)
    env["WMS_DEV_TEST_FAIL_STAGE"] = "api-bind"
    external_api, api_port = _start_http_server()
    external_web, web_port = _start_http_server()
    env["WMS_API_PORT"] = str(api_port)
    env["WMS_WEB_PORT"] = str(web_port)

    def external_ready() -> bool:
        try:
            return (
                urllib.request.urlopen(
                    f"http://127.0.0.1:{api_port}/health", timeout=0.2
                ).status
                == 200
            )
        except OSError:
            return False

    try:
        assert _wait_until(external_ready)

        result = _run_dev(env, "start")

        assert result.returncode != 0
        assert external_api.poll() is None
        assert not list(Path(env["WMS_DEV_RUN_DIR"]).glob("*.meta"))
    finally:
        _run_dev(env, "stop")
        if external_api.poll() is None:
            os.killpg(external_api.pid, signal.SIGTERM)
            external_api.wait(timeout=3)
        if external_web.poll() is None:
            os.killpg(external_web.pid, signal.SIGTERM)
            external_web.wait(timeout=3)


def test_status_and_log_snapshot_cover_all_runtime_services(tmp_path: Path) -> None:
    bin_dir = _fake_runtime_tools(tmp_path)
    env = _dev_env(tmp_path, bin_dir)
    state = Path(env["WMS_DEV_TEST_STATE"])
    (state / "redis.ready").touch()

    status = _run_dev(env, "status")
    logs = _run_dev(env, "logs", "--no-follow")

    assert status.returncode == 0
    assert all(name in status.stdout for name in ("Redis", "API", "Worker", "Web"))
    assert "external" in status.stdout.lower()
    assert logs.returncode == 0
    assert all(name in logs.stdout for name in ("Redis", "API", "Worker", "Web"))


def test_backend_health_uses_the_runtime_web_origins_for_real_cors_headers(
    tmp_path: Path,
) -> None:
    origins = "http://127.0.0.1:43000,http://localhost:43000"
    code = """
import sys
from fastapi.testclient import TestClient
from main import app

client = TestClient(app)
for origin in sys.argv[1].split(","):
    response = client.get("/health", headers={"Origin": origin})
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == origin
blocked = client.get("/health", headers={"Origin": "https://blocked.example"})
assert "access-control-allow-origin" not in blocked.headers
"""
    env = {
        "PATH": os.environ["PATH"],
        "PYTHON_DOTENV_DISABLED": "1",
        "WMS_CORS_ORIGINS": origins,
        "WMS_DATABASE_URL": (
            f"sqlite+aiosqlite:///{tmp_path / 'cors.sqlite3'}"
        ),
        "WMS_DISABLE_SCHEDULER": "1",
        "WMS_WORKER_TOKEN": VALID_TOKEN,
        "FEEDGRAB_DATA_DIR": str(tmp_path / "sessions"),
        "WMS_LLM_API_KEY": "",
        "WMS_IMAGE_API_KEY": "",
        "WMS_SPEECH_API_KEY": "",
        "HEYGEN_API_KEY": "",
    }

    checked = subprocess.run(
        [sys.executable, "-c", code, origins],
        cwd=ROOT / "backend",
        env=env,
        text=True,
        capture_output=True,
    )

    assert checked.returncode == 0, checked.stdout + checked.stderr


def _compose_environment() -> dict[str, str]:
    allowed = (
        "PATH",
        "HOME",
        "DOCKER_HOST",
        "DOCKER_CONTEXT",
        "DOCKER_CONFIG",
        "XDG_CONFIG_HOME",
        "TMPDIR",
    )
    environment = {
        key: os.environ[key]
        for key in allowed
        if key in os.environ
    }
    environment["WMS_WORKER_TOKEN"] = VALID_TOKEN
    return environment


def test_compose_uses_real_api_health_and_healthy_dependencies(
    tmp_path: Path,
) -> None:
    empty_env = tmp_path / "empty.env"
    empty_env.write_text("# deliberately empty\n", encoding="utf-8")
    resolved = subprocess.run(
        [
            "docker",
            "compose",
            "--env-file",
            str(empty_env),
            "config",
            "--format",
            "json",
        ],
        cwd=ROOT,
        env=_compose_environment(),
        check=True,
        text=True,
        capture_output=True,
    )
    compose = json.loads(resolved.stdout)
    services = compose["services"]

    api_health = services["api"]["healthcheck"]["test"]
    assert "/health" in " ".join(api_health)
    assert services["api"]["environment"]["WMS_REDIS_URL"] == "redis://redis:6379/0"
    assert services["worker"]["environment"]["WMS_REDIS_URL"] == "redis://redis:6379/0"
    assert services["worker"]["depends_on"]["redis"]["condition"] == "service_healthy"
    assert services["worker"]["depends_on"]["api"]["condition"] == "service_healthy"
    assert services["web"]["depends_on"]["api"]["condition"] == "service_healthy"
    assert services["api"]["environment"]["WMS_SPEECH_API_KEY"] == ""
    assert services["worker"]["environment"]["WMS_LLM_API_KEY"] == ""
    for service_name in ("api", "worker"):
        command = services[service_name].get("command")
        assert command, f"{service_name} must validate WMS_WORKER_TOKEN before startup"
        command_text = " ".join(command)
        assert "WMS_WORKER_TOKEN" in command_text
        assert "at least 32" in command_text
        assert VALID_TOKEN not in command_text
