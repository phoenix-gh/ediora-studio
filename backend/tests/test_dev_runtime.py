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


def _unused_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


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
        printf '%s|%s|%s|%s\n' \
          "$WMS_REDIS_URL" "$WMS_WORKER_QUEUE" "$token_hash" "$WMS_API_URL" \
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
            printf '%s|%s|%s|%s\n' \
              "$WMS_REDIS_URL" "$WMS_WORKER_QUEUE" "$token_hash" "$WMS_API_URL" \
              >"$WMS_DEV_TEST_STATE/worker.env"
            if [ "${WMS_DEV_TEST_FAIL_STAGE:-}" = worker ]; then
              exit 17
            fi
            trap 'printf "stop:worker\\n" >>"$WMS_DEV_TEST_STATE/events"; exit 0' TERM INT
            while :; do sleep 1; done
            ;;
          *)
            printf 'start:web\n' >>"$WMS_DEV_TEST_STATE/events"
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
            "WMS_DEV_WORKER_SETTLE_SECONDS": "0.05",
            "WMS_DEV_HTTP_SETTLE_SECONDS": "0.2",
            "WMS_REDIS_PORT": str(_unused_port()),
            "WMS_API_PORT": str(_unused_port()),
            "WMS_WEB_PORT": str(_unused_port()),
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


def _events(env: dict[str, str]) -> list[str]:
    path = Path(env["WMS_DEV_TEST_STATE"]) / "events"
    return path.read_text(encoding="utf-8").splitlines() if path.exists() else []


def _metadata_pid(path: Path) -> int:
    fields = dict(
        line.split("=", 1)
        for line in path.read_text(encoding="utf-8").splitlines()
        if "=" in line
    )
    return int(fields["pid"])


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


def _start_http_server(port: int) -> subprocess.Popen[str]:
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

with socketserver.TCPServer(("127.0.0.1", int(sys.argv[1])), Handler) as server:
    server.serve_forever()
"""
    return subprocess.Popen(
        [sys.executable, "-u", "-c", code, str(port)],
        text=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


def _start_redis_ping_server(port: int) -> subprocess.Popen[str]:
    code = """
import socketserver
import sys

class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.recv(1024)
        self.request.sendall(b"+PONG\\r\\n")

with socketserver.ThreadingTCPServer(("127.0.0.1", int(sys.argv[1])), Handler) as server:
    server.serve_forever()
"""
    return subprocess.Popen(
        [sys.executable, "-u", "-c", code, str(port)],
        text=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


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
        assert launch_events.index("start:worker") < launch_events.index("start:web")
        assert launch_events.index("start:web") < launch_events.index("ready:web")
        expected_environment = "|".join(
            [
                f"redis://127.0.0.1:{env['WMS_REDIS_PORT']}/0",
                "content-jobs",
                hashlib.sha256(VALID_TOKEN.encode()).hexdigest(),
                f"http://127.0.0.1:{env['WMS_API_PORT']}/api",
            ]
        )
        state = Path(env["WMS_DEV_TEST_STATE"])
        assert (state / "api.env").read_text(encoding="utf-8").strip() == expected_environment
        assert (state / "worker.env").read_text(encoding="utf-8").strip() == expected_environment

        metadata = [run_dir / f"{service}.meta" for service in ("redis", "api", "worker", "web")]
        assert all(path.exists() for path in metadata)
        owned_pids = [_metadata_pid(path) for path in metadata]

        stopped = _run_dev(env, "stop")
        assert stopped.returncode == 0, stopped.stdout + stopped.stderr
        assert all(not path.exists() for path in metadata)
        assert _wait_until(lambda: all(not _process_is_running(pid) for pid in owned_pids))

        stopped_events = _events(env)
        assert stopped_events.index("stop:web") < stopped_events.index("stop:worker")
        assert stopped_events.index("stop:worker") < stopped_events.index("stop:api")
        assert stopped_events.index("stop:api") < stopped_events.index("stop:redis")
    finally:
        _run_dev(env, "stop")


def test_start_replaces_owned_api_when_worker_would_use_a_new_token(
    tmp_path: Path,
) -> None:
    bin_dir = _fake_runtime_tools(tmp_path)
    env = _dev_env(tmp_path, bin_dir)
    run_dir = Path(env["WMS_DEV_RUN_DIR"])
    state = Path(env["WMS_DEV_TEST_STATE"])

    try:
        first = _run_dev(env, "start")
        assert first.returncode == 0, first.stdout + first.stderr
        old_api_pid = _metadata_pid(run_dir / "api.meta")
        worker_pid = _metadata_pid(run_dir / "worker.meta")
        os.killpg(worker_pid, signal.SIGTERM)
        assert _wait_until(lambda: not _process_is_running(worker_pid))

        replacement_token = "replacement-worker-token-0000000000000000"
        replacement_env = env | {"WMS_WORKER_TOKEN": replacement_token}
        second = _run_dev(replacement_env, "start")

        assert second.returncode == 0, second.stdout + second.stderr
        assert _metadata_pid(run_dir / "api.meta") != old_api_pid
        expected_hash = hashlib.sha256(replacement_token.encode()).hexdigest()
        assert f"|{expected_hash}|" in (state / "api.env").read_text(encoding="utf-8")
        assert f"|{expected_hash}|" in (state / "worker.env").read_text(
            encoding="utf-8"
        )
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
    redis_port = int(env["WMS_REDIS_PORT"])
    external = _start_redis_ping_server(redis_port)

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


def test_external_http_cannot_masquerade_as_the_owned_api_process(
    tmp_path: Path,
) -> None:
    bin_dir = _fake_runtime_tools(tmp_path, fake_http=False)
    env = _dev_env(tmp_path, bin_dir)
    env["WMS_DEV_TEST_FAIL_STAGE"] = "api-bind"
    api_port = int(env["WMS_API_PORT"])
    web_port = int(env["WMS_WEB_PORT"])
    external_api = _start_http_server(api_port)
    external_web = _start_http_server(web_port)

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


def test_compose_uses_real_api_health_and_healthy_dependencies() -> None:
    env = os.environ.copy()
    env["WMS_WORKER_TOKEN"] = VALID_TOKEN
    resolved = subprocess.run(
        ["docker", "compose", "config", "--format", "json"],
        cwd=ROOT,
        env=env,
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

    for service_name in ("api", "worker"):
        command = services[service_name].get("command")
        assert command, f"{service_name} must validate WMS_WORKER_TOKEN before startup"
        short_env = env | {"WMS_WORKER_TOKEN": "short-compose-secret"}
        rejected = subprocess.run(
            command,
            cwd=ROOT / ("backend" if service_name == "api" else "wemedia-studio"),
            env=short_env,
            text=True,
            capture_output=True,
        )
        assert rejected.returncode != 0
        assert "at least 32" in rejected.stderr
        assert short_env["WMS_WORKER_TOKEN"] not in rejected.stderr
