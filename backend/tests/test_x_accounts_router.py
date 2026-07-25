import asyncio
import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{tmp_path / 'x-accounts.db'}")
    monkeypatch.setenv("WMS_DISABLE_SCHEDULER", "1")
    monkeypatch.setenv("FEEDGRAB_DATA_DIR", str(tmp_path / "sessions"))
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


def test_reconcile_marks_missing_managed_file_failed(client):
    account = create_account(client)
    managed_active_file().unlink()

    async def reconcile():
        from database import SessionLocal
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


def test_reconcile_marks_malformed_managed_file_failed(client):
    account = create_account(client)
    managed_active_file().write_text("not json")

    async def reconcile():
        from database import SessionLocal
        from routers.x_accounts import reconcile_x_credential_accounts
        from x_credential_store import CredentialFileStore

        async with SessionLocal() as db:
            return await reconcile_x_credential_accounts(db, CredentialFileStore(session_dir()))

    errors = asyncio.run(reconcile())
    assert errors == [f"账号 {account['id']} 的凭据文件不存在或状态冲突"]
    result = client.get("/api/x/accounts").json()
    row = next(item for item in result["accounts"] if item["id"] == account["id"])
    assert row["test_status"] == "failed"
    assert "格式无效" in row["last_test_error"]


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
