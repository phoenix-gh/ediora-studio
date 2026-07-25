import os
import subprocess
import sys
from io import StringIO
from pathlib import Path

from loguru import logger

from log_redaction import install_log_redaction, redact_secret_text


def test_redacts_full_and_prefixed_credentials():
    text = (
        "auth_token=abcdefgh123456 ct0: csrf-secret "
        "https://api.telegram.org/bot123456:ABC-secret/sendMessage"
    )

    redacted = redact_secret_text(text)

    assert "abcdefgh123456" not in redacted
    assert "csrf-secret" not in redacted
    assert "123456:ABC-secret" not in redacted
    assert "auth_token=***" in redacted
    assert "ct0: ***" in redacted
    assert "api.telegram.org/bot***/sendMessage" in redacted


def test_redaction_stops_at_credential_delimiters():
    text = (
        "auth_token=first-token; next=value, ct0=csrf-token "
        "auth_token: second-token"
    )

    assert redact_secret_text(text) == (
        "auth_token=***; next=value, ct0=*** auth_token: ***"
    )


def test_installed_loguru_patcher_redacts_message_without_echoing_secrets():
    output = StringIO()
    sink_id = logger.add(output, format="{message}")
    try:
        install_log_redaction()
        logger.info(
            "auth_token={} ct0={} {}",
            "runtime-auth-secret",
            "runtime-csrf-secret",
            "https://api.telegram.org/bot123:runtime-telegram-secret/sendMessage",
        )
    finally:
        logger.remove(sink_id)
        logger.configure(patcher=None)

    rendered = output.getvalue()
    assert "runtime-auth-secret" not in rendered
    assert "runtime-csrf-secret" not in rendered
    assert "runtime-telegram-secret" not in rendered
    assert "auth_token=***" in rendered
    assert "ct0=***" in rendered


def test_main_installs_redaction_before_optional_feedgrab_import(tmp_path):
    fake_root = tmp_path / "fake-dependency"
    feedgrab_package = fake_root / "feedgrab"
    feedgrab_package.mkdir(parents=True)
    (feedgrab_package / "__init__.py").write_text(
        "from loguru import logger\n"
        "logger.warning("
        "'auth_token=import-auth-secret ct0=import-csrf-secret "
        "https://api.telegram.org/bot123:import-telegram-secret/sendMessage'"
        ")\n"
    )
    backend_dir = Path(__file__).resolve().parents[1]
    env = os.environ.copy()
    env.update({
        "PYTHONPATH": os.pathsep.join((str(fake_root), str(backend_dir))),
        "WMS_DATABASE_URL": f"sqlite+aiosqlite:///{tmp_path / 'optional.db'}",
        "WMS_DISABLE_SCHEDULER": "1",
    })

    result = subprocess.run(
        [sys.executable, "-c", "import main; print(main.app.title)"],
        cwd=backend_dir,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "WeMedia Studio API"
    for secret in (
        "import-auth-secret",
        "import-csrf-secret",
        "import-telegram-secret",
    ):
        assert secret not in result.stderr
    assert "auth_token=***" in result.stderr
    assert "ct0=***" in result.stderr
