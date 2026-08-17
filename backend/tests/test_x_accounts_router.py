import asyncio
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from cryptography.fernet import Fernet


@pytest.fixture
def client(monkeypatch, tmp_path, postgres_env):
    monkeypatch.setenv("FEEDGRAB_DATA_DIR", str(tmp_path / "sessions"))
    monkeypatch.setenv("X_SESSION_KEY", Fernet.generate_key().decode())
    for name in list(sys.modules):
        if name.startswith((
            "database", "models", "main", "routers", "config",
            "x_credential", "feedgrab_client",
        )):
            sys.modules.pop(name, None)
    from database import Base, engine
    import models  # noqa: F401

    async def create_schema():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.run(create_schema())
    from main import app
    return TestClient(app)


def session_dir() -> Path:
    return Path(os.environ["FEEDGRAB_DATA_DIR"])


def create_account(client, name="采集账号 A"):
    response = client.post("/api/x/accounts", json={
        "name": name,
        "auth_token": "secret-auth",
        "ct0": "secret-csrf",
        "enabled": True,
    })
    assert response.status_code == 200, response.text
    return next(item for item in response.json()["accounts"] if item["name"] == name)


def managed_active_file() -> Path:
    return next(
        path for path in session_dir().glob("x_[0-9]*.json")
        if ".disabled." not in path.name
    )


def test_create_account_writes_file_without_returning_secrets(client):
    response = client.post("/api/x/accounts", json={
        "name": "采集账号 A",
        "auth_token": "secret-auth",
        "ct0": "secret-csrf",
        "enabled": True,
    })

    assert response.status_code == 200, response.text
    body = response.json()
    account = next(item for item in body["accounts"] if item["name"] == "采集账号 A")
    assert account["auth_token_preview"] == "…auth"
    assert account["ct0_preview"] == "…csrf"
    assert "secret-auth" not in response.text
    assert "secret-csrf" not in response.text
    assert body["managed_enabled"] == 1
    assert body["total_accounts"] == 1
    assert body["available_accounts"] == 1
    assert managed_active_file().read_text() == '{"auth_token":"secret-auth","ct0":"secret-csrf"}'


def test_create_account_persists_an_encrypted_database_session(client):
    account = create_account(client)
    from database import SessionLocal
    from x_credential_store import CredentialSessionVault

    async def read_ciphertext():
        from models import XCredentialAccount

        async with SessionLocal() as db:
            row = await db.get(XCredentialAccount, account["id"])
            return row.session_ciphertext

    ciphertext = asyncio.run(read_ciphertext())

    assert ciphertext
    assert "secret-auth" not in ciphertext
    assert "secret-csrf" not in ciphertext
    assert CredentialSessionVault().decrypt(ciphertext).auth_token == "secret-auth"


def test_invalid_create_credential_response_is_redacted(client):
    response = client.post("/api/x/accounts", json={
        "name": " ",
        "auth_token": "create-auth-secret",
        "ct0": "create-csrf-secret",
        "enabled": True,
    })

    assert response.status_code == 422
    assert response.json() == {"detail": "账号凭据请求无效"}
    for raw_value in ("create-auth-secret", "create-csrf-secret", "input"):
        assert raw_value not in response.text


def test_credential_slot_is_rejected_on_input_and_never_returned(client):
    response = client.post("/api/x/accounts", json={
        "name": "采集账号 A",
        "auth_token": "secret-auth",
        "ct0": "secret-csrf",
        "credential_slot": 99,
    })

    assert response.status_code == 422
    account = create_account(client)
    attempted_patch = client.patch(
        f"/api/x/accounts/{account['id']}",
        json={"credential_slot": 99},
    )
    listed = client.get("/api/x/accounts")
    assert attempted_patch.status_code == 422
    assert listed.status_code == 200
    assert "credential_slot" not in account
    assert "credential_slot" not in listed.text


