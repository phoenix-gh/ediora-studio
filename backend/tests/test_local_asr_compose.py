import json
import subprocess
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


def _compose_config() -> dict:
    completed = subprocess.run(
        ["docker", "compose", "config", "--format", "json"],
        cwd=REPOSITORY_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


def test_local_asr_is_private_gpu_service_with_persistent_model_cache():
    config = _compose_config()
    service = config["services"]["local-asr"]

    assert service["image"] == "ghcr.io/speaches-ai/speaches:0.8.3-cuda"
    assert not service.get("ports")
    assert service["deploy"]["resources"]["reservations"]["devices"] == [
        {
            "capabilities": ["gpu"],
            "count": 1,
            "driver": "nvidia",
        }
    ]
    assert any(
        mount["type"] == "volume"
        and mount["target"] == "/home/ubuntu/.cache/huggingface/hub"
        for mount in service["volumes"]
    )


def test_api_uses_local_asr_without_blocking_api_startup():
    config = _compose_config()
    api = config["services"]["api"]

    assert api["environment"]["WMS_LOCAL_ASR_URL"] == "http://local-asr:8000/v1"
    assert api["environment"]["WMS_LOCAL_ASR_MODEL"] == "Systran/faster-whisper-large-v3"
    assert api["environment"]["WMS_LOCAL_ASR_DEVICE"] == "cuda"
    assert api["environment"]["WMS_LOCAL_ASR_COMPUTE_TYPE"] == "int8_float16"
    assert "local-asr" not in api["depends_on"]
