import json
import subprocess

import pytest


def assert_x_session_contract(compose):
    api = compose["services"]["api"]
    volumes = api["volumes"]
    assert api["environment"]["FEEDGRAB_DATA_DIR"] == "/app/sessions"
    assert any(
        mount.get("type") == "volume"
        and mount.get("source") == "sessions-data"
        and mount.get("target") == "/app/sessions"
        for mount in volumes
    )
    assert any(
        mount.get("type") == "volume"
        and mount.get("source") == "uploads-data"
        and mount.get("target") == "/app/uploads"
        for mount in volumes
    )
    assert "sessions-data" in compose["volumes"]
    assert "uploads-data" in compose["volumes"]


def test_api_uses_persistent_feedgrab_session_directory():
    resolved = subprocess.run(
        ["docker", "compose", "config", "--format", "json"],
        check=True,
        text=True,
        capture_output=True,
    )
    compose = json.loads(resolved.stdout)
    assert_x_session_contract(compose)


def test_built_api_image_can_import_application():
    result = subprocess.run(
        [
            "docker",
            "compose",
            "run",
            "--rm",
            "--no-deps",
            "api",
            "python",
            "-c",
            "import main",
        ],
        text=True,
        capture_output=True,
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