def test_patch_requires_both_credentials_and_blank_pair_preserves_file(client):
    account = create_account(client)
    before = managed_active_file().read_bytes()

    partial = client.patch(
        f"/api/x/accounts/{account['id']}",
        json={"auth_token": "replacement"},
    )
    assert partial.status_code == 422
    kept = client.patch(
        f"/api/x/accounts/{account['id']}",
        json={"name": "重命名", "auth_token": "", "ct0": ""},
    )
    assert kept.status_code == 200, kept.text
    assert managed_active_file().read_bytes() == before
    renamed = next(item for item in kept.json()["accounts"] if item["id"] == account["id"])
    assert renamed["name"] == "重命名"


def test_invalid_patch_credential_response_is_redacted(client):
    account = create_account(client)
    response = client.patch(
        f"/api/x/accounts/{account['id']}",
        json={
            "name": "patch-request-name",
            "auth_token": "patch-auth-secret",
            "ct0": "",
        },
    )

    assert response.status_code == 422
    assert response.json() == {"detail": "账号凭据请求无效"}
    for raw_value in ("patch-request-name", "patch-auth-secret"):
        assert raw_value not in response.text


@pytest.mark.parametrize("body", [{"auth_token": ""}, {"ct0": ""}])
def test_patch_rejects_each_single_blank_credential_field(client, body):
    account = create_account(client)

    response = client.patch(f"/api/x/accounts/{account['id']}", json=body)

    assert response.status_code == 422
    assert response.json() == {"detail": "账号凭据请求无效"}


def test_disable_and_delete_only_touch_owned_slot(client):
    session_dir().mkdir(parents=True)
    external = session_dir() / "x_1.json"
    external.write_text('{"auth_token":"external","ct0":"external-csrf"}')
    account = create_account(client)

    assert external.exists()
    assert (session_dir() / "x_2.json").exists()
    assert external.read_text() == '{"auth_token":"external","ct0":"external-csrf"}'
    disabled = client.patch(
        f"/api/x/accounts/{account['id']}",
        json={"enabled": False},
    )
    assert disabled.status_code == 200, disabled.text
    assert disabled.json()["managed_enabled"] == 0
    assert disabled.json()["available_accounts"] == 0
    assert list(session_dir().glob("x_2.disabled.json"))

    deleted = client.delete(f"/api/x/accounts/{account['id']}")
    assert deleted.status_code == 200, deleted.text
    assert deleted.json() == {
        "accounts": [],
        "external_sessions": ["x_1.json"],
        "managed_enabled": 0,
        "total_accounts": 0,
        "available_accounts": 0,
    }
    assert external.read_text() == '{"auth_token":"external","ct0":"external-csrf"}'


def test_patch_restores_owned_file_when_database_commit_fails(client):
    account = create_account(client)
    before = managed_active_file().read_bytes()
    from database import SessionLocal
    from routers import x_accounts

    async def failing_db():
        async with SessionLocal() as db:
            async def fail_commit():
                raise RuntimeError("database unavailable")

            db.commit = fail_commit
            yield db

    client.app.dependency_overrides[x_accounts.get_db] = failing_db
    try:
        failed_client = TestClient(client.app, raise_server_exceptions=False)
        response = failed_client.patch(
            f"/api/x/accounts/{account['id']}",
            json={"auth_token": "replacement-auth", "ct0": "replacement-csrf"},
        )
    finally:
        client.app.dependency_overrides.clear()

    assert response.status_code == 500
    assert managed_active_file().read_bytes() == before


def test_create_removes_owned_file_when_database_commit_fails(client):
    from database import SessionLocal
    from routers import x_accounts

    async def failing_db():
        async with SessionLocal() as db:
            async def fail_commit():
                raise RuntimeError("database unavailable")

            db.commit = fail_commit
            yield db

    client.app.dependency_overrides[x_accounts.get_db] = failing_db
    try:
        failed_client = TestClient(client.app, raise_server_exceptions=False)
        response = failed_client.post("/api/x/accounts", json={
            "name": "采集账号 A",
            "auth_token": "secret-auth",
            "ct0": "secret-csrf",
        })
    finally:
        client.app.dependency_overrides.clear()

    assert response.status_code == 500
    assert not list(session_dir().glob("x_[0-9]*.json"))
    assert client.get("/api/x/accounts").json()["accounts"] == []


