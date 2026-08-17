import json
import stat

import pytest

from models import XCredentialAccount
from x_credential_store import CredentialFileError, CredentialFileStore, CredentialPair


def test_session_vault_round_trips_without_exposing_credentials(monkeypatch):
    from cryptography.fernet import Fernet
    from x_credential_store import CredentialSessionVault

    monkeypatch.setenv("X_SESSION_KEY", Fernet.generate_key().decode())
    pair = CredentialPair("auth-token-secret", "csrf-token-secret")

    ciphertext = CredentialSessionVault().encrypt(pair)

    assert "auth-token-secret" not in ciphertext
    assert "csrf-token-secret" not in ciphertext
    restored = CredentialSessionVault().decrypt(ciphertext)
    assert (restored.auth_token, restored.ct0) == (pair.auth_token, pair.ct0)


def test_x_account_model_has_encrypted_session_storage():
    assert "session_ciphertext" in XCredentialAccount.__table__.columns


def test_allocate_slot_skips_database_and_external_files(tmp_path):
    (tmp_path / "x_1.json").write_text('{"auth_token":"external","ct0":"csrf"}')
    store = CredentialFileStore(tmp_path)

    assert store.allocate_slot({2, 4}) == 3


def test_model_never_has_raw_credential_columns():
    columns = XCredentialAccount.__table__.columns.keys()

    assert "auth_token" not in columns
    assert "ct0" not in columns
    assert {
        "name", "enabled", "credential_slot",
        "auth_token_preview", "ct0_preview",
        "test_status", "last_tested_at", "last_test_error",
    }.issubset(columns)


def test_write_disable_restore_and_delete_are_reversible(tmp_path):
    store = CredentialFileStore(tmp_path)
    original = CredentialPair("token-a", "ct0-a")
    snapshot = store.write(3, True, original)

    active = tmp_path / "x_3.json"
    assert json.loads(active.read_text()) == {
        "auth_token": "token-a",
        "ct0": "ct0-a",
    }
    assert stat.S_IMODE(active.stat().st_mode) == 0o600
    assert stat.S_IMODE(tmp_path.stat().st_mode) == 0o700

    disable_snapshot = store.set_enabled(3, False)
    assert not active.exists()
    assert (tmp_path / "x_3.disabled.json").exists()

    store.restore(disable_snapshot)
    assert active.exists()
    assert not (tmp_path / "x_3.disabled.json").exists()

    delete_snapshot = store.delete(3)
    assert not active.exists()
    store.restore(delete_snapshot)
    assert store.read(3) == original
    assert snapshot.active is None


def test_external_files_are_reported_but_untouched(tmp_path):
    external = tmp_path / "twitter.json"
    external.write_text('{"cookies":[]}')
    store = CredentialFileStore(tmp_path)

    assert store.external_sessions(set()) == ["twitter.json"]
    store.write(2, True, CredentialPair("managed", "csrf"))
    assert external.read_text() == '{"cookies":[]}'


@pytest.mark.parametrize("payload", ["[]", "null"])
def test_read_rejects_non_object_json_as_invalid_credential_file(tmp_path, payload):
    credential = tmp_path / "x_3.json"
    credential.write_text(payload)

    with pytest.raises(CredentialFileError, match="托管凭据文件格式无效"):
        CredentialFileStore(tmp_path).read(3)


def test_write_removes_old_state_before_exposing_new_state(tmp_path, monkeypatch):
    store = CredentialFileStore(tmp_path)
    store.write(3, True, CredentialPair("old-token", "old-ct0"))
    active = tmp_path / "x_3.json"
    disabled = tmp_path / "x_3.disabled.json"
    original_unlink = type(active).unlink

    def unlink_without_dual_state(path, *args, **kwargs):
        if path == active:
            assert not disabled.exists()
        return original_unlink(path, *args, **kwargs)

    monkeypatch.setattr(type(active), "unlink", unlink_without_dual_state)

    store.write(3, False, CredentialPair("new-token", "new-ct0"))

    assert store.read(3) == CredentialPair("new-token", "new-ct0")


def test_delete_restores_snapshot_when_later_removal_fails(tmp_path, monkeypatch):
    store = CredentialFileStore(tmp_path)
    active = tmp_path / "x_3.json"
    disabled = tmp_path / "x_3.disabled.json"
    active.write_text('{"auth_token":"active","ct0":"csrf"}')
    disabled.write_text('{"auth_token":"disabled","ct0":"csrf"}')
    previous = store.snapshot(3)
    original_unlink = type(active).unlink
    failed = False

    def fail_once_for_disabled(path, *args, **kwargs):
        nonlocal failed
        if path == disabled and not failed:
            failed = True
            raise OSError("simulated second removal failure")
        return original_unlink(path, *args, **kwargs)

    monkeypatch.setattr(type(active), "unlink", fail_once_for_disabled)

    with pytest.raises(OSError, match="simulated second removal failure"):
        store.delete(3)

    assert store.snapshot(3) == previous


@pytest.mark.parametrize(
    ("operation", "filename"),
    [
        ("enable", "x_3.disabled.json"),
        ("disable", "x_3.json"),
        ("delete", "x_3.json"),
    ],
)
def test_non_write_lifecycle_operations_repair_directory_mode(tmp_path, operation, filename):
    store = CredentialFileStore(tmp_path)
    credential = tmp_path / filename
    credential.write_text('{"auth_token":"token","ct0":"csrf"}')
    credential.chmod(0o600)
    tmp_path.chmod(0o755)

    if operation == "enable":
        store.set_enabled(3, True)
    elif operation == "disable":
        store.set_enabled(3, False)
    else:
        store.delete(3)

    assert stat.S_IMODE(tmp_path.stat().st_mode) == 0o700


def test_quarantine_is_hidden_until_finalized_or_restored(tmp_path):
    store = CredentialFileStore(tmp_path)
    pair = CredentialPair("token", "csrf")
    store.write(3, True, pair)

    quarantine = store.quarantine(3)

    assert not (tmp_path / "x_3.json").exists()
    assert quarantine.path.exists()
    assert quarantine.path.name.startswith(".x-credential-quarantine-")
    assert store.external_sessions(set()) == []

    store.restore_quarantine(quarantine)
    assert store.read(3) == pair
    assert not quarantine.path.exists()

    quarantine = store.quarantine(3)
    store.finalize_quarantine(quarantine)
    assert not quarantine.path.exists()
    with pytest.raises(CredentialFileError):
        store.read(3)
