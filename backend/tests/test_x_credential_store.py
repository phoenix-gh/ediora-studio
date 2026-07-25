import json
import stat

from models import XCredentialAccount
from x_credential_store import CredentialFileStore, CredentialPair


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