def test_delete_restores_owned_file_when_database_commit_fails(client):
    account = create_account(client)
    before = managed_active_file().read_bytes()
    from database import SessionLocal
    from routers import x_accounts

    async def failing_db():
        async with SessionLocal() as db:
            async def fail_commit():
                raise RuntimeError("database unavailable")

            db.commit = fail_commit
            yield db

    client.app.dependency_overrides[x_accounts.get_db] = failing_db
    try:
        failed_client = TestClient(client.app, raise_server_exceptions=False)
        response = failed_client.delete(f"/api/x/accounts/{account['id']}")
    finally:
        client.app.dependency_overrides.clear()

    assert response.status_code == 500
    assert managed_active_file().read_bytes() == before


def test_reconcile_restores_missing_managed_file_from_database_session(client):
    account = create_account(client)
    managed_active_file().unlink()

    async def reconcile():
        from database import SessionLocal
        from routers.x_accounts import reconcile_x_credential_accounts
        from x_credential_store import CredentialFileStore

        async with SessionLocal() as db:
            return await reconcile_x_credential_accounts(db, CredentialFileStore(session_dir()))

    errors = asyncio.run(reconcile())
    assert errors == []
    assert managed_active_file().read_text() == '{"auth_token":"secret-auth","ct0":"secret-csrf"}'


def test_reconcile_database_session_overwrites_tampered_managed_file(client):
    account = create_account(client)
    managed_active_file().write_text(
        '{"auth_token":"tampered-auth","ct0":"tampered-csrf"}'
    )

    async def reconcile():
        from database import SessionLocal
        from routers.x_accounts import reconcile_x_credential_accounts
        from x_credential_store import CredentialFileStore

        async with SessionLocal() as db:
            return await reconcile_x_credential_accounts(db, CredentialFileStore(session_dir()))

    assert asyncio.run(reconcile()) == []
    assert managed_active_file().read_text() == '{"auth_token":"secret-auth","ct0":"secret-csrf"}'


def test_reconcile_imports_legacy_managed_file_into_database(client):
    account = create_account(client)
    from database import SessionLocal
    from models import XCredentialAccount
    from x_credential_store import CredentialSessionVault

    async def clear_database_session():
        async with SessionLocal() as db:
            row = await db.get(XCredentialAccount, account["id"])
            row.session_ciphertext = ""
            await db.commit()

    asyncio.run(clear_database_session())

    async def reconcile():
        from routers.x_accounts import reconcile_x_credential_accounts
        from x_credential_store import CredentialFileStore

        async with SessionLocal() as db:
            return await reconcile_x_credential_accounts(db, CredentialFileStore(session_dir()))

    assert asyncio.run(reconcile()) == []

    async def read_ciphertext():
        from x_credential_store import CredentialSessionVault

        async with SessionLocal() as db:
            row = await db.get(XCredentialAccount, account["id"])
            return row.session_ciphertext

    assert CredentialSessionVault().decrypt(asyncio.run(read_ciphertext())).ct0 == "secret-csrf"


def test_reconcile_marks_missing_managed_file_failed_when_database_session_is_empty(client):
    account = create_account(client)
    from database import SessionLocal
    from models import XCredentialAccount

    async def clear_database_session():
        async with SessionLocal() as db:
            row = await db.get(XCredentialAccount, account["id"])
            row.session_ciphertext = ""
            await db.commit()

    asyncio.run(clear_database_session())
    managed_active_file().unlink()

    async def reconcile():
        from routers.x_accounts import reconcile_x_credential_accounts
        from x_credential_store import CredentialFileStore

        async with SessionLocal() as db:
            return await reconcile_x_credential_accounts(db, CredentialFileStore(session_dir()))

    errors = asyncio.run(reconcile())
    assert errors == [f"账号 {account['id']} 的凭据文件不存在或状态冲突"]
    result = client.get("/api/x/accounts").json()
    row = next(item for item in result["accounts"] if item["id"] == account["id"])
    assert row["test_status"] == "failed"
    assert "凭据文件不存在" in row["last_test_error"]
    assert result["available_accounts"] == 0


