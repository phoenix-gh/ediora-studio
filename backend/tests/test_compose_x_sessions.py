import json
import subprocess


def test_api_uses_persistent_feedgrab_session_directory():
    resolved = subprocess.run(
        ["docker", "compose", "config", "--format", "json"],
        check=True,
        text=True,
        capture_output=True,
    )
    compose = json.loads(resolved.stdout)
    api = compose["services"]["api"]
    assert api["environment"]["FEEDGRAB_DATA_DIR"] == "/app/sessions"
    assert any(mount["target"] == "/app/sessions" for mount in api["volumes"])
    assert "sessions-data" in compose["volumes"]
