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


def test_installed_patcher_redacts_nested_extra_and_non_string_values():
    class LeakyValue:
        def __repr__(self):
            return "LeakyValue(auth_token=object-auth-secret)"

    nested = {
        "auth_token": "extra-auth-secret",
        "metadata": {
            "ct0": "extra-csrf-secret",
            "telegram": (
                "https://api.telegram.org/"
                "bot123:extra-telegram-secret/sendMessage"
            ),
            "opaque": LeakyValue(),
        },
    }
    nested["self"] = nested
    output = StringIO()
    sink_id = logger.add(
        output,
        format="{message} | {extra}",
        backtrace=False,
        diagnose=False,
    )
    try:
        install_log_redaction()
        logger.bind(payload=nested, attempt=3).info("structured context")
    finally:
        logger.remove(sink_id)
        logger.configure(patcher=None)

    rendered = output.getvalue()
    assert "structured context" in rendered
    assert "attempt" in rendered
    for secret in (
        "extra-auth-secret",
        "extra-csrf-secret",
        "extra-telegram-secret",
        "object-auth-secret",
    ):
        assert secret not in rendered


def test_installed_patcher_redacts_rendered_exception_and_keeps_context():
    output = StringIO()
    sink_id = logger.add(
        output,
        format="{message} | {extra}",
        backtrace=False,
        diagnose=False,
    )
    try:
        install_log_redaction()
        try:
            raise RuntimeError(
                "request 42 failed: auth_token=exception-auth-secret "
                "ct0: exception-csrf-secret "
                "https://api.telegram.org/"
                "bot123:exception-telegram-secret/sendMessage"
            )
        except RuntimeError:
            logger.exception("credential probe failed")
    finally:
        logger.remove(sink_id)
        logger.configure(patcher=None)

    rendered = output.getvalue()
    assert "credential probe failed" in rendered
    assert "RuntimeError" in rendered
    assert "request 42 failed" in rendered
    for secret in (
        "exception-auth-secret",
        "exception-csrf-secret",
        "exception-telegram-secret",
    ):
        assert secret not in rendered


def test_installed_patcher_redacts_nested_exception_group_children():
    output = StringIO()
    sink_id = logger.add(
        output,
        format="{message} | {extra}",
        backtrace=False,
        diagnose=False,
    )
    try:
        install_log_redaction()
        nested = ExceptionGroup(
            "public nested credential checks",
            [
                RuntimeError(
                    "account A failed: auth_token=group-auth-secret"
                ),
                ValueError("account B failed: ct0: group-csrf-secret"),
            ],
        )
        group = ExceptionGroup(
            "public credential batch 42",
            [
                nested,
                OSError(
                    "notifier failed: https://api.telegram.org/"
                    "bot123:group-telegram-secret/sendMessage"
                ),
            ],
        )
        assert isinstance(group, BaseExceptionGroup)
        try:
            raise group
        except ExceptionGroup:
            logger.exception("credential group probe failed")
    finally:
        logger.remove(sink_id)
        logger.configure(patcher=None)

    rendered = output.getvalue()
    assert "credential group probe failed" in rendered
    assert "ExceptionGroup" in rendered
    assert "public credential batch 42" in rendered
    assert "public nested credential checks" in rendered
    assert "account A failed" in rendered
    assert "account B failed" in rendered
    assert "notifier failed" in rendered
    for secret in (
        "group-auth-secret",
        "group-csrf-secret",
        "group-telegram-secret",
    ):
        assert secret not in rendered


def test_main_installs_redaction_before_optional_feedgrab_import(
    tmp_path,
    postgres_database_url,
):
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
        "DATABASE_URL": postgres_database_url,
        "DISABLE_SCHEDULER": "1",
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
    assert result.stdout.strip() == "Ediora API"
    for secret in (
        "import-auth-secret",
        "import-csrf-secret",
        "import-telegram-secret",
    ):
        assert secret not in result.stderr
    assert "auth_token=***" in result.stderr
    assert "ct0=***" in result.stderr


def test_main_default_handler_does_not_render_diagnose_locals(
    tmp_path,
    postgres_database_url,
):
    backend_dir = Path(__file__).resolve().parents[1]
    probe_script = tmp_path / "diagnose_probe.py"
    probe_script.write_text(
        "from loguru import logger\n"
        "import main\n"
        "handler = next(iter(logger._core.handlers.values()))\n"
        "assert handler._exception_formatter._diagnose is False\n"
        "assert handler._exception_formatter._backtrace is False\n"
        "def fail_with_local():\n"
        "    local_payload = {\n"
        "        'auth_token': 'diagnose-' + 'auth-secret',\n"
        "        'ct0': 'diagnose-' + 'csrf-secret',\n"
        "        'telegram': 'https://api.telegram.org/bot123:'"
        " + 'diagnose-telegram-secret/sendMessage',\n"
        "    }\n"
        "    raise RuntimeError('useful public failure context')\n"
        "try:\n"
        "    fail_with_local()\n"
        "except RuntimeError:\n"
        "    logger.exception('diagnose safety probe')\n"
    )
    env = os.environ.copy()
    env.update({
        "PYTHONPATH": str(backend_dir),
        "DATABASE_URL": postgres_database_url,
        "DISABLE_SCHEDULER": "1",
    })

    result = subprocess.run(
        [sys.executable, str(probe_script)],
        cwd=backend_dir,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "diagnose safety probe" in result.stderr
    assert "RuntimeError" in result.stderr
    assert "useful public failure context" in result.stderr
    for secret in (
        "diagnose-auth-secret",
        "diagnose-csrf-secret",
        "diagnose-telegram-secret",
    ):
        assert secret not in result.stderr