def test_reconcile_restores_malformed_managed_file_from_database_session(client):
    account = create_account(client)
    managed_active_file().write_text("not json")

    async def reconcile():
        from database import SessionLocal
        from routers.x_accounts import reconcile_x_credential_accounts
        from x_credential_store import CredentialFileStore

        async with SessionLocal() as db:
            return await reconcile_x_credential_accounts(db, CredentialFileStore(session_dir()))

    assert asyncio.run(reconcile()) == []
    assert managed_active_file().read_text() == '{"auth_token":"secret-auth","ct0":"secret-csrf"}'


@pytest.mark.parametrize("malformed", ["[]", "null"])
def test_reconcile_restores_non_object_json_and_continues(client, malformed):
    broken = create_account(client, "损坏账号")
    healthy = create_account(client, "正常账号")
    managed_active_file().write_text(malformed)

    async def reconcile():
        from database import SessionLocal
        from routers.x_accounts import reconcile_x_credential_accounts
        from x_credential_store import CredentialFileStore

        async with SessionLocal() as db:
            return await reconcile_x_credential_accounts(db, CredentialFileStore(session_dir()))

    errors = asyncio.run(reconcile())
    assert errors == []
    rows = {row["id"]: row for row in client.get("/api/x/accounts").json()["accounts"]}
    assert rows[broken["id"]]["test_status"] == "untested"
    assert rows[healthy["id"]]["test_status"] == "untested"


def test_reconcile_moves_owned_file_to_match_enabled_state(client):
    account = create_account(client)

    async def mark_disabled_then_reconcile():
        from database import SessionLocal
        from models import XCredentialAccount
        from routers.x_accounts import reconcile_x_credential_accounts
        from x_credential_store import CredentialFileStore

        async with SessionLocal() as db:
            owned = await db.get(XCredentialAccount, account["id"])
            owned.enabled = False
            await db.commit()
        async with SessionLocal() as db:
            return await reconcile_x_credential_accounts(db, CredentialFileStore(session_dir()))

    assert asyncio.run(mark_disabled_then_reconcile()) == []
    assert not (session_dir() / "x_1.json").exists()
    assert (session_dir() / "x_1.disabled.json").exists()


def test_account_probe_reads_owned_file_persists_utc_status_and_returns_safe_pool(
    client,
    monkeypatch,
):
    account = create_account(client)
    session_dir().mkdir(parents=True, exist_ok=True)
    (session_dir() / "x.json").write_text(
        '{"auth_token":"external-auth-secret","ct0":"external-csrf-secret"}'
    )
    seen_pairs = []
    from routers import x_accounts
    from x_credential_probe import CredentialProbeResult

    async def successful_probe(pair):
        seen_pairs.append(pair)
        return CredentialProbeResult("available", "")

    monkeypatch.setattr(
        x_accounts,
        "probe_x_credentials",
        successful_probe,
        raising=False,
    )

    response = client.post(f"/api/x/accounts/{account['id']}/test")

    assert response.status_code == 200, response.text
    assert [(pair.auth_token, pair.ct0) for pair in seen_pairs] == [
        ("secret-auth", "secret-csrf"),
    ]
    body = response.json()
    assert set(body) == {
        "accounts",
        "external_sessions",
        "managed_enabled",
        "total_accounts",
        "available_accounts",
    }
    tested = next(row for row in body["accounts"] if row["id"] == account["id"])
    assert tested["test_status"] == "available"
    assert tested["last_test_error"] == ""
    tested_at = datetime.fromisoformat(tested["last_tested_at"])
    assert tested_at.utcoffset() == timezone.utc.utcoffset(tested_at)
    assert body["external_sessions"] == ["x.json"]
    for secret in (
        "secret-auth",
        "secret-csrf",
        "external-auth-secret",
        "external-csrf-secret",
    ):
        assert secret not in response.text


