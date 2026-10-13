import json
import os
import subprocess
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


def _compose_config(environment: dict[str, str] | None = None) -> dict:
    compose_environment = os.environ.copy()
    if environment:
        compose_environment.update(environment)
    completed = subprocess.run(
        [
            "docker",
            "compose",
            "--profile",
            "local-asr",
            "config",
            "--format",
            "json",
        ],
        cwd=REPOSITORY_ROOT,
        check=True,
        capture_output=True,
        text=True,
        env=compose_environment,
    )
    return json.loads(completed.stdout)


def test_local_asr_is_private_gpu_service_with_persistent_model_cache():
    config = _compose_config()
    service = config["services"]["local-asr"]

    assert service["image"] == "ghcr.io/speaches-ai/speaches:0.8.3-cuda"
    assert service["profiles"] == ["local-asr"]
    assert not service.get("ports")
    assert service["environment"]["WHISPER__INFERENCE_DEVICE"] == "cuda"
    assert service["environment"]["WHISPER__COMPUTE_TYPE"] == "float16"
    assert service["deploy"]["resources"]["reservations"]["devices"] == [
        {
            "capabilities": ["gpu"],
            "count": 1,
            "driver": "nvidia",
        }
    ]
    assert any(
        mount["type"] == "bind"
        and mount["source"] == str(
            (REPOSITORY_ROOT / "data/local-asr-models").resolve()
        )
        and mount["target"] == "/home/ubuntu/.cache/huggingface/hub"
        for mount in service["volumes"]
    )


def test_api_uses_local_asr_without_blocking_api_startup():
    config = _compose_config()
    app = config["services"]["app"]

    assert app["environment"]["LOCAL_ASR_URL"] == "http://local-asr:8000/v1"
    assert app["environment"]["LOCAL_ASR_MODEL"] == "Systran/faster-whisper-large-v3"
    assert app["environment"]["LOCAL_ASR_DEVICE"] == "cuda"
    assert app["environment"]["LOCAL_ASR_COMPUTE_TYPE"] == "float16"
    assert "local-asr" not in app["depends_on"]


def test_all_compose_services_restart_after_docker_daemon_restart():
    config = _compose_config()

    for service_name, service in config["services"].items():
        assert service.get("restart") == "unless-stopped", (
            f"{service_name} must restart automatically after a Docker daemon restart"
        )


def test_app_service_runs_api_worker_web_and_one_codex_server():
    config = _compose_config({"NEXT_PUBLIC_DEVELOPER_MODE": "1"})
    app = config["services"]["app"]

    assert app["build"]["context"] == str(REPOSITORY_ROOT)
    assert app["build"]["dockerfile"] == "Dockerfile"
    assert app["build"]["args"]["NEXT_PUBLIC_API_URL"] == (
        "http://localhost:8000/api"
    )
    assert "NEXT_PUBLIC_DEVELOPER_MODE" not in app["build"]["args"]
    assert app["environment"]["DEVELOPER_MODE"] == "1"
    assert "NEXT_PUBLIC_DEVELOPER_MODE" not in app["environment"]
    assert app["user"] == (
        f"{os.environ.get('HOST_UID', '1000')}:{os.environ.get('HOST_GID', '1000')}"
    )
    assert app["environment"]["HOME"] == "/tmp"
    assert app["environment"]["CODEX_HOME"] == "/codex-home"
    assert "CODEX_APP_SERVER_SOCKET" not in app["environment"]
    assert app["command"] == ["bash", "/app/scripts/app-container.sh"]
    script = (REPOSITORY_ROOT / "scripts" / "app-container.sh").read_text(
        encoding="utf-8"
    )
    assert 'codex_listen="ws://127.0.0.1:4500"' in script
    assert "CODEX_APP_SERVER_SOCKET" not in script
    assert "unix://" not in script


def test_host_ports_can_be_overridden_without_changing_container_ports():
    config = _compose_config(
        {
            "API_PORT": "28000",
            "WEB_PORT": "23000",
        }
    )

    published = {
        (item["target"], item["published"])
        for item in config["services"]["app"]["ports"]
    }
    assert published == {(8000, "28000"), (3000, "23000")}
