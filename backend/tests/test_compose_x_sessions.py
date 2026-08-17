import json
import os
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
VALID_TOKEN = "compose-runtime-worker-token-000000000000"


def _compose_environment() -> dict[str, str]:
    allowed = (
        "PATH",
        "HOME",
        "DOCKER_HOST",
        "DOCKER_CONFIG",
        "XDG_CONFIG_HOME",
        "XDG_RUNTIME_DIR",
        "TMPDIR",
    )
    environment = {key: os.environ[key] for key in allowed if key in os.environ}
    environment.update(
        {
            "WORKER_TOKEN": VALID_TOKEN,
        }
    )
    return environment


def _run_compose(
    tmp_path: Path,
    *arguments: str,
) -> subprocess.CompletedProcess[str]:
    empty_env = tmp_path / "compose.env"
    empty_env.write_text("", encoding="utf-8")
    return subprocess.run(
        [
            "docker",
            "compose",
            "--env-file",
            str(empty_env),
            *arguments,
        ],
        cwd=ROOT,
        env=_compose_environment(),
        text=True,
        capture_output=True,
    )


def assert_x_session_contract(compose):
    api = compose["services"]["api"]
    api_volumes = api["volumes"]
    assert api.get("environment", {}).get("FEEDGRAB_DATA_DIR") == "/app/sessions"
    assert api.get("environment", {}).get("SCHEDULER_STATE_FILE") == (
        "/app/.runtime/scheduler_state.json"
    )

    def assert_bind_mount(mounts, relative_source: str, target: str):
        expected_source = str((ROOT / relative_source).resolve())
        assert any(
            mount.get("type") == "bind"
            and mount.get("source") == expected_source
            and mount.get("target") == target
            for mount in mounts
        )

    for source, target in (
        ("data/uploads", "/app/uploads"),
        ("data/sessions", "/app/sessions"),
        ("data/avatars", "/app/avatars"),
        ("data/wechat-images", "/app/wechat_imgs"),
        ("data/scheduler", "/app/.runtime"),
    ):
        assert_bind_mount(api_volumes, source, target)

    assert_bind_mount(
        compose["services"]["web"]["volumes"],
        "data/web-runtime",
        "/app/web/.runtime",
    )
    assert_bind_mount(
        compose["services"]["postgres"]["volumes"],
        "data/postgres",
        "/var/lib/postgresql/data",
    )
    assert_bind_mount(
        compose["services"]["redis"]["volumes"],
        "data/redis",
        "/data",
    )
    assert not compose.get("volumes")


def test_api_uses_persistent_feedgrab_session_directory(tmp_path: Path):
    resolved = _run_compose(
        tmp_path,
        "config",
        "--format",
        "json",
    )
    assert resolved.returncode == 0, resolved.stderr
    compose = json.loads(resolved.stdout)
    assert_x_session_contract(compose)


def test_built_api_image_can_import_application(tmp_path: Path):
    result = _run_compose(
        tmp_path,
        "run",
        "--rm",
        "--no-deps",
        "api",
        "python",
        "-c",
        "import main",
    )

    assert result.returncode == 0, result.stderr


def test_built_api_image_can_import_feedgrab_x_runtime(tmp_path: Path):
    result = _run_compose(
        tmp_path,
        "run",
        "--rm",
        "--no-deps",
        "api",
        "python",
        "-c",
        (
            "from feedgrab.fetchers.twitter_cookies "
            "import load_twitter_cookies; "
            "from feedgrab.fetchers.twitter_keyword_search "
            "import search_twitter_keyword; "
            "assert callable(load_twitter_cookies); "
            "assert callable(search_twitter_keyword)"
        ),
    )

    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize(
    "volumes",
    [
        [
            {"type": "volume", "source": "uploads-data", "target": "/app/uploads"},
            {"type": "volume", "source": "uploads-data", "target": "/app/sessions"},
        ],
        [
            {"type": "volume", "source": "uploads-data", "target": "/app/uploads"},
            {"type": "bind", "source": "/tmp/sessions", "target": "/app/sessions"},
        ],
        [
            {"type": "bind", "source": "/tmp/uploads", "target": "/app/uploads"},
            {"type": "volume", "source": "sessions-data", "target": "/app/sessions"},
        ],
    ],
)
def test_x_session_contract_rejects_wrong_named_volume_wiring(volumes):
    compose = {
        "services": {
            "api": {
                "environment": {"FEEDGRAB_DATA_DIR": "/app/sessions"},
                "volumes": volumes,
            },
        },
        "volumes": {"sessions-data": {}, "uploads-data": {}},
    }

    with pytest.raises(AssertionError):
        assert_x_session_contract(compose)