def test_account_probe_redacts_and_truncates_persisted_error(client, monkeypatch):
    account = create_account(client)
    from routers import x_accounts
    from x_credential_probe import CredentialProbeResult

    leaked = (
        "auth_token=probe-auth-secret ct0: probe-csrf-secret "
        "https://api.telegram.org/bot123456:telegram-secret/sendMessage "
        + ("x" * 600)
    )

    async def failed_probe(_pair):
        return CredentialProbeResult("failed", leaked)

    monkeypatch.setattr(
        x_accounts,
        "probe_x_credentials",
        failed_probe,
        raising=False,
    )

    response = client.post(f"/api/x/accounts/{account['id']}/test")

    assert response.status_code == 200, response.text
    tested = response.json()["accounts"][0]
    assert tested["test_status"] == "failed"
    assert len(tested["last_test_error"]) == 500
    assert "auth_token=***" in tested["last_test_error"]
    for secret in ("probe-auth-secret", "probe-csrf-secret", "telegram-secret"):
        assert secret not in response.text


def test_concurrent_creates_use_distinct_slots_and_files(client):
    from database import SessionLocal
    from routers.x_accounts import XCredentialAccountCreate, create_x_account

    async def create(name, token):
        async with SessionLocal() as db:
            return await create_x_account(
                XCredentialAccountCreate(
                    name=name,
                    auth_token=token,
                    ct0=f"{token}-csrf",
                ),
                db,
            )

    async def run():
        return await asyncio.gather(
            create("并发账号 A", "token-a"),
            create("并发账号 B", "token-b"),
        )

    asyncio.run(run())

    files = sorted(session_dir().glob("x_[0-9]*.json"))
    assert [path.name for path in files] == ["x_1.json", "x_2.json"]
    payloads = {path.read_text() for path in files}
    assert payloads == {
        '{"auth_token":"token-a","ct0":"token-a-csrf"}',
        '{"auth_token":"token-b","ct0":"token-b-csrf"}',
    }
    accounts = client.get("/api/x/accounts").json()["accounts"]
    assert {row["name"] for row in accounts} == {"并发账号 A", "并发账号 B"}


def test_reconcile_restores_precommit_quarantine_for_existing_db_slot(client):
    account = create_account(client)
    from database import SessionLocal
    from routers.x_accounts import reconcile_x_credential_accounts
    from x_credential_store import CredentialFileStore

    store = CredentialFileStore(session_dir())
    quarantine = store.quarantine(1)
    assert quarantine.path.exists()
    assert not (session_dir() / "x_1.json").exists()

    async def reconcile():
        async with SessionLocal() as db:
            return await reconcile_x_credential_accounts(db, store)

    assert asyncio.run(reconcile()) == []
    assert (session_dir() / "x_1.json").exists()
    assert not quarantine.path.exists()
    assert client.get("/api/x/accounts").json()["accounts"][0]["id"] == account["id"]


def test_reconcile_cleans_postcommit_quarantine_when_db_slot_is_gone(client):
    account = create_account(client)
    from database import SessionLocal
    from models import XCredentialAccount
    from routers.x_accounts import reconcile_x_credential_accounts
    from x_credential_store import CredentialFileStore

    store = CredentialFileStore(session_dir())
    quarantine = store.quarantine(1)

    async def remove_db_then_reconcile():
        async with SessionLocal() as db:
            row = await db.get(XCredentialAccount, account["id"])
            await db.delete(row)
            await db.commit()
        async with SessionLocal() as db:
            return await reconcile_x_credential_accounts(db, store)

    assert asyncio.run(remove_db_then_reconcile()) == []
    assert not quarantine.path.exists()
    assert not list(session_dir().glob("x_[0-9]*.json"))
