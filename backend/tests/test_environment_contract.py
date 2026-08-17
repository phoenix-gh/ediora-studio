import json
import os
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


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
    environment["WORKER_TOKEN"] = "environment-contract-worker-token-000000"
    return environment


def _compose_config(tmp_path: Path) -> dict:
    env_file = tmp_path / "compose.env"
    env_file.write_text("", encoding="utf-8")
    result = subprocess.run(
        [
            "docker",
            "compose",
            "--env-file",
            str(env_file),
            "config",
            "--format",
            "json",
        ],
        cwd=ROOT,
        env=_compose_environment(),
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_tracked_text_has_no_legacy_application_prefix():
    legacy_prefix = "".join(("W", "M", "S", "_"))
    result = subprocess.run(
        ["git", "grep", "-Il", legacy_prefix, "--"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 1, result.stdout


def test_compose_uses_internal_names_without_provider_credentials(tmp_path: Path):
    compose = _compose_config(tmp_path)
    services = compose["services"]

    assert services["api"]["environment"]["WORKER_TOKEN"]
    assert services["worker"]["environment"]["WORKER_TOKEN"]
    assert services["worker"]["environment"]["API_URL"] == "http://api:8000/api"
    assert services["web"]["environment"]["API_URL"] == "http://api:8000/api"

    provider_keys = {
        "LLM_API_KEY",
        "IMAGE_API_KEY",
        "SPEECH_API_KEY",
        "HEYGEN_API_KEY",
        "MIMO_API_KEY",
    }
    for service_name in ("api", "worker", "web"):
        assert provider_keys.isdisjoint(services[service_name]["environment"])
