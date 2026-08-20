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
    api = config["services"]["api"]

    assert api["environment"]["LOCAL_ASR_URL"] == "http://local-asr:8000/v1"
    assert api["environment"]["LOCAL_ASR_MODEL"] == "Systran/faster-whisper-large-v3"
    assert api["environment"]["LOCAL_ASR_DEVICE"] == "cuda"
    assert api["environment"]["LOCAL_ASR_COMPUTE_TYPE"] == "float16"
    assert "local-asr" not in api["depends_on"]


def test_app_services_share_one_image_and_api_owns_root_build():
    config = _compose_config({"NEXT_PUBLIC_DEVELOPER_MODE": "1"})
    api = config["services"]["api"]
    worker = config["services"]["worker"]
    web = config["services"]["web"]

    assert api["image"] == worker["image"] == web["image"]
    assert api["build"]["context"] == str(REPOSITORY_ROOT)
    assert api["build"]["dockerfile"] == "Dockerfile"
    assert api["build"]["args"]["NEXT_PUBLIC_API_URL"] == (
        "http://localhost:8000/api"
    )
    assert "NEXT_PUBLIC_DEVELOPER_MODE" not in api["build"]["args"]
    assert "build" not in worker
    assert "build" not in web
    assert worker["working_dir"] == "/app/web"
    assert web["working_dir"] == "/app/web"
    assert web["environment"]["DEVELOPER_MODE"] == "1"
    assert "NEXT_PUBLIC_DEVELOPER_MODE" not in web["environment"]
    assert web["command"] == [
        "./node_modules/.bin/next",
        "start",
        "--hostname",
        "0.0.0.0",
        "--port",
        "3000",
    ]


def test_host_ports_can_be_overridden_without_changing_container_ports():
    config = _compose_config(
        {
            "API_PORT": "28000",
            "WEB_PORT": "23000",
        }
    )

    assert config["services"]["api"]["ports"] == [
        {
            "mode": "ingress",
            "target": 8000,
            "published": "28000",
            "protocol": "tcp",
        }
    ]
    assert config["services"]["web"]["ports"] == [
        {
            "mode": "ingress",
            "target": 3000,
            "published": "23000",
            "protocol": "tcp",
        }
    ]
